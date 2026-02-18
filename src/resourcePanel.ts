import * as vscode from 'vscode';
import { loadProjectList, loadProjectBrief, ProjectBrief, ProjectListEntry } from './services/resources';

export class ResourcePanel {
  private static instance: ResourcePanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private projects: ProjectListEntry[] = [];
  private currentBrief: ProjectBrief | null = null;

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
    }

    this.panel.webview.html = this.getHtml();

    this.panel.webview.onDidReceiveMessage(
      (msg) => this.handleMessage(msg),
      null,
      this.disposables
    );

    this.panel.onDidDispose(() => {
      ResourcePanel.instance = undefined;
      this.disposables.forEach(d => d.dispose());
    }, null, this.disposables);
  }

  private handleMessage(msg: any) {
    switch (msg.type) {
      case 'selectProject': {
        const proj = this.projects.find(p => p.slug === msg.slug);
        if (proj) {
          this.currentBrief = loadProjectBrief(proj.slug, proj.name);
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
        if (this.currentBrief) {
          const uri = vscode.Uri.file(this.currentBrief.briefPath);
          vscode.commands.executeCommand('vscode.open', uri);
        }
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
      .map(u => `<div class="resource-item"><a href="#" onclick="postMsg('openUrl','${escAttr(u.url)}')">${escHtml(u.label)}</a><span class="url-text">${escHtml(u.url)}</span></div>`)
      .join('') : '<div class="empty">No URLs found</div>';

    const pathsHtml = brief?.resources.localPaths.length ? brief.resources.localPaths
      .map(p => `<div class="resource-item"><span class="path-label">${escHtml(p.label)}</span><a href="#" class="path-link" onclick="postMsg('openFile','${escAttr(p.path)}')">${escHtml(p.path)}</a></div>`)
      .join('') : '';

    const pm2Html = brief?.resources.pm2Processes.length
      ? `<div class="pm2-list">${brief.resources.pm2Processes.map(p => `<span class="pill pm2">${escHtml(p)}</span>`).join('')}</div>` : '';

    const keysHtml = brief?.resources.apiKeys.length ? brief.resources.apiKeys
      .map(k => `<div class="resource-item key-item"><span>${escHtml(k.label)}</span><code class="masked-key">${escHtml(k.masked)}</code><button class="copy-btn" onclick="postMsg('copyKey','${escAttr(k.raw)}')">📋</button></div>`)
      .join('') : '';

    const techHtml = brief?.techStack.length
      ? brief.techStack.map(t => `<span class="pill tech">${escHtml(t)}</span>`).join('')
      : '<div class="empty">No tech stack info</div>';

    const decisionsHtml = brief?.keyDecisions.length
      ? `<details open><summary>${brief.keyDecisions.length} decisions</summary><ul>${brief.keyDecisions.map(d => `<li>${escHtml(d)}</li>`).join('')}</ul></details>`
      : '';

    const historyHtml = brief?.history.length
      ? brief.history.map(h => `<details${h === brief.history[0] ? ' open' : ''}><summary>${escHtml(h.date)}</summary><ul>${h.items.map(i => `<li>${escHtml(i)}</li>`).join('')}</ul></details>`).join('')
      : '';

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
</style>
</head>
<body>
  <div class="toolbar">
    <select onchange="vscode.postMessage({type:'selectProject',slug:this.value})">
      ${projectOptions}
    </select>
    <button class="edit-btn" onclick="vscode.postMessage({type:'editBrief'})">✏️ Edit Brief</button>
  </div>

  ${statusHtml}

  ${brief ? `<div class="card">
    <div class="card-header">Resources</div>
    ${urlsHtml}${pathsHtml}${pm2Html}${keysHtml}
  </div>` : ''}

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
