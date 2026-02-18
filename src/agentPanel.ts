import * as vscode from 'vscode';
import {
  fetchAgentData,
  formatBytes,
  formatTokens,
  formatUptime,
  contextBarColor,
  AgentData,
  CronJob,
  PM2Process,
} from './services/agent';

export class AgentPanel {
  private static instance: AgentPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private refreshTimer: ReturnType<typeof setInterval> | undefined;

  public static createOrShow(context: vscode.ExtensionContext) {
    if (AgentPanel.instance) {
      AgentPanel.instance.panel.reveal(vscode.ViewColumn.One);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'oceangram.agent',
      '🤖 Agent',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    AgentPanel.instance = new AgentPanel(panel, context);
  }

  private constructor(panel: vscode.WebviewPanel, _context: vscode.ExtensionContext) {
    this.panel = panel;

    this.panel.onDidDispose(() => {
      AgentPanel.instance = undefined;
      if (this.refreshTimer) clearInterval(this.refreshTimer);
      this.disposables.forEach(d => d.dispose());
    }, null, this.disposables);

    // Handle messages from webview
    this.panel.webview.onDidReceiveMessage(
      (msg) => {
        if (msg.command === 'refresh') this.refresh();
      },
      null,
      this.disposables
    );

    this.refresh();
    this.refreshTimer = setInterval(() => this.refresh(), 30000);
  }

  private async refresh() {
    try {
      const data = await fetchAgentData();
      this.panel.webview.html = this.getHtml(data);
    } catch (e) {
      this.panel.webview.html = this.getErrorHtml(String(e));
    }
  }

  private getHtml(data: AgentData): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: var(--vscode-font-family, system-ui);
  color: var(--vscode-foreground, #ccc);
  background: var(--vscode-editor-background, #1e1e1e);
  padding: 16px;
  font-size: 13px;
}
.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.card {
  background: var(--vscode-editorWidget-background, #252526);
  border: 1px solid var(--vscode-editorWidget-border, #454545);
  border-radius: 6px;
  padding: 12px;
}
.card.full { grid-column: 1 / -1; }
.card h3 {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  opacity: 0.6;
  margin-bottom: 8px;
}
.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}
.header h1 { font-size: 18px; }
.badge {
  display: inline-block;
  background: var(--vscode-badge-background, #4d4d4d);
  color: var(--vscode-badge-foreground, #fff);
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 11px;
  font-weight: 600;
}
.badge.green { background: #2e7d32; }
.badge.orange { background: #e65100; }
.badge.red { background: #c62828; }
.model-name { font-size: 16px; font-weight: 600; }
.ctx-bar-bg {
  width: 100%;
  height: 20px;
  background: var(--vscode-input-background, #3c3c3c);
  border-radius: 4px;
  overflow: hidden;
  margin: 6px 0;
}
.ctx-bar-fill {
  height: 100%;
  border-radius: 4px;
  transition: width 0.3s;
}
.ctx-label {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  opacity: 0.8;
}
.stat-row {
  display: flex;
  justify-content: space-between;
  padding: 3px 0;
  border-bottom: 1px solid var(--vscode-editorWidget-border, #333);
}
.stat-row:last-child { border-bottom: none; }
.dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: 6px;
  vertical-align: middle;
}
.dot.online { background: #4caf50; }
.dot.stopped { background: #f44336; }
.dot.ok { background: #4caf50; }
.dot.error { background: #f44336; }
.dot.idle { background: #757575; }
.refresh-btn {
  background: none;
  border: 1px solid var(--vscode-button-border, #555);
  color: var(--vscode-foreground, #ccc);
  padding: 4px 10px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
}
.refresh-btn:hover { background: var(--vscode-button-hoverBackground, #444); }
.meta { font-size: 11px; opacity: 0.5; }
table { width: 100%; border-collapse: collapse; font-size: 12px; }
th { text-align: left; font-weight: 600; opacity: 0.6; padding: 4px 6px; font-size: 11px; text-transform: uppercase; }
td { padding: 4px 6px; border-top: 1px solid var(--vscode-editorWidget-border, #333); }
.channels { display: flex; gap: 8px; flex-wrap: wrap; }
.channel-badge {
  padding: 3px 8px;
  border-radius: 4px;
  font-size: 11px;
  background: var(--vscode-input-background, #3c3c3c);
}
</style>
</head>
<body>
<div class="header">
  <h1>🤖 Agent Status</h1>
  <button class="refresh-btn" onclick="vscode.postMessage({command:'refresh'})">↻ Refresh</button>
</div>

<div class="grid">
  <!-- Model & Gateway -->
  <div class="card">
    <h3>Model</h3>
    <div class="model-name">${data.model}</div>
    <div class="meta" style="margin-top:4px">
      Gateway: <span class="badge ${data.gateway === 'connected' ? 'green' : 'red'}">${data.gateway}</span>
    </div>
  </div>

  <!-- Sessions -->
  <div class="card">
    <h3>Sessions</h3>
    <div style="font-size:28px;font-weight:700">${data.sessions.total}</div>
    <div class="meta">active sessions</div>
    <div class="channels" style="margin-top:8px">
      ${data.channels.map(c => `<span class="channel-badge">${c.name}: ${c.state}</span>`).join('')}
    </div>
  </div>

  <!-- Context Window -->
  <div class="card full">
    <h3>Context Window</h3>
    <div class="ctx-bar-bg">
      <div class="ctx-bar-fill" style="width:${data.context.percentage}%;background:${contextBarColor(data.context.percentage)}"></div>
    </div>
    <div class="ctx-label">
      <span>${formatTokens(data.context.used)} used</span>
      <span>${data.context.percentage}%</span>
      <span>${formatTokens(data.context.max)} max</span>
    </div>
  </div>

  <!-- PM2 Processes -->
  <div class="card">
    <h3>PM2 Processes</h3>
    ${data.pm2.length === 0 ? '<div class="meta">No processes</div>' : data.pm2.map((p: PM2Process) => `
    <div class="stat-row">
      <span><span class="dot ${p.status}"></span>${p.name}</span>
      <span>${formatBytes(p.memory)} · ${formatUptime(p.uptime)} · ↻${p.restarts}</span>
    </div>`).join('')}
  </div>

  <!-- Cron Jobs -->
  <div class="card">
    <h3>Cron Jobs (${data.crons.length})</h3>
    ${data.crons.length === 0 ? '<div class="meta">No cron jobs</div>' : `
    <table>
      <tr><th>Name</th><th>Next</th><th>Status</th></tr>
      ${data.crons.slice(0, 10).map((c: CronJob) => `
      <tr>
        <td title="${c.schedule}">${c.name}</td>
        <td>${c.nextRun}</td>
        <td><span class="dot ${c.status}"></span>${c.status}</td>
      </tr>`).join('')}
    </table>
    ${data.crons.length > 10 ? `<div class="meta" style="margin-top:4px">+${data.crons.length - 10} more</div>` : ''}`}
  </div>
</div>

<div class="meta" style="margin-top:12px;text-align:center">Auto-refreshes every 30s</div>

<script>const vscode = acquireVsCodeApi();</script>
</body>
</html>`;
  }

  private getErrorHtml(error: string): string {
    return `<!DOCTYPE html>
<html><body style="font-family:system-ui;color:#ccc;background:#1e1e1e;padding:20px">
<h2>⚠️ Error loading agent data</h2>
<pre>${error}</pre>
<button onclick="vscode.postMessage({command:'refresh'})">Retry</button>
<script>const vscode = acquireVsCodeApi();</script>
</body></html>`;
  }
}
