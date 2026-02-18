import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parseKanbanMarkdown,
  parseTask,
  serializeTask,
  serializeBoard,
  moveTask,
  createTask,
  loadProjects,
  KanbanBoard,
  KanbanTask,
  KanbanColumn,
} from '../services/kanban';

const SAMPLE_MARKDOWN = `# Test Kanban

<!-- Config: Last Task ID: 5 -->

## ⚙️ Configuration
**Board Name**: TestProject

## 💡 Ideas

### TASK-001 | Build feature X
**Priority**: P0 | **Category**: Feature | **Assigned**: @ocean
**Created**: 2026-01-01
**Tags**: #frontend #ux

This is the description for feature X.
It spans multiple lines.

---

### TASK-002 | Fix bug Y
**Priority**: P1 | **Category**: Bug | **Assigned**: @fran
**Created**: 2026-01-02
**Tags**: #backend

Bug description here.

---

## 📋 Backlog

### TASK-003 | Research Z
**Priority**: P2 | **Category**: Research | **Assigned**: @ocean
**Created**: 2026-01-03
**Tags**: #research

Research description.

---

## 🔨 In Progress

### TASK-004 | Deploy service
**Priority**: P1 | **Category**: Infra | **Assigned**: @fran
**Created**: 2026-01-04
**Tags**: #infra #deploy

Deploy the service to production.

---

## 🚧 Blocked

## 👀 Review

### TASK-005 | Code review
**Priority**: P3 | **Category**: Review | **Assigned**: @ocean
**Created**: 2026-01-05
**Tags**: #review

Needs review from Fran.

---

## ✅ Done (Agent)

## ✅ Done (Fran)
`;

describe('Kanban Parser', () => {
  let board: KanbanBoard;

  beforeEach(() => {
    board = parseKanbanMarkdown(SAMPLE_MARKDOWN);
  });

  // 1. Board metadata
  it('parses board name', () => {
    expect(board.name).toBe('TestProject');
  });

  it('parses last task ID', () => {
    expect(board.lastTaskId).toBe(5);
  });

  // 2. Column parsing
  it('parses all 7 columns', () => {
    expect(board.columns.length).toBe(7);
  });

  it('columns are in correct order', () => {
    const titles = board.columns.map(c => c.title);
    expect(titles).toEqual([
      '💡 Ideas',
      '📋 Backlog',
      '🔨 In Progress',
      '🚧 Blocked',
      '👀 Review',
      '✅ Done (Agent)',
      '✅ Done (Fran)',
    ]);
  });

  it('Ideas column has 2 tasks', () => {
    expect(board.columns[0].tasks.length).toBe(2);
  });

  it('Backlog column has 1 task', () => {
    expect(board.columns[1].tasks.length).toBe(1);
  });

  it('Blocked column is empty', () => {
    const blocked = board.columns.find(c => c.title === '🚧 Blocked');
    expect(blocked!.tasks.length).toBe(0);
  });

  // 3. Task parsing
  it('parses task ID', () => {
    expect(board.columns[0].tasks[0].id).toBe('TASK-001');
  });

  it('parses task title', () => {
    expect(board.columns[0].tasks[0].title).toBe('Build feature X');
  });

  it('parses priority', () => {
    expect(board.columns[0].tasks[0].priority).toBe('P0');
  });

  it('parses category', () => {
    expect(board.columns[0].tasks[0].category).toBe('Feature');
  });

  it('parses assigned', () => {
    expect(board.columns[0].tasks[0].assigned).toBe('@ocean');
  });

  it('parses tags', () => {
    expect(board.columns[0].tasks[0].tags).toEqual(['#frontend', '#ux']);
  });

  it('parses created date', () => {
    expect(board.columns[0].tasks[0].created).toBe('2026-01-01');
  });

  it('parses multi-line description', () => {
    expect(board.columns[0].tasks[0].description).toContain('spans multiple lines');
  });

  it('parses P1 priority correctly', () => {
    expect(board.columns[0].tasks[1].priority).toBe('P1');
  });

  it('parses P3 priority correctly', () => {
    const reviewCol = board.columns.find(c => c.title === '👀 Review');
    expect(reviewCol!.tasks[0].priority).toBe('P3');
  });
});

describe('parseTask', () => {
  it('returns null for non-task blocks', () => {
    expect(parseTask('just some text')).toBeNull();
    expect(parseTask('')).toBeNull();
  });

  it('parses minimal task', () => {
    const task = parseTask('### TASK-099 | Minimal task\n**Priority**: P2 | **Category**: Task | **Assigned**: @me');
    expect(task).not.toBeNull();
    expect(task!.id).toBe('TASK-099');
    expect(task!.title).toBe('Minimal task');
    expect(task!.tags).toEqual([]);
    expect(task!.description).toBe('');
  });
});

describe('Task Serialization', () => {
  it('round-trips a task', () => {
    const task: KanbanTask = {
      id: 'TASK-010',
      title: 'Test task',
      priority: 'P1',
      category: 'Bug',
      assigned: '@ocean',
      tags: ['#test', '#bug'],
      description: 'Fix the thing.',
      created: '2026-01-10',
    };
    const md = serializeTask(task);
    const parsed = parseTask(md);
    expect(parsed).not.toBeNull();
    expect(parsed!.id).toBe('TASK-010');
    expect(parsed!.title).toBe('Test task');
    expect(parsed!.priority).toBe('P1');
    expect(parsed!.tags).toEqual(['#test', '#bug']);
    expect(parsed!.description).toBe('Fix the thing.');
  });

  it('serializes task without description', () => {
    const task: KanbanTask = {
      id: 'TASK-011', title: 'No desc', priority: 'P3',
      category: 'Task', assigned: '@fran', tags: [], description: '', created: '2026-01-11',
    };
    const md = serializeTask(task);
    expect(md).not.toContain('\n\n');
  });
});

describe('Board Serialization', () => {
  it('serializes and re-parses board', () => {
    const board = parseKanbanMarkdown(SAMPLE_MARKDOWN);
    const md = serializeBoard(board);
    const reparsed = parseKanbanMarkdown(md);
    expect(reparsed.name).toBe('TestProject');
    expect(reparsed.lastTaskId).toBe(5);
    expect(reparsed.columns[0].tasks.length).toBe(2);
    expect(reparsed.columns[0].tasks[0].id).toBe('TASK-001');
  });
});

describe('Move Task', () => {
  it('moves task between columns', () => {
    const board = parseKanbanMarkdown(SAMPLE_MARKDOWN);
    const result = moveTask(board, 'TASK-001', '🔨 In Progress');
    expect(result).toBe(true);
    expect(board.columns[0].tasks.length).toBe(1); // Ideas now has 1
    const inProgress = board.columns.find(c => c.title === '🔨 In Progress');
    expect(inProgress!.tasks.length).toBe(2);
    expect(inProgress!.tasks[1].id).toBe('TASK-001');
  });

  it('returns false for non-existent task', () => {
    const board = parseKanbanMarkdown(SAMPLE_MARKDOWN);
    expect(moveTask(board, 'TASK-999', '📋 Backlog')).toBe(false);
  });

  it('returns false for non-existent target column', () => {
    const board = parseKanbanMarkdown(SAMPLE_MARKDOWN);
    expect(moveTask(board, 'TASK-001', 'Nonexistent')).toBe(false);
    // Task should still be in original column
    expect(board.columns[0].tasks.find(t => t.id === 'TASK-001')).toBeTruthy();
  });

  it('move + serialize produces correct markdown', () => {
    const board = parseKanbanMarkdown(SAMPLE_MARKDOWN);
    moveTask(board, 'TASK-003', '🔨 In Progress');
    const md = serializeBoard(board);
    const reparsed = parseKanbanMarkdown(md);
    const backlog = reparsed.columns.find(c => c.title === '📋 Backlog');
    const inProgress = reparsed.columns.find(c => c.title === '🔨 In Progress');
    expect(backlog!.tasks.length).toBe(0);
    expect(inProgress!.tasks.length).toBe(2);
  });
});

describe('Create Task', () => {
  it('creates task with incremented ID', () => {
    const board = parseKanbanMarkdown(SAMPLE_MARKDOWN);
    const task = createTask(board, '📋 Backlog', 'New feature', 'P1', 'Feature', '@ocean', ['#new']);
    expect(task).not.toBeNull();
    expect(task!.id).toBe('TASK-006');
    expect(board.lastTaskId).toBe(6);
    expect(board.columns[1].tasks.length).toBe(2);
  });

  it('creates second task with next ID', () => {
    const board = parseKanbanMarkdown(SAMPLE_MARKDOWN);
    createTask(board, '📋 Backlog', 'First');
    const second = createTask(board, '📋 Backlog', 'Second');
    expect(second!.id).toBe('TASK-007');
  });

  it('returns null for invalid column', () => {
    const board = parseKanbanMarkdown(SAMPLE_MARKDOWN);
    expect(createTask(board, 'Fake Column', 'Nope')).toBeNull();
  });

  it('sets created date to today', () => {
    const board = parseKanbanMarkdown(SAMPLE_MARKDOWN);
    const task = createTask(board, '💡 Ideas', 'Dated task');
    const today = new Date().toISOString().split('T')[0];
    expect(task!.created).toBe(today);
  });

  it('create + serialize round-trips', () => {
    const board = parseKanbanMarkdown(SAMPLE_MARKDOWN);
    createTask(board, '💡 Ideas', 'Round trip', 'P0', 'Test', '@test', ['#rt'], 'Description here');
    const md = serializeBoard(board);
    const reparsed = parseKanbanMarkdown(md);
    const ideas = reparsed.columns.find(c => c.title === '💡 Ideas');
    const task = ideas!.tasks.find(t => t.title === 'Round trip');
    expect(task).toBeTruthy();
    expect(task!.priority).toBe('P0');
    expect(task!.description).toBe('Description here');
  });
});

describe('Load Projects', () => {
  it('loads projects from JSON file', () => {
    const projects = loadProjects();
    expect(projects.length).toBeGreaterThan(0);
    const oceangram = projects.find(p => p.id === 'oceangram');
    expect(oceangram).toBeTruthy();
    expect(oceangram!.name).toBe('Oceangram');
    expect(oceangram!.file).toContain('oceangram.md');
  });
});

describe('Edge Cases', () => {
  it('handles empty markdown', () => {
    const board = parseKanbanMarkdown('');
    expect(board.columns.length).toBe(7); // All default columns
    expect(board.lastTaskId).toBe(0);
  });

  it('handles markdown with no tasks', () => {
    const md = `# Empty Kanban\n\n## 💡 Ideas\n\n## 📋 Backlog\n`;
    const board = parseKanbanMarkdown(md);
    expect(board.columns[0].tasks.length).toBe(0);
  });

  it('handles task with no tags line', () => {
    const block = `### TASK-050 | No tags task
**Priority**: P2 | **Category**: Feature | **Assigned**: @someone
**Created**: 2026-01-01

Just a description.`;
    const task = parseTask(block);
    expect(task!.tags).toEqual([]);
    expect(task!.description).toBe('Just a description.');
  });
});

describe('Priority Badge Rendering', () => {
  it('P0 maps to red', () => {
    const colors: Record<string, string> = { P0: '#ef4444', P1: '#f97316', P2: '#3b82f6', P3: '#6b7280' };
    expect(colors['P0']).toBe('#ef4444');
  });

  it('P1 maps to orange', () => {
    const colors: Record<string, string> = { P0: '#ef4444', P1: '#f97316', P2: '#3b82f6', P3: '#6b7280' };
    expect(colors['P1']).toBe('#f97316');
  });

  it('P2 maps to blue', () => {
    const colors: Record<string, string> = { P0: '#ef4444', P1: '#f97316', P2: '#3b82f6', P3: '#6b7280' };
    expect(colors['P2']).toBe('#3b82f6');
  });

  it('P3 maps to gray', () => {
    const colors: Record<string, string> = { P0: '#ef4444', P1: '#f97316', P2: '#3b82f6', P3: '#6b7280' };
    expect(colors['P3']).toBe('#6b7280');
  });
});
