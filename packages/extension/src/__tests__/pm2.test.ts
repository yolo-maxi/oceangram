import { describe, it, expect } from 'vitest';
import { parsePM2Json, formatMemory, formatUptime, statusColor, enrichProcesses } from '../services/pm2';

const SAMPLE_PM2_JSON = JSON.stringify([
  {
    name: 'oceangram',
    pm_id: 0,
    monit: { cpu: 2.5, memory: 67108864 },
    pm2_env: {
      status: 'online',
      pm_uptime: Date.now() - 3600000, // 1 hour ago
      restart_time: 3,
      pm_cwd: '/home/xiko/oceangram',
      pm_out_log_path: '/home/xiko/.pm2/logs/oceangram-out.log',
      pm_err_log_path: '/home/xiko/.pm2/logs/oceangram-error.log',
    },
  },
  {
    name: 'langbot',
    pm_id: 1,
    monit: { cpu: 0, memory: 0 },
    pm2_env: {
      status: 'stopped',
      pm_uptime: 0,
      restart_time: 12,
      pm_cwd: '/home/xiko/langbot',
    },
  },
  {
    name: 'broken-app',
    pm_id: 2,
    monit: { cpu: 0, memory: 1048576 },
    pm2_env: {
      status: 'errored',
      pm_uptime: 0,
      restart_time: 99,
    },
  },
]);

describe('parsePM2Json', () => {
  it('parses valid PM2 jlist output', () => {
    const procs = parsePM2Json(SAMPLE_PM2_JSON);
    expect(procs).toHaveLength(3);
    expect(procs[0].name).toBe('oceangram');
    expect(procs[0].status).toBe('online');
    expect(procs[0].cpu).toBe(2.5);
    expect(procs[0].memory).toBe(67108864);
    expect(procs[0].restarts).toBe(3);
  });

  it('extracts pm2_env metadata', () => {
    const procs = parsePM2Json(SAMPLE_PM2_JSON);
    expect(procs[0].pm2_env?.pm_cwd).toBe('/home/xiko/oceangram');
    expect(procs[0].pm2_env?.pm_out_log_path).toContain('oceangram-out.log');
  });

  it('handles stopped processes', () => {
    const procs = parsePM2Json(SAMPLE_PM2_JSON);
    expect(procs[1].status).toBe('stopped');
    expect(procs[1].cpu).toBe(0);
    expect(procs[1].memory).toBe(0);
  });

  it('handles errored processes', () => {
    const procs = parsePM2Json(SAMPLE_PM2_JSON);
    expect(procs[2].status).toBe('errored');
    expect(procs[2].restarts).toBe(99);
  });

  it('returns empty array for invalid JSON', () => {
    expect(parsePM2Json('not json')).toEqual([]);
    expect(parsePM2Json('')).toEqual([]);
  });

  it('returns empty array for non-array JSON', () => {
    expect(parsePM2Json('{"foo": "bar"}')).toEqual([]);
  });

  it('handles missing monit/pm2_env fields gracefully', () => {
    const procs = parsePM2Json(JSON.stringify([{ name: 'bare', pm_id: 5 }]));
    expect(procs).toHaveLength(1);
    expect(procs[0].cpu).toBe(0);
    expect(procs[0].memory).toBe(0);
    expect(procs[0].status).toBe('unknown');
    expect(procs[0].restarts).toBe(0);
  });
});

describe('formatMemory', () => {
  it('formats 0 bytes', () => {
    expect(formatMemory(0)).toBe('0 B');
  });

  it('formats bytes', () => {
    expect(formatMemory(500)).toBe('500 B');
  });

  it('formats kilobytes', () => {
    expect(formatMemory(2048)).toBe('2.0 KB');
  });

  it('formats megabytes', () => {
    expect(formatMemory(67108864)).toBe('64.0 MB');
  });

  it('formats gigabytes', () => {
    expect(formatMemory(1610612736)).toBe('1.50 GB');
  });

  it('handles negative values', () => {
    expect(formatMemory(-100)).toBe('0 B');
  });
});

describe('formatUptime', () => {
  it('returns dash for 0 or negative', () => {
    expect(formatUptime(0)).toBe('-');
    expect(formatUptime(-1000)).toBe('-');
  });

  it('formats seconds', () => {
    expect(formatUptime(45000)).toBe('45s');
  });

  it('formats minutes', () => {
    expect(formatUptime(300000)).toBe('5m');
  });

  it('formats hours and minutes', () => {
    expect(formatUptime(3660000)).toBe('1h 1m');
  });

  it('formats days and hours', () => {
    expect(formatUptime(90000000)).toBe('1d 1h');
  });
});

describe('statusColor', () => {
  it('returns green for online', () => {
    expect(statusColor('online')).toBe('#4caf50');
  });

  it('returns yellow/orange for stopped', () => {
    expect(statusColor('stopped')).toBe('#ff9800');
  });

  it('returns red for errored', () => {
    expect(statusColor('errored')).toBe('#f44336');
  });

  it('returns blue for launching', () => {
    expect(statusColor('launching')).toBe('#2196f3');
  });

  it('returns gray for unknown status', () => {
    expect(statusColor('whatever')).toBe('#888');
  });
});

describe('enrichProcesses', () => {
  it('adds formatted display fields', () => {
    const procs = parsePM2Json(SAMPLE_PM2_JSON);
    const enriched = enrichProcesses(procs);
    expect(enriched).toHaveLength(3);
    expect(enriched[0].memoryFormatted).toBe('64.0 MB');
    expect(enriched[0].statusColor).toBe('#4caf50');
    expect(enriched[0].uptimeFormatted).toMatch(/1h 0m/);
  });

  it('handles stopped processes display', () => {
    const procs = parsePM2Json(SAMPLE_PM2_JSON);
    const enriched = enrichProcesses(procs);
    expect(enriched[1].memoryFormatted).toBe('0 B');
    expect(enriched[1].uptimeFormatted).toBe('-');
    expect(enriched[1].statusColor).toBe('#ff9800');
  });
});
