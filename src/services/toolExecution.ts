import * as fs from 'fs';
import * as path from 'path';

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
  timestamp: number;       // when the assistant message with tool_use was sent
  resultTimestamp: number;  // when the tool result came back
  durationMs: number;
  isError: boolean;
  resultPreview: string;   // truncated result text
  resultFull: string;      // full result text
  messageId: string;       // parent assistant message ID
}

export interface SessionToolCalls {
  sessionId: string;
  toolCalls: ToolCall[];
}

const TOOL_ICONS: Record<string, string> = {
  exec: '⚡',
  read: '📄',
  write: '✏️',
  edit: '🔧',
  web_search: '🔍',
  web_fetch: '🌐',
  browser: '🖥️',
  message: '💬',
  tts: '🔊',
  image: '🖼️',
  canvas: '🎨',
  nodes: '📡',
  process: '⚙️',
};

export function getToolIcon(name: string): string {
  return TOOL_ICONS[name] || '🔨';
}

export function truncateParams(args: Record<string, any>, maxLen: number = 80): string {
  if (!args || Object.keys(args).length === 0) return '';
  
  // For exec, show command
  if (args.command) {
    const cmd = String(args.command);
    return cmd.length > maxLen ? cmd.slice(0, maxLen) + '…' : cmd;
  }
  // For read/write/edit, show file path
  if (args.file_path || args.path) {
    const p = String(args.file_path || args.path);
    return p.length > maxLen ? '…' + p.slice(-maxLen + 1) : p;
  }
  // For web_search, show query
  if (args.query) {
    const q = String(args.query);
    return q.length > maxLen ? q.slice(0, maxLen) + '…' : q;
  }
  // For web_fetch, show url
  if (args.url) {
    const u = String(args.url);
    return u.length > maxLen ? u.slice(0, maxLen) + '…' : u;
  }
  // For message, show action
  if (args.action) {
    return String(args.action);
  }
  
  // Generic: JSON stringify truncated
  const json = JSON.stringify(args);
  return json.length > maxLen ? json.slice(0, maxLen) + '…' : json;
}

export function formatDuration(ms: number): string {
  if (ms < 0) return '?';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  return `${mins}m${secs}s`;
}

interface JsonlMessage {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  message?: {
    role: string;
    content?: Array<{
      type: string;
      id?: string;
      name?: string;
      arguments?: Record<string, any>;
      text?: string;
    }>;
    toolCallId?: string;
    toolName?: string;
  };
}

/**
 * Parse a JSONL session file and extract tool calls with their results.
 */
export function parseToolCallsFromJsonl(lines: string[]): ToolCall[] {
  const toolCalls: ToolCall[] = [];
  
  // Map toolCallId -> pending ToolCall info
  const pending = new Map<string, {
    id: string;
    name: string;
    arguments: Record<string, any>;
    timestamp: number;
    messageId: string;
  }>();

  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: JsonlMessage;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.type !== 'message' || !entry.message) continue;

    const msg = entry.message;
    const ts = new Date(entry.timestamp).getTime();

    // Assistant message with tool_use blocks
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'toolCall' && block.id && block.name) {
          pending.set(block.id, {
            id: block.id,
            name: block.name,
            arguments: block.arguments || {},
            timestamp: ts,
            messageId: entry.id,
          });
        }
      }
    }

    // Tool result message
    if (msg.role === 'toolResult' && msg.toolCallId) {
      const p = pending.get(msg.toolCallId);
      if (!p) continue;
      pending.delete(msg.toolCallId);

      // Extract result text
      let resultText = '';
      let isError = false;
      if (Array.isArray(msg.content)) {
        resultText = msg.content
          .filter((c: any) => c.type === 'text')
          .map((c: any) => c.text || '')
          .join('\n');
      }
      if ((msg as any).isError) isError = true;

      const durationMs = ts - p.timestamp;

      toolCalls.push({
        id: p.id,
        name: p.name,
        arguments: p.arguments,
        timestamp: p.timestamp,
        resultTimestamp: ts,
        durationMs: Math.max(0, durationMs),
        isError,
        resultPreview: resultText.slice(0, 200),
        resultFull: resultText,
        messageId: p.messageId,
      });
    }
  }

  return toolCalls;
}

const SESSIONS_DIR = path.join(process.env.HOME || '/home/xiko', '.openclaw', 'agents', 'main', 'sessions');

/**
 * Find the JSONL session file for a given session key and parse tool calls.
 */
export function getToolCallsForSession(sessionKey: string): ToolCall[] {
  // The session key is like "agent:main:telegram:group:-1003850294102:topic:8547"
  // The sessions.json maps keys to session data which includes the session ID (used as filename)
  const sessionsPath = path.join(SESSIONS_DIR, 'sessions.json');
  try {
    const sessions = JSON.parse(fs.readFileSync(sessionsPath, 'utf-8'));
    const session = sessions[sessionKey];
    if (!session) return [];
    
    // The session ID is the JSONL filename
    const sessionId = session.sessionId || session.id;
    if (!sessionId) return [];
    
    const jsonlPath = path.join(SESSIONS_DIR, `${sessionId}.jsonl`);
    if (!fs.existsSync(jsonlPath)) return [];
    
    const content = fs.readFileSync(jsonlPath, 'utf-8');
    const lines = content.split('\n');
    return parseToolCallsFromJsonl(lines);
  } catch {
    return [];
  }
}

/**
 * Group tool calls by their parent assistant message ID.
 * Returns a map of messageId -> ToolCall[]
 */
export function groupToolCallsByMessage(toolCalls: ToolCall[]): Map<string, ToolCall[]> {
  const grouped = new Map<string, ToolCall[]>();
  for (const tc of toolCalls) {
    const existing = grouped.get(tc.messageId) || [];
    existing.push(tc);
    grouped.set(tc.messageId, existing);
  }
  return grouped;
}
