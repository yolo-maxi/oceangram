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
  file: vi.fn((f: string) => ({ fsPath: f, scheme: 'file', path: f, with: vi.fn((o: any) => ({ ...o, fsPath: o.path || f, scheme: o.scheme || 'file' })) })),
  parse: vi.fn((s: string) => ({ toString: () => s })),
  joinPath: vi.fn((base: any, ...segments: string[]) => {
    const p = [base.path || base.fsPath, ...segments].join('/');
    return { fsPath: p, path: p, scheme: base.scheme || 'file' };
  }),
  from: vi.fn((o: any) => ({ ...o, fsPath: o.path })),
};

export const workspace = {
  workspaceFolders: [{ uri: { scheme: 'file', path: '/home/xiko', fsPath: '/home/xiko', with: vi.fn((o: any) => ({ ...o })) } }],
  fs: {
    readFile: vi.fn(async () => Buffer.from('{}')),
    writeFile: vi.fn(async () => {}),
    stat: vi.fn(async () => ({ type: 1, ctime: 0, mtime: Date.now(), size: 100 })),
    readDirectory: vi.fn(async () => []),
  },
  getConfiguration: vi.fn(() => ({
    get: vi.fn((_key: string, defaultValue: any) => defaultValue),
  })),
  createFileSystemWatcher: vi.fn(() => ({
    onDidChange: vi.fn(),
    onDidCreate: vi.fn(),
    onDidDelete: vi.fn(),
    dispose: vi.fn(),
  })),
};

export const FileType = {
  Unknown: 0,
  File: 1,
  Directory: 2,
  SymbolicLink: 64,
};

export const RelativePattern = vi.fn((base: any, pattern: string) => ({ base, pattern }));

export const env = {
  clipboard: { writeText: vi.fn() },
  openExternal: vi.fn(),
};

export type ExtensionContext = {
  subscriptions: { dispose: () => void }[];
  extensionPath: string;
  globalStorageUri: { fsPath: string };
};
