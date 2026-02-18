import { execSync } from 'child_process';

// --- Types ---

export interface ContextWindow {
  used: number;
  max: number;
  percentage: number;
}

export interface SessionInfo {
  label: string;
  status: string;
  model: string;
  lastActive: string;
}

export interface CronJob {
  id: string;
  name: string;
  schedule: string;
  nextRun: string;
  lastRun: string;
  status: string;
}

export interface PM2Process {
  name: string;
  status: string;
  memory: number;
  cpu: number;
  uptime: number;
  restarts: number;
}

export interface AgentData {
  model: string;
  context: ContextWindow;
  sessions: { total: number; active: number };
  crons: CronJob[];
  pm2: PM2Process[];
  gateway: string;
  channels: { name: string; state: string }[];
}

// --- Parsers (exported for testing) ---

export function parseContextWindow(statusText: string): ContextWindow {
  // Extract from "default claude-opus-4-6 (200k ctx)" pattern
  const ctxMatch = statusText.match(/\((\d+)k ctx\)/i);
  const max = ctxMatch ? parseInt(ctxMatch[1], 10) * 1000 : 200000;

  // Extract sessions count for rough usage estimate
  // Real usage would come from session API; for now use sessions as proxy
  const sessionsMatch = statusText.match(/sessions\s+(\d+)/);
  const sessionCount = sessionsMatch ? parseInt(sessionsMatch[1], 10) : 0;

  // Estimate ~1k tokens per active session as a rough proxy
  // In practice, the current session's token count would come from the API
  const used = Math.min(sessionCount * 1000, max);
  const percentage = Math.round((used / max) * 100);

  return { used, max, percentage };
}

export function parseSessionsInfo(statusText: string): { total: number; active: number; model: string } {
  const sessMatch = statusText.match(/sessions\s+(\d+)/);
  const total = sessMatch ? parseInt(sessMatch[1], 10) : 0;

  const modelMatch = statusText.match(/default\s+([\w-]+)\s+\(/);
  const model = modelMatch ? modelMatch[1] : 'unknown';

  return { total, active: total, model };
}

export function parseGatewayStatus(statusText: string): string {
  const gwMatch = statusText.match(/Gateway\s*│\s*(.*?)│/);
  if (!gwMatch) return 'unknown';
  const text = gwMatch[1].trim();
  if (text.includes('reachable')) return 'connected';
  return 'disconnected';
}

export function parseChannels(statusText: string): { name: string; state: string }[] {
  const channels: { name: string; state: string }[] = [];
  const lines = statusText.split('\n');
  for (const line of lines) {
    const match = line.match(/│\s*(Telegram|WhatsApp|Discord)\s*│\s*(ON|OFF)\s*│\s*([\w]+)/);
    if (match) {
      channels.push({ name: match[1], state: `${match[2]} (${match[3]})` });
    }
  }
  return channels;
}

export function parseCronList(cronText: string): CronJob[] {
  const lines = cronText.trim().split('\n');
  if (lines.length < 2) return [];

  // Parse column positions from header
  const header = lines[0];
  const cols = ['ID', 'Name', 'Schedule', 'Next', 'Last', 'Status'];
  const positions: number[] = [];
  for (const col of cols) {
    const idx = header.indexOf(col);
    if (idx >= 0) positions.push(idx);
  }
  if (positions.length < 6) {
    // Fallback: split by 2+ spaces
    return lines.slice(1).map(line => {
      const parts = line.split(/\s{2,}/);
      if (parts.length < 6) return null;
      return { id: parts[0]?.trim() || '', name: parts[1]?.trim() || '', schedule: parts[2]?.trim() || '', nextRun: parts[3]?.trim() || '', lastRun: parts[4]?.trim() || '', status: parts[5]?.trim() || '' };
    }).filter((c): c is CronJob => c !== null);
  }

  return lines.slice(1).filter(l => l.trim()).map(line => {
    const extract = (i: number) => line.substring(positions[i], positions[i + 1] ?? line.length).trim();
    return {
      id: extract(0),
      name: extract(1),
      schedule: extract(2),
      nextRun: extract(3),
      lastRun: extract(4),
      status: extract(5).split(/\s+/)[0] || '', // status is first word after position
    };
  }).filter(c => c.id.length > 0);
}

export function parsePM2List(jsonStr: string): PM2Process[] {
  try {
    const list = JSON.parse(jsonStr);
    return list.map((proc: any) => ({
      name: proc.name || 'unknown',
      status: proc.pm2_env?.status || 'unknown',
      memory: proc.monit?.memory || 0,
      cpu: proc.monit?.cpu || 0,
      uptime: proc.pm2_env?.pm_uptime || 0,
      restarts: proc.pm2_env?.restart_time || 0,
    }));
  } catch {
    return [];
  }
}

// --- Formatting helpers ---

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
  return `${tokens}`;
}

export function formatRelativeTime(text: string): string {
  // Already relative from openclaw output: "in 35m", "25m ago", "1d ago"
  return text;
}

export function formatUptime(startMs: number): string {
  const now = Date.now();
  const diff = now - startMs;
  if (diff < 0) return 'just started';
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

export function contextBarColor(percentage: number): string {
  if (percentage < 50) return '#4caf50'; // green
  if (percentage < 75) return '#ff9800'; // orange
  if (percentage < 90) return '#f44336'; // red
  return '#d32f2f'; // dark red
}

// --- Data fetching ---

function execCommand(cmd: string): string {
  try {
    return execSync(cmd, { timeout: 10000, encoding: 'utf8' });
  } catch {
    return '';
  }
}

export async function fetchAgentData(): Promise<AgentData> {
  const statusText = execCommand('openclaw status');
  const cronText = execCommand('openclaw cron list');
  const pm2Text = execCommand('pm2 jlist');

  const sessInfo = parseSessionsInfo(statusText);
  const context = parseContextWindow(statusText);

  return {
    model: sessInfo.model,
    context,
    sessions: { total: sessInfo.total, active: sessInfo.active },
    crons: parseCronList(cronText),
    pm2: parsePM2List(pm2Text),
    gateway: parseGatewayStatus(statusText),
    channels: parseChannels(statusText),
  };
}
