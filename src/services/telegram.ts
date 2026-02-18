import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { Api } from 'telegram';
import * as fs from 'fs';
import * as path from 'path';

const CONFIG_DIR = path.join(process.env.HOME || '/home/xiko', '.oceangram');
const PINNED_PATH = path.join(CONFIG_DIR, 'pinned.json');

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
}

export class TelegramService {
  private client: TelegramClient | null = null;
  private connected = false;
  private forumTopicsCache: Map<string, Api.ForumTopic[]> = new Map();

  async connect(): Promise<void> {
    if (this.connected) return;

    // Credentials loaded from env vars or config file — never hardcoded
    const configPath = path.join(CONFIG_DIR, 'config.json');
    let fileConfig: Record<string, string> = {};
    try {
      if (fs.existsSync(configPath)) {
        fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      }
    } catch { /* ignore */ }

    const apiId = parseInt(process.env.TELEGRAM_API_ID || fileConfig.apiId || '0', 10);
    const apiHash = process.env.TELEGRAM_API_HASH || fileConfig.apiHash || '';
    const sessionString = process.env.TELEGRAM_SESSION || fileConfig.session || '';

    if (!apiId || !apiHash || !sessionString) {
      throw new Error(
        'Telegram credentials not configured. Set TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_SESSION env vars ' +
        'or create ~/.oceangram/config.json with { "apiId": "...", "apiHash": "...", "session": "..." }'
      );
    }

    const session = new StringSession(sessionString);
    this.client = new TelegramClient(session, apiId, apiHash, {
      connectionRetries: 5,
    });

    await this.client.connect();
    this.connected = true;
    console.log('[Oceangram] Telegram connected');
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
      if (fs.existsSync(PINNED_PATH)) {
        return JSON.parse(fs.readFileSync(PINNED_PATH, 'utf-8'));
      }
    } catch { /* ignore */ }
    return [];
  }

  private savePinnedIds(ids: string[]): void {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    fs.writeFileSync(PINNED_PATH, JSON.stringify(ids, null, 2));
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

  async searchDialogs(query: string): Promise<DialogInfo[]> {
    const all = await this.getDialogs(200);
    const q = query.toLowerCase();
    return all.filter(d => d.name.toLowerCase().includes(q));
  }

  // --- Messages ---

  async getMessages(dialogId: string, limit = 50): Promise<MessageInfo[]> {
    if (!this.client) throw new Error('Not connected');
    const { chatId, topicId } = TelegramService.parseDialogId(dialogId);
    const entity = await this.client.getEntity(chatId);

    let msgs;
    if (topicId) {
      msgs = await this.client.getMessages(entity, {
        limit,
        replyTo: topicId,
      });
    } else {
      msgs = await this.client.getMessages(entity, { limit });
    }

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
            } else if (isAnimated) {
              info.mediaType = 'gif';
            } else if (isVideo) {
              info.mediaType = 'video';
            } else if (isAudio) {
              const audioAttr = attrs.find((a: any) => a.className === 'DocumentAttributeAudio');
              info.mediaType = audioAttr?.voice ? 'voice' : 'file';
            } else {
              info.mediaType = 'file';
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
      if (msg.replyTo && msg.replyTo.replyToMsgId) {
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

  async sendMessage(dialogId: string, text: string): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    const { chatId, topicId } = TelegramService.parseDialogId(dialogId);
    const entity = await this.client.getEntity(chatId);

    if (topicId) {
      await this.client.sendMessage(entity, { message: text, replyTo: topicId });
    } else {
      await this.client.sendMessage(entity, { message: text });
    }
  }
}
