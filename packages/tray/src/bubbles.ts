// bubbles.ts — Floating avatar bubble windows
import { BrowserWindow, screen, ipcMain, IpcMainEvent } from 'electron';
import path from 'path';
import daemon from './daemon';
import whitelist from './whitelist';
import tracker from './tracker';

const BUBBLE_SIZE = 64;
const BUBBLE_GAP = 12;
const EDGE_MARGIN = 20;
const MAX_BUBBLES = 5;

type PopupFactory = (userId: string) => void;

interface BubbleDataResult {
  [userId: string]: {
    displayName: string;
    count: number;
  };
}

class BubbleManager {
  bubbles: Map<string, BrowserWindow>;
  private popupFactory: PopupFactory | null;
  visible: boolean;
  private avatarCache: Map<string, string>;

  constructor() {
    this.bubbles = new Map();
    this.popupFactory = null;
    this.visible = true;
    this.avatarCache = new Map();
  }

  setPopupFactory(factory: PopupFactory): void {
    this.popupFactory = factory;
  }

  async createBubble(userId: string, unreadCount: number): Promise<void> {
    if (this.bubbles.has(userId)) {
      this._updateBubble(userId, unreadCount);
      return;
    }

    if (this.bubbles.size >= MAX_BUBBLES) return;

    const { width: screenW } = screen.getPrimaryDisplay().workAreaSize;
    const settings = whitelist.getSettings();
    const position = settings.bubblePosition || 'right';
    const index = this.bubbles.size;

    const x = position === 'right'
      ? screenW - BUBBLE_SIZE - EDGE_MARGIN
      : EDGE_MARGIN;
    const y = 100 + index * (BUBBLE_SIZE + BUBBLE_GAP);

    const bubble = new BrowserWindow({
      width: BUBBLE_SIZE,
      height: BUBBLE_SIZE,
      x,
      y,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      hasShadow: true,
      focusable: false,
      type: 'panel',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    // Make it truly round + clickable
    bubble.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    // Load bubble HTML
    bubble.loadFile(path.join(__dirname, '..', 'src', 'bubble.html'));

    bubble.webContents.on('did-finish-load', async () => {
      const userInfo = whitelist.getUserInfo(userId);
      const avatar = await this._getAvatar(userId);
      bubble.webContents.send('bubble-init', {
        userId,
        displayName: userInfo ? userInfo.displayName : userId,
        avatar,
        count: unreadCount,
      });
    });

    // Store reference
    this.bubbles.set(userId, bubble);

    bubble.on('closed', () => {
      this.bubbles.delete(userId);
    });
  }

  private _updateBubble(userId: string, count: number): void {
    const bubble = this.bubbles.get(userId);
    if (!bubble || bubble.isDestroyed()) return;
    bubble.webContents.send('bubble-update', { userId, count });
  }

  private async _getAvatar(userId: string): Promise<string | null> {
    if (this.avatarCache.has(userId)) return this.avatarCache.get(userId)!;
    const base64 = await daemon.getProfilePhotoBase64(userId);
    if (base64) {
      this.avatarCache.set(userId, base64);
    }
    return base64;
  }

  removeBubble(userId: string): void {
    const bubble = this.bubbles.get(userId);
    if (bubble && !bubble.isDestroyed()) {
      bubble.close();
    }
    this.bubbles.delete(userId);
  }

  showAll(): void {
    this.visible = true;
    for (const [, bubble] of this.bubbles) {
      if (!bubble.isDestroyed()) bubble.show();
    }
  }

  hideAll(): void {
    this.visible = false;
    for (const [, bubble] of this.bubbles) {
      if (!bubble.isDestroyed()) bubble.hide();
    }
  }

  toggleVisibility(): boolean {
    if (this.visible) this.hideAll();
    else this.showAll();
    return this.visible;
  }

  repositionAll(): void {
    const { width: screenW } = screen.getPrimaryDisplay().workAreaSize;
    const settings = whitelist.getSettings();
    const position = settings.bubblePosition || 'right';
    let index = 0;

    for (const [, bubble] of this.bubbles) {
      if (bubble.isDestroyed()) continue;
      const x = position === 'right'
        ? screenW - BUBBLE_SIZE - EDGE_MARGIN
        : EDGE_MARGIN;
      const y = 100 + index * (BUBBLE_SIZE + BUBBLE_GAP);
      bubble.setPosition(x, y);
      index++;
    }
  }

  destroyAll(): void {
    for (const [, bubble] of this.bubbles) {
      if (!bubble.isDestroyed()) bubble.close();
    }
    this.bubbles.clear();
  }

  // ── Event handlers ──

  handleUnreadsChanged(userId: string, count: number): void {
    if (count > 0) {
      this.createBubble(userId, count);
    } else {
      this.removeBubble(userId);
    }
  }

  handleBubbleClicked(userId: string): void {
    if (this.popupFactory) {
      this.popupFactory(userId);
    }
  }

  init(): void {
    // Listen for tracker events
    tracker.on('user-unreads-changed', ({ userId, count }: { userId: string; count: number }) => {
      this.handleUnreadsChanged(userId, count);
    });

    // IPC: bubble clicked
    ipcMain.on('bubble-clicked', (_: IpcMainEvent, userId: string) => {
      this.handleBubbleClicked(userId);
    });

    // IPC: get bubble data
    ipcMain.handle('get-bubble-data', (): BubbleDataResult => {
      const result: BubbleDataResult = {};
      for (const [userId] of this.bubbles) {
        const info = whitelist.getUserInfo(userId);
        const unreads = tracker.getUnreads(userId);
        result[userId] = {
          displayName: info ? info.displayName : userId,
          count: unreads.count,
        };
      }
      return result;
    });
  }
}

export = new BubbleManager();
