import * as vscode from 'vscode';
import { ChildProcess, fork } from 'child_process';
import * as path from 'path';
import * as http from 'http';

export interface DaemonStatus {
  running: boolean;
  connected: boolean;  // telegram connected
  weSpawned: boolean;
  port: number;
}

export class DaemonManager {
  private process: ChildProcess | null = null;
  private weSpawned = false;
  private port: number;
  private baseUrl: string;

  constructor(port?: number) {
    this.port = port || vscode.workspace.getConfiguration('oceangram').get<number>('daemonPort', 7777);
    this.baseUrl = `http://127.0.0.1:${this.port}`;
  }

  getPort(): number { return this.port; }
  getBaseUrl(): string { return this.baseUrl; }

  /**
   * Ensure daemon is running. Returns true if healthy.
   * 1. Check health endpoint
   * 2. If responding → use it (external)
   * 3. If not → spawn child process
   * 4. Poll health until ready (timeout 10s)
   */
  async ensureRunning(): Promise<boolean> {
    // Check if already running
    const health = await this.checkHealth();
    if (health) {
      console.log('[Oceangram] Daemon already running on port', this.port);
      this.weSpawned = false;
      return true;
    }

    // Spawn daemon
    console.log('[Oceangram] Spawning daemon...');
    try {
      await this.spawn();
    } catch (err) {
      console.error('[Oceangram] Failed to spawn daemon:', err);
      vscode.window.showErrorMessage(`Failed to start Oceangram daemon: ${err}`);
      return false;
    }

    // Poll for health
    const started = await this.waitForHealth(10000);
    if (!started) {
      console.error('[Oceangram] Daemon failed to start within timeout');
      this.kill();
      vscode.window.showErrorMessage('Oceangram daemon failed to start (timeout)');
      return false;
    }

    console.log('[Oceangram] Daemon started successfully');
    return true;
  }

  private async spawn(): Promise<void> {
    // Find the daemon entry point
    // Try local node_modules first (pnpm link), then fallback to relative path
    const candidates = [
      path.resolve(__dirname, '../daemon/daemon-bundle.js'),  // bundled in .vsix (single file)
      path.resolve(__dirname, '../../node_modules/oceangram-daemon/dist/cli.js'),
      '/home/xiko/oceangram-daemon/dist/cli.js',
    ];

    let entryPoint: string | null = null;
    const fs = require('fs');
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        entryPoint = candidate;
        break;
      }
    }

    if (!entryPoint) {
      throw new Error('Cannot find oceangram-daemon entry point');
    }

    this.process = fork(entryPoint, ['start'], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: {
        ...process.env,
        PORT: this.port.toString(),
      },
      detached: false,
    });

    this.weSpawned = true;

    this.process.stdout?.on('data', (data: Buffer) => {
      console.log('[oceangram-daemon]', data.toString().trim());
    });

    this.process.stderr?.on('data', (data: Buffer) => {
      console.error('[oceangram-daemon]', data.toString().trim());
    });

    this.process.on('exit', (code) => {
      console.log(`[Oceangram] Daemon exited with code ${code}`);
      this.process = null;
    });
  }

  async checkHealth(): Promise<{ status: string; connected: boolean } | null> {
    return new Promise((resolve) => {
      const req = http.get(`${this.baseUrl}/health`, { timeout: 2000 }, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(null);
          }
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    });
  }

  private async waitForHealth(timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const health = await this.checkHealth();
      if (health?.status === 'ok') return true;
      await new Promise(r => setTimeout(r, 500));
    }
    return false;
  }

  getStatus(): DaemonStatus {
    return {
      running: this.process !== null || !this.weSpawned,
      connected: false, // caller should check via health
      weSpawned: this.weSpawned,
      port: this.port,
    };
  }

  kill(): void {
    if (this.process && this.weSpawned) {
      console.log('[Oceangram] Killing daemon process');
      this.process.kill('SIGTERM');
      this.process = null;
    }
  }

  dispose(): void {
    this.kill();
  }
}
