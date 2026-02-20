import * as vscode from 'vscode';
import {
  fetchAgentPanelData,
  getSessionsPath,
  formatTokens,
  formatRelativeTime,
  formatCost,
  formatDuration,
  formatBytes,
  contextBarColor,
  friendlySessionName,
  estimateCost,
  toggleCronJob,
  readMemoryFile,
  AgentPanelData,
  SessionEntry,
  SessionGroup,
  ToolInfo,
  CronJobInfo,
  SubAgentInfo,
  MemoryFile,
} from './services/agent';
import {
  ToolCallEntry,
  getActiveSessionId,
  getSessionJsonlPath,
  readToolCallsFromFile,
  getUniqueToolNames,
  filterByToolName,
} from './services/liveTools';
import { watchRemoteFile, remoteFileExists } from './services/remoteFs';

export class AgentPanel {
  private static instance: AgentPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  private fileWatcher: vscode.FileSystemWatcher | undefined;
  private currentTab: 'overview' | 'tools' | 'subagents' | 'crons' | 'costs' | 'memory' | 'livetools' = 'overview';
  private liveToolsFilter: string | null = null;
  private jsonlWatcher: vscode.FileSystemWatcher | undefined;
  private liveToolEntries: ToolCallEntry[] = [];

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
      if (this.fileWatcher) this.fileWatcher.dispose();
      if (this.jsonlWatcher) this.jsonlWatcher.dispose();
      this.disposables.forEach(d => d.dispose());
    }, null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      async (msg) => {
        switch (msg.command) {
          case 'refresh':
            this.refresh();
            break;
          case 'switchTab':
            this.currentTab = msg.tab;
            this.refresh();
            break;
          case 'toggleCron':
            await toggleCronJob(msg.jobId, msg.enable);
            this.refresh();
            break;
          case 'viewMemory':
            const content = await readMemoryFile(msg.path);
            this.panel.webview.postMessage({ command: 'memoryContent', path: msg.path, content });
            break;
          case 'killSubAgent':
            vscode.window.showWarningMessage(`Sub-agent kill not implemented yet: ${msg.sessionId}`);
            break;
          case 'liveToolsFilter':
            this.liveToolsFilter = msg.filter;
            this.refreshLiveTools();
            break;
        }
      },
      null,
      this.disposables
    );

    try {
      this.fileWatcher = watchRemoteFile(getSessionsPath());
      this.fileWatcher.onDidChange(() => this.refresh());
    } catch { /* file may not exist yet */ }

    this.setupJsonlWatcher();
    this.refresh();
    this.refreshTimer = setInterval(() => this.refresh(), 30000);
  }

  private async setupJsonlWatcher() {
    try {
      const sessionId = await getActiveSessionId();
      if (!sessionId) return;
      const jsonlPath = getSessionJsonlPath(sessionId);
      if (!(await remoteFileExists(jsonlPath))) return;
      this.jsonlWatcher = watchRemoteFile(jsonlPath);
      this.jsonlWatcher.onDidChange(() => this.refreshLiveTools());
      // Initial load
      this.liveToolEntries = await readToolCallsFromFile(jsonlPath);
    } catch { /* ignore */ }
  }

  private async refreshLiveTools() {
    try {
      const sessionId = await getActiveSessionId();
      if (!sessionId) return;
      const jsonlPath = getSessionJsonlPath(sessionId);
      this.liveToolEntries = await readToolCallsFromFile(jsonlPath);
      if (this.currentTab === 'livetools') {
        this.refresh();
      }
    } catch { /* ignore */ }
  }

  private async refresh() {
    try {
      const data = await fetchAgentPanelData();
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

  // --- Tab Renderers ---

  private renderOverviewTab(data: AgentPanelData): string {
    const groupRows = data.groups.map(g => this.renderGroup(g)).join('');
    const subAgentCount = data.groups.reduce((n, g) => n + g.children.length, 0);
    const config = data.config;

    return `
    <div class="config-section">
      <div class="config-row">
        <span class="config-label">Model:</span>
        <select class="model-select" onchange="switchModel(this.value)">
          ${config.availableModels.map(m => 
            `<option value="${m}" ${m === config.model ? 'selected' : ''}>${m}</option>`
          ).join('')}
        </select>
      </div>
      <div class="config-row">
        <span class="config-label">Thinking:</span>
        <span class="config-value">${this.esc(config.thinkingLevel)}</span>
      </div>
      <div class="config-row">
        <span class="config-label">Reasoning:</span>
        <span class="config-value badge ${config.reasoningMode === 'on' ? 'badge-on' : 'badge-off'}">${config.reasoningMode}</span>
      </div>
    </div>

    <div class="summary">
      <span><span class="val">${data.activeSessions}</span> active</span>
      <span class="sep">|</span>
      <span><span class="val">${data.totalSessions}</span> sessions</span>
      ${subAgentCount > 0 ? `<span class="sep">|</span><span><span class="val accent">🔄 ${subAgentCount}</span> sub-agents</span>` : ''}
      <span class="sep">|</span>
      <span>est. cost: <span class="val accent">${formatCost(data.totalCostEstimate)}</span></span>
    </div>

    <div class="sessions">
      ${groupRows || '<div class="empty-state">No sessions found</div>'}
    </div>`;
  }

  private renderToolsTab(data: AgentPanelData): string {
    const tools = data.tools;
    return `
    <div class="section-title">🔧 Available Tools (${tools.length})</div>
    <div class="tools-grid">
      ${tools.map(t => `
        <div class="tool-card ${t.enabled ? '' : 'disabled'}">
          <div class="tool-name">${this.esc(t.name)}</div>
          <div class="tool-status">
            <span class="badge ${t.enabled ? 'badge-on' : 'badge-off'}">${t.enabled ? 'enabled' : 'disabled'}</span>
            ${t.lastUsedAt ? `<span class="tool-last-used">Used ${formatRelativeTime(t.lastUsedAt)}</span>` : ''}
          </div>
        </div>
      `).join('')}
    </div>`;
  }

  private renderSubAgentsTab(data: AgentPanelData): string {
    const subAgents = data.subAgents;
    if (subAgents.length === 0) {
      return '<div class="empty-state">No sub-agents running</div>';
    }

    return `
    <div class="section-title">🔄 Sub-Agents (${subAgents.length})</div>
    <div class="subagents-list">
      ${subAgents.map(sa => `
        <div class="subagent-card ${sa.status}">
          <div class="subagent-header">
            <span class="dot ${sa.status === 'running' ? 'active' : 'idle'}"></span>
            <span class="subagent-label">${this.esc(sa.label)}</span>
            <span class="subagent-status badge badge-${sa.status}">${sa.status}</span>
            ${sa.status === 'running' ? `<button class="kill-btn" onclick="killSubAgent('${sa.sessionId}')">✕ Kill</button>` : ''}
          </div>
          <div class="subagent-task">${this.esc(sa.taskSummary)}</div>
          <div class="subagent-meta">
            <span>Model: ${this.esc(sa.model)}</span>
            <span>Duration: ${formatDuration(sa.durationMs)}</span>
            <span>Context: ${sa.contextUsedPct}%</span>
          </div>
          <button class="view-output-btn" onclick="viewSubAgentOutput('${sa.sessionId}')">View Output</button>
        </div>
      `).join('')}
    </div>`;
  }

  private renderCronsTab(data: AgentPanelData): string {
    const crons = data.cronJobs;
    if (crons.length === 0) {
      return '<div class="empty-state">No cron jobs configured</div>';
    }

    return `
    <div class="section-title">⏰ Cron Jobs (${crons.length})</div>
    <div class="crons-list">
      ${crons.map(cron => `
        <div class="cron-card ${cron.enabled ? '' : 'disabled'}">
          <div class="cron-header">
            <span class="cron-name">${this.esc(cron.name)}</span>
            <label class="toggle-switch">
              <input type="checkbox" ${cron.enabled ? 'checked' : ''} onchange="toggleCron('${cron.id}', this.checked)">
              <span class="toggle-slider"></span>
            </label>
          </div>
          <div class="cron-schedule">${this.esc(cron.scheduleDisplay)}</div>
          <div class="cron-meta">
            <span>Last: ${cron.lastRunAt ? formatRelativeTime(cron.lastRunAt) : 'never'}</span>
            <span>Next: ${cron.nextRunAt ? formatRelativeTime(cron.nextRunAt) : '—'}</span>
            ${cron.lastStatus ? `<span class="badge badge-${cron.lastStatus}">${cron.lastStatus}</span>` : ''}
            ${cron.lastDurationMs ? `<span>${formatDuration(cron.lastDurationMs)}</span>` : ''}
          </div>
          ${cron.consecutiveErrors > 0 ? `<div class="cron-errors">⚠️ ${cron.consecutiveErrors} consecutive errors</div>` : ''}
        </div>
      `).join('')}
    </div>`;
  }

  private renderCostsTab(data: AgentPanelData): string {
    const costs = data.costs;
    return `
    <div class="section-title">💰 Session Costs</div>
    
    <div class="cost-summary">
      <div class="cost-card">
        <div class="cost-label">Current Session</div>
        <div class="cost-value">${formatCost(costs.currentSession)}</div>
      </div>
      <div class="cost-card">
        <div class="cost-label">Today's Total</div>
        <div class="cost-value">${formatCost(costs.dailyTotal)}</div>
      </div>
    </div>

    <div class="section-subtitle">Breakdown by Model</div>
    <div class="cost-breakdown">
      ${costs.breakdown.length === 0 
        ? '<div class="empty-state">No usage today</div>'
        : costs.breakdown.map(b => `
          <div class="breakdown-row">
            <span class="model-name">${this.esc(b.model)}</span>
            <span class="token-count">↑${formatTokens(b.inputTokens)} ↓${formatTokens(b.outputTokens)}</span>
            <span class="model-cost">${formatCost(b.cost)}</span>
          </div>
        `).join('')}
    </div>`;
  }

  private renderMemoryTab(data: AgentPanelData): string {
    const renderTree = (files: MemoryFile[], depth = 0): string => {
      return files.map(f => {
        const indent = 'padding-left:' + (depth * 16) + 'px';
        const icon = f.isDirectory ? '📁' : '📄';
        const clickHandler = f.isDirectory 
          ? '' 
          : `onclick="viewMemoryFile('${this.esc(f.path)}')"`;
        
        return `
          <div class="memory-item ${f.isDirectory ? 'directory' : 'file'}" style="${indent}" ${clickHandler}>
            <span class="memory-icon">${icon}</span>
            <span class="memory-name">${this.esc(f.name)}</span>
            <span class="memory-meta">
              ${!f.isDirectory ? formatBytes(f.size) : ''}
              ${formatRelativeTime(f.modifiedAt)}
            </span>
          </div>
          ${f.children ? renderTree(f.children, depth + 1) : ''}
        `;
      }).join('');
    };

    return `
    <div class="section-title">📂 Memory Files</div>
    <div class="memory-path">~/clawd/memory/</div>
    <div class="memory-tree">
      ${renderTree(data.memoryFiles)}
    </div>
    <div id="memory-preview" class="memory-preview hidden">
      <div class="preview-header">
        <span id="preview-path"></span>
        <button onclick="closePreview()">✕</button>
      </div>
      <pre id="preview-content"></pre>
    </div>`;
  }

  private renderLiveToolsTab(): string {
    const entries = filterByToolName(this.liveToolEntries, this.liveToolsFilter);
    const toolNames = getUniqueToolNames(this.liveToolEntries);
    const currentFilter = this.liveToolsFilter || 'all';

    const filterButtons = [
      `<button class="filter-btn ${currentFilter === 'all' ? 'active' : ''}" onclick="filterLiveTools('all')">All</button>`,
      ...toolNames.map(name =>
        `<button class="filter-btn ${currentFilter === name ? 'active' : ''}" onclick="filterLiveTools('${this.esc(name)}')">${this.esc(name)}</button>`
      ),
    ].join('');

    const rows = entries.map((e, i) => {
      const statusIcon = e.status === 'success' ? '✅' : e.status === 'error' ? '❌' : '⏳';
      const durationStr = e.durationMs != null ? formatDuration(e.durationMs) : '…';
      const expandId = `tool-expand-${i}`;

      return `
      <div class="tool-entry ${e.status}" onclick="toggleExpand('${expandId}')">
        <div class="tool-entry-row">
          <span class="tool-icon">${e.icon}</span>
          <span class="tool-entry-name">${this.esc(e.toolName)}</span>
          <span class="tool-entry-params">${this.esc(e.paramsTruncated)}</span>
          <span class="tool-entry-duration">${durationStr}</span>
          <span class="tool-entry-status">${statusIcon}</span>
        </div>
        <div id="${expandId}" class="tool-expand hidden">
          <div class="expand-section">
            <div class="expand-label">Parameters:</div>
            <pre class="expand-content">${this.esc(e.parameters || '(none)')}</pre>
          </div>
          ${e.result ? `
          <div class="expand-section">
            <div class="expand-label">Result:</div>
            <pre class="expand-content">${this.esc(e.result.substring(0, 2000))}${e.result.length > 2000 ? '\n…truncated' : ''}</pre>
          </div>` : ''}
        </div>
      </div>`;
    }).join('');

    return `
    <div class="section-title">⚡ Live Tool Execution Feed (${entries.length})</div>
    <div class="filter-bar">${filterButtons}</div>
    <div class="live-tools-feed">
      ${rows || '<div class="empty-state">No tool calls yet</div>'}
    </div>`;
  }

  private esc(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  private getHtml(data: AgentPanelData): string {
    const tabs = [
      { id: 'overview', label: '📊 Overview' },
      { id: 'tools', label: '🔧 Tools' },
      { id: 'subagents', label: '🔄 Sub-Agents' },
      { id: 'crons', label: '⏰ Crons' },
      { id: 'costs', label: '💰 Costs' },
      { id: 'memory', label: '📂 Memory' },
      { id: 'livetools', label: '⚡ Live Tools' },
    ];

    let tabContent = '';
    switch (this.currentTab) {
      case 'overview': tabContent = this.renderOverviewTab(data); break;
      case 'tools': tabContent = this.renderToolsTab(data); break;
      case 'subagents': tabContent = this.renderSubAgentsTab(data); break;
      case 'crons': tabContent = this.renderCronsTab(data); break;
      case 'costs': tabContent = this.renderCostsTab(data); break;
      case 'memory': tabContent = this.renderMemoryTab(data); break;
      case 'livetools': tabContent = this.renderLiveToolsTab(); break;
    }

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
:root {
  --bg: #0e1621;
  --bg2: #17212b;
  --bg3: #1e2c3a;
  --text: #f5f5f5;
  --text2: #708499;
  --accent: #6ab2f2;
  --border: #1e2c3a;
  --card: #17212b;
  --card-hover: #1c2a3a;
  --success: #4caf50;
  --warning: #e5c07b;
  --error: #e06c75;
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

/* Tabs */
.tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 16px;
  border-bottom: 1px solid var(--border);
  padding-bottom: 8px;
  flex-wrap: wrap;
}
.tab {
  padding: 6px 12px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
  background: none;
  border: none;
  color: var(--text2);
  transition: all 0.15s;
}
.tab:hover { background: var(--bg2); color: var(--text); }
.tab.active { background: var(--accent); color: var(--bg); }

/* Config section (TASK-115) */
.config-section {
  background: var(--bg2);
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 14px;
}
.config-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}
.config-row:last-child { margin-bottom: 0; }
.config-label { color: var(--text2); min-width: 80px; }
.config-value { color: var(--text); }
.model-select {
  background: var(--bg3);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 4px 8px;
  font-size: 12px;
}

/* Badges */
.badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 10px;
  font-weight: 500;
  text-transform: uppercase;
}
.badge-on, .badge-ok { background: var(--success); color: var(--bg); }
.badge-off { background: var(--text2); color: var(--bg); }
.badge-running { background: var(--accent); color: var(--bg); }
.badge-completed { background: var(--success); color: var(--bg); }
.badge-error { background: var(--error); color: var(--bg); }
.badge-idle { background: var(--text2); color: var(--bg); }

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
.ctx-pct { font-weight: 600; color: var(--text); }
.ctx-tokens { color: var(--text2); }
.ctx-tokens.dim { font-style: italic; }
.session-model {
  color: var(--text2);
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 10px;
}
.session-cost { color: var(--accent); font-weight: 500; }

/* Tools Grid (TASK-116) */
.tools-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 8px;
}
.tool-card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 10px;
}
.tool-card.disabled { opacity: 0.5; }
.tool-name { font-weight: 500; margin-bottom: 4px; }
.tool-status { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.tool-last-used { font-size: 10px; color: var(--text2); }

/* Sub-Agents (TASK-117) */
.subagents-list { display: flex; flex-direction: column; gap: 8px; }
.subagent-card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
}
.subagent-card.running { border-left: 3px solid var(--accent); }
.subagent-card.completed { border-left: 3px solid var(--success); }
.subagent-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.subagent-label { font-weight: 500; flex: 1; }
.subagent-task { font-size: 12px; color: var(--text2); margin-bottom: 8px; }
.subagent-meta {
  display: flex;
  gap: 16px;
  font-size: 11px;
  color: var(--text2);
  margin-bottom: 8px;
}
.kill-btn {
  background: var(--error);
  color: white;
  border: none;
  border-radius: 4px;
  padding: 2px 8px;
  font-size: 10px;
  cursor: pointer;
}
.view-output-btn {
  background: var(--bg3);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 4px 10px;
  font-size: 11px;
  cursor: pointer;
}
.view-output-btn:hover { background: var(--accent); color: var(--bg); }

/* Crons (TASK-118) */
.crons-list { display: flex; flex-direction: column; gap: 8px; }
.cron-card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
}
.cron-card.disabled { opacity: 0.6; }
.cron-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}
.cron-name { font-weight: 500; }
.cron-schedule { font-size: 12px; color: var(--accent); margin-bottom: 6px; }
.cron-meta {
  display: flex;
  gap: 12px;
  font-size: 11px;
  color: var(--text2);
  flex-wrap: wrap;
}
.cron-errors { color: var(--error); font-size: 11px; margin-top: 6px; }

/* Toggle Switch */
.toggle-switch {
  position: relative;
  display: inline-block;
  width: 36px;
  height: 20px;
}
.toggle-switch input { opacity: 0; width: 0; height: 0; }
.toggle-slider {
  position: absolute;
  cursor: pointer;
  top: 0; left: 0; right: 0; bottom: 0;
  background-color: var(--text2);
  border-radius: 20px;
  transition: 0.3s;
}
.toggle-slider:before {
  position: absolute;
  content: "";
  height: 14px; width: 14px;
  left: 3px; bottom: 3px;
  background-color: white;
  border-radius: 50%;
  transition: 0.3s;
}
.toggle-switch input:checked + .toggle-slider { background-color: var(--success); }
.toggle-switch input:checked + .toggle-slider:before { transform: translateX(16px); }

/* Costs (TASK-119) */
.cost-summary {
  display: flex;
  gap: 16px;
  margin-bottom: 20px;
}
.cost-card {
  flex: 1;
  background: var(--bg2);
  border-radius: 8px;
  padding: 16px;
  text-align: center;
}
.cost-label { color: var(--text2); font-size: 12px; margin-bottom: 4px; }
.cost-value { font-size: 24px; font-weight: 600; color: var(--accent); }
.section-subtitle {
  font-size: 12px;
  color: var(--text2);
  margin-bottom: 8px;
  text-transform: uppercase;
}
.cost-breakdown {
  background: var(--bg2);
  border-radius: 8px;
  overflow: hidden;
}
.breakdown-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
}
.breakdown-row:last-child { border-bottom: none; }
.model-name { font-weight: 500; }
.token-count { color: var(--text2); font-size: 11px; }
.model-cost { color: var(--accent); font-weight: 500; }

/* Memory (TASK-120) */
.memory-path {
  font-size: 11px;
  color: var(--text2);
  margin-bottom: 10px;
  font-family: monospace;
}
.memory-tree {
  background: var(--bg2);
  border-radius: 8px;
  max-height: 300px;
  overflow-y: auto;
}
.memory-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
}
.memory-item:hover { background: var(--bg3); }
.memory-item.directory { color: var(--accent); }
.memory-icon { font-size: 14px; }
.memory-name { flex: 1; }
.memory-meta {
  font-size: 10px;
  color: var(--text2);
  display: flex;
  gap: 8px;
}
.memory-preview {
  margin-top: 16px;
  background: var(--bg2);
  border-radius: 8px;
  overflow: hidden;
}
.memory-preview.hidden { display: none; }
.preview-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  background: var(--bg3);
  border-bottom: 1px solid var(--border);
}
.preview-header button {
  background: none;
  border: none;
  color: var(--text2);
  cursor: pointer;
  font-size: 14px;
}
#preview-content {
  padding: 12px;
  max-height: 300px;
  overflow: auto;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
}

/* Section titles */
.section-title {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 12px;
}

.empty-state {
  text-align: center;
  padding: 40px 20px;
  color: var(--text2);
}

/* Live Tools Feed */
.filter-bar {
  display: flex;
  gap: 4px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}
.filter-btn {
  padding: 4px 10px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: none;
  color: var(--text2);
  font-size: 11px;
  cursor: pointer;
}
.filter-btn:hover { background: var(--bg2); color: var(--text); }
.filter-btn.active { background: var(--accent); color: var(--bg); border-color: var(--accent); }

.live-tools-feed {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 600px;
  overflow-y: auto;
}
.tool-entry {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 10px;
  cursor: pointer;
  transition: background 0.15s;
}
.tool-entry:hover { background: var(--card-hover); }
.tool-entry.error { border-left: 3px solid var(--error); }
.tool-entry.pending { border-left: 3px solid var(--warning); }
.tool-entry.success { border-left: 3px solid var(--success); }

.tool-entry-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}
.tool-icon { font-size: 14px; flex-shrink: 0; }
.tool-entry-name { font-weight: 600; min-width: 70px; flex-shrink: 0; }
.tool-entry-params {
  flex: 1;
  color: var(--text2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 10px;
}
.tool-entry-duration { color: var(--accent); font-size: 11px; flex-shrink: 0; min-width: 40px; text-align: right; }
.tool-entry-status { flex-shrink: 0; }

.tool-expand { padding: 8px 0 0 22px; }
.tool-expand.hidden { display: none; }
.expand-section { margin-bottom: 8px; }
.expand-label { font-size: 10px; color: var(--text2); text-transform: uppercase; margin-bottom: 2px; }
.expand-content {
  font-size: 11px;
  font-family: 'SF Mono', 'Fira Code', monospace;
  background: var(--bg);
  padding: 6px 8px;
  border-radius: 4px;
  max-height: 200px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
</head>
<body>
<div class="header">
  <h1>🤖 Agent Status</h1>
  <button class="refresh-btn" onclick="vscode.postMessage({command:'refresh'})">↻ Refresh</button>
</div>

<div class="tabs">
  ${tabs.map(t => `
    <button class="tab ${t.id === this.currentTab ? 'active' : ''}" 
            onclick="switchTab('${t.id}')">${t.label}</button>
  `).join('')}
</div>

<div class="tab-content">
  ${tabContent}
</div>

<script>
const vscode = acquireVsCodeApi();

function switchTab(tab) {
  vscode.postMessage({ command: 'switchTab', tab });
}

function toggleCron(jobId, enable) {
  vscode.postMessage({ command: 'toggleCron', jobId, enable });
}

function killSubAgent(sessionId) {
  if (confirm('Kill this sub-agent?')) {
    vscode.postMessage({ command: 'killSubAgent', sessionId });
  }
}

function viewSubAgentOutput(sessionId) {
  vscode.postMessage({ command: 'viewSubAgentOutput', sessionId });
}

function viewMemoryFile(path) {
  vscode.postMessage({ command: 'viewMemory', path });
}

function closePreview() {
  document.getElementById('memory-preview').classList.add('hidden');
}

function filterLiveTools(filter) {
  vscode.postMessage({ command: 'liveToolsFilter', filter });
}

function toggleExpand(id) {
  const el = document.getElementById(id);
  if (el) el.classList.toggle('hidden');
}

function switchModel(model) {
  // Model switching would require API support
  vscode.postMessage({ command: 'switchModel', model });
}

window.addEventListener('message', event => {
  const msg = event.data;
  if (msg.command === 'memoryContent') {
    const preview = document.getElementById('memory-preview');
    document.getElementById('preview-path').textContent = msg.path.split('/').pop();
    document.getElementById('preview-content').textContent = msg.content;
    preview.classList.remove('hidden');
  }
});
</script>
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
