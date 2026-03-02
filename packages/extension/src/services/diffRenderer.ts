/**
 * Diff rendering utilities for inline git diff previews
 * Renders diffs with syntax highlighting and action buttons
 */

export interface DiffLine {
  type: 'add' | 'remove' | 'context' | 'header';
  content: string;
  lineNumber?: number;
  oldLineNumber?: number;
}

export interface DiffFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  oldPath?: string;
  lines: DiffLine[];
  insertions: number;
  deletions: number;
}

export interface RenderedDiff {
  html: string;
  files: DiffFile[];
  summary: string;
}

/**
 * Service for rendering git diffs as HTML with syntax highlighting
 */
export class DiffRenderer {

  /**
   * Parse unified diff format into structured data
   */
  parseDiff(diffContent: string): DiffFile[] {
    const files: DiffFile[] = [];
    const lines = diffContent.split('\\n');
    
    let currentFile: DiffFile | null = null;
    let oldLineNum = 0;
    let newLineNum = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // File header: diff --git a/path b/path
      if (line.startsWith('diff --git')) {
        if (currentFile) {
          files.push(currentFile);
        }
        
        const match = line.match(/diff --git a\\/(.+) b\\/(.+)/);
        if (match) {
          const [, oldPath, newPath] = match;
          currentFile = {
            path: newPath,
            oldPath: oldPath !== newPath ? oldPath : undefined,
            status: 'modified',
            lines: [],
            insertions: 0,
            deletions: 0
          };
        }
        continue;
      }

      // Skip index lines
      if (line.startsWith('index ') || line.startsWith('+++') || line.startsWith('---')) {
        continue;
      }

      // Hunk header: @@ -oldStart,oldCount +newStart,newCount @@
      if (line.startsWith('@@')) {
        const match = line.match(/@@ -(\\d+),?\\d* \\+(\\d+),?\\d* @@/);
        if (match && currentFile) {
          oldLineNum = parseInt(match[1], 10);
          newLineNum = parseInt(match[2], 10);
          
          currentFile.lines.push({
            type: 'header',
            content: line,
            lineNumber: newLineNum,
            oldLineNumber: oldLineNum
          });
        }
        continue;
      }

      if (!currentFile) continue;

      // Content lines
      if (line.startsWith('+')) {
        currentFile.lines.push({
          type: 'add',
          content: line.slice(1),
          lineNumber: newLineNum
        });
        currentFile.insertions++;
        newLineNum++;
      } else if (line.startsWith('-')) {
        currentFile.lines.push({
          type: 'remove',
          content: line.slice(1),
          oldLineNumber: oldLineNum
        });
        currentFile.deletions++;
        oldLineNum++;
      } else if (line.startsWith(' ') || line === '') {
        currentFile.lines.push({
          type: 'context',
          content: line.slice(1),
          lineNumber: newLineNum,
          oldLineNumber: oldLineNum
        });
        oldLineNum++;
        newLineNum++;
      }
    }

    if (currentFile) {
      files.push(currentFile);
    }

    return files;
  }

  /**
   * Render diff as HTML with collapsible files
   */
  renderDiff(diffContent: string, commitHash?: string, staged: boolean = false): RenderedDiff {
    const files = this.parseDiff(diffContent);
    
    if (files.length === 0) {
      return {
        html: '<div class="diff-preview-empty">No changes found</div>',
        files: [],
        summary: 'No changes'
      };
    }

    const totalInsertions = files.reduce((sum, f) => sum + f.insertions, 0);
    const totalDeletions = files.reduce((sum, f) => sum + f.deletions, 0);
    const summary = `${files.length} file${files.length > 1 ? 's' : ''}, +${totalInsertions} -${totalDeletions}`;

    let html = `<div class="diff-preview">
      <div class="diff-preview-header">
        <div class="diff-preview-title">
          <span class="diff-preview-icon">📊</span>
          <span class="diff-preview-summary">${this.escapeHtml(summary)}</span>
          ${commitHash ? `<span class="diff-preview-commit">${commitHash.slice(0, 7)}</span>` : ''}
          ${staged ? '<span class="diff-preview-staged">staged</span>' : ''}
        </div>
        <button class="diff-preview-toggle" onclick="toggleDiffPreview(this)" title="Toggle diff preview">
          <span class="chevron">▼</span>
        </button>
      </div>
      <div class="diff-preview-content">`;

    for (const file of files) {
      html += this.renderFile(file, staged);
    }

    html += '</div></div>';

    return {
      html,
      files,
      summary
    };
  }

  /**
   * Render a single file's diff
   */
  private renderFile(file: DiffFile, staged: boolean): string {
    const statusIcon = this.getStatusIcon(file.status);
    const statusClass = `diff-file-status-${file.status}`;
    
    let html = `<div class="diff-file">
      <div class="diff-file-header" onclick="toggleDiffFile(this)">
        <span class="diff-file-chevron">▼</span>
        <span class="diff-file-status ${statusClass}">${statusIcon}</span>
        <span class="diff-file-path">${this.escapeHtml(file.path)}</span>
        <span class="diff-file-stats">
          <span class="diff-additions">+${file.insertions}</span>
          <span class="diff-deletions">-${file.deletions}</span>
        </span>
        <div class="diff-file-actions">
          <button class="diff-action-btn" onclick="event.stopPropagation(); openDiffFile('${this.escapeHtml(file.path)}')" title="Open file">
            📂
          </button>`;
          
    if (!staged) {
      html += `<button class="diff-action-btn diff-action-revert" onclick="event.stopPropagation(); revertDiffFile('${this.escapeHtml(file.path)}')" title="Revert changes">
        ↶
      </button>`;
    }
    
    html += `</div>
      </div>
      <div class="diff-file-content">
        <div class="diff-lines">`;

    let lineNumber = 1;
    for (const diffLine of file.lines) {
      const lineClass = `diff-line diff-line-${diffLine.type}`;
      const lineNumberDisplay = diffLine.type === 'add' ? diffLine.lineNumber : 
                               diffLine.type === 'remove' ? diffLine.oldLineNumber : 
                               diffLine.lineNumber || lineNumber;

      html += `<div class="${lineClass}">
        <span class="diff-line-number">${lineNumberDisplay || ''}</span>
        <span class="diff-line-content">${this.escapeHtml(diffLine.content)}</span>
      </div>`;
      
      if (diffLine.type !== 'header') {
        lineNumber++;
      }
    }

    html += '</div></div></div>';
    return html;
  }

  /**
   * Get icon for file status
   */
  private getStatusIcon(status: string): string {
    switch (status) {
      case 'added': return '✅';
      case 'deleted': return '❌';
      case 'renamed': return '📝';
      case 'modified': 
      default: return '📝';
    }
  }

  /**
   * Escape HTML characters
   */
  private escapeHtml(text: string): string {
    if (!text) return '';
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Generate a compact diff summary for display
   */
  generateSummary(files: DiffFile[]): string {
    if (files.length === 0) return 'No changes';
    
    const totalInsertions = files.reduce((sum, f) => sum + f.insertions, 0);
    const totalDeletions = files.reduce((sum, f) => sum + f.deletions, 0);
    
    const fileCountText = files.length === 1 ? '1 file' : `${files.length} files`;
    const changesText = [];
    
    if (totalInsertions > 0) changesText.push(`+${totalInsertions}`);
    if (totalDeletions > 0) changesText.push(`-${totalDeletions}`);
    
    return `${fileCountText}${changesText.length > 0 ? ', ' + changesText.join(' ') : ''}`;
  }

  /**
   * Extract file paths from diff for quick access
   */
  extractFilePaths(files: DiffFile[]): string[] {
    return files.map(f => f.path);
  }

  /**
   * Check if diff contains significant changes (not just whitespace)
   */
  hasSignificantChanges(files: DiffFile[]): boolean {
    return files.some(file => 
      file.insertions > 0 || 
      file.deletions > 0 ||
      file.lines.some(line => 
        line.type !== 'context' && 
        line.content.trim().length > 0
      )
    );
  }

  /**
   * Format diff for text-only display (fallback)
   */
  renderPlainText(files: DiffFile[]): string {
    if (files.length === 0) return 'No changes';
    
    let text = `${files.length} file(s) changed:\\n`;
    
    for (const file of files) {
      text += `  ${file.path} (+${file.insertions} -${file.deletions})\\n`;
    }
    
    return text;
  }
}