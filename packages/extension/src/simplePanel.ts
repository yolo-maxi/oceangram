import * as vscode from 'vscode';

/**
 * Generic editor-tab panel for Kanban, Resources, Agent Status.
 * Each panel type is a singleton — reopening reveals the existing tab.
 */
export class SimplePanel {
  private static panels: Map<string, SimplePanel> = new Map();

  private readonly panel: vscode.WebviewPanel;
  private readonly id: string;
  private disposables: vscode.Disposable[] = [];

  public static createOrShow(id: string, title: string, context: vscode.ExtensionContext) {
    const existing = SimplePanel.panels.get(id);
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.One);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      `oceangram.${id}`,
      title,
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    SimplePanel.panels.set(id, new SimplePanel(panel, id, title));
  }

  private constructor(panel: vscode.WebviewPanel, id: string, title: string) {
    this.panel = panel;
    this.id = id;
    this.panel.webview.html = this.getHtml(title);

    this.panel.onDidDispose(() => {
      SimplePanel.panels.delete(this.id);
      this.disposables.forEach(d => d.dispose());
    }, null, this.disposables);
  }

  private getHtml(title: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
body {
  font-family: var(--vscode-font-family, system-ui);
  color: var(--vscode-foreground, #ccc);
  background: var(--vscode-editor-background, #1e1e1e);
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100vh;
  margin: 0;
}
.placeholder {
  text-align: center;
  opacity: 0.5;
}
.placeholder h1 { font-size: 48px; margin-bottom: 8px; }
.placeholder p { font-size: 16px; }
</style>
</head>
<body>
<div class="placeholder">
  <h1>${title.split(' ')[0]}</h1>
  <p>${title} — coming soon</p>
</div>
</body>
</html>`;
  }
}
