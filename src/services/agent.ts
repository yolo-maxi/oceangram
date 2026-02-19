import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// --- Types ---

export interface SessionEntry {
  key: string;
  model: string | null;
  updatedAt: number;
  contextTokens: number | null;
  totalTokens: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface AgentPanelData {
  sessions: SessionEntry[];
  totalSessions: number;
  activeSessions: number;   // updated < 5min ago
  defaultModel: string;
  updatedAtMs: number;
}

// --- Paths ---

const SESSIONS_PATH = path.join(os.homedir(), '.openclaw/agents/main/sessions/sessions.json');
const CONFIG_PATH = path.join(os.homedir(), '.openclaw/openclaw.json');

export function getSessionsPath(): string {
  return SESSIONS_PATH;
}

// --- Data fetching ---

export function fetchAgentPanelData(): AgentPanelData {
  const now = Date.now();
  const fiveMinAgo = now - 5 * 60 * 1000;

  // Read sessions
  let sessions: SessionEntry[] = [];
  try {
    const raw = JSON.parse(fs.readFileSync(SESSIONS_PATH, 'utf8'));
    sessions = Object.entries(raw).map(([key, val]: [string, any]) => ({
      key,
      model: val.model || null,
      updatedAt: val.updatedAt || 0,
      contextTokens: val.contextTokens || null,
      totalTokens: val.totalTokens || null,
      inputTokens: val.inputTokens || null,
      outputTokens: val.outputTokens || null,
    }));
    sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  } catch { /* empty */ }

  // Read default model from config
  let defaultModel = 'unknown';
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    defaultModel = config?.agents?.defaults?.model?.primary || 'unknown';
  } catch { /* empty */ }

  const activeSessions = sessions.filter(s => s.updatedAt > fiveMinAgo).length;

  return {
    sessions,
    totalSessions: sessions.length,
    activeSessions,
    defaultModel,
    updatedAtMs: now,
  };
}

// --- Formatting helpers ---

export function formatTokens(tokens: number): string {
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
  return `${tokens}`;
}

export function contextBarColor(percentage: number): string {
  if (percentage < 60) return '#6ab2f2';  // blue
  if (percentage < 80) return '#e5c07b';  // yellow
  return '#e06c75';                        // red
}

export function formatRelativeTime(timestampMs: number): string {
  const diff = Date.now() - timestampMs;
  if (diff < 0) return 'just now';
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function truncateKey(key: string, maxLen = 40): string {
  if (key.length <= maxLen) return key;
  return key.substring(0, maxLen - 3) + '...';
}

// Keep old exports for backward compat (used by existing panel)
export interface ContextWindow { used: number; max: number; percentage: number; }
export interface CronJob { id: string; name: string; schedule: string; nextRun: string; lastRun: string; status: string; }
export interface PM2Process { name: string; status: string; memory: number; cpu: number; uptime: number; restarts: number; }
export interface AgentData {
  model: string; context: ContextWindow; sessions: { total: number; active: number };
  crons: CronJob[]; pm2: PM2Process[]; gateway: string; channels: { name: string; state: string }[];
}
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
export function formatUptime(startMs: number): string {
  const diff = Date.now() - startMs;
  if (diff < 0) return 'just started';
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}
export async function fetchAgentData(): Promise<AgentData> {
  const data = fetchAgentPanelData();
  return {
    model: data.defaultModel,
    context: { used: 0, max: 200000, percentage: 0 },
    sessions: { total: data.totalSessions, active: data.activeSessions },
    crons: [], pm2: [], gateway: 'unknown', channels: [],
  };
}
