import * as vscode from 'vscode';
import * as fs from 'fs';
import {
  loadProjects,
  readBoard,
  writeBoard,
  moveTask,
  createTask,
  KanbanBoard,
  ProjectInfo,
} from './services/kanban';

export class KanbanPanel {
  private static current: KanbanPanel | undefined;
  private panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private projects: ProjectInfo[] = [];
  private currentProject: ProjectInfo | undefined;
  private board: KanbanBoard | undefined;
  private watcher: fs.FSWatcher | undefined;

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
    this.panel.webview.html = this.getHtml();

    this.panel.onDidDispose(() => {
      KanbanPanel.current = undefined;
      this.stopWatching();
      this.disposables.forEach(d => d.dispose());
    }, null, this.disposables);

    this.panel.webview.onDidReceiveMessage(async (msg) => {
      try {
        switch (msg.type) {
          case 'init':
            this.projects = loadProjects();
            this.panel.webview.postMessage({
              type: 'projects',
              projects: this.projects.map(p => ({ id: p.id, name: p.name })),
            });
            // Auto-select first project
            if (this.projects.length > 0) {
              this.selectProject(this.projects[0].id);
            }
            break;

          case 'selectProject':
            this.selectProject(msg.projectId);
            break;

          case 'moveTask':
            if (this.board && this.currentProject) {
              const position = typeof msg.position === 'number' ? msg.position : undefined;
              const ok = moveTask(this.board, msg.taskId, msg.targetColumn, position);
              if (ok) {
                writeBoard(this.currentProject.file, this.board);
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
                writeBoard(this.currentProject.file, this.board);
                this.sendBoard();
              }
            }
            break;
        }
      } catch (e: any) {
        this.panel.webview.postMessage({ type: 'error', message: e.message });
      }
    }, null, this.disposables);
  }

  private selectProject(projectId: string) {
    this.currentProject = this.projects.find(p => p.id === projectId);
    if (!this.currentProject) return;

    this.stopWatching();

    if (fs.existsSync(this.currentProject.file)) {
      this.board = readBoard(this.currentProject.file);
      this.sendBoard();
      this.startWatching(this.currentProject.file);
    } else {
      this.panel.webview.postMessage({ type: 'error', message: `File not found: ${this.currentProject.file}` });
    }
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
      this.watcher = fs.watch(filePath, (event) => {
        if (event === 'change' && this.currentProject) {
          setTimeout(() => {
            try {
              this.board = readBoard(this.currentProject!.file);
              this.sendBoard();
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
      this.watcher.close();
      this.watcher = undefined;
    }
  }

  private getHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
:root {
  --tg-bg: #0e1621;
  --tg-bg-secondary: #17212b;
  --tg-msg-in-bg: #182533;
  --tg-accent: #6ab2f2;
  --tg-text: #f5f5f5;
  --tg-text-secondary: #6d7f8f;
  --tg-border: #1e2c3a;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: system-ui, -apple-system, sans-serif;
  color: var(--tg-text);
  background: var(--tg-bg);
  overflow: hidden;
  height: 100vh;
  display: flex;
  flex-direction: column;
}

/* Toolbar */
.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--tg-border);
  background: var(--tg-bg-secondary);
  flex-shrink: 0;
}
.toolbar select {
  background: var(--tg-bg);
  color: var(--tg-text);
  border: 1px solid var(--tg-border);
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 13px;
  outline: none;
}
.toolbar select:focus {
  border-color: var(--tg-accent);
}
.toolbar .board-name {
  font-weight: 600;
  font-size: 14px;
  color: var(--tg-text-secondary);
  margin-left: auto;
}

/* Board */
.board {
  display: flex;
  gap: 12px;
  padding: 12px;
  overflow-x: auto;
  overflow-y: hidden;
  flex: 1;
  align-items: flex-start;
}

/* Column */
.column {
  min-width: 260px;
  max-width: 300px;
  background: var(--tg-bg-secondary);
  border: 1px solid var(--tg-border);
  border-radius: 6px;
  display: flex;
  flex-direction: column;
  max-height: 100%;
  flex-shrink: 0;
}
.column-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  font-weight: 600;
  font-size: 13px;
  border-bottom: 1px solid var(--tg-border);
  flex-shrink: 0;
}
.column-header .count {
  background: var(--tg-accent);
  color: var(--tg-bg);
  padding: 1px 6px;
  border-radius: 8px;
  font-size: 11px;
  font-weight: 600;
}
.column-header .add-btn {
  cursor: pointer;
  opacity: 0.5;
  font-size: 16px;
  border: none;
  background: none;
  color: var(--tg-text);
  padding: 0 4px;
}
.column-header .add-btn:hover { opacity: 1; }
.column-body {
  overflow-y: auto;
  padding: 6px;
  flex: 1;
  min-height: 60px;
  position: relative;
}
.column-body.drag-over {
  background: rgba(106, 178, 242, 0.08);
}
.column-body.drag-over-empty::after {
  content: 'Drop here';
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  color: var(--tg-accent);
  font-size: 11px;
  font-weight: 500;
  opacity: 0.7;
  pointer-events: none;
}
/* Drop indicator for empty columns or end of column */
.drop-indicator {
  height: 3px;
  background: var(--tg-accent);
  border-radius: 2px;
  margin: 2px 0;
  animation: dropIndicatorPulse 0.8s ease-in-out infinite;
}

/* Card */
.card {
  background: var(--tg-msg-in-bg);
  border: 1px solid var(--tg-border);
  border-radius: 4px;
  padding: 8px 10px;
  margin-bottom: 6px;
  cursor: grab;
  transition: border-color 0.15s, box-shadow 0.15s, transform 0.2s ease, opacity 0.2s ease;
  font-size: 12px;
  position: relative;
}
.card:hover {
  border-color: var(--tg-accent);
  box-shadow: 0 1px 4px rgba(0,0,0,0.3);
}
.card:active {
  cursor: grabbing;
}
.card.dragging {
  opacity: 0.4;
  transform: scale(0.98);
}
.card.drag-over-above::before {
  content: '';
  position: absolute;
  top: -4px;
  left: 0;
  right: 0;
  height: 3px;
  background: var(--tg-accent);
  border-radius: 2px;
  animation: dropIndicatorPulse 0.8s ease-in-out infinite;
}
.card.drag-over-below::after {
  content: '';
  position: absolute;
  bottom: -4px;
  left: 0;
  right: 0;
  height: 3px;
  background: var(--tg-accent);
  border-radius: 2px;
  animation: dropIndicatorPulse 0.8s ease-in-out infinite;
}
@keyframes dropIndicatorPulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}
.card-title {
  font-weight: 600;
  font-size: 12.5px;
  margin-bottom: 4px;
  cursor: pointer;
}
.card-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
}
.badge {
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 10px;
  font-weight: 600;
  color: #fff;
}
.badge-P0 { background: #e06c75; }
.badge-P1 { background: #d19a66; }
.badge-P2 { background: #61afef; }
.badge-P3 { background: #5a6e7e; }
.tag {
  font-size: 10px;
  color: var(--tg-text-secondary);
}
.assigned {
  font-size: 10px;
  color: var(--tg-text-secondary);
  margin-left: auto;
}
.card-id {
  font-size: 10px;
  color: var(--tg-text-secondary);
}

/* Expanded description */
.card-desc {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid var(--tg-border);
  font-size: 11px;
  color: var(--tg-text-secondary);
  white-space: pre-wrap;
  display: none;
}
.card-desc.show { display: block; }

/* Create form */
.create-form {
  padding: 6px;
  border-top: 1px solid var(--tg-border);
  display: none;
}
.create-form.show { display: block; }
.create-form input, .create-form select, .create-form textarea {
  width: 100%;
  background: var(--tg-bg);
  color: var(--tg-text);
  border: 1px solid var(--tg-border);
  padding: 4px 6px;
  border-radius: 3px;
  font-size: 12px;
  margin-bottom: 4px;
  font-family: inherit;
  outline: none;
}
.create-form textarea { resize: vertical; min-height: 40px; }
.create-form .form-row {
  display: flex;
  gap: 4px;
}
.create-form .form-row select { width: 50%; }
.create-form .form-actions {
  display: flex;
  gap: 4px;
  margin-top: 4px;
}
.create-form button {
  padding: 3px 10px;
  border-radius: 3px;
  font-size: 11px;
  cursor: pointer;
  border: none;
}
.btn-create {
  background: var(--tg-accent);
  color: var(--tg-bg);
  font-weight: 600;
}
.btn-cancel {
  background: transparent;
  color: var(--tg-text-secondary);
  border: 1px solid var(--tg-border) !important;
}

/* Loading / Error */
.status {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--tg-text-secondary);
  font-size: 14px;
}

/* Priority left border on cards */
.card[data-priority="P0"] { border-left: 3px solid #e06c75; }
.card[data-priority="P1"] { border-left: 3px solid #d19a66; }
.card[data-priority="P2"] { border-left: 3px solid #61afef; }
.card[data-priority="P3"] { border-left: 3px solid #5a6e7e; }

/* Scrollbar */
::-webkit-scrollbar { width: 6px; height: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--tg-text-secondary); border-radius: 3px; }
::-webkit-scrollbar-thumb:hover { background: var(--tg-accent); }
</style>
</head>
<body>
<div class="toolbar">
  <select id="projectSelect"><option value="">Loading...</option></select>
  <span class="board-name" id="boardName"></span>
</div>
<div class="board" id="board">
  <div class="status">Loading projects...</div>
</div>

<script>
const vscode = acquireVsCodeApi();
let board = null;
let expandedTasks = new Set();

// Init
vscode.postMessage({ type: 'init' });

window.addEventListener('message', (e) => {
  const msg = e.data;
  switch (msg.type) {
    case 'projects':
      renderProjectSelect(msg.projects);
      break;
    case 'board':
      board = msg.board;
      renderBoard(board);
      break;
    case 'error':
      document.getElementById('board').innerHTML = '<div class="status">' + escHtml(msg.message) + '</div>';
      break;
  }
});

function renderProjectSelect(projects) {
  const sel = document.getElementById('projectSelect');
  sel.innerHTML = projects.map(p =>
    '<option value="' + p.id + '">' + escHtml(p.name) + '</option>'
  ).join('');
  sel.onchange = () => {
    vscode.postMessage({ type: 'selectProject', projectId: sel.value });
  };
}

function renderBoard(board) {
  document.getElementById('boardName').textContent = board.name;
  const el = document.getElementById('board');
  el.innerHTML = board.columns.map(col => renderColumn(col)).join('');
  initDragDrop();
}

function renderColumn(col) {
  const colId = col.title;
  return '<div class="column" data-column="' + escAttr(colId) + '">' +
    '<div class="column-header">' +
      '<span>' + escHtml(colId) + '</span>' +
      '<span><span class="count">' + col.tasks.length + '</span> ' +
      '<button class="add-btn" onclick="toggleCreateForm(this)" title="Add task">+</button></span>' +
    '</div>' +
    '<div class="column-body" data-column="' + escAttr(colId) + '">' +
      col.tasks.map(t => renderCard(t)).join('') +
    '</div>' +
    '<div class="create-form" data-column="' + escAttr(colId) + '">' +
      '<input type="text" placeholder="Task title" class="cf-title">' +
      '<div class="form-row">' +
        '<select class="cf-priority"><option value="P0">P0</option><option value="P1">P1</option><option value="P2" selected>P2</option><option value="P3">P3</option></select>' +
        '<select class="cf-category"><option value="Feature">Feature</option><option value="Bug">Bug</option><option value="Infra">Infra</option><option value="Research">Research</option><option value="Task">Task</option></select>' +
      '</div>' +
      '<input type="text" placeholder="@assigned" class="cf-assigned">' +
      '<input type="text" placeholder="#tag1 #tag2" class="cf-tags">' +
      '<textarea placeholder="Description (optional)" class="cf-desc"></textarea>' +
      '<div class="form-actions">' +
        '<button class="btn-create" onclick="submitCreate(this)">Create</button>' +
        '<button class="btn-cancel" onclick="toggleCreateForm(this)">Cancel</button>' +
      '</div>' +
    '</div>' +
  '</div>';
}

function renderCard(t) {
  const expanded = expandedTasks.has(t.id);
  return '<div class="card" draggable="true" data-task-id="' + t.id + '" data-priority="' + t.priority + '">' +
    '<div class="card-title" onclick="toggleDesc(\\'' + t.id + '\\')">' + escHtml(t.title) + '</div>' +
    '<div class="card-meta">' +
      '<span class="badge badge-' + t.priority + '">' + t.priority + '</span>' +
      '<span class="card-id">' + t.id + '</span>' +
      t.tags.map(tag => '<span class="tag">' + escHtml(tag) + '</span>').join('') +
      (t.assigned ? '<span class="assigned">' + escHtml(t.assigned) + '</span>' : '') +
    '</div>' +
    (t.description ? '<div class="card-desc' + (expanded ? ' show' : '') + '" data-task-id="' + t.id + '">' + escHtml(t.description) + '</div>' : '') +
  '</div>';
}

function toggleDesc(taskId) {
  if (expandedTasks.has(taskId)) {
    expandedTasks.delete(taskId);
  } else {
    expandedTasks.add(taskId);
  }
  const descs = document.querySelectorAll('.card-desc[data-task-id="' + taskId + '"]');
  descs.forEach(d => d.classList.toggle('show'));
}

function toggleCreateForm(btn) {
  const form = btn.closest('.column').querySelector('.create-form');
  form.classList.toggle('show');
  if (form.classList.contains('show')) {
    form.querySelector('.cf-title').focus();
  }
}

function submitCreate(btn) {
  const form = btn.closest('.create-form');
  const column = form.dataset.column;
  const title = form.querySelector('.cf-title').value.trim();
  if (!title) return;

  const tags = form.querySelector('.cf-tags').value.trim().split(/\\s+/).filter(t => t);

  vscode.postMessage({
    type: 'createTask',
    column,
    title,
    priority: form.querySelector('.cf-priority').value,
    category: form.querySelector('.cf-category').value,
    assigned: form.querySelector('.cf-assigned').value.trim(),
    tags,
    description: form.querySelector('.cf-desc').value.trim(),
  });

  // Reset form
  form.querySelector('.cf-title').value = '';
  form.querySelector('.cf-desc').value = '';
  form.querySelector('.cf-tags').value = '';
  form.querySelector('.cf-assigned').value = '';
  form.classList.remove('show');
}

/* Drag & Drop */
let draggedTaskId = null;
let dropPosition = null;
let dropTargetColumn = null;

function initDragDrop() {
  document.querySelectorAll('.card').forEach(card => {
    card.addEventListener('dragstart', (e) => {
      draggedTaskId = card.dataset.taskId;
      e.dataTransfer.setData('text/plain', card.dataset.taskId);
      e.dataTransfer.effectAllowed = 'move';
      // Delay adding class so drag image captures properly
      requestAnimationFrame(() => card.classList.add('dragging'));
    });
    
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      clearAllDropIndicators();
      draggedTaskId = null;
      dropPosition = null;
      dropTargetColumn = null;
    });
    
    card.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      // Don't show indicator on the card being dragged
      if (card.dataset.taskId === draggedTaskId) return;
      
      const rect = card.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      const isAbove = e.clientY < midY;
      
      clearAllDropIndicators();
      card.classList.add(isAbove ? 'drag-over-above' : 'drag-over-below');
      
      // Calculate position
      const colBody = card.closest('.column-body');
      const cards = Array.from(colBody.querySelectorAll('.card:not(.dragging)'));
      const cardIndex = cards.indexOf(card);
      dropPosition = isAbove ? cardIndex : cardIndex + 1;
      dropTargetColumn = colBody.dataset.column;
    });
    
    card.addEventListener('dragleave', (e) => {
      // Only clear if actually leaving this card
      if (!card.contains(e.relatedTarget)) {
        card.classList.remove('drag-over-above', 'drag-over-below');
      }
    });
    
    card.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const taskId = e.dataTransfer.getData('text/plain');
      const colBody = card.closest('.column-body');
      const targetColumn = colBody.dataset.column;
      
      const rect = card.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      const isAbove = e.clientY < midY;
      
      const cards = Array.from(colBody.querySelectorAll('.card:not(.dragging)'));
      const cardIndex = cards.indexOf(card);
      const position = isAbove ? cardIndex : cardIndex + 1;
      
      clearAllDropIndicators();
      
      if (taskId && targetColumn) {
        vscode.postMessage({ type: 'moveTask', taskId, targetColumn, position });
      }
    });
  });

  document.querySelectorAll('.column-body').forEach(colBody => {
    colBody.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      colBody.classList.add('drag-over');
      
      // If dragging over empty space (not over a card), show end-of-list indicator
      const target = e.target;
      if (target === colBody || target.classList.contains('column-body')) {
        const cards = colBody.querySelectorAll('.card:not(.dragging)');
        if (cards.length === 0) {
          colBody.classList.add('drag-over-empty');
          dropPosition = 0;
        } else {
          // Check if we're below all cards
          const lastCard = cards[cards.length - 1];
          const lastRect = lastCard.getBoundingClientRect();
          if (e.clientY > lastRect.bottom) {
            clearAllDropIndicators();
            lastCard.classList.add('drag-over-below');
            dropPosition = cards.length;
          }
        }
        dropTargetColumn = colBody.dataset.column;
      }
    });
    
    colBody.addEventListener('dragleave', (e) => {
      // Only remove if actually leaving the column body
      if (!colBody.contains(e.relatedTarget)) {
        colBody.classList.remove('drag-over', 'drag-over-empty');
      }
    });
    
    colBody.addEventListener('drop', (e) => {
      e.preventDefault();
      const taskId = e.dataTransfer.getData('text/plain');
      const targetColumn = colBody.dataset.column;
      
      // Calculate position based on where we dropped
      let position = null;
      const cards = Array.from(colBody.querySelectorAll('.card:not(.dragging)'));
      
      if (cards.length === 0) {
        position = 0;
      } else {
        // Find position based on y coordinate
        const y = e.clientY;
        position = cards.length; // Default to end
        for (let i = 0; i < cards.length; i++) {
          const rect = cards[i].getBoundingClientRect();
          if (y < rect.top + rect.height / 2) {
            position = i;
            break;
          }
        }
      }
      
      clearAllDropIndicators();
      colBody.classList.remove('drag-over', 'drag-over-empty');
      
      if (taskId && targetColumn) {
        vscode.postMessage({ type: 'moveTask', taskId, targetColumn, position });
      }
    });
  });
}

function clearAllDropIndicators() {
  document.querySelectorAll('.card').forEach(c => {
    c.classList.remove('drag-over-above', 'drag-over-below');
  });
  document.querySelectorAll('.column-body').forEach(cb => {
    cb.classList.remove('drag-over', 'drag-over-empty');
  });
}

function escHtml(s) {
  return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function escAttr(s) {
  return (s || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
</script>
</body>
</html>`;
  }
}
