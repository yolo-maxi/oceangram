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
  // Chat popup
  getMessages(dialogId: string, limit?: number): Promise<TelegramMessage[]>;
  sendMessage(dialogId: string, text: string): Promise<unknown>;
  markRead(userId: string): Promise<boolean>;
  getDialogInfo(dialogId: string): Promise<TelegramDialog | null>;
  getProfilePhoto(userId: string): Promise<string | null>;
  closePopup(): void;

  // Whitelist / Settings
  getWhitelist(): Promise<WhitelistEntry[]>;
  addUser(user: { userId: string; username?: string; displayName?: string }): Promise<boolean>;
  removeUser(userId: string): Promise<boolean>;
  getSettings(): Promise<AppSettings>;
  updateSettings(settings: Partial<AppSettings>): Promise<boolean>;
  getDialogs(): Promise<TelegramDialog[]>;
  getDaemonStatus(): Promise<boolean>;
  getMe(): Promise<TelegramUser | null>;

  // Events from main → renderer
  onNewMessage(cb: (data: NewMessageEvent) => void): void;
  onMessagesUpdated(cb: (data: unknown) => void): void;
  onConnectionChanged(cb: (status: boolean) => void): void;

  // Bubble-specific
  getBubbleData(): Promise<Record<string, { displayName: string; count: number }>>;
  bubbleClicked(userId: string): void;
  onBubbleInit(cb: (data: BubbleInitData) => void): void;
  onBubbleUpdate(cb: (data: BubbleUpdateData) => void): void;

  // Popup-specific
  onPopupInit(cb: (data: PopupInitData) => void): void;

  // Window control
  startDrag(): void;

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
