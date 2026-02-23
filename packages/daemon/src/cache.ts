import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import * as path from 'path';
import * as fs from 'fs';
import type { DialogInfo, MessageInfo } from './telegram';

const DEFAULT_DB_DIR = path.join(process.env.HOME || '/root', '.oceangram');
const DEFAULT_DB_PATH = path.join(DEFAULT_DB_DIR, 'cache.db');

export class Cache {
  private db: SqlJsDatabase | null = null;
  private dbPath: string;
  private dirty = false;
  private saveTimer: ReturnType<typeof setInterval> | null = null;

  constructor(dbPath: string = DEFAULT_DB_PATH) {
    this.dbPath = dbPath;
  }

  async init(): Promise<void> {
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    // Locate WASM file — next to the bundle in production, or in node_modules in dev
    let wasmPath: string | undefined;
    const bundleDir = path.dirname(process.argv[1] || __dirname);
    const candidates = [
      path.join(bundleDir, 'sql-wasm.wasm'),
      path.join(bundleDir, '..', 'resources', 'sql-wasm.wasm'),
      path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) { wasmPath = c; break; }
    }

    const initOpts: any = {};
    if (wasmPath) {
      initOpts.locateFile = () => wasmPath;
    }
    const SQL = await initSqlJs(initOpts);

    if (fs.existsSync(this.dbPath)) {
      const buffer = fs.readFileSync(this.dbPath);
      this.db = new SQL.Database(buffer);
    } else {
      this.db = new SQL.Database();
    }

    // Performance pragmas
    this.db.run('PRAGMA journal_mode = WAL');
    this.db.run('PRAGMA synchronous = NORMAL');

    this.createSchema();

    // Auto-save every 10s if dirty
    this.saveTimer = setInterval(() => this.saveToDisk(), 10_000);
  }

  private createSchema(): void {
    this.db!.run(`
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
      )
    `);
    this.db!.run('CREATE INDEX IF NOT EXISTS idx_messages_dialog ON messages(dialog_id, date DESC)');

    this.db!.run(`
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
      )
    `);
    this.db!.run('CREATE INDEX IF NOT EXISTS idx_dialogs_date ON dialogs(last_message_time DESC)');

    this.db!.run(`
      CREATE TABLE IF NOT EXISTS profile_photos (
        user_id TEXT PRIMARY KEY,
        data BLOB,
        mime_type TEXT DEFAULT 'image/jpeg',
        updated_at INTEGER
      )
    `);
  }

  private saveToDisk(): void {
    if (!this.dirty || !this.db) return;
    try {
      const data = this.db.export();
      fs.writeFileSync(this.dbPath, Buffer.from(data));
      this.dirty = false;
    } catch (e) {
      console.error('[cache] Failed to save:', e);
    }
  }

  // ─── Messages ──────────────────────────────────────────────────────────

  getMessages(dialogId: string, limit: number, offsetId?: number): MessageInfo[] {
    if (!this.db) return [];
    try {
      let stmt;
      if (offsetId) {
        stmt = this.db.prepare(`
          SELECT * FROM messages WHERE dialog_id = ? AND id < ? ORDER BY date DESC LIMIT ?
        `);
        stmt.bind([dialogId, offsetId, limit]);
      } else {
        stmt = this.db.prepare(`
          SELECT * FROM messages WHERE dialog_id = ? ORDER BY date DESC LIMIT ?
        `);
        stmt.bind([dialogId, limit]);
      }

      const rows: any[] = [];
      while (stmt.step()) {
        rows.push(stmt.getAsObject());
      }
      stmt.free();
      return rows.map(rowToMessageInfo).reverse();
    } catch {
      return [];
    }
  }

  getMessageCount(dialogId: string): number {
    if (!this.db) return 0;
    try {
      const stmt = this.db.prepare('SELECT COUNT(*) as cnt FROM messages WHERE dialog_id = ?');
      stmt.bind([dialogId]);
      if (stmt.step()) {
        const row = stmt.getAsObject() as any;
        stmt.free();
        return row.cnt || 0;
      }
      stmt.free();
      return 0;
    } catch {
      return 0;
    }
  }

  upsertMessages(dialogId: string, messages: MessageInfo[]): void {
    if (!this.db || messages.length === 0) return;
    try {
      this.db.run('BEGIN TRANSACTION');
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO messages (
          id, dialog_id, from_id, sender_name, text, date, edit_date,
          reply_to, media_type, is_outgoing, raw
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const m of messages) {
        stmt.run([
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
        ]);
      }

      stmt.free();
      this.db.run('COMMIT');
      this.dirty = true;
    } catch (e) {
      try { this.db.run('ROLLBACK'); } catch { /* ignore */ }
      console.error('[cache] upsertMessages error:', e);
    }
  }

  deleteMessage(dialogId: string, messageId: number): void {
    if (!this.db) return;
    try {
      this.db.run('DELETE FROM messages WHERE dialog_id = ? AND id = ?', [dialogId, messageId]);
      this.dirty = true;
    } catch { /* ignore */ }
  }

  // ─── Dialogs ───────────────────────────────────────────────────────────

  getDialogs(limit: number): DialogInfo[] {
    if (!this.db) return [];
    try {
      const stmt = this.db.prepare('SELECT * FROM dialogs ORDER BY last_message_time DESC LIMIT ?');
      stmt.bind([limit]);

      const rows: any[] = [];
      while (stmt.step()) {
        rows.push(stmt.getAsObject());
      }
      stmt.free();
      return rows.map(rowToDialogInfo);
    } catch {
      return [];
    }
  }

  getDialogCount(): number {
    if (!this.db) return 0;
    try {
      const stmt = this.db.prepare('SELECT COUNT(*) as cnt FROM dialogs');
      if (stmt.step()) {
        const row = stmt.getAsObject() as any;
        stmt.free();
        return row.cnt || 0;
      }
      stmt.free();
      return 0;
    } catch {
      return 0;
    }
  }

  upsertDialogs(dialogs: DialogInfo[]): void {
    if (!this.db || dialogs.length === 0) return;
    try {
      this.db.run('BEGIN TRANSACTION');
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO dialogs (
          id, chat_id, topic_id, name, type, last_message, last_message_time,
          unread_count, is_forum, group_name, topic_name, has_photo, raw, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const d of dialogs) {
        stmt.run([
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
        ]);
      }

      stmt.free();
      this.db.run('COMMIT');
      this.dirty = true;
    } catch (e) {
      try { this.db.run('ROLLBACK'); } catch { /* ignore */ }
      console.error('[cache] upsertDialogs error:', e);
    }
  }

  // ─── Profile Photos ────────────────────────────────────────────────────

  getProfilePhoto(userId: string): { data: Buffer; mimeType: string } | null {
    if (!this.db) return null;
    try {
      const stmt = this.db.prepare('SELECT data, mime_type FROM profile_photos WHERE user_id = ?');
      stmt.bind([userId]);
      if (stmt.step()) {
        const row = stmt.getAsObject() as any;
        stmt.free();
        if (!row.data) return null;
        return { data: Buffer.from(row.data), mimeType: row.mime_type || 'image/jpeg' };
      }
      stmt.free();
      return null;
    } catch {
      return null;
    }
  }

  setProfilePhoto(userId: string, data: Buffer, mimeType: string): void {
    if (!this.db) return;
    try {
      this.db.run(
        'INSERT OR REPLACE INTO profile_photos (user_id, data, mime_type, updated_at) VALUES (?, ?, ?, ?)',
        [userId, data, mimeType, Math.floor(Date.now() / 1000)]
      );
      this.dirty = true;
    } catch { /* ignore */ }
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────

  close(): void {
    if (this.saveTimer) clearInterval(this.saveTimer);
    this.saveToDisk();
    if (this.db) this.db.close();
  }
}

// ─── Row → Interface mappers ───────────────────────────────────────────────

function rowToMessageInfo(row: any): MessageInfo {
  if (row.raw) {
    try {
      const parsed = JSON.parse(row.raw);
      return {
        ...parsed,
        id: row.id,
        text: row.text ?? parsed.text,
        isEdited: row.edit_date ? true : parsed.isEdited,
      };
    } catch { /* fall through */ }
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
