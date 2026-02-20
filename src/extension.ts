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
import { OpenClawGatewayClient } from './services/openclawGateway';

let daemonManager: DaemonManager | undefined;
let telegramApi: TelegramApiClient | undefined;
let gatewayClient: OpenClawGatewayClient | undefined;

/** Get the shared TelegramApiClient (created on activate) */
export function getTelegramApi(): TelegramApiClient | undefined {
  return telegramApi;
}

/** Get the shared OpenClaw Gateway WS client */
export function getGatewayClient(): OpenClawGatewayClient | undefined {
  return gatewayClient;
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

  // Initialize OpenClaw Gateway WS client
  const gwUrl = vscode.workspace.getConfiguration('oceangram').get<string>('gatewayUrl') || 'ws://127.0.0.1:18789';
  const gwToken = vscode.workspace.getConfiguration('oceangram').get<string>('gatewayToken') || '';
  if (gwToken) {
    gatewayClient = new OpenClawGatewayClient(gwUrl, gwToken);
    context.subscriptions.push({ dispose: () => gatewayClient?.dispose() });
    gatewayClient.connect().then(() => {
      console.log('[Oceangram] Connected to OpenClaw Gateway WS');
    }).catch(err => {
      console.error('[Oceangram] Gateway WS connect failed:', err.message);
    });
  } else {
    console.log('[Oceangram] No gatewayToken configured, skipping Gateway WS');
  }

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

  // Export chat command
  context.subscriptions.push(
    vscode.commands.registerCommand('oceangram.exportChat', () => {
      vscode.window.showInformationMessage('Use the 📥 button in an open chat header to export.');
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

  // Cost ticker status bar item (TASK-038)
  const costItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  costItem.command = 'oceangram.openAgent';
  costItem.tooltip = 'Oceangram: Today\'s estimated cost (click for details)';
  costItem.text = '💰 $0.00 today';
  costItem.show();
  context.subscriptions.push(costItem);

  const updateCostTicker = async () => {
    try {
      const fs = require('fs');
      const path = require('path');
      const sessionsPath = path.join(
        process.env.HOME || '~', '.openclaw', 'agents', 'main', 'sessions', 'sessions.json'
      );
      if (!fs.existsSync(sessionsPath)) { return; }
      const data = JSON.parse(fs.readFileSync(sessionsPath, 'utf-8'));
      const todayStart = new Date().setHours(0, 0, 0, 0);
      const PRICING: Record<string, { input: number; output: number; cacheRead: number }> = {
        'claude-opus-4-6': { input: 15, output: 75, cacheRead: 1.5 },
        'claude-opus-4-5': { input: 15, output: 75, cacheRead: 1.5 },
        'claude-sonnet-4-20250514': { input: 3, output: 15, cacheRead: 0.3 },
        'default': { input: 15, output: 75, cacheRead: 1.5 },
      };
      let totalCost = 0;
      for (const key of Object.keys(data)) {
        const s = data[key];
        if (!s.updatedAt || s.updatedAt < todayStart) { continue; }
        const model = s.model || 'default';
        const pricing = PRICING[model] || PRICING['default'];
        const input = (s.inputTokens || 0) / 1_000_000;
        const output = (s.outputTokens || 0) / 1_000_000;
        const cacheReads = input * 0.8;
        const freshInput = input * 0.2;
        totalCost += freshInput * pricing.input + output * pricing.output + cacheReads * pricing.cacheRead;
      }
      costItem.text = '💰 $' + totalCost.toFixed(2) + ' today';
    } catch {
      // silently ignore
    }
  };

  updateCostTicker();
  const costInterval = setInterval(updateCostTicker, 30000);
  context.subscriptions.push({ dispose: () => clearInterval(costInterval) });

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
