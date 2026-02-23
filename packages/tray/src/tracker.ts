// tracker.ts — Message tracking + filtering for whitelisted users
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import os from 'os';
import daemon from './daemon';
import whitelist from './whitelist';
import { TelegramMessage, TelegramDialog, DaemonEvent, UnreadEntry } from './types';

const LAST_SEEN_FILE: string = path.join(os.homedir(), '.oceangram-tray', 'last-seen.json');

class MessageTracker extends EventEmitter {
  private unreads: Map<string, UnreadEntry>;
  private lastSeenIds: Map<string, number>;
  private pollTimer: ReturnType<typeof setInterval> | null;
  private wsActive: boolean;

  constructor() {
    super();
    this.unreads = new Map();
    this.lastSeenIds = new Map();
    this.pollTimer = null;
    this.wsActive = false;

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

    // Start polling
    const interval = whitelist.getSettings().pollIntervalMs || 3000;
    this.pollTimer = setInterval(() => this._poll(), interval);
    // Initial poll
    setTimeout(() => this._poll(), 1000);
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this._saveLastSeen();
  }

  private async _poll(): Promise<void> {
    // If WS is active, poll less frequently (just for catch-up)
    if (!daemon.connected) return;

    try {
      const dialogs = await daemon.getDialogs();
      if (!Array.isArray(dialogs)) return;

      for (const dialog of dialogs) {
        const d = dialog as TelegramDialog;
        const userId = String(d.userId || d.id);
        if (!whitelist.isWhitelisted(userId)) continue;

        const dialogId = String(d.id);
        const messages = await daemon.getMessages(dialogId, 10);
        if (!Array.isArray(messages) || messages.length === 0) continue;

        const lastSeen = this.lastSeenIds.get(dialogId);
        const newMsgs = lastSeen
          ? messages.filter((m: TelegramMessage) => m.id > lastSeen && String(m.fromId || m.senderId) === userId)
          : [];

        if (newMsgs.length > 0) {
          for (const msg of newMsgs) {
            this._addUnread(userId, dialogId, msg);
          }
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[tracker] Poll error:', message);
    }
  }

  private _handleNewMessage(event: DaemonEvent): void {
    const msg = (event.message || event) as TelegramMessage;
    const fromId = String(msg.fromId || msg.senderId || '');
    const dialogId = String(msg.dialogId || msg.chatId || '');

    if (!fromId || !whitelist.isWhitelisted(fromId)) return;

    this._addUnread(fromId, dialogId, msg);
  }

  private _addUnread(userId: string, dialogId: string, msg: TelegramMessage): void {
    if (!this.unreads.has(userId)) {
      this.unreads.set(userId, { dialogId, messages: [], count: 0 });
    }

    const entry = this.unreads.get(userId)!;
    // Prevent duplicates
    if (entry.messages.some((m) => m.id === msg.id)) return;

    entry.dialogId = dialogId;
    entry.messages.push(msg);
    entry.count = entry.messages.length;

    this.emit('new-message', { userId, dialogId, message: msg });
    this.emit('user-unreads-changed', { userId, count: entry.count });
  }

  markRead(userId: string): void {
    const entry = this.unreads.get(userId);
    if (!entry) return;

    // Update last seen to the latest message
    const latest = entry.messages[entry.messages.length - 1];
    if (latest) {
      this.lastSeenIds.set(entry.dialogId || '', latest.id);
      this._saveLastSeen();
      // Mark read on daemon
      daemon.markRead(latest.id).catch(() => {});
    }

    this.unreads.delete(userId);
    this.emit('messages-read', { userId });
    this.emit('user-unreads-changed', { userId, count: 0 });
  }

  getUnreads(userId: string): UnreadEntry {
    return this.unreads.get(userId) || { dialogId: null, messages: [], count: 0 };
  }

  getAllUnreads(): Record<string, UnreadEntry> {
    const result: Record<string, UnreadEntry> = {};
    for (const [userId, data] of this.unreads) {
      result[userId] = data;
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
}

export = new MessageTracker();
