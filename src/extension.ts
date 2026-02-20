import * as vscode from 'vscode';
import { CommsPicker } from './commsPanel';
import { KanbanPanel } from './kanbanPanel';
import { SimplePanel } from './simplePanel';
import { ResourcePanel } from './resourcePanel';
import { AgentPanel } from './agentPanel';
import { setStoragePath } from './services/telegram';
import { DaemonManager } from './services/daemonManager';
import { TelegramApiClient } from './services/telegramApi';
import { showQuickPick } from './quickPick';

let daemonManager: DaemonManager | undefined;
let telegramApi: TelegramApiClient | undefined;

/** Get the shared TelegramApiClient (created on activate) */
export function getTelegramApi(): TelegramApiClient | undefined {
  return telegramApi;
}

export function activate(context: vscode.ExtensionContext) {
  // Use VS Code's globalStorageUri for cache — always local to the UI machine
  const storagePath = context.globalStorageUri.fsPath;
  setStoragePath(storagePath);

  // Initialize daemon manager
  daemonManager = new DaemonManager();
  context.subscriptions.push({ dispose: () => daemonManager?.dispose() });

  // Start daemon and create API client
  daemonManager.ensureRunning().then(async (running) => {
    if (running) {
      telegramApi = new TelegramApiClient(
        daemonManager!.getBaseUrl(),
        storagePath,
      );
      try {
        await telegramApi.connect();
        console.log('[Oceangram] Connected to daemon API');
      } catch (err) {
        console.error('[Oceangram] Failed to connect to daemon API:', err);
      }
    }
  }).catch(err => {
    console.error('[Oceangram] Daemon startup error:', err);
  });

  // Comms — chat picker (Cmd+Shift+1)
  context.subscriptions.push(
    vscode.commands.registerCommand('oceangram.openComms', () => {
      CommsPicker.show(context);
    })
  );

  // Kanban (Cmd+Shift+2)
  context.subscriptions.push(
    vscode.commands.registerCommand('oceangram.openKanban', () => {
      KanbanPanel.createOrShow(context);
    })
  );

  // Resources (Cmd+Shift+3)
  context.subscriptions.push(
    vscode.commands.registerCommand('oceangram.openResources', () => {
      ResourcePanel.createOrShow(context);
    })
  );

  // Agent Status (Cmd+Shift+4)
  context.subscriptions.push(
    vscode.commands.registerCommand('oceangram.openAgent', () => {
      AgentPanel.createOrShow(context);
    })
  );

  // Telegram login/logout command
  context.subscriptions.push(
    vscode.commands.registerCommand('oceangram.telegramLogin', async () => {
      const configPath = require('path').join(context.globalStorageUri.fsPath, 'config.json');
      try {
        const fs = require('fs');
        if (fs.existsSync(configPath)) {
          const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
          delete config.session;
          fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        }
      } catch { /* ignore */ }
      vscode.window.showInformationMessage('Session cleared. Open Comms to log in again.');
    })
  );

  // Quick command palette (Cmd+Shift+O)
  context.subscriptions.push(
    vscode.commands.registerCommand('oceangram.quickPick', () => {
      showQuickPick(context);
    })
  );

  // Auto-open chat picker
  CommsPicker.show(context);

  console.log('Oceangram activated — Cmd+Shift+1-4');
}

export function deactivate() {
  const { disposeHighlighter } = require('./services/highlighter');
  disposeHighlighter();

  // Shut down daemon if we spawned it
  if (daemonManager) {
    daemonManager.dispose();
    daemonManager = undefined;
  }

  // Disconnect API client
  if (telegramApi) {
    telegramApi.disconnect();
    telegramApi = undefined;
  }
}
