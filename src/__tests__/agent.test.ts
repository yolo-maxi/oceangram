import { describe, it, expect } from 'vitest';
import {
  parseContextWindow,
  parseSessionsInfo,
  parseGatewayStatus,
  parseChannels,
  parseCronList,
  parsePM2List,
  formatBytes,
  formatTokens,
  formatUptime,
  contextBarColor,
} from '../services/agent';

const SAMPLE_STATUS = `OpenClaw status

Overview
┌─────────────────┬──────────────────────────────────────┐
│ Item            │ Value                                │
├─────────────────┼──────────────────────────────────────┤
│ Gateway         │ local · ws://127.0.0.1:18789 (local loopback) · reachable 24ms │
│ Agents          │ 1 · sessions 80 · default claude-opus-4-6 (200k ctx)           │
│ Memory          │ 121 files · 1594 chunks                                        │
└─────────────────┴──────────────────────────────────────┘

Channels
┌──────────┬─────────┬────────┬──────────┐
│ Telegram │ ON      │ WARN   │ token    │
│ WhatsApp │ ON      │ WARN   │ linked   │
└──────────┴─────────┴────────┴──────────┘`;

const SAMPLE_CRON = `ID                                   Name                     Schedule                         Next       Last       Status    Target    Agent     
d3b4baf3-35f0-4fc2-870e-312d27ab15b4 SSS Hourly Report        every 1h                         in 35m     25m ago    ok        isolated  main
f11537a2-1901-4bd2-85d9-8e6c37472798 supstrategy-6h-report    cron 0 */6 * * *                 in 2h      4h ago     ok        isolated  main
3f7aea7e-4b6f-4617-a7a7-f82a545c1178 Static Site Secret Audit cron 0 3 * * * @ Asia/Ho_Chi_... in 4h      20h ago    ok        isolated  main`;

const SAMPLE_PM2 = JSON.stringify([
  {
    name: 'king-guard',
    pm2_env: { status: 'online', pm_uptime: Date.now() - 3600000, restart_time: 2 },
    monit: { memory: 123674624, cpu: 0.1 },
  },
  {
    name: 'yolomaxi-relay',
    pm2_env: { status: 'stopped', pm_uptime: 0, restart_time: 5 },
    monit: { memory: 0, cpu: 0 },
  },
  {
    name: 'rikai-api',
    pm2_env: { status: 'online', pm_uptime: Date.now() - 86400000, restart_time: 0 },
    monit: { memory: 67108864, cpu: 1.5 },
  },
]);

// --- Context Window ---

describe('parseContextWindow', () => {
  it('extracts max from status text', () => {
    const ctx = parseContextWindow(SAMPLE_STATUS);
    expect(ctx.max).toBe(200000);
  });

  it('calculates percentage', () => {
    const ctx = parseContextWindow(SAMPLE_STATUS);
    expect(ctx.percentage).toBeGreaterThanOrEqual(0);
    expect(ctx.percentage).toBeLessThanOrEqual(100);
  });

  it('handles missing context info', () => {
    const ctx = parseContextWindow('no context here');
    expect(ctx.max).toBe(200000); // default
  });

  it('extracts used tokens from session count', () => {
    const ctx = parseContextWindow(SAMPLE_STATUS);
    // 80 sessions * 1000 = 80000
    expect(ctx.used).toBe(80000);
    expect(ctx.percentage).toBe(40);
  });
});

// --- Sessions ---

describe('parseSessionsInfo', () => {
  it('extracts session count', () => {
    const info = parseSessionsInfo(SAMPLE_STATUS);
    expect(info.total).toBe(80);
  });

  it('extracts model name', () => {
    const info = parseSessionsInfo(SAMPLE_STATUS);
    expect(info.model).toBe('claude-opus-4-6');
  });

  it('handles missing info gracefully', () => {
    const info = parseSessionsInfo('nothing here');
    expect(info.total).toBe(0);
    expect(info.model).toBe('unknown');
  });
});

// --- Gateway ---

describe('parseGatewayStatus', () => {
  it('detects connected gateway', () => {
    expect(parseGatewayStatus(SAMPLE_STATUS)).toBe('connected');
  });

  it('returns unknown for missing', () => {
    expect(parseGatewayStatus('nothing')).toBe('unknown');
  });
});

// --- Channels ---

describe('parseChannels', () => {
  it('parses channel list', () => {
    const channels = parseChannels(SAMPLE_STATUS);
    expect(channels.length).toBe(2);
    expect(channels[0].name).toBe('Telegram');
    expect(channels[1].name).toBe('WhatsApp');
  });
});

// --- Cron ---

describe('parseCronList', () => {
  it('parses cron jobs', () => {
    const crons = parseCronList(SAMPLE_CRON);
    expect(crons.length).toBe(3);
    expect(crons[0].name).toBe('SSS Hourly Report');
    expect(crons[0].status).toBe('ok');
    expect(crons[0].nextRun).toBe('in 35m');
  });

  it('handles empty input', () => {
    expect(parseCronList('')).toEqual([]);
  });
});

// --- PM2 ---

describe('parsePM2List', () => {
  it('parses PM2 process list', () => {
    const procs = parsePM2List(SAMPLE_PM2);
    expect(procs.length).toBe(3);
    expect(procs[0].name).toBe('king-guard');
    expect(procs[0].status).toBe('online');
    expect(procs[0].memory).toBe(123674624);
    expect(procs[1].status).toBe('stopped');
  });

  it('handles invalid JSON', () => {
    expect(parsePM2List('not json')).toEqual([]);
  });

  it('handles empty array', () => {
    expect(parsePM2List('[]')).toEqual([]);
  });
});

// --- Formatters ---

describe('formatBytes', () => {
  it('formats bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(123674624)).toBe('117.9 MB');
    expect(formatBytes(1073741824)).toBe('1.0 GB');
  });
});

describe('formatTokens', () => {
  it('formats token counts', () => {
    expect(formatTokens(500)).toBe('500');
    expect(formatTokens(1000)).toBe('1K');
    expect(formatTokens(45000)).toBe('45K');
    expect(formatTokens(200000)).toBe('200K');
  });
});

describe('formatUptime', () => {
  it('formats various durations', () => {
    const now = Date.now();
    expect(formatUptime(now - 30000)).toBe('30s');
    expect(formatUptime(now - 300000)).toBe('5m');
    expect(formatUptime(now - 7200000)).toBe('2h 0m');
    expect(formatUptime(now - 90000000)).toBe('1d 1h');
  });

  it('handles future timestamp', () => {
    expect(formatUptime(Date.now() + 10000)).toBe('just started');
  });
});

describe('contextBarColor', () => {
  it('returns green for low usage', () => {
    expect(contextBarColor(10)).toBe('#4caf50');
    expect(contextBarColor(49)).toBe('#4caf50');
  });

  it('returns orange for medium usage', () => {
    expect(contextBarColor(50)).toBe('#ff9800');
    expect(contextBarColor(74)).toBe('#ff9800');
  });

  it('returns red for high usage', () => {
    expect(contextBarColor(75)).toBe('#f44336');
    expect(contextBarColor(89)).toBe('#f44336');
  });

  it('returns dark red for critical usage', () => {
    expect(contextBarColor(90)).toBe('#d32f2f');
    expect(contextBarColor(100)).toBe('#d32f2f');
  });
});
