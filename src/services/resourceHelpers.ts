/**
 * Enhanced resource helpers for TASK-046, TASK-047, TASK-049
 */

// --- TASK-046: URL extraction ---

export interface ExtractedUrl {
  url: string;
  label: string;
}

/**
 * Extract all URLs from a markdown document with labels.
 * Deduplicates by URL.
 */
export function extractAllUrls(markdown: string): ExtractedUrl[] {
  const seen = new Set<string>();
  const results: ExtractedUrl[] = [];

  const add = (url: string, label: string) => {
    // Strip trailing punctuation
    url = url.replace(/[.,;:!?)]+$/, '');
    if (seen.has(url)) return;
    seen.add(url);
    results.push({ url, label });
  };

  // Match [label](url) markdown links
  const mdLinkRegex = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
  let m;
  while ((m = mdLinkRegex.exec(markdown)) !== null) {
    add(m[2], m[1]);
  }

  // Match labeled URLs: **Label**: url or - Label: url
  for (const line of markdown.split('\n')) {
    const urlMatches = line.match(/https?:\/\/[^\s)>\]]+/g);
    if (!urlMatches) continue;
    const boldLabel = line.match(/\*\*(.+?)\*\*/)?.[1];
    const dashLabel = line.match(/^-\s*(.+?):/)?.[1]?.trim();
    for (const url of urlMatches) {
      const cleanUrl = url.replace(/[.,;:!?)]+$/, '');
      if (seen.has(cleanUrl)) continue;
      const label = boldLabel || dashLabel || new URL(cleanUrl).hostname;
      add(cleanUrl, label);
    }
  }

  return results;
}

// --- TASK-047: Key masking ---

/**
 * Mask an API key: show first 4 + last 4 chars, rest as ****
 * Keys <= 8 chars are fully masked.
 */
export function maskKeyEnhanced(key: string): string {
  if (key.length <= 8) return '********';
  return `${key.slice(0, 4)}****${key.slice(-4)}`;
}

/**
 * Return the unmasked key (identity function — used for reveal logic).
 * The actual reveal/re-mask timing is handled in the webview.
 */
export function unmaskKey(key: string): string {
  return key;
}

// --- TASK-049: PM2 parsing ---

export interface Pm2Process {
  name: string;
  status: string;
  memoryMB: number;
  cpu: number;
  uptimeMs: number;
  restarts: number;
  env: string;
}

/**
 * Parse PM2 jlist JSON output into structured process info.
 */
export function parsePm2Json(jsonStr: string): Pm2Process[] {
  try {
    const data = JSON.parse(jsonStr);
    if (!Array.isArray(data)) return [];
    return data.map((p: any) => ({
      name: p.name || 'unknown',
      status: p.pm2_env?.status || 'unknown',
      memoryMB: (p.monit?.memory || 0) / (1024 * 1024),
      cpu: p.monit?.cpu || 0,
      uptimeMs: p.pm2_env?.pm_uptime ? Date.now() - p.pm2_env.pm_uptime : 0,
      restarts: p.pm2_env?.restart_time || 0,
      env: p.pm2_env?.NODE_ENV || 'unknown',
    }));
  } catch {
    return [];
  }
}

// --- TASK-049: Git parsing ---

export interface GitLogInfo {
  hash: string;
  date: string;
  author: string;
  message: string;
}

/**
 * Parse output of `git log -1 --format="%h%n%ai%n%an%n%s"`
 */
export function parseGitLog(output: string): GitLogInfo | null {
  const lines = output.trim().split('\n');
  if (lines.length < 4) return null;
  return {
    hash: lines[0],
    date: lines[1],
    author: lines[2],
    message: lines[3],
  };
}

export interface GitRemote {
  name: string;
  url: string;
}

/**
 * Parse output of `git remote -v` — deduplicates fetch/push.
 */
export function parseGitRemote(output: string): GitRemote[] {
  if (!output.trim()) return [];
  const seen = new Set<string>();
  const results: GitRemote[] = [];
  for (const line of output.trim().split('\n')) {
    const m = line.match(/^(\S+)\t(.+?)\s+\(/);
    if (m && !seen.has(m[1])) {
      seen.add(m[1]);
      results.push({ name: m[1], url: m[2] });
    }
  }
  return results;
}

// --- TASK-049: Deployment status aggregator ---

export interface DeploymentStatus {
  git: GitLogInfo | null;
  remotes: GitRemote[];
  pm2Processes: Pm2Process[];
}

/**
 * Format uptime from milliseconds to human-readable string
 */
export function formatUptime(ms: number): string {
  if (ms <= 0) return 'N/A';
  const seconds = Math.floor(ms / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}
