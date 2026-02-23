import * as vscode from 'vscode';
import { CommsPicker } from './commsPanel';
import { KanbanPanel } from './kanbanPanel';
import { SimplePanel } from './simplePanel';
import { ResourcePanel } from './resourcePanel';
import { AgentPanel } from './agent/agentPanel';
import { setStoragePath } from './services/telegram';
import { DaemonManager } from './services/daemonManager';
import { TelegramApiClient } from './services/telegramApi';
import { showQuickPick } from './quickPick';
import { showChatPicker } from './chatPicker';
import { OpenClawGatewayClient } from './agent/openclawGateway';
import { AnnotationManager } from './agent/annotations';

let daemonManager: DaemonManager | undefined;
let telegramApi: TelegramApiClient | undefined;
let gatewayClient: OpenClawGatewayClient | undefined;
let annotationManager: AnnotationManager | undefined;

/** Check if agent features are enabled via settings */
export function isAgentEnabled(): boolean {
  return vscode.workspace.getConfiguration('oceangram').get<boolean>('features.agent', true);
}

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

  // --- Agent features (gated by oceangram.features.agent) ---
  const agentEnabled = isAgentEnabled();

  if (agentEnabled) {
    // Initialize OpenClaw Gateway WS client
    const gwUrl = vscode.workspace.getConfiguration('oceangram').get<string>('gatewayUrl') || 'ws://127.0.0.1:18789';
    const gwToken = vscode.workspace.getConfiguration('oceangram').get<string>('gatewayToken') || '';
    if (gwToken) {
      gatewayClient = new OpenClawGatewayClient(gwUrl, gwToken);
      context.subscriptions.push({ dispose: () => gatewayClient?.dispose() });
      gatewayClient.connect().then(() => {
        console.log('[Oceangram] Connected to OpenClaw Gateway WS');
      }).catch(err => {
        // Graceful degradation — gateway not available is fine
        console.warn('[Oceangram] Gateway WS connect failed (agent features unavailable):', err.message);
      });
    } else {
      console.log('[Oceangram] No gatewayToken configured, skipping Gateway WS');
    }

    // Initialize Annotation Manager
    annotationManager = new AnnotationManager();
    context.subscriptions.push(annotationManager);

    // Wire gateway events to annotation manager
    if (gatewayClient) {
      // Listen for agent message events from the gateway
      gatewayClient.on('event:chat.message', (data: any) => {
        if (data?.role === 'assistant' && data?.content && annotationManager) {
          const content = typeof data.content === 'string' ? data.content : String(data.content);
          const created = annotationManager.processMessage(content);
          if (created.length > 0) {
            console.log(`[Oceangram] Created ${created.length} annotation(s) from agent message`);
          }
        }
      });
      // Also listen for generic message events
      gatewayClient.on('event:message', (data: any) => {
        if (data?.role === 'assistant' && data?.content && annotationManager) {
          const content = typeof data.content === 'string' ? data.content : String(data.content);
          const created = annotationManager.processMessage(content);
          if (created.length > 0) {
            console.log(`[Oceangram] Created ${created.length} annotation(s) from agent message`);
          }
        }
      });
    }
  } else {
    console.log('[Oceangram] Agent features disabled via oceangram.features.agent setting');
  }

  // Clear Annotations command (always registered, graceful when disabled)
  context.subscriptions.push(
    vscode.commands.registerCommand('oceangram.clearAnnotations', () => {
      if (!agentEnabled) {
        vscode.window.showInformationMessage('Enable agent features in settings (oceangram.features.agent)');
        return;
      }
      if (annotationManager) {
        const count = annotationManager.count;
        annotationManager.clearAll();
        vscode.window.showInformationMessage(`Cleared ${count} annotation(s).`);
      }
    })
  );

  // Toggle Annotations command (always registered, graceful when disabled)
  context.subscriptions.push(
    vscode.commands.registerCommand('oceangram.toggleAnnotations', () => {
      if (!agentEnabled) {
        vscode.window.showInformationMessage('Enable agent features in settings (oceangram.features.agent)');
        return;
      }
      if (annotationManager) {
        const visible = annotationManager.toggle();
        vscode.window.showInformationMessage(
          `Annotations ${visible ? 'shown' : 'hidden'} (${annotationManager.count} total).`
        );
      }
    })
  );

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

  // Agent Status (Cmd+Shift+4) — always registered, graceful when disabled
  context.subscriptions.push(
    vscode.commands.registerCommand('oceangram.openAgent', () => {
      if (!agentEnabled) {
        vscode.window.showInformationMessage('Enable agent features in settings (oceangram.features.agent)');
        return;
      }
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

  // Send terminal output to chat (Cmd+Shift+T)
  context.subscriptions.push(
    vscode.commands.registerCommand('oceangram.sendTerminalToChat', async () => {
      const terminal = vscode.window.activeTerminal;
      if (!terminal) {
        vscode.window.showWarningMessage('No active terminal. Open a terminal first.');
        return;
      }

      // Copy the terminal selection to clipboard, then read it
      await vscode.commands.executeCommand('workbench.action.terminal.copySelection');
      const clipboardText = await vscode.env.clipboard.readText();

      if (!clipboardText || !clipboardText.trim()) {
        // No selection — inform user
        vscode.window.showInformationMessage(
          'Select text in the terminal first, then run this command. The selected text will be sent as a code block.'
        );
        return;
      }

      // Pick a chat to send to
      const api = getTelegramApi();
      if (!api) {
        vscode.window.showWarningMessage('Telegram not connected. Open Comms first.');
        return;
      }

      const { showChatPicker } = await import('./chatPicker');
      const chosen = await showChatPicker(api);
      if (!chosen) { return; }

      // Format as code block and send
      const codeBlock = '```\n' + clipboardText.trim() + '\n```';
      try {
        await api.connect();
        await api.sendMessage(chosen.id, codeBlock);
        vscode.window.showInformationMessage(`Terminal output sent to ${chosen.name}`);
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to send: ${err.message}`);
      }
    })
  );

  // Send to Chat — editor context menu
  context.subscriptions.push(
    vscode.commands.registerCommand('oceangram.sendToChat', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        vscode.window.showWarningMessage('Select some text first.');
        return;
      }

      const selection = editor.selection;
      const selectedText = editor.document.getText(selection);
      const fileName = vscode.workspace.asRelativePath(editor.document.uri);
      const startLine = selection.start.line + 1;
      const endLine = selection.end.line + 1;
      const languageId = editor.document.languageId;
      const lineRange = startLine === endLine ? `L${startLine}` : `L${startLine}-${endLine}`;

      const header = `📎 \`${fileName}:${lineRange}\``;
      const codeBlock = `\`\`\`${languageId}\n${selectedText}\n\`\`\``;
      const message = `${header}\n${codeBlock}`;

      const api = getTelegramApi();
      if (!api) {
        vscode.window.showErrorMessage('Telegram not connected. Open Comms first.');
        return;
      }

      const chat = await showChatPicker(api);
      if (!chat) { return; }

      try {
        await api.sendMessage(chat.id, message);
        vscode.window.showInformationMessage(`Sent to ${chat.name}`);
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to send: ${err.message}`);
      }
    })
  );

  // Send to Agent — editor context menu (always registered, graceful when disabled)
  context.subscriptions.push(
    vscode.commands.registerCommand('oceangram.sendToAgent', async () => {
      if (!agentEnabled) {
        vscode.window.showInformationMessage('Enable agent features in settings (oceangram.features.agent)');
        return;
      }

      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        vscode.window.showWarningMessage('Select some text first.');
        return;
      }

      const selection = editor.selection;
      const selectedText = editor.document.getText(selection);
      const fileName = vscode.workspace.asRelativePath(editor.document.uri);
      const startLine = selection.start.line + 1;
      const endLine = selection.end.line + 1;
      const languageId = editor.document.languageId;
      const lineRange = startLine === endLine ? `L${startLine}` : `L${startLine}-${endLine}`;

      const message = `File: ${fileName}:${lineRange}\n\`\`\`${languageId}\n${selectedText}\n\`\`\``;

      const gw = getGatewayClient();
      if (!gw || !gw.connected) {
        vscode.window.showErrorMessage('OpenClaw Gateway not connected. Check gatewayUrl and gatewayToken settings.');
        return;
      }

      try {
        await gw.sendChat(message);
        vscode.window.showInformationMessage('Sent to OpenClaw agent');
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to send to agent: ${err.message}`);
      }
    })
  );

  // Auto-open chat picker
  CommsPicker.show(context);

  // Cost ticker status bar item — only when agent features enabled
  if (agentEnabled) {
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
  }

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
