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
}

export interface MessageInfo {
  id: number;
  senderId: string;
  senderName: string;
  text: string;
  timestamp: number;
  isOutgoing: boolean;
}

export class TelegramService {
  private client: TelegramClient | null = null;
  private connected = false;
  private forumTopicsCache: Map<string, Api.ForumTopic[]> = new Map();

  async connect(): Promise<void> {
    if (this.connected) return;

    const apiId = parseInt(process.env.TELEGRAM_API_ID || '35419737', 10);
    const apiHash = process.env.TELEGRAM_API_HASH || 'f689329727c1f0002f72152be5f3f6fa';
    const sessionString = process.env.TELEGRAM_SESSION || '1BAAOMTQ5LjE1NC4xNjcuOTEAUB7AWOonm5gqktEItqbPhPnn/VP+MWHhKWzhXCMxmaMt4VhoMSTfgw1uA/QKt8z7fXpF0pkdtmN8PkivXjiJb2U66HPKCAPmcFiOxly6u4NNdqlkZvWzBQT3MLnNNDwTuZ+x8XjIEEMGc13S0M6ZxGfKBSiybieLaH1eCHCYxFSYcyistaQ8gXD/DaVxSC3BcCSSgK0oG1aUa+feEzkyqvcYjv2ECiL9ACkdxokIVwXk7MD9ZFekeRmx5JY/UZcsfQDhGpr6bLtUBPbabmW78OEcDxzqvPsjmYadbFORaBRTa3IPfGXdYuTQmvV1sXRVAK3VW+lqehK1HbgUR4ut/Cg=';

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
            const topicName = topic.title || 'General';
            const displayName = `${groupName} / ${topicName}`;
            results.push({
              id: dialogId,
              chatId,
              topicId,
              name: displayName,
              lastMessage: '', // Topic-level last message requires extra fetch
              lastMessageTime: topic.date || 0,
              unreadCount: topic.unreadCount || 0,
              initials: this.getInitials(topicName),
              isPinned: pinnedIds.includes(dialogId),
              isForum: true,
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
      // Fetch messages from a specific forum topic
      msgs = await this.client.getMessages(entity, {
        limit,
        replyTo: topicId,
      });
    } else {
      msgs = await this.client.getMessages(entity, { limit });
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
      results.push({
        id: msg.id,
        senderId: msg.senderId?.toString() || '',
        senderName,
        text: msg.message || '',
        timestamp: msg.date || 0,
        isOutgoing: msg.out || false,
      });
    }

    return results.reverse();
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
