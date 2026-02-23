import { describe, it, expect } from 'vitest';
import {
  parseToolCallsFromJsonl,
  truncateParams,
  formatDuration,
  getToolIcon,
  groupToolCallsByMessage,
} from '../agent/toolExecution';

describe('parseToolCallsFromJsonl', () => {
  it('parses a simple tool call with result', () => {
    const lines = [
      JSON.stringify({
        type: 'message', id: 'msg1', parentId: null,
        timestamp: '2026-02-20T04:33:39.596Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 'tc1', name: 'exec', arguments: { command: 'ls -la' } },
          ],
        },
      }),
      JSON.stringify({
        type: 'message', id: 'msg2', parentId: 'msg1',
        timestamp: '2026-02-20T04:33:39.700Z',
        message: {
          role: 'toolResult', toolCallId: 'tc1', toolName: 'exec',
          content: [{ type: 'text', text: 'file1.txt\nfile2.txt' }],
        },
      }),
    ];

    const calls = parseToolCallsFromJsonl(lines);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('exec');
    expect(calls[0].arguments).toEqual({ command: 'ls -la' });
    expect(calls[0].durationMs).toBe(104); // 700 - 596
    expect(calls[0].isError).toBe(false);
    expect(calls[0].resultPreview).toBe('file1.txt\nfile2.txt');
    expect(calls[0].messageId).toBe('msg1');
  });

  it('handles multiple tool calls in one assistant message', () => {
    const lines = [
      JSON.stringify({
        type: 'message', id: 'msg1', parentId: null,
        timestamp: '2026-02-20T04:00:00.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 'tc1', name: 'read', arguments: { file_path: '/a.ts' } },
            { type: 'toolCall', id: 'tc2', name: 'exec', arguments: { command: 'pwd' } },
          ],
        },
      }),
      JSON.stringify({
        type: 'message', id: 'r1', parentId: 'msg1',
        timestamp: '2026-02-20T04:00:00.050Z',
        message: {
          role: 'toolResult', toolCallId: 'tc1', toolName: 'read',
          content: [{ type: 'text', text: 'file contents' }],
        },
      }),
      JSON.stringify({
        type: 'message', id: 'r2', parentId: 'r1',
        timestamp: '2026-02-20T04:00:00.100Z',
        message: {
          role: 'toolResult', toolCallId: 'tc2', toolName: 'exec',
          content: [{ type: 'text', text: '/home/user' }],
        },
      }),
    ];

    const calls = parseToolCallsFromJsonl(lines);
    expect(calls).toHaveLength(2);
    expect(calls[0].name).toBe('read');
    expect(calls[0].durationMs).toBe(50);
    expect(calls[1].name).toBe('exec');
    expect(calls[1].durationMs).toBe(100);
    // Both belong to same message
    expect(calls[0].messageId).toBe('msg1');
    expect(calls[1].messageId).toBe('msg1');
  });

  it('handles error results', () => {
    const lines = [
      JSON.stringify({
        type: 'message', id: 'msg1', parentId: null,
        timestamp: '2026-02-20T04:00:00.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 'tc1', name: 'exec', arguments: { command: 'bad-cmd' } },
          ],
        },
      }),
      JSON.stringify({
        type: 'message', id: 'r1', parentId: 'msg1',
        timestamp: '2026-02-20T04:00:01.000Z',
        message: {
          role: 'toolResult', toolCallId: 'tc1', toolName: 'exec',
          content: [{ type: 'text', text: 'command not found' }],
          isError: true,
        },
      }),
    ];

    const calls = parseToolCallsFromJsonl(lines);
    expect(calls).toHaveLength(1);
    expect(calls[0].isError).toBe(true);
    expect(calls[0].durationMs).toBe(1000);
  });

  it('skips non-message lines and invalid JSON', () => {
    const lines = [
      '{"type":"session","version":3,"id":"abc"}',
      'invalid json here',
      '',
      JSON.stringify({
        type: 'message', id: 'msg1', parentId: null,
        timestamp: '2026-02-20T04:00:00.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 'tc1', name: 'read', arguments: { path: '/x' } },
          ],
        },
      }),
      JSON.stringify({
        type: 'message', id: 'r1', parentId: 'msg1',
        timestamp: '2026-02-20T04:00:00.200Z',
        message: {
          role: 'toolResult', toolCallId: 'tc1', toolName: 'read',
          content: [{ type: 'text', text: 'ok' }],
        },
      }),
    ];

    const calls = parseToolCallsFromJsonl(lines);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('read');
  });

  it('handles empty input', () => {
    expect(parseToolCallsFromJsonl([])).toEqual([]);
    expect(parseToolCallsFromJsonl([''])).toEqual([]);
  });

  it('truncates long results in preview', () => {
    const longText = 'x'.repeat(500);
    const lines = [
      JSON.stringify({
        type: 'message', id: 'msg1', parentId: null,
        timestamp: '2026-02-20T04:00:00.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'tc1', name: 'read', arguments: {} }],
        },
      }),
      JSON.stringify({
        type: 'message', id: 'r1', parentId: 'msg1',
        timestamp: '2026-02-20T04:00:00.100Z',
        message: {
          role: 'toolResult', toolCallId: 'tc1', toolName: 'read',
          content: [{ type: 'text', text: longText }],
        },
      }),
    ];

    const calls = parseToolCallsFromJsonl(lines);
    expect(calls[0].resultPreview.length).toBe(200);
    expect(calls[0].resultFull.length).toBe(500);
  });
});

describe('truncateParams', () => {
  it('shows command for exec', () => {
    expect(truncateParams({ command: 'ls -la /tmp' })).toBe('ls -la /tmp');
  });

  it('truncates long commands', () => {
    const long = 'echo ' + 'a'.repeat(200);
    const result = truncateParams({ command: long }, 80);
    expect(result.length).toBe(81); // 80 + '…'
    expect(result.endsWith('…')).toBe(true);
  });

  it('shows file_path for read/write', () => {
    expect(truncateParams({ file_path: '/home/user/file.ts' })).toBe('/home/user/file.ts');
  });

  it('truncates long paths from the end', () => {
    const long = '/very/long/' + 'dir/'.repeat(30) + 'file.ts';
    const result = truncateParams({ file_path: long }, 40);
    expect(result.startsWith('…')).toBe(true);
    expect(result.length).toBe(40);
  });

  it('shows query for web_search', () => {
    expect(truncateParams({ query: 'how to parse JSON' })).toBe('how to parse JSON');
  });

  it('shows url for web_fetch', () => {
    expect(truncateParams({ url: 'https://example.com' })).toBe('https://example.com');
  });

  it('handles empty args', () => {
    expect(truncateParams({})).toBe('');
  });

  it('falls back to JSON for unknown args', () => {
    const result = truncateParams({ foo: 'bar', baz: 42 });
    expect(result).toBe('{"foo":"bar","baz":42}');
  });
});

describe('formatDuration', () => {
  it('formats milliseconds', () => {
    expect(formatDuration(50)).toBe('50ms');
    expect(formatDuration(999)).toBe('999ms');
  });

  it('formats seconds', () => {
    expect(formatDuration(1500)).toBe('1.5s');
    expect(formatDuration(30000)).toBe('30.0s');
  });

  it('formats minutes', () => {
    expect(formatDuration(65000)).toBe('1m5s');
    expect(formatDuration(120000)).toBe('2m0s');
  });

  it('handles negative', () => {
    expect(formatDuration(-1)).toBe('?');
  });

  it('handles zero', () => {
    expect(formatDuration(0)).toBe('0ms');
  });
});

describe('getToolIcon', () => {
  it('returns known icons', () => {
    expect(getToolIcon('exec')).toBe('⚡');
    expect(getToolIcon('read')).toBe('📄');
    expect(getToolIcon('web_search')).toBe('🔍');
  });

  it('returns default for unknown', () => {
    expect(getToolIcon('unknown_tool')).toBe('🔨');
  });
});

describe('groupToolCallsByMessage', () => {
  it('groups by messageId', () => {
    const calls = [
      { id: 'tc1', name: 'read', messageId: 'msg1' } as any,
      { id: 'tc2', name: 'exec', messageId: 'msg1' } as any,
      { id: 'tc3', name: 'read', messageId: 'msg2' } as any,
    ];
    const grouped = groupToolCallsByMessage(calls);
    expect(grouped.size).toBe(2);
    expect(grouped.get('msg1')).toHaveLength(2);
    expect(grouped.get('msg2')).toHaveLength(1);
  });

  it('handles empty', () => {
    expect(groupToolCallsByMessage([]).size).toBe(0);
  });
});
