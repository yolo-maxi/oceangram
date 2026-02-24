import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { NewMessage, NewMessageEvent } from 'telegram/events';
import { EditedMessage, EditedMessageEvent } from 'telegram/events/EditedMessage';
import { DeletedMessage, DeletedMessageEvent } from 'telegram/events/DeletedMessage';
import { CustomFile } from 'telegram/client/uploads';
import { computeCheck } from 'telegram/Password';
import bigInt from 'big-integer';
import { getApiId, getApiHash, loadConfig, saveConfig } from './config';
import type { Cache as CacheType } from './cache';

// Dynamic import — better-sqlite3 may not be available (e.g. bundled without native addon)
let CacheClass: (new () => CacheType) | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  CacheClass = require('./cache').Cache;
} catch {
  console.log('[telegram] SQLite cache not available — running without disk cache');
}

/** No-op cache fallback when better-sqlite3 is unavailable. */
const noopCache: CacheType = {
  getDialogs: () => [],
  upsertDialogs: () => {},
  getMessages: () => [],
  upsertMessages: () => {},
  deleteMessage: () => {},
  getProfilePhoto: () => null,
  setProfilePhoto: () => {},
  close: () => {},
} as unknown as CacheType;

// --- Privacy key mapping ---
type PrivacyKeyName = 'lastSeen' | 'phoneNumber' | 'profilePhoto' | 'forwards' | 'calls' | 'groups';
type PrivacyValue = 'everybody' | 'contacts' | 'nobody';

const PRIVACY_KEYS: Record<PrivacyKeyName, new () => Api.TypeInputPrivacyKey> = {
  lastSeen: Api.InputPrivacyKeyStatusTimestamp,
  phoneNumber: Api.InputPrivacyKeyPhoneNumber,
  profilePhoto: Api.InputPrivacyKeyProfilePhoto,
  forwards: Api.InputPrivacyKeyForwards,
  calls: Api.InputPrivacyKeyPhoneCall,
  groups: Api.InputPrivacyKeyChatInvite,
};

function privacyRulesToValue(rules: Api.TypePrivacyRule[]): PrivacyValue {
  for (const rule of rules) {
    if (rule instanceof Api.PrivacyValueAllowAll) return 'everybody';
    if (rule instanceof Api.PrivacyValueAllowContacts) return 'contacts';
    if (rule instanceof Api.PrivacyValueDisallowAll) return 'nobody';
  }
  return 'nobody';
}

function privacyValueToRules(value: PrivacyValue): Api.TypeInputPrivacyRule[] {
  switch (value) {
    case 'everybody':
      return [new Api.InputPrivacyValueAllowAll()];
    case 'contacts':
      return [new Api.InputPrivacyValueAllowContacts(), new Api.InputPrivacyValueDisallowAll()];
    case 'nobody':
      return [new Api.InputPrivacyValueDisallowAll()];
  }
}

// --- Notification scope mapping ---
type NotificationScope = 'private' | 'group' | 'channel';

function notifyScopeToInputPeer(scope: NotificationScope): Api.TypeInputNotifyPeer {
  switch (scope) {
    case 'private': return new Api.InputNotifyUsers();
    case 'group': return new Api.InputNotifyChats();
    case 'channel': return new Api.InputNotifyBroadcasts();
  }
}

export interface DialogInfo {
  id: string;
  chatId: string;
  topicId?: number;
  name: string;
  lastMessage: string;
  lastMessageTime: number;
  lastMessageOutgoing?: boolean;
  unreadCount: number;
  isForum: boolean;
  groupName?: string;
  topicName?: string;
  hasPhoto?: boolean;
  type?: 'user' | 'group' | 'supergroup' | 'channel';
}

export interface MessageInfo {
  id: number;
  senderId: string;
  senderName: string;
  text: string;
  timestamp: number;
  isOutgoing: boolean;
  mediaType?: 'photo' | 'video' | 'voice' | 'file' | 'sticker' | 'gif';
  mediaWidth?: number;
  mediaHeight?: number;
  mediaDuration?: number;
  mediaMimeType?: string;
  fileName?: string;
  fileSize?: number;
  replyToId?: number;
  forwardFrom?: string;
  isEdited?: boolean;
  reactions?: { emoji: string; count: number }[];
}

export type TelegramEvent =
  | { type: 'newMessage'; dialogId: string; message: MessageInfo }
  | { type: 'editedMessage'; dialogId: string; message: MessageInfo }
  | { type: 'deletedMessage'; dialogId: string; messageIds: number[] }
  | { type: 'typing'; dialogId: string; userId: string; action: string }
  | { type: 'userStatus'; userId: string; online: boolean; lastSeen?: number }
  | { type: 'readHistory'; dialogId: string; maxId: number; direction: 'incoming' | 'outgoing' };

export type EventListener = (event: TelegramEvent) => void;

export class TelegramService {
  private client: TelegramClient | null = null;
  private connected = false;
  private eventListeners: Set<EventListener> = new Set();
  private forumTopicsCache: Map<string, Api.ForumTopic[]> = new Map();
  private forumTopicsCacheTs: Map<string, number> = new Map();
  private messagesCache: Map<string, { ts: number; data: MessageInfo[] }> = new Map();
  private dialogsCache: { ts: number; data: DialogInfo[] } | null = null;
  private profilePhotoCache: Map<string, { ts: number; data: { buffer: Buffer; mimeType: string } | null }> = new Map();
  private cache: CacheType;

  constructor() {
    if (CacheClass) {
      try {
        this.cache = new CacheClass();
      } catch (e) {
        console.error('[telegram] Failed to init SQLite cache:', e);
        this.cache = noopCache;
      }
    } else {
      this.cache = noopCache;
    }
  }

  isConnected(): boolean { return this.connected; }
  getClient(): TelegramClient | null { return this.client; }

  onEvent(listener: EventListener): () => void {
    this.eventListeners.add(listener);
    return () => { this.eventListeners.delete(listener); };
  }

  private emit(event: TelegramEvent): void {
    for (const listener of this.eventListeners) {
      try { listener(event); } catch (e) { console.error('Event listener error:', e); }
    }
  }

  async connect(sessionString?: string): Promise<void> {
    if (this.connected) return;

    const apiId = getApiId();
    const apiHash = getApiHash();
    const session = new StringSession(sessionString || loadConfig().session || '');

    this.client = new TelegramClient(session, apiId, apiHash, {
      connectionRetries: 5,
      timeout: 30,
    });

    console.log('[telegram] Connecting to Telegram...');
    await this.client.connect();
    console.log('[telegram] Connected. Checking auth...');

    if (!await this.client.isUserAuthorized()) {
      throw new Error('NOT_AUTHORIZED');
    }

    console.log('[telegram] Authorized. Ready.');
    this.connected = true;
    this.setupEventHandlers();
  }

  async startLogin(phone: string): Promise<{ phoneCodeHash: string }> {
    const apiId = getApiId();
    const apiHash = getApiHash();

    this.client = new TelegramClient(new StringSession(''), apiId, apiHash, {
      connectionRetries: 5,
    });
    await this.client.connect();

    const result = await this.client.invoke(
      new Api.auth.SendCode({
        phoneNumber: phone,
        apiId,
        apiHash,
        settings: new Api.CodeSettings({}),
      })
    );

    return { phoneCodeHash: (result as any).phoneCodeHash };
  }

  async completeLogin(phone: string, code: string, phoneCodeHash: string): Promise<string> {
    if (!this.client) throw new Error('Call startLogin first');

    try {
      await this.client.invoke(
        new Api.auth.SignIn({
          phoneNumber: phone,
          phoneCodeHash,
          phoneCode: code,
        })
      );
    } catch (err: unknown) {
      if ((err as any)?.errorMessage === 'SESSION_PASSWORD_NEEDED') {
        throw new Error('2FA_REQUIRED');
      }
      throw err;
    }

    const sessionStr = this.client.session.save() as unknown as string;
    const config = loadConfig();
    config.session = sessionStr;
    saveConfig(config);

    this.connected = true;
    this.setupEventHandlers();
    return sessionStr;
  }

  async get2FAHint(): Promise<string | undefined> {
    if (!this.client) return undefined;
    const passwordInfo = await this.client.invoke(new Api.account.GetPassword());
    return passwordInfo.hint || undefined;
  }

  async complete2FA(password: string): Promise<string> {
    if (!this.client) throw new Error('Call startLogin first');

    const passwordInfo = await this.client.invoke(new Api.account.GetPassword());
    const passwordCheck = await computeCheck(passwordInfo, password);
    await this.client.invoke(new Api.auth.CheckPassword({ password: passwordCheck }));

    const sessionStr = this.client.session.save() as unknown as string;
    const config = loadConfig();
    config.session = sessionStr;
    saveConfig(config);

    this.connected = true;
    this.setupEventHandlers();
    return sessionStr;
  }

  private setupEventHandlers(): void {
    if (!this.client) return;
    console.log('[telegram] Setting up event handlers...');

    this.client.addEventHandler((event: NewMessageEvent) => {
      console.log('[telegram] NewMessage event received, chatId:', event.message?.chatId?.toString());
      const msg = event.message;
      if (!msg) return;
      const chatId = msg.chatId?.toString() || (msg as any).peerId?.toString() || '';
      const replyTo = msg.replyTo as any;
      const topicId = replyTo?.forumTopic
        ? (replyTo.replyToTopId || replyTo.replyToMsgId)
        : undefined;
      const dialogId = topicId ? `${chatId}:${topicId}` : chatId;

      const messageInfo = this.rawMessageToInfo(msg);
      // Upsert into SQLite cache (L2)
      try { this.cache.upsertMessages(dialogId, [messageInfo]); } catch (e) { console.error('[cache] upsert error:', e); }

      this.emit({
        type: 'newMessage',
        dialogId,
        message: messageInfo,
      });
    }, new NewMessage({}));

    this.client.addEventHandler((event: EditedMessageEvent) => {
      const msg = event.message;
      if (!msg) return;
      const chatId = msg.chatId?.toString() || (msg as any).peerId?.toString() || '';

      const messageInfo = this.rawMessageToInfo(msg);
      // Update in SQLite cache (L2)
      try { this.cache.upsertMessages(chatId, [messageInfo]); } catch (e) { console.error('[cache] edit upsert error:', e); }

      this.emit({
        type: 'editedMessage',
        dialogId: chatId,
        message: messageInfo,
      });
    }, new EditedMessage({}));

    this.client.addEventHandler((event: DeletedMessageEvent) => {
      const ids = event.deletedIds || [];
      const chatId = (event as any).chatId?.toString() || '';

      // Delete from SQLite cache (L2)
      for (const id of ids) {
        try { this.cache.deleteMessage(chatId, id); } catch (e) { console.error('[cache] delete error:', e); }
      }

      this.emit({
        type: 'deletedMessage',
        dialogId: chatId,
        messageIds: ids,
      });
    }, new DeletedMessage({}));

    // Raw update handler for typing + read receipts
    this.client.addEventHandler((update: Api.TypeUpdate) => {
      // Typing events
      if (update instanceof Api.UpdateUserTyping) {
        const actionName = (update.action as any)?.className || 'typing';
        this.emit({
          type: 'typing',
          dialogId: update.userId.toString(),
          userId: update.userId.toString(),
          action: actionName,
        });
      } else if (update instanceof Api.UpdateChatUserTyping) {
        const actionName = (update.action as any)?.className || 'typing';
        const fromId = update.fromId;
        let userId = '';
        if (fromId instanceof Api.PeerUser) userId = fromId.userId.toString();
        else if (fromId instanceof Api.PeerChannel) userId = fromId.channelId.toString();
        else if (fromId instanceof Api.PeerChat) userId = fromId.chatId.toString();
        this.emit({
          type: 'typing',
          dialogId: `-${update.chatId.toString()}`,
          userId,
          action: actionName,
        });
      } else if (update instanceof Api.UpdateChannelUserTyping) {
        const actionName = (update.action as any)?.className || 'typing';
        const fromId = update.fromId;
        let userId = '';
        if (fromId instanceof Api.PeerUser) userId = fromId.userId.toString();
        else if (fromId instanceof Api.PeerChannel) userId = fromId.channelId.toString();
        else if (fromId instanceof Api.PeerChat) userId = fromId.chatId.toString();
        // Use negative channel ID + topic for forum groups
        const channelDialogId = `-100${update.channelId.toString()}`;
        const topicId = (update as any).topMsgId;
        const typingDialogId = topicId ? `${channelDialogId}:${topicId}` : channelDialogId;
        console.log('[telegram] typing event:', typingDialogId, 'from:', userId, 'action:', actionName);
        this.emit({
          type: 'typing',
          dialogId: typingDialogId,
          userId,
          action: actionName,
        });
      }

      // Read receipt events
      if (update instanceof Api.UpdateReadHistoryInbox) {
        const peer = update.peer;
        let dialogId = '';
        if (peer instanceof Api.PeerUser) dialogId = peer.userId.toString();
        else if (peer instanceof Api.PeerChat) dialogId = peer.chatId.toString();
        else if (peer instanceof Api.PeerChannel) dialogId = peer.channelId.toString();
        this.emit({
          type: 'readHistory',
          dialogId,
          maxId: update.maxId,
          direction: 'incoming',
        });
      } else if (update instanceof Api.UpdateReadHistoryOutbox) {
        const peer = update.peer;
        let dialogId = '';
        if (peer instanceof Api.PeerUser) dialogId = peer.userId.toString();
        else if (peer instanceof Api.PeerChat) dialogId = peer.chatId.toString();
        else if (peer instanceof Api.PeerChannel) dialogId = peer.channelId.toString();
        this.emit({
          type: 'readHistory',
          dialogId,
          maxId: update.maxId,
          direction: 'outgoing',
        });
      } else if (update instanceof Api.UpdateReadChannelInbox) {
        this.emit({
          type: 'readHistory',
          dialogId: update.channelId.toString(),
          maxId: update.maxId,
          direction: 'incoming',
        });
      } else if (update instanceof Api.UpdateReadChannelOutbox) {
        this.emit({
          type: 'readHistory',
          dialogId: update.channelId.toString(),
          maxId: update.maxId,
          direction: 'outgoing',
        });
      }
    });
  }

  private rawMessageToInfo(msg: Api.Message): MessageInfo {
    const info: MessageInfo = {
      id: msg.id,
      senderId: msg.senderId?.toString() || '',
      senderName: '',
      text: msg.message || '',
      timestamp: msg.date || 0,
      isOutgoing: msg.out || false,
    };

    if (msg.editDate) info.isEdited = true;

    if (msg.media) {
      const media = msg.media as any;
      const className = media.className || '';
      if (className === 'MessageMediaPhoto') {
        info.mediaType = 'photo';
        // Extract photo dimensions from largest size
        const photo = media.photo;
        if (photo?.sizes) {
          const sizes = photo.sizes as any[];
          const largest = sizes[sizes.length - 1];
          if (largest) {
            if (largest.w) info.mediaWidth = largest.w;
            if (largest.h) info.mediaHeight = largest.h;
          }
        }
      } else if (className === 'MessageMediaDocument') {
        const doc = media.document;
        if (doc) {
          const attrs = doc.attributes || [];
          const videoAttr = attrs.find((a: any) => a.className === 'DocumentAttributeVideo');
          const audioAttr = attrs.find((a: any) => a.className === 'DocumentAttributeAudio');
          if (videoAttr) {
            info.mediaType = 'video';
            if (videoAttr.w) info.mediaWidth = videoAttr.w;
            if (videoAttr.h) info.mediaHeight = videoAttr.h;
            if (videoAttr.duration) info.mediaDuration = videoAttr.duration;
          } else if (audioAttr) {
            info.mediaType = 'voice';
            if (audioAttr.duration) info.mediaDuration = audioAttr.duration;
          } else if (attrs.some((a: any) => a.className === 'DocumentAttributeSticker')) info.mediaType = 'sticker';
          else info.mediaType = 'file';
          if (doc.mimeType) info.mediaMimeType = doc.mimeType;
          const fnAttr = attrs.find((a: any) => a.className === 'DocumentAttributeFilename');
          if (fnAttr) info.fileName = fnAttr.fileName;
          if (typeof doc.size === 'number') info.fileSize = doc.size;
        }
      }
    }

    if (msg.reactions) {
      const results = (msg.reactions as any).results;
      if (results) {
        info.reactions = results
          .filter((r: any) => r.reaction && r.count)
          .map((r: any) => ({
            emoji: r.reaction?.emoticon || '❓',
            count: r.count || 0,
          }));
      }
    }

    // Set replyToId only for real replies, not forum topic anchors
    const rt = msg.replyTo as any;
    if (rt?.replyToMsgId && !rt.forumTopic) {
      // In forum topics, replyToTopId is the topic ID — only expose replyToMsgId if it's a genuine reply
      if (!rt.replyToTopId || rt.replyToMsgId !== rt.replyToTopId) {
        info.replyToId = rt.replyToMsgId;
      }
    }
    if (msg.fwdFrom?.fromName) info.forwardFrom = msg.fwdFrom.fromName;

    return info;
  }

  // --- API Methods ---

  async getMe(): Promise<Api.User> {
    if (!this.client) throw new Error('Not connected');
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('getMe timeout (15s)')), 15000)
    );
    return await Promise.race([this.client.getMe(), timeout]) as Api.User;
  }

  async getDialogs(limit = 100): Promise<DialogInfo[]> {
    if (!this.client) throw new Error('Not connected');

    // L1: Return in-memory cached if fresh (< 30s)
    if (this.dialogsCache && (Date.now() - this.dialogsCache.ts) < 30_000) {
      return this.dialogsCache.data.slice(0, limit);
    }

    // L2: Check SQLite cache
    const cachedDialogs = this.cache.getDialogs(limit);
    if (cachedDialogs.length >= limit) {
      // Populate L1 and schedule background refresh
      this.dialogsCache = { ts: Date.now(), data: cachedDialogs };
      this.refreshDialogsBackground(limit);
      return cachedDialogs;
    }

    // Cache miss — fetch from Telegram
    const fresh = await this.fetchDialogsFromTelegram(limit);
    return fresh;
  }

  private async fetchDialogsFromTelegram(limit: number): Promise<DialogInfo[]> {
    if (!this.client) throw new Error('Not connected');

    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('getDialogs timeout (30s)')), 30000)
    );
    const dialogs = await Promise.race([this.client.getDialogs({ limit }), timeout]);
    const results: DialogInfo[] = [];

    for (const d of dialogs) {
      const chatId = d.id?.toString() || '0';
      const name = this.getEntityName(d.entity);
      const isForum = (d.entity as any)?.forum === true;

      const entity = d.entity as any;
      const hasPhoto = !!(entity?.photo);
      const type = entity?.className === 'User' ? 'user' as const
        : entity?.className === 'Channel' ? (entity.megagroup ? 'supergroup' as const : 'channel' as const)
        : 'group' as const;

      if (isForum) {
        try {
          const topics = await this.getForumTopics(chatId);
          for (const topic of topics) {
            const topicOutgoing = this.isForumTopicLastMessageOutgoing(chatId, topic.topMessage);
            // Get actual last message time from the message, not topic.date (which is creation date)
            const topMsgMap = this.forumTopicMessages.get(chatId);
            const topMsg = topMsgMap?.get(topic.topMessage);
            const lastMsgTime = topMsg?.date || topic.date || 0;
            results.push({
              id: `${chatId}:${topic.id}`,
              chatId,
              topicId: topic.id,
              name: `${name} / ${topic.title || 'General'}`,
              lastMessage: topMsg?.message || '',
              lastMessageTime: lastMsgTime,
              lastMessageOutgoing: topicOutgoing,
              unreadCount: topic.unreadCount || 0,
              isForum: true,
              groupName: name,
              topicName: topic.title || 'General',
              hasPhoto,
              type,
            });
          }
        } catch {
          results.push({
            id: chatId, chatId, name,
            lastMessage: d.message?.message || '',
            lastMessageTime: d.message?.date || 0,
            lastMessageOutgoing: d.message?.out || false,
            unreadCount: d.unreadCount || 0,
            isForum: true,
            hasPhoto,
            type,
          });
        }
      } else {
        results.push({
          id: chatId, chatId, name,
          lastMessage: d.message?.message || '',
          lastMessageTime: d.message?.date || 0,
          lastMessageOutgoing: d.message?.out || false,
          unreadCount: d.unreadCount || 0,
          isForum: false,
          hasPhoto,
          type,
        });
      }
    }

    // Update both caches
    this.dialogsCache = { ts: Date.now(), data: results };
    try { this.cache.upsertDialogs(results); } catch (e) { console.error('[cache] dialogs upsert error:', e); }
    return results;
  }

  private refreshDialogsBackground(limit: number): void {
    this.fetchDialogsFromTelegram(limit).catch((e) => {
      console.error('[cache] background dialogs refresh error:', e);
    });
  }

  private forumTopicMessages: Map<string, Map<number, Api.Message>> = new Map();

  private async getForumTopics(chatId: string): Promise<Api.ForumTopic[]> {
    if (!this.client) throw new Error('Not connected');
    const cached = this.forumTopicsCache.get(chatId);
    const cachedTs = this.forumTopicsCacheTs.get(chatId) || 0;
    if (cached && (Date.now() - cachedTs) < 30_000) {
      return cached;
    }

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
      (t): t is Api.ForumTopic => t instanceof Api.ForumTopic
    );

    // Index top messages by ID so we can check `out` flag for each topic
    const msgMap = new Map<number, Api.Message>();
    for (const msg of (result.messages || [])) {
      if (msg instanceof Api.Message) {
        msgMap.set(msg.id, msg);
      }
    }
    this.forumTopicMessages.set(chatId, msgMap);

    this.forumTopicsCache.set(chatId, topics);
    this.forumTopicsCacheTs.set(chatId, Date.now());
    return topics;
  }

  /** Check if the last message in a forum topic was sent by us */
  isForumTopicLastMessageOutgoing(chatId: string, topMessage: number): boolean {
    const msgMap = this.forumTopicMessages.get(chatId);
    if (!msgMap) return false;
    const msg = msgMap.get(topMessage);
    return msg?.out ?? false;
  }

  async getMessages(dialogId: string, limit = 20, offsetId?: number): Promise<MessageInfo[]> {
    if (!this.client) throw new Error('Not connected');

    // L1: in-memory cache
    const cacheKey = `${dialogId}|${limit}|${offsetId || 0}`;
    const memCached = this.messagesCache.get(cacheKey);
    if (memCached && (Date.now() - memCached.ts) < 2_000) {
      return memCached.data;
    }

    // L2: SQLite cache
    const dbCached = this.cache.getMessages(dialogId, limit, offsetId);
    if (dbCached.length >= limit) {
      // Populate L1 and schedule background refresh
      this.messagesCache.set(cacheKey, { ts: Date.now(), data: dbCached });
      this.refreshMessagesBackground(dialogId, limit, offsetId);
      return dbCached;
    }

    // Cache miss — fetch from Telegram, cache, return
    const fresh = await this.fetchMessagesFromTelegram(dialogId, limit, offsetId);
    this.messagesCache.set(cacheKey, { ts: Date.now(), data: fresh });
    return fresh;
  }

  private async fetchMessagesFromTelegram(dialogId: string, limit: number, offsetId?: number): Promise<MessageInfo[]> {
    if (!this.client) throw new Error('Not connected');

    const { chatId, topicId } = this.parseDialogId(dialogId);
    const entity = await this.client.getEntity(chatId);

    const opts: any = { limit };
    if (topicId) opts.replyTo = topicId;
    if (offsetId) opts.offsetId = offsetId;

    const msgs = await this.client.getMessages(entity, opts);
    const results: MessageInfo[] = [];

    // Resolve sender entities once per unique sender (much faster than per-message lookups)
    const senderIds = Array.from(new Set(msgs.map((m: any) => m.senderId?.toString()).filter(Boolean))) as string[];
    const senderNames = new Map<string, string>();
    await Promise.all(senderIds.map(async (sid) => {
      try {
        const sender = await this.client!.getEntity(sid);
        senderNames.set(sid, this.getEntityName(sender));
      } catch { /* ignore */ }
    }));

    for (const msg of msgs) {
      const info = this.rawMessageToInfo(msg);
      const sid = msg.senderId?.toString();
      if (sid && senderNames.has(sid)) {
        info.senderName = senderNames.get(sid)!;
      }
      results.push(info);
    }

    const out = results.reverse();

    // Persist to SQLite (L2)
    try { this.cache.upsertMessages(dialogId, out); } catch (e) { console.error('[cache] messages upsert error:', e); }

    return out;
  }

  private refreshMessagesBackground(dialogId: string, limit: number, offsetId?: number): void {
    this.fetchMessagesFromTelegram(dialogId, limit, offsetId)
      .then((fresh) => {
        // Update L1 with fresh data
        const cacheKey = `${dialogId}|${limit}|${offsetId || 0}`;
        this.messagesCache.set(cacheKey, { ts: Date.now(), data: fresh });
      })
      .catch((e) => {
        console.error('[cache] background messages refresh error:', e);
      });
  }

  async sendMessage(dialogId: string, text: string, replyTo?: number): Promise<MessageInfo> {
    if (!this.client) throw new Error('Not connected');
    const { chatId, topicId } = this.parseDialogId(dialogId);
    const entity = await this.client.getEntity(chatId);

    const opts: any = { message: text };
    if (topicId) opts.replyTo = topicId;
    if (replyTo) opts.replyTo = replyTo;

    const msg = await this.client.sendMessage(entity, opts);
    this.messagesCache.clear();
    const messageInfo = this.rawMessageToInfo(msg);

    // Upsert sent message into SQLite cache (L2)
    try { this.cache.upsertMessages(dialogId, [messageInfo]); } catch (e) { console.error('[cache] send upsert error:', e); }

    return messageInfo;
  }

  async editMessage(dialogId: string, messageId: number, text: string): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    const { chatId } = this.parseDialogId(dialogId);
    const entity = await this.client.getEntity(chatId);
    await this.client.editMessage(entity, { message: messageId, text });
    this.messagesCache.clear();
  }

  async deleteMessage(dialogId: string, messageId: number): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    const { chatId } = this.parseDialogId(dialogId);
    const entity = await this.client.getEntity(chatId);
    await this.client.deleteMessages(entity, [messageId], { revoke: true });
    this.messagesCache.clear();
  }

  async markAsRead(dialogId: string, messageId: number): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    const { chatId } = this.parseDialogId(dialogId);
    const entity = await this.client.getEntity(chatId);
    await this.client.markAsRead(entity, messageId);
  }

  async sendReaction(dialogId: string, messageId: number, emoji: string): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    const { chatId } = this.parseDialogId(dialogId);
    const entity = await this.client.getEntity(chatId);
    await this.client.invoke(
      new Api.messages.SendReaction({
        peer: entity,
        msgId: messageId,
        reaction: [new Api.ReactionEmoji({ emoticon: emoji })],
      })
    );
  }

  async searchMessages(dialogId: string, query: string, limit = 20): Promise<MessageInfo[]> {
    if (!this.client) throw new Error('Not connected');
    const { chatId, topicId } = this.parseDialogId(dialogId);
    const entity = await this.client.getEntity(chatId);

    const opts: any = { limit, search: query };
    if (topicId) opts.replyTo = topicId;

    const msgs = await this.client.getMessages(entity, opts);
    const results: MessageInfo[] = [];

    const senderIds = Array.from(new Set(msgs.map((m: any) => m.senderId?.toString()).filter(Boolean))) as string[];
    const senderNames = new Map<string, string>();
    await Promise.all(senderIds.map(async (sid) => {
      try {
        const sender = await this.client!.getEntity(sid);
        senderNames.set(sid, this.getEntityName(sender));
      } catch { /* ignore */ }
    }));

    for (const msg of msgs) {
      const info = this.rawMessageToInfo(msg);
      const sid = msg.senderId?.toString();
      if (sid && senderNames.has(sid)) {
        info.senderName = senderNames.get(sid)!;
      }
      results.push(info);
    }
    return results;
  }

  async downloadMedia(messageId: number, dialogId: string): Promise<{ buffer: Buffer; mimeType: string } | null> {
    if (!this.client) throw new Error('Not connected');
    const { chatId } = this.parseDialogId(dialogId);
    const entity = await this.client.getEntity(chatId);
    const msgs = await this.client.getMessages(entity, { ids: [messageId] });
    const msg = msgs?.[0];
    if (!msg?.media) return null;

    const buffer = await this.client.downloadMedia(msg, {});
    if (!buffer || !Buffer.isBuffer(buffer)) return null;

    // Determine MIME type
    const media = msg.media as any;
    let mimeType = 'application/octet-stream';
    if (media?.document?.mimeType) {
      mimeType = media.document.mimeType;
    } else if (media?.className === 'MessageMediaPhoto') {
      mimeType = 'image/jpeg'; // Telegram photos are always JPEG
    }
    return { buffer, mimeType };
  }

  async sendFile(dialogId: string, buffer: Buffer, fileName: string, mimeType?: string, caption?: string): Promise<MessageInfo> {
    if (!this.client) throw new Error('Not connected');
    const { chatId, topicId } = this.parseDialogId(dialogId);
    const entity = await this.client.getEntity(chatId);

    const file = new CustomFile(fileName, buffer.length, '', buffer);
    const msg = await this.client.sendFile(entity, {
      file,
      caption: caption || '',
      forceDocument: !(mimeType && mimeType.startsWith('image/')),
      replyTo: topicId,
    });
    this.messagesCache.clear();
    return this.rawMessageToInfo(msg);
  }

  async sendVoice(dialogId: string, buffer: Buffer, duration: number, waveform?: number[]): Promise<MessageInfo> {
    if (!this.client) throw new Error('Not connected');
    const { chatId, topicId } = this.parseDialogId(dialogId);
    const entity = await this.client.getEntity(chatId);

    // Pack waveform into 5-bit format (Telegram's format)
    let waveformBuffer: Buffer | undefined;
    if (waveform && waveform.length > 0) {
      const byteLen = Math.ceil(waveform.length * 5 / 8);
      waveformBuffer = Buffer.alloc(byteLen);
      for (let i = 0; i < waveform.length; i++) {
        const val = Math.min(31, Math.max(0, Math.round(waveform[i])));
        const byteIdx = Math.floor(i * 5 / 8);
        const bitIdx = (i * 5) % 8;
        waveformBuffer[byteIdx] |= (val << bitIdx) & 0xff;
        if (bitIdx > 3 && byteIdx + 1 < byteLen) {
          waveformBuffer[byteIdx + 1] |= (val >> (8 - bitIdx)) & 0xff;
        }
      }
    }

    const msg = await this.client.sendFile(entity, {
      file: buffer,
      voiceNote: true,
      attributes: [
        new Api.DocumentAttributeAudio({
          voice: true,
          duration: Math.round(duration),
          waveform: waveformBuffer,
        }),
      ],
      replyTo: topicId,
    });
    this.messagesCache.clear();
    return this.rawMessageToInfo(msg);
  }

  async sendTyping(dialogId: string): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    const { chatId, topicId } = this.parseDialogId(dialogId);
    const entity = await this.client.getEntity(chatId);
    await this.client.invoke(
      new Api.messages.SetTyping({
        peer: entity,
        topMsgId: topicId,
        action: new Api.SendMessageTypingAction(),
      })
    );
  }

  async getDialogInfo(dialogId: string): Promise<Record<string, unknown>> {
    if (!this.client) throw new Error('Not connected');
    const { chatId } = this.parseDialogId(dialogId);
    const entity = await this.client.getEntity(chatId);
    let about: string | undefined;
    try {
      const full = await this.client.invoke(
        new Api.messages.GetFullChat({ chatId: bigInt(chatId) })
      );
      about = (full as any)?.fullChat?.about;
    } catch { /* ignore */ }

    return {
      id: chatId,
      name: this.getEntityName(entity),
      about,
    };
  }

  async getUserProfile(userId: string): Promise<Record<string, unknown>> {
    if (!this.client) throw new Error('Not connected');
    const entity = await this.client.getEntity(userId) as any;
    return {
      id: userId,
      name: this.getEntityName(entity),
      username: entity.username,
      phone: entity.phone,
    };
  }

  async getProfilePhoto(userId: string): Promise<{ buffer: Buffer; mimeType: string } | null> {
    if (!this.client) throw new Error('Not connected');

    // L1: Check in-memory cache (1 hour TTL)
    const memCached = this.profilePhotoCache.get(userId);
    if (memCached && (Date.now() - memCached.ts) < 3_600_000) {
      return memCached.data;
    }

    // L2: Check SQLite cache
    const dbCached = this.cache.getProfilePhoto(userId);
    if (dbCached) {
      const result = { buffer: dbCached.data, mimeType: dbCached.mimeType };
      this.profilePhotoCache.set(userId, { ts: Date.now(), data: result });
      return result;
    }

    // Cache miss — download from Telegram
    try {
      const entity = await this.client.getEntity(userId);
      const buffer = await this.client.downloadProfilePhoto(entity);
      if (!buffer || !Buffer.isBuffer(buffer)) {
        this.profilePhotoCache.set(userId, { ts: Date.now(), data: null });
        return null;
      }
      const result = { buffer, mimeType: 'image/jpeg' };
      // Update both caches
      this.profilePhotoCache.set(userId, { ts: Date.now(), data: result });
      try { this.cache.setProfilePhoto(userId, buffer, 'image/jpeg'); } catch (e) { console.error('[cache] photo set error:', e); }
      return result;
    } catch {
      this.profilePhotoCache.set(userId, { ts: Date.now(), data: null });
      return null;
    }
  }

  // --- Forward Messages ---

  async forwardMessages(fromDialogId: string, toDialogId: string, messageIds: number[]): Promise<MessageInfo[]> {
    if (!this.client) throw new Error('Not connected');
    const { chatId: fromChatId } = this.parseDialogId(fromDialogId);
    const { chatId: toChatId } = this.parseDialogId(toDialogId);
    const fromEntity = await this.client.getEntity(fromChatId);
    const toEntity = await this.client.getEntity(toChatId);

    const result = await this.client.forwardMessages(toEntity, {
      messages: messageIds,
      fromPeer: fromEntity,
    });

    this.messagesCache.clear();
    const msgs = Array.isArray(result) ? result : [result];
    return msgs
      .filter((m): m is Api.Message => m instanceof Api.Message)
      .map((m) => this.rawMessageToInfo(m));
  }

  // --- Pin / Unpin ---

  async pinMessage(dialogId: string, messageId: number, silent?: boolean): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    const { chatId } = this.parseDialogId(dialogId);
    const entity = await this.client.getEntity(chatId);
    await this.client.pinMessage(entity, messageId, { notify: !silent });
  }

  async unpinMessage(dialogId: string, messageId: number): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    const { chatId } = this.parseDialogId(dialogId);
    const entity = await this.client.getEntity(chatId);
    await this.client.invoke(
      new Api.messages.UpdatePinnedMessage({
        peer: entity,
        id: messageId,
        unpin: true,
      })
    );
  }

  // --- Archive / Unarchive ---

  async archiveChat(dialogId: string): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    const { chatId } = this.parseDialogId(dialogId);
    const entity = await this.client.getEntity(chatId);
    await this.client.invoke(
      new Api.folders.EditPeerFolders({
        folderPeers: [
          new Api.InputFolderPeer({
            peer: entity as unknown as Api.TypeInputPeer,
            folderId: 1,
          }),
        ],
      })
    );
  }

  async unarchiveChat(dialogId: string): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    const { chatId } = this.parseDialogId(dialogId);
    const entity = await this.client.getEntity(chatId);
    await this.client.invoke(
      new Api.folders.EditPeerFolders({
        folderPeers: [
          new Api.InputFolderPeer({
            peer: entity as unknown as Api.TypeInputPeer,
            folderId: 0,
          }),
        ],
      })
    );
  }

  // --- Mute ---

  async muteChat(dialogId: string, duration?: number): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    const { chatId } = this.parseDialogId(dialogId);
    const entity = await this.client.getEntity(chatId);

    // duration: undefined = unmute, 0 = forever, >0 = seconds
    let muteUntil: number;
    if (duration === undefined) {
      muteUntil = 0; // unmute
    } else if (duration === 0) {
      muteUntil = 2147483647; // max int32 = forever
    } else {
      muteUntil = Math.floor(Date.now() / 1000) + duration;
    }

    await this.client.invoke(
      new Api.account.UpdateNotifySettings({
        peer: new Api.InputNotifyPeer({ peer: entity as unknown as Api.TypeInputPeer }),
        settings: new Api.InputPeerNotifySettings({
          muteUntil,
        }),
      })
    );
  }

  // --- Scheduled Messages ---

  async sendMessageScheduled(dialogId: string, text: string, scheduleDate: number, replyTo?: number): Promise<MessageInfo> {
    if (!this.client) throw new Error('Not connected');
    const { chatId, topicId } = this.parseDialogId(dialogId);
    const entity = await this.client.getEntity(chatId);

    const opts: any = { message: text, schedule: scheduleDate };
    if (topicId) opts.replyTo = topicId;
    if (replyTo) opts.replyTo = replyTo;

    const msg = await this.client.sendMessage(entity, opts);
    this.messagesCache.clear();
    return this.rawMessageToInfo(msg);
  }

  async getScheduledMessages(dialogId: string): Promise<MessageInfo[]> {
    if (!this.client) throw new Error('Not connected');
    const { chatId } = this.parseDialogId(dialogId);
    const entity = await this.client.getEntity(chatId);

    const result = await this.client.invoke(
      new Api.messages.GetScheduledHistory({
        peer: entity,
        hash: bigInt(0),
      })
    );

    const msgs = (result as any).messages || [];
    return msgs
      .filter((m: any): m is Api.Message => m instanceof Api.Message)
      .map((m: Api.Message) => this.rawMessageToInfo(m));
  }

  // --- Drafts ---

  async getDraft(dialogId: string): Promise<{ text: string; replyTo?: number; date?: number } | null> {
    if (!this.client) throw new Error('Not connected');
    const { chatId } = this.parseDialogId(dialogId);
    const entity = await this.client.getEntity(chatId);

    const result = await this.client.invoke(
      new Api.messages.GetPeerDialogs({
        peers: [new Api.InputDialogPeer({ peer: entity as unknown as Api.TypeInputPeer })],
      })
    );

    const dialog = (result as any).dialogs?.[0];
    const draft = dialog?.draft;
    if (!draft || draft.className === 'DraftMessageEmpty') return null;

    return {
      text: draft.message || '',
      replyTo: draft.replyTo?.replyToMsgId,
      date: draft.date,
    };
  }

  async saveDraft(dialogId: string, text: string, replyTo?: number): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    const { chatId } = this.parseDialogId(dialogId);
    const entity = await this.client.getEntity(chatId);

    await this.client.invoke(
      new Api.messages.SaveDraft({
        peer: entity,
        message: text,
        replyTo: replyTo
          ? new Api.InputReplyToMessage({ replyToMsgId: replyTo })
          : undefined,
      })
    );
  }

  async clearDraft(dialogId: string): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    const { chatId } = this.parseDialogId(dialogId);
    const entity = await this.client.getEntity(chatId);

    await this.client.invoke(
      new Api.messages.SaveDraft({
        peer: entity,
        message: '',
      })
    );
  }

  // --- Folders ---

  async getFolders(): Promise<{ id: number; title: string }[]> {
    if (!this.client) throw new Error('Not connected');
    const result = await this.client.invoke(new Api.messages.GetDialogFilters());
    const filters = (result as any).filters || result;
    return (Array.isArray(filters) ? filters : [])
      .filter((f: any) => f.className === 'DialogFilter' || f.className === 'DialogFilterChatlist')
      .map((f: any) => ({
        id: f.id,
        title: f.title,
      }));
  }

  async createFolder(title: string, includePeerIds?: string[], excludePeerIds?: string[]): Promise<{ id: number }> {
    if (!this.client) throw new Error('Not connected');

    // Get existing filters to determine next ID
    const existing = await this.getFolders();
    const nextId = existing.length > 0 ? Math.max(...existing.map((f) => f.id)) + 1 : 2;

    const includePeers: Api.TypeInputPeer[] = [];
    if (includePeerIds) {
      for (const pid of includePeerIds) {
        const e = await this.client.getEntity(pid);
        includePeers.push(e as unknown as Api.TypeInputPeer);
      }
    }

    const excludePeers: Api.TypeInputPeer[] = [];
    if (excludePeerIds) {
      for (const pid of excludePeerIds) {
        const e = await this.client.getEntity(pid);
        excludePeers.push(e as unknown as Api.TypeInputPeer);
      }
    }

    await this.client.invoke(
      new Api.messages.UpdateDialogFilter({
        id: nextId,
        filter: new Api.DialogFilter({
          id: nextId,
          title: title as unknown as Api.TypeTextWithEntities,
          pinnedPeers: [],
          includePeers,
          excludePeers,
        }),
      })
    );

    return { id: nextId };
  }

  async updateFolder(folderId: number, title: string, includePeerIds?: string[], excludePeerIds?: string[]): Promise<void> {
    if (!this.client) throw new Error('Not connected');

    const includePeers: Api.TypeInputPeer[] = [];
    if (includePeerIds) {
      for (const pid of includePeerIds) {
        const e = await this.client.getEntity(pid);
        includePeers.push(e as unknown as Api.TypeInputPeer);
      }
    }

    const excludePeers: Api.TypeInputPeer[] = [];
    if (excludePeerIds) {
      for (const pid of excludePeerIds) {
        const e = await this.client.getEntity(pid);
        excludePeers.push(e as unknown as Api.TypeInputPeer);
      }
    }

    await this.client.invoke(
      new Api.messages.UpdateDialogFilter({
        id: folderId,
        filter: new Api.DialogFilter({
          id: folderId,
          title: title as unknown as Api.TypeTextWithEntities,
          pinnedPeers: [],
          includePeers,
          excludePeers,
        }),
      })
    );
  }

  async deleteFolder(folderId: number): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    await this.client.invoke(
      new Api.messages.UpdateDialogFilter({
        id: folderId,
      })
    );
  }

  // --- Create Groups/Channels ---

  async createGroup(title: string, userIds: string[], type: 'group' | 'supergroup' | 'channel'): Promise<Record<string, unknown>> {
    if (!this.client) throw new Error('Not connected');

    if (type === 'group') {
      const users: Api.TypeInputUser[] = [];
      for (const uid of userIds) {
        const entity = await this.client.getEntity(uid);
        users.push(entity as unknown as Api.TypeInputUser);
      }

      const result = await this.client.invoke(
        new Api.messages.CreateChat({
          title,
          users,
        })
      );
      const updates = result as any;
      const chat = updates.chats?.[0];
      return {
        id: chat?.id?.toString(),
        title: chat?.title || title,
        type: 'group',
      };
    } else {
      // supergroup or channel
      const result = await this.client.invoke(
        new Api.channels.CreateChannel({
          title,
          about: '',
          megagroup: type === 'supergroup',
          broadcast: type === 'channel',
        })
      );
      const updates = result as any;
      const channel = updates.chats?.[0];

      // Invite users if any
      if (userIds.length > 0 && channel) {
        const users: Api.TypeInputUser[] = [];
        for (const uid of userIds) {
          const entity = await this.client.getEntity(uid);
          users.push(entity as unknown as Api.TypeInputUser);
        }
        try {
          await this.client.invoke(
            new Api.channels.InviteToChannel({
              channel: channel as unknown as Api.TypeInputChannel,
              users,
            })
          );
        } catch { /* some users may not be invitable */ }
      }

      return {
        id: channel?.id?.toString(),
        title: channel?.title || title,
        type,
      };
    }
  }

  // --- Bot Inline Queries ---

  async getInlineBotResults(botUsername: string, query: string, dialogId: string): Promise<Record<string, unknown>> {
    if (!this.client) throw new Error('Not connected');
    const { chatId } = this.parseDialogId(dialogId);
    const bot = await this.client.getEntity(botUsername);
    const peer = await this.client.getEntity(chatId);

    const result = await this.client.invoke(
      new Api.messages.GetInlineBotResults({
        bot: bot as unknown as Api.TypeInputUser,
        peer: peer as unknown as Api.TypeInputPeer,
        query,
        offset: '',
      })
    );

    return {
      queryId: (result as any).queryId?.toString(),
      results: ((result as any).results || []).map((r: any) => ({
        id: r.id,
        type: r.type,
        title: r.title || r.sendMessage?.message,
      })),
    };
  }

  async sendInlineBotResult(
    botUsername: string,
    queryId: string,
    resultId: string,
    dialogId: string,
  ): Promise<Record<string, unknown>> {
    if (!this.client) throw new Error('Not connected');
    const { chatId } = this.parseDialogId(dialogId);
    const peer = await this.client.getEntity(chatId);

    const result = await this.client.invoke(
      new Api.messages.SendInlineBotResult({
        peer: peer as unknown as Api.TypeInputPeer,
        queryId: bigInt(queryId),
        id: resultId,
        randomId: bigInt(Math.floor(Math.random() * 1e15)),
      })
    );

    this.messagesCache.clear();
    return { ok: true, updates: (result as any).className };
  }

  // --- Privacy Settings ---

  async getPrivacySettings(): Promise<Record<PrivacyKeyName, PrivacyValue>> {
    if (!this.client) throw new Error('Not connected');
    const result: Record<string, PrivacyValue> = {} as Record<PrivacyKeyName, PrivacyValue>;
    for (const [name, KeyClass] of Object.entries(PRIVACY_KEYS)) {
      const resp = await this.client.invoke(
        new Api.account.GetPrivacy({ key: new KeyClass() })
      );
      result[name] = privacyRulesToValue(resp.rules);
    }
    return result as Record<PrivacyKeyName, PrivacyValue>;
  }

  async setPrivacySetting(key: PrivacyKeyName, value: PrivacyValue): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    const KeyClass = PRIVACY_KEYS[key];
    if (!KeyClass) throw new Error(`Unknown privacy key: ${key}`);
    await this.client.invoke(
      new Api.account.SetPrivacy({
        key: new KeyClass(),
        rules: privacyValueToRules(value),
      })
    );
  }

  // --- Account Settings ---

  async getAccountSettings(): Promise<{ firstName: string; lastName: string; username: string; bio: string; phone: string }> {
    if (!this.client) throw new Error('Not connected');
    const me = await this.client.getMe() as Api.User;
    // Get bio from full user
    const full = await this.client.invoke(
      new Api.users.GetFullUser({ id: new Api.InputUserSelf() })
    );
    const userFull = full.fullUser as Api.UserFull;
    return {
      firstName: me.firstName || '',
      lastName: me.lastName || '',
      username: me.username || '',
      bio: userFull.about || '',
      phone: me.phone || '',
    };
  }

  async updateProfile(params: { firstName?: string; lastName?: string; bio?: string }): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    await this.client.invoke(
      new Api.account.UpdateProfile({
        firstName: params.firstName,
        lastName: params.lastName,
        about: params.bio,
      })
    );
  }

  async updateUsername(username: string): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    await this.client.invoke(
      new Api.account.UpdateUsername({ username })
    );
  }

  async uploadProfilePhoto(data: string): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    const buffer = Buffer.from(data, 'base64');
    const file = new CustomFile('profile.jpg', buffer.length, '', buffer);
    const uploaded = await this.client.uploadFile({
      file: file,
      workers: 1,
    });
    await this.client.invoke(
      new Api.photos.UploadProfilePhoto({ file: uploaded })
    );
  }

  async deleteProfilePhoto(): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    // Get current photos and delete the first one (current)
    const photos = await this.client.invoke(
      new Api.photos.GetUserPhotos({
        userId: new Api.InputUserSelf(),
        offset: 0,
        maxId: bigInt(0),
        limit: 1,
      })
    );
    const photoList = photos.photos;
    if (photoList && photoList.length > 0) {
      const photo = photoList[0];
      if (photo instanceof Api.Photo) {
        await this.client.invoke(
          new Api.photos.DeletePhotos({
            id: [new Api.InputPhoto({
              id: photo.id,
              accessHash: photo.accessHash,
              fileReference: photo.fileReference,
            })],
          })
        );
      }
    }
  }

  // --- Two-Step Verification (2FA) ---

  async get2FAStatus(): Promise<{ enabled: boolean; hasRecoveryEmail: boolean; hint?: string }> {
    if (!this.client) throw new Error('Not connected');
    const password = await this.client.invoke(new Api.account.GetPassword());
    return {
      enabled: password.hasPassword || false,
      hasRecoveryEmail: password.hasRecovery || !!password.emailUnconfirmedPattern,
      hint: password.hint || undefined,
    };
  }

  async set2FA(params: { currentPassword?: string; newPassword: string; hint?: string; email?: string }): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    const passwordInfo = await this.client.invoke(new Api.account.GetPassword());

    let passwordCheck: Api.TypeInputCheckPasswordSRP;
    if (passwordInfo.hasPassword && params.currentPassword) {
      passwordCheck = await computeCheck(passwordInfo, params.currentPassword);
    } else {
      passwordCheck = new Api.InputCheckPasswordEmpty();
    }

    // Compute new password hash using the algo from server
    const newPasswordCheck = await computeCheck(passwordInfo, params.newPassword);
    const newAlgo = passwordInfo.newAlgo;
    const newPasswordHash = (newPasswordCheck as Api.InputCheckPasswordSRP).M1;

    await this.client.invoke(
      new Api.account.UpdatePasswordSettings({
        password: passwordCheck,
        newSettings: new Api.account.PasswordInputSettings({
          newAlgo,
          newPasswordHash,
          hint: params.hint || '',
          email: params.email,
        }),
      })
    );
  }

  async disable2FA(password: string): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    const passwordInfo = await this.client.invoke(new Api.account.GetPassword());
    const passwordCheck = await computeCheck(passwordInfo, password);

    await this.client.invoke(
      new Api.account.UpdatePasswordSettings({
        password: passwordCheck,
        newSettings: new Api.account.PasswordInputSettings({
          newAlgo: new Api.PasswordKdfAlgoUnknown(),
          newPasswordHash: Buffer.alloc(0),
          hint: '',
        }),
      })
    );
  }

  // --- Active Sessions ---

  async getSessions(): Promise<Array<{
    hash: string;
    deviceModel: string;
    platform: string;
    systemVersion: string;
    apiId: number;
    appName: string;
    appVersion: string;
    dateCreated: number;
    dateActive: number;
    ip: string;
    country: string;
    region: string;
    current: boolean;
  }>> {
    if (!this.client) throw new Error('Not connected');
    const result = await this.client.invoke(new Api.account.GetAuthorizations());
    return result.authorizations.map((auth) => ({
      hash: auth.hash.toString(),
      deviceModel: auth.deviceModel,
      platform: auth.platform,
      systemVersion: auth.systemVersion,
      apiId: auth.apiId,
      appName: auth.appName,
      appVersion: auth.appVersion,
      dateCreated: auth.dateCreated,
      dateActive: auth.dateActive,
      ip: auth.ip,
      country: auth.country,
      region: auth.region,
      current: auth.current || false,
    }));
  }

  async terminateSession(hash: string): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    await this.client.invoke(
      new Api.account.ResetAuthorization({ hash: bigInt(hash) })
    );
  }

  async terminateAllOtherSessions(): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    await this.client.invoke(new Api.auth.ResetAuthorizations());
  }

  // --- Blocked Users ---

  async getBlockedUsers(limit = 20, offset = 0): Promise<Array<{ userId: string; date: number }>> {
    if (!this.client) throw new Error('Not connected');
    const result = await this.client.invoke(
      new Api.contacts.GetBlocked({ offset, limit })
    );
    const blocked = result.blocked || [];
    return blocked.map((b: Api.PeerBlocked) => {
      const peerId = b.peerId;
      const userId = peerId instanceof Api.PeerUser ? peerId.userId.toString() : peerId.toString();
      return {
        userId,
        date: b.date || 0,
      };
    });
  }

  async blockUser(userId: string): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    const entity = await this.client.getEntity(userId);
    await this.client.invoke(
      new Api.contacts.Block({ id: entity })
    );
  }

  async unblockUser(userId: string): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    const entity = await this.client.getEntity(userId);
    await this.client.invoke(
      new Api.contacts.Unblock({ id: entity })
    );
  }

  // --- Notification Settings ---

  async getNotificationSettings(): Promise<Record<NotificationScope, { muteUntil: number; sound: string; showPreviews: boolean }>> {
    if (!this.client) throw new Error('Not connected');
    const scopes: NotificationScope[] = ['private', 'group', 'channel'];
    const result: Record<string, { muteUntil: number; sound: string; showPreviews: boolean }> = {} as Record<NotificationScope, { muteUntil: number; sound: string; showPreviews: boolean }>;

    for (const scope of scopes) {
      const peer = notifyScopeToInputPeer(scope);
      const settings = await this.client.invoke(
        new Api.account.GetNotifySettings({ peer })
      ) as Api.PeerNotifySettings;
      result[scope] = {
        muteUntil: settings.muteUntil || 0,
        sound: settings.iosSound instanceof Api.NotificationSoundDefault ? 'default' : 'none',
        showPreviews: settings.showPreviews !== false,
      };
    }
    return result as Record<NotificationScope, { muteUntil: number; sound: string; showPreviews: boolean }>;
  }

  async updateNotificationSettings(scope: NotificationScope, params: { muteUntil?: number; sound?: string; showPreviews?: boolean }): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    const peer = notifyScopeToInputPeer(scope);

    const soundObj = params.sound !== undefined
      ? (params.sound === 'none' ? new Api.NotificationSoundNone() : new Api.NotificationSoundDefault())
      : undefined;

    await this.client.invoke(
      new Api.account.UpdateNotifySettings({
        peer,
        settings: new Api.InputPeerNotifySettings({
          muteUntil: params.muteUntil,
          showPreviews: params.showPreviews,
          sound: soundObj,
        }),
      })
    );
  }

  // --- Auto-Download Settings ---

  async getAutoDownloadSettings(): Promise<{
    low: { disabled: boolean; photoSizeMax: number; videoSizeMax: string; fileSizeMax: string };
    medium: { disabled: boolean; photoSizeMax: number; videoSizeMax: string; fileSizeMax: string };
    high: { disabled: boolean; photoSizeMax: number; videoSizeMax: string; fileSizeMax: string };
  }> {
    if (!this.client) throw new Error('Not connected');
    const result = await this.client.invoke(new Api.account.GetAutoDownloadSettings()) as unknown as {
      low: Api.AutoDownloadSettings;
      medium: Api.AutoDownloadSettings;
      high: Api.AutoDownloadSettings;
    };

    const mapSettings = (s: Api.AutoDownloadSettings) => ({
      disabled: s.disabled || false,
      photoSizeMax: s.photoSizeMax || 0,
      videoSizeMax: (s.videoSizeMax || '0').toString(),
      fileSizeMax: (s.fileSizeMax || '0').toString(),
    });

    return {
      low: mapSettings(result.low),
      medium: mapSettings(result.medium),
      high: mapSettings(result.high),
    };
  }

  async saveAutoDownloadSettings(params: { photos: boolean; videos: boolean; files: boolean; maxFileSize?: number }): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    // If all disabled, set disabled flag
    const allDisabled = !params.photos && !params.videos && !params.files;
    const maxSize = params.maxFileSize || 10 * 1024 * 1024; // default 10MB

    await this.client.invoke(
      new Api.account.SaveAutoDownloadSettings({
        settings: new Api.AutoDownloadSettings({
          disabled: allDisabled,
          photoSizeMax: params.photos ? maxSize : 0,
          videoSizeMax: params.videos ? bigInt(maxSize) : bigInt(0),
          fileSizeMax: params.files ? bigInt(maxSize) : bigInt(0),
          videoUploadMaxbitrate: 50,
          smallQueueActiveOperationsMax: 5,
          largeQueueActiveOperationsMax: 2,
        }),
      })
    );
  }

  // --- Logout ---

  async logout(): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    await this.client.invoke(new Api.auth.LogOut());
    this.connected = false;
  }

  // --- Mark All as Read ---

  async markAllAsRead(dialogId: string): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    const { chatId } = this.parseDialogId(dialogId);
    const entity = await this.client.getEntity(chatId);
    await this.client.markAsRead(entity);
  }

  // --- Read History (mark as read) ---

  async readHistory(dialogId: string, maxId?: number): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    const { chatId } = this.parseDialogId(dialogId);
    const inputEntity = await this.client.getInputEntity(chatId);

    if (inputEntity instanceof Api.InputPeerChannel) {
      await this.client.invoke(
        new Api.channels.ReadHistory({
          channel: new Api.InputChannel({
            channelId: inputEntity.channelId,
            accessHash: inputEntity.accessHash,
          }),
          maxId: maxId || 0,
        })
      );
    } else {
      await this.client.invoke(
        new Api.messages.ReadHistory({
          peer: inputEntity,
          maxId: maxId || 0,
        })
      );
    }
  }

  // --- Get Single Message ---

  async getMessageById(dialogId: string, messageId: number): Promise<MessageInfo | null> {
    if (!this.client) throw new Error('Not connected');
    const { chatId } = this.parseDialogId(dialogId);
    const entity = await this.client.getEntity(chatId);
    const msgs = await this.client.getMessages(entity, { ids: [messageId] });
    const msg = msgs?.[0];
    if (!msg) return null;

    const info = this.rawMessageToInfo(msg);
    // Resolve sender name
    if (msg.senderId) {
      try {
        const sender = await this.client.getEntity(msg.senderId.toString());
        info.senderName = this.getEntityName(sender);
      } catch { /* ignore */ }
    }
    return info;
  }

  // --- Pinned Messages ---

  async getPinnedMessages(dialogId: string): Promise<MessageInfo[]> {
    if (!this.client) throw new Error('Not connected');
    const { chatId } = this.parseDialogId(dialogId);
    const entity = await this.client.getEntity(chatId);

    const result = await this.client.invoke(
      new Api.messages.Search({
        peer: entity,
        q: '',
        filter: new Api.InputMessagesFilterPinned(),
        minDate: 0,
        maxDate: 0,
        offsetId: 0,
        addOffset: 0,
        limit: 100,
        maxId: 0,
        minId: 0,
        hash: bigInt(0),
      })
    );

    const msgs = (result as any).messages || [];
    const filtered = msgs.filter((m: any): m is Api.Message => m instanceof Api.Message);

    // Resolve sender names
    const senderIds = Array.from(new Set(filtered.map((m: Api.Message) => m.senderId?.toString()).filter(Boolean))) as string[];
    const senderNames = new Map<string, string>();
    await Promise.all(senderIds.map(async (sid) => {
      try {
        const sender = await this.client!.getEntity(sid);
        senderNames.set(sid, this.getEntityName(sender));
      } catch { /* ignore */ }
    }));

    return filtered.map((m: Api.Message) => {
      const info = this.rawMessageToInfo(m);
      const sid = m.senderId?.toString();
      if (sid && senderNames.has(sid)) {
        info.senderName = senderNames.get(sid)!;
      }
      return info;
    });
  }

  // --- Leave Chat ---

  async leaveChat(dialogId: string): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    const { chatId } = this.parseDialogId(dialogId);
    const entity = await this.client.getEntity(chatId);

    if ((entity as any).className === 'Channel') {
      await this.client.invoke(
        new Api.channels.LeaveChannel({
          channel: entity as unknown as Api.TypeInputChannel,
        })
      );
    } else {
      // Basic group (Chat)
      const me = await this.client.getMe() as Api.User;
      await this.client.invoke(
        new Api.messages.DeleteChatUser({
          chatId: bigInt(chatId),
          userId: me as unknown as Api.TypeInputUser,
        })
      );
    }
  }

  // --- Delete Chat History ---

  async deleteChatHistory(dialogId: string, revoke = true): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    const { chatId } = this.parseDialogId(dialogId);
    const entity = await this.client.getEntity(chatId);
    await this.client.invoke(
      new Api.messages.DeleteHistory({
        peer: entity,
        maxId: 0,
        revoke,
      })
    );
    this.messagesCache.clear();
  }

  // --- Global Search ---

  async searchGlobal(query: string, limit = 20, offsetId?: number, offsetPeer?: string): Promise<{
    messages: Array<{
      id: number;
      dialogId: string;
      dialogName: string;
      senderName: string;
      text: string;
      date: number;
    }>;
    count: number;
    nextOffsetId?: number;
    nextOffsetPeer?: string;
  }> {
    if (!this.client) throw new Error('Not connected');

    let offsetPeerEntity: Api.TypeInputPeer = new Api.InputPeerEmpty();
    if (offsetPeer) {
      try {
        const e = await this.client.getEntity(offsetPeer);
        offsetPeerEntity = e as unknown as Api.TypeInputPeer;
      } catch { /* use empty */ }
    }

    const result = await this.client.invoke(
      new Api.messages.SearchGlobal({
        q: query,
        offsetRate: 0,
        offsetPeer: offsetPeerEntity,
        offsetId: offsetId || 0,
        limit,
        folderId: undefined,
      })
    );

    const rawMsgs = ((result as any).messages || []).filter(
      (m: any): m is Api.Message => m instanceof Api.Message
    );

    // Build maps for chats and users from the result
    const chatsMap = new Map<string, string>();
    const usersMap = new Map<string, string>();

    for (const chat of ((result as any).chats || [])) {
      chatsMap.set(chat.id.toString(), chat.title || chat.firstName || 'Unknown');
    }
    for (const user of ((result as any).users || [])) {
      const name = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.username || 'Unknown';
      usersMap.set(user.id.toString(), name);
    }

    const messages = rawMsgs.map((m: Api.Message) => {
      const peerId = m.peerId as any;
      let dialogId = '';
      let dialogName = 'Unknown';

      if (peerId?.className === 'PeerUser') {
        dialogId = peerId.userId.toString();
        dialogName = usersMap.get(dialogId) || 'Unknown';
      } else if (peerId?.className === 'PeerChat') {
        dialogId = peerId.chatId.toString();
        dialogName = chatsMap.get(dialogId) || 'Unknown';
      } else if (peerId?.className === 'PeerChannel') {
        dialogId = peerId.channelId.toString();
        dialogName = chatsMap.get(dialogId) || 'Unknown';
      }

      const senderId = m.senderId?.toString() || '';
      const senderName = usersMap.get(senderId) || chatsMap.get(senderId) || '';

      return {
        id: m.id,
        dialogId,
        dialogName,
        senderName,
        text: m.message || '',
        date: m.date || 0,
      };
    });

    // Pagination: use last message's rate/peer/id
    let nextOffsetId: number | undefined;
    let nextOffsetPeer: string | undefined;
    if (rawMsgs.length > 0) {
      const last = rawMsgs[rawMsgs.length - 1];
      nextOffsetId = last.id;
      const lastPeerId = last.peerId as any;
      if (lastPeerId?.className === 'PeerUser') {
        nextOffsetPeer = lastPeerId.userId.toString();
      } else if (lastPeerId?.className === 'PeerChat') {
        nextOffsetPeer = lastPeerId.chatId.toString();
      } else if (lastPeerId?.className === 'PeerChannel') {
        nextOffsetPeer = lastPeerId.channelId.toString();
      }
    }

    return {
      messages,
      count: (result as any).count || messages.length,
      nextOffsetId,
      nextOffsetPeer,
    };
  }

  // --- Search Dialogs (contacts.Search) ---

  async searchDialogs(query: string, limit = 20): Promise<{
    users: Array<{ id: string; name: string; username?: string; type: string }>;
    chats: Array<{ id: string; name: string; username?: string; type: string }>;
  }> {
    if (!this.client) throw new Error('Not connected');

    const result = await this.client.invoke(
      new Api.contacts.Search({
        q: query,
        limit,
      })
    );

    const users = ((result as any).users || []).map((u: any) => ({
      id: u.id.toString(),
      name: [u.firstName, u.lastName].filter(Boolean).join(' ') || u.username || 'Unknown',
      username: u.username,
      type: 'user',
    }));

    const chats = ((result as any).chats || []).map((c: any) => ({
      id: c.id.toString(),
      name: c.title || 'Unknown',
      username: c.username,
      type: c.className === 'Channel' ? (c.megagroup ? 'supergroup' : 'channel') : 'group',
    }));

    return { users, chats };
  }

  // --- Forum Topics CRUD ---

  async listForumTopics(dialogId: string, limit = 100, offsetDate?: number, offsetId?: number): Promise<{
    topics: Array<{
      id: number;
      title: string;
      iconColor?: number;
      iconEmojiId?: string;
      unreadCount: number;
      lastMessage?: string;
      date: number;
      closed: boolean;
      pinned: boolean;
    }>;
  }> {
    if (!this.client) throw new Error('Not connected');
    const { chatId } = this.parseDialogId(dialogId);
    const entity = await this.client.getEntity(chatId);

    const result = await this.client.invoke(
      new Api.channels.GetForumTopics({
        channel: entity as unknown as Api.TypeInputChannel,
        offsetDate: offsetDate || 0,
        offsetId: offsetId || 0,
        offsetTopic: 0,
        limit,
      })
    );

    const topics = ((result as any).topics || [])
      .filter((t: any): t is Api.ForumTopic => t instanceof Api.ForumTopic)
      .map((t: Api.ForumTopic) => ({
        id: t.id,
        title: t.title || '',
        iconColor: t.iconColor,
        iconEmojiId: t.iconEmojiId?.toString(),
        unreadCount: t.unreadCount || 0,
        date: t.date || 0,
        closed: t.closed || false,
        pinned: t.pinned || false,
      }));

    return { topics };
  }

  async createForumTopic(dialogId: string, title: string, iconColor?: number, iconEmojiId?: string, sendAs?: string): Promise<{
    id: number;
    title: string;
  }> {
    if (!this.client) throw new Error('Not connected');
    const { chatId } = this.parseDialogId(dialogId);
    const entity = await this.client.getEntity(chatId);

    const params: any = {
      channel: entity as unknown as Api.TypeInputChannel,
      title,
      randomId: bigInt(Math.floor(Math.random() * 1e15)),
    };
    if (iconColor !== undefined) params.iconColor = iconColor;
    if (iconEmojiId) params.iconEmojiId = bigInt(iconEmojiId);
    if (sendAs) {
      const sendAsEntity = await this.client.getEntity(sendAs);
      params.sendAs = sendAsEntity as unknown as Api.TypeInputPeer;
    }

    const result = await this.client.invoke(
      new Api.channels.CreateForumTopic(params)
    );

    // The result is Updates which contains the topic info in messages
    const updates = result as any;
    const topicMsg = updates.updates?.find((u: any) =>
      u.className === 'UpdateNewChannelMessage' || u.className === 'UpdateNewMessage'
    );

    // Extract topic ID from the action in the first message
    const replyTo = topicMsg?.message?.replyTo;
    const topicId = replyTo?.replyToTopId || replyTo?.replyToMsgId || topicMsg?.message?.id || 0;

    // Clear forum topics cache
    this.forumTopicsCache.delete(chatId);

    return { id: topicId, title };
  }

  async editForumTopic(dialogId: string, topicId: number, params: {
    title?: string;
    iconEmojiId?: string;
    closed?: boolean;
    hidden?: boolean;
  }): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    const { chatId } = this.parseDialogId(dialogId);
    const entity = await this.client.getEntity(chatId);

    const args: any = {
      channel: entity as unknown as Api.TypeInputChannel,
      topicId,
    };
    if (params.title !== undefined) args.title = params.title;
    if (params.iconEmojiId !== undefined) args.iconEmojiId = bigInt(params.iconEmojiId);
    if (params.closed !== undefined) args.closed = params.closed;
    if (params.hidden !== undefined) args.hidden = params.hidden;

    await this.client.invoke(new Api.channels.EditForumTopic(args));
    this.forumTopicsCache.delete(chatId);
  }

  async deleteForumTopic(dialogId: string, topicId: number): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    const { chatId } = this.parseDialogId(dialogId);
    const entity = await this.client.getEntity(chatId);

    await this.client.invoke(
      new Api.channels.DeleteTopicHistory({
        channel: entity as unknown as Api.TypeInputChannel,
        topMsgId: topicId,
      })
    );
    this.forumTopicsCache.delete(chatId);
  }

  async pinForumTopic(dialogId: string, topicId: number, pinned: boolean): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    const { chatId } = this.parseDialogId(dialogId);
    const entity = await this.client.getEntity(chatId);

    await this.client.invoke(
      new Api.channels.UpdatePinnedForumTopic({
        channel: entity as unknown as Api.TypeInputChannel,
        topicId,
        pinned,
      })
    );
    this.forumTopicsCache.delete(chatId);
  }

  // --- Edit Group/Channel Info ---

  async editDialogInfo(dialogId: string, params: { title?: string; about?: string }): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    const { chatId } = this.parseDialogId(dialogId);
    const entity = await this.client.getEntity(chatId);

    if ((entity as any).className === 'Channel') {
      // supergroup or channel
      if (params.title) {
        await this.client.invoke(
          new Api.channels.EditTitle({
            channel: entity as unknown as Api.TypeInputChannel,
            title: params.title,
          })
        );
      }
      if (params.about !== undefined) {
        await this.client.invoke(
          new Api.messages.EditChatAbout({
            peer: entity,
            about: params.about,
          })
        );
      }
    } else {
      // basic group
      if (params.title) {
        await this.client.invoke(
          new Api.messages.EditChatTitle({
            chatId: bigInt(chatId),
            title: params.title,
          })
        );
      }
      if (params.about !== undefined) {
        await this.client.invoke(
          new Api.messages.EditChatAbout({
            peer: entity,
            about: params.about,
          })
        );
      }
    }
  }

  async editDialogPhoto(dialogId: string, base64Data: string): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    const { chatId } = this.parseDialogId(dialogId);
    const entity = await this.client.getEntity(chatId);
    const buffer = Buffer.from(base64Data, 'base64');
    const file = new CustomFile('photo.jpg', buffer.length, '', buffer);
    const uploaded = await this.client.uploadFile({ file, workers: 1 });
    const inputPhoto = new Api.InputChatUploadedPhoto({ file: uploaded });

    if ((entity as any).className === 'Channel') {
      await this.client.invoke(
        new Api.channels.EditPhoto({
          channel: entity as unknown as Api.TypeInputChannel,
          photo: inputPhoto,
        })
      );
    } else {
      await this.client.invoke(
        new Api.messages.EditChatPhoto({
          chatId: bigInt(chatId),
          photo: inputPhoto,
        })
      );
    }
  }

  // --- Members ---

  async getMembers(dialogId: string, opts: {
    limit?: number;
    offset?: number;
    filter?: 'all' | 'admins' | 'kicked' | 'banned' | 'bots';
    q?: string;
  }): Promise<{ members: Array<{ userId: string; firstName: string; lastName: string; username: string; role: string; joinDate: number }>; count: number }> {
    if (!this.client) throw new Error('Not connected');
    const { chatId } = this.parseDialogId(dialogId);
    const entity = await this.client.getEntity(chatId);
    const limit = opts.limit || 100;
    const offset = opts.offset || 0;

    let channelFilter: Api.TypeChannelParticipantsFilter;
    switch (opts.filter) {
      case 'admins':
        channelFilter = new Api.ChannelParticipantsAdmins();
        break;
      case 'kicked':
        channelFilter = new Api.ChannelParticipantsKicked({ q: opts.q || '' });
        break;
      case 'banned':
        channelFilter = new Api.ChannelParticipantsBanned({ q: opts.q || '' });
        break;
      case 'bots':
        channelFilter = new Api.ChannelParticipantsBots();
        break;
      default:
        channelFilter = opts.q
          ? new Api.ChannelParticipantsSearch({ q: opts.q })
          : new Api.ChannelParticipantsRecent();
        break;
    }

    const result = await this.client.invoke(
      new Api.channels.GetParticipants({
        channel: entity as unknown as Api.TypeInputChannel,
        filter: channelFilter,
        offset,
        limit,
        hash: bigInt(0),
      })
    );

    const participants = (result as any).participants || [];
    const usersMap = new Map<string, any>();
    for (const u of ((result as any).users || [])) {
      usersMap.set(u.id.toString(), u);
    }

    const members = participants.map((p: any) => {
      let peerId: string;
      if (p.userId) {
        peerId = p.userId.toString();
      } else if (p.peer instanceof Api.PeerUser) {
        peerId = p.peer.userId.toString();
      } else {
        peerId = '';
      }
      const user = usersMap.get(peerId);
      let role = 'member';
      if (p.className === 'ChannelParticipantCreator') role = 'creator';
      else if (p.className === 'ChannelParticipantAdmin') role = 'admin';
      else if (p.className === 'ChannelParticipantBanned') role = 'banned';
      else if (p.className === 'ChannelParticipantLeft') role = 'left';

      return {
        userId: peerId,
        firstName: user?.firstName || '',
        lastName: user?.lastName || '',
        username: user?.username || '',
        role,
        joinDate: p.date || 0,
      };
    });

    return { members, count: (result as any).count || members.length };
  }

  async addMembers(dialogId: string, userIds: string[]): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    const { chatId } = this.parseDialogId(dialogId);
    const entity = await this.client.getEntity(chatId);
    const users: Api.TypeInputUser[] = [];
    for (const uid of userIds) {
      const u = await this.client.getEntity(uid);
      users.push(u as unknown as Api.TypeInputUser);
    }
    await this.client.invoke(
      new Api.channels.InviteToChannel({
        channel: entity as unknown as Api.TypeInputChannel,
        users,
      })
    );
  }

  async removeMember(dialogId: string, userId: string, ban = false): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    const { chatId } = this.parseDialogId(dialogId);
    const entity = await this.client.getEntity(chatId);
    const userEntity = await this.client.getEntity(userId);

    if ((entity as any).className === 'Channel') {
      await this.client.invoke(
        new Api.channels.EditBanned({
          channel: entity as unknown as Api.TypeInputChannel,
          participant: userEntity as unknown as Api.TypeInputPeer,
          bannedRights: new Api.ChatBannedRights({
            untilDate: ban ? 0 : Math.floor(Date.now() / 1000) + 60, // kick = ban for 60s
            viewMessages: true,
            sendMessages: true,
            sendMedia: true,
            sendStickers: true,
            sendGifs: true,
            sendGames: true,
            sendInline: true,
            embedLinks: true,
          }),
        })
      );
      // If just kick (not permanent ban), unban after a moment
      if (!ban) {
        await this.client.invoke(
          new Api.channels.EditBanned({
            channel: entity as unknown as Api.TypeInputChannel,
            participant: userEntity as unknown as Api.TypeInputPeer,
            bannedRights: new Api.ChatBannedRights({ untilDate: 0 }),
          })
        );
      }
    } else {
      // basic group
      await this.client.invoke(
        new Api.messages.DeleteChatUser({
          chatId: bigInt(chatId),
          userId: userEntity as unknown as Api.TypeInputUser,
        })
      );
    }
  }

  // --- Ban / Unban ---

  async banMember(dialogId: string, userId: string, deleteMessages = false): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    const { chatId } = this.parseDialogId(dialogId);
    const entity = await this.client.getEntity(chatId);
    const userEntity = await this.client.getEntity(userId);

    if ((entity as any).className === 'Channel') {
      await this.client.invoke(
        new Api.channels.EditBanned({
          channel: entity as unknown as Api.TypeInputChannel,
          participant: userEntity as unknown as Api.TypeInputPeer,
          bannedRights: new Api.ChatBannedRights({
            untilDate: 0, // permanent
            viewMessages: true,
            sendMessages: true,
            sendMedia: true,
            sendStickers: true,
            sendGifs: true,
            sendGames: true,
            sendInline: true,
            embedLinks: true,
          }),
        })
      );
      if (deleteMessages) {
        await this.client.invoke(
          new Api.channels.DeleteParticipantHistory({
            channel: entity as unknown as Api.TypeInputChannel,
            participant: userEntity as unknown as Api.TypeInputPeer,
          })
        );
      }
    } else {
      // Basic group: kick user (no ban concept in basic groups)
      await this.client.invoke(
        new Api.messages.DeleteChatUser({
          chatId: bigInt(chatId),
          userId: userEntity as unknown as Api.TypeInputUser,
          revokeHistory: deleteMessages || undefined,
        })
      );
    }
  }

  async unbanMember(dialogId: string, userId: string): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    const { chatId } = this.parseDialogId(dialogId);
    const entity = await this.client.getEntity(chatId);
    const userEntity = await this.client.getEntity(userId);

    if ((entity as any).className === 'Channel') {
      await this.client.invoke(
        new Api.channels.EditBanned({
          channel: entity as unknown as Api.TypeInputChannel,
          participant: userEntity as unknown as Api.TypeInputPeer,
          bannedRights: new Api.ChatBannedRights({ untilDate: 0 }),
        })
      );
    } else {
      // Basic groups don't have a ban list — nothing to unban
      throw new Error('Unban not supported for basic groups');
    }
  }

  // --- Per-Member Permissions ---

  async setMemberPermissions(dialogId: string, userId: string, perms: {
    sendMessages?: boolean;
    sendMedia?: boolean;
    sendStickers?: boolean;
    sendGifs?: boolean;
    sendGames?: boolean;
    sendInline?: boolean;
    embedLinks?: boolean;
    sendPolls?: boolean;
    changeInfo?: boolean;
    inviteUsers?: boolean;
    pinMessages?: boolean;
    manageTopics?: boolean;
    untilDate?: number;
  }): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    const { chatId } = this.parseDialogId(dialogId);
    const entity = await this.client.getEntity(chatId);
    const userEntity = await this.client.getEntity(userId);

    if ((entity as any).className !== 'Channel') {
      throw new Error('Per-member permissions only supported for supergroups/channels');
    }

    // bannedRights: true = RESTRICTED
    await this.client.invoke(
      new Api.channels.EditBanned({
        channel: entity as unknown as Api.TypeInputChannel,
        participant: userEntity as unknown as Api.TypeInputPeer,
        bannedRights: new Api.ChatBannedRights({
          untilDate: perms.untilDate || 0,
          sendMessages: perms.sendMessages === false ? true : undefined,
          sendMedia: perms.sendMedia === false ? true : undefined,
          sendStickers: perms.sendStickers === false ? true : undefined,
          sendGifs: perms.sendGifs === false ? true : undefined,
          sendGames: perms.sendGames === false ? true : undefined,
          sendInline: perms.sendInline === false ? true : undefined,
          embedLinks: perms.embedLinks === false ? true : undefined,
          sendPolls: perms.sendPolls === false ? true : undefined,
          changeInfo: perms.changeInfo === false ? true : undefined,
          inviteUsers: perms.inviteUsers === false ? true : undefined,
          pinMessages: perms.pinMessages === false ? true : undefined,
          manageTopics: perms.manageTopics === false ? true : undefined,
        }),
      })
    );
  }

  // --- Primary Invite Link ---

  async getPrimaryInviteLink(dialogId: string): Promise<{ link: string }> {
    if (!this.client) throw new Error('Not connected');
    const { chatId } = this.parseDialogId(dialogId);
    const entity = await this.client.getEntity(chatId);

    if ((entity as any).className === 'Channel') {
      const full = await this.client.invoke(
        new Api.channels.GetFullChannel({
          channel: entity as unknown as Api.TypeInputChannel,
        })
      );
      const invite = (full as any).fullChat?.exportedInvite;
      if (invite?.link) return { link: invite.link };
      // If no exported invite, create one
      const result = await this.client.invoke(
        new Api.messages.ExportChatInvite({ peer: entity })
      );
      return { link: (result as Api.ChatInviteExported).link };
    } else {
      const full = await this.client.invoke(
        new Api.messages.GetFullChat({ chatId: bigInt(chatId) })
      );
      const invite = (full as any).fullChat?.exportedInvite;
      if (invite?.link) return { link: invite.link };
      const result = await this.client.invoke(
        new Api.messages.ExportChatInvite({ peer: entity })
      );
      return { link: (result as Api.ChatInviteExported).link };
    }
  }

  // --- Admin Management ---

  async promoteAdmin(dialogId: string, userId: string, rights: {
    changeInfo?: boolean;
    postMessages?: boolean;
    editMessages?: boolean;
    deleteMessages?: boolean;
    banUsers?: boolean;
    inviteUsers?: boolean;
    pinMessages?: boolean;
    manageTopics?: boolean;
    addAdmins?: boolean;
    anonymous?: boolean;
    manageCall?: boolean;
    other?: boolean;
  }): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    const { chatId } = this.parseDialogId(dialogId);
    const entity = await this.client.getEntity(chatId);
    const userEntity = await this.client.getEntity(userId);

    await this.client.invoke(
      new Api.channels.EditAdmin({
        channel: entity as unknown as Api.TypeInputChannel,
        userId: userEntity as unknown as Api.TypeInputUser,
        adminRights: new Api.ChatAdminRights({
          changeInfo: rights.changeInfo,
          postMessages: rights.postMessages,
          editMessages: rights.editMessages,
          deleteMessages: rights.deleteMessages,
          banUsers: rights.banUsers,
          inviteUsers: rights.inviteUsers,
          pinMessages: rights.pinMessages,
          manageTopics: rights.manageTopics,
          addAdmins: rights.addAdmins,
          anonymous: rights.anonymous,
          manageCall: rights.manageCall,
          other: rights.other,
        }),
        rank: '',
      })
    );
  }

  async demoteAdmin(dialogId: string, userId: string): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    const { chatId } = this.parseDialogId(dialogId);
    const entity = await this.client.getEntity(chatId);
    const userEntity = await this.client.getEntity(userId);

    await this.client.invoke(
      new Api.channels.EditAdmin({
        channel: entity as unknown as Api.TypeInputChannel,
        userId: userEntity as unknown as Api.TypeInputUser,
        adminRights: new Api.ChatAdminRights({}),
        rank: '',
      })
    );
  }

  // --- Invite Links ---

  async createInviteLink(dialogId: string, params: {
    expireDate?: number;
    usageLimit?: number;
    requestNeeded?: boolean;
    title?: string;
  }): Promise<{ link: string; expireDate?: number; usageLimit?: number; usage: number; title?: string }> {
    if (!this.client) throw new Error('Not connected');
    const { chatId } = this.parseDialogId(dialogId);
    const entity = await this.client.getEntity(chatId);

    const result = await this.client.invoke(
      new Api.messages.ExportChatInvite({
        peer: entity,
        expireDate: params.expireDate,
        usageLimit: params.usageLimit,
        requestNeeded: params.requestNeeded,
        title: params.title,
      })
    );

    const invite = result as Api.ChatInviteExported;
    return {
      link: invite.link,
      expireDate: invite.expireDate,
      usageLimit: invite.usageLimit,
      usage: invite.usage || 0,
      title: invite.title,
    };
  }

  async getInviteLinks(dialogId: string, opts: {
    limit?: number;
    revoked?: boolean;
  }): Promise<Array<{ link: string; expireDate?: number; usageLimit?: number; usage: number; title?: string; revoked: boolean }>> {
    if (!this.client) throw new Error('Not connected');
    const { chatId } = this.parseDialogId(dialogId);
    const entity = await this.client.getEntity(chatId);
    const me = await this.client.getMe() as Api.User;

    const result = await this.client.invoke(
      new Api.messages.GetExportedChatInvites({
        peer: entity,
        adminId: me as unknown as Api.TypeInputUser,
        revoked: opts.revoked || false,
        limit: opts.limit || 50,
      })
    );

    return ((result as any).invites || []).map((inv: Api.ChatInviteExported) => ({
      link: inv.link,
      expireDate: inv.expireDate,
      usageLimit: inv.usageLimit,
      usage: inv.usage || 0,
      title: inv.title,
      revoked: inv.revoked || false,
    }));
  }

  async revokeInviteLink(dialogId: string, link: string): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    const { chatId } = this.parseDialogId(dialogId);
    const entity = await this.client.getEntity(chatId);

    await this.client.invoke(
      new Api.messages.EditExportedChatInvite({
        peer: entity,
        link,
        revoked: true,
      })
    );
  }

  // --- Join / Leave ---

  async joinChat(params: { link?: string; username?: string }): Promise<{ dialogId: string }> {
    if (!this.client) throw new Error('Not connected');

    if (params.link) {
      // Extract hash from invite link
      const hash = params.link.replace(/^https?:\/\/t\.me\/\+/, '').replace(/^https?:\/\/t\.me\/joinchat\//, '');
      const result = await this.client.invoke(
        new Api.messages.ImportChatInvite({ hash })
      );
      const chat = (result as any).chats?.[0];
      return { dialogId: chat?.id?.toString() || '' };
    } else if (params.username) {
      const entity = await this.client.getEntity(params.username);
      await this.client.invoke(
        new Api.channels.JoinChannel({
          channel: entity as unknown as Api.TypeInputChannel,
        })
      );
      return { dialogId: (entity as any).id?.toString() || '' };
    }

    throw new Error('Either link or username required');
  }

  // leaveChat already exists above

  // --- Permissions ---

  async getDefaultPermissions(dialogId: string): Promise<Record<string, boolean>> {
    if (!this.client) throw new Error('Not connected');
    const { chatId } = this.parseDialogId(dialogId);
    const entity = await this.client.getEntity(chatId);

    let bannedRights: Api.ChatBannedRights | undefined;

    if ((entity as any).className === 'Channel') {
      const full = await this.client.invoke(
        new Api.channels.GetFullChannel({
          channel: entity as unknown as Api.TypeInputChannel,
        })
      );
      const chat = (full as any).chats?.[0];
      bannedRights = chat?.defaultBannedRights;
    } else {
      const full = await this.client.invoke(
        new Api.messages.GetFullChat({ chatId: bigInt(chatId) })
      );
      const chat = (full as any).chats?.[0];
      bannedRights = chat?.defaultBannedRights;
    }

    if (!bannedRights) return {};

    // Return inverted: true = ALLOWED (bannedRights means "restricted when true")
    return {
      sendMessages: !bannedRights.sendMessages,
      sendMedia: !bannedRights.sendMedia,
      sendStickers: !bannedRights.sendStickers,
      sendGifs: !bannedRights.sendGifs,
      sendGames: !bannedRights.sendGames,
      sendInline: !bannedRights.sendInline,
      embedLinks: !bannedRights.embedLinks,
      sendPolls: !bannedRights.sendPolls,
      changeInfo: !bannedRights.changeInfo,
      inviteUsers: !bannedRights.inviteUsers,
      pinMessages: !bannedRights.pinMessages,
      manageTopics: !bannedRights.manageTopics,
    };
  }

  async setDefaultPermissions(dialogId: string, perms: {
    sendMessages?: boolean;
    sendMedia?: boolean;
    sendStickers?: boolean;
    sendGifs?: boolean;
    sendGames?: boolean;
    sendInline?: boolean;
    embedLinks?: boolean;
    sendPolls?: boolean;
    changeInfo?: boolean;
    inviteUsers?: boolean;
    pinMessages?: boolean;
    manageTopics?: boolean;
  }): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    const { chatId } = this.parseDialogId(dialogId);
    const entity = await this.client.getEntity(chatId);

    // bannedRights = inverted: true means RESTRICTED
    await this.client.invoke(
      new Api.messages.EditChatDefaultBannedRights({
        peer: entity,
        bannedRights: new Api.ChatBannedRights({
          untilDate: 0,
          sendMessages: perms.sendMessages === false ? true : undefined,
          sendMedia: perms.sendMedia === false ? true : undefined,
          sendStickers: perms.sendStickers === false ? true : undefined,
          sendGifs: perms.sendGifs === false ? true : undefined,
          sendGames: perms.sendGames === false ? true : undefined,
          sendInline: perms.sendInline === false ? true : undefined,
          embedLinks: perms.embedLinks === false ? true : undefined,
          sendPolls: perms.sendPolls === false ? true : undefined,
          changeInfo: perms.changeInfo === false ? true : undefined,
          inviteUsers: perms.inviteUsers === false ? true : undefined,
          pinMessages: perms.pinMessages === false ? true : undefined,
          manageTopics: perms.manageTopics === false ? true : undefined,
        }),
      })
    );
  }

  // --- Slow Mode ---

  async setSlowMode(dialogId: string, seconds: number): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    const { chatId } = this.parseDialogId(dialogId);
    const entity = await this.client.getEntity(chatId);

    await this.client.invoke(
      new Api.channels.ToggleSlowMode({
        channel: entity as unknown as Api.TypeInputChannel,
        seconds,
      })
    );
  }

  // --- Bot Callback ---

  async getBotCallbackAnswer(dialogId: string, messageId: number, data: string): Promise<{ message?: string; alert?: boolean; url?: string }> {
    if (!this.client) throw new Error('Not connected');
    const { chatId } = this.parseDialogId(dialogId);
    const entity = await this.client.getEntity(chatId);

    const result = await this.client.invoke(
      new Api.messages.GetBotCallbackAnswer({
        peer: entity,
        msgId: messageId,
        data: Buffer.from(data),
      })
    );

    return {
      message: result.message || undefined,
      alert: result.alert || false,
      url: result.url || undefined,
    };
  }

  // --- Contacts ---

  async getContacts(limit?: number): Promise<Array<{ userId: string; firstName: string; lastName: string; username: string; phone: string }>> {
    if (!this.client) throw new Error('Not connected');

    const result = await this.client.invoke(
      new Api.contacts.GetContacts({ hash: bigInt(0) })
    );

    const users = (result as any).users || [];
    const contacts = users.map((u: any) => ({
      userId: u.id.toString(),
      firstName: u.firstName || '',
      lastName: u.lastName || '',
      username: u.username || '',
      phone: u.phone || '',
    }));

    return limit ? contacts.slice(0, limit) : contacts;
  }

  async searchContacts(q: string, limit = 20): Promise<{
    users: Array<{ id: string; name: string; username?: string }>;
    chats: Array<{ id: string; name: string; username?: string }>;
  }> {
    if (!this.client) throw new Error('Not connected');

    const result = await this.client.invoke(
      new Api.contacts.Search({ q, limit })
    );

    const users = ((result as any).users || []).map((u: any) => ({
      id: u.id.toString(),
      name: [u.firstName, u.lastName].filter(Boolean).join(' ') || u.username || 'Unknown',
      username: u.username,
    }));

    const chats = ((result as any).chats || []).map((c: any) => ({
      id: c.id.toString(),
      name: c.title || 'Unknown',
      username: c.username,
    }));

    return { users, chats };
  }

  // --- Saved Messages ---

  async getSavedMessages(limit = 20, offsetId?: number): Promise<MessageInfo[]> {
    if (!this.client) throw new Error('Not connected');

    const me = await this.client.getMe() as Api.User;
    const opts: any = { limit };
    if (offsetId) opts.offsetId = offsetId;

    const msgs = await this.client.getMessages(me, opts);
    const results: MessageInfo[] = [];

    const senderIds = Array.from(new Set(msgs.map((m: any) => m.senderId?.toString()).filter(Boolean))) as string[];
    const senderNames = new Map<string, string>();
    await Promise.all(senderIds.map(async (sid) => {
      try {
        const sender = await this.client!.getEntity(sid);
        senderNames.set(sid, this.getEntityName(sender));
      } catch { /* ignore */ }
    }));

    for (const msg of msgs) {
      const info = this.rawMessageToInfo(msg);
      const sid = msg.senderId?.toString();
      if (sid && senderNames.has(sid)) {
        info.senderName = senderNames.get(sid)!;
      }
      results.push(info);
    }
    return results.reverse();
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.disconnect();
      this.connected = false;
    }
    try { this.cache.close(); } catch { /* ignore */ }
  }

  private parseDialogId(id: string): { chatId: string; topicId?: number } {
    const parts = id.split(':');
    if (parts.length === 2) return { chatId: parts[0], topicId: parseInt(parts[1], 10) };
    return { chatId: id };
  }

  private getEntityName(entity: unknown): string {
    const e = entity as any;
    if (!e) return 'Unknown';
    if (e.title) return e.title;
    const parts = [e.firstName, e.lastName].filter(Boolean);
    return parts.join(' ') || e.username || 'Unknown';
  }
}
