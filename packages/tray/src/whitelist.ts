// whitelist.ts — Config + whitelist management
import fs from 'fs';
import path from 'path';
import os from 'os';
import { AppConfig, AppSettings, WhitelistEntry } from './types';

const CONFIG_DIR: string = path.join(os.homedir(), '.oceangram-tray');
const CONFIG_PATH: string = path.join(CONFIG_DIR, 'config.json');

const DEFAULT_CONFIG: AppConfig = {
  whitelist: [],
  settings: {
    alwaysOnTop: true,
    bubblePosition: 'right',
    bubbleSize: 64,
    maxBubbles: 5,
    pollIntervalMs: 3000,
    showNotifications: true,
    theme: 'system',
  },
};

class WhitelistManager {
  config: AppConfig;

  constructor() {
    this.config = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as AppConfig;
    this.load();
  }

  load(): void {
    try {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
      if (fs.existsSync(CONFIG_PATH)) {
        const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
        const parsed = JSON.parse(raw) as Partial<AppConfig>;
        this.config = {
          whitelist: Array.isArray(parsed.whitelist) ? parsed.whitelist : [],
          settings: { ...DEFAULT_CONFIG.settings, ...parsed.settings },
        };
      } else {
        this.config = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as AppConfig;
        this.save();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[whitelist] Failed to load config:', message);
      this.config = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as AppConfig;
      this.save();
    }
  }

  save(): void {
    try {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(this.config, null, 2));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[whitelist] Failed to save config:', message);
    }
  }

  isWhitelisted(userId: string | number): boolean {
    const id = String(userId);
    return this.config.whitelist.some((u) => String(u.userId) === id);
  }

  addUser(user: { userId: string | number; username?: string; displayName?: string }): boolean {
    const id = String(user.userId);
    if (this.isWhitelisted(id)) return false;
    this.config.whitelist.push({
      userId: id,
      username: user.username || '',
      displayName: user.displayName || user.username || id,
    });
    this.save();
    return true;
  }

  removeUser(userId: string | number): boolean {
    const id = String(userId);
    const before = this.config.whitelist.length;
    this.config.whitelist = this.config.whitelist.filter((u) => String(u.userId) !== id);
    if (this.config.whitelist.length !== before) {
      this.save();
      return true;
    }
    return false;
  }

  getWhitelist(): WhitelistEntry[] {
    return this.config.whitelist;
  }

  getSettings(): AppSettings {
    return this.config.settings;
  }

  updateSettings(partial: Partial<AppSettings>): void {
    this.config.settings = { ...this.config.settings, ...partial };
    this.save();
  }

  getUserInfo(userId: string | number): WhitelistEntry | null {
    const id = String(userId);
    return this.config.whitelist.find((u) => String(u.userId) === id) || null;
  }
}

export = new WhitelistManager();
