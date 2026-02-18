import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { Api } from 'telegram';
import * as fs from 'fs';
import * as path from 'path';

const CONFIG_DIR = path.join(process.env.HOME || '/home/xiko', '.oceangram');
const PINNED_PATH = path.join(CONFIG_DIR, 'pinned.json');

export interface DialogInfo {
  id: string;
  name: string;
  lastMessage: string;
  lastMessageTime: number;
  unreadCount: number;
  initials: string;
  isPinned: boolean;
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

  async connect(): Promise<void> {
    if (this.connected) { return; }

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

  pinDialog(chatId: string): void {
    const ids = this.getPinnedIds();
    if (!ids.includes(chatId)) {
      ids.push(chatId);
      this.savePinnedIds(ids);
    }
  }

  unpinDialog(chatId: string): void {
    const ids = this.getPinnedIds().filter(id => id !== chatId);
    this.savePinnedIds(ids);
  }

  private getInitials(name: string): string {
    return name.split(' ').map(w => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
  }

  private getEntityName(entity: any): string {
    if (!entity) { return 'Unknown'; }
    if (entity.title) { return entity.title; }
    const parts = [entity.firstName, entity.lastName].filter(Boolean);
    return parts.join(' ') || entity.username || 'Unknown';
  }

  private getEntityId(dialog: any): string {
    const peer = dialog.id;
    if (peer) { return peer.toString(); }
    return '0';
  }

  async getDialogs(limit = 100): Promise<DialogInfo[]> {
    if (!this.client) { throw new Error('Not connected'); }
    const dialogs = await this.client.getDialogs({ limit });
    const pinnedIds = this.getPinnedIds();

    return dialogs.map(d => {
      const id = this.getEntityId(d);
      const name = this.getEntityName(d.entity);
      return {
        id,
        name,
        lastMessage: d.message?.message || '',
        lastMessageTime: d.message?.date || 0,
        unreadCount: d.unreadCount || 0,
        initials: this.getInitials(name),
        isPinned: pinnedIds.includes(id),
      };
    });
  }

  async searchDialogs(query: string): Promise<DialogInfo[]> {
    const all = await this.getDialogs(200);
    const q = query.toLowerCase();
    return all.filter(d => d.name.toLowerCase().includes(q));
  }

  async getMessages(chatId: string, limit = 50): Promise<MessageInfo[]> {
    if (!this.client) { throw new Error('Not connected'); }
    const entity = await this.client.getEntity(chatId);
    const msgs = await this.client.getMessages(entity, { limit });
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

  async sendMessage(chatId: string, text: string): Promise<void> {
    if (!this.client) { throw new Error('Not connected'); }
    const entity = await this.client.getEntity(chatId);
    await this.client.sendMessage(entity, { message: text });
  }
}
