import * as vscode from 'vscode';
import { CommsPicker } from './commsPanel';
import { KanbanPanel } from './kanbanPanel';
import { SimplePanel } from './simplePanel';
import { ResourcePanel } from './resourcePanel';
import { AgentPanel } from './agentPanel';

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

  // Auto-open chat picker
  CommsPicker.show(context);

  console.log('Oceangram activated — Cmd+Shift+1-4');
}

export function deactivate() {}
