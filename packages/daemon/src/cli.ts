#!/usr/bin/env node

import { readPid, removePid, getPort, loadConfig } from './config';
import { TelegramService } from './telegram';
import { createServer } from './server';

const command = process.argv[2] || 'start';

async function main() {
  switch (command) {
    case 'start':
      await start();
      break;
    case 'stop':
      stop();
      break;
    case 'status':
      status();
      break;
    default:
      console.log('Usage: oceangram-daemon <start|stop|status>');
      process.exit(1);
  }
}

async function start() {
  const existingPid = readPid();
  if (existingPid) {
    try {
      process.kill(existingPid, 0);
      console.error(`Daemon already running (PID ${existingPid})`);
      process.exit(1);
    } catch {
      removePid();
    }
  }

  const telegram = new TelegramService();
  const config = loadConfig();

  // Try to connect with existing session
  if (config.session) {
    try {
      await telegram.connect(config.session);
      console.log('Telegram connected');
    } catch (err: unknown) {
      const error = err as Error;
      if (error.message === 'NOT_AUTHORIZED') {
        console.log('Session expired. Visit http://127.0.0.1:' + getPort() + '/login to re-authenticate');
      } else {
        console.error('Telegram connection failed:', error.message);
      }
    }
  } else {
    console.log('No session found. Visit http://127.0.0.1:' + getPort() + '/login to authenticate');
  }

  await createServer(telegram);
  console.log(`oceangram-daemon listening on http://127.0.0.1:${getPort()}`);
}

function stop() {
  const pid = readPid();
  if (!pid) {
    console.log('Daemon not running');
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
    removePid();
    console.log(`Stopped daemon (PID ${pid})`);
  } catch {
    console.log('Daemon not running (stale PID file)');
    removePid();
  }
}

function status() {
  const pid = readPid();
  if (!pid) {
    console.log('Daemon not running');
    return;
  }
  try {
    process.kill(pid, 0);
    console.log(`Daemon running (PID ${pid}) on port ${getPort()}`);
  } catch {
    console.log('Daemon not running (stale PID file)');
    removePid();
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
