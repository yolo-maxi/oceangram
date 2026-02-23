// main.ts — Electron main process for Oceangram Tray
import { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, Notification, screen, IpcMainEvent, IpcMainInvokeEvent, MenuItemConstructorOptions } from 'electron';
import path from 'path';
import http from 'http';
import { DaemonManager } from './daemonManager';
import { NewMessageEvent, AppSettings, WhitelistEntry, TelegramDialog } from './types';

// Module types (loaded after app ready)
type DaemonModule = typeof import('./daemon');
type WhitelistModule = typeof import('./whitelist');
type TrackerModule = typeof import('./tracker');

let daemon: DaemonModule | null = null;
let whitelist: WhitelistModule | null = null;
let tracker: TrackerModule | null = null;

// Globals
let tray: Tray | null = null;
let settingsWindow: BrowserWindow | null = null;
let loginWindow: BrowserWindow | null = null;
let popupWindow: BrowserWindow | null = null;
const daemonManager = new DaemonManager();

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

  // Setup
  setupIPC();

  // Start daemon connection & message tracking
  daemon.start();
  tracker.start();

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
    }
  });

  tracker.on('new-message', (data: NewMessageEvent) => {
    // Forward to popup
    if (popupWindow && !popupWindow.isDestroyed()) {
      popupWindow.webContents.send('new-message', data);
    }

    // Show notification if enabled and popup is not focused
    const settings = whitelist!.getSettings();
    if (settings.showNotifications) {
      const popupFocused = popupWindow && !popupWindow.isDestroyed() && popupWindow.isFocused();
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
  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Settings',
      click: openSettings,
    },
    { type: 'separator' },
    {
      label: 'Quit Oceangram',
      click: () => {
        app.quit();
      },
    },
  ]);
  tray.on('right-click', () => {
    tray!.popUpContextMenu(contextMenu);
  });
}

function togglePopup(): void {
  if (popupWindow && !popupWindow.isDestroyed()) {
    popupWindow.close();
    popupWindow = null;
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

  popupWindow.loadFile(path.join(__dirname, '..', 'src', 'popup.html'));

  popupWindow.webContents.on('did-finish-load', () => {
    if (popupWindow && !popupWindow.isDestroyed()) {
      popupWindow.webContents.send('connection-changed', daemon ? daemon.connected : false);
    }
  });

  // Close on blur (clicking outside)
  popupWindow.on('blur', () => {
    // Small delay to avoid closing when clicking tray icon to toggle
    setTimeout(() => {
      if (popupWindow && !popupWindow.isDestroyed() && !popupWindow.isFocused()) {
        popupWindow.close();
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

  const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'src', 'assets', iconName));
  icon.setTemplateImage(true);
  tray.setImage(icon);
  tray.setToolTip(tooltip);
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

  settingsWindow.loadFile(path.join(__dirname, '..', 'src', 'settings.html'));

  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
}

// ── IPC Handlers ──

function setupIPC(): void {
  // Messages
  ipcMain.handle('get-messages', async (_: IpcMainInvokeEvent, dialogId: string, limit?: number) => {
    return await daemon!.getMessages(dialogId, limit || 30);
  });

  ipcMain.handle('send-message', async (_: IpcMainInvokeEvent, dialogId: string, text: string) => {
    return await daemon!.sendMessage(dialogId, text);
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

  // User info
  ipcMain.handle('get-me', async () => {
    return await daemon!.getMe();
  });

  // Unread counts
  ipcMain.handle('get-unread-counts', () => {
    return tracker!.getAllUnreadCounts();
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
}
