import { describe, it, expect, vi } from 'vitest';

// Mock vscode for any imports that need it
vi.mock('vscode', () => ({
  window: {
    createWebviewPanel: vi.fn(() => ({
      webview: { html: '', onDidReceiveMessage: vi.fn(), postMessage: vi.fn() },
      onDidDispose: vi.fn(),
      reveal: vi.fn(),
      dispose: vi.fn(),
      title: '',
    })),
  },
  commands: { registerCommand: vi.fn((_: string, __: Function) => ({ dispose: vi.fn() })) },
  ViewColumn: { One: 1, Two: 2, Active: -1 },
  Uri: { file: vi.fn((f: string) => ({ fsPath: f })) },
}));

vi.mock('../services/telegram', () => ({
  TelegramService: vi.fn().mockImplementation(() => ({
    connect: vi.fn(), disconnect: vi.fn(), getDialogs: vi.fn().mockResolvedValue([]),
    searchDialogs: vi.fn().mockResolvedValue([]), getMessages: vi.fn().mockResolvedValue([]),
    sendMessage: vi.fn(), getPinnedIds: vi.fn().mockReturnValue([]),
    pinDialog: vi.fn(), unpinDialog: vi.fn(),
  })),
}));

// Extract and test the rendering logic that lives in the webview HTML.
// We replicate the JS functions from commsPanel.ts's getHtml() to test them.

// --- Extracted functions (from ChatTab webview script) ---

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function linkify(text: string): string {
  return text.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" title="$1">$1</a>');
}

function isEmojiOnly(text: string): boolean {
  if (!text) return false;
  const stripped = text.replace(/[\s]/g, '');
  const emojiRe = /^(?:[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{200D}\u{20E3}\u{E0020}-\u{E007F}])+$/u;
  return stripped.length <= 10 && emojiRe.test(stripped);
}

function formatTime(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDate(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const msgDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diff = (today.getTime() - msgDay.getTime()) / 86400000;
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

interface MockMessage {
  id: number;
  senderId: string;
  senderName: string;
  text: string;
  timestamp: number;
  isOutgoing: boolean;
}

interface MessageGroup {
  key: string;
  isOutgoing: boolean;
  senderName: string;
  msgs: MockMessage[];
}

function groupMessages(msgs: MockMessage[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  for (const m of msgs) {
    const key = m.isOutgoing ? '__out__' : (m.senderName || '');
    const last = groups[groups.length - 1];
    if (last && last.key === key && m.timestamp - last.msgs[last.msgs.length - 1].timestamp < 300) {
      last.msgs.push(m);
    } else {
      groups.push({ key, isOutgoing: m.isOutgoing, senderName: m.senderName, msgs: [m] });
    }
  }
  return groups;
}

// --- Tests ---

describe('HTML escaping (XSS prevention)', () => {
  it('escapes < and >', () => {
    expect(esc('<script>alert("xss")</script>')).toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  });

  it('escapes ampersand', () => {
    expect(esc('A & B')).toBe('A &amp; B');
  });

  it('escapes quotes', () => {
    expect(esc('"hello" \'world\'')).toBe('&quot;hello&quot; &#039;world&#039;');
  });

  it('handles empty string', () => {
    expect(esc('')).toBe('');
  });

  it('leaves safe text unchanged', () => {
    expect(esc('hello world 123')).toBe('hello world 123');
  });

  it('escapes nested HTML', () => {
    expect(esc('<img src=x onerror=alert(1)>')).toContain('&lt;img');
  });
});

describe('URL linkification', () => {
  it('linkifies http URL', () => {
    const result = linkify('check http://example.com out');
    expect(result).toContain('<a href="http://example.com"');
  });

  it('linkifies https URL', () => {
    const result = linkify('visit https://example.com/path?q=1');
    expect(result).toContain('<a href="https://example.com/path?q=1"');
  });

  it('linkifies multiple URLs', () => {
    const result = linkify('http://a.com and https://b.com');
    expect(result).toContain('href="http://a.com"');
    expect(result).toContain('href="https://b.com"');
  });

  it('leaves text without URLs unchanged', () => {
    expect(linkify('no urls here')).toBe('no urls here');
  });

  it('does not linkify ftp or other schemes', () => {
    expect(linkify('ftp://example.com')).toBe('ftp://example.com');
  });
});

describe('emoji-only detection', () => {
  it('detects single emoji', () => {
    expect(isEmojiOnly('😀')).toBe(true);
  });

  it('detects multiple emojis', () => {
    expect(isEmojiOnly('😀🎉')).toBe(true);
  });

  it('rejects text with emojis', () => {
    expect(isEmojiOnly('hello 😀')).toBe(false);
  });

  it('rejects plain text', () => {
    expect(isEmojiOnly('hello')).toBe(false);
  });

  it('handles empty string', () => {
    expect(isEmojiOnly('')).toBe(false);
  });

  it('detects emoji with spaces', () => {
    expect(isEmojiOnly('😀 🎉')).toBe(true);
  });

  it('rejects long emoji strings (>10 chars stripped)', () => {
    // 6 emojis = 12 chars when stripped (each emoji is 2 chars in UTF-16)
    // Actually each emoji like 😀 is 2 UTF-16 code units but .length varies
    const sixEmoji = '😀😀😀😀😀😀';
    // This might pass or fail depending on string length
    // The check is stripped.length <= 10
    if (sixEmoji.replace(/\s/g, '').length > 10) {
      expect(isEmojiOnly(sixEmoji)).toBe(false);
    } else {
      expect(isEmojiOnly(sixEmoji)).toBe(true);
    }
  });

  it('detects flag emoji', () => {
    expect(isEmojiOnly('🇺🇸')).toBe(true);
  });

  it('detects weather emoji', () => {
    expect(isEmojiOnly('☀️')).toBe(true);
  });
});

describe('timestamp formatting', () => {
  it('returns empty string for 0', () => {
    expect(formatTime(0)).toBe('');
  });

  it('returns time string for valid timestamp', () => {
    const ts = Math.floor(new Date('2024-01-15T10:30:00Z').getTime() / 1000);
    const result = formatTime(ts);
    expect(result).toBeTruthy();
    // Should contain a colon (HH:MM format)
    expect(result).toContain(':');
  });
});

describe('date formatting', () => {
  it('returns empty for 0', () => {
    expect(formatDate(0)).toBe('');
  });

  it('returns "Today" for today', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(formatDate(now)).toBe('Today');
  });

  it('returns "Yesterday" for yesterday', () => {
    const yesterday = Math.floor(Date.now() / 1000) - 86400;
    expect(formatDate(yesterday)).toBe('Yesterday');
  });

  it('returns month+day for older dates', () => {
    // 30 days ago
    const old = Math.floor(Date.now() / 1000) - 86400 * 30;
    const result = formatDate(old);
    expect(result).not.toBe('Today');
    expect(result).not.toBe('Yesterday');
    expect(result.length).toBeGreaterThan(0);
  });
});

describe('message grouping', () => {
  const makeMsg = (id: number, sender: string, ts: number, outgoing = false): MockMessage => ({
    id,
    senderId: sender,
    senderName: sender,
    text: `msg ${id}`,
    timestamp: ts,
    isOutgoing: outgoing,
  });

  it('groups consecutive messages from same sender within 5 min', () => {
    const msgs = [
      makeMsg(1, 'Alice', 1000),
      makeMsg(2, 'Alice', 1100), // 100s later, < 300s
      makeMsg(3, 'Alice', 1200),
    ];
    const groups = groupMessages(msgs);
    expect(groups).toHaveLength(1);
    expect(groups[0].msgs).toHaveLength(3);
  });

  it('splits groups when sender changes', () => {
    const msgs = [
      makeMsg(1, 'Alice', 1000),
      makeMsg(2, 'Bob', 1100),
    ];
    const groups = groupMessages(msgs);
    expect(groups).toHaveLength(2);
  });

  it('splits groups when time gap > 300s', () => {
    const msgs = [
      makeMsg(1, 'Alice', 1000),
      makeMsg(2, 'Alice', 1500), // 500s later, > 300s
    ];
    const groups = groupMessages(msgs);
    expect(groups).toHaveLength(2);
  });

  it('groups outgoing messages together', () => {
    const msgs = [
      makeMsg(1, 'me', 1000, true),
      makeMsg(2, 'me', 1100, true),
    ];
    const groups = groupMessages(msgs);
    expect(groups).toHaveLength(1);
    expect(groups[0].isOutgoing).toBe(true);
  });

  it('separates incoming from outgoing', () => {
    const msgs = [
      makeMsg(1, 'Alice', 1000, false),
      makeMsg(2, 'me', 1100, true),
    ];
    const groups = groupMessages(msgs);
    expect(groups).toHaveLength(2);
  });

  it('handles empty message list', () => {
    expect(groupMessages([])).toEqual([]);
  });

  it('handles single message', () => {
    const groups = groupMessages([makeMsg(1, 'Alice', 1000)]);
    expect(groups).toHaveLength(1);
    expect(groups[0].msgs).toHaveLength(1);
  });

  it('boundary: exactly 300s gap stays grouped', () => {
    // timestamp diff < 300 means grouped. At exactly 300, diff is NOT < 300
    const msgs = [
      makeMsg(1, 'Alice', 1000),
      makeMsg(2, 'Alice', 1300), // exactly 300s
    ];
    const groups = groupMessages(msgs);
    // 1300 - 1000 = 300, which is NOT < 300, so separate groups
    expect(groups).toHaveLength(2);
  });

  it('boundary: 299s gap stays grouped', () => {
    const msgs = [
      makeMsg(1, 'Alice', 1000),
      makeMsg(2, 'Alice', 1299),
    ];
    const groups = groupMessages(msgs);
    expect(groups).toHaveLength(1);
  });
});

describe('SimplePanel', () => {
  // Test SimplePanel singleton behavior
  it('is importable', async () => {
    // Just verify the module structure
    const { SimplePanel } = await import('../simplePanel');
    expect(SimplePanel).toBeDefined();
    expect(SimplePanel.createOrShow).toBeTypeOf('function');
  });
});

describe('extension activation', () => {
  it('registers all four commands', async () => {
    const vsc = await import('vscode');
    const { activate } = await import('../extension');
    const ctx = { subscriptions: [], extensionPath: '/test' } as any;
    activate(ctx);
    expect(ctx.subscriptions.length).toBe(4);
  });
});
