import { createHighlighter, type Highlighter, type BundledLanguage } from 'shiki';

let highlighterInstance: Highlighter | undefined;
let highlighterPromise: Promise<Highlighter> | undefined;

// Languages to preload — covers most common use cases
const PRELOADED_LANGUAGES: BundledLanguage[] = [
  'javascript', 'typescript', 'python', 'json', 'html', 'css',
  'bash', 'shell', 'markdown', 'yaml', 'toml', 'sql', 'rust',
  'go', 'java', 'c', 'cpp', 'ruby', 'php', 'swift', 'kotlin',
  'dockerfile', 'graphql', 'xml', 'diff',
];

// VS Code dark theme that respects editor colors
const THEME = 'dark-plus';

/**
 * Get or create the shared Shiki highlighter instance.
 */
export async function getHighlighter(): Promise<Highlighter> {
  if (highlighterInstance) { return highlighterInstance; }
  if (highlighterPromise) { return highlighterPromise; }

  highlighterPromise = createHighlighter({
    themes: [THEME, 'light-plus'],
    langs: PRELOADED_LANGUAGES,
  });

  highlighterInstance = await highlighterPromise;
  return highlighterInstance;
}

/**
 * Highlight a code string. Returns HTML with inline styles.
 * Falls back to plain escaped text if language is unknown.
 */
export async function highlightCode(code: string, language?: string): Promise<string> {
  try {
    const hl = await getHighlighter();
    const lang = language?.toLowerCase() || 'text';

    // Check if language is loaded
    const loadedLangs = hl.getLoadedLanguages();
    if (lang !== 'text' && !loadedLangs.includes(lang as BundledLanguage)) {
      // Try to load it dynamically
      try {
        await hl.loadLanguage(lang as BundledLanguage);
      } catch {
        // Unknown language — render as plain text
        return escapeHtml(code);
      }
    }

    const html = hl.codeToHtml(code, {
      lang: lang === 'text' ? 'text' : lang,
      theme: THEME,
    });

    // shiki wraps in <pre><code>...</code></pre> — extract just the inner content
    // We'll use the full output since we need the styles
    return html;
  } catch {
    return `<pre><code>${escapeHtml(code)}</code></pre>`;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Process message entities and pre-highlight code blocks.
 * Returns a map of code block index → highlighted HTML.
 */
export async function highlightMessageCodeBlocks(
  text: string,
  entities?: Array<{ type: string; offset: number; length: number; language?: string }>
): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  if (!entities) { return result; }

  const codeEntities = entities
    .map((e, i) => ({ ...e, index: i }))
    .filter(e => e.type === 'pre');

  if (codeEntities.length === 0) { return result; }

  // Pre-warm highlighter
  await getHighlighter();

  await Promise.all(codeEntities.map(async (e) => {
    const chars = Array.from(text);
    const code = chars.slice(e.offset, e.offset + e.length).join('');
    const html = await highlightCode(code, e.language);
    result.set(e.index, html);
  }));

  return result;
}

/**
 * Dispose the highlighter when extension deactivates.
 */
export function disposeHighlighter(): void {
  if (highlighterInstance) {
    highlighterInstance.dispose();
    highlighterInstance = undefined;
    highlighterPromise = undefined;
  }
}
