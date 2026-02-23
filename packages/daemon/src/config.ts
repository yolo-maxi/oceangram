import * as fs from 'fs';
import * as path from 'path';

const CONFIG_DIR = path.join(process.env.HOME || '/root', '.oceangram-daemon');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const PID_FILE = path.join(CONFIG_DIR, 'daemon.pid');

export const DEFAULT_API_ID = 35419737;
export const DEFAULT_API_HASH = 'f689329727c1f0002f72152be5f3f6fa';

export interface DaemonConfig {
  session?: string;
  apiId?: number;
  apiHash?: string;
  port?: number;
  authToken?: string;
}

export function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

export function getConfigDir(): string {
  return CONFIG_DIR;
}

export function loadConfig(): DaemonConfig {
  // Try daemon config first, then fall back to extension config (~/.oceangram/)
  const candidates = [
    CONFIG_FILE,
    path.join(process.env.HOME || '/root', '.oceangram', 'config.json'),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return JSON.parse(fs.readFileSync(candidate, 'utf-8'));
      }
    } catch { /* ignore */ }
  }
  return {};
}

export function saveConfig(config: DaemonConfig): void {
  ensureConfigDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function getApiId(): number {
  return parseInt(process.env.TELEGRAM_API_ID || '', 10) || loadConfig().apiId || DEFAULT_API_ID;
}

export function getApiHash(): string {
  return process.env.TELEGRAM_API_HASH || loadConfig().apiHash || DEFAULT_API_HASH;
}

export function getPort(): number {
  return parseInt(process.env.PORT || '', 10) || loadConfig().port || 7777;
}

export function getAuthToken(): string | undefined {
  return process.env.AUTH_TOKEN || loadConfig().authToken;
}

export function writePid(): void {
  ensureConfigDir();
  fs.writeFileSync(PID_FILE, process.pid.toString());
}

export function readPid(): number | null {
  try {
    if (fs.existsSync(PID_FILE)) {
      return parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
    }
  } catch { /* ignore */ }
  return null;
}

export function removePid(): void {
  try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
}
