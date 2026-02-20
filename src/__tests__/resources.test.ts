import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseBrief, maskKey, loadProjectList, readBriefRaw, saveBrief, ProjectBrief } from '../services/resources';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Mock fs for loadProjectList tests
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual };
});

const SAMPLE_BRIEF = `# Project: Rikai

> Telegram-based language reading assistant

## Status
- **Phase**: launched (soft launch, 3 students)
- **Last touched**: 2026-02-05
- **Next action**: Implement usage tracking/limits

## Resources

### Domains & URLs
- **Bot**: @rikai_reading_bot (Telegram)
- **Landing**: https://rikai.chat
- **API Docs**: https://api.rikai.chat/docs

### Accounts & Services
- **Vercel**: Landing page hosting

### API Keys & Secrets
- Venice API key: \`vn_sk_abc12345xyz9876\`
- Bot token: \`1234567890:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw\`

### Local Paths
- Main bot: \`/home/xiko/langbot/\`
- Admin bot: \`/home/xiko/rikai-admin-bot/\`
- PM2 process: \`langbot\`

## Tech Stack
- Backend: TypeScript + Grammy
- Database: PostgreSQL + Drizzle ORM
- AI: Venice API, OpenAI
- Hosting: VPS, Vercel

## Key Decisions
- **Not a language learning app**: Reading practice tool, not competing with Duolingo
- **Target**: Expats who need to read real content
- **Progressive disclosure**: Show help on demand

## History
### 2026-02-05
- Launch roadmap documented
- Product positioning clarified

### 2026-01-30
- Comprehensive product notes written
- Launch roadmap created

## Related
- Kanban: RIKAI-XXX tasks
`;

const EMPTY_BRIEF = `# Project: Empty

> Nothing here

## Status
- **Phase**: ideation
`;

const MINIMAL_BRIEF = '';

describe('Brief Parser — parseBrief', () => {
  let brief: ProjectBrief;

  beforeEach(() => {
    brief = parseBrief(SAMPLE_BRIEF, 'rikai', 'Rikai');
  });

  it('parses slug and name', () => {
    expect(brief.slug).toBe('rikai');
    expect(brief.name).toBe('Rikai');
  });

  it('parses status phase', () => {
    expect(brief.status.phase).toBe('launched (soft launch, 3 students)');
  });

  it('parses status last touched', () => {
    expect(brief.status.lastTouched).toBe('2026-02-05');
  });

  it('parses status next action', () => {
    expect(brief.status.nextAction).toBe('Implement usage tracking/limits');
  });

  it('extracts URLs from resources', () => {
    const urls = brief.resources.urls.map(u => u.url);
    expect(urls).toContain('https://rikai.chat');
    expect(urls).toContain('https://api.rikai.chat/docs');
  });

  it('extracts URL labels', () => {
    const landing = brief.resources.urls.find(u => u.url === 'https://rikai.chat');
    expect(landing?.label).toBe('Landing');
  });

  it('extracts local paths', () => {
    const paths = brief.resources.localPaths.map(p => p.path);
    expect(paths).toContain('/home/xiko/langbot/');
    expect(paths).toContain('/home/xiko/rikai-admin-bot/');
  });

  it('extracts PM2 process names', () => {
    expect(brief.resources.pm2Processes).toContain('langbot');
  });

  it('parses tech stack into individual items', () => {
    expect(brief.techStack).toContain('TypeScript');
    expect(brief.techStack).toContain('Grammy');
    expect(brief.techStack).toContain('PostgreSQL');
    expect(brief.techStack).toContain('Drizzle ORM');
  });

  it('parses key decisions', () => {
    expect(brief.keyDecisions.length).toBe(3);
    expect(brief.keyDecisions[0]).toContain('Not a language learning app');
  });

  it('parses history entries in order', () => {
    expect(brief.history.length).toBe(2);
    expect(brief.history[0].date).toBe('2026-02-05');
    expect(brief.history[1].date).toBe('2026-01-30');
  });

  it('parses history items within entries', () => {
    expect(brief.history[0].items).toContain('Launch roadmap documented');
    expect(brief.history[1].items.length).toBe(2);
  });

  it('sets briefPath correctly', () => {
    expect(brief.briefPath).toContain('rikai.md');
  });
});

describe('Brief Parser — edge cases', () => {
  it('handles empty markdown gracefully', () => {
    const brief = parseBrief(MINIMAL_BRIEF, 'empty', 'Empty');
    expect(brief.status.phase).toBe('unknown');
    expect(brief.resources.urls).toEqual([]);
    expect(brief.techStack).toEqual([]);
    expect(brief.keyDecisions).toEqual([]);
    expect(brief.history).toEqual([]);
  });

  it('handles brief with only status section', () => {
    const brief = parseBrief(EMPTY_BRIEF, 'empty', 'Empty');
    expect(brief.status.phase).toBe('ideation');
    expect(brief.status.lastTouched).toBe('');
    expect(brief.resources.urls).toEqual([]);
  });

  it('handles brief with no history entries', () => {
    const md = `## History\n<!-- nothing yet -->`;
    const brief = parseBrief(md, 'test', 'Test');
    expect(brief.history).toEqual([]);
  });
});

describe('maskKey', () => {
  it('masks long keys showing first 3 and last 4', () => {
    expect(maskKey('sk_live_abc123def456')).toBe('sk_...f456');
  });

  it('masks short keys completely', () => {
    expect(maskKey('abc')).toBe('••••••••');
    expect(maskKey('12345678')).toBe('••••••••');
  });

  it('masks 9-char key correctly', () => {
    expect(maskKey('123456789')).toBe('123...6789');
  });
});

describe('loadProjectList', () => {
  it('loads projects from a JSON file', () => {
    // Use the actual projects.json file
    const projects = loadProjectList('/home/xiko/kanban-app/data/projects.json');
    expect(projects.length).toBeGreaterThan(0);
    const oceangram = projects.find(p => p.slug === 'oceangram');
    expect(oceangram).toBeDefined();
    expect(oceangram!.name).toBe('Oceangram');
  });

  it('marks projects with existing briefs', () => {
    const projects = loadProjectList('/home/xiko/kanban-app/data/projects.json');
    const oceangram = projects.find(p => p.slug === 'oceangram');
    expect(oceangram!.hasBrief).toBe(true);
  });
});

describe('readBriefRaw / saveBrief roundtrip', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oceangram-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null for non-existent brief', () => {
    expect(readBriefRaw('nonexistent', tmpDir)).toBeNull();
  });

  it('roundtrips content through save and read', () => {
    const content = '# Test Brief\n\n## Status\n- **Phase**: dev\n';
    saveBrief('testproj', content, tmpDir);
    const read = readBriefRaw('testproj', tmpDir);
    expect(read).toBe(content);
  });

  it('overwrites existing content on save', () => {
    saveBrief('testproj', 'original', tmpDir);
    saveBrief('testproj', 'updated', tmpDir);
    expect(readBriefRaw('testproj', tmpDir)).toBe('updated');
  });

  it('preserves unicode and special chars', () => {
    const content = '# 🚀 Prøject\n\nCafé résumé naïve';
    saveBrief('unicode', content, tmpDir);
    expect(readBriefRaw('unicode', tmpDir)).toBe(content);
  });
});
