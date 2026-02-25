// main.ts — Electron main process for Oceangram Tray
import { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, Notification, screen, shell, IpcMainEvent, IpcMainInvokeEvent, MenuItemConstructorOptions } from 'electron';
import path from 'path';

// Hot reload in development (pnpm dev)
if (!app.isPackaged) {
  try {
    // Watch dist/ (compiled TS) and src/ (HTML, CSS)
    const srcDir = path.join(__dirname, '..', 'src');
    require('electron-reload')([__dirname, srcDir], {
      electron: path.join(__dirname, '..', 'node_modules', '.bin', 'electron'),
      hardResetMethod: 'exit',
      forceHardReset: true,
    });
  } catch {
    // electron-reload not available
  }
}
import http from 'http';
import https from 'https';
import fs from 'fs';
import os from 'os';
import { DaemonManager } from './daemonManager';
import { NewMessageEvent, AppSettings, WhitelistEntry, TelegramDialog } from './types';

// Module types (loaded after app ready)
type DaemonModule = typeof import('./daemon');
type WhitelistModule = typeof import('./whitelist');
type TrackerModule = typeof import('./tracker');
type OpenClawModule = {
  start(): void;
  stop(): void;
  readonly isEnabled: boolean;
  readonly connected: boolean;
  getStatus(): Promise<{ model: string; activeSessions: number; totalTokens: number; estimatedCost: number }>;
  getSessionForDialog(dialogId: string): Promise<{ sessionKey: string; model: string; totalTokens: number; contextWindow: number; contextUsedPct: number; updatedAt: number; displayName: string } | null>;
};

let daemon: DaemonModule | null = null;
let whitelist: WhitelistModule | null = null;
let tracker: TrackerModule | null = null;
let openclaw: OpenClawModule | null = null;

// Globals
let tray: Tray | null = null;
let settingsWindow: BrowserWindow | null = null;
let loginWindow: BrowserWindow | null = null;
let popupWindow: BrowserWindow | null = null;
let popupPinned = true;
const daemonManager = new DaemonManager();

// Tray icon flashing state
let flashInterval: ReturnType<typeof setInterval> | null = null;
let flashState = false; // toggles between normal and unread icon

// GitHub token (optional, read from ~/.oceangram/github-token)
let githubToken: string | null = null;
try {
  const tokenPath = path.join(os.homedir(), '.oceangram', 'github-token');
  if (fs.existsSync(tokenPath)) {
    githubToken = fs.readFileSync(tokenPath, 'utf-8').trim();
    if (!githubToken) githubToken = null;
    console.log('[main] GitHub token loaded');
  }
} catch {
  // No token — that's fine, merge button just won't show
}

// GitHub API helper
function githubAPIRequest(method: string, apiPath: string, body?: string): Promise<{ status: number; data: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      'User-Agent': 'Oceangram',
      'Accept': 'application/vnd.github.v3+json',
    };
    if (githubToken) {
      headers['Authorization'] = `token ${githubToken}`;
    }
    if (body) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(body));
    }
    const req = https.request({
      hostname: 'api.github.com',
      path: apiPath,
      method,
      headers,
    }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode || 0, data }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('GitHub API timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

// ── App setup ──

// Single instance lock
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

app.on('second-instance', () => {
  if (popupWindow && !popupWindow.isDestroyed()) {
    popupWindow.focus();
  } else if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
  }
});

// Hide dock icon on macOS
if (process.platform === 'darwin') {
  app.dock?.hide();
}

// ── Helper: check if logged in ──

function checkLoggedIn(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get('http://localhost:7777/me', (res) => {
      if (res.statusCode === 200) {
        let data = '';
        res.on('data', (c: Buffer) => (data += c));
        res.on('end', () => {
          try {
            const me = JSON.parse(data) as { id?: string };
            resolve(!!me.id);
          } catch {
            resolve(false);
          }
        });
      } else {
        res.resume();
        resolve(false);
      }
    });
    req.on('error', () => resolve(false));
    req.setTimeout(3000, () => { req.destroy(); resolve(false); });
  });
}

// ── App ready ──

app.whenReady().then(async () => {
  // Create tray immediately with "Starting..." state
  createTray();
  tray!.setToolTip('Oceangram — Starting...');

  // Start the daemon
  console.log('[main] Starting daemon...');
  const daemonReady = await daemonManager.start();
  if (!daemonReady) {
    console.error('[main] Daemon failed to start');
    tray!.setToolTip('Oceangram — Daemon failed to start');
  }

  // Check if logged in
  const loggedIn = await checkLoggedIn();

  if (!loggedIn) {
    console.log('[main] Not logged in — showing login window');
    tray!.setToolTip('Oceangram — Login required');
    showLoginWindow();
  } else {
    console.log('[main] Already logged in — initializing');
    initializeApp();
  }
});

app.on('window-all-closed', () => {
  // Don't quit when windows close — we're a tray app
});

app.on('before-quit', () => {
  if (daemon) daemon.stop();
  if (tracker) tracker.stop();
  if (openclaw) openclaw.stop();
  daemonManager.stop();
});

// ── Login Window ──

function showLoginWindow(): void {
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.focus();
    return;
  }

  loginWindow = new BrowserWindow({
    width: 380,
    height: 520,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: true,
    vibrancy: 'under-window',
    visualEffectState: 'active',
    roundedCorners: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'loginPreload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  loginWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  loginWindow.loadFile(path.join(__dirname, '..', 'src', 'login.html'));

  loginWindow.on('closed', () => {
    loginWindow = null;
  });
}

// IPC from login window
ipcMain.on('login-success', () => {
  console.log('[main] Login success — initializing app');
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.close();
  }
  loginWindow = null;
  initializeApp();
});

ipcMain.on('close-login', () => {
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.close();
  }
  loginWindow = null;
});

// ── Initialize app after login ──

function initializeApp(): void {
  // Load modules
  daemon = require('./daemon') as DaemonModule;
  whitelist = require('./whitelist') as WhitelistModule;
  tracker = require('./tracker') as TrackerModule;
  const mod = require('./openclaw');
  openclaw = (mod.default || mod) as OpenClawModule;

  // Setup
  setupIPC();

  // Start daemon connection & message tracking
  daemon.start();
  tracker.start();

  // Debug: log WS and new message events
  daemon.on('ws-connected', () => console.log('[main] daemon WS connected'));
  daemon.on('ws-disconnected', () => console.log('[main] daemon WS disconnected'));
  daemon.on('newMessage', (e: unknown) => console.log('[main] got newMessage event:', JSON.stringify(e).substring(0, 200)));
  daemon.on('typing', (e: { type: string; dialogId: string; userId: string; action: string }) => {
    if (popupWindow && !popupWindow.isDestroyed()) {
      popupWindow.webContents.send('typing', { dialogId: e.dialogId, userId: e.userId, action: e.action });
    }
  });
  tracker.on('new-message', (data: NewMessageEvent) => console.log('[main] tracker emitted new-message, dialogId:', data.dialogId));

  // Start OpenClaw (feature-flagged — no-op if disabled)
  openclaw.start();

  // Update tray based on events
  daemon.on('connection-changed', (connected: boolean) => {
    updateTrayIcon();
    // Forward to popup if open
    if (popupWindow && !popupWindow.isDestroyed()) {
      popupWindow.webContents.send('connection-changed', connected);
    }
  });

  tracker.on('unread-count-changed', () => {
    updateTrayIcon();
    // Forward unread counts to popup
    if (popupWindow && !popupWindow.isDestroyed()) {
      popupWindow.webContents.send('unread-counts-updated', tracker!.getAllUnreadCounts());
      // Active chats may have changed (unreads cleared/added)
      popupWindow.webContents.send('active-chats-changed', tracker!.getActiveChats());
    }
  });

  tracker.on('active-chats-changed', () => {
    if (popupWindow && !popupWindow.isDestroyed()) {
      popupWindow.webContents.send('active-chats-changed', tracker!.getActiveChats());
    }
  });

  tracker.on('new-message', (data: NewMessageEvent) => {
    console.log('[main] Forwarding new-message to popup, dialogId:', data.dialogId, 'popupExists:', !!popupWindow);
    // Forward to popup
    if (popupWindow && !popupWindow.isDestroyed()) {
      popupWindow.webContents.send('new-message', data);
    }

    const popupFocused = popupWindow && !popupWindow.isDestroyed() && popupWindow.isFocused();

    // Flash tray icon if popup is not focused
    if (!popupFocused) {
      startTrayFlash();

      // macOS: bounce dock icon
      if (process.platform === 'darwin') {
        app.dock?.bounce('informational');
      }
    }

    // Show notification if enabled and popup is not focused
    const settings = whitelist!.getSettings();
    if (settings.showNotifications) {
      if (!popupFocused) {
        showNotification(data);
      }
    }
  });

  updateTrayIcon();
  console.log('[main] Oceangram Tray initialized');
}

// ── Tray ──

function createTray(): void {
  const iconPath = path.join(__dirname, '..', 'src', 'assets', 'tray-icon.png');
  const icon = nativeImage.createFromPath(iconPath);
  icon.setTemplateImage(true);

  tray = new Tray(icon);
  tray.setToolTip('Oceangram — Connecting...');

  // Left-click: toggle popup
  tray.on('click', () => {
    togglePopup();
  });

  // Right-click: context menu with Settings + Quit
  tray.on('right-click', () => {
    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Sticky Pane',
        type: 'checkbox' as const,
        checked: popupPinned,
        click: () => { popupPinned = !popupPinned; },
      },
      { type: 'separator' as const },
      {
        label: 'Settings',
        click: openSettings,
      },
      { type: 'separator' as const },
      {
        label: 'Quit Oceangram',
        click: () => { app.quit(); },
      },
    ]);
    tray!.popUpContextMenu(contextMenu);
  });
}

function closePopupAnimated(): void {
  if (!popupWindow || popupWindow.isDestroyed()) return;
  popupWindow.webContents.executeJavaScript(`
    document.querySelector('.app').style.animation = 'popOut 0.15s cubic-bezier(0.55, 0.085, 0.68, 0.53) forwards';
  `).catch(() => {});
  setTimeout(() => {
    if (popupWindow && !popupWindow.isDestroyed()) {
      popupWindow.close();
      popupWindow = null;
    }
  }, 150);
}

function togglePopup(): void {
  if (popupWindow && !popupWindow.isDestroyed()) {
    closePopupAnimated();
    return;
  }
  openPopup();
}

function openPopup(): void {
  if (popupWindow && !popupWindow.isDestroyed()) {
    popupWindow.focus();
    return;
  }

  // Position near the tray icon
  const trayBounds = tray!.getBounds();
  const display = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y });
  const workArea = display.workArea;

  const popupWidth = 350;
  const popupHeight = 450;

  // Calculate position: centered below tray icon, clamped to screen
  let x = Math.round(trayBounds.x + trayBounds.width / 2 - popupWidth / 2);
  let y: number;

  // On macOS menu bar is at top, so popup goes below
  if (process.platform === 'darwin') {
    y = trayBounds.y + trayBounds.height + 4;
  } else {
    // On other platforms, tray might be at bottom
    if (trayBounds.y > workArea.y + workArea.height / 2) {
      // Tray is in bottom half — show above
      y = trayBounds.y - popupHeight - 4;
    } else {
      y = trayBounds.y + trayBounds.height + 4;
    }
  }

  // Clamp to screen bounds
  x = Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - popupWidth));
  y = Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - popupHeight));

  const settings = whitelist ? whitelist.getSettings() : { alwaysOnTop: true };

  popupWindow = new BrowserWindow({
    width: popupWidth,
    height: popupHeight,
    x,
    y,
    frame: false,
    transparent: true,
    alwaysOnTop: settings.alwaysOnTop !== false,
    skipTaskbar: true,
    resizable: true,
    minimizable: false,
    maximizable: false,
    hasShadow: true,
    vibrancy: 'under-window',
    visualEffectState: 'active',
    roundedCorners: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Open links in system browser instead of embedded Electron window
  popupWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  popupWindow.loadFile(path.join(__dirname, '..', 'src', 'popup.html'));

  popupWindow.webContents.on('did-finish-load', () => {
    if (popupWindow && !popupWindow.isDestroyed()) {
      popupWindow.webContents.send('connection-changed', daemon ? daemon.connected : false);
    }
  });

  // Stop tray flash when popup gets focus
  popupWindow.on('focus', () => {
    stopTrayFlash();
  });

  // Close on blur (clicking outside) — unless pinned
  popupWindow.on('blur', () => {
    setTimeout(() => {
      if (popupWindow && !popupWindow.isDestroyed() && !popupWindow.isFocused() && !popupPinned) {
        closePopupAnimated();
      }
    }, 100);
  });

  popupWindow.on('closed', () => {
    popupWindow = null;
  });
}

function updateTrayIcon(): void {
  if (!tray) return;

  const totalUnreads = tracker ? tracker.getTotalUnreadCount() : 0;
  const connected = daemon ? daemon.connected : false;

  let iconName = 'tray-icon.png';
  let tooltip = 'Oceangram';

  if (!connected) {
    tooltip = 'Oceangram — Disconnected';
  } else if (totalUnreads > 0) {
    iconName = 'tray-unread.png';
    tooltip = `Oceangram — ${totalUnreads} unread`;
  } else {
    tooltip = 'Oceangram — Connected';
  }

  // Only update icon if not currently flashing (flash handles its own icon)
  if (!flashInterval) {
    const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'src', 'assets', iconName));
    icon.setTemplateImage(true);
    tray.setImage(icon);
  }
  tray.setToolTip(tooltip);

  // Set macOS badge count
  if (process.platform === 'darwin') {
    app.setBadgeCount(totalUnreads);
  }
}

function startTrayFlash(): void {
  if (flashInterval) return; // already flashing

  const normalIconPath = path.join(__dirname, '..', 'src', 'assets', 'tray-icon.png');
  const unreadIconPath = path.join(__dirname, '..', 'src', 'assets', 'tray-unread.png');
  const normalIcon = nativeImage.createFromPath(normalIconPath);
  normalIcon.setTemplateImage(true);
  const unreadIcon = nativeImage.createFromPath(unreadIconPath);
  unreadIcon.setTemplateImage(true);

  flashState = false;
  flashInterval = setInterval(() => {
    if (!tray) return;
    flashState = !flashState;
    tray.setImage(flashState ? unreadIcon : normalIcon);
  }, 500);
}

function stopTrayFlash(): void {
  if (flashInterval) {
    clearInterval(flashInterval);
    flashInterval = null;
    flashState = false;
  }
  // Restore correct icon state
  updateTrayIcon();
}

// ── Notifications ──

function showNotification(data: NewMessageEvent): void {
  const name = data.displayName || 'Unknown';
  const text = data.message.text || data.message.message || 'New message';

  const notif = new Notification({
    title: name,
    body: text.substring(0, 200),
    silent: false,
    urgency: 'normal',
  });

  notif.on('click', () => {
    // Open popup and select this chat
    if (!popupWindow || popupWindow.isDestroyed()) {
      openPopup();
    }
    // Wait for load then select chat
    setTimeout(() => {
      if (popupWindow && !popupWindow.isDestroyed()) {
        popupWindow.webContents.send('select-dialog', data.dialogId);
        popupWindow.focus();
      }
    }, 300);
  });

  notif.show();
}

// ── Settings Window ──

function openSettings(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 480,
    height: 600,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: true,
    vibrancy: 'under-window',
    roundedCorners: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  settingsWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  settingsWindow.loadFile(path.join(__dirname, '..', 'src', 'settings.html'));

  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
}

// ── IPC Handlers ──

function setupIPC(): void {
  // Messages
  ipcMain.handle('get-messages', async (_: IpcMainInvokeEvent, dialogId: string, limit?: number, offsetId?: number) => {
    return await daemon!.getMessages(dialogId, limit || 30, offsetId);
  });

  ipcMain.handle('send-message', async (_: IpcMainInvokeEvent, dialogId: string, text: string, replyTo?: number) => {
    // Record sent time for active-chats filter
    tracker!.recordSent(dialogId);
    return await daemon!.sendMessage(dialogId, text, replyTo);
  });

  ipcMain.handle('send-file', async (_: IpcMainInvokeEvent, dialogId: string, data: string, fileName: string, mimeType?: string, caption?: string) => {
    tracker!.recordSent(dialogId);
    return await daemon!.uploadFile(dialogId, data, fileName, mimeType, caption);
  });

  ipcMain.handle('mark-read', async (_: IpcMainInvokeEvent, dialogId: string) => {
    tracker!.markRead(dialogId);
    return true;
  });

  ipcMain.handle('get-dialog-info', async (_: IpcMainInvokeEvent, dialogId: string) => {
    const dialogs = await daemon!.getDialogs();
    if (Array.isArray(dialogs)) {
      return dialogs.find((d: TelegramDialog) => String(d.id) === String(dialogId)) || null;
    }
    return null;
  });

  ipcMain.handle('get-profile-photo', async (_: IpcMainInvokeEvent, userId: string) => {
    return await daemon!.getProfilePhotoBase64(userId);
  });

  ipcMain.handle('get-media', async (_: IpcMainInvokeEvent, dialogId: string, messageId: number) => {
    return await daemon!.getMedia(dialogId, messageId);
  });

  // Whitelist
  ipcMain.handle('get-whitelist', () => {
    return whitelist!.getWhitelist();
  });

  ipcMain.handle('add-user', (_: IpcMainInvokeEvent, user: { userId: string; username?: string; displayName?: string }) => {
    return whitelist!.addUser(user);
  });

  ipcMain.handle('remove-user', (_: IpcMainInvokeEvent, userId: string) => {
    return whitelist!.removeUser(userId);
  });

  // Blacklist (muted chats — hidden from tray)
  ipcMain.handle('get-blacklist', () => {
    return whitelist!.getBlacklist();
  });

  ipcMain.handle('unmute-chat', async (_: IpcMainInvokeEvent, dialogId: string) => {
    whitelist!.removeFromBlacklist(dialogId);
    try {
      await daemon!.unmuteChat(dialogId);
    } catch {
      /* daemon unmute may fail if not actually muted */
    }
    if (popupWindow && !popupWindow.isDestroyed()) {
      popupWindow.webContents.send('blacklist-changed');
    }
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.webContents.send('blacklist-changed');
    }
    return true;
  });

  // Settings
  ipcMain.handle('get-settings', () => {
    return whitelist!.getSettings();
  });

  ipcMain.handle('update-settings', (_: IpcMainInvokeEvent, settings: Partial<AppSettings>) => {
    whitelist!.updateSettings(settings);
    return true;
  });

  // Dialogs
  ipcMain.handle('get-dialogs', async (_: IpcMainInvokeEvent, limit?: number) => {
    return await daemon!.getDialogs(limit);
  });

  // Daemon status
  ipcMain.handle('get-daemon-status', async () => {
    const health = await daemon!.getHealth();
    return health !== null;
  });

  ipcMain.handle('get-daemon-ws-status', () => {
    return { connected: daemon?.connected ?? false, wsUrl: 'ws://localhost:7777/events' };
  });

  ipcMain.handle('toggle-pin', () => {
    popupPinned = !popupPinned;
    return popupPinned;
  });

  ipcMain.handle('get-pinned', () => {
    return popupPinned;
  });

  // User info
  ipcMain.handle('get-me', async () => {
    return await daemon!.getMe();
  });

  // Unread counts
  ipcMain.handle('get-unread-counts', () => {
    return tracker!.getAllUnreadCounts();
  });

  // Active chats (recent send + unread)
  ipcMain.handle('get-active-chats', () => {
    return tracker!.getActiveChats();
  });

  // OpenClaw agent status (feature-flagged)
  ipcMain.handle('openclaw-enabled', () => {
    return openclaw ? openclaw.isEnabled && openclaw.connected : false;
  });

  ipcMain.handle('openclaw-get-status', async () => {
    if (!openclaw || !openclaw.isEnabled || !openclaw.connected) return null;
    try {
      return await openclaw.getStatus();
    } catch (err) {
      console.error('[openclaw] Status request failed:', err);
      return null;
    }
  });

  ipcMain.handle('openclaw-get-session', async (_event: Electron.IpcMainInvokeEvent, dialogId: string) => {
    if (!openclaw || !openclaw.isEnabled || !openclaw.connected) return null;
    try {
      return await openclaw.getSessionForDialog(dialogId);
    } catch (err) {
      console.error('[openclaw] Session request failed:', err);
      return null;
    }
  });

  // Tab context menu (right-click on avatar)
  ipcMain.on('show-tab-context-menu', (event: IpcMainEvent, dialogId: string, displayName: string, isPinned: boolean) => {
    const menu = Menu.buildFromTemplate([
      {
        label: isPinned ? '📌 Unpin Chat' : '📌 Pin Chat',
        click: async () => {
          if (isPinned) {
            whitelist!.removeUser(dialogId.split(':')[0]);
          } else {
            whitelist!.addUser({ userId: dialogId, displayName });
          }
          if (popupWindow && !popupWindow.isDestroyed()) {
            popupWindow.webContents.send('whitelist-changed');
          }
        },
      },
      { type: 'separator' as const },
      {
        label: '🔇 Mute Chat',
        click: async () => {
          await daemon!.muteChat(dialogId);
          whitelist!.addToBlacklist(dialogId, displayName);
          if (popupWindow && !popupWindow.isDestroyed()) {
            popupWindow.webContents.send('blacklist-changed');
          }
          if (settingsWindow && !settingsWindow.isDestroyed()) {
            settingsWindow.webContents.send('blacklist-changed');
          }
        },
      },
    ]);
    menu.popup();
  });

  // Close popup (from renderer)
  ipcMain.on('close-popup', (event: IpcMainEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) {
      win.close();
    }
  });

  // Open settings from renderer
  ipcMain.on('open-settings', () => {
    openSettings();
  });

  // Theme changed in settings → forward to popup
  ipcMain.on('theme-changed', (_: IpcMainEvent, theme: string) => {
    if (popupWindow && !popupWindow.isDestroyed()) {
      popupWindow.webContents.send('theme-changed', theme);
    }
  });

  // GitHub PR — fetch PR details
  ipcMain.handle('fetch-github-pr', async (_: IpcMainInvokeEvent, owner: string, repo: string, prNumber: number) => {
    try {
      const result = await githubAPIRequest('GET', `/repos/${owner}/${repo}/pulls/${prNumber}`);
      if (result.status === 200) {
        const pr = JSON.parse(result.data);
        return {
          number: pr.number,
          title: pr.title,
          state: pr.state,
          merged: pr.merged || false,
          user: { login: pr.user?.login || 'unknown' },
          additions: pr.additions || 0,
          deletions: pr.deletions || 0,
          html_url: pr.html_url,
        };
      }
      throw new Error(`GitHub API returned ${result.status}`);
    } catch (err) {
      console.error('[main] GitHub PR fetch error:', err);
      throw err;
    }
  });

  // GitHub PR — merge
  ipcMain.handle('merge-github-pr', async (_: IpcMainInvokeEvent, owner: string, repo: string, prNumber: number) => {
    if (!githubToken) {
      return { merged: false, message: 'No GitHub token configured' };
    }
    try {
      const result = await githubAPIRequest('PUT', `/repos/${owner}/${repo}/pulls/${prNumber}/merge`, JSON.stringify({ merge_method: 'merge' }));
      const data = JSON.parse(result.data);
      if (result.status === 200) {
        return { merged: true, message: data.message || 'Pull request merged' };
      }
      return { merged: false, message: data.message || `Merge failed (${result.status})` };
    } catch (err) {
      console.error('[main] GitHub PR merge error:', err);
      return { merged: false, message: String(err) };
    }
  });
}
