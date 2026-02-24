// openclaw.ts — OpenClaw Gateway WebSocket client for AI enrichments
import { EventEmitter } from 'events';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import WebSocketLib from 'ws';

const CONFIG_PATH = path.join(os.homedir(), '.oceangram', 'config.json');
const DEFAULT_URL = 'ws://localhost:18789';
const RECONNECT_DELAY = 5000;

interface OpenClawConfig {
  features?: { openclaw?: boolean };
  openclaw?: { token?: string; url?: string };
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function genId(): string {
  return crypto.randomBytes(12).toString('hex');
}

function readConfig(): OpenClawConfig {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    return JSON.parse(raw) as OpenClawConfig;
  } catch {
    return {};
  }
}

class OpenClawClient extends EventEmitter {
  private ws: WebSocketLib | null = null;
  private pending = new Map<string, PendingRequest>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private enabled = false;
  private token = '';
  private url = DEFAULT_URL;
  private _connected = false;
  private _started = false;

  get connected(): boolean {
    return this._connected;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Read config and determine if OpenClaw is enabled. */
  private loadConfig(): void {
    const cfg = readConfig();
    this.enabled = cfg.features?.openclaw === true;
    this.token = cfg.openclaw?.token || '';
    this.url = cfg.openclaw?.url || DEFAULT_URL;
  }

  /** Start the client. No-op if feature is disabled. */
  start(): void {
    this.loadConfig();
    if (!this.enabled) {
      console.log('[openclaw] Feature disabled — skipping');
      return;
    }
    if (!this.token) {
      console.log('[openclaw] No token configured — skipping');
      this.enabled = false;
      return;
    }
    this._started = true;
    this.connect();
  }

  /** Stop the client and clean up. */
  stop(): void {
    this._started = false;
    this.enabled = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    // Reject all pending requests
    for (const [id, req] of this.pending) {
      clearTimeout(req.timer);
      req.reject(new Error('Client stopped'));
      this.pending.delete(id);
    }
    this._connected = false;
  }

  private connect(): void {
    if (!this._started) return;
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
    }

    try {
      this.ws = new WebSocketLib(this.url);
    } catch (err) {
      console.error('[openclaw] Failed to create WebSocket:', err);
      this.scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      console.log('[openclaw] WS connected, sending auth...');
      this.sendHandshake();
    });

    this.ws.on('message', (data: WebSocketLib.RawData) => {
      try {
        const msg = JSON.parse(data.toString());
        this.handleMessage(msg);
      } catch (e) {
        console.error('[openclaw] Parse error:', e);
      }
    });

    this.ws.on('close', () => {
      console.log('[openclaw] WS disconnected');
      this._connected = false;
      this.emit('connection-changed', false);
      this.scheduleReconnect();
    });

    this.ws.on('error', (err: Error) => {
      console.error('[openclaw] WS error:', err.message);
    });
  }

  private sendHandshake(): void {
    const id = genId();
    const handshake = {
      type: 'req',
      id,
      method: 'connect',
      params: { auth: { token: this.token } },
    };
    this.ws?.send(JSON.stringify(handshake));
    // Wait for response to confirm connection
    this.pending.set(id, {
      resolve: () => {
        console.log('[openclaw] Auth successful');
        this._connected = true;
        this.emit('connection-changed', true);
      },
      reject: (err) => {
        console.error('[openclaw] Auth failed:', err.message);
        this._connected = false;
      },
      timer: setTimeout(() => {
        this.pending.delete(id);
        console.error('[openclaw] Auth timeout');
      }, 15000),
    });
  }

  private handleMessage(msg: { type: string; id?: string; result?: unknown; error?: unknown; event?: string; data?: unknown }): void {
    if (msg.type === 'res' && msg.id) {
      const req = this.pending.get(msg.id);
      if (req) {
        clearTimeout(req.timer);
        this.pending.delete(msg.id);
        req.resolve(msg.result);
      }
    } else if (msg.type === 'err' && msg.id) {
      const req = this.pending.get(msg.id);
      if (req) {
        clearTimeout(req.timer);
        this.pending.delete(msg.id);
        req.reject(new Error(typeof msg.error === 'string' ? msg.error : JSON.stringify(msg.error)));
      }
    } else if (msg.type === 'evt') {
      this.emit('event', { event: msg.event, data: msg.data });
    }
  }

  private scheduleReconnect(): void {
    if (!this._started) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    console.log(`[openclaw] Reconnecting in ${RECONNECT_DELAY}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, RECONNECT_DELAY);
  }

  /** Send a request and await the response. */
  private request(method: string, params?: Record<string, unknown>, timeoutMs = 30000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this._connected || !this.ws || this.ws.readyState !== WebSocketLib.OPEN) {
        reject(new Error('Not connected'));
        return;
      }

      const id = genId();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request timeout: ${method}`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });

      this.ws.send(JSON.stringify({
        type: 'req',
        id,
        method,
        params,
      }));
    });
  }

  // ── Public API ──

  /** Get gateway status: model, sessions, tokens, cost. */
  async getStatus(): Promise<{ model: string; activeSessions: number; totalTokens: number; estimatedCost: number }> {
    if (!this._connected) throw new Error('OpenClaw not connected');
    const status = await this.request('status') as Record<string, unknown>;
    const sessions = await this.request('sessions.list', { activeMinutes: 30 }) as { sessions?: Array<Record<string, unknown>> };

    const sessionList = sessions?.sessions || [];
    let totalTokens = 0;
    let totalCost = 0;
    for (const s of sessionList) {
      totalTokens += (s.totalTokens as number) || 0;
      // Rough cost estimate: $0.01 per 1K tokens (varies by model)
      totalCost += ((s.totalTokens as number) || 0) * 0.00001;
    }

    return {
      model: (status.model as string) || 'unknown',
      activeSessions: sessionList.filter(s => {
        const updated = s.updatedAt as number;
        return updated && (Date.now() - updated) < 5 * 60 * 1000;
      }).length,
      totalTokens,
      estimatedCost: totalCost,
    };
  }
}

const openclawClient = new OpenClawClient();
export = openclawClient;
