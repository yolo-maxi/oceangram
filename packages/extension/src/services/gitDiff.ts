/**
 * Git diff detection and rendering service for inline diff previews
 * Detects when chat messages reference file modifications and generates diff previews
 */

import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import { promisify } from 'util';

const exec = promisify(cp.exec);

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  insertions: number;
  deletions: number;
  oldPath?: string; // for renames
}

export interface GitDiffResult {
  files: FileChange[];
  diff: string;
  commitHash?: string;
  staged: boolean;
}

export interface DiffDetectionResult {
  hasDiff: boolean;
  commitHashes: string[];
  filePaths: string[];
  keywords: string[];
}

/**
 * Service for detecting git diffs in chat messages and generating previews
 */
export class GitDiffService {
  private workspaceRoot: string;

  constructor() {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    this.workspaceRoot = workspaceFolder?.uri.fsPath || process.cwd();
  }

  /**
   * Detect if a message contains references to file modifications
   */
  detectDiffReferences(messageText: string): DiffDetectionResult {
    if (!messageText) {
      return { hasDiff: false, commitHashes: [], filePaths: [], keywords: [] };
    }

    const text = messageText.toLowerCase();
    const originalText = messageText;
    
    // Detect commit hashes (7+ hex chars)
    const commitHashRegex = /\b([0-9a-f]{7,40})\b/gi;
    const commitHashes = [...originalText.matchAll(commitHashRegex)]
      .map(match => match[1])
      .filter(hash => hash.length >= 7);

    // Detect file paths (various patterns)
    const filePathRegexes = [
      /([a-zA-Z0-9_\-\/\.]+\.[a-zA-Z0-9]+)/g, // file.ext
      /\b(src|lib|packages|components|services)\/[a-zA-Z0-9_\-\/.]+/g, // typical project paths
      /\b[a-zA-Z0-9_\-]+\.(ts|js|tsx|jsx|py|rb|go|rs|java|cpp|c|h)\b/g, // code files
    ];
    
    const filePaths = [];
    for (const regex of filePathRegexes) {
      const matches = [...originalText.matchAll(regex)];
      filePaths.push(...matches.map(match => match[0]));
    }

    // Detect modification keywords
    const modificationKeywords = [
      'changed', 'modified', 'updated', 'edited', 'committed', 'pushed',
      'added', 'created', 'deleted', 'removed', 'renamed', 'moved',
      'fixed', 'implemented', 'refactored', 'improved', 'optimized',
      'staged', 'unstaged', 'diff', 'patch'
    ];

    const detectedKeywords = modificationKeywords.filter(keyword => 
      text.includes(keyword)
    );

    const hasDiff = (
      commitHashes.length > 0 ||
      (filePaths.length > 0 && detectedKeywords.length > 0) ||
      detectedKeywords.length >= 2
    );

    return {
      hasDiff,
      commitHashes: [...new Set(commitHashes)],
      filePaths: [...new Set(filePaths)],
      keywords: detectedKeywords
    };
  }

  /**
   * Generate git diff for specific commit or staged changes
   */
  async generateDiff(commitHash?: string, filePaths?: string[]): Promise<GitDiffResult | null> {
    try {
      let command = 'git diff --stat --no-color';
      let diffCommand = 'git diff --no-color';
      let staged = false;

      if (commitHash) {
        // Show diff for specific commit
        command += ` ${commitHash}^..${commitHash}`;
        diffCommand += ` ${commitHash}^..${commitHash}`;
      } else {
        // Show staged changes, fallback to working directory changes
        try {
          const { stdout: stagedCheck } = await exec('git diff --staged --name-only', { cwd: this.workspaceRoot });
          if (stagedCheck.trim()) {
            command += ' --staged';
            diffCommand += ' --staged';
            staged = true;
          }
        } catch {
          // No staged changes, show working directory
        }
      }

      if (filePaths && filePaths.length > 0) {
        const validPaths = filePaths.filter(p => p && typeof p === 'string');
        if (validPaths.length > 0) {
          command += ' -- ' + validPaths.join(' ');
          diffCommand += ' -- ' + validPaths.join(' ');
        }
      }

      // Get file stats
      const { stdout: statOutput } = await exec(command, { cwd: this.workspaceRoot });
      
      // Get full diff
      const { stdout: diffOutput } = await exec(diffCommand, { cwd: this.workspaceRoot });

      if (!statOutput.trim() && !diffOutput.trim()) {
        return null; // No changes
      }

      // Parse file changes from stat output
      const files = this.parseGitStat(statOutput);

      return {
        files,
        diff: diffOutput,
        commitHash,
        staged
      };
    } catch (error) {
      console.warn('[GitDiff] Failed to generate diff:', error);
      return null;
    }
  }

  /**
   * Get the git status of current repository
   */
  async getGitStatus(): Promise<{ hasChanges: boolean; hasStagedChanges: boolean } | null> {
    try {
      const { stdout: statusOutput } = await exec('git status --porcelain', { cwd: this.workspaceRoot });
      const lines = statusOutput.trim().split('\n').filter(line => line.trim());
      
      const hasChanges = lines.length > 0;
      const hasStagedChanges = lines.some(line => {
        const staged = line.charAt(0);
        return staged !== ' ' && staged !== '?';
      });

      return { hasChanges, hasStagedChanges };
    } catch {
      return null; // Not a git repository or git not available
    }
  }

  /**
   * Check if a file path exists in the workspace
   */
  async isValidFilePath(filePath: string): Promise<boolean> {
    if (!filePath) return false;
    
    try {
      const fullPath = path.resolve(this.workspaceRoot, filePath);
      // Check if the path is within workspace and exists
      if (!fullPath.startsWith(this.workspaceRoot)) return false;
      
      const uri = vscode.Uri.file(fullPath);
      const stat = await vscode.workspace.fs.stat(uri);
      return stat.type === vscode.FileType.File;
    } catch {
      return false;
    }
  }

  /**
   * Parse git stat output to extract file changes
   */
  private parseGitStat(statOutput: string): FileChange[] {
    const files: FileChange[] = [];
    const lines = statOutput.trim().split('\n');

    for (const line of lines) {
      if (!line.trim() || line.includes('file') || line.includes('insertion') || line.includes('deletion')) {
        continue; // Skip summary lines
      }

      // Parse lines like: " path/to/file.ts | 5 ++---"
      const match = line.match(/^\s*(.+?)\s*\|\s*(\d+)\s*([+-]*)$/);
      if (match) {
        const [, filePath, changesStr, symbols] = match;
        const changes = parseInt(changesStr, 10);
        const insertions = (symbols.match(/\+/g) || []).length;
        const deletions = (symbols.match(/-/g) || []).length;

        files.push({
          path: filePath.trim(),
          status: 'modified', // Default status, could be enhanced
          insertions,
          deletions
        });
      }
    }

    return files;
  }

  /**
   * Open file in VS Code editor at specific line
   */
  async openFileInEditor(filePath: string, line?: number): Promise<void> {
    try {
      let fullPath = filePath;
      if (!path.isAbsolute(filePath)) {
        fullPath = path.resolve(this.workspaceRoot, filePath);
      }

      const uri = vscode.Uri.file(fullPath);
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, { preview: true });

      if (line && line > 0) {
        const pos = new vscode.Position(line - 1, 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(
          new vscode.Range(pos, pos),
          vscode.TextEditorRevealType.InCenter
        );
      }
    } catch (error) {
      console.warn('[GitDiff] Failed to open file:', error);
      vscode.window.showWarningMessage(`Could not open file: ${filePath}`);
    }
  }

  /**
   * Revert changes for a specific file
   */
  async revertFile(filePath: string, staged: boolean = false): Promise<boolean> {
    try {
      const command = staged ? 'git reset HEAD' : 'git checkout --';
      await exec(`${command} "${filePath}"`, { cwd: this.workspaceRoot });
      return true;
    } catch (error) {
      console.warn('[GitDiff] Failed to revert file:', error);
      vscode.window.showErrorMessage(`Failed to revert ${filePath}: ${error}`);
      return false;
    }
  }

  /**
   * Get the repository root path
   */
  getWorkspaceRoot(): string {
    return this.workspaceRoot;
  }

  /**
   * Check if current workspace is a git repository
   */
  async isGitRepository(): Promise<boolean> {
    try {
      await exec('git rev-parse --git-dir', { cwd: this.workspaceRoot });
      return true;
    } catch {
      return false;
    }
  }
}