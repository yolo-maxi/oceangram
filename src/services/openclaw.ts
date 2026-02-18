import * as fs from 'fs';
import * as path from 'path';

export interface AgentSessionInfo {
  sessionKey: string;
  model: string;
  contextTokens: number;
  totalTokens: number;
  contextPercent: number;
  updatedAt: number;
  agentName: string;
  isActive: boolean;
}

const OPENCLAW_DIR = path.join(process.env.HOME || '/home/xiko', '.openclaw');
const SESSIONS_PATH = path.join(OPENCLAW_DIR, 'agents', 'main', 'sessions', 'sessions.json');
const CONFIG_PATH = path.join(OPENCLAW_DIR, 'openclaw.json');

export class OpenClawService {
  private pollTimers: Map<string, NodeJS.Timeout> = new Map();
  private listeners: Map<string, ((info: AgentSessionInfo | null) => void)[]> = new Map();
  private watcher: fs.FSWatcher | null = null;
  private sessionsCache: Record<string, any> | null = null;
  private lastMtime: number = 0;
  private botUserId: string = '';

  constructor() {
    // Extract bot user ID from config (botToken format: "userId:token")
    try {
      const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      const token = config.channels?.telegram?.botToken || '';
      const parts = token.split(':');
      if (parts.length >= 2) this.botUserId = parts[0];
    } catch { /* ignore */ }
  }

  get isConfigured(): boolean {
    return fs.existsSync(SESSIONS_PATH);
  }

  private loadSessions(): Record<string, any> {
    try {
      const stat = fs.statSync(SESSIONS_PATH);
      if (stat.mtimeMs === this.lastMtime && this.sessionsCache) {
        return this.sessionsCache;
      }
      this.lastMtime = stat.mtimeMs;
      this.sessionsCache = JSON.parse(fs.readFileSync(SESSIONS_PATH, 'utf-8'));
      return this.sessionsCache!;
    } catch {
      return {};
    }
  }

  findSession(chatId: string, topicId?: number): AgentSessionInfo | null {
    const sessions = this.loadSessions();

    // Build patterns to match session keys
    const patterns: string[] = [];
    if (topicId) {
      patterns.push(`telegram:group:${chatId}:topic:${topicId}`);
    }
    patterns.push(`telegram:group:${chatId}:`);
    patterns.push(`telegram:dm:${chatId}`);

    for (const [key, s] of Object.entries(sessions)) {
      let matched = false;

      // Match by session key pattern
      for (const p of patterns) {
        if (key.includes(p)) { matched = true; break; }
      }

      // Also match by lastTo/deliveryContext (covers DMs where IDs are flipped)
      if (!matched) {
        const lastTo = (s.lastTo || s.deliveryContext?.to || '') as string;
        // Direct match
        if (lastTo === `telegram:${chatId}`) {
          matched = true;
        }
        // Bot DM: Oceangram sees bot ID as chatId, OpenClaw sees user ID in lastTo
        // If chatId is the bot, match any DM session (lastTo is a positive user ID)
        if (!matched && this.botUserId && chatId === this.botUserId && lastTo.startsWith('telegram:') && !lastTo.includes('-')) {
          matched = true;
        }
      }

      if (matched) {
        const totalTokens = s.totalTokens || 0;
        const contextTokens = s.contextTokens || 200000;
        return {
          sessionKey: key,
          model: s.model || 'unknown',
          contextTokens,
          totalTokens,
          contextPercent: Math.round((totalTokens / contextTokens) * 100),
          updatedAt: s.updatedAt || 0,
          agentName: key.split(':')[1] || 'main',
          isActive: (Date.now() - (s.updatedAt || 0)) < 300000,
        };
      }
    }
    return null;
  }

  startPolling(chatId: string, topicId: number | undefined, listener: (info: AgentSessionInfo | null) => void): void {
    const key = topicId ? `${chatId}:${topicId}` : chatId;

    if (!this.listeners.has(key)) this.listeners.set(key, []);
    this.listeners.get(key)!.push(listener);

    if (this.pollTimers.has(key)) return;

    const poll = () => {
      const info = this.findSession(chatId, topicId);
      const cbs = this.listeners.get(key) || [];
      for (const cb of cbs) cb(info);
    };

    poll();

    // Watch the sessions file for changes (instant updates)
    if (!this.watcher) {
      try {
        this.watcher = fs.watch(SESSIONS_PATH, () => {
          this.sessionsCache = null; // invalidate cache
          // Notify all listeners
          for (const [k, cbs] of this.listeners) {
            const parts = k.split(':');
            const cId = parts[0];
            const tId = parts.length > 1 ? parseInt(parts[1], 10) : undefined;
            const info = this.findSession(cId, tId);
            for (const cb of cbs) cb(info);
          }
        });
      } catch {
        // Fallback to interval polling if watch fails
      }
    }

    // Also poll every 15s as fallback (fs.watch can miss events)
    const timer = setInterval(poll, 15000);
    this.pollTimers.set(key, timer);
  }

  stopPolling(chatId: string, topicId?: number): void {
    const key = topicId ? `${chatId}:${topicId}` : chatId;
    const timer = this.pollTimers.get(key);
    if (timer) clearInterval(timer);
    this.pollTimers.delete(key);
    this.listeners.delete(key);
  }

  stopAll(): void {
    for (const timer of this.pollTimers.values()) clearInterval(timer);
    this.pollTimers.clear();
    this.listeners.clear();
    if (this.watcher) { this.watcher.close(); this.watcher = null; }
  }
}
