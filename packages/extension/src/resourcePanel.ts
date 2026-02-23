import * as vscode from 'vscode';
import { loadProjectList, loadProjectBrief, readBriefRaw, saveBrief, ProjectBrief, ProjectListEntry } from './services/resources';
import { renderMarkdown } from './services/markdownRenderer';
import { extractAllUrls, parsePm2Json, parseGitLog, parseGitRemote, formatUptime, Pm2Process, GitLogInfo, GitRemote } from './services/resourceHelpers';
import { fetchPM2Processes, enrichProcesses, pm2Action, pm2Logs, PM2ProcessDisplay } from './services/pm2';
import { getRemoteHome } from './services/remoteFs';

export class ResourcePanel {
  private static instance: ResourcePanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private projects: ProjectListEntry[] = [];
  private currentBrief: ProjectBrief | null = null;
  private briefMode: 'view' | 'edit' = 'view';
  private briefRaw: string = '';
  private urlHealthStatus: Map<string, boolean | null> = new Map();
  private healthCheckInterval: NodeJS.Timeout | undefined;
  private deploymentData: { pm2: Pm2Process[]; git: GitLogInfo | null; remotes: GitRemote[] } | null = null;
  private pm2Processes: PM2ProcessDisplay[] = [];
  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  private context: vscode.ExtensionContext;

  public static createOrShow(context: vscode.ExtensionContext) {
    if (ResourcePanel.instance) {
      ResourcePanel.instance.panel.reveal(vscode.ViewColumn.One);
      return;
    }
    const mediaUri = vscode.Uri.joinPath(context.extensionUri, 'media');
    const panel = vscode.window.createWebviewPanel(
      'oceangram.resources',
      '📦 Resources',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [mediaUri] }
    );
    ResourcePanel.instance = new ResourcePanel(panel, context);
  }

  private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
    this.panel = panel;
    this.context = context;

    // Async init
    this.initAsync();

    this.refreshPM2();
    this.panel.webview.html = this.getHtml();
    this.startHealthChecks();

    this.loadDeploymentData();

    // Auto-refresh PM2 every 30s
    this.refreshTimer = setInterval(() => {
      this.refreshPM2();
      this.panel.webview.postMessage({ type: 'pm2Update', processes: this.pm2Processes });
    }, 30000);

    this.panel.webview.onDidReceiveMessage(
      (msg) => this.handleMessage(msg),
      null,
      this.disposables
    );

    this.panel.onDidDispose(() => {
      ResourcePanel.instance = undefined;
      if (this.refreshTimer) { clearInterval(this.refreshTimer); }
      if (this.healthCheckInterval) { clearInterval(this.healthCheckInterval); }
      this.disposables.forEach(d => d.dispose());
    }, null, this.disposables);
  }

  private async initAsync() {
    try {
      this.projects = await loadProjectList();
      const first = this.projects.find(p => p.hasBrief);
      if (first) {
        this.currentBrief = await loadProjectBrief(first.slug, first.name);
        this.briefRaw = (await readBriefRaw(first.slug)) || '';
      }
      this.panel.webview.html = this.getHtml();
    } catch (e) {
      // Will show empty state
    }
  }

  private refreshPM2() {
    this.pm2Processes = enrichProcesses(fetchPM2Processes());
  }

  private loadDeploymentData() {
    try {
      const pm2Output = execSync('pm2 jlist 2>/dev/null || echo "[]"', { encoding: 'utf-8', timeout: 5000 });
      const pm2 = parsePm2Json(pm2Output);

      let git: GitLogInfo | null = null;
      let remotes: GitRemote[] = [];
      const projectPath = this.currentBrief?.resources.localPaths[0]?.path.replace(/^~/, getRemoteHome());
      if (projectPath) {
        try {
          const gitLog = execSync(`cd "${projectPath}" && git log -1 --format="%h%n%ai%n%an%n%s" 2>/dev/null || echo ""`, { encoding: 'utf-8', timeout: 5000 });
          git = parseGitLog(gitLog);
          const gitRemote = execSync(`cd "${projectPath}" && git remote -v 2>/dev/null || echo ""`, { encoding: 'utf-8', timeout: 5000 });
          remotes = parseGitRemote(gitRemote);
        } catch { /* no git */ }
      }
      this.deploymentData = { pm2, git, remotes };
    } catch {
      this.deploymentData = null;
    }
  }

  private startHealthChecks() {
    if (this.currentBrief) {
      for (const u of this.currentBrief.resources.urls) {
        this.checkUrlHealth(u.url);
      }
    }
    this.healthCheckInterval = setInterval(() => {
      if (this.currentBrief) {
        for (const u of this.currentBrief.resources.urls) {
          this.checkUrlHealth(u.url);
        }
      }
    }, 60000);
  }

  private async checkUrlHealth(url: string) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const resp = await fetch(url, { method: 'HEAD', signal: controller.signal, redirect: 'follow' });
      clearTimeout(timeout);
      this.urlHealthStatus.set(url, resp.ok || resp.status < 500);
    } catch {
      this.urlHealthStatus.set(url, false);
    }
    this.panel.webview.postMessage({
      type: 'healthUpdate',
      url,
      status: this.urlHealthStatus.get(url),
    });
  }

  private async handleMessage(msg: any) {
    switch (msg.type) {
      case 'selectProject': {
        const proj = this.projects.find(p => p.slug === msg.slug);
        if (proj) {
          this.currentBrief = await loadProjectBrief(proj.slug, proj.name);
          this.briefRaw = (await readBriefRaw(proj.slug)) || '';
          this.briefMode = 'view';
          this.loadDeploymentData();
          this.urlHealthStatus.clear();
          this.panel.webview.html = this.getHtml();
          if (this.healthCheckInterval) { clearInterval(this.healthCheckInterval); }
          this.startHealthChecks();
        }
        break;
      }
      case 'openFile': {
        const uri = vscode.Uri.file(msg.path.replace(/^~/, getRemoteHome()));
        vscode.commands.executeCommand('vscode.open', uri);
        break;
      }
      case 'openUrl': {
        vscode.env.openExternal(vscode.Uri.parse(msg.url));
        break;
      }
      case 'copyKey': {
        vscode.env.clipboard.writeText(msg.value);
        vscode.window.showInformationMessage('Key copied to clipboard');
        break;
      }
      case 'editBrief': {
        this.briefMode = 'edit';
        this.panel.webview.html = this.getHtml();
        break;
      }
      case 'viewBrief': {
        this.briefMode = 'view';
        this.panel.webview.html = this.getHtml();
        break;
      }
      case 'saveBrief': {
        if (this.currentBrief && msg.content != null) {
          await saveBrief(this.currentBrief.slug, msg.content);
          this.briefRaw = msg.content;
          this.currentBrief = await loadProjectBrief(this.currentBrief.slug, this.currentBrief.name);
          this.briefMode = 'view';
          this.panel.webview.html = this.getHtml();
          vscode.window.showInformationMessage('Brief saved');
        }
        break;
      }
      case 'autoSaveBrief': {
        if (this.currentBrief && msg.content != null) {
          await saveBrief(this.currentBrief.slug, msg.content);
          this.briefRaw = msg.content;
          this.currentBrief = await loadProjectBrief(this.currentBrief.slug, this.currentBrief.name);
        }
        break;
      }
      case 'pm2Restart':
      case 'pm2Stop':
      case 'pm2Delete': {
        const action = msg.type.replace('pm2', '').toLowerCase() as 'restart' | 'stop' | 'delete';
        const result = pm2Action(action, msg.name);
        if (result.success) {
          vscode.window.showInformationMessage(`PM2: ${action} ${msg.name} succeeded`);
        } else {
          vscode.window.showErrorMessage(`PM2: ${action} ${msg.name} failed — ${result.output}`);
        }
        this.refreshPM2();
        this.panel.webview.postMessage({ type: 'pm2Update', processes: this.pm2Processes });
        break;
      }
      case 'pm2Logs': {
        const logs = pm2Logs(msg.name, 50);
        this.panel.webview.postMessage({ type: 'pm2LogsResult', name: msg.name, logs });
        break;
      }
      case 'pm2Refresh': {
        this.refreshPM2();
        this.panel.webview.postMessage({ type: 'pm2Update', processes: this.pm2Processes });
        break;
      }
      case 'openTerminal': {
        const terminal = vscode.window.createTerminal({ name: msg.name, cwd: msg.path });
        terminal.show();
        break;
      }
    }
  }

  private getDeploymentHtml(): string {
    if (!this.deploymentData) return '';
    const { git, remotes } = this.deploymentData;
    let html = '<div class="card"><div class="card-header">🚀 Deployment Status</div>';

    if (git) {
      html += `<div class="deploy-section">
        <div class="deploy-row"><span class="deploy-label">Last commit</span><code>${escHtml(git.hash)}</code> ${escHtml(git.message)}</div>
        <div class="deploy-row"><span class="deploy-label">Author</span>${escHtml(git.author)}</div>
        <div class="deploy-row"><span class="deploy-label">Date</span>${escHtml(git.date)}</div>
      </div>`;
    }

    if (remotes.length) {
      html += `<div class="deploy-section">${remotes.map(r =>
        `<div class="deploy-row"><span class="deploy-label">${escHtml(r.name)}</span><span class="url-text">${escHtml(r.url)}</span></div>`
      ).join('')}</div>`;
    }

    // Show PM2 processes relevant to this project
    const projectPm2 = this.currentBrief?.resources.pm2Processes || [];
    const relevantProcs = this.deploymentData.pm2.filter(p => projectPm2.includes(p.name));
    if (relevantProcs.length) {
      html += `<div class="deploy-section">${relevantProcs.map(p => {
        const statusColor = p.status === 'online' ? '#4caf50' : p.status === 'stopped' ? '#f44336' : '#ff9800';
        return `<div class="deploy-row">
          <span class="deploy-label">${escHtml(p.name)}</span>
          <span class="pm2-status-dot" style="background:${statusColor}"></span>
          <span>${escHtml(p.status)}</span>
          <span class="url-text">up ${formatUptime(p.uptimeMs)} · ${escHtml(p.env)} · ${p.restarts} restarts</span>
        </div>`;
      }).join('')}</div>`;
    }

    html += '</div>';
    return html;
  }

  private getHtml(): string {
    const brief = this.currentBrief;
    const projectOptions = this.projects
      .filter(p => p.hasBrief)
      .map(p => `<option value="${p.slug}" ${brief?.slug === p.slug ? 'selected' : ''}>${p.name}</option>`)
      .join('');

    const statusHtml = brief ? `
      <div class="card">
        <div class="card-header">Status</div>
        <div class="status-grid">
          <span class="status-label">Phase</span><span class="status-phase">${escHtml(brief.status.phase)}</span>
          <span class="status-label">Last touched</span><span>${escHtml(brief.status.lastTouched)}</span>
          <span class="status-label">Next action</span><span>${escHtml(brief.status.nextAction)}</span>
        </div>
      </div>` : '';

    const urlsHtml = brief?.resources.urls.length ? brief.resources.urls
      .map(u => {
        const health = this.urlHealthStatus.get(u.url);
        const dot = health === true ? '🟢' : health === false ? '🔴' : '⚪';
        return `<div class="resource-item"><span class="health-dot" data-url="${escAttr(u.url)}">${dot}</span><a href="#" onclick="postMsg('openUrl','${escAttr(u.url)}')">${escHtml(u.label)}</a><span class="url-text">${escHtml(u.url)}</span></div>`;
      })
      .join('') : '<div class="empty">No URLs found</div>';

    const pathsHtml = brief?.resources.localPaths.length ? brief.resources.localPaths
      .map(p => `<div class="resource-item"><span class="path-label">${escHtml(p.label)}</span><a href="#" class="path-link" onclick="postMsg('openFile','${escAttr(p.path)}')">${escHtml(p.path)}</a></div>`)
      .join('') : '';

    const pm2Html = brief?.resources.pm2Processes.length
      ? `<div class="pm2-list">${brief.resources.pm2Processes.map(p => `<span class="pill pm2">${escHtml(p)}</span>`).join('')}</div>` : '';

    const keysHtml = brief?.resources.apiKeys.length ? `<div class="card"><div class="card-header">🔑 API Keys</div>` + brief.resources.apiKeys
      .map((k, i) => `<div class="resource-item key-item">
        <span class="key-label">${escHtml(k.label)}</span>
        <code class="masked-key" id="key-${i}" data-masked="${escAttr(k.masked)}" data-raw="${escAttr(k.raw)}">${escHtml(k.masked)}</code>
        <button class="copy-btn" onclick="postMsg('copyKey','${escAttr(k.raw)}')" title="Copy">📋</button>
        <button class="copy-btn reveal-btn" onclick="revealKey(${i})" title="Reveal for 5s">👁</button>
      </div>`)
      .join('') + '</div>' : '';

    const pm2CardsHtml = this.pm2Processes.length ? this.pm2Processes.map(p => `
      <div class="pm2-card">
        <div class="pm2-card-header">
          <span class="pm2-name">${escHtml(p.name)}</span>
          <span class="pm2-status-pill" style="background:${p.statusColor}">${escHtml(p.status)}</span>
        </div>
        <div class="pm2-stats">
          <span>CPU: ${p.cpu}%</span>
          <span>Mem: ${escHtml(p.memoryFormatted)}</span>
          <span>Up: ${escHtml(p.uptimeFormatted)}</span>
          <span>↻ ${p.restarts}</span>
        </div>
        <div class="pm2-actions">
          <button class="action-btn restart" onclick="pm2Do('pm2Restart','${escAttr(p.name)}')">🔄 Restart</button>
          <button class="action-btn stop" onclick="pm2Confirm('pm2Stop','${escAttr(p.name)}')">⏹ Stop</button>
          <button class="action-btn logs" onclick="pm2Do('pm2Logs','${escAttr(p.name)}')">📄 Logs</button>
          ${p.pm2_env?.pm_cwd ? `<button class="action-btn terminal" onclick="vscode.postMessage({type:'openTerminal',name:'${escAttr(p.name)}',path:'${escAttr(p.pm2_env.pm_cwd)}'})">💻 Terminal</button>` : ''}
        </div>
        <div class="pm2-log-area" id="logs-${p.pm_id}" style="display:none"></div>
      </div>`).join('') : '<div class="empty">No PM2 processes running</div>';

    const techHtml = brief?.techStack.length
      ? brief.techStack.map(t => `<span class="pill tech">${escHtml(t)}</span>`).join('')
      : '<div class="empty">No tech stack info</div>';

    const decisionsHtml = brief?.keyDecisions.length
      ? `<details open><summary>${brief.keyDecisions.length} decisions</summary><ul>${brief.keyDecisions.map(d => `<li>${escHtml(d)}</li>`).join('')}</ul></details>`
      : '';

    const historyHtml = brief?.history.length
      ? brief.history.map(h => `<details${h === brief.history[0] ? ' open' : ''}><summary>${escHtml(h.date)}</summary><ul>${h.items.map(i => `<li>${escHtml(i)}</li>`).join('')}</ul></details>`).join('')
      : '';

    const briefHtml = brief ? (this.briefMode === 'edit'
      ? `<div class="card brief-editor">
          <div class="card-header">Brief <span class="mode-badge">Editing</span></div>
          <textarea id="briefTextarea" class="brief-textarea">${escHtml(this.briefRaw)}</textarea>
          <div class="brief-actions">
            <button class="edit-btn save-btn" onclick="saveBrief()">💾 Save</button>
            <button class="edit-btn cancel-btn" onclick="vscode.postMessage({type:'viewBrief'})">Cancel</button>
          </div>
        </div>`
      : `<div class="card brief-view">
          <div class="card-header">Brief <span class="mode-badge">Preview</span></div>
          <div class="brief-content">${renderMarkdown(this.briefRaw)}</div>
        </div>`) : '';

    const editBtnLabel = this.briefMode === 'edit' ? '👁️ View' : '✏️ Edit Brief';
    const editBtnAction = this.briefMode === 'edit' ? 'viewBrief' : 'editBrief';

    const cssUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'resourcePanel.css')
    );
    const jsUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'resourcePanel.js')
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<link rel="stylesheet" href="${cssUri}">
</head>
<body>
  <div class="toolbar">
    <select onchange="vscode.postMessage({type:'selectProject',slug:this.value})">
      ${projectOptions}
    </select>
    <button class="edit-btn" onclick="vscode.postMessage({type:'${editBtnAction}'})">${editBtnLabel}</button>
  </div>

  ${briefHtml}

  ${statusHtml}

  ${brief ? `<div class="card">
    <div class="card-header">🌐 URLs & Endpoints</div>
    ${urlsHtml}${pathsHtml}${pm2Html}
  </div>` : ''}

  ${keysHtml}

  ${this.getDeploymentHtml()}

  <div class="card">
    <div class="card-header" style="display:flex;justify-content:space-between;align-items:center">
      <span>PM2 Processes</span>
      <button class="edit-btn" style="font-size:11px;padding:3px 8px" onclick="pm2Do('pm2Refresh','')">🔄 Refresh</button>
    </div>
    ${pm2CardsHtml}
  </div>

  <!-- Confirmation dialog -->
  <div id="confirm-dialog" class="confirm-overlay" style="display:none">
    <div class="confirm-box">
      <p id="confirm-msg"></p>
      <div class="confirm-actions">
        <button class="action-btn stop" id="confirm-yes">Yes, do it</button>
        <button class="action-btn" id="confirm-no" onclick="hideConfirm()">Cancel</button>
      </div>
    </div>
  </div>

  ${brief ? `<div class="card">
    <div class="card-header">Tech Stack</div>
    ${techHtml}
  </div>` : ''}

  ${decisionsHtml ? `<div class="card">
    <div class="card-header">Key Decisions</div>
    ${decisionsHtml}
  </div>` : ''}

  ${historyHtml ? `<div class="card">
    <div class="card-header">History</div>
    ${historyHtml}
  </div>` : ''}

  ${!brief ? '<div class="empty" style="text-align:center;margin-top:40px;">Select a project with a brief to view resources</div>' : ''}

<script src="${jsUri}"></script>
</body>
</html>`;
  }
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escAttr(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;');
}
