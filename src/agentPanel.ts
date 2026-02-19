import * as vscode from 'vscode';
import * as fs from 'fs';
import {
  fetchAgentPanelData,
  getSessionsPath,
  formatTokens,
  formatRelativeTime,
  truncateKey,
  contextBarColor,
  AgentPanelData,
  SessionEntry,
} from './services/agent';

export class AgentPanel {
  private static instance: AgentPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  private fileWatcher: fs.FSWatcher | undefined;

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
      if (this.fileWatcher) this.fileWatcher.close();
      this.disposables.forEach(d => d.dispose());
    }, null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      (msg) => {
        if (msg.command === 'refresh') this.refresh();
      },
      null,
      this.disposables
    );

    // Watch sessions.json for changes
    try {
      const sessionsPath = getSessionsPath();
      this.fileWatcher = fs.watch(sessionsPath, () => {
        this.refresh();
      });
    } catch { /* file may not exist yet */ }

    this.refresh();
    // Also refresh on interval for relative time updates
    this.refreshTimer = setInterval(() => this.refresh(), 30000);
  }

  private async refresh() {
    try {
      const data = fetchAgentPanelData();
      this.panel.webview.html = this.getHtml(data);
    } catch (e) {
      this.panel.webview.html = this.getErrorHtml(String(e));
    }
  }

  private renderSessionRow(s: SessionEntry): string {
    const model = s.model || 'default';
    const lastActive = formatRelativeTime(s.updatedAt);
    const keyDisplay = truncateKey(s.key, 45);

    // Context usage
    const ctxMax = s.contextTokens || 0;
    const ctxUsed = s.totalTokens || 0;
    const pct = ctxMax > 0 ? Math.min(Math.round((ctxUsed / ctxMax) * 100), 100) : 0;
    const barColor = contextBarColor(pct);

    // Active badge (updated < 5min)
    const isActive = (Date.now() - s.updatedAt) < 5 * 60 * 1000;
    const activeDot = isActive
      ? '<span class="dot active"></span>'
      : '<span class="dot idle"></span>';

    const ctxBar = ctxMax > 0
      ? `<div class="ctx-bar-bg">
           <div class="ctx-bar-fill" style="width:${pct}%;background:${barColor}"></div>
         </div>
         <div class="ctx-label">
           <span>${formatTokens(ctxUsed)} / ${formatTokens(ctxMax)}</span>
           <span>${pct}%</span>
         </div>`
      : '<div class="ctx-label"><span class="meta">No context data</span></div>';

    return `
    <div class="session-card">
      <div class="session-header">
        <div class="session-info">
          ${activeDot}
          <span class="session-model">${this.escapeHtml(model)}</span>
          <span class="session-time">${lastActive}</span>
        </div>
      </div>
      ${ctxBar}
      <div class="session-key" title="${this.escapeHtml(s.key)}">${this.escapeHtml(keyDisplay)}</div>
    </div>`;
  }

  private escapeHtml(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  private getHtml(data: AgentPanelData): string {
    const sessionRows = data.sessions.map(s => this.renderSessionRow(s)).join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
:root {
  --tg-bg: #0e1621;
  --tg-bg-secondary: #17212b;
  --tg-text: #f5f5f5;
  --tg-text-secondary: #708499;
  --tg-accent: #6ab2f2;
  --tg-border: #1e2c3a;
  --tg-card: #17212b;
  --tg-card-hover: #1c2a3a;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  color: var(--tg-text);
  background: var(--tg-bg);
  padding: 16px;
  font-size: 13px;
}
.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--tg-border);
}
.header h1 {
  font-size: 18px;
  font-weight: 600;
  color: var(--tg-text);
}
.refresh-btn {
  background: none;
  border: 1px solid var(--tg-border);
  color: var(--tg-accent);
  padding: 4px 12px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
  transition: background 0.2s;
}
.refresh-btn:hover { background: var(--tg-bg-secondary); }

/* Stats bar */
.stats-bar {
  display: flex;
  gap: 12px;
  margin-bottom: 16px;
}
.stat-card {
  flex: 1;
  background: var(--tg-card);
  border: 1px solid var(--tg-border);
  border-radius: 8px;
  padding: 12px;
  text-align: center;
}
.stat-value {
  font-size: 24px;
  font-weight: 700;
  color: var(--tg-accent);
}
.stat-label {
  font-size: 11px;
  color: var(--tg-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-top: 2px;
}
.stat-model .stat-value {
  font-size: 14px;
  word-break: break-all;
}

/* Session cards */
.sessions-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.session-card {
  background: var(--tg-card);
  border: 1px solid var(--tg-border);
  border-radius: 8px;
  padding: 10px 12px;
  transition: background 0.15s;
}
.session-card:hover { background: var(--tg-card-hover); }
.session-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}
.session-info {
  display: flex;
  align-items: center;
  gap: 8px;
}
.session-model {
  font-weight: 600;
  font-size: 13px;
  color: var(--tg-text);
}
.session-time {
  font-size: 11px;
  color: var(--tg-text-secondary);
}
.session-key {
  font-size: 11px;
  color: var(--tg-text-secondary);
  font-family: 'SF Mono', 'Fira Code', monospace;
  margin-top: 4px;
}
.dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.dot.active { background: #4caf50; box-shadow: 0 0 4px #4caf5080; }
.dot.idle { background: #708499; }

/* Context bar */
.ctx-bar-bg {
  width: 100%;
  height: 6px;
  background: #1e2c3a;
  border-radius: 3px;
  overflow: hidden;
  margin: 4px 0 2px;
}
.ctx-bar-fill {
  height: 100%;
  border-radius: 3px;
  transition: width 0.3s ease;
}
.ctx-label {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: var(--tg-text-secondary);
}
.meta {
  font-size: 11px;
  color: var(--tg-text-secondary);
  font-style: italic;
}
.footer {
  text-align: center;
  margin-top: 12px;
  font-size: 11px;
  color: var(--tg-text-secondary);
}
</style>
</head>
<body>
<div class="header">
  <h1>🤖 Agent Status</h1>
  <button class="refresh-btn" onclick="vscode.postMessage({command:'refresh'})">↻ Refresh</button>
</div>

<div class="stats-bar">
  <div class="stat-card">
    <div class="stat-value">${data.totalSessions}</div>
    <div class="stat-label">Total Sessions</div>
  </div>
  <div class="stat-card">
    <div class="stat-value">${data.activeSessions}</div>
    <div class="stat-label">Active (&lt;5m)</div>
  </div>
  <div class="stat-card stat-model">
    <div class="stat-value">${this.escapeHtml(data.defaultModel)}</div>
    <div class="stat-label">Default Model</div>
  </div>
</div>

<div class="sessions-list">
  ${sessionRows || '<div class="meta" style="text-align:center;padding:20px">No sessions found</div>'}
</div>

<div class="footer">Auto-refreshes on file change &amp; every 30s</div>

<script>const vscode = acquireVsCodeApi();</script>
</body>
</html>`;
  }

  private getErrorHtml(error: string): string {
    return `<!DOCTYPE html>
<html><body style="font-family:system-ui;color:#f5f5f5;background:#0e1621;padding:20px">
<h2>⚠️ Error loading agent data</h2>
<pre style="color:#e06c75">${error}</pre>
<button onclick="vscode.postMessage({command:'refresh'})" style="margin-top:12px;padding:6px 16px;background:#6ab2f2;border:none;color:#0e1621;border-radius:6px;cursor:pointer">Retry</button>
<script>const vscode = acquireVsCodeApi();</script>
</body></html>`;
  }
}
