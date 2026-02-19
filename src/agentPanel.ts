import * as vscode from 'vscode';
import * as fs from 'fs';
import {
  fetchAgentPanelData,
  getSessionsPath,
  formatTokens,
  formatRelativeTime,
  formatCost,
  contextBarColor,
  friendlySessionName,
  estimateCost,
  AgentPanelData,
  SessionEntry,
  SessionGroup,
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

    try {
      const sessionsPath = getSessionsPath();
      this.fileWatcher = fs.watch(sessionsPath, () => this.refresh());
    } catch { /* file may not exist yet */ }

    this.refresh();
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

  private renderSessionCard(s: SessionEntry, indent: boolean = false): string {
    const name = friendlySessionName(s);
    const model = (s.model || 'default').replace(/^anthropic\//, '');
    const lastActive = formatRelativeTime(s.updatedAt);
    const cost = estimateCost(s);
    const costStr = formatCost(cost);

    const ctxMax = s.contextTokens || 0;
    const ctxUsed = s.totalTokens || 0;
    const pct = ctxMax > 0 ? Math.min(Math.round((ctxUsed / ctxMax) * 100), 100) : 0;
    const barColor = contextBarColor(pct);

    const isActive = (Date.now() - s.updatedAt) < 5 * 60 * 1000;
    const dotClass = isActive ? 'active' : 'idle';
    const indentClass = indent ? ' sub-agent' : '';

    const ctxBar = ctxMax > 0
      ? `<div class="ctx-bar-bg">
           <div class="ctx-bar-fill" style="width:${pct}%;background:${barColor}"></div>
         </div>`
      : '';

    const ctxLabel = ctxMax > 0
      ? `<span class="ctx-pct">${pct}%</span>
         <span class="ctx-tokens">${formatTokens(ctxUsed)} / ${formatTokens(ctxMax)}</span>`
      : '<span class="ctx-tokens dim">No context data</span>';

    return `
    <div class="session-card${indentClass}">
      <div class="session-row-1">
        <span class="dot ${dotClass}"></span>
        <span class="session-name">${this.esc(name)}</span>
        <span class="session-time">${lastActive}</span>
      </div>
      ${ctxBar}
      <div class="session-row-2">
        <div class="session-meta-left">
          ${ctxLabel}
        </div>
        <div class="session-meta-right">
          <span class="session-model">${this.esc(model)}</span>
          <span class="session-cost">${costStr}</span>
        </div>
      </div>
    </div>`;
  }

  private renderGroup(g: SessionGroup): string {
    let html = this.renderSessionCard(g.parent, false);
    for (const child of g.children) {
      html += this.renderSessionCard(child, true);
    }
    return html;
  }

  private esc(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  private getHtml(data: AgentPanelData): string {
    const groupRows = data.groups.map(g => this.renderGroup(g)).join('');
    const subAgentCount = data.groups.reduce((n, g) => n + g.children.length, 0);

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
:root {
  --bg: #0e1621;
  --bg2: #17212b;
  --text: #f5f5f5;
  --text2: #708499;
  --accent: #6ab2f2;
  --border: #1e2c3a;
  --card: #17212b;
  --card-hover: #1c2a3a;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  color: var(--text);
  background: var(--bg);
  padding: 16px;
  font-size: 13px;
}

/* Header */
.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 14px;
}
.header h1 { font-size: 16px; font-weight: 600; }
.refresh-btn {
  background: none;
  border: 1px solid var(--border);
  color: var(--accent);
  padding: 3px 10px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
}
.refresh-btn:hover { background: var(--bg2); }

/* Summary strip */
.summary {
  display: flex;
  gap: 16px;
  align-items: center;
  padding: 10px 14px;
  background: var(--bg2);
  border-radius: 8px;
  margin-bottom: 14px;
  font-size: 12px;
  color: var(--text2);
  flex-wrap: wrap;
}
.summary .val { color: var(--text); font-weight: 600; }
.summary .accent { color: var(--accent); }
.sep { opacity: 0.3; }

/* Session cards */
.sessions { display: flex; flex-direction: column; gap: 2px; }

.session-card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 12px;
  transition: background 0.15s;
}
.session-card:hover { background: var(--card-hover); }

.session-card.sub-agent {
  margin-left: 24px;
  border-left: 2px solid var(--accent);
  border-radius: 0 8px 8px 0;
  opacity: 0.85;
}

.session-row-1 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}
.session-name {
  font-weight: 600;
  font-size: 13px;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.session-time {
  font-size: 11px;
  color: var(--text2);
  flex-shrink: 0;
}

.dot {
  display: inline-block;
  width: 7px; height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}
.dot.active { background: #4caf50; box-shadow: 0 0 4px #4caf5080; }
.dot.idle { background: #708499; }

/* Context bar */
.ctx-bar-bg {
  width: 100%;
  height: 4px;
  background: var(--border);
  border-radius: 2px;
  overflow: hidden;
  margin-bottom: 4px;
}
.ctx-bar-fill {
  height: 100%;
  border-radius: 2px;
  transition: width 0.3s ease;
}

.session-row-2 {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 11px;
  color: var(--text2);
}
.session-meta-left {
  display: flex;
  align-items: center;
  gap: 8px;
}
.session-meta-right {
  display: flex;
  align-items: center;
  gap: 10px;
}
.ctx-pct {
  font-weight: 600;
  color: var(--text);
}
.ctx-tokens { color: var(--text2); }
.ctx-tokens.dim { font-style: italic; }
.session-model {
  color: var(--text2);
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 10px;
}
.session-cost {
  color: var(--accent);
  font-weight: 500;
}

.empty-state {
  text-align: center;
  padding: 40px 20px;
  color: var(--text2);
}
</style>
</head>
<body>
<div class="header">
  <h1>🤖 Agent Status</h1>
  <button class="refresh-btn" onclick="vscode.postMessage({command:'refresh'})">↻ Refresh</button>
</div>

<div class="summary">
  <span><span class="val">${data.activeSessions}</span> active</span>
  <span class="sep">|</span>
  <span><span class="val">${data.totalSessions}</span> sessions</span>
  ${subAgentCount > 0 ? `<span class="sep">|</span><span><span class="val accent">🔄 ${subAgentCount}</span> sub-agents</span>` : ''}
  <span class="sep">|</span>
  <span>model: <span class="val">${this.esc(data.defaultModel.replace(/^anthropic\//, ''))}</span></span>
  <span class="sep">|</span>
  <span>est. cost: <span class="val accent">${formatCost(data.totalCostEstimate)}</span></span>
</div>

<div class="sessions">
  ${groupRows || '<div class="empty-state">No sessions found</div>'}
</div>

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
