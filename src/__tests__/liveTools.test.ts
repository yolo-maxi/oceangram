import { describe, it, expect } from 'vitest';
import {
  parseJsonlLine,
  pairToolCalls,
  truncateParams,
  getToolIcon,
  filterByToolName,
  getUniqueToolNames,
  ToolCallEntry,
  ParsedEntry,
} from '../agent/liveTools';

// --- Sample JSONL lines ---

const toolCallLine = JSON.stringify({
  type: 'message',
  id: 'msg1',
  parentId: null,
  timestamp: '2026-02-20T04:34:19.154Z',
  message: {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Looking at files...' },
      {
        type: 'toolCall',
        id: 'tc_001',
        name: 'read',
        arguments: { file_path: '/home/xiko/oceangram/src/agentPanel.ts' },
      },
      {
        type: 'toolCall',
        id: 'tc_002',
        name: 'exec',
        arguments: { command: 'ls -la /tmp' },
      },
    ],
    model: 'claude-opus-4-5',
  },
});

const toolResultLine = JSON.stringify({
  type: 'message',
  id: 'msg2',
  parentId: 'msg1',
  timestamp: '2026-02-20T04:34:22.000Z',
  message: {
    role: 'toolResult',
    toolCallId: 'tc_001',
    toolName: 'read',
    content: [{ type: 'text', text: 'import * as vscode from "vscode";' }],
    isError: false,
  },
});

const toolResultErrorLine = JSON.stringify({
  type: 'message',
  id: 'msg3',
  parentId: 'msg1',
  timestamp: '2026-02-20T04:34:23.500Z',
  message: {
    role: 'toolResult',
    toolCallId: 'tc_002',
    toolName: 'exec',
    content: [{ type: 'text', text: 'Permission denied' }],
    isError: true,
  },
});

const nonToolLine = JSON.stringify({
  type: 'message',
  id: 'msg0',
  timestamp: '2026-02-20T04:34:00.000Z',
  message: {
    role: 'user',
    content: [{ type: 'text', text: 'Hello' }],
  },
});

// --- Tests ---

describe('parseJsonlLine', () => {
  it('extracts tool calls from assistant message', () => {
    const results = parseJsonlLine(toolCallLine);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      type: 'toolCall',
      id: 'tc_001',
      name: 'read',
    });
    expect(results[1]).toMatchObject({
      type: 'toolCall',
      id: 'tc_002',
      name: 'exec',
    });
  });

  it('extracts tool result', () => {
    const results = parseJsonlLine(toolResultLine);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      type: 'toolResult',
      toolCallId: 'tc_001',
      toolName: 'read',
      isError: false,
    });
  });

  it('extracts error tool result', () => {
    const results = parseJsonlLine(toolResultErrorLine);
    expect(results).toHaveLength(1);
    const r = results[0];
    expect(r.type).toBe('toolResult');
    if (r.type === 'toolResult') {
      expect(r.isError).toBe(true);
      expect(r.content).toBe('Permission denied');
    }
  });

  it('returns empty for non-tool messages', () => {
    expect(parseJsonlLine(nonToolLine)).toHaveLength(0);
  });

  it('returns empty for invalid JSON', () => {
    expect(parseJsonlLine('not json')).toHaveLength(0);
  });

  it('returns empty for empty string', () => {
    expect(parseJsonlLine('')).toHaveLength(0);
  });
});

describe('pairToolCalls', () => {
  it('pairs a tool call with its result', () => {
    const entries: ParsedEntry[] = [
      ...parseJsonlLine(toolCallLine),
      ...parseJsonlLine(toolResultLine),
    ];

    const { completed, pending } = pairToolCalls(entries);
    expect(completed).toHaveLength(1);
    expect(completed[0].toolName).toBe('read');
    expect(completed[0].status).toBe('success');
    expect(pending.size).toBe(1); // tc_002 still pending
  });

  it('calculates duration correctly', () => {
    const entries: ParsedEntry[] = [
      ...parseJsonlLine(toolCallLine),
      ...parseJsonlLine(toolResultLine),
    ];

    const { completed } = pairToolCalls(entries);
    // 04:34:22.000 - 04:34:19.154 = 2846ms
    expect(completed[0].durationMs).toBe(2846);
  });

  it('marks error results correctly', () => {
    const entries: ParsedEntry[] = [
      ...parseJsonlLine(toolCallLine),
      ...parseJsonlLine(toolResultErrorLine),
    ];

    const { completed } = pairToolCalls(entries);
    const execResult = completed.find(c => c.toolName === 'exec');
    expect(execResult?.status).toBe('error');
    expect(execResult?.isError).toBe(true);
  });

  it('handles result without matching call', () => {
    const orphanResult = JSON.stringify({
      type: 'message',
      id: 'x',
      timestamp: '2026-02-20T04:35:00.000Z',
      message: {
        role: 'toolResult',
        toolCallId: 'orphan_id',
        toolName: 'web_search',
        content: [{ type: 'text', text: 'results' }],
        isError: false,
      },
    });

    const entries = parseJsonlLine(orphanResult);
    const { completed } = pairToolCalls(entries);
    expect(completed).toHaveLength(1);
    expect(completed[0].toolName).toBe('web_search');
    expect(completed[0].status).toBe('success');
  });

  it('tracks pending calls correctly', () => {
    const entries = parseJsonlLine(toolCallLine);
    const { completed, pending } = pairToolCalls(entries);
    expect(completed).toHaveLength(0);
    expect(pending.size).toBe(2);
    expect(pending.has('tc_001')).toBe(true);
    expect(pending.has('tc_002')).toBe(true);
  });
});

describe('truncateParams', () => {
  it('returns short strings as-is', () => {
    expect(truncateParams('hello')).toBe('hello');
  });

  it('truncates at 100 chars by default', () => {
    const long = 'a'.repeat(150);
    const result = truncateParams(long);
    expect(result.length).toBe(101); // 100 + ellipsis char
    expect(result.endsWith('…')).toBe(true);
  });

  it('respects custom maxLen', () => {
    const result = truncateParams('abcdefghij', 5);
    expect(result).toBe('abcde…');
  });

  it('handles exact length', () => {
    const s = 'a'.repeat(100);
    expect(truncateParams(s)).toBe(s);
  });
});

describe('getToolIcon', () => {
  it('returns correct icons for known tools', () => {
    expect(getToolIcon('exec')).toBe('🔧');
    expect(getToolIcon('read')).toBe('📖');
    expect(getToolIcon('edit')).toBe('✏️');
    expect(getToolIcon('web_search')).toBe('🔍');
    expect(getToolIcon('web_fetch')).toBe('🌐');
  });

  it('returns default icon for unknown tools', () => {
    expect(getToolIcon('unknown_tool')).toBe('🔧');
  });
});

describe('filterByToolName', () => {
  const entries: ToolCallEntry[] = [
    { id: '1', toolName: 'read', icon: '📖', parameters: '', paramsTruncated: '', startedAt: 1000, status: 'success' },
    { id: '2', toolName: 'exec', icon: '🔧', parameters: '', paramsTruncated: '', startedAt: 2000, status: 'success' },
    { id: '3', toolName: 'read', icon: '📖', parameters: '', paramsTruncated: '', startedAt: 3000, status: 'error' },
    { id: '4', toolName: 'web_search', icon: '🔍', parameters: '', paramsTruncated: '', startedAt: 4000, status: 'pending' },
  ];

  it('returns all when filter is null', () => {
    expect(filterByToolName(entries, null)).toHaveLength(4);
  });

  it('returns all when filter is "all"', () => {
    expect(filterByToolName(entries, 'all')).toHaveLength(4);
  });

  it('filters by tool name', () => {
    const result = filterByToolName(entries, 'read');
    expect(result).toHaveLength(2);
    expect(result.every(e => e.toolName === 'read')).toBe(true);
  });

  it('returns empty for non-existent tool', () => {
    expect(filterByToolName(entries, 'nonexistent')).toHaveLength(0);
  });
});

describe('getUniqueToolNames', () => {
  it('returns sorted unique names', () => {
    const entries: ToolCallEntry[] = [
      { id: '1', toolName: 'read', icon: '', parameters: '', paramsTruncated: '', startedAt: 0, status: 'success' },
      { id: '2', toolName: 'exec', icon: '', parameters: '', paramsTruncated: '', startedAt: 0, status: 'success' },
      { id: '3', toolName: 'read', icon: '', parameters: '', paramsTruncated: '', startedAt: 0, status: 'success' },
    ];
    expect(getUniqueToolNames(entries)).toEqual(['exec', 'read']);
  });

  it('returns empty for no entries', () => {
    expect(getUniqueToolNames([])).toEqual([]);
  });
});
