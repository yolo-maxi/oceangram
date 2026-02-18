import * as fs from 'fs';
import * as path from 'path';

const PROJECTS_JSON = '/home/xiko/kanban-app/data/projects.json';
const BRIEFS_DIR = '/home/xiko/clawd/memory/projects';

export interface ProjectBrief {
  slug: string;
  name: string;
  status: {
    phase: string;
    lastTouched: string;
    nextAction: string;
  };
  resources: {
    urls: { label: string; url: string }[];
    apiKeys: { label: string; masked: string; raw: string }[];
    localPaths: { label: string; path: string }[];
    pm2Processes: string[];
  };
  techStack: string[];
  keyDecisions: string[];
  history: { date: string; items: string[] }[];
  briefPath: string;
}

export interface ProjectListEntry {
  slug: string;
  name: string;
  hasBrief: boolean;
}

/**
 * Load the project list from kanban-app's projects.json
 */
export function loadProjectList(projectsJsonPath: string = PROJECTS_JSON): ProjectListEntry[] {
  const raw = fs.readFileSync(projectsJsonPath, 'utf-8');
  const data = JSON.parse(raw);
  const projects = data.projects || {};
  return Object.entries(projects).map(([slug, info]: [string, any]) => {
    const briefPath = path.join(BRIEFS_DIR, `${slug}.md`);
    return {
      slug,
      name: info.name || slug,
      hasBrief: fs.existsSync(briefPath),
    };
  });
}

/**
 * Parse a project brief markdown file into structured data
 */
export function parseBrief(markdown: string, slug: string, name: string): ProjectBrief {
  const briefPath = path.join(BRIEFS_DIR, `${slug}.md`);

  return {
    slug,
    name,
    status: parseStatus(markdown),
    resources: parseResources(markdown),
    techStack: parseTechStack(markdown),
    keyDecisions: parseKeyDecisions(markdown),
    history: parseHistory(markdown),
    briefPath,
  };
}

/**
 * Load and parse a single project's brief
 */
export function loadProjectBrief(slug: string, name: string, briefsDir: string = BRIEFS_DIR): ProjectBrief | null {
  const briefPath = path.join(briefsDir, `${slug}.md`);
  if (!fs.existsSync(briefPath)) { return null; }
  const markdown = fs.readFileSync(briefPath, 'utf-8');
  return parseBrief(markdown, slug, name);
}

// --- Section parsers ---

function getSection(markdown: string, heading: string): string {
  // Match ## heading (case-insensitive) and capture until next ## or end
  const regex = new RegExp(`^##\\s+${heading}\\s*$`, 'im');
  const match = regex.exec(markdown);
  if (!match) { return ''; }
  const start = match.index + match[0].length;
  const nextSection = markdown.indexOf('\n## ', start);
  return nextSection === -1 ? markdown.slice(start) : markdown.slice(start, nextSection);
}

function parseStatus(md: string): ProjectBrief['status'] {
  const section = getSection(md, 'Status');
  const phase = section.match(/\*\*Phase\*\*:\s*(.+)/i)?.[1]?.trim() || 'unknown';
  const lastTouched = section.match(/\*\*Last touched\*\*:\s*(.+)/i)?.[1]?.trim() || '';
  const nextAction = section.match(/\*\*Next action\*\*:\s*(.+)/i)?.[1]?.trim() || '';
  return { phase, lastTouched, nextAction };
}

function parseResources(md: string): ProjectBrief['resources'] {
  const section = getSection(md, 'Resources');
  const urls: ProjectBrief['resources']['urls'] = [];
  const apiKeys: ProjectBrief['resources']['apiKeys'] = [];
  const localPaths: ProjectBrief['resources']['localPaths'] = [];
  const pm2Processes: string[] = [];

  // Extract URLs: **Label**: url or - **Label**: url
  const urlRegex = /https?:\/\/[^\s)>]+/g;
  for (const line of section.split('\n')) {
    const urlMatch = line.match(urlRegex);
    if (urlMatch) {
      const label = line.match(/\*\*(.+?)\*\*/)?.[1] || line.match(/^-\s*(.+?):/)?.[1]?.trim() || 'Link';
      for (const url of urlMatch) {
        urls.push({ label, url });
      }
    }

    // Local paths: backtick-wrapped paths starting with / or ~/
    const pathMatch = line.match(/`((?:\/|~\/)[^`]+)`/);
    if (pathMatch) {
      const label = line.match(/\*\*(.+?)\*\*/)?.[1] || line.match(/^-\s*(.+?):/)?.[1]?.trim() || 'Path';
      localPaths.push({ label, path: pathMatch[1] });
    }

    // PM2 process names
    const pm2Match = line.match(/PM2(?:\s+process)?:\s*`([^`]+)`/i);
    if (pm2Match) {
      pm2Processes.push(pm2Match[1]);
    }
  }

  // API keys from the secrets/keys subsection
  const keySection = getSection(md, 'API Keys & Secrets') || '';
  const keySectionInResources = section.match(/###\s*API Keys/i) ? section : keySection;
  for (const line of (keySectionInResources || section).split('\n')) {
    const keyRef = line.match(/(?:key|token|secret)[\s:]*[`"]?([a-zA-Z0-9_-]{8,})[`"]?/i);
    if (keyRef) {
      const label = line.match(/\*\*(.+?)\*\*/)?.[1] || line.match(/^-\s*(.+?):/)?.[1]?.trim() || 'Key';
      const raw = keyRef[1];
      apiKeys.push({ label, masked: maskKey(raw), raw });
    }
  }

  return { urls, apiKeys, localPaths, pm2Processes };
}

/**
 * Mask an API key: show first 3 and last 4 chars
 */
export function maskKey(key: string): string {
  if (key.length <= 8) { return '••••••••'; }
  return `${key.slice(0, 3)}...${key.slice(-4)}`;
}

function parseTechStack(md: string): string[] {
  const section = getSection(md, 'Tech Stack');
  const items: string[] = [];
  for (const line of section.split('\n')) {
    // Match "- **Label**: value" or "- Label: value"
    const match = line.match(/^-\s*(?:\*\*(.+?)\*\*|(.+?)):\s*(.+)/);
    if (match) {
      const value = match[3];
      const techs = value.split(/[,+]/).map(t => t.trim().replace(/\(.*?\)/g, '').trim()).filter(Boolean);
      items.push(...techs);
    }
  }
  return items;
}

function parseKeyDecisions(md: string): string[] {
  const section = getSection(md, 'Key Decisions');
  const decisions: string[] = [];
  for (const line of section.split('\n')) {
    const match = line.match(/^-\s*\*\*(.+?)\*\*(?::\s*(.+))?/);
    if (match) {
      decisions.push(match[2] ? `${match[1]}: ${match[2]}` : match[1]);
    }
  }
  return decisions;
}

function parseHistory(md: string): ProjectBrief['history']  {
  const section = getSection(md, 'History');
  const entries: ProjectBrief['history'] = [];
  let currentDate = '';
  let currentItems: string[] = [];

  for (const line of section.split('\n')) {
    const dateMatch = line.match(/^###\s+(\d{4}-\d{2}-\d{2})/);
    if (dateMatch) {
      if (currentDate && currentItems.length) {
        entries.push({ date: currentDate, items: currentItems });
      }
      currentDate = dateMatch[1];
      currentItems = [];
    } else {
      const item = line.match(/^-\s+(.+)/);
      if (item && currentDate) {
        currentItems.push(item[1]);
      }
    }
  }
  if (currentDate && currentItems.length) {
    entries.push({ date: currentDate, items: currentItems });
  }

  return entries;
}
