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
    '<div class="card-title" onclick="openTaskDetail(\'' + t.id + '\')">' + escHtml(t.title) + '</div>' +
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

  const tags = form.querySelector('.cf-tags').value.trim().split(/\s+/).filter(t => t);

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

/* Task Detail Panel */
let detailTaskId = null;

function openTaskDetail(taskId) {
  detailTaskId = taskId;
  const task = findTaskInBoard(taskId);
  if (!task) return;

  const overlay = document.getElementById('detailOverlay');
  const panel = document.getElementById('detailPanel');

  // Find current column
  let currentColumn = '';
  for (const col of board.columns) {
    if (col.tasks.find(t => t.id === taskId)) {
      currentColumn = col.title;
      break;
    }
  }

  panel.innerHTML =
    '<div class="detail-header">' +
      '<span class="task-id">' + escHtml(task.id) + '</span>' +
      '<button class="detail-close" onclick="closeTaskDetail()">✕</button>' +
    '</div>' +
    '<div class="detail-body">' +
      '<div class="field-group">' +
        '<div class="field-label">Title</div>' +
        '<input class="title-input" value="' + escAttr(task.title) + '" onchange="updateField(\'' + task.id + '\', \'title\', this.value)">' +
      '</div>' +
      '<div class="field-row">' +
        '<div class="field-group">' +
          '<div class="field-label">Priority</div>' +
          '<select onchange="updateField(\'' + task.id + '\', \'priority\', this.value)">' +
            ['P0','P1','P2','P3'].map(p => '<option value="' + p + '"' + (p === task.priority ? ' selected' : '') + '>' + p + '</option>').join('') +
          '</select>' +
        '</div>' +
        '<div class="field-group">' +
          '<div class="field-label">Category</div>' +
          '<select onchange="updateField(\'' + task.id + '\', \'category\', this.value)">' +
            ['Feature','Bug','Infra','Research','Task','Polish','Reliability','Review'].map(c => '<option value="' + c + '"' + (c === task.category ? ' selected' : '') + '>' + c + '</option>').join('') +
          '</select>' +
        '</div>' +
      '</div>' +
      '<div class="field-group">' +
        '<div class="field-label">Assigned</div>' +
        '<input value="' + escAttr(task.assigned) + '" onchange="updateField(\'' + task.id + '\', \'assigned\', this.value)">' +
      '</div>' +
      '<div class="field-group">' +
        '<div class="field-label">Tags</div>' +
        '<input value="' + escAttr((task.tags || []).join(' ')) + '" onchange="updateField(\'' + task.id + '\', \'tags\', this.value.trim().split(/\\s+/).filter(t=>t))">' +
      '</div>' +
      '<div class="field-group">' +
        '<div class="field-label">Description</div>' +
        '<textarea onchange="updateField(\'' + task.id + '\', \'description\', this.value)">' + escHtml(task.description) + '</textarea>' +
      '</div>' +
      (task.subtasks && task.subtasks.length > 0 ?
        '<div class="field-group">' +
          '<div class="field-label">Subtasks (' + task.subtasks.filter(s=>s.done).length + '/' + task.subtasks.length + ')</div>' +
          '<ul class="subtask-list">' +
            task.subtasks.map((st, i) =>
              '<li class="subtask-item' + (st.done ? ' done' : '') + '" onclick="toggleSubtask(\'' + task.id + '\', ' + i + ')">' +
                '<input type="checkbox"' + (st.done ? ' checked' : '') + '>' +
                '<span>' + escHtml(st.text) + '</span>' +
              '</li>'
            ).join('') +
          '</ul>' +
        '</div>'
      : '') +
      '<div class="field-group">' +
        '<div class="field-label">Move to Column</div>' +
        '<select class="move-column-select" onchange="moveToColumn(\'' + task.id + '\', this.value)">' +
          board.columns.map(col =>
            '<option value="' + escAttr(col.title) + '"' + (col.title === currentColumn ? ' selected' : '') + '>' + escHtml(col.title) + '</option>'
          ).join('') +
        '</select>' +
      '</div>' +
    '</div>';

  requestAnimationFrame(() => {
    overlay.classList.add('open');
    panel.classList.add('open');
  });
}

function closeTaskDetail() {
  detailTaskId = null;
  const overlay = document.getElementById('detailOverlay');
  const panel = document.getElementById('detailPanel');
  overlay.classList.remove('open');
  panel.classList.remove('open');
}

function findTaskInBoard(taskId) {
  if (!board) return null;
  for (const col of board.columns) {
    const t = col.tasks.find(t => t.id === taskId);
    if (t) return t;
  }
  return null;
}

function updateField(taskId, field, value) {
  vscode.postMessage({ type: 'updateTask', taskId, field, value });
}

function toggleSubtask(taskId, index) {
  vscode.postMessage({ type: 'toggleSubtask', taskId, index });
}

function moveToColumn(taskId, targetColumn) {
  vscode.postMessage({ type: 'moveTaskToColumn', taskId, targetColumn });
}

// Close on overlay click
document.getElementById('detailOverlay').addEventListener('click', closeTaskDetail);

// Close on Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && detailTaskId) {
    closeTaskDetail();
  }
});

// Re-open detail if board refreshes while detail is open
window.addEventListener('message', (e) => {
  if (e.data.type === 'board' && detailTaskId) {
    // Board was updated, refresh the detail panel
    setTimeout(() => openTaskDetail(detailTaskId), 50);
  }
});

function escHtml(s) {
  return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function escAttr(s) {
  return (s || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
