// daemonManager.ts — Spawns and manages the oceangram-daemon child process
import { fork, ChildProcess } from 'child_process';
import path from 'path';
import http from 'http';

export class DaemonManager {
  private process: ChildProcess | null;
  private port: number;

  constructor() {
    this.process = null;
    this.port = 7777;
  }

  // Check if daemon is already running
  async isRunning(): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.get(`http://localhost:${this.port}/health`, (res) => {
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.setTimeout(2000, () => { req.destroy(); resolve(false); });
    });
  }

  // Get the daemon bundle path (works in dev and packaged)
  getBundlePath(): string {
    if (process.resourcesPath && !process.resourcesPath.includes('node_modules')) {
      // Packaged app
      return path.join(process.resourcesPath, 'daemon-bundle.js');
    }
    // Dev mode
    return path.join(__dirname, '..', 'resources', 'daemon-bundle.js');
  }

  // Start daemon as child process
  async start(): Promise<boolean> {
    if (await this.isRunning()) {
      console.log('[DaemonManager] Daemon already running on port', this.port);
      return true;
    }

    const bundlePath = this.getBundlePath();
    console.log('[DaemonManager] Starting daemon from:', bundlePath);

    this.process = fork(bundlePath, [], {
      env: { ...process.env, PORT: String(this.port) },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      detached: false,
    });

    this.process.stdout?.on('data', (d: Buffer) => console.log('[Daemon]', d.toString().trim()));
    this.process.stderr?.on('data', (d: Buffer) => console.error('[Daemon ERR]', d.toString().trim()));
    this.process.on('exit', (code: number | null) => {
      console.log('[DaemonManager] Daemon exited with code', code);
      this.process = null;
    });

    // Wait for health check
    return this.waitForReady(15000);
  }

  async waitForReady(timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await this.isRunning()) return true;
      await new Promise<void>((r) => setTimeout(r, 500));
    }
    console.error('[DaemonManager] Daemon failed to start within', timeoutMs, 'ms');
    return false;
  }

  stop(): void {
    if (this.process) {
      console.log('[DaemonManager] Stopping daemon process');
      this.process.kill('SIGTERM');
      // Force kill after 3 seconds if it doesn't exit gracefully
      const proc = this.process;
      setTimeout(() => {
        if (proc && !proc.killed) {
          proc.kill('SIGKILL');
        }
      }, 3000);
      this.process = null;
    }
  }
}
