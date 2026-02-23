/**
 * OpenClaw Gateway WebSocket client.
 *
 * Speaks the Gateway Control-UI protocol:
 *   → { type: "req", id, method, params }
 *   ← { type: "res", id, result } | { type: "err", id, error }
 *   ← { type: "evt", event, data }            (server-push events)
 *   Handshake: method "connect" with auth.token
 *
 * Replaces file-based reading of sessions.json / config / cron state
 * with live WS queries to the running gateway.
 */

import WebSocket from 'ws';
import { randomBytes } from 'crypto';
import { EventEmitter } from 'events';

function genId(): string {
  return randomBytes(12).toString('hex');
}

// ---- Types ----

export interface GatewaySessionEntry {
  key: string;
  model: string | null;
  updatedAt: number;
  contextTokens: number | null;
  totalTokens: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  label: string | null;
  chatType: string | null;
  channel: string | null;
  lastTo: string | null;
  sessionId: string | null;
  taskSummary?: string;
  status?: string;
  startedAt?: number;
}

export interface GatewayCronJob {
  id: string;
  name: string;
  enabled: boolean;
  schedule: any;
  payload: any;
  delivery?: any;
  sessionTarget: string;
  lastRunAt?: number;
  nextRunAt?: number;
  lastStatus?: string;
  lastDurationMs?: number;
  consecutiveErrors?: number;
}

export interface GatewayCronRun {
  runId: string;
  startedAt: number;
  finishedAt?: number;
  status: string;
  durationMs?: number;
  error?: string;
  output?: string;
}

export interface GatewayStatus {
  version: string;
  uptime: number;
  sessions: number;
  model: string;
  [key: string]: any;
}

export interface GatewayHealth {
  status: string;
  [key: string]: any;
}

export interface GatewayConfig {
  [key: string]: any;
}

export interface ChatMessage {
  role: string;
  content: string;
  [key: string]: any;
}

// ---- Client ----

type PendingRequest = {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class OpenClawGatewayClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private url: string;
  private token: string;
  private pending = new Map<string, PendingRequest>();
  private _connected = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 2000;
  private maxReconnectDelay = 30000;
  private disposed = false;
  private connectPromise: Promise<void> | null = null;

  constructor(url: string, token: string) {
    super();
    this.url = url;
    this.token = token;
  }

  get connected(): boolean {
    return this._connected;
  }

  /** Connect to gateway WS. Resolves when handshake completes. */
  async connect(): Promise<void> {
    if (this._connected) return;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = new Promise<void>((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.url);

        const timeout = setTimeout(() => {
          reject(new Error('Gateway connection timeout'));
          this.ws?.close();
        }, 10000);

        this.ws.on('open', async () => {
          clearTimeout(timeout);
          try {
            await this.sendHandshake();
            this._connected = true;
            this.reconnectDelay = 2000;
            this.emit('connected');
            resolve();
          } catch (err) {
            reject(err);
            this.ws?.close();
          }
        });

        this.ws.on('message', (data: WebSocket.Data) => {
          this.handleMessage(String(data));
        });

        this.ws.on('close', (code, reason) => {
          clearTimeout(timeout);
          const wasConnected = this._connected;
          this._connected = false;
          this.connectPromise = null;
          // Reject all pending requests
          for (const [id, p] of this.pending) {
            clearTimeout(p.timer);
            p.reject(new Error(`WS closed (${code})`));
          }
          this.pending.clear();
          if (wasConnected) {
            this.emit('disconnected', code, String(reason));
            this.scheduleReconnect();
          } else {
            reject(new Error(`WS closed during connect: ${code} ${reason}`));
          }
        });

        this.ws.on('error', (err) => {
          clearTimeout(timeout);
          if (!this._connected) {
            reject(err);
          }
          this.emit('error', err);
        });
      } catch (err) {
        this.connectPromise = null;
        reject(err);
      }
    });

    return this.connectPromise;
  }

  private async sendHandshake(): Promise<void> {
    const result = await this.request('connect', {
      auth: { token: this.token },
      roles: ['operator.admin'],
      clientType: 'oceangram-extension',
    });
    if (result?.error) {
      throw new Error(`Handshake failed: ${result.error}`);
    }
  }

  /** Send a request and wait for response. */
  async request(method: string, params?: any, timeoutMs = 15000): Promise<any> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Gateway not connected');
    }

    const id = genId();
    const msg = { type: 'req', id, method, params };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request timeout: ${method}`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.ws!.send(JSON.stringify(msg));
    });
  }

  private handleMessage(raw: string) {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === 'res' || msg.type === 'err') {
      const p = this.pending.get(msg.id);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(msg.id);
        if (msg.type === 'err') {
          p.reject(new Error(msg.error || 'Unknown error'));
        } else {
          p.resolve(msg.result);
        }
      }
    } else if (msg.type === 'evt') {
      this.emit('event', msg.event, msg.data);
      this.emit(`event:${msg.event}`, msg.data);
    }
  }

  private scheduleReconnect() {
    if (this.disposed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.disposed) return;
      try {
        await this.connect();
      } catch {
        this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, this.maxReconnectDelay);
        this.scheduleReconnect();
      }
    }, this.reconnectDelay);
  }

  // ---- High-level API ----

  async getStatus(): Promise<GatewayStatus> {
    return this.request('status');
  }

  async getHealth(): Promise<GatewayHealth> {
    return this.request('health');
  }

  async listSessions(opts?: { activeMinutes?: number; limit?: number; includeGlobal?: boolean }): Promise<{ sessions: GatewaySessionEntry[] }> {
    return this.request('sessions.list', opts);
  }

  async patchSession(key: string, patch: { label?: string; thinkingLevel?: string; verbose?: boolean }): Promise<any> {
    return this.request('sessions.patch', { key, ...patch });
  }

  async deleteSession(key: string): Promise<any> {
    return this.request('sessions.delete', { key });
  }

  async getSessionUsage(key?: string): Promise<any> {
    return this.request('sessions.usage', key ? { key } : undefined);
  }

  async listCronJobs(opts?: { includeDisabled?: boolean }): Promise<{ jobs: GatewayCronJob[] }> {
    return this.request('cron.list', opts);
  }

  async getCronStatus(): Promise<any> {
    return this.request('cron.status');
  }

  async runCronJob(jobId: string): Promise<any> {
    return this.request('cron.run', { jobId });
  }

  async getCronRuns(jobId: string): Promise<{ runs: GatewayCronRun[] }> {
    return this.request('cron.runs', { jobId });
  }

  async updateCronJob(jobId: string, patch: any): Promise<any> {
    return this.request('cron.update', { jobId, patch });
  }

  async getConfig(): Promise<GatewayConfig> {
    return this.request('config.get');
  }

  async listModels(): Promise<any> {
    return this.request('models.list');
  }

  async getChatHistory(sessionKey?: string): Promise<{ messages: ChatMessage[] }> {
    return this.request('chat.history', sessionKey ? { sessionKey } : undefined);
  }

  async sendChat(text: string, sessionKey?: string): Promise<any> {
    return this.request('chat.send', {
      text,
      ...(sessionKey ? { sessionKey } : {}),
    });
  }

  async abortChat(sessionKey?: string): Promise<any> {
    return this.request('chat.abort', sessionKey ? { sessionKey } : undefined);
  }

  dispose() {
    this.disposed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('Disposed'));
    }
    this.pending.clear();
    this.ws?.close();
    this.ws = null;
    this._connected = false;
  }
}
