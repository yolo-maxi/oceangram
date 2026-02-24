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

interface GitHubPR {
  number: number;
  title: string;
  state: string; // 'open' | 'closed'
  merged: boolean;
  user: { login: string };
  additions: number;
  deletions: number;
  html_url: string;
}

interface GitHubMergeResult {
  merged: boolean;
  message: string;
}

interface OceangramAPI {
  // Chat messages
  getMessages(dialogId: string, limit?: number, offsetId?: number): Promise<TelegramMessage[]>;
  sendMessage(dialogId: string, text: string, replyTo?: number): Promise<unknown>;
  sendFile(dialogId: string, data: string, fileName: string, mimeType?: string, caption?: string): Promise<unknown>;
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
  onTyping(cb: (data: { dialogId: string; userId: string; action: string }) => void): void;
  getDaemonWsStatus(): Promise<{ connected: boolean; wsUrl: string }>;
  togglePin(): Promise<boolean>;
  getPinned(): Promise<boolean>;

  // Bubble-specific (legacy)
  getBubbleData(): Promise<Record<string, { displayName: string; count: number }>>;
  bubbleClicked(userId: string): void;
  onBubbleInit(cb: (data: BubbleInitData) => void): void;
  onBubbleUpdate(cb: (data: BubbleUpdateData) => void): void;

  // Popup-specific (legacy)
  onPopupInit(cb: (data: PopupInitData) => void): void;

  // Tab context menu
  showTabContextMenu(dialogId: string, displayName: string, isPinned: boolean): void;

  // Whitelist changed notification
  onWhitelistChanged(cb: () => void): void;

  // Window control
  startDrag(): void;
  openSettings(): void;

  // Login
  loginSuccess(): void;
  closeLogin?(): void;

  // GitHub PR
  fetchGitHubPR(owner: string, repo: string, prNumber: number): Promise<GitHubPR>;
  mergeGitHubPR(owner: string, repo: string, prNumber: number): Promise<GitHubMergeResult>;

  // OpenClaw AI enrichments (feature-flagged)
  openclawEnabled(): Promise<boolean>;
  openclawGetStatus(): Promise<{ model: string; activeSessions: number; totalTokens: number; estimatedCost: number } | null>;

  // Theme change notification
  notifyThemeChanged(theme: string): void;
  onThemeChanged(cb: (theme: string) => void): void;
}

declare global {
  interface Window {
    oceangram: OceangramAPI;
  }
}

export {};
