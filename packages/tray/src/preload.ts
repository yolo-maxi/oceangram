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
  // Chat popup
  getMessages: (dialogId: string, limit?: number): Promise<TelegramMessage[]> =>
    ipcRenderer.invoke('get-messages', dialogId, limit),
  sendMessage: (dialogId: string, text: string): Promise<unknown> =>
    ipcRenderer.invoke('send-message', dialogId, text),
  markRead: (userId: string): Promise<boolean> =>
    ipcRenderer.invoke('mark-read', userId),
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
  getDialogs: (): Promise<TelegramDialog[]> =>
    ipcRenderer.invoke('get-dialogs'),
  getDaemonStatus: (): Promise<boolean> =>
    ipcRenderer.invoke('get-daemon-status'),
  getMe: (): Promise<TelegramUser | null> =>
    ipcRenderer.invoke('get-me'),

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

  // Bubble-specific
  getBubbleData: (): Promise<Record<string, { displayName: string; count: number }>> =>
    ipcRenderer.invoke('get-bubble-data'),
  bubbleClicked: (userId: string): void => ipcRenderer.send('bubble-clicked', userId),
  onBubbleInit: (cb: (data: BubbleInitData) => void): void => {
    ipcRenderer.on('bubble-init', (_: IpcRendererEvent, data: BubbleInitData) => cb(data));
  },
  onBubbleUpdate: (cb: (data: BubbleUpdateData) => void): void => {
    ipcRenderer.on('bubble-update', (_: IpcRendererEvent, data: BubbleUpdateData) => cb(data));
  },

  // Popup-specific
  onPopupInit: (cb: (data: PopupInitData) => void): void => {
    ipcRenderer.on('popup-init', (_: IpcRendererEvent, data: PopupInitData) => cb(data));
  },

  // Window control
  startDrag: (): void => ipcRenderer.send('start-drag'),

  // Login
  loginSuccess: (): void => ipcRenderer.send('login-success'),
});
