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
  label: string | null;
  chatType: string | null;
  channel: string | null;
  lastTo: string | null;
  origin: any | null;
}

export interface SessionGroup {
  parent: SessionEntry;
  children: SessionEntry[]; // sub-agents spawned from this context
}

export interface AgentPanelData {
  groups: SessionGroup[];
  totalSessions: number;
  activeSessions: number;
  defaultModel: string;
  updatedAtMs: number;
  totalCostEstimate: number; // rough USD estimate
}

// --- Paths ---

const SESSIONS_PATH = path.join(os.homedir(), '.openclaw/agents/main/sessions/sessions.json');
const CONFIG_PATH = path.join(os.homedir(), '.openclaw/openclaw.json');

export function getSessionsPath(): string {
  return SESSIONS_PATH;
}

// --- Friendly name resolution ---

export function friendlySessionName(s: SessionEntry): string {
  // Use label if available (cron jobs, sub-agents with labels)
  if (s.label) {
    // Clean up cron labels
    if (s.label.startsWith('Cron: ')) return `⏰ ${s.label.slice(6)}`;
    return s.label;
  }

  const key = s.key;

  // Main session
  if (key === 'agent:main:main') return '🏠 Main Session';

  // Telegram group with topic
  const groupTopicMatch = key.match(/telegram:group:(-?\d+):topic:(\d+)/);
  if (groupTopicMatch) {
    const groupId = groupTopicMatch[1];
    const topicId = groupTopicMatch[2];
    // Try to get origin label
    const originLabel = s.origin?.label;
    if (originLabel) {
      // Extract group name from label like "Arbeit Macht Frei 🪸 id:-xxx topic:8547"
      const nameMatch = originLabel.match(/^(.+?)\s+id:/);
      if (nameMatch) return `💬 ${nameMatch[1]} #${topicId}`;
      return `💬 ${originLabel}`;
    }
    return `💬 Group ${groupId} #${topicId}`;
  }

  // Telegram DM
  const dmMatch = key.match(/telegram:dm:(-?\d+)/);
  if (dmMatch) {
    const originLabel = s.origin?.label;
    if (originLabel) return `👤 ${originLabel}`;
    return `👤 DM ${dmMatch[1]}`;
  }

  // Cron session
  const cronMatch = key.match(/cron:(.+)/);
  if (cronMatch) return `⏰ ${cronMatch[1].slice(0, 20)}`;

  // Sub-agent
  const subMatch = key.match(/subagent:(.+)/);
  if (subMatch) return `🔄 Sub-agent`;

  // Fallback: trim prefix
  return key.replace(/^agent:main:/, '');
}

// --- Cost estimation ---

// Rough pricing per 1M tokens (USD) - Opus 4
const PRICING: Record<string, { input: number; output: number; cacheRead: number }> = {
  'claude-opus-4-6': { input: 15, output: 75, cacheRead: 1.5 },
  'claude-opus-4-5': { input: 15, output: 75, cacheRead: 1.5 },
  'claude-sonnet-4-20250514': { input: 3, output: 15, cacheRead: 0.3 },
  'default': { input: 15, output: 75, cacheRead: 1.5 },
};

export function estimateCost(s: SessionEntry): number {
  const model = s.model || 'default';
  const pricing = PRICING[model] || PRICING['default'];
  const input = (s.inputTokens || 0) / 1_000_000;
  const output = (s.outputTokens || 0) / 1_000_000;
  // Rough: assume 80% of input was cache reads
  const cacheReads = input * 0.8;
  const freshInput = input * 0.2;
  return freshInput * pricing.input + output * pricing.output + cacheReads * pricing.cacheRead;
}

// --- Data fetching ---

export function fetchAgentPanelData(): AgentPanelData {
  const now = Date.now();
  const fiveMinAgo = now - 5 * 60 * 1000;

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
      label: val.label || null,
      chatType: val.chatType || null,
      channel: val.channel || null,
      lastTo: val.lastTo || null,
      origin: val.origin || null,
    }));
    sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  } catch { /* empty */ }

  let defaultModel = 'unknown';
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    defaultModel = config?.agents?.defaults?.model?.primary || 'unknown';
  } catch { /* empty */ }

  const activeSessions = sessions.filter(s => s.updatedAt > fiveMinAgo).length;

  // Group: sub-agents under their parent (heuristic: recent sub-agents near cron/main sessions)
  const subAgents = sessions.filter(s => s.key.includes(':subagent:'));
  const nonSubAgents = sessions.filter(s => !s.key.includes(':subagent:'));

  const groups: SessionGroup[] = nonSubAgents.map(parent => ({
    parent,
    children: [] as SessionEntry[],
  }));

  // Assign sub-agents to the most recently active non-sub session
  // (rough heuristic — OpenClaw doesn't store parent ID)
  for (const sub of subAgents) {
    // Find the closest active parent by time
    let bestGroup = groups[0]; // fallback to most recent
    let bestDiff = Infinity;
    for (const g of groups) {
      const diff = Math.abs(g.parent.updatedAt - sub.updatedAt);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestGroup = g;
      }
    }
    if (bestGroup) {
      bestGroup.children.push(sub);
    }
  }

  // Calculate total cost
  const totalCostEstimate = sessions.reduce((sum, s) => sum + estimateCost(s), 0);

  return {
    groups,
    totalSessions: sessions.length,
    activeSessions,
    defaultModel,
    updatedAtMs: now,
    totalCostEstimate,
  };
}

// --- Formatting helpers ---

export function formatTokens(tokens: number): string {
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
  return `${tokens}`;
}

export function contextBarColor(percentage: number): string {
  if (percentage < 60) return '#6ab2f2';
  if (percentage < 80) return '#e5c07b';
  return '#e06c75';
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

export function formatCost(usd: number): string {
  if (usd < 0.01) return '<$0.01';
  if (usd < 1) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(2)}`;
}

export function truncateKey(key: string, maxLen = 40): string {
  if (key.length <= maxLen) return key;
  return key.substring(0, maxLen - 3) + '...';
}

// Legacy exports for backward compat
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
