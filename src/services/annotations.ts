/**
 * Inline editor annotations from agent messages.
 *
 * Parses agent messages for file+line references and renders them as
 * subtle inline decorations (🪸 summary) after the referenced line.
 * Hovering shows the full agent message context.
 */

import * as vscode from 'vscode';

// ---- Types ----

export interface FileAnnotation {
  /** Workspace-relative file path (e.g. "src/foo.ts") */
  filePath: string;
  /** 1-based line number */
  line: number;
  /** Short summary shown inline (truncated from the message) */
  summary: string;
  /** Full agent message for hover */
  fullMessage: string;
  /** Timestamp when the annotation was created */
  createdAt: number;
}

// ---- Regex patterns for extracting file:line references ----

const FILE_LINE_PATTERNS: RegExp[] = [
  // src/foo.ts:42 or ./src/foo.ts:42 or foo.ts:42
  /(?:^|[\s`"'(])(\/?(?:\.\/)?[\w./-]+\.[a-zA-Z]{1,10}):(\d+)/gm,
  // line 42 of foo.ts / line 42 of `foo.ts`
  /line\s+(\d+)\s+(?:of|in)\s+`?(\/?(?:\.\/)?[\w./-]+\.[a-zA-Z]{1,10})`?/gim,
  // in `foo.ts` at line 42 / in foo.ts at line 42
  /in\s+`?(\/?(?:\.\/)?[\w./-]+\.[a-zA-Z]{1,10})`?\s+(?:at\s+)?line\s+(\d+)/gim,
  // foo.ts, line 42 / `foo.ts`, line 42
  /`?(\/?(?:\.\/)?[\w./-]+\.[a-zA-Z]{1,10})`?,?\s+line\s+(\d+)/gim,
];

/**
 * Extract file+line references from an agent message.
 * Returns an array of { filePath, line } pairs.
 */
export function extractFileReferences(message: string): Array<{ filePath: string; line: number }> {
  const results: Array<{ filePath: string; line: number }> = [];
  const seen = new Set<string>();

  // Pattern 1: file:line
  {
    const re = /(?:^|[\s`"'(])(\/?(?:\.\/)?[\w./-]+\.[a-zA-Z]{1,10}):(\d+)/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(message)) !== null) {
      const filePath = m[1].replace(/^\.\//, '');
      const line = parseInt(m[2], 10);
      const key = `${filePath}:${line}`;
      if (!seen.has(key) && line > 0) {
        seen.add(key);
        results.push({ filePath, line });
      }
    }
  }

  // Pattern 2: line N of file
  {
    const re = /line\s+(\d+)\s+(?:of|in)\s+`?(\/?(?:\.\/)?[\w./-]+\.[a-zA-Z]{1,10})`?/gim;
    let m: RegExpExecArray | null;
    while ((m = re.exec(message)) !== null) {
      const line = parseInt(m[1], 10);
      const filePath = m[2].replace(/^\.\//, '');
      const key = `${filePath}:${line}`;
      if (!seen.has(key) && line > 0) {
        seen.add(key);
        results.push({ filePath, line });
      }
    }
  }

  // Pattern 3: in file at line N
  {
    const re = /in\s+`?(\/?(?:\.\/)?[\w./-]+\.[a-zA-Z]{1,10})`?\s+(?:at\s+)?line\s+(\d+)/gim;
    let m: RegExpExecArray | null;
    while ((m = re.exec(message)) !== null) {
      const filePath = m[1].replace(/^\.\//, '');
      const line = parseInt(m[2], 10);
      const key = `${filePath}:${line}`;
      if (!seen.has(key) && line > 0) {
        seen.add(key);
        results.push({ filePath, line });
      }
    }
  }

  // Pattern 4: file, line N
  {
    const re = /`?(\/?(?:\.\/)?[\w./-]+\.[a-zA-Z]{1,10})`?,?\s+line\s+(\d+)/gim;
    let m: RegExpExecArray | null;
    while ((m = re.exec(message)) !== null) {
      const filePath = m[1].replace(/^\.\//, '');
      const line = parseInt(m[2], 10);
      const key = `${filePath}:${line}`;
      if (!seen.has(key) && line > 0) {
        seen.add(key);
        results.push({ filePath, line });
      }
    }
  }

  return results;
}

/**
 * Extract a short summary from the message context around the file reference.
 * Tries to grab a meaningful sentence fragment near the reference.
 */
function extractSummary(message: string, filePath: string, line: number): string {
  // Find the reference in the message and grab surrounding context
  const patterns = [
    new RegExp(`${escapeRegex(filePath)}:${line}[^\\n]*`, 'i'),
    new RegExp(`line\\s+${line}\\s+(?:of|in)\\s+\`?${escapeRegex(filePath)}\`?[^\\n]*`, 'i'),
    new RegExp(`in\\s+\`?${escapeRegex(filePath)}\`?\\s+(?:at\\s+)?line\\s+${line}[^\\n]*`, 'i'),
    new RegExp(`\`?${escapeRegex(filePath)}\`?,?\\s+line\\s+${line}[^\\n]*`, 'i'),
  ];

  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (match) {
      // Get the full line containing the match
      const idx = message.indexOf(match[0]);
      const lineStart = message.lastIndexOf('\n', idx) + 1;
      const lineEnd = message.indexOf('\n', idx + match[0].length);
      let contextLine = message.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim();

      // Remove the file:line reference itself to get the comment
      contextLine = contextLine
        .replace(/^[-*•]\s*/, '')  // strip list markers
        .replace(/`?[\w./-]+\.[a-zA-Z]{1,10}`?[,:]\s*(?:line\s+)?\d+[,:—\-–]?\s*/i, '')
        .replace(/(?:in|at)\s+`?[\w./-]+\.[a-zA-Z]{1,10}`?\s+(?:at\s+)?line\s+\d+[,:—\-–]?\s*/i, '')
        .replace(/line\s+\d+\s+(?:of|in)\s+`?[\w./-]+\.[a-zA-Z]{1,10}`?[,:—\-–]?\s*/i, '')
        .trim();

      if (contextLine.length > 0) {
        // Truncate to reasonable length
        if (contextLine.length > 80) {
          contextLine = contextLine.slice(0, 77) + '…';
        }
        return contextLine;
      }
    }
  }

  // Fallback: first non-empty line of the message
  const firstLine = message.split('\n').find(l => l.trim().length > 0)?.trim() || 'Agent annotation';
  return firstLine.length > 80 ? firstLine.slice(0, 77) + '…' : firstLine;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---- AnnotationManager ----

export class AnnotationManager implements vscode.Disposable {
  /** All annotations keyed by workspace-relative file path */
  private annotations = new Map<string, FileAnnotation[]>();
  /** Decoration type for inline annotations */
  private decorationType: vscode.TextEditorDecorationType;
  /** Whether annotations are visible */
  private visible = true;
  /** Disposables */
  private disposables: vscode.Disposable[] = [];

  constructor() {
    // Create the decoration type — subtle inline text after the line
    this.decorationType = vscode.window.createTextEditorDecorationType({
      after: {
        color: '#8774e1',
        fontStyle: 'italic',
        margin: '0 0 0 2em',
      },
      backgroundColor: 'rgba(135, 116, 225, 0.06)',
      isWholeLine: true,
    });

    // Re-apply decorations when active editor changes
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(editor => {
        if (editor) {
          this.applyDecorations(editor);
        }
      })
    );

    // Re-apply when visible editors change (e.g. split view)
    this.disposables.push(
      vscode.window.onDidChangeVisibleTextEditors(editors => {
        for (const editor of editors) {
          this.applyDecorations(editor);
        }
      })
    );

    // Register hover provider for all files to show full message on hover
    this.disposables.push(
      vscode.languages.registerHoverProvider({ scheme: '*', language: '*' }, {
        provideHover: (document, position) => {
          return this.provideHover(document, position);
        },
      })
    );
  }

  /**
   * Process an agent message — extract file references and create annotations.
   */
  processMessage(message: string): FileAnnotation[] {
    const refs = extractFileReferences(message);
    const created: FileAnnotation[] = [];

    for (const ref of refs) {
      const summary = extractSummary(message, ref.filePath, ref.line);
      const annotation: FileAnnotation = {
        filePath: ref.filePath,
        line: ref.line,
        summary,
        fullMessage: message,
        createdAt: Date.now(),
      };

      const existing = this.annotations.get(ref.filePath) || [];
      // Remove any existing annotation on the same line
      const filtered = existing.filter(a => a.line !== ref.line);
      filtered.push(annotation);
      this.annotations.set(ref.filePath, filtered);
      created.push(annotation);
    }

    // Refresh decorations on all visible editors
    if (created.length > 0) {
      this.refreshVisibleEditors();
    }

    return created;
  }

  /**
   * Clear all annotations.
   */
  clearAll(): void {
    this.annotations.clear();
    this.refreshVisibleEditors();
  }

  /**
   * Toggle annotations visibility.
   */
  toggle(): boolean {
    this.visible = !this.visible;
    this.refreshVisibleEditors();
    return this.visible;
  }

  /**
   * Get annotation count.
   */
  get count(): number {
    let total = 0;
    for (const anns of this.annotations.values()) {
      total += anns.length;
    }
    return total;
  }

  /**
   * Apply decorations to a specific editor.
   */
  private applyDecorations(editor: vscode.TextEditor): void {
    if (!this.visible) {
      editor.setDecorations(this.decorationType, []);
      return;
    }

    const relativePath = vscode.workspace.asRelativePath(editor.document.uri);
    const fileAnnotations = this.findAnnotationsForFile(relativePath, editor.document.uri);

    if (!fileAnnotations || fileAnnotations.length === 0) {
      editor.setDecorations(this.decorationType, []);
      return;
    }

    const decorations: vscode.DecorationOptions[] = [];
    for (const ann of fileAnnotations) {
      const lineIdx = ann.line - 1; // 0-based
      if (lineIdx < 0 || lineIdx >= editor.document.lineCount) {
        continue;
      }

      const line = editor.document.lineAt(lineIdx);
      decorations.push({
        range: line.range,
        renderOptions: {
          after: {
            contentText: `  🪸 ${ann.summary}`,
          },
        },
        hoverMessage: this.createHoverMarkdown(ann),
      });
    }

    editor.setDecorations(this.decorationType, decorations);
  }

  /**
   * Find annotations matching a file, trying multiple path strategies.
   */
  private findAnnotationsForFile(relativePath: string, uri: vscode.Uri): FileAnnotation[] | undefined {
    // Direct match
    if (this.annotations.has(relativePath)) {
      return this.annotations.get(relativePath);
    }

    // Try matching by filename suffix — the agent might reference
    // "src/foo.ts" but the workspace relative path is "packages/app/src/foo.ts"
    for (const [key, anns] of this.annotations) {
      if (relativePath.endsWith(key) || key.endsWith(relativePath)) {
        return anns;
      }
      // Also try matching just the filename
      const keyBasename = key.split('/').pop();
      const relBasename = relativePath.split('/').pop();
      if (keyBasename && relBasename && keyBasename === relBasename) {
        // Fuzzy match — only if there's exactly one file with this name annotated
        const allWithSameName = [...this.annotations.keys()].filter(
          k => k.split('/').pop() === keyBasename
        );
        if (allWithSameName.length === 1) {
          return anns;
        }
      }
    }

    return undefined;
  }

  /**
   * Create hover markdown content for an annotation.
   */
  private createHoverMarkdown(ann: FileAnnotation): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.supportThemeIcons = true;

    const timestamp = new Date(ann.createdAt).toLocaleTimeString();
    md.appendMarkdown(`**🪸 Ocean Agent** — _${timestamp}_\n\n`);
    md.appendMarkdown('---\n\n');

    // Show the full message, truncated if very long
    let fullMsg = ann.fullMessage;
    if (fullMsg.length > 1000) {
      fullMsg = fullMsg.slice(0, 997) + '…';
    }
    md.appendMarkdown(fullMsg);

    return md;
  }

  /**
   * Provide hover content when hovering over annotated lines.
   */
  private provideHover(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.Hover | undefined {
    const relativePath = vscode.workspace.asRelativePath(document.uri);
    const fileAnnotations = this.findAnnotationsForFile(relativePath, document.uri);

    if (!fileAnnotations) {
      return undefined;
    }

    const lineNum = position.line + 1; // 1-based
    const annotation = fileAnnotations.find(a => a.line === lineNum);
    if (!annotation) {
      return undefined;
    }

    return new vscode.Hover(
      this.createHoverMarkdown(annotation),
      document.lineAt(position.line).range
    );
  }

  /**
   * Refresh decorations on all currently visible text editors.
   */
  private refreshVisibleEditors(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      this.applyDecorations(editor);
    }
  }

  dispose(): void {
    this.decorationType.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.annotations.clear();
  }
}
