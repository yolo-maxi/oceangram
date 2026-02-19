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

export interface WorkspaceFileInfo {
  name: string;
  chars: number;
  truncated: boolean;
}

export interface SkillInfo {
  name: string;
  source: string; // openclaw-bundled, openclaw-workspace, agents-skills-project
  chars: number;
}

export interface ToolInfo {
  name: string;
  schemaChars: number;
}

export interface SubAgentInfo {
  sessionKey: string;
  model: string;
  isActive: boolean;
  updatedAt: number;
}

export interface AgentDetailedInfo extends AgentSessionInfo {
  // Context breakdown
  systemPromptChars: number;
  projectContextChars: number;
  conversationChars: number;
  
  // Workspace files loaded into context
  workspaceFiles: WorkspaceFileInfo[];
  
  // Skills available
  skills: SkillInfo[];
  totalSkillChars: number;
  
  // Tools available
  tools: ToolInfo[];
  totalToolChars: number;
  
  // Sub-agents (other active sessions)
  subAgents: SubAgentInfo[];
  
  // Session metadata
  channel: string;
  chatType: string;
  workspaceDir: string;
  sandboxed: boolean;
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

  /**
   * Get detailed session info including context breakdown, skills, tools, and sub-agents
   */
  getDetailedSession(chatId: string, topicId?: number): AgentDetailedInfo | null {
    const basicInfo = this.findSession(chatId, topicId);
    if (!basicInfo) return null;

    const sessions = this.loadSessions();
    const session = sessions[basicInfo.sessionKey];
    if (!session) return null;

    const report = session.systemPromptReport || {};
    
    // Parse workspace files from injectedWorkspaceFiles
    const workspaceFiles: WorkspaceFileInfo[] = [];
    const injectedFiles = report.injectedWorkspaceFiles || [];
    for (const file of injectedFiles) {
      workspaceFiles.push({
        name: file.name || 'unknown',
        chars: file.chars || 0,
        truncated: file.truncated || false,
      });
    }

    // Parse skills from skills.entries
    const skills: SkillInfo[] = [];
    let totalSkillChars = 0;
    const skillsData = report.skills || {};
    const skillEntries = skillsData.entries || [];
    for (const skill of skillEntries) {
      const chars = skill.chars || 0;
      skills.push({
        name: skill.name || 'unknown',
        source: skill.source || 'unknown',
        chars,
      });
      totalSkillChars += chars;
    }

    // Parse tools from tools.entries
    const tools: ToolInfo[] = [];
    let totalToolChars = 0;
    const toolsData = report.tools || {};
    const toolEntries = toolsData.entries || [];
    for (const tool of toolEntries) {
      const schemaChars = tool.schemaChars || tool.chars || 0;
      tools.push({
        name: tool.name || 'unknown',
        schemaChars,
      });
      totalToolChars += schemaChars;
    }

    // Find other active sessions (potential sub-agents)
    const subAgents: SubAgentInfo[] = [];
    const now = Date.now();
    const ACTIVE_THRESHOLD = 5 * 60 * 1000; // 5 minutes
    
    for (const [key, s] of Object.entries(sessions)) {
      if (key === basicInfo.sessionKey) continue; // Skip self
      
      const updatedAt = (s as any).updatedAt || 0;
      const isActive = (now - updatedAt) < ACTIVE_THRESHOLD;
      
      // Only include recently active sessions
      if (isActive) {
        subAgents.push({
          sessionKey: key,
          model: (s as any).model || 'unknown',
          isActive: true,
          updatedAt,
        });
      }
    }

    // Sort sub-agents by most recent first
    subAgents.sort((a, b) => b.updatedAt - a.updatedAt);

    // Extract session metadata
    const deliveryContext = session.deliveryContext || {};
    const channel = deliveryContext.channel || 'unknown';
    const chatType = deliveryContext.chatType || basicInfo.sessionKey.includes(':group:') ? 'group' : 'dm';
    const workspaceDir = report.workspaceDir || session.workspaceDir || '';
    const sandboxed = session.sandboxed || false;

    // Calculate chars breakdown
    const systemPromptChars = report.systemPromptChars || report.baseChars || 0;
    const projectContextChars = report.projectContextChars || 
      workspaceFiles.reduce((sum, f) => sum + f.chars, 0);
    
    // Estimate conversation chars from total tokens (roughly 4 chars per token for English)
    const totalChars = (basicInfo.totalTokens || 0) * 4;
    const contextUsedChars = systemPromptChars + projectContextChars + totalSkillChars + totalToolChars;
    const conversationChars = Math.max(0, totalChars - contextUsedChars);

    return {
      ...basicInfo,
      systemPromptChars,
      projectContextChars,
      conversationChars,
      workspaceFiles,
      skills,
      totalSkillChars,
      tools,
      totalToolChars,
      subAgents,
      channel,
      chatType,
      workspaceDir,
      sandboxed,
    };
  }
}
