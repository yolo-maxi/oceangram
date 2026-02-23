import { describe, it, expect, beforeEach } from 'vitest';
import {
  parseTask,
  parseKanbanMarkdown,
  serializeTask,
  serializeBoard,
  KanbanTask,
  KanbanBoard,
} from '../services/kanban';

// --- Subtask parsing ---

const TASK_WITH_SUBTASKS = `### TASK-050 | Build login flow
**Priority**: P1 | **Category**: Feature | **Assigned**: @ocean
**Created**: 2026-01-15
**Tags**: #auth #frontend

Implement OAuth login flow.

- [ ] Add OAuth provider config
- [x] Create login button component
- [ ] Handle callback redirect`;

const TASK_NO_SUBTASKS = `### TASK-051 | Simple task
**Priority**: P2 | **Category**: Task | **Assigned**: @fran
**Created**: 2026-01-16
**Tags**: #misc

Just a plain description with no checkboxes.`;

describe('Subtask Parsing', () => {
  it('parses subtasks from description', () => {
    const task = parseTask(TASK_WITH_SUBTASKS);
    expect(task).not.toBeNull();
    expect(task!.subtasks).toHaveLength(3);
    expect(task!.subtasks[0]).toEqual({ text: 'Add OAuth provider config', done: false });
    expect(task!.subtasks[1]).toEqual({ text: 'Create login button component', done: true });
    expect(task!.subtasks[2]).toEqual({ text: 'Handle callback redirect', done: false });
  });

  it('description excludes subtask lines', () => {
    const task = parseTask(TASK_WITH_SUBTASKS);
    expect(task!.description).toBe('Implement OAuth login flow.');
    expect(task!.description).not.toContain('- [');
  });

  it('returns empty subtasks when none present', () => {
    const task = parseTask(TASK_NO_SUBTASKS);
    expect(task!.subtasks).toEqual([]);
    expect(task!.description).toContain('no checkboxes');
  });
});

// --- Subtask toggle ---

describe('Subtask Toggle', () => {
  it('toggles subtask from unchecked to checked', () => {
    const task = parseTask(TASK_WITH_SUBTASKS)!;
    expect(task.subtasks[0].done).toBe(false);
    task.subtasks[0].done = true;
    const md = serializeTask(task);
    const reparsed = parseTask(md)!;
    expect(reparsed.subtasks[0].done).toBe(true);
    expect(reparsed.subtasks[0].text).toBe('Add OAuth provider config');
  });

  it('toggles subtask from checked to unchecked', () => {
    const task = parseTask(TASK_WITH_SUBTASKS)!;
    expect(task.subtasks[1].done).toBe(true);
    task.subtasks[1].done = false;
    const md = serializeTask(task);
    const reparsed = parseTask(md)!;
    expect(reparsed.subtasks[1].done).toBe(false);
  });

  it('preserves other subtasks when toggling one', () => {
    const task = parseTask(TASK_WITH_SUBTASKS)!;
    task.subtasks[0].done = true;
    const md = serializeTask(task);
    const reparsed = parseTask(md)!;
    expect(reparsed.subtasks).toHaveLength(3);
    expect(reparsed.subtasks[1].done).toBe(true);
    expect(reparsed.subtasks[2].done).toBe(false);
  });
});

// --- Subtask serialization ---

describe('Subtask Serialization', () => {
  it('serializes subtasks as checkboxes', () => {
    const task: KanbanTask = {
      id: 'TASK-060',
      title: 'With subtasks',
      priority: 'P2',
      category: 'Feature',
      assigned: '@ocean',
      tags: ['#test'],
      description: 'Some desc.',
      created: '2026-02-01',
      subtasks: [
        { text: 'First', done: false },
        { text: 'Second', done: true },
      ],
    };
    const md = serializeTask(task);
    expect(md).toContain('- [ ] First');
    expect(md).toContain('- [x] Second');
  });

  it('serializes task with empty subtasks (no checkbox lines)', () => {
    const task: KanbanTask = {
      id: 'TASK-061',
      title: 'No subtasks',
      priority: 'P3',
      category: 'Task',
      assigned: '',
      tags: [],
      description: 'Plain.',
      created: '2026-02-01',
      subtasks: [],
    };
    const md = serializeTask(task);
    expect(md).not.toContain('- [');
  });

  it('round-trips task with subtasks through board serialize/parse', () => {
    const mdBoard = `# Test Kanban

<!-- Config: Last Task ID: 50 -->

## ⚙️ Configuration
**Board Name**: Test

## 💡 Ideas

${TASK_WITH_SUBTASKS}

---

## 📋 Backlog
## 🔨 In Progress
## 🚧 Blocked
## 👀 Review
## ✅ Done (Agent)
## ✅ Done (Fran)
`;
    const board = parseKanbanMarkdown(mdBoard);
    const task = board.columns[0].tasks[0];
    expect(task.subtasks).toHaveLength(3);

    // Toggle and re-serialize
    task.subtasks[0].done = true;
    const serialized = serializeBoard(board);
    const reparsed = parseKanbanMarkdown(serialized);
    const t2 = reparsed.columns[0].tasks[0];
    expect(t2.subtasks[0].done).toBe(true);
    expect(t2.subtasks[1].done).toBe(true);
    expect(t2.subtasks[2].done).toBe(false);
    expect(t2.description).toBe('Implement OAuth login flow.');
  });
});

// --- Field editing ---

describe('Task Field Editing', () => {
  it('updates priority and serializes correctly', () => {
    const task = parseTask(TASK_WITH_SUBTASKS)!;
    task.priority = 'P0';
    const md = serializeTask(task);
    const reparsed = parseTask(md)!;
    expect(reparsed.priority).toBe('P0');
  });

  it('updates category', () => {
    const task = parseTask(TASK_WITH_SUBTASKS)!;
    task.category = 'Bug';
    const md = serializeTask(task);
    const reparsed = parseTask(md)!;
    expect(reparsed.category).toBe('Bug');
  });

  it('updates assigned', () => {
    const task = parseTask(TASK_WITH_SUBTASKS)!;
    task.assigned = '@fran';
    const md = serializeTask(task);
    const reparsed = parseTask(md)!;
    expect(reparsed.assigned).toBe('@fran');
  });

  it('updates tags', () => {
    const task = parseTask(TASK_WITH_SUBTASKS)!;
    task.tags = ['#new', '#tags'];
    const md = serializeTask(task);
    const reparsed = parseTask(md)!;
    expect(reparsed.tags).toEqual(['#new', '#tags']);
  });

  it('updates description', () => {
    const task = parseTask(TASK_WITH_SUBTASKS)!;
    task.description = 'Updated description.';
    const md = serializeTask(task);
    const reparsed = parseTask(md)!;
    expect(reparsed.description).toBe('Updated description.');
  });

  it('updates title', () => {
    const task = parseTask(TASK_WITH_SUBTASKS)!;
    task.title = 'New title here';
    const md = serializeTask(task);
    const reparsed = parseTask(md)!;
    expect(reparsed.title).toBe('New title here');
  });
});

// --- updateTask helper ---

describe('updateTask in board', () => {
  it('finds and updates a task in the board', () => {
    const md = `# Test Kanban

<!-- Config: Last Task ID: 2 -->

## ⚙️ Configuration
**Board Name**: Test

## 💡 Ideas

### TASK-001 | Original title
**Priority**: P2 | **Category**: Feature | **Assigned**: @ocean
**Created**: 2026-01-01
**Tags**: #old

Old description.

---

## 📋 Backlog
## 🔨 In Progress
## 🚧 Blocked
## 👀 Review
## ✅ Done (Agent)
## ✅ Done (Fran)
`;
    const board = parseKanbanMarkdown(md);
    const task = board.columns[0].tasks[0];
    task.title = 'Updated title';
    task.priority = 'P0';
    task.description = 'New desc.';

    const serialized = serializeBoard(board);
    const reparsed = parseKanbanMarkdown(serialized);
    const updated = reparsed.columns[0].tasks[0];
    expect(updated.title).toBe('Updated title');
    expect(updated.priority).toBe('P0');
    expect(updated.description).toBe('New desc.');
  });
});
