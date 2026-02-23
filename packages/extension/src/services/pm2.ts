import { execSync } from 'child_process';

export interface PM2Process {
  name: string;
  pm_id: number;
  status: 'online' | 'stopped' | 'errored' | 'launching' | string;
  cpu: number;
  memory: number;       // bytes
  uptime: number;       // ms since start (0 if stopped)
  restarts: number;
  pm2_env?: {
    pm_cwd?: string;
    pm_out_log_path?: string;
    pm_err_log_path?: string;
  };
}

export interface PM2ProcessDisplay extends PM2Process {
  memoryFormatted: string;
  uptimeFormatted: string;
  statusColor: string;
}

/**
 * Parse PM2 jlist JSON output into structured process list
 */
export function parsePM2Json(json: string): PM2Process[] {
  let data: any[];
  try {
    data = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) { return []; }

  return data.map(p => ({
    name: p.name ?? 'unknown',
    pm_id: p.pm_id ?? 0,
    status: p.pm2_env?.status ?? 'unknown',
    cpu: p.monit?.cpu ?? 0,
    memory: p.monit?.memory ?? 0,
    uptime: p.pm2_env?.pm_uptime ? (Date.now() - p.pm2_env.pm_uptime) : 0,
    restarts: p.pm2_env?.restart_time ?? 0,
    pm2_env: {
      pm_cwd: p.pm2_env?.pm_cwd,
      pm_out_log_path: p.pm2_env?.pm_out_log_path,
      pm_err_log_path: p.pm2_env?.pm_err_log_path,
    },
  }));
}

/**
 * Format bytes to human-readable string
 */
export function formatMemory(bytes: number): string {
  if (bytes <= 0) { return '0 B'; }
  if (bytes < 1024) { return `${bytes} B`; }
  if (bytes < 1024 * 1024) { return `${(bytes / 1024).toFixed(1)} KB`; }
  if (bytes < 1024 * 1024 * 1024) { return `${(bytes / (1024 * 1024)).toFixed(1)} MB`; }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Format uptime from milliseconds to human-readable
 */
export function formatUptime(ms: number): string {
  if (ms <= 0) { return '-'; }
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) { return `${seconds}s`; }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) { return `${minutes}m`; }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) { return `${hours}h ${minutes % 60}m`; }
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

/**
 * Map PM2 status to CSS color
 */
export function statusColor(status: string): string {
  switch (status) {
    case 'online': return '#4caf50';
    case 'stopped': return '#ff9800';
    case 'errored': return '#f44336';
    case 'launching': return '#2196f3';
    default: return '#888';
  }
}

/**
 * Enrich PM2 processes with display fields
 */
export function enrichProcesses(procs: PM2Process[]): PM2ProcessDisplay[] {
  return procs.map(p => ({
    ...p,
    memoryFormatted: formatMemory(p.memory),
    uptimeFormatted: formatUptime(p.uptime),
    statusColor: statusColor(p.status),
  }));
}

/**
 * Fetch live PM2 process list
 */
export function fetchPM2Processes(): PM2Process[] {
  try {
    const output = execSync('pm2 jlist', { encoding: 'utf-8', timeout: 5000 });
    return parsePM2Json(output);
  } catch {
    return [];
  }
}

/**
 * Execute a PM2 action
 */
export function pm2Action(action: 'restart' | 'stop' | 'delete', nameOrId: string | number): { success: boolean; output: string } {
  try {
    const output = execSync(`pm2 ${action} ${nameOrId}`, { encoding: 'utf-8', timeout: 10000 });
    return { success: true, output };
  } catch (e: any) {
    return { success: false, output: e.message || 'Unknown error' };
  }
}

/**
 * Get last N lines of PM2 logs for a process
 */
export function pm2Logs(nameOrId: string | number, lines: number = 50): string {
  try {
    return execSync(`pm2 logs ${nameOrId} --nostream --lines ${lines} 2>&1`, { encoding: 'utf-8', timeout: 5000 });
  } catch (e: any) {
    return e.message || 'Failed to fetch logs';
  }
}
