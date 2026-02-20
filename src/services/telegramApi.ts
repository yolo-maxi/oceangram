/**
 * TelegramApiClient — HTTP/WS client that talks to oceangram-daemon.
 * Drop-in replacement for TelegramService (same public API surface).
 */
import * as http from 'http';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type {
  DialogInfo, MessageInfo, ConnectionState, ConnectionStateListener,
  DialogUpdateListener, ChatEvent, ChatEventListener,
  UserStatus, UserStatusListener, GroupMember, ChatInfoResult,
  ChatMember, SharedMediaItem, LinkPreview, MessageEntity, ReactionInfo,
} from './telegram';

// Re-export types so consumers can import from here
export type {
  DialogInfo, MessageInfo, ConnectionState, ConnectionStateListener,
  DialogUpdateListener, ChatEvent, ChatEventListener,
  UserStatus, UserStatusListener, GroupMember, ChatInfoResult,
  ChatMember, SharedMediaItem,
};

export class TelegramApiClient {
  private baseUrl: string;
  private authToken?: string;
  private ws: any = null; // WebSocket
  private connected = false;
  private connectionState: ConnectionState = 'disconnected';
  private connectionStateListeners = new Set<ConnectionStateListener>();
  private dialogUpdateListeners = new Set<DialogUpdateListener>();
  private chatListeners = new Map<string, Set<ChatEventListener>>();
  private userStatusListeners = new Set<UserStatusListener>();
  private userStatuses = new Map<string, UserStatus>();

  // Local state (pinned, recent, caches — managed client-side)
  private configDir: string;
  private dialogCache: DialogInfo[] | null = null;
  private dialogCacheTime = 0;
  private dialogCacheTTL = 30_000;
  private dialogRefreshing = false;
  private messageCache = new Map<string, { messages: MessageInfo[]; timestamp: number }>();
  private messageCacheTTL = 30_000;
  private profilePhotoCache = new Map<string, string | null>();
  private profilePhotoFetching = new Set<string>();
  private lastKnownMessageIds = new Map<string, number>();

  constructor(baseUrl: string, configDir: string, authToken?: string) {
    this.baseUrl = baseUrl;
    this.configDir = configDir;
    this.authToken = authToken;
  }

  // --- HTTP helpers ---

  private async request<T = any>(method: string, path: string, body?: any): Promise<T> {
    return new Promise((resolve, reject) => {
      const url = new URL(path, this.baseUrl);
      const opts: http.RequestOptions = {
        method,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        timeout: 15000,
        headers: {
          'Content-Type': 'application/json',
          ...(this.authToken ? { 'Authorization': `Bearer ${this.authToken}` } : {}),
        },
      };

      const req = http.request(opts, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode && res.statusCode >= 400) {
              reject(new Error(parsed.error || `HTTP ${res.statusCode}`));
            } else {
              resolve(parsed);
            }
          } catch {
            if (res.statusCode && res.statusCode >= 400) {
              reject(new Error(`HTTP ${res.statusCode}: ${data}`));
            } else {
              resolve(data as any);
            }
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  private async requestBuffer(method: string, urlPath: string): Promise<{ buffer: Buffer; mimeType: string } | null> {
    return new Promise((resolve, reject) => {
      const url = new URL(urlPath, this.baseUrl);
      const opts: http.RequestOptions = {
        method,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        timeout: 30000,
        headers: {
          ...(this.authToken ? { 'Authorization': `Bearer ${this.authToken}` } : {}),
        },
      };

      const req = http.request(opts, (res) => {
        if (res.statusCode === 404) { resolve(null); return; }
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          resolve({ buffer, mimeType: res.headers['content-type'] || 'application/octet-stream' });
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
      req.end();
    });
  }

  // --- Connection ---

  async connect(): Promise<void> {
    if (this.connected) return;

    const health = await this.request('GET', '/health');
    if (health.status !== 'ok') throw new Error('Daemon not healthy');

    this.connected = true;

    if (!health.connected) {
      // Daemon running but Telegram not connected — need login
      // Don't throw; let the caller handle login flow
      console.log('[TelegramApi] Daemon running but not authenticated');
    }

    this.setConnectionState('connected');
    this.connectWebSocket();
    this.loadDialogCacheFromDisk();
    this.loadMessageCacheFromDisk();
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.setConnectionState('disconnected');
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
  }

  // --- WebSocket for real-time events ---

  private connectWebSocket(): void {
    try {
      // Use dynamic import for ws since it may or may not be available
      const WebSocket = require('ws');
      const wsUrl = this.baseUrl.replace('http://', 'ws://') + '/events';
      this.ws = new WebSocket(wsUrl);

      this.ws.on('message', (data: any) => {
        try {
          const event = JSON.parse(data.toString());
          this.handleDaemonEvent(event);
        } catch {}
      });

      this.ws.on('close', () => {
        // Reconnect after delay
        setTimeout(() => {
          if (this.connected) this.connectWebSocket();
        }, 3000);
      });

      this.ws.on('error', () => {
        // Will trigger close
      });
    } catch {
      console.error('[TelegramApi] WebSocket not available');
    }
  }

  private handleDaemonEvent(event: any): void {
    const dialogId = event.dialogId || '';

    switch (event.type) {
      case 'newMessage': {
        const msg = this.mapMessage(event.message);
        this.appendMessageToCache(dialogId, msg);
        this.emit(dialogId, { type: 'newMessage', message: msg });
        break;
      }
      case 'editedMessage': {
        const msg = this.mapMessage(event.message);
        this.emit(dialogId, { type: 'editMessage', message: msg });
        break;
      }
      case 'deletedMessage': {
        this.emit(dialogId, { type: 'deleteMessages', messageIds: event.messageIds || [] });
        break;
      }
      case 'typing': {
        this.emit(dialogId, { type: 'typing', userId: event.userId || '', userName: event.userId || 'Someone' });
        break;
      }
      case 'userStatus': {
        const status: UserStatus = { online: event.online || false, lastSeen: event.lastSeen };
        this.emitUserStatus(event.userId || '', status);
        break;
      }
      case 'readHistory': {
        this.emit(dialogId, { type: 'readOutbox', maxId: event.maxId || 0 });
        break;
      }
    }
  }

  // --- Event system (same API as TelegramService) ---

  private emit(dialogId: string, event: ChatEvent): void {
    const listeners = this.chatListeners.get(dialogId);
    if (listeners) {
      for (const listener of listeners) {
        try { listener(event); } catch (e) { console.error('[TelegramApi] Event listener error:', e); }
      }
    }
  }

  onChatEvent(dialogId: string, listener: ChatEventListener): () => void {
    if (!this.chatListeners.has(dialogId)) {
      this.chatListeners.set(dialogId, new Set());
    }
    this.chatListeners.get(dialogId)!.add(listener);
    return () => {
      const set = this.chatListeners.get(dialogId);
      if (set) {
        set.delete(listener);
        if (set.size === 0) this.chatListeners.delete(dialogId);
      }
    };
  }

  onDialogUpdate(listener: DialogUpdateListener): () => void {
    this.dialogUpdateListeners.add(listener);
    return () => { this.dialogUpdateListeners.delete(listener); };
  }

  onConnectionStateChange(listener: ConnectionStateListener): () => void {
    this.connectionStateListeners.add(listener);
    listener(this.connectionState);
    return () => { this.connectionStateListeners.delete(listener); };
  }

  getConnectionState(): ConnectionState { return this.connectionState; }

  private setConnectionState(state: ConnectionState, attempt?: number) {
    this.connectionState = state;
    for (const listener of this.connectionStateListeners) {
      try { listener(state, attempt); } catch {}
    }
  }

  onUserStatusChange(listener: UserStatusListener): () => void {
    this.userStatusListeners.add(listener);
    return () => { this.userStatusListeners.delete(listener); };
  }

  getUserStatus(userId: string): UserStatus | undefined {
    return this.userStatuses.get(userId);
  }

  private emitUserStatus(userId: string, status: UserStatus) {
    this.userStatuses.set(userId, status);
    for (const listener of this.userStatusListeners) {
      try { listener(userId, status); } catch {}
    }
  }

  // --- Dialogs ---

  async getDialogs(limit = 100): Promise<DialogInfo[]> {
    const now = Date.now();

    if (this.dialogCache && this.dialogCache.length > 0) {
      const pinnedIds = this.getPinnedIds();
      this.dialogCache.forEach(d => d.isPinned = pinnedIds.includes(d.id));

      if (now - this.dialogCacheTime > this.dialogCacheTTL && !this.dialogRefreshing) {
        this.dialogRefreshing = true;
        this.fetchDialogsFresh(limit).then(fresh => {
          this.dialogCache = fresh;
          this.dialogCacheTime = Date.now();
          this.dialogRefreshing = false;
          this.saveDialogCacheToDisk(fresh);
          for (const l of this.dialogUpdateListeners) { try { l(fresh); } catch {} }
        }).catch(() => { this.dialogRefreshing = false; });
      }
      return this.dialogCache;
    }

    const fresh = await this.fetchDialogsFresh(limit);
    this.dialogCache = fresh;
    this.dialogCacheTime = Date.now();
    this.saveDialogCacheToDisk(fresh);
    return fresh;
  }

  private async fetchDialogsFresh(limit: number): Promise<DialogInfo[]> {
    const dialogs: any[] = await this.request('GET', `/dialogs?limit=${limit}`);
    const pinnedIds = this.getPinnedIds();
    return dialogs.map(d => this.mapDialog(d, pinnedIds));
  }

  getCachedDialogs(): DialogInfo[] | null {
    if (this.dialogCache) return this.dialogCache;
    this.loadDialogCacheFromDisk();
    return this.dialogCache;
  }

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

  async getMessages(dialogId: string, limit = 20, offsetId?: number): Promise<MessageInfo[]> {
    if (!offsetId) {
      const cached = this.messageCache.get(dialogId);
      if (cached && cached.messages.length > 0) {
        const now = Date.now();
        if (now - cached.timestamp > this.messageCacheTTL) {
          this.fetchMessagesFresh(dialogId, limit).then(fresh => {
            this.updateMessageCache(dialogId, fresh);
            const listeners = this.chatListeners.get(dialogId);
            if (listeners) {
              for (const listener of listeners) {
                try { listener({ type: 'reconnected' } as any); } catch {}
              }
            }
          }).catch(() => {});
        }
        return cached.messages;
      }
    }

    const fresh = await this.fetchMessagesFresh(dialogId, limit, offsetId);
    if (!offsetId) this.updateMessageCache(dialogId, fresh);
    return fresh;
  }

  private async fetchMessagesFresh(dialogId: string, limit = 20, offsetId?: number): Promise<MessageInfo[]> {
    let url = `/dialogs/${encodeURIComponent(dialogId)}/messages?limit=${limit}`;
    if (offsetId) url += `&offsetId=${offsetId}`;
    const msgs: any[] = await this.request('GET', url);
    return msgs.map(m => this.mapMessage(m));
  }

  async getPinnedMessages(dialogId: string): Promise<MessageInfo[]> {
    try {
      const msgs: any[] = await this.request('GET', `/dialogs/${encodeURIComponent(dialogId)}/pinned`);
      return msgs.map(m => this.mapMessage(m));
    } catch {
      return [];
    }
  }

  async searchMessages(dialogId: string, query: string, limit = 20): Promise<MessageInfo[]> {
    const msgs: any[] = await this.request('GET', `/dialogs/${encodeURIComponent(dialogId)}/search?q=${encodeURIComponent(query)}&limit=${limit}`);
    return msgs.map(m => this.mapMessage(m));
  }

  async sendMessage(dialogId: string, text: string, replyToMsgId?: number): Promise<void> {
    await this.request('POST', `/dialogs/${encodeURIComponent(dialogId)}/messages`, {
      text,
      replyTo: replyToMsgId,
    });
  }

  async editMessage(dialogId: string, messageId: number, text: string): Promise<void> {
    await this.request('PATCH', `/messages/${messageId}`, { dialogId, text });
  }

  async deleteMessages(dialogId: string, messageIds: number[], _revoke: boolean): Promise<void> {
    for (const id of messageIds) {
      await this.request('DELETE', `/messages/${id}`, { dialogId });
    }
    // Remove from cache
    const cached = this.messageCache.get(dialogId);
    if (cached) {
      const delSet = new Set(messageIds);
      cached.messages = cached.messages.filter(m => !delSet.has(m.id));
    }
  }

  async sendTyping(dialogId: string): Promise<void> {
    try {
      await this.request('POST', `/dialogs/${encodeURIComponent(dialogId)}/typing`);
    } catch {}
  }

  // --- Media ---

  async downloadVideo(dialogId: string, messageId: number): Promise<string | undefined> {
    try {
      const result = await this.requestBuffer('GET', `/media/${messageId}?dialogId=${encodeURIComponent(dialogId)}`);
      if (result) {
        return `data:${result.mimeType};base64,${result.buffer.toString('base64')}`;
      }
    } catch {}
    return undefined;
  }

  async downloadFile(dialogId: string, messageId: number, _progressCb?: (downloaded: number, total: number) => void): Promise<{ buffer: Buffer; fileName: string; mimeType: string }> {
    const result = await this.requestBuffer('GET', `/media/${messageId}?dialogId=${encodeURIComponent(dialogId)}`);
    if (!result) throw new Error('No media');
    return { buffer: result.buffer, fileName: 'file', mimeType: result.mimeType };
  }

  async sendFile(dialogId: string, _buffer: Buffer, _fileName: string, _mimeType?: string, _caption?: string): Promise<void> {
    // TODO: Add file upload endpoint to daemon
    console.warn('[TelegramApi] sendFile not yet supported via daemon');
    throw new Error('File upload not yet supported via daemon API');
  }

  async sendVoice(dialogId: string, _buffer: Buffer, _duration: number, _waveform?: number[]): Promise<void> {
    // TODO: Add voice upload endpoint to daemon
    console.warn('[TelegramApi] sendVoice not yet supported via daemon');
    throw new Error('Voice upload not yet supported via daemon API');
  }

  // --- Profile ---

  getProfilePhoto(userId: string): string | null | undefined {
    return this.profilePhotoCache.get(userId);
  }

  async fetchProfilePhotos(userIds: string[]): Promise<Map<string, string | null>> {
    const result = new Map<string, string | null>();
    const toFetch = userIds.filter(id => !this.profilePhotoCache.has(id) && !this.profilePhotoFetching.has(id));

    for (const id of userIds) {
      if (this.profilePhotoCache.has(id)) result.set(id, this.profilePhotoCache.get(id)!);
    }

    const batch = toFetch.slice(0, 10);
    for (const id of batch) this.profilePhotoFetching.add(id);

    await Promise.allSettled(batch.map(async (userId) => {
      try {
        const res = await this.requestBuffer('GET', `/profile/${userId}/photo`);
        if (res) {
          const dataUri = `data:${res.mimeType};base64,${res.buffer.toString('base64')}`;
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

  async getUserInfo(userId: string): Promise<any> {
    try {
      return await this.request('GET', `/profile/${userId}`);
    } catch {
      return { name: 'Unknown', id: userId, isBot: false };
    }
  }

  async fetchUserStatus(userId: string): Promise<UserStatus> {
    // Not directly supported by daemon yet — return cached or unknown
    return this.userStatuses.get(userId) || { online: false, hidden: true };
  }

  // --- Group/Chat Info (delegate to daemon) ---

  async getGroupMembers(chatId: string, limit = 50): Promise<GroupMember[]> {
    try {
      return await this.request('GET', `/dialogs/${encodeURIComponent(chatId)}/members?limit=${limit}`);
    } catch {
      return [];
    }
  }

  async getChatInfo(dialogId: string): Promise<ChatInfoResult> {
    try {
      const info = await this.request('GET', `/dialogs/${encodeURIComponent(dialogId)}/info`);
      return {
        type: info.type || 'user',
        title: info.name || info.title || 'Unknown',
        description: info.about || info.description,
        memberCount: info.memberCount,
        photo: info.photo,
        username: info.username,
        isVerified: info.isVerified,
        isForum: info.isForum,
      };
    } catch {
      return { type: 'user', title: 'Unknown' };
    }
  }

  async getChatMembersForInfo(dialogId: string, limit = 50): Promise<ChatMember[]> {
    try {
      return await this.request('GET', `/dialogs/${encodeURIComponent(dialogId)}/members?limit=${limit}`);
    } catch {
      return [];
    }
  }

  async getSharedMedia(dialogId: string, mediaType: 'photo' | 'video' | 'file' | 'link', limit = 20): Promise<SharedMediaItem[]> {
    try {
      return await this.request('GET', `/dialogs/${encodeURIComponent(dialogId)}/media?type=${mediaType}&limit=${limit}`);
    } catch {
      return [];
    }
  }

  async fetchMissedMessages(dialogId: string): Promise<MessageInfo[]> {
    // Fetch recent messages and filter for ones newer than last known
    const lastId = this.lastKnownMessageIds.get(dialogId);
    if (!lastId) return [];
    try {
      const msgs = await this.fetchMessagesFresh(dialogId, 50);
      return msgs.filter(m => m.id > lastId);
    } catch {
      return [];
    }
  }

  // --- Local state (pinned, recent) ---

  private ensureConfigDir() {
    if (!fs.existsSync(this.configDir)) fs.mkdirSync(this.configDir, { recursive: true });
  }

  getPinnedIds(): string[] {
    try {
      const p = path.join(this.configDir, 'pinned.json');
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch {}
    return [];
  }

  private savePinnedIds(ids: string[]) {
    this.ensureConfigDir();
    fs.writeFileSync(path.join(this.configDir, 'pinned.json'), JSON.stringify(ids, null, 2));
  }

  pinDialog(dialogId: string): void {
    const ids = this.getPinnedIds();
    if (!ids.includes(dialogId)) { ids.push(dialogId); this.savePinnedIds(ids); }
  }

  unpinDialog(dialogId: string): void {
    this.savePinnedIds(this.getPinnedIds().filter(id => id !== dialogId));
  }

  getRecentChats(): { id: string; timestamp: number }[] {
    try {
      const p = path.join(this.configDir, 'recent.json');
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8')) || [];
    } catch {}
    return [];
  }

  trackRecentChat(chatId: string): void {
    this.ensureConfigDir();
    let recent = this.getRecentChats().filter(r => r.id !== chatId);
    recent.unshift({ id: chatId, timestamp: Date.now() });
    recent = recent.slice(0, 10);
    fs.writeFileSync(path.join(this.configDir, 'recent.json'), JSON.stringify(recent));
  }

  trackMessageId(dialogId: string, messageId: number): void {
    const current = this.lastKnownMessageIds.get(dialogId) || 0;
    if (messageId > current) this.lastKnownMessageIds.set(dialogId, messageId);
  }

  appendMessageToCache(dialogId: string, message: MessageInfo): void {
    this.trackMessageId(dialogId, message.id);
    const entry = this.messageCache.get(dialogId);
    if (entry) {
      if (!entry.messages.some(m => m.id === message.id)) {
        entry.messages.push(message);
        if (entry.messages.length > 50) entry.messages.shift();
        entry.timestamp = Date.now();
      }
    } else {
      this.messageCache.set(dialogId, { messages: [message], timestamp: Date.now() });
    }
  }

  // --- Mapping helpers ---

  private mapDialog(d: any, pinnedIds: string[]): DialogInfo {
    const name = d.name || 'Unknown';
    return {
      id: d.id,
      chatId: d.chatId,
      topicId: d.topicId,
      name,
      lastMessage: d.lastMessage || '',
      lastMessageTime: d.lastMessageTime || 0,
      unreadCount: d.unreadCount || 0,
      initials: name.split(' ').map((w: string) => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase(),
      isPinned: pinnedIds.includes(d.id),
      isForum: d.isForum || false,
      topicEmoji: d.topicEmoji,
      groupName: d.groupName,
      topicName: d.topicName,
    };
  }

  private mapMessage(m: any): MessageInfo {
    return {
      id: m.id,
      senderId: m.senderId || '',
      senderName: m.senderName || '',
      text: m.text || '',
      timestamp: m.timestamp || 0,
      isOutgoing: m.isOutgoing || false,
      mediaType: m.mediaType,
      mediaUrl: m.mediaUrl,
      thumbnailUrl: m.thumbnailUrl,
      fileName: m.fileName,
      fileSize: m.fileSize,
      fileMimeType: m.fileMimeType,
      duration: m.duration,
      isVideoNote: m.isVideoNote,
      waveform: m.waveform,
      replyToId: m.replyToId,
      replyToText: m.replyToText,
      replyToSender: m.replyToSender,
      forwardFrom: m.forwardFrom,
      isEdited: m.isEdited,
      entities: m.entities,
      linkPreview: m.linkPreview,
      reactions: m.reactions?.map((r: any) => ({ emoji: r.emoji, count: r.count, isSelected: r.isSelected || false })),
      status: m.status,
    };
  }

  // --- Disk cache ---

  private loadDialogCacheFromDisk(): void {
    try {
      const p = path.join(this.configDir, 'dialogs-cache.json');
      if (fs.existsSync(p)) {
        const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
        if (data?.dialogs) {
          this.dialogCache = data.dialogs;
          this.dialogCacheTime = data.timestamp || 0;
        }
      }
    } catch {}
  }

  private saveDialogCacheToDisk(dialogs: DialogInfo[]): void {
    this.ensureConfigDir();
    fs.writeFileSync(
      path.join(this.configDir, 'dialogs-cache.json'),
      JSON.stringify({ timestamp: Date.now(), dialogs })
    );
  }

  private loadMessageCacheFromDisk(): void {
    try {
      const p = path.join(this.configDir, 'messages.jsonl');
      if (!fs.existsSync(p)) return;
      const content = fs.readFileSync(p, 'utf-8');
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.chatId && Array.isArray(entry.messages)) {
            this.messageCache.set(entry.chatId, { messages: entry.messages, timestamp: entry.timestamp || 0 });
          }
        } catch {}
      }
    } catch {}
  }

  private updateMessageCache(dialogId: string, messages: MessageInfo[]): void {
    const existing = this.messageCache.get(dialogId);
    let merged = messages;
    if (existing) {
      const freshIds = new Set(messages.map(m => m.id));
      const kept = existing.messages.filter(m => !freshIds.has(m.id));
      merged = [...kept, ...messages].sort((a, b) => a.timestamp - b.timestamp || a.id - b.id).slice(-50);
    }
    this.messageCache.set(dialogId, { messages: merged, timestamp: Date.now() });
  }

  // --- Static helpers (match TelegramService interface) ---

  static parseDialogId(id: string): { chatId: string; topicId?: number } {
    const parts = id.split(':');
    if (parts.length === 2) return { chatId: parts[0], topicId: parseInt(parts[1], 10) };
    return { chatId: id };
  }

  static makeDialogId(chatId: string, topicId?: number): string {
    return topicId ? `${chatId}:${topicId}` : chatId;
  }

  // --- Login flow (daemon handles it via HTTP) ---

  async isAuthenticated(): Promise<boolean> {
    const health = await this.request('GET', '/health');
    return health.connected === true;
  }

  async startLogin(phone: string): Promise<{ phoneCodeHash: string }> {
    return await this.request('POST', '/login/phone', { phone });
  }

  async completeLogin(phone: string, code: string, phoneCodeHash: string): Promise<void> {
    const result = await this.request('POST', '/login/code', { phone, code, phoneCodeHash });
    if (result.need2FA) throw new Error('2FA_REQUIRED');
  }

  async complete2FA(password: string): Promise<void> {
    await this.request('POST', '/login/2fa', { password });
  }
}
