// daemon.ts — HTTP/WS client for oceangram-daemon at localhost:7777
import { EventEmitter } from 'events';
import http from 'http';
import path from 'path';
import fs from 'fs';
import os from 'os';
import WebSocketLib from 'ws';
import {
  TelegramUser,
  TelegramDialog,
  TelegramMessage,
  DaemonEvent,
  HealthResponse,
} from './types';

const BASE_URL = 'http://localhost:7777';
const WS_URL = 'ws://localhost:7777/events';
const AVATAR_DIR: string = path.join(os.homedir(), '.oceangram-tray', 'avatars');

class DaemonClient extends EventEmitter {
  connected: boolean;
  private ws: WebSocketLib | null;
  private reconnectAttempts: number;
  private maxReconnectDelay: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | null;
  private healthCheckTimer: ReturnType<typeof setInterval> | null;

  constructor() {
    super();
    this.connected = false;
    this.ws = null;
    this.reconnectAttempts = 0;
    this.maxReconnectDelay = 30000;
    this.reconnectTimer = null;
    this.healthCheckTimer = null;

    // Ensure avatar cache dir
    fs.mkdirSync(AVATAR_DIR, { recursive: true });
  }

  // ── HTTP helpers ──

  private _request(method: string, urlPath: string, body: Record<string, unknown> | null = null): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const url = new URL(urlPath, BASE_URL);
      const options: http.RequestOptions = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers: { 'Content-Type': 'application/json' },
        timeout: 15000,
      };

      const req = http.request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          const ct = res.headers['content-type'] || '';
          if (ct.includes('application/json')) {
            try {
              resolve(JSON.parse(raw.toString()));
            } catch {
              resolve(raw.toString());
            }
          } else {
            resolve(raw);
          }
        });
      });

      req.on('error', (err) => reject(err));
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  async getHealth(): Promise<HealthResponse | null> {
    try {
      const res = await this._request('GET', '/health') as HealthResponse;
      this.connected = true;
      this.emit('connection-changed', true);
      return res;
    } catch {
      this.connected = false;
      this.emit('connection-changed', false);
      return null;
    }
  }

  async getMe(): Promise<TelegramUser | null> {
    try {
      return await this._request('GET', '/me') as TelegramUser;
    } catch {
      return null;
    }
  }

  async getDialogs(limit?: number): Promise<TelegramDialog[]> {
    try {
      const query = limit ? `?limit=${limit}` : '';
      return await this._request('GET', `/dialogs${query}`) as TelegramDialog[];
    } catch {
      return [];
    }
  }

  async getMessages(dialogId: string, limit: number = 30, offsetId?: number): Promise<TelegramMessage[]> {
    try {
      let url = `/dialogs/${dialogId}/messages?limit=${limit}`;
      if (offsetId) url += `&offsetId=${offsetId}`;
      return await this._request('GET', url) as TelegramMessage[];
    } catch {
      return [];
    }
  }

  async sendMessage(dialogId: string, text: string, replyTo?: number): Promise<unknown> {
    try {
      const body: Record<string, unknown> = { text };
      if (replyTo != null) body.replyTo = replyTo;
      return await this._request('POST', `/dialogs/${dialogId}/messages`, body);
    } catch {
      return null;
    }
  }

  async uploadFile(dialogId: string, data: string, fileName: string, mimeType?: string, caption?: string): Promise<unknown> {
    try {
      return await this._request('POST', `/dialogs/${dialogId}/upload`, { data, fileName, mimeType, caption });
    } catch {
      return null;
    }
  }

  async markRead(messageId: number): Promise<unknown> {
    try {
      return await this._request('POST', `/messages/${messageId}/read`);
    } catch {
      return null;
    }
  }

  async muteChat(dialogId: string): Promise<unknown> {
    try {
      return await this._request('POST', `/dialogs/${dialogId}/mute`);
    } catch {
      return null;
    }
  }

  async unmuteChat(dialogId: string): Promise<unknown> {
    try {
      return await this._request('POST', `/dialogs/${dialogId}/unmute`);
    } catch {
      return null;
    }
  }

  async getProfilePhoto(userId: string): Promise<string | null> {
    const cachePath = path.join(AVATAR_DIR, `${userId}.jpg`);
    // Return cached if fresh (< 24h)
    try {
      const stat = fs.statSync(cachePath);
      if (Date.now() - stat.mtimeMs < 24 * 60 * 60 * 1000) {
        return cachePath;
      }
    } catch { /* not cached */ }

    try {
      const data = await this._request('GET', `/profile/${userId}/photo`);
      if (Buffer.isBuffer(data) && data.length > 100) {
        fs.writeFileSync(cachePath, data);
        return cachePath;
      }
    } catch { /* ignore */ }
    return null;
  }

  async getProfilePhotoBase64(userId: string): Promise<string | null> {
    const filePath = await this.getProfilePhoto(userId);
    if (!filePath) return null;
    try {
      const data = fs.readFileSync(filePath);
      return `data:image/jpeg;base64,${data.toString('base64')}`;
    } catch {
      return null;
    }
  }

  // ── WebSocket ──

  connectWS(): void {
    console.log('[daemon] connectWS() called, attempting connection to', WS_URL);
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
    }

    try {
      this.ws = new WebSocketLib(WS_URL);
      console.log('[daemon] WebSocket object created');
    } catch (e) {
      console.error('[daemon] WebSocket creation FAILED:', e);
      this._scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      console.log('[daemon] WS connected to', WS_URL);
      this.reconnectAttempts = 0;
      this.connected = true;
      this.emit('connection-changed', true);
      this.emit('ws-connected');
    });

    this.ws.on('message', (data: WebSocketLib.RawData) => {
      try {
        const event = JSON.parse(data.toString()) as DaemonEvent;
        this.emit('event', event);
        if (event.type) {
          this.emit(event.type, event);
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error('[daemon] WS parse error:', message);
      }
    });

    this.ws.on('close', () => {
      console.log('[daemon] WS disconnected');
      this.connected = false;
      this.emit('connection-changed', false);
      this.emit('ws-disconnected');
      this._scheduleReconnect();
    });

    this.ws.on('error', (err: Error) => {
      console.error('[daemon] WS error:', err.message);
    });
  }

  private _scheduleReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), this.maxReconnectDelay);
    this.reconnectAttempts++;
    console.log(`[daemon] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    this.reconnectTimer = setTimeout(() => this.connectWS(), delay);
  }

  // ── Health check loop ──

  startHealthCheck(intervalMs: number = 10000): void {
    this.stopHealthCheck();
    this.healthCheckTimer = setInterval(() => this.getHealth(), intervalMs);
    this.getHealth();
  }

  stopHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  // ── Lifecycle ──

  start(): void {
    console.log('[daemon] start() called');
    this.startHealthCheck();
    this.connectWS();
  }

  stop(): void {
    this.stopHealthCheck();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
    }
  }
}

export = new DaemonClient();
