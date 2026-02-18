import * as vscode from 'vscode';
import { CommsPanel } from './commsPanel';
import { SimplePanel } from './simplePanel';

export function activate(context: vscode.ExtensionContext) {
  // Comms — Telegram chat (Cmd+Shift+1)
  context.subscriptions.push(
    vscode.commands.registerCommand('oceangram.openComms', () => {
      CommsPanel.createOrShow(context);
    })
  );

  // Kanban (Cmd+Shift+2)
  context.subscriptions.push(
    vscode.commands.registerCommand('oceangram.openKanban', () => {
      SimplePanel.createOrShow('kanban', '📋 Kanban', context);
    })
  );

  // Resources (Cmd+Shift+3)
  context.subscriptions.push(
    vscode.commands.registerCommand('oceangram.openResources', () => {
      SimplePanel.createOrShow('resources', '📦 Resources', context);
    })
  );

  // Agent Status (Cmd+Shift+4)
  context.subscriptions.push(
    vscode.commands.registerCommand('oceangram.openAgent', () => {
      SimplePanel.createOrShow('agent', '🤖 Agent', context);
    })
  );

  // Auto-open Comms on activation
  CommsPanel.createOrShow(context);

  console.log('Oceangram activated — no sidebar, all tabs. Cmd+Shift+1-4 to switch.');
}

export function deactivate() {}
