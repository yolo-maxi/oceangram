import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import type { DialogInfo, MessageInfo } from './telegram';

const DEFAULT_DB_DIR = path.join(process.env.HOME || '/root', '.oceangram');
const DEFAULT_DB_PATH = path.join(DEFAULT_DB_DIR, 'cache.db');

export class Cache {
  private db: Database.Database;

  constructor(dbPath: string = DEFAULT_DB_PATH) {
    // Ensure directory exists
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    this.db = new Database(dbPath);

    // Performance pragmas
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');

    this.createSchema();
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER NOT NULL,
        dialog_id TEXT NOT NULL,
        from_id TEXT,
        sender_name TEXT,
        text TEXT,
        date INTEGER,
        edit_date INTEGER,
        reply_to INTEGER,
        media_type TEXT,
        is_outgoing INTEGER DEFAULT 0,
        raw JSON,
        PRIMARY KEY (dialog_id, id)
      );
      CREATE INDEX IF NOT EXISTS idx_messages_dialog ON messages(dialog_id, date DESC);

      CREATE TABLE IF NOT EXISTS dialogs (
        id TEXT PRIMARY KEY,
        chat_id TEXT,
        topic_id INTEGER,
        name TEXT,
        type TEXT,
        last_message TEXT,
        last_message_time INTEGER,
        unread_count INTEGER DEFAULT 0,
        is_forum INTEGER DEFAULT 0,
        group_name TEXT,
        topic_name TEXT,
        has_photo INTEGER DEFAULT 0,
        raw JSON,
        updated_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_dialogs_date ON dialogs(last_message_time DESC);

      CREATE TABLE IF NOT EXISTS profile_photos (
        user_id TEXT PRIMARY KEY,
        data BLOB,
        mime_type TEXT DEFAULT 'image/jpeg',
        updated_at INTEGER
      );
    `);
  }

  // ─── Messages ──────────────────────────────────────────────────────────

  getMessages(dialogId: string, limit: number, offsetId?: number): MessageInfo[] {
    let stmt;
    if (offsetId) {
      stmt = this.db.prepare(`
        SELECT * FROM messages
        WHERE dialog_id = ? AND id < ?
        ORDER BY date DESC
        LIMIT ?
      `);
      const rows = stmt.all(dialogId, offsetId, limit) as any[];
      return rows.map(rowToMessageInfo).reverse();
    } else {
      stmt = this.db.prepare(`
        SELECT * FROM messages
        WHERE dialog_id = ?
        ORDER BY date DESC
        LIMIT ?
      `);
      const rows = stmt.all(dialogId, limit) as any[];
      return rows.map(rowToMessageInfo).reverse();
    }
  }

  getMessageCount(dialogId: string): number {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM messages WHERE dialog_id = ?').get(dialogId) as any;
    return row?.cnt || 0;
  }

  upsertMessages(dialogId: string, messages: MessageInfo[]): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO messages (
        id, dialog_id, from_id, sender_name, text, date, edit_date,
        reply_to, media_type, is_outgoing, raw
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const tx = this.db.transaction((msgs: MessageInfo[]) => {
      for (const m of msgs) {
        stmt.run(
          m.id,
          dialogId,
          m.senderId || null,
          m.senderName || null,
          m.text || null,
          m.timestamp || null,
          m.isEdited ? Math.floor(Date.now() / 1000) : null,
          m.replyToId || null,
          m.mediaType || null,
          m.isOutgoing ? 1 : 0,
          JSON.stringify(m),
        );
      }
    });

    tx(messages);
  }

  deleteMessage(dialogId: string, messageId: number): void {
    this.db.prepare('DELETE FROM messages WHERE dialog_id = ? AND id = ?').run(dialogId, messageId);
  }

  // ─── Dialogs ───────────────────────────────────────────────────────────

  getDialogs(limit: number): DialogInfo[] {
    const rows = this.db.prepare(`
      SELECT * FROM dialogs
      ORDER BY last_message_time DESC
      LIMIT ?
    `).all(limit) as any[];

    return rows.map(rowToDialogInfo);
  }

  getDialogCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM dialogs').get() as any;
    return row?.cnt || 0;
  }

  upsertDialogs(dialogs: DialogInfo[]): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO dialogs (
        id, chat_id, topic_id, name, type, last_message, last_message_time,
        unread_count, is_forum, group_name, topic_name, has_photo, raw, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const tx = this.db.transaction((ds: DialogInfo[]) => {
      for (const d of ds) {
        stmt.run(
          d.id,
          d.chatId || d.id,
          d.topicId || null,
          d.name || null,
          d.type || null,
          d.lastMessage || null,
          d.lastMessageTime || null,
          d.unreadCount || 0,
          d.isForum ? 1 : 0,
          d.groupName || null,
          d.topicName || null,
          d.hasPhoto ? 1 : 0,
          JSON.stringify(d),
          Math.floor(Date.now() / 1000),
        );
      }
    });

    tx(dialogs);
  }

  // ─── Profile Photos ────────────────────────────────────────────────────

  getProfilePhoto(userId: string): { data: Buffer; mimeType: string } | null {
    const row = this.db.prepare('SELECT data, mime_type FROM profile_photos WHERE user_id = ?').get(userId) as any;
    if (!row || !row.data) return null;
    return { data: Buffer.from(row.data), mimeType: row.mime_type || 'image/jpeg' };
  }

  setProfilePhoto(userId: string, data: Buffer, mimeType: string): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO profile_photos (user_id, data, mime_type, updated_at)
      VALUES (?, ?, ?, ?)
    `).run(userId, data, mimeType, Math.floor(Date.now() / 1000));
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────

  close(): void {
    this.db.close();
  }
}

// ─── Row → Interface mappers ───────────────────────────────────────────────

function rowToMessageInfo(row: any): MessageInfo {
  // If we have full raw JSON, prefer that for richness (reactions, forward, etc.)
  if (row.raw) {
    try {
      const parsed = JSON.parse(row.raw);
      // Ensure critical fields from DB columns override (they may be updated)
      return {
        ...parsed,
        id: row.id,
        text: row.text ?? parsed.text,
        isEdited: row.edit_date ? true : parsed.isEdited,
      };
    } catch { /* fall through to manual mapping */ }
  }

  return {
    id: row.id,
    senderId: row.from_id || '',
    senderName: row.sender_name || '',
    text: row.text || '',
    timestamp: row.date || 0,
    isOutgoing: row.is_outgoing === 1,
    mediaType: row.media_type || undefined,
    replyToId: row.reply_to || undefined,
    isEdited: row.edit_date ? true : false,
  };
}

function rowToDialogInfo(row: any): DialogInfo {
  // Prefer raw JSON for full fidelity
  if (row.raw) {
    try {
      const parsed = JSON.parse(row.raw);
      return {
        ...parsed,
        id: row.id,
        unreadCount: row.unread_count ?? parsed.unreadCount,
        lastMessageTime: row.last_message_time ?? parsed.lastMessageTime,
      };
    } catch { /* fall through */ }
  }

  return {
    id: row.id,
    chatId: row.chat_id || row.id,
    name: row.name || 'Unknown',
    lastMessage: row.last_message || '',
    lastMessageTime: row.last_message_time || 0,
    unreadCount: row.unread_count || 0,
    isForum: row.is_forum === 1,
    groupName: row.group_name || undefined,
    topicName: row.topic_name || undefined,
    topicId: row.topic_id || undefined,
    hasPhoto: row.has_photo === 1,
    type: row.type as DialogInfo['type'],
  };
}
