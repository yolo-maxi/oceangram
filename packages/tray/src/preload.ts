// preload.ts — Secure IPC bridge via contextBridge
import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';
import {
  TelegramMessage,
  TelegramUser,
  TelegramDialog,
  WhitelistEntry,
  BlacklistEntry,
  AppSettings,
  PopupInitData,
  BubbleInitData,
  BubbleUpdateData,
  NewMessageEvent,
} from './types';

contextBridge.exposeInMainWorld('oceangram', {
  // Chat messages
  getMessages: (dialogId: string, limit?: number, offsetId?: number): Promise<TelegramMessage[]> =>
    ipcRenderer.invoke('get-messages', dialogId, limit, offsetId),
  sendMessage: (dialogId: string, text: string, replyTo?: number): Promise<unknown> =>
    ipcRenderer.invoke('send-message', dialogId, text, replyTo),
  sendFile: (dialogId: string, data: string, fileName: string, mimeType?: string, caption?: string): Promise<unknown> =>
    ipcRenderer.invoke('send-file', dialogId, data, fileName, mimeType, caption),
  markRead: (dialogId: string, messageId?: number): Promise<boolean> =>
    ipcRenderer.invoke('mark-read', dialogId, messageId),
  getDialogInfo: (dialogId: string): Promise<TelegramDialog | null> =>
    ipcRenderer.invoke('get-dialog-info', dialogId),
  getProfilePhoto: (userId: string): Promise<string | null> =>
    ipcRenderer.invoke('get-profile-photo', userId),
  getMedia: (dialogId: string, messageId: number): Promise<string | null> =>
    ipcRenderer.invoke('get-media', dialogId, messageId),
  getMembers: (dialogId: string, limit?: number, q?: string): Promise<{ members: Array<{ userId: string; firstName: string; lastName: string; username: string; role: string }>; count: number } | null> =>
    ipcRenderer.invoke('get-members', dialogId, limit, q),
  closePopup: (): void => ipcRenderer.send('close-popup'),

  // Whitelist / Settings
  getWhitelist: (): Promise<WhitelistEntry[]> =>
    ipcRenderer.invoke('get-whitelist'),
  addUser: (user: { userId: string; username?: string; displayName?: string }): Promise<boolean> =>
    ipcRenderer.invoke('add-user', user),
  removeUser: (userId: string): Promise<boolean> =>
    ipcRenderer.invoke('remove-user', userId),
  getBlacklist: (): Promise<BlacklistEntry[]> =>
    ipcRenderer.invoke('get-blacklist'),
  unmuteChat: (dialogId: string): Promise<boolean> =>
    ipcRenderer.invoke('unmute-chat', dialogId),
  getSettings: (): Promise<AppSettings> =>
    ipcRenderer.invoke('get-settings'),
  updateSettings: (settings: Partial<AppSettings>): Promise<boolean> =>
    ipcRenderer.invoke('update-settings', settings),
  getDialogs: (limit?: number): Promise<TelegramDialog[]> =>
    ipcRenderer.invoke('get-dialogs', limit),
  getDaemonStatus: (): Promise<boolean> =>
    ipcRenderer.invoke('get-daemon-status'),
  getMe: (): Promise<TelegramUser | null> =>
    ipcRenderer.invoke('get-me'),

  // Unread counts
  getUnreadCounts: (): Promise<Record<string, number>> =>
    ipcRenderer.invoke('get-unread-counts'),

  // Active chats (sent recently + has unreads)
  getActiveChats: (): Promise<Array<{ dialogId: string; displayName: string }>> =>
    ipcRenderer.invoke('get-active-chats'),

  // Events from main → renderer
  onNewMessage: (cb: (data: NewMessageEvent) => void): void => {
    ipcRenderer.on('new-message', (_: IpcRendererEvent, data: NewMessageEvent) => cb(data));
  },
  onMessagesUpdated: (cb: (data: unknown) => void): void => {
    ipcRenderer.on('messages-updated', (_: IpcRendererEvent, data: unknown) => cb(data));
  },
  onConnectionChanged: (cb: (status: boolean) => void): void => {
    ipcRenderer.on('connection-changed', (_: IpcRendererEvent, status: boolean) => cb(status));
  },
  onUnreadCountsUpdated: (cb: (counts: Record<string, number>) => void): void => {
    ipcRenderer.on('unread-counts-updated', (_: IpcRendererEvent, counts: Record<string, number>) => cb(counts));
  },
  onSelectDialog: (cb: (dialogId: string) => void): void => {
    ipcRenderer.on('select-dialog', (_: IpcRendererEvent, dialogId: string) => cb(dialogId));
  },
  onActiveChatsChanged: (cb: (chats: Array<{ dialogId: string; displayName: string }>) => void): void => {
    ipcRenderer.on('active-chats-changed', (_: IpcRendererEvent, chats: Array<{ dialogId: string; displayName: string }>) => cb(chats));
  },
  onTyping: (cb: (data: { dialogId: string; userId: string; action: string }) => void): void => {
    ipcRenderer.on('typing', (_: IpcRendererEvent, data: { dialogId: string; userId: string; action: string }) => cb(data));
  },
  // Debug: check if WS is connected
  getDaemonWsStatus: (): Promise<{ connected: boolean; wsUrl: string }> =>
    ipcRenderer.invoke('get-daemon-ws-status'),
  togglePin: (): Promise<boolean> =>
    ipcRenderer.invoke('toggle-pin'),
  getPinned: (): Promise<boolean> =>
    ipcRenderer.invoke('get-pinned'),

  // Bubble-specific (kept for backward compat)
  getBubbleData: (): Promise<Record<string, { displayName: string; count: number }>> =>
    ipcRenderer.invoke('get-bubble-data'),
  bubbleClicked: (userId: string): void => ipcRenderer.send('bubble-clicked', userId),
  onBubbleInit: (cb: (data: BubbleInitData) => void): void => {
    ipcRenderer.on('bubble-init', (_: IpcRendererEvent, data: BubbleInitData) => cb(data));
  },
  onBubbleUpdate: (cb: (data: BubbleUpdateData) => void): void => {
    ipcRenderer.on('bubble-update', (_: IpcRendererEvent, data: BubbleUpdateData) => cb(data));
  },

  // Popup-specific (legacy)
  onPopupInit: (cb: (data: PopupInitData) => void): void => {
    ipcRenderer.on('popup-init', (_: IpcRendererEvent, data: PopupInitData) => cb(data));
  },

  // Tab context menu
  showTabContextMenu: (dialogId: string, displayName: string, isPinned: boolean): void =>
    ipcRenderer.send('show-tab-context-menu', dialogId, displayName, isPinned),

  // Sender context menu (right-click on avatar in group chat)
  showSenderContextMenu: (userId: string, displayName: string): void =>
    ipcRenderer.send('show-sender-context-menu', userId, displayName),
  onOpenDirectChat: (cb: (data: { dialogId: string; displayName: string }) => void): void => {
    ipcRenderer.on('open-direct-chat', (_: IpcRendererEvent, data: { dialogId: string; displayName: string }) => cb(data));
  },

  // Whitelist changed (from main process after context menu action)
  onWhitelistChanged: (cb: () => void): void => {
    ipcRenderer.on('whitelist-changed', () => cb());
  },

  // Blacklist changed (mute/unmute)
  onBlacklistChanged: (cb: () => void): void => {
    ipcRenderer.on('blacklist-changed', () => cb());
  },

  // Window control
  startDrag: (): void => ipcRenderer.send('start-drag'),
  openSettings: (): void => ipcRenderer.send('open-settings'),

  // Login
  loginSuccess: (): void => ipcRenderer.send('login-success'),

  // GitHub PR
  fetchGitHubPR: (owner: string, repo: string, prNumber: number): Promise<unknown> =>
    ipcRenderer.invoke('fetch-github-pr', owner, repo, prNumber),
  mergeGitHubPR: (owner: string, repo: string, prNumber: number): Promise<unknown> =>
    ipcRenderer.invoke('merge-github-pr', owner, repo, prNumber),

  // OpenClaw agent status (feature-flagged)
  openclawEnabled: (): Promise<boolean> =>
    ipcRenderer.invoke('openclaw-enabled'),
  openclawGetStatus: (): Promise<{ model: string; activeSessions: number; totalTokens: number; estimatedCost: number } | null> =>
    ipcRenderer.invoke('openclaw-get-status'),
  openclawGetSession: (dialogId: string): Promise<{ sessionKey: string; model: string; totalTokens: number; contextWindow: number; contextUsedPct: number; updatedAt: number; displayName: string } | null> =>
    ipcRenderer.invoke('openclaw-get-session', dialogId),

  // Theme change notification (settings → main → popup)
  notifyThemeChanged: (theme: string): void => ipcRenderer.send('theme-changed', theme),
  onThemeChanged: (cb: (theme: string) => void): void => {
    ipcRenderer.on('theme-changed', (_: IpcRendererEvent, theme: string) => cb(theme));
  },
});
