import * as path from 'path';
import * as vscode from 'vscode';
import { readRemoteFile, readRemoteDir, remoteFileExists, remoteFileStat, getOpenclawDir } from './remoteFs';

// --- Types ---

export interface ToolCallEntry {
  id: string;
  toolName: string;
  icon: string;
  parameters: string;       // full JSON string of arguments
  paramsTruncated: string;  // first 100 chars
  startedAt: number;        // timestamp ms
  endedAt?: number;         // timestamp ms
  durationMs?: number;
  status: 'pending' | 'success' | 'error';
  result?: string;          // full result text
  isError?: boolean;
}

// --- Icon mapping ---

const TOOL_ICONS: Record<string, string> = {
  exec: '🔧',
  read: '📖',
  edit: '✏️',
  write: '📝',
  web_search: '🔍',
  web_fetch: '🌐',
  browser: '🖥️',
  message: '💬',
  tts: '🔊',
  process: '⚙️',
  canvas: '🎨',
  nodes: '📡',
  image: '🖼️',
};

export function getToolIcon(toolName: string): string {
  return TOOL_ICONS[toolName] || '🔧';
}

// --- Parameter truncation ---

export function truncateParams(params: string, maxLen: number = 100): string {
  if (params.length <= maxLen) return params;
  return params.substring(0, maxLen) + '…';
}

// --- JSONL line parsing ---

export interface ParsedToolCall {
  type: 'toolCall';
  id: string;
  name: string;
  arguments: any;
  timestamp: number;
}

export interface ParsedToolResult {
  type: 'toolResult';
  toolCallId: string;
  toolName: string;
  content: string;
  isError: boolean;
  timestamp: number;
}

export type ParsedEntry = ParsedToolCall | ParsedToolResult;

/**
 * Parse a single JSONL line and extract tool call or tool result info.
 * Returns null if the line is not tool-related.
 */
export function parseJsonlLine(line: string): ParsedEntry[] {
  if (!line.trim()) return [];
  
  let parsed: any;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }

  if (parsed.type !== 'message' || !parsed.message) return [];

  const msg = parsed.message;
  const timestamp = typeof parsed.timestamp === 'string'
    ? new Date(parsed.timestamp).getTime()
    : (parsed.timestamp || msg.timestamp || 0);

  const results: ParsedEntry[] = [];

  // Assistant message with toolCall entries in content
  if (msg.role === 'assistant' && Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (block.type === 'toolCall' && block.id && block.name) {
        results.push({
          type: 'toolCall',
          id: block.id,
          name: block.name,
          arguments: block.arguments || {},
          timestamp,
        });
      }
    }
  }

  // Tool result message
  if (msg.role === 'toolResult' && msg.toolCallId) {
    const contentText = Array.isArray(msg.content)
      ? msg.content.map((c: any) => c.text || '').join('\n')
      : (typeof msg.content === 'string' ? msg.content : '');

    results.push({
      type: 'toolResult',
      toolCallId: msg.toolCallId,
      toolName: msg.toolName || 'unknown',
      content: contentText,
      isError: !!msg.isError,
      timestamp,
    });
  }

  return results;
}

// --- Tool call pairing ---

/**
 * Pair tool calls with their results. Returns completed ToolCallEntry items
 * and a map of still-pending calls.
 */
export function pairToolCalls(
  entries: ParsedEntry[],
  pending: Map<string, ToolCallEntry> = new Map(),
): { completed: ToolCallEntry[]; pending: Map<string, ToolCallEntry> } {
  const completed: ToolCallEntry[] = [];

  for (const entry of entries) {
    if (entry.type === 'toolCall') {
      const paramsStr = typeof entry.arguments === 'string'
        ? entry.arguments
        : JSON.stringify(entry.arguments);

      const call: ToolCallEntry = {
        id: entry.id,
        toolName: entry.name,
        icon: getToolIcon(entry.name),
        parameters: paramsStr,
        paramsTruncated: truncateParams(paramsStr),
        startedAt: entry.timestamp,
        status: 'pending',
      };
      pending.set(entry.id, call);
    } else if (entry.type === 'toolResult') {
      const call = pending.get(entry.toolCallId);
      if (call) {
        call.endedAt = entry.timestamp;
        call.durationMs = entry.timestamp - call.startedAt;
        call.status = entry.isError ? 'error' : 'success';
        call.result = entry.content;
        call.isError = entry.isError;
        pending.delete(entry.toolCallId);
        completed.push(call);
      } else {
        // Result without a matching call — create a standalone entry
        completed.push({
          id: entry.toolCallId,
          toolName: entry.toolName,
          icon: getToolIcon(entry.toolName),
          parameters: '',
          paramsTruncated: '',
          startedAt: entry.timestamp,
          endedAt: entry.timestamp,
          durationMs: 0,
          status: entry.isError ? 'error' : 'success',
          result: entry.content,
          isError: entry.isError,
        });
      }
    }
  }

  return { completed, pending };
}

// --- Session JSONL watcher ---

function getSessionsDir(): string {
  return path.join(getOpenclawDir(), 'agents', 'main', 'sessions');
}

export async function getActiveSessionId(): Promise<string | null> {
  try {
    const sessionsPath = path.join(getSessionsDir(), 'sessions.json');
    const raw = JSON.parse(await readRemoteFile(sessionsPath));

    let bestKey = '';
    let bestTime = 0;
    for (const [key, val] of Object.entries(raw as Record<string, any>)) {
      const updatedAt = val.updatedAt || 0;
      if (updatedAt > bestTime) {
        bestTime = updatedAt;
        bestKey = key;
      }
    }

    if (!bestKey) return null;

    const entry = raw[bestKey];
    if (entry.sessionId) return entry.sessionId;

    // Fallback: find most recently modified JSONL
    const entries = await readRemoteDir(getSessionsDir());
    const jsonlFiles: { name: string; mtime: number }[] = [];
    for (const [name, type] of entries) {
      if (!name.endsWith('.jsonl') || type !== vscode.FileType.File) continue;
      const stat = await remoteFileStat(path.join(getSessionsDir(), name));
      jsonlFiles.push({ name, mtime: stat?.mtime || 0 });
    }
    jsonlFiles.sort((a, b) => b.mtime - a.mtime);

    if (jsonlFiles.length > 0) {
      return jsonlFiles[0].name.replace('.jsonl', '');
    }

    return null;
  } catch {
    return null;
  }
}

export function getSessionJsonlPath(sessionId: string): string {
  return path.join(getSessionsDir(), `${sessionId}.jsonl`);
}

/**
 * Read all tool calls from a JSONL file (remote).
 */
export async function readToolCallsFromFile(filePath: string, maxEntries: number = 100): Promise<ToolCallEntry[]> {
  try {
    const content = await readRemoteFile(filePath);
    const lines = content.split('\n');

    const allEntries: ParsedEntry[] = [];
    for (const line of lines) {
      allEntries.push(...parseJsonlLine(line));
    }

    const { completed, pending } = pairToolCalls(allEntries);
    const all = [...completed, ...Array.from(pending.values())];
    all.sort((a, b) => b.startedAt - a.startedAt);
    return all.slice(0, maxEntries);
  } catch {
    return [];
  }
}

// --- Filter logic ---

export function getUniqueToolNames(entries: ToolCallEntry[]): string[] {
  const names = new Set(entries.map(e => e.toolName));
  return Array.from(names).sort();
}

export function filterByToolName(entries: ToolCallEntry[], toolName: string | null): ToolCallEntry[] {
  if (!toolName || toolName === 'all') return entries;
  return entries.filter(e => e.toolName === toolName);
}
