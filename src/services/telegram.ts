import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { Api } from 'telegram';
import { NewMessage, NewMessageEvent } from 'telegram/events';
import { EditedMessage, EditedMessageEvent } from 'telegram/events/EditedMessage';
import { DeletedMessage, DeletedMessageEvent } from 'telegram/events/DeletedMessage';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

// Default fallback for non-extension contexts
const DEFAULT_CONFIG_DIR = path.join(process.env.HOME || '/home/xiko', '.oceangram');

// Storage directory — set via setStoragePath() to use VS Code's globalStorageUri
let CONFIG_DIR = DEFAULT_CONFIG_DIR;

function getPath(name: string): string {
  return path.join(CONFIG_DIR, name);
}

/** Set the storage directory (call with context.globalStorageUri.fsPath) */
export function setStoragePath(storagePath: string): void {
  CONFIG_DIR = storagePath;
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  // Migrate from old location if needed
  const oldDir = DEFAULT_CONFIG_DIR;
  if (oldDir !== CONFIG_DIR && fs.existsSync(oldDir)) {
    for (const file of ['config.json', 'pinned.json', 'dialogs-cache.json', 'messages.jsonl', 'messages-cache.json', 'recent.json']) {
      const oldFile = path.join(oldDir, file);
      const newFile = path.join(CONFIG_DIR, file);
      if (fs.existsSync(oldFile) && !fs.existsSync(newFile)) {
        try { fs.copyFileSync(oldFile, newFile); } catch { /* ignore */ }
      }
    }
  }
}

export interface DialogInfo {
  id: string;           // "chatId" or "chatId:topicId" for forum topics
  chatId: string;       // raw telegram chat id
  topicId?: number;     // forum topic thread id
  name: string;
  lastMessage: string;
  lastMessageTime: number;
  unreadCount: number;
  initials: string;
  isPinned: boolean;
  isForum: boolean;
  topicEmoji?: string;  // emoji for forum topic (extracted or fallback)
  groupName?: string;   // parent group name (for topics)
  topicName?: string;   // just the topic name (for topics)
}

export interface LinkPreview {
  url: string;
  title?: string;
  description?: string;
  imageUrl?: string;
}

export interface MessageEntity {
  type: 'bold' | 'italic' | 'code' | 'pre' | 'strikethrough' | 'url' | 'text_link';
  offset: number;
  length: number;
  url?: string;      // for text_link
  language?: string;  // for pre (code blocks)
}

export interface ReactionInfo {
  emoji: string;
  count: number;
  isSelected: boolean;
}

export interface MessageInfo {
  id: number;
  senderId: string;
  senderName: string;
  text: string;
  timestamp: number;
  isOutgoing: boolean;
  // Media
  mediaType?: 'photo' | 'video' | 'voice' | 'file' | 'sticker' | 'gif';
  mediaUrl?: string;
  thumbnailUrl?: string;
  fileName?: string;
  fileSize?: number;
  duration?: number; // seconds, for voice/video/gif
  // Reply
  replyToId?: number;
  replyToText?: string;
  replyToSender?: string;
  // Forward
  forwardFrom?: string;
  // Edited
  isEdited?: boolean;
  // Entities (for markdown rendering)
  entities?: MessageEntity[];
  // Link preview
  linkPreview?: LinkPreview;
  // Reactions
  reactions?: ReactionInfo[];
}

export type DialogUpdateListener = (dialogs: DialogInfo[]) => void;

export class TelegramService {
  private client: TelegramClient | null = null;
  private connected = false;
  private forumTopicsCache: Map<string, Api.ForumTopic[]> = new Map();

  // Dialog cache (stale-while-revalidate)
  private dialogCache: DialogInfo[] | null = null;
  private dialogCacheTime = 0;
  private dialogCacheTTL = 30_000; // 30 seconds
  private dialogRefreshing = false;
  private dialogUpdateListeners: Set<DialogUpdateListener> = new Set();

  // Message cache (per dialog)
  private messageCache: Map<string, { messages: MessageInfo[]; timestamp: number }> = new Map();
  private messageCacheTTL = 30_000;

  // Profile photo cache: senderId → base64 data URI (or null if no photo)
  private profilePhotoCache: Map<string, string | null> = new Map();
  private profilePhotoFetching: Set<string> = new Set();

  onDialogUpdate(listener: DialogUpdateListener): () => void {
    this.dialogUpdateListeners.add(listener);
    return () => { this.dialogUpdateListeners.delete(listener); };
  }

  private emitDialogUpdate(dialogs: DialogInfo[]) {
    for (const listener of this.dialogUpdateListeners) {
      try { listener(dialogs); } catch (e) { console.error('[Oceangram] Dialog update listener error:', e); }
    }
  }

  private ensureConfigDir() {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }

  private loadDialogCache(): DialogInfo[] | null {
    try {
      if (fs.existsSync(getPath('dialogs-cache.json'))) {
        const data = JSON.parse(fs.readFileSync(getPath('dialogs-cache.json'), 'utf-8'));
        if (data && Array.isArray(data.dialogs)) {
          this.dialogCache = data.dialogs;
          this.dialogCacheTime = data.timestamp || 0;
          return data.dialogs;
        }
      }
    } catch { /* ignore */ }
    return null;
  }

  private saveDialogCache(dialogs: DialogInfo[]) {
    this.ensureConfigDir();
    const data = {
      timestamp: Date.now(),
      dialogs: dialogs.map(d => ({
        id: d.id, chatId: d.chatId, topicId: d.topicId, name: d.name,
        lastMessage: d.lastMessage, lastMessageTime: d.lastMessageTime,
        unreadCount: d.unreadCount, initials: d.initials, isPinned: d.isPinned,
        isForum: d.isForum, groupName: d.groupName, topicName: d.topicName,
        topicEmoji: d.topicEmoji,
      }))
    };
    fs.writeFileSync(getPath('dialogs-cache.json'), JSON.stringify(data));
  }

  private loadMessageCache(): void {
    try {
      // Try JSONL format first, fall back to legacy JSON
      const jsonlPath = getPath('messages.jsonl');
      const legacyPath = getPath('messages-cache.json');
      
      if (fs.existsSync(jsonlPath)) {
        const content = fs.readFileSync(jsonlPath, 'utf-8');
        for (const line of content.split('\n')) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line);
            if (entry.chatId && Array.isArray(entry.messages)) {
              this.messageCache.set(entry.chatId, { messages: entry.messages, timestamp: entry.timestamp || 0 });
            }
          } catch { /* skip malformed lines */ }
        }
      } else if (fs.existsSync(legacyPath)) {
        // Migrate from legacy JSON format
        const data = JSON.parse(fs.readFileSync(legacyPath, 'utf-8'));
        if (data && typeof data === 'object') {
          for (const [dialogId, entry] of Object.entries(data)) {
            const e = entry as any;
            if (Array.isArray(e.messages)) {
              this.messageCache.set(dialogId, { messages: e.messages, timestamp: e.timestamp || 0 });
            }
          }
        }
        // Save in new format and remove legacy
        this.saveMessageCache();
        try { fs.unlinkSync(legacyPath); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }

  /** Read a single chat's messages from JSONL without loading everything */
  private loadMessageCacheForChat(dialogId: string): { messages: MessageInfo[]; timestamp: number } | null {
    try {
      const jsonlPath = getPath('messages.jsonl');
      if (!fs.existsSync(jsonlPath)) return null;
      const content = fs.readFileSync(jsonlPath, 'utf-8');
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.chatId === dialogId && Array.isArray(entry.messages)) {
            return { messages: entry.messages, timestamp: entry.timestamp || 0 };
          }
        } catch { /* skip */ }
      }
    } catch { /* ignore */ }
    return null;
  }

  private saveMessageCache() {
    this.ensureConfigDir();
    const lines: string[] = [];
    for (const [dialogId, entry] of this.messageCache) {
      lines.push(JSON.stringify({
        chatId: dialogId,
        messages: entry.messages.slice(-20),
        timestamp: entry.timestamp,
      }));
    }
    fs.writeFileSync(getPath('messages.jsonl'), lines.join('\n') + '\n');
  }

  /** Save only a single chat's cache entry (append/replace in JSONL) */
  private saveMessageCacheForChat(dialogId: string) {
    this.ensureConfigDir();
    const jsonlPath = getPath('messages.jsonl');
    const entry = this.messageCache.get(dialogId);
    if (!entry) return;

    const newLine = JSON.stringify({
      chatId: dialogId,
      messages: entry.messages.slice(-20),
      timestamp: entry.timestamp,
    });

    // Read existing, replace the matching line or append
    let lines: string[] = [];
    try {
      if (fs.existsSync(jsonlPath)) {
        lines = fs.readFileSync(jsonlPath, 'utf-8').split('\n').filter(l => l.trim());
      }
    } catch { /* ignore */ }

    let replaced = false;
    for (let i = 0; i < lines.length; i++) {
      try {
        const parsed = JSON.parse(lines[i]);
        if (parsed.chatId === dialogId) {
          lines[i] = newLine;
          replaced = true;
          break;
        }
      } catch { /* skip */ }
    }
    if (!replaced) lines.push(newLine);
    fs.writeFileSync(jsonlPath, lines.join('\n') + '\n');
  }

  // Recent chats
  getRecentChats(): { id: string; timestamp: number }[] {
    try {
      if (fs.existsSync(getPath('recent.json'))) {
        return JSON.parse(fs.readFileSync(getPath('recent.json'), 'utf-8')) || [];
      }
    } catch { /* ignore */ }
    return [];
  }

  trackRecentChat(chatId: string) {
    this.ensureConfigDir();
    let recent = this.getRecentChats().filter(r => r.id !== chatId);
    recent.unshift({ id: chatId, timestamp: Date.now() });
    recent = recent.slice(0, 10);
    fs.writeFileSync(getPath('recent.json'), JSON.stringify(recent));
  }

  private loadConfig(): Record<string, string> {
    try {
      if (fs.existsSync(getPath('config.json'))) {
        return JSON.parse(fs.readFileSync(getPath('config.json'), 'utf-8'));
      }
    } catch { /* ignore */ }
    return {};
  }

  private saveConfig(config: Record<string, string>): void {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    fs.writeFileSync(getPath('config.json'), JSON.stringify(config, null, 2));
  }

  // Built-in app credentials (same as any public Telegram client)
  private static readonly DEFAULT_API_ID = 35419737;
  private static readonly DEFAULT_API_HASH = 'f689329727c1f0002f72152be5f3f6fa';

  async connect(): Promise<void> {
    if (this.connected) return;

    const fileConfig = this.loadConfig();

    const apiId = parseInt(process.env.TELEGRAM_API_ID || fileConfig.apiId || '0', 10) || TelegramService.DEFAULT_API_ID;
    const apiHash = process.env.TELEGRAM_API_HASH || fileConfig.apiHash || TelegramService.DEFAULT_API_HASH;
    const sessionString = process.env.TELEGRAM_SESSION || fileConfig.session || '';

    const session = new StringSession(sessionString);
    this.client = new TelegramClient(session, apiId, apiHash, {
      connectionRetries: 5,
    });

    // If no session string, do interactive login
    if (!sessionString) {
      await this.interactiveLogin(apiId, apiHash);
    } else {
      await this.client.connect();
    }

    this.connected = true;
    console.log('[Oceangram] Telegram connected');
  }

  private async promptApiCredentials(): Promise<{ apiId: number; apiHash: string } | null> {
    const info = await vscode.window.showInformationMessage(
      'Telegram not configured. You need API credentials from my.telegram.org.',
      'Set up now', 'Open my.telegram.org', 'Cancel'
    );

    if (info === 'Open my.telegram.org') {
      vscode.env.openExternal(vscode.Uri.parse('https://my.telegram.org/apps'));
    }
    if (info === 'Cancel' || !info) return null;

    const idStr = await vscode.window.showInputBox({
      title: 'Telegram API ID',
      prompt: 'Enter your API ID from my.telegram.org/apps',
      placeHolder: '12345678',
      ignoreFocusOut: true,
    });
    if (!idStr) return null;

    const hash = await vscode.window.showInputBox({
      title: 'Telegram API Hash',
      prompt: 'Enter your API Hash from my.telegram.org/apps',
      placeHolder: 'abcdef1234567890abcdef1234567890',
      ignoreFocusOut: true,
    });
    if (!hash) return null;

    const apiId = parseInt(idStr, 10);
    if (isNaN(apiId)) {
      vscode.window.showErrorMessage('Invalid API ID — must be a number');
      return null;
    }

    // Save credentials
    const config = this.loadConfig();
    config.apiId = idStr;
    config.apiHash = hash;
    this.saveConfig(config);

    return { apiId, apiHash: hash };
  }

  private async interactiveLogin(apiId: number, apiHash: string): Promise<void> {
    const session = new StringSession('');
    this.client = new TelegramClient(session, apiId, apiHash, {
      connectionRetries: 5,
    });

    // Use a webview panel for login — showInputBox is broken in Cursor
    const result = await this.webviewLogin();
    if (!result) throw new Error('Login cancelled');

    await this.client.start({
      phoneNumber: async () => result.phone,
      phoneCode: async () => {
        // After phone is sent, we need the code — show step 2 in webview
        const code = await this.webviewPrompt('Telegram sent you a code', 'Enter verification code', 'code');
        if (!code) throw new Error('Login cancelled');
        return code;
      },
      password: async () => {
        const pw = await this.webviewPrompt('Two-factor authentication', 'Enter your 2FA password', 'password');
        if (!pw) throw new Error('Login cancelled');
        return pw;
      },
      onError: (err) => {
        console.error('[Oceangram] Login error:', err);
        vscode.window.showErrorMessage(`Telegram login error: ${err.message}`);
      },
    });

    // Close login panel if still open
    if (this.loginPanel) { this.loginPanel.dispose(); this.loginPanel = undefined; }

    // Save session string for next time
    const sessionStr = this.client.session.save() as unknown as string;
    console.log('[Oceangram] Session string length after login:', sessionStr?.length || 0);
    if (sessionStr && sessionStr.length > 10) {
      const config = this.loadConfig();
      config.session = sessionStr;
      this.saveConfig(config);
      console.log('[Oceangram] Session saved to config');
      vscode.window.showInformationMessage('✅ Telegram logged in! Session saved.');
    } else {
      console.error('[Oceangram] Session string empty after login — not saved');
      vscode.window.showWarningMessage('⚠️ Logged in but session may not persist. Try reloading.');
    }
  }

  private loginPanel: vscode.WebviewPanel | undefined;
  private loginResolve: ((value: string | null) => void) | undefined;

  private getLoginHtml(title: string, subtitle: string, inputType: string, placeholder: string): string {
    return `<!DOCTYPE html>
<html><head><style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background: #0e1621;
  color: #f5f5f5;
  height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
}
.login-card {
  background: #17212b;
  border-radius: 16px;
  padding: 40px;
  width: 380px;
  text-align: center;
}
.logo { font-size: 48px; margin-bottom: 16px; }
h1 { font-size: 22px; font-weight: 500; margin-bottom: 8px; }
.subtitle { color: #6d7f8f; font-size: 14px; margin-bottom: 24px; }
input {
  width: 100%;
  padding: 14px 16px;
  background: #242f3d;
  border: 2px solid transparent;
  border-radius: 12px;
  color: #f5f5f5;
  font-size: 18px;
  text-align: center;
  letter-spacing: 2px;
  outline: none;
  transition: border-color 0.2s;
}
input:focus { border-color: #6ab2f2; }
input::placeholder { color: #5a6e7e; letter-spacing: 0; font-size: 14px; }
button {
  width: 100%;
  padding: 14px;
  margin-top: 16px;
  background: #6ab2f2;
  color: #0e1621;
  border: none;
  border-radius: 12px;
  font-size: 16px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s;
}
button:hover { background: #7dc0f7; }
.cancel {
  background: transparent;
  color: #6d7f8f;
  margin-top: 8px;
  font-size: 13px;
}
.cancel:hover { color: #f5f5f5; background: transparent; }
</style></head>
<body>
<div class="login-card">
  <div class="logo">🦞</div>
  <h1>${title}</h1>
  <p class="subtitle">${subtitle}</p>
  <input id="input" type="${inputType}" placeholder="${placeholder}" autofocus />
  <button id="submit" onclick="submit()">Continue</button>
  <button class="cancel" onclick="cancel()">Cancel</button>
</div>
<script>
const vscode = acquireVsCodeApi();
const input = document.getElementById('input');
function submit() {
  const val = input.value.trim();
  if (val) vscode.postMessage({ type: 'submit', value: val });
}
function cancel() { vscode.postMessage({ type: 'cancel' }); }
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submit();
  if (e.key === 'Escape') cancel();
});
</script>
</body></html>`;
  }

  private async webviewLogin(): Promise<{ phone: string } | null> {
    const phone = await this.webviewPrompt(
      'Log in to Telegram',
      'Enter your phone number with country code',
      'tel',
      '+1 234 567 8900'
    );
    if (!phone) return null;
    return { phone };
  }

  private webviewPrompt(title: string, subtitle: string, inputType: string, placeholder?: string): Promise<string | null> {
    return new Promise((resolve) => {
      if (this.loginResolve) {
        // Reuse existing panel, update content
        this.loginResolve = resolve;
        if (this.loginPanel) {
          this.loginPanel.webview.html = this.getLoginHtml(title, subtitle, inputType === 'code' ? 'text' : inputType, placeholder || '');
        }
        return;
      }

      this.loginResolve = resolve;

      if (!this.loginPanel) {
        this.loginPanel = vscode.window.createWebviewPanel(
          'oceangram.login', '🦞 Telegram Login', vscode.ViewColumn.One,
          { enableScripts: true, retainContextWhenHidden: true }
        );
        this.loginPanel.onDidDispose(() => {
          this.loginPanel = undefined;
          if (this.loginResolve) { this.loginResolve(null); this.loginResolve = undefined; }
        });
        this.loginPanel.webview.onDidReceiveMessage((msg) => {
          if (msg.type === 'submit' && this.loginResolve) {
            const r = this.loginResolve;
            this.loginResolve = undefined;
            r(msg.value);
          } else if (msg.type === 'cancel' && this.loginResolve) {
            const r = this.loginResolve;
            this.loginResolve = undefined;
            r(null);
          }
        });
      }

      this.loginPanel.webview.html = this.getLoginHtml(title, subtitle, inputType === 'code' ? 'text' : inputType, placeholder || '');
      this.loginPanel.reveal(vscode.ViewColumn.One);
    });
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.disconnect();
      this.connected = false;
    }
  }

  // --- Pinning ---

  getPinnedIds(): string[] {
    try {
      if (fs.existsSync(getPath('pinned.json'))) {
        return JSON.parse(fs.readFileSync(getPath('pinned.json'), 'utf-8'));
      }
    } catch { /* ignore */ }
    return [];
  }

  private savePinnedIds(ids: string[]): void {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    fs.writeFileSync(getPath('pinned.json'), JSON.stringify(ids, null, 2));
  }

  pinDialog(dialogId: string): void {
    const ids = this.getPinnedIds();
    if (!ids.includes(dialogId)) {
      ids.push(dialogId);
      this.savePinnedIds(ids);
    }
  }

  unpinDialog(dialogId: string): void {
    const ids = this.getPinnedIds().filter(id => id !== dialogId);
    this.savePinnedIds(ids);
  }

  // --- Helpers ---

  private getInitials(name: string): string {
    return name.split(' ').map(w => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
  }

  private getEntityName(entity: any): string {
    if (!entity) return 'Unknown';
    if (entity.title) return entity.title;
    const parts = [entity.firstName, entity.lastName].filter(Boolean);
    return parts.join(' ') || entity.username || 'Unknown';
  }

  private getEntityId(dialog: any): string {
    const peer = dialog.id;
    if (peer) return peer.toString();
    return '0';
  }

  /** Parse a dialog ID like "chatId:topicId" */
  static parseDialogId(id: string): { chatId: string; topicId?: number } {
    const parts = id.split(':');
    if (parts.length === 2) {
      return { chatId: parts[0], topicId: parseInt(parts[1], 10) };
    }
    return { chatId: id };
  }

  /** Make a dialog ID from chat + optional topic */
  static makeDialogId(chatId: string, topicId?: number): string {
    return topicId ? `${chatId}:${topicId}` : chatId;
  }

  // --- Forum Topics ---

  private async getForumTopics(chatId: string): Promise<Api.ForumTopic[]> {
    if (!this.client) throw new Error('Not connected');
    const cached = this.forumTopicsCache.get(chatId);
    if (cached) return cached;

    try {
      const entity = await this.client.getEntity(chatId);
      const result = await this.client.invoke(
        new Api.channels.GetForumTopics({
          channel: entity as any,
          limit: 100,
          offsetDate: 0,
          offsetId: 0,
          offsetTopic: 0,
        })
      );
      const topics = (result.topics || []).filter(
        (t: any) => t instanceof Api.ForumTopic
      ) as Api.ForumTopic[];
      this.forumTopicsCache.set(chatId, topics);
      return topics;
    } catch (err) {
      // Not a forum or no permission
      return [];
    }
  }

  private isForumGroup(entity: any): boolean {
    return entity?.forum === true;
  }

  // --- Dialogs ---

  async getDialogs(limit = 100): Promise<DialogInfo[]> {
    // Stale-while-revalidate: return cache immediately, refresh in background
    const now = Date.now();

    // Try memory cache first, then disk cache
    if (!this.dialogCache) {
      this.loadDialogCache();
      this.loadMessageCache(); // Also load message cache on first access
    }

    if (this.dialogCache && this.dialogCache.length > 0) {
      // Update pinned status from current pinned list
      const pinnedIds = this.getPinnedIds();
      this.dialogCache.forEach(d => d.isPinned = pinnedIds.includes(d.id));

      // If stale, refresh in background
      if (now - this.dialogCacheTime > this.dialogCacheTTL && !this.dialogRefreshing) {
        this.dialogRefreshing = true;
        this.fetchDialogsFresh(limit).then(fresh => {
          this.dialogCache = fresh;
          this.dialogCacheTime = Date.now();
          this.dialogRefreshing = false;
          this.saveDialogCache(fresh);
          this.emitDialogUpdate(fresh);
        }).catch(() => { this.dialogRefreshing = false; });
      }
      return this.dialogCache;
    }

    // No cache — fetch fresh (blocking)
    const fresh = await this.fetchDialogsFresh(limit);
    this.dialogCache = fresh;
    this.dialogCacheTime = Date.now();
    this.saveDialogCache(fresh);
    return fresh;
  }

  /** Get cached dialogs synchronously (for client-side search) */
  getCachedDialogs(): DialogInfo[] | null {
    if (this.dialogCache) return this.dialogCache;
    return this.loadDialogCache();
  }

  private async fetchDialogsFresh(limit = 100): Promise<DialogInfo[]> {
    if (!this.client) throw new Error('Not connected');
    const dialogs = await this.client.getDialogs({ limit });
    const pinnedIds = this.getPinnedIds();
    const results: DialogInfo[] = [];

    for (const d of dialogs) {
      const chatId = this.getEntityId(d);
      const groupName = this.getEntityName(d.entity);
      const isForum = this.isForumGroup(d.entity);

      if (isForum) {
        // For forum groups, list each topic as a separate entry
        try {
          const topics = await this.getForumTopics(chatId);
          for (const topic of topics) {
            const topicId = topic.id;
            const dialogId = TelegramService.makeDialogId(chatId, topicId);
            const topicTitle = topic.title || 'General';
            const displayName = `${groupName} / ${topicTitle}`;

            // Extract topic emoji
            let topicEmoji: string | undefined;
            // Check if title ends with an emoji
            const emojiMatch = topicTitle.match(/([\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}])\s*$/u);
            if (emojiMatch) {
              topicEmoji = emojiMatch[1];
            } else if (topicTitle === 'General' || topicId === 1) {
              topicEmoji = '💬';
            } else {
              topicEmoji = '⌗';
            }

            results.push({
              id: dialogId,
              chatId,
              topicId,
              name: displayName,
              lastMessage: '', // Topic-level last message requires extra fetch
              lastMessageTime: topic.date || 0,
              unreadCount: topic.unreadCount || 0,
              initials: this.getInitials(groupName),
              isPinned: pinnedIds.includes(dialogId),
              isForum: true,
              topicEmoji,
              groupName,
              topicName: topicTitle,
            });
          }
        } catch {
          // Fallback: show the group as a single entry
          results.push({
            id: chatId,
            chatId,
            name: groupName,
            lastMessage: d.message?.message || '',
            lastMessageTime: d.message?.date || 0,
            unreadCount: d.unreadCount || 0,
            initials: this.getInitials(groupName),
            isPinned: pinnedIds.includes(chatId),
            isForum: true,
          });
        }
      } else {
        // Regular chat/group
        results.push({
          id: chatId,
          chatId,
          name: groupName,
          lastMessage: d.message?.message || '',
          lastMessageTime: d.message?.date || 0,
          unreadCount: d.unreadCount || 0,
          initials: this.getInitials(groupName),
          isPinned: pinnedIds.includes(chatId),
          isForum: false,
        });
      }
    }

    return results;
  }

  /** Search dialogs — uses cache for instant results, API as fallback */
  searchDialogsFromCache(query: string): DialogInfo[] {
    const cached = this.getCachedDialogs();
    if (!cached) return [];
    const q = query.toLowerCase();
    return cached.filter(d => d.name.toLowerCase().includes(q));
  }

  async searchDialogs(query: string): Promise<DialogInfo[]> {
    const all = await this.getDialogs(200);
    const q = query.toLowerCase();
    return all.filter(d => d.name.toLowerCase().includes(q));
  }

  // --- Messages ---

  async searchMessages(dialogId: string, query: string, limit: number = 20): Promise<MessageInfo[]> {
    if (!this.client) throw new Error('Not connected');
    const { chatId, topicId } = TelegramService.parseDialogId(dialogId);
    const entity = await this.client.getEntity(chatId);

    const opts: any = { limit, search: query };
    if (topicId) opts.replyTo = topicId;

    const msgs = await this.client.getMessages(entity, opts);
    const results: MessageInfo[] = [];
    for (const msg of msgs) {
      if (!msg.message && !msg.media) continue;
      results.push(await this.messageToInfo(msg));
    }
    return results;
  }

  async getMessages(dialogId: string, limit = 20, offsetId?: number): Promise<MessageInfo[]> {
    // For initial load (no offsetId), use cache
    if (!offsetId) {
      const cached = this.messageCache.get(dialogId);
      if (cached && cached.messages.length > 0) {
        // Return cache immediately, refresh in background
        const now = Date.now();
        if (now - cached.timestamp > this.messageCacheTTL) {
          this.fetchMessagesFresh(dialogId, limit).then(fresh => {
            this.updateMessageCache(dialogId, fresh);
            // Emit update via chat event listeners
            const listeners = this.chatListeners.get(dialogId);
            if (listeners) {
              for (const listener of listeners) {
                try { listener({ type: 'messagesRefreshed' as any, messages: fresh } as any); } catch {}
              }
            }
          }).catch(() => {});
        }
        return cached.messages;
      }
    }

    const fresh = await this.fetchMessagesFresh(dialogId, limit, offsetId);
    if (!offsetId) {
      this.updateMessageCache(dialogId, fresh);
    }
    return fresh;
  }

  private updateMessageCache(dialogId: string, messages: MessageInfo[]) {
    const existing = this.messageCache.get(dialogId);
    let merged = messages;
    if (existing) {
      // Merge: keep new messages + any existing that aren't in the fresh batch
      const freshIds = new Set(messages.map(m => m.id));
      const kept = existing.messages.filter(m => !freshIds.has(m.id));
      merged = [...kept, ...messages].sort((a, b) => a.timestamp - b.timestamp || a.id - b.id).slice(-50);
    }
    this.messageCache.set(dialogId, { messages: merged, timestamp: Date.now() });
    this.saveMessageCacheForChat(dialogId);
  }

  /** Append a single message to cache (for real-time events) */
  appendMessageToCache(dialogId: string, message: MessageInfo) {
    const entry = this.messageCache.get(dialogId);
    if (entry) {
      if (!entry.messages.some(m => m.id === message.id)) {
        entry.messages.push(message);
        if (entry.messages.length > 50) entry.messages.shift();
        entry.timestamp = Date.now();
        this.saveMessageCacheForChat(dialogId);
      }
    } else {
      this.messageCache.set(dialogId, { messages: [message], timestamp: Date.now() });
      this.saveMessageCacheForChat(dialogId);
    }
  }

  private async fetchMessagesFresh(dialogId: string, limit = 20, offsetId?: number): Promise<MessageInfo[]> {
    if (!this.client) throw new Error('Not connected');
    const { chatId, topicId } = TelegramService.parseDialogId(dialogId);
    const entity = await this.client.getEntity(chatId);

    const opts: any = { limit };
    if (topicId) opts.replyTo = topicId;
    if (offsetId) opts.offsetId = offsetId;

    const msgs = await this.client.getMessages(entity, opts);

    // Build a map of message IDs for reply lookups
    const msgMap = new Map<number, any>();
    for (const m of msgs) {
      msgMap.set(m.id, m);
    }

    const results: MessageInfo[] = [];
    for (const msg of msgs) {
      let senderName = 'Unknown';
      if (msg.senderId) {
        try {
          const sender = await this.client.getEntity(msg.senderId);
          senderName = this.getEntityName(sender);
        } catch { /* ignore */ }
      }

      const info: MessageInfo = {
        id: msg.id,
        senderId: msg.senderId?.toString() || '',
        senderName,
        text: msg.message || '',
        timestamp: msg.date || 0,
        isOutgoing: msg.out || false,
      };

      // --- Media detection ---
      if (msg.photo) {
        info.mediaType = 'photo';
        try {
          const buffer = await this.client!.downloadMedia(msg, {});
          if (buffer && Buffer.isBuffer(buffer)) {
            info.mediaUrl = `data:image/jpeg;base64,${buffer.toString('base64')}`;
          }
        } catch { /* ignore download errors */ }
      } else if (msg.media) {
        const media = msg.media as any;
        const className = media.className || '';
        if (className === 'MessageMediaPhoto') {
          info.mediaType = 'photo';
          try {
            const buffer = await this.client!.downloadMedia(msg, {});
            if (buffer && Buffer.isBuffer(buffer)) {
              info.mediaUrl = `data:image/jpeg;base64,${buffer.toString('base64')}`;
            }
          } catch { /* ignore */ }
        } else if (className === 'MessageMediaDocument') {
          const doc = media.document;
          if (doc) {
            const attrs = doc.attributes || [];
            const isVideo = attrs.some((a: any) => a.className === 'DocumentAttributeVideo');
            const isAudio = attrs.some((a: any) => a.className === 'DocumentAttributeAudio');
            const isSticker = attrs.some((a: any) => a.className === 'DocumentAttributeSticker');
            const isAnimated = attrs.some((a: any) => a.className === 'DocumentAttributeAnimated');
            const filenameAttr = attrs.find((a: any) => a.className === 'DocumentAttributeFilename');

            if (isSticker) {
              info.mediaType = 'sticker';
            } else if (isAnimated || (isVideo && doc.mimeType === 'video/mp4' && !filenameAttr && media.document?.mimeType === 'video/mp4')) {
              info.mediaType = 'gif';
            } else if (isVideo) {
              info.mediaType = 'video';
            } else if (isAudio) {
              const audioAttr = attrs.find((a: any) => a.className === 'DocumentAttributeAudio');
              info.mediaType = audioAttr?.voice ? 'voice' : 'file';
              if (audioAttr?.duration) info.duration = audioAttr.duration;
            } else {
              info.mediaType = 'file';
            }
            // Extract duration from video/gif attributes
            if (info.mediaType === 'video' || info.mediaType === 'gif') {
              const videoAttr = attrs.find((a: any) => a.className === 'DocumentAttributeVideo');
              if (videoAttr?.duration) info.duration = videoAttr.duration;
            }
            if (filenameAttr) info.fileName = filenameAttr.fileName;
            if (doc.size) info.fileSize = typeof doc.size === 'number' ? doc.size : Number(doc.size);
          }
        } else if (className === 'MessageMediaWebPage') {
          // Link preview
          const webpage = media.webpage;
          if (webpage && webpage.className === 'WebPage') {
            info.linkPreview = {
              url: webpage.url || '',
              title: webpage.title,
              description: webpage.description,
            };
            // We could extract image but skip for now
          }
        }
      }

      // --- Reply-to ---
      // Skip if replyToMsgId matches topicId (forum topic root, not a real reply)
      if (msg.replyTo && msg.replyTo.replyToMsgId && msg.replyTo.replyToMsgId !== topicId) {
        info.replyToId = msg.replyTo.replyToMsgId;
        const repliedMsg = msgMap.get(msg.replyTo.replyToMsgId);
        if (repliedMsg) {
          info.replyToText = (repliedMsg.message || '').slice(0, 100);
          if (repliedMsg.senderId) {
            try {
              const replySender = await this.client!.getEntity(repliedMsg.senderId);
              info.replyToSender = this.getEntityName(replySender);
            } catch { /* ignore */ }
          }
        }
      }

      // --- Forward ---
      if (msg.fwdFrom) {
        if (msg.fwdFrom.fromName) {
          info.forwardFrom = msg.fwdFrom.fromName;
        } else if (msg.fwdFrom.fromId) {
          try {
            const fwdEntity = await this.client!.getEntity(msg.fwdFrom.fromId);
            info.forwardFrom = this.getEntityName(fwdEntity);
          } catch {
            info.forwardFrom = 'Unknown';
          }
        }
      }

      // --- Edited ---
      if (msg.editDate) {
        info.isEdited = true;
      }

      // --- Entities ---
      if (msg.entities && msg.entities.length > 0) {
        info.entities = msg.entities.map((e: any) => {
          const entity: MessageEntity = {
            type: this.mapEntityType(e.className),
            offset: e.offset,
            length: e.length,
          };
          if (e.url) entity.url = e.url;
          if (e.language) entity.language = e.language;
          return entity;
        }).filter((e: MessageEntity) => e.type !== undefined);
      }

      // --- Reactions ---
      if (msg.reactions && msg.reactions.results) {
        info.reactions = msg.reactions.results
          .filter((r: any) => r.reaction && r.count)
          .map((r: any) => ({
            emoji: r.reaction.emoticon || r.reaction.documentId?.toString() || '❓',
            count: r.count || 0,
            isSelected: r.chosen || r.chosenOrder !== undefined || false,
          }));
      }

      results.push(info);
    }

    return results.reverse();
  }

  private mapEntityType(className: string): MessageEntity['type'] {
    const map: Record<string, MessageEntity['type']> = {
      'MessageEntityBold': 'bold',
      'MessageEntityItalic': 'italic',
      'MessageEntityCode': 'code',
      'MessageEntityPre': 'pre',
      'MessageEntityStrike': 'strikethrough',
      'MessageEntityUrl': 'url',
      'MessageEntityTextUrl': 'text_link',
    };
    return map[className] as MessageEntity['type'];
  }

  async sendMessage(dialogId: string, text: string, replyToMsgId?: number): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    const { chatId, topicId } = TelegramService.parseDialogId(dialogId);
    const entity = await this.client.getEntity(chatId);

    const opts: any = { message: text };
    if (topicId) opts.replyTo = topicId;
    if (replyToMsgId) opts.replyTo = replyToMsgId;

    await this.client.sendMessage(entity, opts);
  }

  async editMessage(dialogId: string, messageId: number, text: string): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    const { chatId } = TelegramService.parseDialogId(dialogId);
    const entity = await this.client.getEntity(chatId);
    await this.client.editMessage(entity, { message: messageId, text });
  }

  async deleteMessages(dialogId: string, messageIds: number[], revoke: boolean): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    const { chatId } = TelegramService.parseDialogId(dialogId);
    const entity = await this.client.getEntity(chatId);
    await this.client.deleteMessages(entity, messageIds, { revoke });
    // Remove from cache
    const cached = this.messageCache.get(dialogId);
    if (cached) {
      const delSet = new Set(messageIds);
      this.messageCache.set(dialogId, cached.filter(m => !delSet.has(m.id)));
    }
  }

  // --- Profile Photo Cache ---

  /**
   * Get cached profile photo for a user. Returns base64 data URI, null (no photo), or undefined (not cached).
   */
  getProfilePhoto(userId: string): string | null | undefined {
    return this.profilePhotoCache.get(userId);
  }

  /**
   * Fetch profile photos for multiple user IDs in the background.
   * Skips already-cached or in-progress fetches.
   */
  async fetchProfilePhotos(userIds: string[]): Promise<Map<string, string | null>> {
    if (!this.client) return new Map();

    const toFetch = userIds.filter(id => !this.profilePhotoCache.has(id) && !this.profilePhotoFetching.has(id));
    const result = new Map<string, string | null>();

    // Return cached values for already-known ids
    for (const id of userIds) {
      if (this.profilePhotoCache.has(id)) {
        result.set(id, this.profilePhotoCache.get(id)!);
      }
    }

    // Fetch new ones (limit concurrency to avoid flooding)
    const batch = toFetch.slice(0, 10);
    for (const userId of batch) {
      this.profilePhotoFetching.add(userId);
    }

    await Promise.allSettled(batch.map(async (userId) => {
      try {
        const entity = await this.client!.getEntity(userId);
        const photoBuffer = await this.client!.downloadProfilePhoto(entity, { isBig: false });
        if (photoBuffer && Buffer.isBuffer(photoBuffer) && photoBuffer.length > 0) {
          const dataUri = `data:image/jpeg;base64,${photoBuffer.toString('base64')}`;
          this.profilePhotoCache.set(userId, dataUri);
          result.set(userId, dataUri);
        } else {
          this.profilePhotoCache.set(userId, null);
          result.set(userId, null);
        }
      } catch {
        this.profilePhotoCache.set(userId, null);
        result.set(userId, null);
      } finally {
        this.profilePhotoFetching.delete(userId);
      }
    }));

    return result;
  }

  // --- User Info ---

  async getUserInfo(userId: string): Promise<{
    name: string;
    username?: string;
    phone?: string;
    bio?: string;
    photo?: string;
    lastSeen?: string;
    isBot: boolean;
    id: string;
  }> {
    if (!this.client) throw new Error('Not connected');

    const entity = await this.client.getEntity(userId);
    const user = entity as Api.User;

    const name = [user.firstName, user.lastName].filter(Boolean).join(' ') || 'Unknown';
    const result: any = {
      name,
      username: user.username,
      phone: user.phone,
      isBot: user.bot || false,
      id: userId,
    };

    // Last seen
    if (user.status) {
      const statusName = user.status.className;
      if (statusName === 'UserStatusOnline') {
        result.lastSeen = 'online';
      } else if (statusName === 'UserStatusOffline') {
        const offStatus = user.status as Api.UserStatusOffline;
        const d = new Date(offStatus.wasOnline * 1000);
        result.lastSeen = 'last seen ' + d.toLocaleString();
      } else if (statusName === 'UserStatusRecently') {
        result.lastSeen = 'last seen recently';
      } else if (statusName === 'UserStatusLastWeek') {
        result.lastSeen = 'last seen within a week';
      } else if (statusName === 'UserStatusLastMonth') {
        result.lastSeen = 'last seen within a month';
      }
    }

    // Full user info (bio)
    try {
      const fullUser = await this.client.invoke(
        new Api.users.GetFullUser({ id: user })
      );
      if (fullUser.fullUser?.about) {
        result.bio = fullUser.fullUser.about;
      }
    } catch { /* ignore - may not have permission */ }

    // Profile photo
    try {
      const photoBuffer = await this.client.downloadProfilePhoto(user, { isBig: true });
      if (photoBuffer && Buffer.isBuffer(photoBuffer) && photoBuffer.length > 0) {
        result.photo = `data:image/jpeg;base64,${photoBuffer.toString('base64')}`;
      }
    } catch { /* ignore */ }

    return result;
  }

  // --- Real-time Event Handlers ---

  private eventHandlersRegistered = false;
  private chatListeners: Map<string, Set<ChatEventListener>> = new Map();

  /**
   * Subscribe to real-time events for a specific dialog.
   * Returns an unsubscribe function.
   */
  onChatEvent(dialogId: string, listener: ChatEventListener): () => void {
    if (!this.chatListeners.has(dialogId)) {
      this.chatListeners.set(dialogId, new Set());
    }
    this.chatListeners.get(dialogId)!.add(listener);
    this.ensureEventHandlers();

    return () => {
      const listeners = this.chatListeners.get(dialogId);
      if (listeners) {
        listeners.delete(listener);
        if (listeners.size === 0) {
          this.chatListeners.delete(dialogId);
        }
      }
    };
  }

  private emit(dialogId: string, event: ChatEvent) {
    const listeners = this.chatListeners.get(dialogId);
    if (listeners) {
      for (const listener of listeners) {
        try { listener(event); } catch (e) { console.error('[Oceangram] Event listener error:', e); }
      }
    }
  }

  /** Convert a gramJS message to MessageInfo (single message, lightweight) */
  private async messageToInfo(msg: Api.Message, forumTopicId?: number): Promise<MessageInfo> {
    let senderName = 'Unknown';
    if (msg.senderId && this.client) {
      try {
        const sender = await this.client.getEntity(msg.senderId);
        senderName = this.getEntityName(sender);
      } catch { /* ignore */ }
    }

    const info: MessageInfo = {
      id: msg.id,
      senderId: msg.senderId?.toString() || '',
      senderName,
      text: msg.message || '',
      timestamp: msg.date || 0,
      isOutgoing: msg.out || false,
    };

    // Media detection (simplified for real-time — skip downloading photos)
    if (msg.photo || (msg.media as any)?.className === 'MessageMediaPhoto') {
      info.mediaType = 'photo';
      // Download in background for real-time events
      if (this.client) {
        try {
          const buffer = await this.client.downloadMedia(msg, {});
          if (buffer && Buffer.isBuffer(buffer)) {
            info.mediaUrl = `data:image/jpeg;base64,${buffer.toString('base64')}`;
          }
        } catch { /* ignore */ }
      }
    } else if (msg.media) {
      const media = msg.media as any;
      const className = media.className || '';
      if (className === 'MessageMediaDocument') {
        const doc = media.document;
        if (doc) {
          const attrs = doc.attributes || [];
          const isVideo = attrs.some((a: any) => a.className === 'DocumentAttributeVideo');
          const isAudio = attrs.some((a: any) => a.className === 'DocumentAttributeAudio');
          const isSticker = attrs.some((a: any) => a.className === 'DocumentAttributeSticker');
          if (isSticker) info.mediaType = 'sticker';
          else if (isVideo) info.mediaType = 'video';
          else if (isAudio) {
            const audioAttr = attrs.find((a: any) => a.className === 'DocumentAttributeAudio');
            info.mediaType = audioAttr?.voice ? 'voice' : 'file';
          } else info.mediaType = 'file';
          const filenameAttr = attrs.find((a: any) => a.className === 'DocumentAttributeFilename');
          if (filenameAttr) info.fileName = filenameAttr.fileName;
        }
      } else if (className === 'MessageMediaWebPage') {
        const webpage = media.webpage;
        if (webpage && webpage.className === 'WebPage') {
          info.linkPreview = { url: webpage.url || '', title: webpage.title, description: webpage.description };
        }
      }
    }

    // Reply-to (skip forum topic root replies)
    if (msg.replyTo && msg.replyTo.replyToMsgId && msg.replyTo.replyToMsgId !== forumTopicId) {
      info.replyToId = msg.replyTo.replyToMsgId;
    }

    // Forward
    if (msg.fwdFrom) {
      if (msg.fwdFrom.fromName) info.forwardFrom = msg.fwdFrom.fromName;
      else if (msg.fwdFrom.fromId && this.client) {
        try { info.forwardFrom = this.getEntityName(await this.client.getEntity(msg.fwdFrom.fromId)); } catch { info.forwardFrom = 'Unknown'; }
      }
    }

    // Edited
    if (msg.editDate) info.isEdited = true;

    // Entities
    if (msg.entities && msg.entities.length > 0) {
      info.entities = msg.entities.map((e: any) => {
        const entity: MessageEntity = { type: this.mapEntityType(e.className), offset: e.offset, length: e.length };
        if (e.url) entity.url = e.url;
        if (e.language) entity.language = e.language;
        return entity;
      }).filter((e: MessageEntity) => e.type !== undefined);
    }

    // Reactions
    if (msg.reactions && (msg.reactions as any).results) {
      info.reactions = (msg.reactions as any).results
        .filter((r: any) => r.reaction && r.count)
        .map((r: any) => ({
          emoji: r.reaction.emoticon || r.reaction.documentId?.toString() || '❓',
          count: r.count || 0,
          isSelected: r.chosen || r.chosenOrder !== undefined || false,
        }));
    }

    return info;
  }

  /** Determine dialog ID for a message (chatId or chatId:topicId for forums) */
  private getDialogIdFromMessage(msg: Api.Message): string[] {
    const chatId = msg.peerId ? this.peerToId(msg.peerId) : '';
    if (!chatId) return [];

    const ids: string[] = [chatId];

    // For forum topics, also emit on chatId:topicId
    if (msg.replyTo && (msg.replyTo as any).forumTopic) {
      const topicId = msg.replyTo.replyToTopId || msg.replyTo.replyToMsgId;
      if (topicId) {
        ids.push(TelegramService.makeDialogId(chatId, topicId));
      }
    }

    return ids;
  }

  private peerToId(peer: Api.TypePeer): string {
    if (peer instanceof Api.PeerUser) return peer.userId.toString();
    if (peer instanceof Api.PeerChat) return `-${peer.chatId.toString()}`;
    if (peer instanceof Api.PeerChannel) return `-100${peer.channelId.toString()}`;
    return '';
  }

  private ensureEventHandlers() {
    if (this.eventHandlersRegistered || !this.client) return;
    this.eventHandlersRegistered = true;

    // New messages
    this.client.addEventHandler(async (event: NewMessageEvent) => {
      const msg = event.message as Api.Message;
      if (!msg) return;
      const dialogIds = this.getDialogIdFromMessage(msg);
      if (dialogIds.length === 0) return;

      // Only process if someone is listening
      const hasListener = dialogIds.some(id => this.chatListeners.has(id));
      if (!hasListener) return;

      // Extract forum topic ID from message for filtering reply-to
      const evtTopicId = msg.replyTo && (msg.replyTo as any).forumTopic
        ? (msg.replyTo.replyToTopId || msg.replyTo.replyToMsgId)
        : undefined;
      const info = await this.messageToInfo(msg, evtTopicId);
      for (const dialogId of dialogIds) {
        this.appendMessageToCache(dialogId, info);
        this.emit(dialogId, { type: 'newMessage', message: info });
      }
    }, new NewMessage({}));

    // Edited messages
    this.client.addEventHandler(async (event: EditedMessageEvent) => {
      const msg = event.message as Api.Message;
      if (!msg) return;
      const dialogIds = this.getDialogIdFromMessage(msg);
      if (dialogIds.length === 0) return;

      const hasListener = dialogIds.some(id => this.chatListeners.has(id));
      if (!hasListener) return;

      const editTopicId = msg.replyTo && (msg.replyTo as any).forumTopic
        ? (msg.replyTo.replyToTopId || msg.replyTo.replyToMsgId)
        : undefined;
      const info = await this.messageToInfo(msg, editTopicId);
      for (const dialogId of dialogIds) {
        this.emit(dialogId, { type: 'editMessage', message: info });
      }
    }, new EditedMessage({}));

    // Deleted messages
    this.client.addEventHandler(async (event: DeletedMessageEvent) => {
      const deletedIds = event.deletedIds;
      const peer = event.peer;
      // For channels/supergroups we can determine the chat
      // For private chats, broadcast to all listeners
      if (peer && this.client) {
        try {
          const entity = await this.client.getEntity(peer);
          const chatId = (entity as any).id?.toString() || '';
          if (chatId) {
            // Try all possible dialog IDs for this chat
            for (const [dialogId, listeners] of this.chatListeners) {
              const parsed = TelegramService.parseDialogId(dialogId);
              if (parsed.chatId === chatId || parsed.chatId === `-100${chatId}`) {
                this.emit(dialogId, { type: 'deleteMessages', messageIds: deletedIds });
              }
            }
            return;
          }
        } catch { /* ignore */ }
      }
      // Broadcast to all listeners as fallback
      for (const [dialogId] of this.chatListeners) {
        this.emit(dialogId, { type: 'deleteMessages', messageIds: deletedIds });
      }
    }, new DeletedMessage({}));

    // Typing indicators via raw updates
    this.client.addEventHandler(async (update: Api.TypeUpdate) => {
      try {
        let chatId = '';
        let userId = '';

        if (update instanceof Api.UpdateUserTyping) {
          // DM typing
          userId = update.userId.toString();
          chatId = userId;
        } else if (update instanceof Api.UpdateChatUserTyping) {
          chatId = `-${update.chatId.toString()}`;
          userId = update.fromId && update.fromId instanceof Api.PeerUser
            ? update.fromId.userId.toString() : '';
        } else if (update instanceof Api.UpdateChannelUserTyping) {
          chatId = `-100${update.channelId.toString()}`;
          userId = update.fromId && update.fromId instanceof Api.PeerUser
            ? update.fromId.userId.toString() : '';
        } else {
          return;
        }

        if (!userId || !chatId) return;

        // Check if anyone is listening on this chatId or any topic under it
        const matchingDialogIds: string[] = [];
        for (const [dialogId] of this.chatListeners) {
          const parsed = TelegramService.parseDialogId(dialogId);
          if (parsed.chatId === chatId) {
            matchingDialogIds.push(dialogId);
          }
        }
        if (matchingDialogIds.length === 0) return;

        // Resolve user name
        let userName = 'Someone';
        try {
          const entity = await this.client!.getEntity(userId);
          userName = this.getEntityName(entity);
        } catch { /* ignore */ }

        for (const dialogId of matchingDialogIds) {
          this.emit(dialogId, { type: 'typing', userId, userName });
        }
      } catch (err) {
        console.error('[Oceangram] Typing handler error:', err);
      }
    });

    console.log('[Oceangram] Real-time event handlers registered');
  }

  /** Send typing indicator to a dialog */
  async sendTyping(dialogId: string): Promise<void> {
    if (!this.client) return;
    try {
      const { chatId, topicId } = TelegramService.parseDialogId(dialogId);
      const entity = await this.client.getEntity(chatId);
      const params: any = {
        peer: entity,
        action: new Api.SendMessageTypingAction(),
      };
      if (topicId) params.topMsgId = topicId;
      await this.client.invoke(new Api.messages.SetTyping(params));
    } catch {
      // Silently ignore typing errors
    }
  }
}

// --- Event types ---

export type ChatEvent =
  | { type: 'newMessage'; message: MessageInfo }
  | { type: 'editMessage'; message: MessageInfo }
  | { type: 'deleteMessages'; messageIds: number[] }
  | { type: 'typing'; userId: string; userName: string };

export type ChatEventListener = (event: ChatEvent) => void;
