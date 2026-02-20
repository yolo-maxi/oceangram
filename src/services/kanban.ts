import * as fs from 'fs';
import * as path from 'path';

export interface KanbanTask {
  id: string;
  title: string;
  priority: string;
  category: string;
  assigned: string;
  tags: string[];
  description: string;
  created: string;
}

export interface KanbanColumn {
  title: string;
  tasks: KanbanTask[];
}

export interface KanbanBoard {
  name: string;
  columns: KanbanColumn[];
  lastTaskId: number;
}

export interface ProjectInfo {
  id: string;
  name: string;
  file: string;
  owner: string;
}

const PROJECTS_JSON = '/home/xiko/kanban-app/data/projects.json';

/**
 * Load project list from projects.json
 */
export function loadProjects(): ProjectInfo[] {
  const raw = fs.readFileSync(PROJECTS_JSON, 'utf-8');
  const data = JSON.parse(raw);
  return Object.entries(data.projects).map(([id, p]: [string, any]) => ({
    id,
    name: p.name,
    file: p.file,
    owner: p.owner,
  }));
}

/**
 * Known column headers (order matters for rendering)
 */
const COLUMN_HEADERS = [
  '💡 Ideas',
  '📋 Backlog',
  '🔨 In Progress',
  '🚧 Blocked',
  '👀 Review',
  '✅ Done (Agent)',
  '✅ Done (Fran)',
];

/**
 * Parse a single task block (### TASK-xxx | title ... --- )
 */
export function parseTask(block: string): KanbanTask | null {
  const lines = block.trim().split('\n');
  if (lines.length === 0) return null;

  // First line: ### TASK-035 | Semantic chat search
  const headerMatch = lines[0].match(/^###\s+(TASK-\d+)\s*\|\s*(.+)/);
  if (!headerMatch) return null;

  const id = headerMatch[1];
  const title = headerMatch[2].trim();

  let priority = '';
  let category = '';
  let assigned = '';
  let tags: string[] = [];
  let created = '';
  const descLines: string[] = [];
  let pastMeta = false;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];

    // Priority/Category/Assigned line
    const metaMatch = line.match(/^\*\*Priority\*\*:\s*(\S+)/);
    if (metaMatch) {
      priority = metaMatch[1];
      const catMatch = line.match(/\*\*Category\*\*:\s*(\S+)/);
      if (catMatch) category = catMatch[1];
      const assignMatch = line.match(/\*\*Assigned\*\*:\s*(\S+)/);
      if (assignMatch) assigned = assignMatch[1];
      continue;
    }

    // Created line
    const createdMatch = line.match(/^\*\*Created\*\*:\s*(.+)/);
    if (createdMatch) {
      created = createdMatch[1].trim();
      continue;
    }

    // Tags line
    const tagsMatch = line.match(/^\*\*Tags\*\*:\s*(.+)/);
    if (tagsMatch) {
      tags = tagsMatch[1].trim().split(/\s+/).filter(t => t.startsWith('#'));
      pastMeta = true;
      continue;
    }

    // Skip empty lines right after meta
    if (!pastMeta && line.trim() === '') {
      pastMeta = true;
      continue;
    }

    if (pastMeta || (line.trim() !== '' && !line.startsWith('**'))) {
      pastMeta = true;
      descLines.push(line);
    }
  }

  return {
    id,
    title,
    priority,
    category,
    assigned,
    tags,
    description: descLines.join('\n').trim(),
    created,
  };
}

/**
 * Parse kanban markdown into structured board data
 */
export function parseKanbanMarkdown(content: string): KanbanBoard {
  let lastTaskId = 0;
  const configMatch = content.match(/Last Task ID:\s*(\d+)/);
  if (configMatch) lastTaskId = parseInt(configMatch[1], 10);

  const nameMatch = content.match(/^\*\*Board Name\*\*:\s*(.+)/m);
  const name = nameMatch ? nameMatch[1].trim() : 'Untitled';

  const columns: KanbanColumn[] = [];

  // Split by ## headers (columns)
  const columnRegex = /^## (.+)$/gm;
  const matches: { title: string; start: number }[] = [];
  let m;
  while ((m = columnRegex.exec(content)) !== null) {
    matches.push({ title: m[1].trim(), start: m.index + m[0].length });
  }

  for (let i = 0; i < matches.length; i++) {
    const colTitle = matches[i].title;

    // Skip config section
    if (colTitle.includes('Configuration')) continue;

    const sectionEnd = i + 1 < matches.length ? matches[i + 1].start - matches[i + 1].title.length - 4 : content.length;
    const sectionContent = content.slice(matches[i].start, sectionEnd);

    // Split into task blocks by ---
    const taskBlocks = sectionContent.split(/\n---\n/);
    const tasks: KanbanTask[] = [];

    for (const block of taskBlocks) {
      const task = parseTask(block);
      if (task) tasks.push(task);
    }

    columns.push({ title: colTitle, tasks });
  }

  // Ensure all known columns exist (even if empty)
  for (const header of COLUMN_HEADERS) {
    if (!columns.find(c => c.title === header)) {
      columns.push({ title: header, tasks: [] });
    }
  }

  // Sort columns by known order
  columns.sort((a, b) => {
    const ai = COLUMN_HEADERS.indexOf(a.title);
    const bi = COLUMN_HEADERS.indexOf(b.title);
    if (ai === -1 && bi === -1) return 0;
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });

  return { name, columns, lastTaskId };
}

/**
 * Serialize a task back to markdown
 */
export function serializeTask(task: KanbanTask): string {
  const lines: string[] = [];
  lines.push(`### ${task.id} | ${task.title}`);
  lines.push(`**Priority**: ${task.priority} | **Category**: ${task.category} | **Assigned**: ${task.assigned}`);
  if (task.created) lines.push(`**Created**: ${task.created}`);
  if (task.tags.length > 0) lines.push(`**Tags**: ${task.tags.join(' ')}`);
  if (task.description) {
    lines.push('');
    lines.push(task.description);
  }
  return lines.join('\n');
}

/**
 * Serialize entire board back to markdown
 */
export function serializeBoard(board: KanbanBoard): string {
  const lines: string[] = [];
  lines.push(`# ${board.name} Kanban`);
  lines.push('');
  lines.push(`<!-- Config: Last Task ID: ${board.lastTaskId} -->`);
  lines.push('');
  lines.push('## ⚙️ Configuration');
  lines.push(`**Board Name**: ${board.name}`);
  lines.push('');

  for (const col of board.columns) {
    lines.push(`## ${col.title}`);
    lines.push('');
    for (let i = 0; i < col.tasks.length; i++) {
      lines.push(serializeTask(col.tasks[i]));
      lines.push('');
      lines.push('---');
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * Move a task from one column to another in the board, optionally at a specific position
 * @param board The kanban board
 * @param taskId ID of the task to move
 * @param targetColumnTitle Title of the target column
 * @param position Optional position index in the target column (defaults to end)
 */
export function moveTask(
  board: KanbanBoard,
  taskId: string,
  targetColumnTitle: string,
  position?: number
): boolean {
  let task: KanbanTask | undefined;
  let sourceCol: KanbanColumn | undefined;
  let sourceIdx: number = -1;

  for (const col of board.columns) {
    const idx = col.tasks.findIndex(t => t.id === taskId);
    if (idx !== -1) {
      task = col.tasks[idx];
      sourceCol = col;
      sourceIdx = idx;
      col.tasks.splice(idx, 1);
      break;
    }
  }

  if (!task) return false;

  const targetCol = board.columns.find(c => c.title === targetColumnTitle);
  if (!targetCol) {
    // Put it back
    sourceCol!.tasks.splice(sourceIdx, 0, task);
    return false;
  }

  // Calculate actual insert position
  let insertAt = position ?? targetCol.tasks.length;
  
  // If moving within the same column and the original position was before the target,
  // we need to adjust since we already removed the task
  if (sourceCol === targetCol && sourceIdx < insertAt) {
    insertAt = Math.max(0, insertAt - 1);
  }
  
  // Clamp to valid range
  insertAt = Math.max(0, Math.min(insertAt, targetCol.tasks.length));
  
  targetCol.tasks.splice(insertAt, 0, task);
  return true;
}

/**
 * Create a new task in a column
 */
export function createTask(
  board: KanbanBoard,
  columnTitle: string,
  title: string,
  priority: string = 'P2',
  category: string = 'Feature',
  assigned: string = '',
  tags: string[] = [],
  description: string = ''
): KanbanTask | null {
  const col = board.columns.find(c => c.title === columnTitle);
  if (!col) return null;

  board.lastTaskId++;
  const id = `TASK-${String(board.lastTaskId).padStart(3, '0')}`;
  const today = new Date().toISOString().split('T')[0];

  const task: KanbanTask = {
    id,
    title,
    priority,
    category,
    assigned,
    tags,
    description,
    created: today,
  };

  col.tasks.push(task);
  return task;
}

/**
 * Read and parse a kanban file
 */
export function readBoard(filePath: string): KanbanBoard {
  const content = fs.readFileSync(filePath, 'utf-8');
  return parseKanbanMarkdown(content);
}

/**
 * Write board back to file
 */
export function writeBoard(filePath: string, board: KanbanBoard): void {
  fs.writeFileSync(filePath, serializeBoard(board), 'utf-8');
}
