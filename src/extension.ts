import * as vscode from 'vscode';
import { OceangramWebviewProvider } from './webviewProvider';

export function activate(context: vscode.ExtensionContext) {
  const panels = [
    { viewId: 'oceangram.comms', title: 'Comms', emoji: '💬' },
    { viewId: 'oceangram.kanban', title: 'Kanban', emoji: '📋' },
    { viewId: 'oceangram.resources', title: 'Resources', emoji: '📦' },
    { viewId: 'oceangram.agentStatus', title: 'Agent Status', emoji: '🤖' },
  ];

  for (const panel of panels) {
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
