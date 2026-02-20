import * as vscode from 'vscode';
import { loadProjectList, loadProjectBrief, readBriefRaw, saveBrief, ProjectBrief, ProjectListEntry } from './services/resources';
import { renderMarkdown } from './services/markdownRenderer';
import { extractAllUrls, parsePm2Json, parseGitLog, parseGitRemote, formatUptime, Pm2Process, GitLogInfo, GitRemote } from './services/resourceHelpers';
import { execSync } from 'child_process';
import { fetchPM2Processes, enrichProcesses, pm2Action, pm2Logs, PM2ProcessDisplay } from './services/pm2';

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

  public static createOrShow(context: vscode.ExtensionContext) {
    if (ResourcePanel.instance) {
      ResourcePanel.instance.panel.reveal(vscode.ViewColumn.One);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'oceangram.resources',
      '📦 Resources',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    ResourcePanel.instance = new ResourcePanel(panel, context);
  }

  private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
    this.panel = panel;
    this.projects = loadProjectList();

    // Load first project with a brief
    const first = this.projects.find(p => p.hasBrief);
    if (first) {
      this.currentBrief = loadProjectBrief(first.slug, first.name);
      this.briefRaw = readBriefRaw(first.slug) || '';
    }

    this.refreshPM2();
    this.loadDeploymentData();
    this.panel.webview.html = this.getHtml();
    this.startHealthChecks();

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

  private refreshPM2() {
    this.pm2Processes = enrichProcesses(fetchPM2Processes());
  }

  private loadDeploymentData() {
    try {
      const pm2Output = execSync('pm2 jlist 2>/dev/null || echo "[]"', { encoding: 'utf-8', timeout: 5000 });
      const pm2 = parsePm2Json(pm2Output);

      let git: GitLogInfo | null = null;
      let remotes: GitRemote[] = [];
      const projectPath = this.currentBrief?.resources.localPaths[0]?.path.replace(/^~/, process.env.HOME || '/home/xiko');
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

  private handleMessage(msg: any) {
    switch (msg.type) {
      case 'selectProject': {
        const proj = this.projects.find(p => p.slug === msg.slug);
        if (proj) {
          this.currentBrief = loadProjectBrief(proj.slug, proj.name);
          this.briefRaw = readBriefRaw(proj.slug) || '';
          this.briefMode = 'view';
          this.panel.webview.html = this.getHtml();
        }
        break;
      }
      case 'openFile': {
        const uri = vscode.Uri.file(msg.path.replace(/^~/, process.env.HOME || '/home/xiko'));
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
          saveBrief(this.currentBrief.slug, msg.content);
          this.briefRaw = msg.content;
          this.currentBrief = loadProjectBrief(this.currentBrief.slug, this.currentBrief.name);
          this.briefMode = 'view';
          this.panel.webview.html = this.getHtml();
          vscode.window.showInformationMessage('Brief saved');
        }
        break;
      }
      case 'autoSaveBrief': {
        if (this.currentBrief && msg.content != null) {
          saveBrief(this.currentBrief.slug, msg.content);
          this.briefRaw = msg.content;
          this.currentBrief = loadProjectBrief(this.currentBrief.slug, this.currentBrief.name);
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
  line-height: 1.5;
}
.toolbar {
  display: flex; align-items: center; gap: 10px; margin-bottom: 16px;
}
select {
  background: var(--vscode-dropdown-background, #3c3c3c);
  color: var(--vscode-dropdown-foreground, #ccc);
  border: 1px solid var(--vscode-dropdown-border, #555);
  padding: 6px 10px; border-radius: 4px; font-size: 13px; flex: 1;
}
.edit-btn {
  background: var(--vscode-button-background, #0e639c);
  color: var(--vscode-button-foreground, #fff);
  border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 13px;
}
.edit-btn:hover { opacity: 0.85; }
.brief-textarea {
  width: 100%; min-height: 300px; resize: vertical;
  background: var(--vscode-input-background, #3c3c3c);
  color: var(--vscode-input-foreground, #ccc);
  border: 1px solid var(--vscode-input-border, #555);
  border-radius: 4px; padding: 10px; font-size: 13px;
  font-family: var(--vscode-editor-font-family, 'Fira Code', 'Cascadia Code', monospace);
  line-height: 1.6; tab-size: 2;
}
.brief-textarea:focus { outline: 1px solid var(--vscode-focusBorder, #007fd4); }
.brief-actions { display: flex; gap: 8px; margin-top: 8px; }
.cancel-btn { background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-button-secondaryForeground, #ccc); }
.save-btn { background: #2ea043; }
.mode-badge {
  font-size: 11px; font-weight: 400; padding: 2px 8px; border-radius: 8px; margin-left: 8px;
  background: var(--vscode-badge-background, #4d4d4d); color: var(--vscode-badge-foreground, #fff);
}
.brief-content {
  font-size: 13px; line-height: 1.6;
}
.brief-content h1 { font-size: 20px; margin: 12px 0 6px; border-bottom: 1px solid var(--vscode-editorWidget-border, #454545); padding-bottom: 4px; }
.brief-content h2 { font-size: 16px; margin: 10px 0 4px; }
.brief-content h3 { font-size: 14px; margin: 8px 0 4px; }
.brief-content p { margin: 6px 0; }
.brief-content ul { padding-left: 20px; margin: 4px 0; }
.brief-content li { padding: 2px 0; }
.brief-content pre { background: var(--vscode-textCodeBlock-background, #2d2d2d); padding: 10px; border-radius: 4px; overflow-x: auto; margin: 8px 0; }
.brief-content code { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }
.brief-content blockquote { border-left: 3px solid var(--vscode-textLink-foreground, #3794ff); padding-left: 12px; margin: 6px 0; color: var(--vscode-descriptionForeground, #888); font-style: italic; }
.brief-content a { color: var(--vscode-textLink-foreground, #3794ff); }
.brief-content strong { font-weight: 600; }
.card {
  background: var(--vscode-editorWidget-background, #252526);
  border: 1px solid var(--vscode-editorWidget-border, #454545);
  border-radius: 6px; padding: 12px 16px; margin-bottom: 12px;
}
.card-header {
  font-weight: 600; font-size: 13px; text-transform: uppercase; letter-spacing: 0.5px;
  color: var(--vscode-descriptionForeground, #888); margin-bottom: 8px;
}
.status-grid {
  display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; font-size: 13px;
}
.status-label { color: var(--vscode-descriptionForeground, #888); }
.status-phase { font-weight: 600; }
a { color: var(--vscode-textLink-foreground, #3794ff); text-decoration: none; }
a:hover { text-decoration: underline; }
.resource-item {
  display: flex; align-items: center; gap: 8px; font-size: 13px; padding: 3px 0;
}
.url-text { color: var(--vscode-descriptionForeground, #888); font-size: 12px; }
.path-label { color: var(--vscode-descriptionForeground, #888); min-width: 80px; }
.path-link { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }
.masked-key { background: var(--vscode-textCodeBlock-background, #2d2d2d); padding: 2px 6px; border-radius: 3px; font-size: 12px; }
.copy-btn { background: none; border: none; cursor: pointer; font-size: 14px; padding: 2px; }
.copy-btn:hover { opacity: 0.7; }
.pill {
  display: inline-block; padding: 3px 10px; border-radius: 12px; font-size: 12px; margin: 2px 4px 2px 0;
}
.pill.tech { background: var(--vscode-badge-background, #4d4d4d); color: var(--vscode-badge-foreground, #fff); }
.pill.pm2 { background: #2d5a27; color: #8fd883; }
.pm2-list { margin-top: 6px; }
details { margin: 4px 0; }
summary { cursor: pointer; font-size: 13px; padding: 4px 0; }
summary:hover { color: var(--vscode-textLink-foreground, #3794ff); }
ul { padding-left: 20px; font-size: 13px; }
li { padding: 2px 0; }
.empty { color: var(--vscode-descriptionForeground, #888); font-size: 13px; font-style: italic; }
.section-title { font-weight: 600; font-size: 13px; color: var(--vscode-descriptionForeground, #888); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; }
.pm2-card { background: var(--vscode-editor-background, #1e1e1e); border: 1px solid var(--vscode-editorWidget-border, #454545); border-radius: 6px; padding: 10px 14px; margin-bottom: 8px; }
.pm2-card-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
.pm2-name { font-weight: 600; font-size: 13px; }
.pm2-status-pill { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; color: #fff; font-weight: 600; }
.pm2-stats { display: flex; gap: 12px; font-size: 12px; color: var(--vscode-descriptionForeground, #999); margin-bottom: 6px; }
.pm2-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.action-btn { background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-button-secondaryForeground, #ccc); border: none; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 12px; }
.action-btn:hover { opacity: 0.8; }
.action-btn.stop { background: #5a2d2d; color: #f88; }
.action-btn.restart { background: #2d4a2d; color: #8f8; }
.pm2-log-area { margin-top: 8px; max-height: 300px; overflow-y: auto; background: var(--vscode-terminal-background, #1a1a1a); border-radius: 4px; padding: 8px; }
.pm2-log-area pre { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; white-space: pre-wrap; word-break: break-all; margin: 0; color: var(--vscode-terminal-foreground, #ccc); }
.confirm-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 100; }
.confirm-box { background: var(--vscode-editorWidget-background, #252526); border: 1px solid var(--vscode-editorWidget-border, #454545); border-radius: 8px; padding: 20px; max-width: 360px; text-align: center; }
.confirm-box p { margin-bottom: 16px; font-size: 14px; }
.confirm-actions { display: flex; gap: 10px; justify-content: center; }
</style>
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

<script>
  const vscode = acquireVsCodeApi();
  function postMsg(type, value) {
    if (type === 'openUrl') vscode.postMessage({type, url: value});
    else if (type === 'openFile') vscode.postMessage({type, path: value});
    else if (type === 'copyKey') vscode.postMessage({type, value});
  }
  function pm2Do(type, name) {
    vscode.postMessage({type, name});
  }
  let pendingConfirm = null;
  function pm2Confirm(type, name) {
    document.getElementById('confirm-msg').textContent = 'Are you sure you want to ' + type.replace('pm2','').toLowerCase() + ' "' + name + '"?';
    document.getElementById('confirm-dialog').style.display = 'flex';
    pendingConfirm = {type, name};
    document.getElementById('confirm-yes').onclick = function() {
      if (pendingConfirm) pm2Do(pendingConfirm.type, pendingConfirm.name);
      hideConfirm();
    };
  }
  function hideConfirm() {
    document.getElementById('confirm-dialog').style.display = 'none';
    pendingConfirm = null;
  }
  window.addEventListener('message', function(event) {
    const msg = event.data;
    if (msg.type === 'pm2LogsResult') {
      const procs = document.querySelectorAll('.pm2-card');
      procs.forEach(function(card) {
        const nameEl = card.querySelector('.pm2-name');
        if (nameEl && nameEl.textContent === msg.name) {
          const logArea = card.querySelector('.pm2-log-area');
          logArea.innerHTML = '<pre>' + escapeHtml(msg.logs) + '</pre>';
          logArea.style.display = logArea.style.display === 'none' ? 'block' : 'none';
        }
      });
    }
  });
  function escapeHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
</script>
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
