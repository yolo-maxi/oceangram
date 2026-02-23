import { describe, it, expect } from 'vitest';
import {
  extractAllUrls,
  maskKeyEnhanced,
  unmaskKey,
  parsePm2Json,
  parseGitLog,
  parseGitRemote,
} from '../services/resourceHelpers';

// --- TASK-046: URL extraction from markdown ---
describe('extractAllUrls', () => {
  it('extracts plain URLs from markdown', () => {
    const md = `Check https://example.com and http://api.test.io/v1/health`;
    const urls = extractAllUrls(md);
    expect(urls).toContainEqual({ url: 'https://example.com', label: 'example.com' });
    expect(urls).toContainEqual({ url: 'http://api.test.io/v1/health', label: 'api.test.io' });
  });

  it('extracts labeled URLs from markdown links', () => {
    const md = `- **Landing**: https://rikai.chat\n- **API**: https://api.rikai.chat/docs`;
    const urls = extractAllUrls(md);
    expect(urls.find(u => u.url === 'https://rikai.chat')?.label).toBe('Landing');
    expect(urls.find(u => u.url === 'https://api.rikai.chat/docs')?.label).toBe('API');
  });

  it('extracts markdown link syntax [text](url)', () => {
    const md = `Visit [our docs](https://docs.example.com) for info.`;
    const urls = extractAllUrls(md);
    expect(urls).toContainEqual({ url: 'https://docs.example.com', label: 'our docs' });
  });

  it('deduplicates URLs', () => {
    const md = `https://example.com appears twice: https://example.com`;
    const urls = extractAllUrls(md);
    const matches = urls.filter(u => u.url === 'https://example.com');
    expect(matches.length).toBe(1);
  });

  it('returns empty array for no URLs', () => {
    expect(extractAllUrls('no urls here')).toEqual([]);
  });

  it('handles URLs with trailing punctuation', () => {
    const md = `See https://example.com. And https://test.com, also.`;
    const urls = extractAllUrls(md);
    // Should not include trailing period/comma
    expect(urls.find(u => u.url === 'https://example.com')).toBeDefined();
    expect(urls.find(u => u.url === 'https://test.com')).toBeDefined();
  });
});

// --- TASK-047: Key masking ---
describe('maskKeyEnhanced', () => {
  it('shows first 4 and last 4 chars for long keys', () => {
    expect(maskKeyEnhanced('sk_live_abc123def456ghi')).toBe('sk_l****6ghi');
  });

  it('shows first 4 + last 4 with stars in middle', () => {
    const result = maskKeyEnhanced('abcdefghijklmnop');
    expect(result).toBe('abcd****mnop');
  });

  it('masks short keys completely', () => {
    expect(maskKeyEnhanced('short')).toBe('********');
    expect(maskKeyEnhanced('12345678')).toBe('********');
  });

  it('masks 9-char key showing first 4 + last 4', () => {
    expect(maskKeyEnhanced('123456789')).toBe('1234****6789');
  });
});

describe('unmaskKey', () => {
  it('returns the original key', () => {
    expect(unmaskKey('my-secret-key')).toBe('my-secret-key');
  });
});

// --- TASK-049: PM2 JSON parsing ---
describe('parsePm2Json', () => {
  const pm2Output = JSON.stringify([
    {
      name: 'langbot',
      pm2_env: {
        status: 'online',
        pm_uptime: Date.now() - 86400000,
        restart_time: 3,
        NODE_ENV: 'production',
      },
      monit: { memory: 52428800, cpu: 2.5 },
    },
    {
      name: 'web-server',
      pm2_env: {
        status: 'stopped',
        pm_uptime: 0,
        restart_time: 0,
        NODE_ENV: 'development',
      },
      monit: { memory: 0, cpu: 0 },
    },
  ]);

  it('parses process list', () => {
    const procs = parsePm2Json(pm2Output);
    expect(procs).toHaveLength(2);
  });

  it('extracts process name and status', () => {
    const procs = parsePm2Json(pm2Output);
    expect(procs[0].name).toBe('langbot');
    expect(procs[0].status).toBe('online');
    expect(procs[1].status).toBe('stopped');
  });

  it('extracts memory in MB', () => {
    const procs = parsePm2Json(pm2Output);
    expect(procs[0].memoryMB).toBeCloseTo(50, 0);
  });

  it('extracts environment', () => {
    const procs = parsePm2Json(pm2Output);
    expect(procs[0].env).toBe('production');
    expect(procs[1].env).toBe('development');
  });

  it('extracts uptime', () => {
    const procs = parsePm2Json(pm2Output);
    expect(procs[0].uptimeMs).toBeGreaterThan(0);
  });

  it('extracts restart count', () => {
    const procs = parsePm2Json(pm2Output);
    expect(procs[0].restarts).toBe(3);
  });

  it('handles invalid JSON gracefully', () => {
    expect(parsePm2Json('not json')).toEqual([]);
  });

  it('handles empty array', () => {
    expect(parsePm2Json('[]')).toEqual([]);
  });
});

// --- TASK-049: Git output parsing ---
describe('parseGitLog', () => {
  const gitLogOutput = `abc1234\n2026-02-20 10:30:00 +0700\nJohn Doe\nFix deployment bug`;

  it('parses commit hash', () => {
    const log = parseGitLog(gitLogOutput);
    expect(log?.hash).toBe('abc1234');
  });

  it('parses commit date', () => {
    const log = parseGitLog(gitLogOutput);
    expect(log?.date).toBe('2026-02-20 10:30:00 +0700');
  });

  it('parses author', () => {
    const log = parseGitLog(gitLogOutput);
    expect(log?.author).toBe('John Doe');
  });

  it('parses commit message', () => {
    const log = parseGitLog(gitLogOutput);
    expect(log?.message).toBe('Fix deployment bug');
  });

  it('handles empty output', () => {
    expect(parseGitLog('')).toBeNull();
  });

  it('handles malformed output', () => {
    expect(parseGitLog('only one line')).toBeNull();
  });
});

describe('parseGitRemote', () => {
  const remoteOutput = `origin\thttps://github.com/user/repo.git (fetch)\norigin\thttps://github.com/user/repo.git (push)`;

  it('extracts remote URL', () => {
    const remotes = parseGitRemote(remoteOutput);
    expect(remotes).toHaveLength(1);
    expect(remotes[0].name).toBe('origin');
    expect(remotes[0].url).toBe('https://github.com/user/repo.git');
  });

  it('handles multiple remotes', () => {
    const output = `origin\tgit@github.com:a/b.git (fetch)\norigin\tgit@github.com:a/b.git (push)\nupstream\thttps://github.com/c/d.git (fetch)\nupstream\thttps://github.com/c/d.git (push)`;
    const remotes = parseGitRemote(output);
    expect(remotes).toHaveLength(2);
  });

  it('handles empty output', () => {
    expect(parseGitRemote('')).toEqual([]);
  });
});
