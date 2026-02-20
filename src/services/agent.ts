import * as path from 'path';
import * as vscode from 'vscode';
import { readRemoteFile, readRemoteDir, remoteFileExists, remoteFileStat, getOpenclawDir, getMemoryDir } from './remoteFs';
import type { OpenClawGatewayClient } from './openclawGateway';

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
  sessionId: string | null;
  // Sub-agent specific
  taskSummary?: string;
  status?: 'running' | 'completed' | 'failed';
  startedAt?: number;
}

export interface SessionGroup {
  parent: SessionEntry;
  children: SessionEntry[]; // sub-agents spawned from this context
}

export interface ToolInfo {
  name: string;
  enabled: boolean;
  lastUsedAt?: number;
  usageCount?: number;
}

export interface CronJobInfo {
  id: string;
  name: string;
  enabled: boolean;
  schedule: string;
  scheduleDisplay: string;
  lastRunAt: number | null;
  nextRunAt: number | null;
  lastStatus: 'ok' | 'error' | null;
  lastDurationMs: number | null;
  consecutiveErrors: number;
  delivery?: { mode: string; channel?: string; to?: string };
  lastOutput?: string;
}

export interface SubAgentInfo {
  id: string;
  label: string;
  status: 'running' | 'completed' | 'idle';
  startedAt: number;
  durationMs: number;
  model: string;
  taskSummary: string;
  contextUsedPct: number;
  sessionId: string;
}

export interface CostBreakdown {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

export interface SessionCostEntry {
  name: string;
  model: string;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  updatedAt: number;
}

export interface SessionCosts {
  currentSession: number;
  dailyTotal: number;
  weeklyTotal: number;
  breakdown: CostBreakdown[];
  sessionCosts: SessionCostEntry[];
}

export interface MemoryFile {
  name: string;
  path: string;
  size: number;
  modifiedAt: number;
  isDirectory: boolean;
  children?: MemoryFile[];
}

export interface AgentConfig {
  model: string;
  thinkingLevel: string;
  reasoningMode: string;
  availableModels: string[];
}

export interface AgentPanelData {
  groups: SessionGroup[];
  totalSessions: number;
  activeSessions: number;
  defaultModel: string;
  updatedAtMs: number;
  totalCostEstimate: number;
  // New fields for TASK-115 to TASK-120
  config: AgentConfig;
  tools: ToolInfo[];
  subAgents: SubAgentInfo[];
  cronJobs: CronJobInfo[];
  costs: SessionCosts;
  memoryFiles: MemoryFile[];
}

// --- Paths ---

function getSessionsPath(): string {
  return path.join(getOpenclawDir(), 'agents', 'main', 'sessions', 'sessions.json');
}

function getConfigPath(): string {
  return path.join(getOpenclawDir(), 'openclaw.json');
}

export { getSessionsPath };

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
    const topicId = groupTopicMatch[2];
    const originLabel = s.origin?.label;
    if (originLabel) {
      const nameMatch = originLabel.match(/^(.+?)\s+id:/);
      if (nameMatch) return `💬 ${nameMatch[1]} #${topicId}`;
      return `💬 ${originLabel}`;
    }
    return `💬 Group #${topicId}`;
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
  const cacheReads = input * 0.8;
  const freshInput = input * 0.2;
  return freshInput * pricing.input + output * pricing.output + cacheReads * pricing.cacheRead;
}

// --- Get tools from system prompt report ---

async function getToolsFromConfig(): Promise<ToolInfo[]> {
  const defaultTools: ToolInfo[] = [
    { name: 'read', enabled: true },
    { name: 'write', enabled: true },
    { name: 'edit', enabled: true },
    { name: 'exec', enabled: true },
    { name: 'process', enabled: true },
    { name: 'browser', enabled: true },
    { name: 'canvas', enabled: true },
    { name: 'nodes', enabled: true },
    { name: 'cron', enabled: true },
    { name: 'message', enabled: true },
    { name: 'tts', enabled: true },
    { name: 'gateway', enabled: true },
    { name: 'agents_list', enabled: true },
    { name: 'sessions_list', enabled: true },
    { name: 'sessions_history', enabled: true },
    { name: 'sessions_send', enabled: true },
    { name: 'sessions_spawn', enabled: true },
    { name: 'session_status', enabled: true },
    { name: 'web_search', enabled: true },
    { name: 'web_fetch', enabled: true },
    { name: 'image', enabled: true },
    { name: 'memory_search', enabled: true },
    { name: 'memory_get', enabled: true },
  ];

  try {
    const sessionsDir = path.dirname(getSessionsPath());
    const entries = await readRemoteDir(sessionsDir);
    const jsonlFiles = entries
      .filter(([name, type]) => name.endsWith('.jsonl') && type === vscode.FileType.File)
      .map(([name]) => name)
      .slice(0, 5);

    const toolUsage: Record<string, number> = {};
    for (const file of jsonlFiles) {
      try {
        const content = await readRemoteFile(path.join(sessionsDir, file));
        const lines = content.split('\n').filter(l => l.trim());
        for (const line of lines.slice(-50)) {
          try {
            const entry = JSON.parse(line);
            if (entry.role === 'assistant' && entry.tool_calls) {
              for (const tc of entry.tool_calls) {
                const name = tc.function?.name || tc.name;
                if (name) toolUsage[name] = Date.now();
              }
            }
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
    }

    for (const tool of defaultTools) {
      if (toolUsage[tool.name]) tool.lastUsedAt = toolUsage[tool.name];
    }
  } catch { /* ignore */ }

  return defaultTools;
}

// --- Get cron jobs ---
// Note: getCronJobs uses HTTP to the OpenClaw gateway since execSync won't work
// on the remote from a UI extension. Falls back to reading cron state file.

async function getCronJobs(): Promise<CronJobInfo[]> {
  try {
    const gatewayPort = vscode.workspace.getConfiguration('oceangram').get<number>('gatewayPort', 4380);
    const resp = await fetch(`http://localhost:${gatewayPort}/api/cron/list`);
    if (!resp.ok) return [];
    const data = await resp.json() as any;

    return (data.jobs || []).map((job: any) => {
      let scheduleDisplay = '';
      if (job.schedule?.kind === 'cron') {
        scheduleDisplay = job.schedule.expr;
      } else if (job.schedule?.kind === 'every') {
        const ms = job.schedule.everyMs;
        if (ms >= 3600000) scheduleDisplay = `Every ${Math.round(ms / 3600000)}h`;
        else if (ms >= 60000) scheduleDisplay = `Every ${Math.round(ms / 60000)}m`;
        else scheduleDisplay = `Every ${Math.round(ms / 1000)}s`;
      }

      return {
        id: job.id,
        name: job.name || 'Unnamed',
        enabled: job.enabled,
        schedule: job.schedule?.expr || `${job.schedule?.everyMs}ms`,
        scheduleDisplay,
        lastRunAt: job.state?.lastRunAtMs || null,
        nextRunAt: job.state?.nextRunAtMs || null,
        lastStatus: job.state?.lastStatus || null,
        lastDurationMs: job.state?.lastDurationMs || null,
        consecutiveErrors: job.state?.consecutiveErrors || 0,
        delivery: job.delivery,
      };
    });
  } catch {
    return [];
  }
}

// --- Get sub-agents ---

function getSubAgents(sessions: SessionEntry[]): SubAgentInfo[] {
  const fiveMinAgo = Date.now() - 5 * 60 * 1000;
  
  return sessions
    .filter(s => s.key.includes(':subagent:'))
    .map(s => {
      const idMatch = s.key.match(/:subagent:([a-f0-9-]+)/);
      const id = idMatch ? idMatch[1] : s.key;
      
      const isActive = s.updatedAt > fiveMinAgo;
      const status = isActive ? 'running' : 'completed';
      
      const contextUsedPct = s.contextTokens && s.totalTokens
        ? Math.round((s.totalTokens / s.contextTokens) * 100)
        : 0;

      return {
        id,
        label: s.label || `Sub-agent ${id.slice(0, 8)}`,
        status,
        startedAt: s.updatedAt - (60 * 60 * 1000), // Approximate
        durationMs: Date.now() - (s.updatedAt - (60 * 60 * 1000)),
        model: (s.model || 'default').replace(/^anthropic\//, ''),
        taskSummary: s.label || 'Working on task...',
        contextUsedPct,
        sessionId: s.sessionId || id,
      };
    })
    .slice(0, 20); // Limit to 20 most recent
}

// --- Get memory files ---

async function getMemoryFiles(dir?: string, depth: number = 0): Promise<MemoryFile[]> {
  if (depth > 2) return [];
  const memDir = dir || getMemoryDir();

  try {
    const entries = await readRemoteDir(memDir);
    const results: MemoryFile[] = [];

    for (const [name, type] of entries) {
      if (name.startsWith('.')) continue;
      const fullPath = path.join(memDir, name);
      const stat = await remoteFileStat(fullPath);
      const isDir = type === vscode.FileType.Directory;

      const file: MemoryFile = {
        name,
        path: fullPath,
        size: stat?.size || 0,
        modifiedAt: stat?.mtime || 0,
        isDirectory: isDir,
      };

      if (isDir && depth < 2) {
        file.children = await getMemoryFiles(fullPath, depth + 1);
      }

      results.push(file);
    }

    return results.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return b.modifiedAt - a.modifiedAt;
    });
  } catch {
    return [];
  }
}

// --- Get session costs ---

function getSessionCosts(sessions: SessionEntry[]): SessionCosts {
  const now = Date.now();
  const todayStart = new Date().setHours(0, 0, 0, 0);
  const weekStart = todayStart - 6 * 24 * 60 * 60 * 1000;
  
  // Current session (most recent)
  const currentSession = sessions[0] ? estimateCost(sessions[0]) : 0;
  
  // Daily total (sessions updated today)
  const todaySessions = sessions.filter(s => s.updatedAt >= todayStart);
  const dailyTotal = todaySessions.reduce((sum, s) => sum + estimateCost(s), 0);
  
  // Weekly total (last 7 days)
  const weekSessions = sessions.filter(s => s.updatedAt >= weekStart);
  const weeklyTotal = weekSessions.reduce((sum, s) => sum + estimateCost(s), 0);
  
  // Breakdown by model (today)
  const modelCosts: Record<string, { input: number; output: number; cost: number }> = {};
  
  for (const s of todaySessions) {
    const model = (s.model || 'default').replace(/^anthropic\//, '');
    if (!modelCosts[model]) {
      modelCosts[model] = { input: 0, output: 0, cost: 0 };
    }
    modelCosts[model].input += s.inputTokens || 0;
    modelCosts[model].output += s.outputTokens || 0;
    modelCosts[model].cost += estimateCost(s);
  }
  
  const breakdown: CostBreakdown[] = Object.entries(modelCosts).map(([model, data]) => ({
    model,
    inputTokens: data.input,
    outputTokens: data.output,
    cost: data.cost,
  }));
  
  // Per-session cost list (today, sorted by cost desc)
  const sessionCosts: SessionCostEntry[] = todaySessions.map(s => ({
    name: friendlySessionName(s),
    model: (s.model || 'default').replace(/^anthropic\//, ''),
    cost: estimateCost(s),
    inputTokens: s.inputTokens || 0,
    outputTokens: s.outputTokens || 0,
    updatedAt: s.updatedAt,
  })).sort((a, b) => b.cost - a.cost);
  
  return { currentSession, dailyTotal, weeklyTotal, breakdown, sessionCosts };
}

// --- Get agent config ---

async function getAgentConfig(): Promise<AgentConfig> {
  let model = 'unknown';
  let thinkingLevel = 'default';
  let reasoningMode = 'off';
  const availableModels = [
    'claude-opus-4-6',
    'claude-opus-4-5',
    'claude-sonnet-4-20250514',
  ];

  try {
    const config = JSON.parse(await readRemoteFile(getConfigPath()));
    model = config?.agents?.defaults?.model?.primary?.replace(/^anthropic\//, '') || 'unknown';
    thinkingLevel = config?.agents?.defaults?.thinking?.level || 'default';
    reasoningMode = config?.agents?.defaults?.reasoning?.mode || 'off';
  } catch { /* ignore */ }

  return { model, thinkingLevel, reasoningMode, availableModels };
}

// --- Data fetching ---

export async function fetchAgentPanelData(): Promise<AgentPanelData> {
  const now = Date.now();
  const fiveMinAgo = now - 5 * 60 * 1000;

  let sessions: SessionEntry[] = [];
  try {
    const raw = JSON.parse(await readRemoteFile(getSessionsPath()));
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
      sessionId: val.sessionId || null,
    }));
    sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  } catch { /* empty */ }

  let defaultModel = 'unknown';
  try {
    const config = JSON.parse(await readRemoteFile(getConfigPath()));
    defaultModel = config?.agents?.defaults?.model?.primary || 'unknown';
  } catch { /* empty */ }

  const activeSessions = sessions.filter(s => s.updatedAt > fiveMinAgo).length;

  // Group: sub-agents under their parent
  const subAgents = sessions.filter(s => s.key.includes(':subagent:'));
  const nonSubAgents = sessions.filter(s => !s.key.includes(':subagent:'));

  const groups: SessionGroup[] = nonSubAgents.map(parent => ({
    parent,
    children: [] as SessionEntry[],
  }));

  // Assign sub-agents to the most recently active non-sub session
  for (const sub of subAgents) {
    let bestGroup = groups[0];
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

  const totalCostEstimate = sessions.reduce((sum, s) => sum + estimateCost(s), 0);

  return {
    groups,
    totalSessions: sessions.length,
    activeSessions,
    defaultModel,
    updatedAtMs: now,
    totalCostEstimate,
    // New data for TASK-115 to TASK-120
    config: await getAgentConfig(),
    tools: await getToolsFromConfig(),
    subAgents: getSubAgents(sessions),
    cronJobs: await getCronJobs(),
    costs: getSessionCosts(sessions),
    memoryFiles: await getMemoryFiles(),
  };
}

/**
 * Fetch agent panel data via the OpenClaw Gateway WS client.
 * Falls back to file-based reads if gateway is not connected.
 */
export async function fetchAgentPanelDataViaGateway(gw: OpenClawGatewayClient): Promise<AgentPanelData> {
  const now = Date.now();
  const fiveMinAgo = now - 5 * 60 * 1000;

  // Fetch sessions + config + crons in parallel
  const [sessionsResult, configResult, cronResult, statusResult] = await Promise.allSettled([
    gw.listSessions({ includeGlobal: true }),
    gw.getConfig(),
    gw.listCronJobs({ includeDisabled: true }),
    gw.getStatus(),
  ]);

  // Parse sessions
  let sessions: SessionEntry[] = [];
  if (sessionsResult.status === 'fulfilled' && sessionsResult.value?.sessions) {
    sessions = sessionsResult.value.sessions.map((s: any) => ({
      key: s.key,
      model: s.model || null,
      updatedAt: s.updatedAt || 0,
      contextTokens: s.contextTokens || null,
      totalTokens: s.totalTokens || null,
      inputTokens: s.inputTokens || null,
      outputTokens: s.outputTokens || null,
      label: s.label || null,
      chatType: s.chatType || null,
      channel: s.channel || null,
      lastTo: s.lastTo || null,
      origin: s.origin || null,
      sessionId: s.sessionId || null,
      taskSummary: s.taskSummary,
      status: s.status,
      startedAt: s.startedAt,
    }));
    sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  // Parse config
  let defaultModel = 'unknown';
  if (configResult.status === 'fulfilled') {
    const config = configResult.value;
    defaultModel = config?.agents?.defaults?.model?.primary || config?.model || 'unknown';
  }

  // Parse crons
  let cronJobs: CronJobInfo[] = [];
  if (cronResult.status === 'fulfilled' && cronResult.value?.jobs) {
    cronJobs = cronResult.value.jobs.map((job: any) => {
      let scheduleDisplay = '';
      if (job.schedule?.kind === 'cron') {
        scheduleDisplay = job.schedule.expr;
      } else if (job.schedule?.kind === 'every') {
        const ms = job.schedule.everyMs;
        if (ms >= 3600000) scheduleDisplay = `Every ${Math.round(ms / 3600000)}h`;
        else if (ms >= 60000) scheduleDisplay = `Every ${Math.round(ms / 60000)}m`;
        else scheduleDisplay = `Every ${Math.round(ms / 1000)}s`;
      }
      return {
        id: job.id,
        name: job.name || 'Unnamed',
        enabled: job.enabled !== false,
        schedule: job.schedule?.expr || `${job.schedule?.everyMs}ms`,
        scheduleDisplay,
        lastRunAt: job.state?.lastRunAtMs || null,
        nextRunAt: job.state?.nextRunAtMs || null,
        lastStatus: job.state?.lastStatus || null,
        lastDurationMs: job.state?.lastDurationMs || null,
        consecutiveErrors: job.state?.consecutiveErrors || 0,
        delivery: job.delivery,
      };
    });
  }

  const activeSessions = sessions.filter(s => s.updatedAt > fiveMinAgo).length;

  // Group: sub-agents under their parent
  const subAgents = sessions.filter(s => s.key.includes(':subagent:'));
  const nonSubAgents = sessions.filter(s => !s.key.includes(':subagent:'));
  const groups: SessionGroup[] = nonSubAgents.map(parent => ({
    parent,
    children: [] as SessionEntry[],
  }));
  for (const sub of subAgents) {
    let bestGroup = groups[0];
    let bestDiff = Infinity;
    for (const g of groups) {
      const diff = Math.abs(g.parent.updatedAt - sub.updatedAt);
      if (diff < bestDiff) { bestDiff = diff; bestGroup = g; }
    }
    if (bestGroup) bestGroup.children.push(sub);
  }

  const totalCostEstimate = sessions.reduce((sum, s) => sum + estimateCost(s), 0);

  return {
    groups,
    totalSessions: sessions.length,
    activeSessions,
    defaultModel,
    updatedAtMs: now,
    totalCostEstimate,
    config: await getAgentConfig(),
    tools: await getToolsFromConfig(),
    subAgents: getSubAgents(sessions),
    cronJobs,
    costs: getSessionCosts(sessions),
    memoryFiles: await getMemoryFiles(),
  };
}

/**
 * Toggle a cron job via the Gateway WS client.
 */
export async function toggleCronJobViaGateway(gw: OpenClawGatewayClient, jobId: string, enable: boolean): Promise<boolean> {
  try {
    await gw.updateCronJob(jobId, { enabled: enable });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run a cron job immediately via the Gateway WS client.
 */
export async function runCronJobViaGateway(gw: OpenClawGatewayClient, jobId: string): Promise<boolean> {
  try {
    await gw.runCronJob(jobId);
    return true;
  } catch {
    return false;
  }
}

// --- Cron control functions ---

export async function fetchCronOutput(jobId: string): Promise<string> {
  try {
    const gatewayPort = vscode.workspace.getConfiguration('oceangram').get<number>('gatewayPort', 4380);
    const resp = await fetch(`http://localhost:${gatewayPort}/api/cron/output/${jobId}`);
    if (!resp.ok) return '(No output available)';
    const data = await resp.json() as any;
    return data.output || data.lastOutput || '(No output)';
  } catch {
    return '(Failed to fetch output)';
  }
}

export async function toggleCronJob(jobId: string, enable: boolean): Promise<boolean> {
  try {
    const gatewayPort = vscode.workspace.getConfiguration('oceangram').get<number>('gatewayPort', 4380);
    const cmd = enable ? 'enable' : 'disable';
    const resp = await fetch(`http://localhost:${gatewayPort}/api/cron/${cmd}/${jobId}`, { method: 'POST' });
    return resp.ok;
  } catch {
    return false;
  }
}

export async function killSubAgent(sessionId: string): Promise<boolean> {
  // Note: OpenClaw doesn't have a direct kill command for sub-agents
  // This is a placeholder for future implementation
  console.log(`Would kill sub-agent: ${sessionId}`);
  return false;
}

export async function readMemoryFile(filePath: string): Promise<string> {
  try {
    const memDir = getMemoryDir();
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(memDir)) {
      return 'Access denied: Path outside memory directory';
    }
    return await readRemoteFile(resolved);
  } catch (e: any) {
    return `Error reading file: ${e.message}`;
  }
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

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
  const data = await fetchAgentPanelData();
  return {
    model: data.defaultModel,
    context: { used: 0, max: 200000, percentage: 0 },
    sessions: { total: data.totalSessions, active: data.activeSessions },
    crons: [], pm2: [], gateway: 'unknown', channels: [],
  };
}
