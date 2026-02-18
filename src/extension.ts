import * as vscode from 'vscode';
import { OceangramWebviewProvider } from './webviewProvider';
import { CommsPanel } from './commsPanel';

export function activate(context: vscode.ExtensionContext) {
  // Comms — opens as editor tab
  context.subscriptions.push(
    vscode.commands.registerCommand('oceangram.openComms', () => {
      CommsPanel.createOrShow(context);
    })
  );

  // Auto-open Comms on activation
  CommsPanel.createOrShow(context);

  // Other panels — sidebar placeholders
  const placeholderPanels = [
    { viewId: 'oceangram.kanban', title: 'Kanban', emoji: '📋' },
    { viewId: 'oceangram.resources', title: 'Resources', emoji: '📦' },
    { viewId: 'oceangram.agentStatus', title: 'Agent Status', emoji: '🤖' },
  ];

  for (const panel of placeholderPanels) {
    const provider = new OceangramWebviewProvider(context.extensionUri, panel.title, panel.emoji);
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(panel.viewId, provider)
    );
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('oceangram.refreshAll', () => {
      vscode.window.showInformationMessage('Oceangram: Panels refreshed');
    })
  );

  console.log('Oceangram activated');
}

export function deactivate() {}
