import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock vscode
vi.mock('vscode', () => {
  const panels: any[] = [];
  return {
    window: {
      createWebviewPanel: vi.fn((_viewType: string, title: string) => {
        const panel = {
          webview: {
            html: '',
            onDidReceiveMessage: vi.fn(),
            postMessage: vi.fn(),
          },
          onDidDispose: vi.fn(),
          reveal: vi.fn(),
          dispose: vi.fn(),
          title,
        };
        panels.push(panel);
        return panel;
      }),
    },
    commands: {
      registerCommand: vi.fn((_cmd: string, _cb: Function) => ({ dispose: vi.fn() })),
    },
    ViewColumn: { One: 1, Two: 2, Active: -1 },
    Uri: {
      file: vi.fn((f: string) => ({ fsPath: f })),
    },
    __panels: panels,
  };
});

// Mock telegram service
vi.mock('../services/telegram', () => {
  return {
    TelegramService: vi.fn().mockImplementation(() => ({
      connect: vi.fn(),
      disconnect: vi.fn(),
      getDialogs: vi.fn().mockResolvedValue([]),
      searchDialogs: vi.fn().mockResolvedValue([]),
      getMessages: vi.fn().mockResolvedValue([]),
      sendMessage: vi.fn(),
      getPinnedIds: vi.fn().mockReturnValue([]),
      pinDialog: vi.fn(),
      unpinDialog: vi.fn(),
    })),
  };
});

import * as vscode from 'vscode';

describe('CommsPicker', () => {
  let CommsPicker: any;
  let ChatTab: any;

  beforeEach(async () => {
    vi.resetModules();
    // Re-import to reset static state
    const mod = await import('../commsPanel');
    CommsPicker = mod.CommsPicker;
    ChatTab = mod.ChatTab;
  });

  const mockContext = {
    subscriptions: [],
    extensionPath: '/test',
  } as any;

  it('creates a webview panel on show', () => {
    CommsPicker.show(mockContext);
    expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
      'oceangram.commsPicker',
      '💬 Chats',
      1, // ViewColumn.One
      expect.objectContaining({ enableScripts: true }),
    );
  });

  it('reveals existing panel on second show call', () => {
    CommsPicker.show(mockContext);
    const firstCallCount = (vscode.window.createWebviewPanel as any).mock.calls.length;
    CommsPicker.show(mockContext);
    // Should not create a new panel
    expect((vscode.window.createWebviewPanel as any).mock.calls.length).toBe(firstCallCount);
  });
});

describe('ChatTab', () => {
  let ChatTab: any;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../commsPanel');
    ChatTab = mod.ChatTab;
  });

  const mockContext = {
    subscriptions: [],
    extensionPath: '/test',
  } as any;

  it('creates a panel with correct title', () => {
    ChatTab.createOrShow('123', 'TestChat', mockContext);
    expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
      'oceangram.chat',
      '💬 TestChat',
      -1, // ViewColumn.Active
      expect.objectContaining({ enableScripts: true }),
    );
  });

  it('creates panels for different chat IDs', () => {
    ChatTab.createOrShow('111', 'Chat A', mockContext);
    ChatTab.createOrShow('222', 'Chat B', mockContext);
    const calls = (vscode.window.createWebviewPanel as any).mock.calls;
    const chatCalls = calls.filter((c: any[]) => c[0] === 'oceangram.chat');
    expect(chatCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('reuses existing panel for same chat ID', () => {
    ChatTab.createOrShow('333', 'Same Chat', mockContext);
    const count1 = (vscode.window.createWebviewPanel as any).mock.calls.length;
    ChatTab.createOrShow('333', 'Same Chat', mockContext);
    const count2 = (vscode.window.createWebviewPanel as any).mock.calls.length;
    expect(count2).toBe(count1); // no new panel created
  });

  it('creates panel with topic dialog ID', () => {
    ChatTab.createOrShow('123:45', 'Forum / Topic', mockContext);
    expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
      'oceangram.chat',
      '💬 Forum / Topic',
      -1,
      expect.objectContaining({ enableScripts: true }),
    );
  });
});
