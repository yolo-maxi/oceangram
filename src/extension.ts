import * as vscode from 'vscode';
import { CommsPicker } from './commsPanel';
import { KanbanPanel } from './kanbanPanel';
import { SimplePanel } from './simplePanel';
import { ResourcePanel } from './resourcePanel';
import { AgentPanel } from './agentPanel';
import { setStoragePath } from './services/telegram';
import { showQuickPick } from './quickPick';

export function activate(context: vscode.ExtensionContext) {
  // Use VS Code's globalStorageUri for cache — always local to the UI machine
  setStoragePath(context.globalStorageUri.fsPath);
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
}
