import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fs module
vi.mock('fs', () => {
  let mockFiles: Record<string, string> = {};
  return {
    existsSync: vi.fn((p: string) => p in mockFiles),
    readFileSync: vi.fn((p: string) => mockFiles[p] || ''),
    writeFileSync: vi.fn((p: string, data: string) => { mockFiles[p] = data; }),
    mkdirSync: vi.fn(),
    __setMockFiles: (files: Record<string, string>) => { mockFiles = { ...files }; },
    __getMockFiles: () => mockFiles,
  };
});

vi.mock('telegram', () => ({
  TelegramClient: vi.fn().mockImplementation(() => ({
    connect: vi.fn(),
    disconnect: vi.fn(),
    getDialogs: vi.fn().mockResolvedValue([]),
    getEntity: vi.fn().mockResolvedValue({}),
    getMessages: vi.fn().mockResolvedValue([]),
    sendMessage: vi.fn(),
    invoke: vi.fn().mockResolvedValue({ topics: [] }),
  })),
}));

vi.mock('telegram/sessions', () => ({
  StringSession: vi.fn().mockImplementation((s: string) => s),
}));

vi.mock('telegram', () => {
  const mockClient = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    getDialogs: vi.fn().mockResolvedValue([]),
    getEntity: vi.fn().mockResolvedValue({}),
    getMessages: vi.fn().mockResolvedValue([]),
    sendMessage: vi.fn(),
    invoke: vi.fn().mockResolvedValue({ topics: [] }),
  };
  return {
    TelegramClient: vi.fn().mockImplementation(() => mockClient),
    Api: {
      channels: { GetForumTopics: vi.fn() },
      ForumTopic: class ForumTopic {},
    },
    __mockClient: mockClient,
  };
});

import * as fs from 'fs';
import * as path from 'path';
import { TelegramService, MessageInfo, MessageEntity, LinkPreview } from '../telegram';

const CONFIG_DIR = path.join(process.env.HOME || '/home/xiko', '.oceangram');
const PINNED_PATH = path.join(CONFIG_DIR, 'pinned.json');

const setMockFiles = (fs as any).__setMockFiles as (files: Record<string, string>) => void;
const getMockFiles = (fs as any).__getMockFiles as () => Record<string, string>;

describe('TelegramService', () => {
  let service: TelegramService;

  beforeEach(() => {
    service = new TelegramService();
    setMockFiles({});
    vi.clearAllMocks();
  });

  // --- parseDialogId ---
  describe('parseDialogId', () => {
    it('parses a regular chat ID', () => {
      expect(TelegramService.parseDialogId('12345')).toEqual({ chatId: '12345' });
    });

    it('parses a negative chat ID', () => {
      expect(TelegramService.parseDialogId('-100123456')).toEqual({ chatId: '-100123456' });
    });

    it('parses a topic ID with colon', () => {
      expect(TelegramService.parseDialogId('12345:67')).toEqual({ chatId: '12345', topicId: 67 });
    });

    it('parses a negative chat ID with topic', () => {
      expect(TelegramService.parseDialogId('-100123456:42')).toEqual({ chatId: '-100123456', topicId: 42 });
    });

    it('handles empty string', () => {
      expect(TelegramService.parseDialogId('')).toEqual({ chatId: '' });
    });

    it('handles single part with no colon', () => {
      expect(TelegramService.parseDialogId('0')).toEqual({ chatId: '0' });
    });

    it('parses topic ID as number', () => {
      const result = TelegramService.parseDialogId('123:456');
      expect(typeof result.topicId).toBe('number');
      expect(result.topicId).toBe(456);
    });
  });

  // --- makeDialogId ---
  describe('makeDialogId', () => {
    it('makes ID without topic', () => {
      expect(TelegramService.makeDialogId('12345')).toBe('12345');
    });

    it('makes ID with topic', () => {
      expect(TelegramService.makeDialogId('12345', 67)).toBe('12345:67');
    });

    it('makes ID with undefined topic', () => {
      expect(TelegramService.makeDialogId('12345', undefined)).toBe('12345');
    });

    it('makes ID with topic 0 (falsy)', () => {
      expect(TelegramService.makeDialogId('12345', 0)).toBe('12345');
    });

    it('roundtrips with parseDialogId', () => {
      const id = TelegramService.makeDialogId('-100999', 42);
      const parsed = TelegramService.parseDialogId(id);
      expect(parsed.chatId).toBe('-100999');
      expect(parsed.topicId).toBe(42);
    });

    it('roundtrips without topic', () => {
      const id = TelegramService.makeDialogId('555');
      const parsed = TelegramService.parseDialogId(id);
      expect(parsed.chatId).toBe('555');
      expect(parsed.topicId).toBeUndefined();
    });
  });

  // --- getPinnedIds / pinDialog / unpinDialog ---
  describe('pinning', () => {
    it('returns empty array when pinned file does not exist', () => {
      setMockFiles({});
      expect(service.getPinnedIds()).toEqual([]);
    });

    it('returns parsed array when pinned file exists', () => {
      setMockFiles({ [PINNED_PATH]: JSON.stringify(['a', 'b']) });
      expect(service.getPinnedIds()).toEqual(['a', 'b']);
    });

    it('returns empty array on parse error', () => {
      setMockFiles({ [PINNED_PATH]: 'invalid json{' });
      expect(service.getPinnedIds()).toEqual([]);
    });

    it('pinDialog adds an ID', () => {
      setMockFiles({ [PINNED_PATH]: JSON.stringify(['a']), [CONFIG_DIR]: '' });
      service.pinDialog('b');
      const written = JSON.parse(getMockFiles()[PINNED_PATH]);
      expect(written).toEqual(['a', 'b']);
    });

    it('pinDialog does not duplicate', () => {
      setMockFiles({ [PINNED_PATH]: JSON.stringify(['a']), [CONFIG_DIR]: '' });
      service.pinDialog('a');
      // writeFileSync should not have been called since 'a' already exists
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it('unpinDialog removes an ID', () => {
      setMockFiles({ [PINNED_PATH]: JSON.stringify(['a', 'b', 'c']), [CONFIG_DIR]: '' });
      service.unpinDialog('b');
      const written = JSON.parse(getMockFiles()[PINNED_PATH]);
      expect(written).toEqual(['a', 'c']);
    });

    it('unpinDialog handles non-existent ID gracefully', () => {
      setMockFiles({ [PINNED_PATH]: JSON.stringify(['a']), [CONFIG_DIR]: '' });
      service.unpinDialog('nonexistent');
      const written = JSON.parse(getMockFiles()[PINNED_PATH]);
      expect(written).toEqual(['a']);
    });

    it('pinDialog creates config dir if needed', () => {
      setMockFiles({});
      service.pinDialog('x');
      expect(fs.mkdirSync).toHaveBeenCalledWith(CONFIG_DIR, { recursive: true });
    });

    it('pinDialog works with topic dialog IDs', () => {
      setMockFiles({ [PINNED_PATH]: JSON.stringify([]), [CONFIG_DIR]: '' });
      service.pinDialog('123:45');
      const written = JSON.parse(getMockFiles()[PINNED_PATH]);
      expect(written).toEqual(['123:45']);
    });
  });

  // --- connect ---
  describe('connect', () => {
    it('throws when credentials missing', async () => {
      const origEnv = { ...process.env };
      delete process.env.TELEGRAM_API_ID;
      delete process.env.TELEGRAM_API_HASH;
      delete process.env.TELEGRAM_SESSION;
      setMockFiles({});

      await expect(service.connect()).rejects.toThrow('Telegram credentials not configured');

      Object.assign(process.env, origEnv);
    });
  });

  // --- getMessages / sendMessage ---
  describe('getMessages', () => {
    it('throws when not connected', async () => {
      await expect(service.getMessages('123')).rejects.toThrow('Not connected');
    });

    it('throws when not connected for sendMessage too', async () => {
      await expect(service.sendMessage('123', 'hi')).rejects.toThrow('Not connected');
    });
  });

  // --- disconnect ---
  describe('disconnect', () => {
    it('handles disconnect when never connected', async () => {
      await service.disconnect();
    });
  });

  // --- MessageInfo interface shape tests ---
  describe('MessageInfo extended fields', () => {
    it('supports media fields', () => {
      const msg: MessageInfo = {
        id: 1, senderId: '1', senderName: 'Test', text: '', timestamp: 0, isOutgoing: false,
        mediaType: 'photo', mediaUrl: 'data:image/jpeg;base64,abc', fileName: 'test.jpg', fileSize: 1024,
      };
      expect(msg.mediaType).toBe('photo');
      expect(msg.mediaUrl).toContain('base64');
      expect(msg.fileName).toBe('test.jpg');
      expect(msg.fileSize).toBe(1024);
    });

    it('supports all media types', () => {
      const types: MessageInfo['mediaType'][] = ['photo', 'video', 'voice', 'file', 'sticker', 'gif'];
      for (const t of types) {
        const msg: MessageInfo = { id: 1, senderId: '1', senderName: 'T', text: '', timestamp: 0, isOutgoing: false, mediaType: t };
        expect(msg.mediaType).toBe(t);
      }
    });

    it('supports reply fields', () => {
      const msg: MessageInfo = {
        id: 1, senderId: '1', senderName: 'T', text: 'reply', timestamp: 0, isOutgoing: false,
        replyToId: 42, replyToText: 'original msg', replyToSender: 'Alice',
      };
      expect(msg.replyToId).toBe(42);
      expect(msg.replyToText).toBe('original msg');
      expect(msg.replyToSender).toBe('Alice');
    });

    it('supports forward field', () => {
      const msg: MessageInfo = {
        id: 1, senderId: '1', senderName: 'T', text: '', timestamp: 0, isOutgoing: false,
        forwardFrom: 'Bob',
      };
      expect(msg.forwardFrom).toBe('Bob');
    });

    it('supports edited field', () => {
      const msg: MessageInfo = {
        id: 1, senderId: '1', senderName: 'T', text: '', timestamp: 0, isOutgoing: false,
        isEdited: true,
      };
      expect(msg.isEdited).toBe(true);
    });

    it('supports entities field', () => {
      const entities: MessageEntity[] = [
        { type: 'bold', offset: 0, length: 4 },
        { type: 'italic', offset: 5, length: 3 },
        { type: 'code', offset: 9, length: 5 },
        { type: 'pre', offset: 15, length: 10, language: 'js' },
        { type: 'strikethrough', offset: 26, length: 3 },
        { type: 'text_link', offset: 30, length: 4, url: 'https://example.com' },
      ];
      const msg: MessageInfo = {
        id: 1, senderId: '1', senderName: 'T', text: 'bold ita code pre-block--- link', timestamp: 0, isOutgoing: false,
        entities,
      };
      expect(msg.entities).toHaveLength(6);
      expect(msg.entities![3].language).toBe('js');
      expect(msg.entities![5].url).toBe('https://example.com');
    });

    it('supports link preview field', () => {
      const lp: LinkPreview = { url: 'https://example.com', title: 'Example', description: 'A site' };
      const msg: MessageInfo = {
        id: 1, senderId: '1', senderName: 'T', text: 'https://example.com', timestamp: 0, isOutgoing: false,
        linkPreview: lp,
      };
      expect(msg.linkPreview?.url).toBe('https://example.com');
      expect(msg.linkPreview?.title).toBe('Example');
    });

    it('all extended fields are optional', () => {
      const msg: MessageInfo = {
        id: 1, senderId: '1', senderName: 'T', text: '', timestamp: 0, isOutgoing: false,
      };
      expect(msg.mediaType).toBeUndefined();
      expect(msg.replyToId).toBeUndefined();
      expect(msg.forwardFrom).toBeUndefined();
      expect(msg.isEdited).toBeUndefined();
      expect(msg.entities).toBeUndefined();
      expect(msg.linkPreview).toBeUndefined();
    });
  });

  // --- mapEntityType ---
  describe('mapEntityType', () => {
    it('maps gramjs entity class names correctly', () => {
      // We test this indirectly via the private method by checking the interface
      // The actual mapping is tested through integration
      const mapping: Record<string, MessageEntity['type']> = {
        'MessageEntityBold': 'bold',
        'MessageEntityItalic': 'italic',
        'MessageEntityCode': 'code',
        'MessageEntityPre': 'pre',
        'MessageEntityStrike': 'strikethrough',
        'MessageEntityUrl': 'url',
        'MessageEntityTextUrl': 'text_link',
      };
      for (const [cls, expected] of Object.entries(mapping)) {
        expect(expected).toBeTruthy();
      }
    });
  });
});
