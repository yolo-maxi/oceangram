// renderer.d.ts — Type declarations for the renderer process (window.oceangram)
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

interface OceangramAPI {
  // Chat messages
  getMessages(dialogId: string, limit?: number): Promise<TelegramMessage[]>;
  sendMessage(dialogId: string, text: string): Promise<unknown>;
  markRead(dialogId: string): Promise<boolean>;
  getDialogInfo(dialogId: string): Promise<TelegramDialog | null>;
  getProfilePhoto(userId: string): Promise<string | null>;
  closePopup(): void;

  // Whitelist / Settings
  getWhitelist(): Promise<WhitelistEntry[]>;
  addUser(user: { userId: string; username?: string; displayName?: string }): Promise<boolean>;
  removeUser(userId: string): Promise<boolean>;
  getSettings(): Promise<AppSettings>;
  updateSettings(settings: Partial<AppSettings>): Promise<boolean>;
  getDialogs(limit?: number): Promise<TelegramDialog[]>;
  getDaemonStatus(): Promise<boolean>;
  getMe(): Promise<TelegramUser | null>;

  // Unread counts
  getUnreadCounts(): Promise<Record<string, number>>;

  // Active chats (sent recently + has unreads)
  getActiveChats(): Promise<Array<{ dialogId: string; displayName: string }>>;

  // Events from main → renderer
  onNewMessage(cb: (data: NewMessageEvent) => void): void;
  onMessagesUpdated(cb: (data: unknown) => void): void;
  onConnectionChanged(cb: (status: boolean) => void): void;
  onUnreadCountsUpdated(cb: (counts: Record<string, number>) => void): void;
  onSelectDialog(cb: (dialogId: string) => void): void;
  onActiveChatsChanged(cb: (chats: Array<{ dialogId: string; displayName: string }>) => void): void;

  // Bubble-specific (legacy)
  getBubbleData(): Promise<Record<string, { displayName: string; count: number }>>;
  bubbleClicked(userId: string): void;
  onBubbleInit(cb: (data: BubbleInitData) => void): void;
  onBubbleUpdate(cb: (data: BubbleUpdateData) => void): void;

  // Popup-specific (legacy)
  onPopupInit(cb: (data: PopupInitData) => void): void;

  // Window control
  startDrag(): void;
  openSettings(): void;

  // Login
  loginSuccess(): void;
  closeLogin?(): void;
}

declare global {
  interface Window {
    oceangram: OceangramAPI;
  }
}

export {};
