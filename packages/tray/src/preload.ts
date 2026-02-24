// preload.ts — Secure IPC bridge via contextBridge
import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';
import {
  TelegramMessage,
  TelegramUser,
  TelegramDialog,
  WhitelistEntry,
  AppSettings,
  PopupInitData,
  BubbleInitData,
  BubbleUpdateData,
  NewMessageEvent,
} from './types';

contextBridge.exposeInMainWorld('oceangram', {
  // Chat messages
  getMessages: (dialogId: string, limit?: number): Promise<TelegramMessage[]> =>
    ipcRenderer.invoke('get-messages', dialogId, limit),
  sendMessage: (dialogId: string, text: string, replyTo?: number): Promise<unknown> =>
    ipcRenderer.invoke('send-message', dialogId, text, replyTo),
  sendFile: (dialogId: string, data: string, fileName: string, mimeType?: string, caption?: string): Promise<unknown> =>
    ipcRenderer.invoke('send-file', dialogId, data, fileName, mimeType, caption),
  markRead: (dialogId: string): Promise<boolean> =>
    ipcRenderer.invoke('mark-read', dialogId),
  getDialogInfo: (dialogId: string): Promise<TelegramDialog | null> =>
    ipcRenderer.invoke('get-dialog-info', dialogId),
  getProfilePhoto: (userId: string): Promise<string | null> =>
    ipcRenderer.invoke('get-profile-photo', userId),
  closePopup: (): void => ipcRenderer.send('close-popup'),

  // Whitelist / Settings
  getWhitelist: (): Promise<WhitelistEntry[]> =>
    ipcRenderer.invoke('get-whitelist'),
  addUser: (user: { userId: string; username?: string; displayName?: string }): Promise<boolean> =>
    ipcRenderer.invoke('add-user', user),
  removeUser: (userId: string): Promise<boolean> =>
    ipcRenderer.invoke('remove-user', userId),
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
});
