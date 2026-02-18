import { vi } from 'vitest';

const mockWebviewPanel = {
  webview: {
    html: '',
    onDidReceiveMessage: vi.fn(),
    postMessage: vi.fn(),
  },
  onDidDispose: vi.fn(),
  reveal: vi.fn(),
  dispose: vi.fn(),
  title: '',
};

export const window = {
  createWebviewPanel: vi.fn((_viewType: string, title: string) => {
    const panel = { ...mockWebviewPanel, title, webview: { ...mockWebviewPanel.webview } };
    return panel;
  }),
  showInformationMessage: vi.fn(),
  showErrorMessage: vi.fn(),
};

export const commands = {
  registerCommand: vi.fn((_cmd: string, _cb: Function) => ({ dispose: vi.fn() })),
};

export const ViewColumn = { One: 1, Two: 2, Active: -1 };

export const Uri = {
  file: vi.fn((f: string) => ({ fsPath: f, scheme: 'file' })),
  parse: vi.fn((s: string) => ({ toString: () => s })),
};

export type ExtensionContext = {
  subscriptions: { dispose: () => void }[];
  extensionPath: string;
};
