/**
 * Simple markdown-to-HTML renderer for project briefs.
 * Handles: headers, lists, code blocks, inline code, links, bold, italic.
 * All output is XSS-safe via HTML escaping before any markdown processing.
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Process inline markdown: bold, italic, code, links */
function processInline(line: string): string {
  // Inline code first (protect from other processing)
  const codeSegments: string[] = [];
  line = line.replace(/`([^`]+)`/g, (_m, code) => {
    codeSegments.push(code);
    return `\x00CODE${codeSegments.length - 1}\x00`;
  });

  // Links: [text](url) — sanitize javascript: URIs
  line = line.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text, url) => {
    const cleanUrl = url.replace(/[\s\x00-\x1f]/g, '');
    if (/^javascript:/i.test(cleanUrl) || /^vbscript:/i.test(cleanUrl) || /^data:/i.test(cleanUrl)) {
      return text; // strip dangerous links, keep text
    }
    return `<a href="${url}">${text}</a>`;
  });

  // Bold+italic: ***text*** or ___text___
  line = line.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  line = line.replace(/___(.+?)___/g, '<strong><em>$1</em></strong>');

  // Bold: **text** or __text__
  line = line.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  line = line.replace(/__(.+?)__/g, '<strong>$1</strong>');

  // Italic: *text* or _text_ (but not inside words for _)
  line = line.replace(/\*(.+?)\*/g, '<em>$1</em>');
  line = line.replace(/(?<!\w)_(.+?)_(?!\w)/g, '<em>$1</em>');

  // Restore inline code
  line = line.replace(/\x00CODE(\d+)\x00/g, (_m, i) => `<code>${codeSegments[Number(i)]}</code>`);

  return line;
}

export function renderMarkdown(markdown: string): string {
  // Escape HTML first for XSS prevention
  const escaped = escapeHtml(markdown);
  const lines = escaped.split('\n');
  const output: string[] = [];
  let inCodeBlock = false;
  let codeBlockContent: string[] = [];
  let inList = false;

  function closeList() {
    if (inList) {
      output.push('</ul>');
      inList = false;
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Fenced code blocks (``` was escaped to empty since < > & are escaped, but ``` has no special HTML chars)
    if (line.match(/^```/)) {
      if (!inCodeBlock) {
        closeList();
        inCodeBlock = true;
        codeBlockContent = [];
      } else {
        output.push(`<pre><code>${codeBlockContent.join('\n')}</code></pre>`);
        inCodeBlock = false;
      }
      continue;
    }

    if (inCodeBlock) {
      codeBlockContent.push(line);
      continue;
    }

    // Empty line
    if (line.trim() === '') {
      closeList();
      continue;
    }

    // Headers
    const headerMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headerMatch) {
      closeList();
      const level = headerMatch[1].length;
      output.push(`<h${level}>${processInline(headerMatch[2])}</h${level}>`);
      continue;
    }

    // Unordered list items
    const listMatch = line.match(/^(\s*)[-*]\s+(.+)/);
    if (listMatch) {
      if (!inList) {
        output.push('<ul>');
        inList = true;
      }
      output.push(`<li>${processInline(listMatch[2])}</li>`);
      continue;
    }

    // Blockquote
    const bqMatch = line.match(/^&gt;\s?(.*)/);
    if (bqMatch) {
      closeList();
      output.push(`<blockquote>${processInline(bqMatch[1])}</blockquote>`);
      continue;
    }

    // Paragraph
    closeList();
    output.push(`<p>${processInline(line)}</p>`);
  }

  // Close unclosed code block
  if (inCodeBlock) {
    output.push(`<pre><code>${codeBlockContent.join('\n')}</code></pre>`);
  }
  closeList();

  return output.join('\n');
}
