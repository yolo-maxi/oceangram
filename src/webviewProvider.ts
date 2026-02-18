import * as vscode from 'vscode';

export class OceangramWebviewProvider implements vscode.WebviewViewProvider {
  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly panelTitle: string,
    private readonly emoji: string
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.getHtml();
  }

  private getHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      padding: 16px;
      margin: 0;
    }
    h2 { margin: 0 0 8px; font-size: 14px; font-weight: 600; }
    p { font-size: 12px; opacity: 0.7; margin: 0; }
    .container {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 120px;
    }
    .emoji { font-size: 32px; margin-bottom: 8px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="emoji">${this.emoji}</div>
    <h2>${this.panelTitle}</h2>
    <p>Panel coming soon</p>
  </div>
</body>
</html>`;
  }
}
