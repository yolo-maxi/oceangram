import * as vscode from 'vscode';
import { CommsPicker } from './commsPanel';
import { SimplePanel } from './simplePanel';

export function activate(context: vscode.ExtensionContext) {
  // Comms — chat picker (Cmd+Shift+1)
  context.subscriptions.push(
    vscode.commands.registerCommand('oceangram.openComms', () => {
      CommsPicker.show(context);
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

  // Auto-open chat picker
  CommsPicker.show(context);

  console.log('Oceangram activated — Cmd+Shift+1-4');
}

export function deactivate() {}
