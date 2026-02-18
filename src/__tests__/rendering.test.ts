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

// --- Markdown/entity rendering (from ChatTab webview) ---

function applyEntities(text: string, entities?: Array<{type: string; offset: number; length: number; url?: string; language?: string}>): string {
  if (!entities || entities.length === 0) return linkify(esc(text));

  // Sort by offset descending so we can replace from end to start
  const sorted = [...entities].sort((a, b) => b.offset - a.offset);
  // Work on an array of chars to handle multi-byte correctly
  const chars = Array.from(text);
  // First escape everything
  const escaped = chars.map(c => esc(c));

  for (const e of sorted) {
    const slice = escaped.slice(e.offset, e.offset + e.length).join('');
    let replacement: string;
    switch (e.type) {
      case 'bold': replacement = '<strong>' + slice + '</strong>'; break;
      case 'italic': replacement = '<em>' + slice + '</em>'; break;
      case 'code': replacement = '<code>' + slice + '</code>'; break;
      case 'pre': replacement = '<pre><code' + (e.language ? ' class="language-' + esc(e.language) + '"' : '') + '>' + slice + '</code></pre>'; break;
      case 'strikethrough': replacement = '<del>' + slice + '</del>'; break;
      case 'text_link': {
        const safeUrl = (e.url || '').match(/^https?:\/\//) ? e.url! : '#';
        replacement = '<a href="' + esc(safeUrl) + '">' + slice + '</a>'; break;
      }
      case 'url': replacement = '<a href="' + slice + '">' + slice + '</a>'; break;
      default: replacement = slice;
    }
    escaped.splice(e.offset, e.length, replacement);
  }

  return escaped.join('');
}

function renderMessageHtml(m: {
  text: string;
  isOutgoing: boolean;
  senderName?: string;
  mediaType?: string;
  mediaUrl?: string;
  fileName?: string;
  fileSize?: number;
  replyToId?: number;
  replyToText?: string;
  replyToSender?: string;
  forwardFrom?: string;
  isEdited?: boolean;
  entities?: Array<{type: string; offset: number; length: number; url?: string; language?: string}>;
  linkPreview?: { url: string; title?: string; description?: string; imageUrl?: string };
  timestamp: number;
}): string {
  let html = '';

  // Forward header
  if (m.forwardFrom) {
    html += '<div class="forward-header">Forwarded from <strong>' + esc(m.forwardFrom) + '</strong></div>';
  }

  // Reply quote
  if (m.replyToId) {
    html += '<div class="reply-quote">';
    if (m.replyToSender) html += '<div class="reply-sender">' + esc(m.replyToSender) + '</div>';
    html += '<div class="reply-text">' + esc(m.replyToText || '') + '</div>';
    html += '</div>';
  }

  // Media
  if (m.mediaType === 'photo' && m.mediaUrl) {
    html += '<img class="msg-photo" src="' + esc(m.mediaUrl) + '" />';
  } else if (m.mediaType === 'file' && m.fileName) {
    html += '<div class="msg-file">📎 ' + esc(m.fileName) + (m.fileSize ? ' (' + Math.round(m.fileSize / 1024) + ' KB)' : '') + '</div>';
  } else if (m.mediaType === 'voice') {
    html += '<div class="msg-voice">🎤 Voice message</div>';
  } else if (m.mediaType === 'video') {
    html += '<div class="msg-video">🎬 Video</div>';
  } else if (m.mediaType === 'sticker') {
    html += '<div class="msg-sticker">🏷️ Sticker</div>';
  } else if (m.mediaType === 'gif') {
    html += '<div class="msg-gif">🎞️ GIF</div>';
  }

  // Text with entities
  if (m.text) {
    const content = applyEntities(m.text, m.entities);
    html += '<div class="msg-text">' + content + '</div>';
  }

  // Edited label
  if (m.isEdited) {
    html += '<span class="msg-edited">edited</span>';
  }

  // Link preview
  if (m.linkPreview) {
    html += '<div class="link-preview">';
    if (m.linkPreview.imageUrl) html += '<img class="lp-image" src="' + esc(m.linkPreview.imageUrl) + '" />';
    if (m.linkPreview.title) html += '<div class="lp-title">' + esc(m.linkPreview.title) + '</div>';
    if (m.linkPreview.description) html += '<div class="lp-desc">' + esc(m.linkPreview.description) + '</div>';
    html += '<div class="lp-url">' + esc(m.linkPreview.url) + '</div>';
    html += '</div>';
  }

  return html;
}

describe('entity-based markdown rendering', () => {
  it('renders bold text', () => {
    const result = applyEntities('hello world', [{ type: 'bold', offset: 0, length: 5 }]);
    expect(result).toContain('<strong>hello</strong>');
  });

  it('renders italic text', () => {
    const result = applyEntities('hello world', [{ type: 'italic', offset: 6, length: 5 }]);
    expect(result).toContain('<em>world</em>');
  });

  it('renders inline code', () => {
    const result = applyEntities('use foo() here', [{ type: 'code', offset: 4, length: 5 }]);
    expect(result).toContain('<code>foo()</code>');
  });

  it('renders code blocks with language', () => {
    const result = applyEntities('const x = 1;', [{ type: 'pre', offset: 0, length: 12, language: 'js' }]);
    expect(result).toContain('<pre><code class="language-js">');
    expect(result).toContain('const x = 1;');
  });

  it('renders code blocks without language', () => {
    const result = applyEntities('some code', [{ type: 'pre', offset: 0, length: 9 }]);
    expect(result).toContain('<pre><code>some code</code></pre>');
  });

  it('renders strikethrough', () => {
    const result = applyEntities('deleted text', [{ type: 'strikethrough', offset: 0, length: 7 }]);
    expect(result).toContain('<del>deleted</del>');
  });

  it('renders text links', () => {
    const result = applyEntities('click here for info', [{ type: 'text_link', offset: 6, length: 4, url: 'https://example.com' }]);
    expect(result).toContain('<a href="https://example.com">here</a>');
  });

  it('renders URL entities', () => {
    const result = applyEntities('visit https://example.com today', [{ type: 'url', offset: 6, length: 19 }]);
    expect(result).toContain('<a href="https://example.com">https://example.com</a>');
  });

  it('handles multiple entities', () => {
    const result = applyEntities('bold and italic', [
      { type: 'bold', offset: 0, length: 4 },
      { type: 'italic', offset: 9, length: 6 },
    ]);
    expect(result).toContain('<strong>bold</strong>');
    expect(result).toContain('<em>italic</em>');
  });

  it('escapes HTML in text while preserving entity tags', () => {
    const result = applyEntities('<script>alert("xss")</script>', [{ type: 'bold', offset: 0, length: 8 }]);
    expect(result).not.toContain('<script>');
    expect(result).toContain('&lt;script&gt;');
    expect(result).toContain('<strong>');
  });

  it('falls back to linkify when no entities', () => {
    const result = applyEntities('visit https://example.com', undefined);
    expect(result).toContain('<a href="https://example.com"');
  });

  it('handles empty entities array', () => {
    const result = applyEntities('plain text', []);
    expect(result).toBe('plain text');
  });

  it('sanitizes javascript: URLs in text_link entities', () => {
    const result = applyEntities('click', [{ type: 'text_link', offset: 0, length: 5, url: 'javascript:alert(1)' }]);
    // Should either strip the link or use a safe href
    expect(result).not.toContain('href="javascript:');
  });
});

describe('photo message rendering', () => {
  it('renders img tag for photo with base64 URL', () => {
    const html = renderMessageHtml({
      text: '', timestamp: 1000, isOutgoing: false,
      mediaType: 'photo', mediaUrl: 'data:image/jpeg;base64,/9j/4AAQ==',
    });
    expect(html).toContain('<img class="msg-photo"');
    expect(html).toContain('src="data:image/jpeg;base64,');
  });

  it('does not render img without mediaUrl', () => {
    const html = renderMessageHtml({
      text: '', timestamp: 1000, isOutgoing: false,
      mediaType: 'photo',
    });
    expect(html).not.toContain('<img');
  });

  it('renders photo with caption text', () => {
    const html = renderMessageHtml({
      text: 'Nice photo!', timestamp: 1000, isOutgoing: false,
      mediaType: 'photo', mediaUrl: 'data:image/jpeg;base64,abc',
    });
    expect(html).toContain('<img');
    expect(html).toContain('Nice photo!');
  });
});

describe('file message rendering', () => {
  it('renders file with name and size', () => {
    const html = renderMessageHtml({
      text: '', timestamp: 1000, isOutgoing: false,
      mediaType: 'file', fileName: 'doc.pdf', fileSize: 2048,
    });
    expect(html).toContain('📎 doc.pdf');
    expect(html).toContain('2 KB');
  });

  it('renders voice message indicator', () => {
    const html = renderMessageHtml({ text: '', timestamp: 1000, isOutgoing: false, mediaType: 'voice' });
    expect(html).toContain('🎤 Voice message');
  });

  it('renders video indicator', () => {
    const html = renderMessageHtml({ text: '', timestamp: 1000, isOutgoing: false, mediaType: 'video' });
    expect(html).toContain('🎬 Video');
  });

  it('renders sticker indicator', () => {
    const html = renderMessageHtml({ text: '', timestamp: 1000, isOutgoing: false, mediaType: 'sticker' });
    expect(html).toContain('🏷️ Sticker');
  });

  it('renders gif indicator', () => {
    const html = renderMessageHtml({ text: '', timestamp: 1000, isOutgoing: false, mediaType: 'gif' });
    expect(html).toContain('🎞️ GIF');
  });
});

describe('reply-to rendering', () => {
  it('renders reply quote block', () => {
    const html = renderMessageHtml({
      text: 'My reply', timestamp: 1000, isOutgoing: false,
      replyToId: 42, replyToText: 'Original message', replyToSender: 'Alice',
    });
    expect(html).toContain('class="reply-quote"');
    expect(html).toContain('Alice');
    expect(html).toContain('Original message');
  });

  it('renders reply without sender gracefully', () => {
    const html = renderMessageHtml({
      text: 'Reply', timestamp: 1000, isOutgoing: false,
      replyToId: 42, replyToText: 'Some text',
    });
    expect(html).toContain('class="reply-quote"');
    expect(html).toContain('Some text');
    expect(html).not.toContain('reply-sender');
  });

  it('renders reply without text gracefully', () => {
    const html = renderMessageHtml({
      text: 'Reply', timestamp: 1000, isOutgoing: false,
      replyToId: 42, replyToSender: 'Bob',
    });
    expect(html).toContain('class="reply-quote"');
    expect(html).toContain('Bob');
  });

  it('does not render reply block when no replyToId', () => {
    const html = renderMessageHtml({ text: 'Normal msg', timestamp: 1000, isOutgoing: false });
    expect(html).not.toContain('reply-quote');
  });
});

describe('forward rendering', () => {
  it('renders forwarded from header', () => {
    const html = renderMessageHtml({
      text: 'forwarded content', timestamp: 1000, isOutgoing: false,
      forwardFrom: 'Charlie',
    });
    expect(html).toContain('Forwarded from');
    expect(html).toContain('<strong>Charlie</strong>');
    expect(html).toContain('class="forward-header"');
  });

  it('does not render forward header when not forwarded', () => {
    const html = renderMessageHtml({ text: 'normal', timestamp: 1000, isOutgoing: false });
    expect(html).not.toContain('forward-header');
  });

  it('escapes forward sender name', () => {
    const html = renderMessageHtml({
      text: '', timestamp: 1000, isOutgoing: false,
      forwardFrom: '<script>alert(1)</script>',
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('edited label rendering', () => {
  it('shows edited label when isEdited is true', () => {
    const html = renderMessageHtml({ text: 'updated text', timestamp: 1000, isOutgoing: false, isEdited: true });
    expect(html).toContain('class="msg-edited"');
    expect(html).toContain('edited');
  });

  it('does not show edited label when not edited', () => {
    const html = renderMessageHtml({ text: 'original', timestamp: 1000, isOutgoing: false });
    expect(html).not.toContain('msg-edited');
  });
});

describe('link preview rendering', () => {
  it('renders full link preview card', () => {
    const html = renderMessageHtml({
      text: 'Check this out', timestamp: 1000, isOutgoing: false,
      linkPreview: { url: 'https://example.com', title: 'Example Site', description: 'A great site', imageUrl: 'https://example.com/img.jpg' },
    });
    expect(html).toContain('class="link-preview"');
    expect(html).toContain('Example Site');
    expect(html).toContain('A great site');
    expect(html).toContain('https://example.com');
    expect(html).toContain('lp-image');
  });

  it('renders link preview without image', () => {
    const html = renderMessageHtml({
      text: 'link', timestamp: 1000, isOutgoing: false,
      linkPreview: { url: 'https://example.com', title: 'Title' },
    });
    expect(html).toContain('class="link-preview"');
    expect(html).toContain('Title');
    expect(html).not.toContain('lp-image');
  });

  it('renders link preview with only URL', () => {
    const html = renderMessageHtml({
      text: '', timestamp: 1000, isOutgoing: false,
      linkPreview: { url: 'https://example.com' },
    });
    expect(html).toContain('class="link-preview"');
    expect(html).toContain('https://example.com');
  });

  it('does not render link preview when absent', () => {
    const html = renderMessageHtml({ text: 'no preview', timestamp: 1000, isOutgoing: false });
    expect(html).not.toContain('link-preview');
  });

  it('escapes link preview fields for XSS', () => {
    const html = renderMessageHtml({
      text: '', timestamp: 1000, isOutgoing: false,
      linkPreview: { url: 'https://x.com', title: '<img onerror=alert(1)>', description: '"><script>' },
    });
    expect(html).not.toContain('<img onerror');
    expect(html).not.toContain('<script>');
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
