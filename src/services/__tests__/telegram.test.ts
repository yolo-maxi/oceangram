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
import { TelegramService } from '../telegram';

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
});
