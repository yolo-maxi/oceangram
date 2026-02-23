import * as path from 'path';
import { readRemoteFile, remoteFileExists, getOpenclawDir } from '../services/remoteFs';

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
  timestamp: number;
  resultTimestamp: number;
  durationMs: number;
  isError: boolean;
  resultPreview: string;
  resultFull: string;
  messageId: string;
}

export interface SessionToolCalls {
  sessionId: string;
  toolCalls: ToolCall[];
}

const TOOL_ICONS: Record<string, string> = {
  exec: '⚡',
  read: '📄',
  Read: '📄',
  write: '✏️',
  Write: '✏️',
  edit: '🔧',
  Edit: '🔧',
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
  
  if (args.command) {
    const cmd = String(args.command);
    return cmd.length > maxLen ? cmd.slice(0, maxLen) + '…' : cmd;
  }
  if (args.file_path || args.path) {
    const p = String(args.file_path || args.path);
    return p.length > maxLen ? '…' + p.slice(-maxLen + 1) : p;
  }
  if (args.query) {
    const q = String(args.query);
    return q.length > maxLen ? q.slice(0, maxLen) + '…' : q;
  }
  if (args.url) {
    const u = String(args.url);
    return u.length > maxLen ? u.slice(0, maxLen) + '…' : u;
  }
  if (args.action) {
    return String(args.action);
  }
  
  const json = JSON.stringify(args);
  return json.length > maxLen ? json.slice(0, maxLen) + '…' : json;
}

export function truncateString(s: string, maxLen: number = 60): string {
  if (!s) return '';
  s = s.trim();
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + '…';
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

export function parseToolCallsFromJsonl(lines: string[]): ToolCall[] {
  const toolCalls: ToolCall[] = [];
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

    if (msg.role === 'toolResult' && msg.toolCallId) {
      const p = pending.get(msg.toolCallId);
      if (!p) continue;
      pending.delete(msg.toolCallId);

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

function getSessionsDir(): string {
  return path.join(getOpenclawDir(), 'agents', 'main', 'sessions');
}

export async function getToolCallsForSession(sessionKey: string): Promise<ToolCall[]> {
  const sessionsPath = path.join(getSessionsDir(), 'sessions.json');
  try {
    const sessions = JSON.parse(await readRemoteFile(sessionsPath));
    const session = sessions[sessionKey];
    if (!session) return [];

    const sessionId = session.sessionId || session.id;
    if (!sessionId) return [];

    const jsonlPath = path.join(getSessionsDir(), `${sessionId}.jsonl`);
    if (!(await remoteFileExists(jsonlPath))) return [];

    const content = await readRemoteFile(jsonlPath);
    const lines = content.split('\n');
    return parseToolCallsFromJsonl(lines);
  } catch {
    return [];
  }
}

export function groupToolCallsByMessage(toolCalls: ToolCall[]): Map<string, ToolCall[]> {
  const grouped = new Map<string, ToolCall[]>();
  for (const tc of toolCalls) {
    const existing = grouped.get(tc.messageId) || [];
    existing.push(tc);
    grouped.set(tc.messageId, existing);
  }
  return grouped;
}

export interface EmbeddedToolCall {
  name: string;
  params: string;
  fullParams: string;
  result: string;
  fullResult: string;
  durationMs: number;
  isError: boolean;
  index: number;
}

/**
 * Parse tool calls embedded in message text from OpenClaw.
 * Detects XML-style invoke blocks and function_results.
 */
export function parseToolCallsFromText(text: string): EmbeddedToolCall[] {
  const toolCalls: EmbeddedToolCall[] = [];
  if (!text) return toolCalls;

  // Build tag markers using string concat to avoid XML parsing issues
  const LT = String.fromCharCode(60);
  const GT = String.fromCharCode(62);
  
  const invokeOpen = LT + 'invoke';
  const invokeClose = LT + '/invoke' + GT;
  const paramOpen = LT + 'parameter name="';
  const paramClose = LT + '/parameter' + GT;
  const fnResultOpen = LT + 'function_results' + GT;
  const fnResultClose = LT + '/function_results' + GT;
  
  // Also check for antml:invoke variant
  const antInvokeOpen = LT + 'antml:invoke';
  const antInvokeClose = LT + '/antml:invoke' + GT;
  const antParamOpen = LT + 'antml:parameter name="';
  const antParamClose = LT + '/antml:parameter' + GT;
  
  let searchStart = 0;
  let toolIndex = 0;
  
  while (searchStart < text.length) {
    // Find next invoke block (either format)
    let invokeStart = text.indexOf(invokeOpen, searchStart);
    let antInvokeStart = text.indexOf(antInvokeOpen, searchStart);
    
    // Avoid false positive: <invoke should not match <invoke
    if (invokeStart !== -1 && antInvokeStart !== -1 && antInvokeStart < invokeStart) {
      // If antml:invoke comes first, skip the regular match if it's at the same position
      if (invokeStart === antInvokeStart + 6) { // 'antml:'.length = 6
        invokeStart = text.indexOf(invokeOpen, invokeStart + 1);
      }
    }
    
    // Use whichever comes first (if any)
    let isAntFormat = false;
    let blockStart = -1;
    
    if (invokeStart === -1 && antInvokeStart === -1) break;
    if (invokeStart === -1) {
      blockStart = antInvokeStart;
      isAntFormat = true;
    } else if (antInvokeStart === -1) {
      blockStart = invokeStart;
    } else {
      if (antInvokeStart <= invokeStart) {
        blockStart = antInvokeStart;
        isAntFormat = true;
      } else {
        blockStart = invokeStart;
      }
    }
    
    // Extract tool name from name="..." attribute
    const nameMatch = text.slice(blockStart, blockStart + 100).match(/name="([^"]+)"/);
    if (!nameMatch) {
      searchStart = blockStart + 10;
      continue;
    }
    const toolName = nameMatch[1];
    
    // Find the closing tag
    const closeTag = isAntFormat ? antInvokeClose : invokeClose;
    const blockEnd = text.indexOf(closeTag, blockStart);
    if (blockEnd === -1) {
      searchStart = blockStart + 10;
      continue;
    }
    
    // Extract the block content (parameters)
    const blockContent = text.slice(blockStart, blockEnd + closeTag.length);
    
    // Parse parameters
    const params: Record<string, string> = {};
    const pOpen = isAntFormat ? antParamOpen : paramOpen;
    const pClose = isAntFormat ? antParamClose : paramClose;
    
    let pSearch = 0;
    while (pSearch < blockContent.length) {
      const pStart = blockContent.indexOf(pOpen, pSearch);
      if (pStart === -1) break;
      
      // Get parameter name
      const pNameEnd = blockContent.indexOf('"', pStart + pOpen.length);
      if (pNameEnd === -1) break;
      const pName = blockContent.slice(pStart + pOpen.length, pNameEnd);
      
      // Find closing > after name
      const tagEnd = blockContent.indexOf(GT, pNameEnd);
      if (tagEnd === -1) break;
      
      // Find parameter closing tag
      const pEnd = blockContent.indexOf(pClose, tagEnd);
      if (pEnd === -1) break;
      
      // Get parameter value
      const pValue = blockContent.slice(tagEnd + 1, pEnd);
      params[pName] = pValue;
      
      pSearch = pEnd + pClose.length;
    }
    
    // Look for function_results after this invoke block
    let result = '';
    let isError = false;
    const afterBlock = text.slice(blockEnd + closeTag.length);
    
    // Check if there's a result block following
    const resultStart = afterBlock.indexOf(fnResultOpen);
    if (resultStart !== -1 && resultStart < 500) { // Within reasonable distance
      const resultEnd = afterBlock.indexOf(fnResultClose, resultStart);
      if (resultEnd !== -1) {
        result = afterBlock.slice(resultStart + fnResultOpen.length, resultEnd).trim();
        // Check for error indicators
        if (result.toLowerCase().includes('error') || result.toLowerCase().includes('failed')) {
          isError = true;
        }
      }
    }
    
    // Create truncated params summary
    let paramsSummary = '';
    if (params.command) {
      paramsSummary = truncateString(params.command, 60);
    } else if (params.file_path || params.path) {
      paramsSummary = truncateString(params.file_path || params.path || '', 60);
    } else if (params.query) {
      paramsSummary = truncateString(params.query, 60);
    } else if (params.url) {
      paramsSummary = truncateString(params.url, 60);
    } else if (params.action) {
      paramsSummary = params.action;
    } else {
      const keys = Object.keys(params);
      if (keys.length > 0) {
        paramsSummary = truncateString(JSON.stringify(params), 60);
      }
    }
    
    toolCalls.push({
      name: toolName,
      params: paramsSummary,
      fullParams: JSON.stringify(params, null, 2),
      result: truncateString(result, 100),
      fullResult: result,
      durationMs: -1, // Unknown for text-parsed calls
      isError,
      index: toolIndex++,
    });
    
    searchStart = blockEnd + closeTag.length;
  }
  
  return toolCalls;
}

/**
 * Check if a message likely contains tool calls (quick check before full parsing)
 */
export function messageHasToolCalls(text: string): boolean {
  if (!text) return false;
  const LT = String.fromCharCode(60);
  // Check for both formats
  return text.includes(LT + 'invoke') || 
         text.includes(LT + 'antml:invoke') ||
         text.includes(LT + 'function_calls' + String.fromCharCode(62));
}
