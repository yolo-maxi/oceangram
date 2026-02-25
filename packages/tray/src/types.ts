// types.ts — Shared type definitions for Oceangram Tray

// ── Telegram Data Types ──

export interface TelegramUser {
  id: number | string;
  firstName: string;
  lastName?: string;
  username?: string;
  phone?: string;
}

export interface TelegramDialog {
  id: string | number;
  userId?: string | number;
  name?: string;
  title?: string;
  firstName?: string;
  username?: string;
  type?: 'user' | 'group' | 'channel' | 'supergroup';
  unreadCount?: number;
  lastMessage?: TelegramMessage;
  lastMessageTime?: number;
  lastMessageOutgoing?: boolean;
  photo?: string;
}

export interface ChatMember {
  userId: string;
  firstName: string;
  lastName: string;
  username: string;
  role: string;
  joinDate: number;
}

export interface TelegramMessage {
  id: number;
  text?: string;
  message?: string;
  date?: number;
  timestamp?: number;
  fromId?: number | string;
  senderId?: number | string;
  senderName?: string;
  firstName?: string;
  isOutgoing?: boolean;
  replyTo?: number;
  dialogId?: string;
  chatId?: string;
  media?: { type: string; url?: string };
}

// ── Whitelist / Config ──

export interface WhitelistEntry {
  userId: string;
  username: string;
  displayName: string;
}

export interface BlacklistEntry {
  dialogId: string;
  displayName: string;
}

export interface AppSettings {
  alwaysOnTop: boolean;
  bubblePosition: 'left' | 'right';
  bubbleSize: number;
  maxBubbles: number;
  pollIntervalMs: number;
  showNotifications: boolean;
  theme: 'system' | 'day' | 'night' | 'tinted' | 'arctic';
  openclawEnabled?: boolean;
  openclawToken?: string;
  openclawUrl?: string;
}

export interface AppConfig {
  whitelist: WhitelistEntry[];
  blacklist: BlacklistEntry[];
  settings: AppSettings;
}

// ── Tracker State ──

export interface UnreadEntry {
  dialogId: string | null;
  messages: TelegramMessage[];
  count: number;
}

// ── Daemon Events ──

export interface DaemonEvent {
  type?: string;
  message?: TelegramMessage;
  fromId?: number | string;
  senderId?: number | string;
  dialogId?: string;
  chatId?: string;
  [key: string]: unknown;
}

// ── Health Response ──

export interface HealthResponse {
  status: string;
  connected: boolean;
  uptime: number;
}

// ── Bubble Init Data ──

export interface BubbleInitData {
  userId: string;
  displayName: string;
  avatar: string | null;
  count: number;
}

export interface BubbleUpdateData {
  userId: string;
  count: number;
}

// ── Popup Init Data ──

export interface PopupInitData {
  userId: string;
  dialogId: string;
  displayName: string;
}

// ── New Message Event ──

export interface NewMessageEvent {
  userId: string;
  dialogId: string;
  message: TelegramMessage;
  displayName?: string;
}

// ── Login API ──

export interface LoginPhoneResponse {
  ok: boolean;
  phoneCodeHash: string;
}

export interface LoginCodeResponse {
  ok: boolean;
  need2FA?: boolean;
}

export interface LoginTwoFaResponse {
  ok: boolean;
}

// ── IPC Channel Names ──

export type IpcInvokeChannel =
  | 'get-messages'
  | 'send-message'
  | 'mark-read'
  | 'get-dialog-info'
  | 'get-profile-photo'
  | 'get-media'
  | 'get-members'
  | 'get-whitelist'
  | 'add-user'
  | 'remove-user'
  | 'get-settings'
  | 'update-settings'
  | 'get-dialogs'
  | 'get-daemon-status'
  | 'get-me'
  | 'get-bubble-data';

export type IpcSendChannel =
  | 'close-popup'
  | 'bubble-clicked'
  | 'login-success'
  | 'close-login'
  | 'start-drag';

export type IpcReceiveChannel =
  | 'new-message'
  | 'messages-updated'
  | 'connection-changed'
  | 'bubble-init'
  | 'bubble-update'
  | 'popup-init';
