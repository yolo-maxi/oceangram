import * as vscode from 'vscode';
import {
  loadProjects,
  readBoard,
  writeBoard,
  moveTask,
  createTask,
  enrichBoardWithPRInfo,
  KanbanBoard,
  KanbanTask,
  ProjectInfo,
} from './services/kanban';
import { clearPRCache } from './services/github';
import { remoteFileExists, watchRemoteFile } from './services/remoteFs';

export class KanbanPanel {
  private static current: KanbanPanel | undefined;
  private panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private projects: ProjectInfo[] = [];
  private currentProject: ProjectInfo | undefined;
  private board: KanbanBoard | undefined;
  private watcher: vscode.FileSystemWatcher | undefined;
  private prRefreshTimer: NodeJS.Timeout | undefined;
  private context: vscode.ExtensionContext;

  static createOrShow(context: vscode.ExtensionContext) {
    if (KanbanPanel.current) {
      KanbanPanel.current.panel.reveal(vscode.ViewColumn.One);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'oceangram.kanban', '📋 Kanban', vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    KanbanPanel.current = new KanbanPanel(panel, context);
  }

  private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
    this.panel = panel;
    this.context = context;
    this.panel.webview.html = this.getHtml();

    this.panel.onDidDispose(() => {
      KanbanPanel.current = undefined;
      this.stopWatching();
      this.stopPRRefreshTimer();
      this.disposables.forEach(d => d.dispose());
    }, null, this.disposables);

    this.panel.webview.onDidReceiveMessage(async (msg) => {
      try {
        switch (msg.type) {
          case 'init':
            this.projects = await loadProjects();
            this.panel.webview.postMessage({
              type: 'projects',
              projects: this.projects.map(p => ({ id: p.id, name: p.name })),
            });
            if (this.projects.length > 0) {
              await this.selectProject(this.projects[0].id);
            }
            break;

          case 'selectProject':
            await this.selectProject(msg.projectId);
            break;

          case 'moveTask':
            if (this.board && this.currentProject) {
              const position = typeof msg.position === 'number' ? msg.position : undefined;
              const ok = moveTask(this.board, msg.taskId, msg.targetColumn, position);
              if (ok) {
                await writeBoard(this.currentProject.file, this.board);
                this.sendBoard();
              }
            }
            break;

          case 'createTask':
            if (this.board && this.currentProject) {
              const task = createTask(
                this.board, msg.column, msg.title,
                msg.priority || 'P2', msg.category || 'Feature',
                msg.assigned || '', msg.tags || [], msg.description || ''
              );
              if (task) {
                await writeBoard(this.currentProject.file, this.board);
                this.sendBoard();
              }
            }
            break;

          case 'updateTask':
            if (this.board && this.currentProject) {
              const found = this.findTask(msg.taskId);
              if (found) {
                if (msg.field === 'title') found.title = msg.value;
                else if (msg.field === 'priority') found.priority = msg.value;
                else if (msg.field === 'category') found.category = msg.value;
                else if (msg.field === 'assigned') found.assigned = msg.value;
                else if (msg.field === 'tags') found.tags = msg.value;
                else if (msg.field === 'description') found.description = msg.value;
                await writeBoard(this.currentProject.file, this.board);
                this.sendBoard();
              }
            }
            break;

          case 'toggleSubtask':
            if (this.board && this.currentProject) {
              const t = this.findTask(msg.taskId);
              if (t && t.subtasks && t.subtasks[msg.index] !== undefined) {
                t.subtasks[msg.index].done = !t.subtasks[msg.index].done;
                await writeBoard(this.currentProject.file, this.board);
                this.sendBoard();
              }
            }
            break;

          case 'moveTaskToColumn':
            if (this.board && this.currentProject) {
              const ok = moveTask(this.board, msg.taskId, msg.targetColumn);
              if (ok) {
                await writeBoard(this.currentProject.file, this.board);
                this.sendBoard();
              }
            }
            break;

          case 'refreshPRs':
            clearPRCache();
            await this.loadBoardWithPRInfo();
            break;

          case 'openPR':
            if (msg.prUrl) {
              vscode.env.openExternal(vscode.Uri.parse(msg.prUrl));
            }
            break;
        }
      } catch (e: any) {
        this.panel.webview.postMessage({ type: 'error', message: e.message });
      }
    }, null, this.disposables);
  }

  private findTask(taskId: string): KanbanTask | undefined {
    if (!this.board) return undefined;
    for (const col of this.board.columns) {
      const t = col.tasks.find(t => t.id === taskId);
      if (t) return t;
    }
    return undefined;
  }

  private async selectProject(projectId: string) {
    this.currentProject = this.projects.find(p => p.id === projectId);
    if (!this.currentProject) return;

    this.stopWatching();
    this.stopPRRefreshTimer();

    if (await remoteFileExists(this.currentProject.file)) {
      await this.loadBoardWithPRInfo();
      this.startWatching(this.currentProject.file);
      this.startPRRefreshTimer();
    } else {
      this.panel.webview.postMessage({ type: 'error', message: `File not found: ${this.currentProject.file}` });
    }
  }

  private async loadBoardWithPRInfo() {
    if (!this.currentProject) return;
    
    this.board = await readBoard(this.currentProject.file);
    await enrichBoardWithPRInfo(this.board);
    this.sendBoard();
  }

  private sendBoard() {
    if (this.board) {
      this.panel.webview.postMessage({
        type: 'board',
        board: this.board,
        projectId: this.currentProject?.id,
      });
    }
  }

  private startWatching(filePath: string) {
    try {
      this.watcher = watchRemoteFile(filePath);
      this.watcher.onDidChange(async () => {
        if (this.currentProject) {
          setTimeout(async () => {
            try {
              await this.loadBoardWithPRInfo();
            } catch (e) {
              // File might be mid-write
            }
          }, 100);
        }
      });
    } catch (e) {
      // Watch not supported
    }
  }

  private stopWatching() {
    if (this.watcher) {
      this.watcher.dispose();
      this.watcher = undefined;
    }
  }

  private startPRRefreshTimer() {
    // Auto-refresh PR status every 5 minutes
    this.prRefreshTimer = setInterval(async () => {
      if (this.board && this.currentProject) {
        const oldBoard = JSON.stringify(this.board);
        await enrichBoardWithPRInfo(this.board);
        // Only send update if PR info actually changed
        if (JSON.stringify(this.board) !== oldBoard) {
          this.sendBoard();
        }
      }
    }, 5 * 60 * 1000); // 5 minutes
  }

  private stopPRRefreshTimer() {
    if (this.prRefreshTimer) {
      clearInterval(this.prRefreshTimer);
      this.prRefreshTimer = undefined;
    }
  }


  private getHtml(): string {
    const cssUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'kanbanPanel.css')
    );
    const jsUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'kanbanPanel.js')
    );
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<link rel="stylesheet" href="${cssUri}">
</head>
<body>
<div class="toolbar">
  <select id="projectSelect"><option value="">Loading...</option></select>
  <span class="board-name" id="boardName"></span>
</div>
<div class="board" id="board">
  <div class="status">Loading projects...</div>
</div>
<div class="detail-overlay" id="detailOverlay"></div>
<div class="detail-panel" id="detailPanel"></div>
<script src="${jsUri}"></script>
</body>
</html>`;
  }
}
