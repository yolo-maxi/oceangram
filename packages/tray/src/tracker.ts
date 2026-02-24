// tracker.ts — Message tracking for all dialogs (no whitelist filtering)
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import os from 'os';
import daemon from './daemon';
import { TelegramMessage, TelegramDialog, DaemonEvent, UnreadEntry } from './types';

const LAST_SEEN_FILE: string = path.join(os.homedir(), '.oceangram-tray', 'last-seen.json');

class MessageTracker extends EventEmitter {
  private unreads: Map<string, UnreadEntry>;
  private lastSeenIds: Map<string, number>;
  private pollTimer: ReturnType<typeof setInterval> | null;
  private activeChatsTimer: ReturnType<typeof setInterval> | null;
  private wsActive: boolean;
  // Cache dialog info for display names in notifications
  private dialogNames: Map<string, string>;
  // Track when user last sent a message per dialog (for active-chats filter)
  private lastSentTimes: Map<string, number>;

  constructor() {
    super();
    this.unreads = new Map();
    this.lastSeenIds = new Map();
    this.pollTimer = null;
    this.activeChatsTimer = null;
    this.wsActive = false;
    this.dialogNames = new Map();
    this.lastSentTimes = new Map();

    this._loadLastSeen();
  }

  private _loadLastSeen(): void {
    try {
      if (fs.existsSync(LAST_SEEN_FILE)) {
        const data = JSON.parse(fs.readFileSync(LAST_SEEN_FILE, 'utf-8')) as Record<string, number>;
        for (const [k, v] of Object.entries(data)) {
          this.lastSeenIds.set(k, v);
        }
      }
    } catch { /* ignore */ }
  }

  private _saveLastSeen(): void {
    try {
      const obj: Record<string, number> = Object.fromEntries(this.lastSeenIds);
      fs.writeFileSync(LAST_SEEN_FILE, JSON.stringify(obj));
    } catch { /* ignore */ }
  }

  start(): void {
    // Listen for WS events
    daemon.on('newMessage', (event: DaemonEvent) => this._handleNewMessage(event));
    daemon.on('ws-connected', () => {
      this.wsActive = true;
      console.log('[tracker] WS active, reducing poll frequency');
    });
    daemon.on('ws-disconnected', () => {
      this.wsActive = false;
      console.log('[tracker] WS lost, polling mode');
    });

    // Start polling — fetch dialog unread counts from daemon
    this.pollTimer = setInterval(() => this._poll(), 5000);
    // Initial poll
    setTimeout(() => this._poll(), 1000);

    // Periodically prune expired active chats (every 30s)
    this.activeChatsTimer = setInterval(() => this._pruneActiveChats(), 30000);
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.activeChatsTimer) {
      clearInterval(this.activeChatsTimer);
      this.activeChatsTimer = null;
    }
    this._saveLastSeen();
  }

  private async _poll(): Promise<void> {
    if (!daemon.connected) return;

    try {
      const dialogs = await daemon.getDialogs();
      if (!Array.isArray(dialogs)) return;

      let changed = false;
      for (const dialog of dialogs) {
        const d = dialog as TelegramDialog;
        const dialogId = String(d.id);
        const name = d.title || d.name || d.firstName || d.username || dialogId;
        this.dialogNames.set(dialogId, name);

        // Use the unread count from the dialog itself
        const daemonUnread = d.unreadCount || 0;
        const current = this.unreads.get(dialogId);
        const currentCount = current ? current.count : 0;

        if (daemonUnread !== currentCount) {
          if (daemonUnread > 0) {
            if (!current) {
              this.unreads.set(dialogId, { dialogId, messages: [], count: daemonUnread });
            } else {
              current.count = daemonUnread;
            }
          } else {
            this.unreads.delete(dialogId);
          }
          changed = true;
        }
      }

      // Sync active chats from daemon dialog data (captures sends from regular Telegram / other clients)
      this.syncActiveChatsFromDaemon(dialogs);

      if (changed) {
        this.emit('unread-count-changed');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[tracker] Poll error:', message);
    }
  }

  private _handleNewMessage(event: DaemonEvent): void {
    console.log('[tracker] _handleNewMessage called, event type:', (event as any).type, 'dialogId:', (event as any).dialogId);
    const msg = (event.message || event) as TelegramMessage;
    const fromId = String(msg.fromId || msg.senderId || '');
    const dialogId = String(msg.dialogId || msg.chatId || '');

    if (!dialogId) return;

    // Track unread
    if (!this.unreads.has(dialogId)) {
      this.unreads.set(dialogId, { dialogId, messages: [], count: 0 });
    }
    const entry = this.unreads.get(dialogId)!;

    // Prevent duplicates
    if (msg.id && entry.messages.some((m) => m.id === msg.id)) return;

    entry.messages.push(msg);
    entry.count = entry.messages.length;

    const displayName = this.dialogNames.get(dialogId) || msg.senderName || msg.firstName || fromId;

    this.emit('new-message', { userId: fromId, dialogId, message: msg, displayName });
    this.emit('unread-count-changed');
  }

  markRead(dialogId: string): void {
    const entry = this.unreads.get(dialogId);
    const latest = entry?.messages?.[entry.messages.length - 1];

    if (entry) {
      if (latest) {
        this.lastSeenIds.set(dialogId, latest.id);
        this._saveLastSeen();
      }
      this.unreads.delete(dialogId);
      this.emit('messages-read', { dialogId });
      this.emit('unread-count-changed');
    }

    // Always tell daemon so Telegram marks the dialog as read (clears unread badge / stops showing as active)
    if (latest) {
      daemon.markRead(dialogId, latest.id).catch(() => {});
    } else {
      // Tracker had no messages for this dialog (unreads came from poll only). Fetch latest message id or mark all.
      daemon.getMessages(dialogId, 1).then((msgs) => {
        if (msgs && msgs.length > 0) {
          const last = msgs[msgs.length - 1];
          const id = (last as { id?: number }).id ?? (last as any).messageId;
          if (id != null) daemon.markRead(dialogId, id).catch(() => {});
        } else {
          daemon.markAllAsRead(dialogId).catch(() => {});
        }
      }).catch(() => {});
    }
  }

  getUnreads(dialogId: string): UnreadEntry {
    return this.unreads.get(dialogId) || { dialogId: null, messages: [], count: 0 };
  }

  getAllUnreads(): Record<string, UnreadEntry> {
    const result: Record<string, UnreadEntry> = {};
    for (const [dialogId, data] of this.unreads) {
      result[dialogId] = data;
    }
    return result;
  }

  getAllUnreadCounts(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [dialogId, data] of this.unreads) {
      result[dialogId] = data.count;
    }
    return result;
  }

  getTotalUnreadCount(): number {
    let total = 0;
    for (const [, data] of this.unreads) {
      total += data.count;
    }
    return total;
  }

  getDialogName(dialogId: string): string | undefined {
    return this.dialogNames.get(dialogId);
  }

  // ── Active chats (sent recently + has unreads) ──

  private static readonly ACTIVE_WINDOW_MS = 60 * 60 * 1000; // 1 hour

  /** Record that the user sent a message to a dialog. */
  recordSent(dialogId: string): void {
    this.lastSentTimes.set(dialogId, Date.now());
  }

  /**
   * Sync active chats from daemon dialog data.
   * Checks each dialog's lastMessage — if it's outgoing and within the active window, record it.
   * This captures sends from regular Telegram (not just the tray composer).
   */
  syncActiveChatsFromDaemon(dialogs: TelegramDialog[]): void {
    if (!Array.isArray(dialogs)) return;
    const now = Date.now();
    const cutoff = now - MessageTracker.ACTIVE_WINDOW_MS;
    const FUTURE_TOLERANCE_MS = 60_000; // ignore timestamps > now + 1 min (wrong clock / bug)
    let changed = false;
    const recentFromDaemon = new Set<string>();

    for (const d of dialogs) {
      const dialogId = String(d.id);

      // Use lastOutgoingTime if available (forum topics where last msg isn't ours),
      // otherwise fall back to lastMessageTime if lastMessageOutgoing is true
      let outgoingTimeRaw = 0;
      if ((d as any).lastOutgoingTime) {
        outgoingTimeRaw = (d as any).lastOutgoingTime;
      } else if (d.lastMessageOutgoing) {
        outgoingTimeRaw = d.lastMessageTime || 0;
      }
      if (!outgoingTimeRaw) continue;

      // Convert to ms (daemon uses seconds)
      const msgTimeMs = outgoingTimeRaw < 1e12 ? outgoingTimeRaw * 1000 : outgoingTimeRaw;
      if (msgTimeMs < cutoff) continue;
      if (msgTimeMs > now + FUTURE_TOLERANCE_MS) continue; // ignore future timestamps

      recentFromDaemon.add(dialogId);
      // Only set if we don't already have a more recent send time
      const existing = this.lastSentTimes.get(dialogId);
      if (!existing || existing < msgTimeMs) {
        this.lastSentTimes.set(dialogId, msgTimeMs);
        changed = true;
      }
    }

    // Daemon is source of truth: clear lastSentTimes for dialogs that appear in this batch
    // but are not in the "recent" set (so we stop showing them as active)
    for (const d of dialogs) {
      const dialogId = String(d.id);
      if (this.lastSentTimes.has(dialogId) && !recentFromDaemon.has(dialogId)) {
        this.lastSentTimes.delete(dialogId);
        changed = true;
      }
    }

    if (changed) {
      this.emit('active-chats-changed');
    }
  }

  /**
   * Returns dialog IDs where EITHER:
   *  - dialog has unread messages (unreadCount > 0), OR
   *  - user sent a message within the last hour (from tray OR regular Telegram)
   * These are "active conversations" that should appear alongside whitelisted tabs.
   */
  getActiveChats(): Array<{ dialogId: string; displayName: string }> {
    const now = Date.now();
    const cutoff = now - MessageTracker.ACTIVE_WINDOW_MS;
    const result: Array<{ dialogId: string; displayName: string }> = [];

    // Only show chats where user sent recently AND has unreads (replies)
    // This keeps the client minimal — Telegram is full of spam
    for (const [dialogId, sentTime] of this.lastSentTimes) {
      if (sentTime < cutoff) continue;
      const unread = this.unreads.get(dialogId);
      if (!unread || unread.count <= 0) continue;
      const name = this.dialogNames.get(dialogId) || dialogId;
      result.push({ dialogId, displayName: name });
    }

    return result;
  }

  /** Prune expired entries and emit change if any were removed. */
  private _pruneActiveChats(): void {
    const now = Date.now();
    const cutoff = now - MessageTracker.ACTIVE_WINDOW_MS;
    let changed = false;

    for (const [dialogId, sentTime] of this.lastSentTimes) {
      if (sentTime < cutoff) {
        this.lastSentTimes.delete(dialogId);
        changed = true;
      }
    }

    if (changed) {
      this.emit('active-chats-changed');
    }
  }
}

export = new MessageTracker();
