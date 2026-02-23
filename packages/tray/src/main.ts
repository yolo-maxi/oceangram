// main.ts — Electron main process for Oceangram Tray
import { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, Notification, screen, IpcMainEvent, IpcMainInvokeEvent, MenuItemConstructorOptions } from 'electron';
import path from 'path';
import http from 'http';
import { DaemonManager } from './daemonManager';
import { NewMessageEvent, AppSettings, WhitelistEntry } from './types';

// Module types (loaded after app ready)
type DaemonModule = typeof import('./daemon');
type WhitelistModule = typeof import('./whitelist');
type TrackerModule = typeof import('./tracker');
type BubblesModule = typeof import('./bubbles');

let daemon: DaemonModule | null = null;
let whitelist: WhitelistModule | null = null;
let tracker: TrackerModule | null = null;
let bubbles: BubblesModule | null = null;

// Globals
let tray: Tray | null = null;
let settingsWindow: BrowserWindow | null = null;
let loginWindow: BrowserWindow | null = null;
const chatPopups: Map<string, BrowserWindow> = new Map();
const daemonManager = new DaemonManager();

// ── App setup ──

// Single instance lock
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

app.on('second-instance', () => {
  // Focus settings if open
  if (settingsWindow && !settingsWindow.isDestroyed()) {
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
    // Still try to continue — daemon might be externally managed
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
  // No-op: prevent default quit behavior for tray apps
});

app.on('before-quit', () => {
  if (daemon) daemon.stop();
  if (tracker) tracker.stop();
  if (bubbles) bubbles.destroyAll();
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
  bubbles = require('./bubbles') as BubblesModule;

  // Setup
  setupIPC();
  bubbles.init();
  bubbles.setPopupFactory(openChatPopup);

  // Start daemon connection & message tracking
  daemon.start();
  tracker.start();

  // Update tray based on events
  daemon.on('connection-changed', (connected: boolean) => {
    updateTrayIcon();
    // Forward to all open windows
    for (const [, win] of chatPopups) {
      if (!win.isDestroyed()) {
        win.webContents.send('connection-changed', connected);
      }
    }
  });

  tracker.on('user-unreads-changed', () => {
    updateTrayIcon();
  });

  tracker.on('new-message', (data: NewMessageEvent) => {
    // Forward to relevant chat popup
    const popup = chatPopups.get(data.userId);
    if (popup && !popup.isDestroyed()) {
      popup.webContents.send('new-message', data);
    }

    // Show notification if enabled
    const settings = whitelist!.getSettings();
    if (settings.showNotifications) {
      showNotification(data);
    }
  });

  updateTrayIcon();
  console.log('[main] Oceangram Tray initialized');
}

// ── Tray ──

function createTray(): void {
  const iconPath = path.join(__dirname, '..', 'src', 'assets', 'tray-icon.png');
  const icon = nativeImage.createFromPath(iconPath);
  // Set as template for macOS dark/light mode
  icon.setTemplateImage(true);

  tray = new Tray(icon);
  tray.setToolTip('Oceangram — Connecting...');
  updateTrayMenu();
}

function updateTrayMenu(): void {
  const bubblesVisible = bubbles ? bubbles.visible : true;
  const items: MenuItemConstructorOptions[] = [];

  if (bubbles) {
    items.push({
      label: bubblesVisible ? 'Hide Bubbles' : 'Show Bubbles',
      click: () => {
        bubbles!.toggleVisibility();
        updateTrayMenu();
      },
    });
    items.push({ type: 'separator' });
  }

  items.push({
    label: 'Settings',
    click: openSettings,
  });
  items.push({ type: 'separator' });
  items.push({
    label: 'Quit Oceangram',
    click: () => {
      app.quit();
    },
  });

  const menu = Menu.buildFromTemplate(items);
  tray!.setContextMenu(menu);
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
  const userInfo = whitelist!.getUserInfo(data.userId);
  const name = userInfo ? userInfo.displayName : 'Unknown';
  const text = data.message.text || data.message.message || 'New message';

  const notif = new Notification({
    title: name,
    body: text.substring(0, 200),
    silent: false,
    urgency: 'normal',
  });

  notif.on('click', () => {
    openChatPopup(data.userId);
  });

  notif.show();
}

// ── Chat Popup ──

function openChatPopup(userId: string): void {
  // If already open, focus it
  if (chatPopups.has(userId)) {
    const existing = chatPopups.get(userId)!;
    if (!existing.isDestroyed()) {
      existing.focus();
      return;
    }
    chatPopups.delete(userId);
  }

  const settings = whitelist!.getSettings();
  const userInfo = whitelist!.getUserInfo(userId);
  const unreads = tracker!.getUnreads(userId);

  // Position near the bubble if possible
  const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize;
  const x = Math.max(20, screenW - 400 - 100);
  const y = Math.max(50, Math.floor(screenH / 2) - 250);

  const popup = new BrowserWindow({
    width: 400,
    height: 500,
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

  popup.loadFile(path.join(__dirname, '..', 'src', 'popup.html'));

  popup.webContents.on('did-finish-load', () => {
    popup.webContents.send('popup-init', {
      userId,
      dialogId: unreads.dialogId || userId,
      displayName: userInfo ? userInfo.displayName : userId,
    });
    popup.webContents.send('connection-changed', daemon!.connected);
  });

  // Track popup
  chatPopups.set(userId, popup);

  popup.on('closed', () => {
    chatPopups.delete(userId);
  });

  // Mark messages as read when popup opens
  tracker!.markRead(userId);

  // Remove bubble when chat is open
  if (bubbles) {
    bubbles.removeBubble(userId);
  }
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

  ipcMain.handle('mark-read', async (_: IpcMainInvokeEvent, userId: string) => {
    tracker!.markRead(userId);
    return true;
  });

  ipcMain.handle('get-dialog-info', async (_: IpcMainInvokeEvent, dialogId: string) => {
    const dialogs = await daemon!.getDialogs();
    if (Array.isArray(dialogs)) {
      return dialogs.find((d) => String(d.id) === String(dialogId)) || null;
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
    // Apply settings changes
    if (settings.bubblePosition !== undefined && bubbles) {
      bubbles.repositionAll();
    }
    return true;
  });

  // Dialogs
  ipcMain.handle('get-dialogs', async () => {
    return await daemon!.getDialogs();
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

  // Close popup (from renderer)
  ipcMain.on('close-popup', (event: IpcMainEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) {
      win.close();
    }
  });
}
