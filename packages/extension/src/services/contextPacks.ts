import * as vscode from 'vscode';
import * as path from 'path';

export interface ContextFile {
  /** Unique identifier for this context file */
  id: string;
  /** File path relative to workspace root */
  path: string;
  /** Display name for the chip */
  name: string;
  /** Reason this file is relevant */
  reason: 'open-editor' | 'recent-change' | 'terminal-error' | 'dependency';
  /** File content (loaded when needed) */
  content?: string;
  /** Icon for the chip */
  icon: string;
  /** Priority for sorting (higher = more relevant) */
  priority: number;
}

export interface ContextPack {
  /** All suggested context files */
  files: ContextFile[];
  /** Timestamp when this pack was generated */
  timestamp: number;
}

/**
 * Service for detecting relevant context files to suggest for agent messages
 */
export class ContextPacksService {
  private disposables: vscode.Disposable[] = [];
  private listeners: ((pack: ContextPack) => void)[] = [];
  private lastPack: ContextPack | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private workspaceRoot: string | null = null;

  constructor() {
    // Get workspace root
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
      this.workspaceRoot = workspaceFolders[0].uri.fsPath;
    }

    this.setupEventListeners();
    // Generate initial pack
    this.schedulePackUpdate();
  }

  /**
   * Subscribe to context pack updates
   */
  onPackUpdate(listener: (pack: ContextPack) => void): vscode.Disposable {
    this.listeners.push(listener);
    // Send current pack if available
    if (this.lastPack) {
      listener(this.lastPack);
    }
    return {
      dispose: () => {
        const index = this.listeners.indexOf(listener);
        if (index > -1) {
          this.listeners.splice(index, 1);
        }
      }
    };
  }

  /**
   * Get the current context pack
   */
  getCurrentPack(): ContextPack | null {
    return this.lastPack;
  }

  /**
   * Load content for a specific context file
   */
  async loadFileContent(file: ContextFile): Promise<string> {
    if (file.content) {
      return file.content;
    }

    if (!this.workspaceRoot) {
      return '';
    }

    try {
      const fullPath = path.resolve(this.workspaceRoot, file.path);
      const uri = vscode.Uri.file(fullPath);
      const document = await vscode.workspace.openTextDocument(uri);
      file.content = document.getText();
      return file.content;
    } catch (error) {
      console.error(`Failed to load content for ${file.path}:`, error);
      return '';
    }
  }

  /**
   * Generate a new context pack based on current VS Code state
   */
  async generateContextPack(): Promise<ContextPack> {
    const files: ContextFile[] = [];
    
    // 1. Open editor files
    const openFiles = await this.getOpenEditorFiles();
    files.push(...openFiles);

    // 2. Recently changed files (git)
    const recentChanges = await this.getRecentlyChangedFiles();
    files.push(...recentChanges);

    // 3. Terminal errors
    const terminalErrors = await this.getTerminalErrorFiles();
    files.push(...terminalErrors);

    // 4. Active file dependencies
    const dependencies = await this.getActiveFileDependencies();
    files.push(...dependencies);

    // Deduplicate by path, keeping highest priority
    const deduped = this.deduplicateFiles(files);

    // Sort by priority (highest first), then by name
    deduped.sort((a, b) => {
      if (a.priority !== b.priority) {
        return b.priority - a.priority;
      }
      return a.name.localeCompare(b.name);
    });

    // Limit to top 10 most relevant files
    const limitedFiles = deduped.slice(0, 10);

    return {
      files: limitedFiles,
      timestamp: Date.now()
    };
  }

  /**
   * Setup event listeners for VS Code state changes
   */
  private setupEventListeners(): void {
    // Editor focus changes
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => {
        this.schedulePackUpdate();
      })
    );

    // Visible editors change
    this.disposables.push(
      vscode.window.onDidChangeVisibleTextEditors(() => {
        this.schedulePackUpdate();
      })
    );

    // Terminal updates
    this.disposables.push(
      vscode.window.onDidWriteTerminalData(event => {
        // Check if the terminal data contains error-like patterns
        if (this.hasErrorPatterns(event.data)) {
          this.schedulePackUpdate();
        }
      })
    );

    // File changes
    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument(() => {
        this.schedulePackUpdate();
      })
    );
  }

  /**
   * Schedule a context pack update with debouncing
   */
  private schedulePackUpdate(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(async () => {
      try {
        const newPack = await this.generateContextPack();
        this.lastPack = newPack;
        
        // Notify all listeners
        this.listeners.forEach(listener => {
          try {
            listener(newPack);
          } catch (error) {
            console.error('Error in context pack listener:', error);
          }
        });
      } catch (error) {
        console.error('Failed to generate context pack:', error);
      }
    }, 500); // 500ms debounce
  }

  /**
   * Get files from open editors
   */
  private async getOpenEditorFiles(): Promise<ContextFile[]> {
    if (!this.workspaceRoot) {
      return [];
    }

    const files: ContextFile[] = [];
    const visibleEditors = vscode.window.visibleTextEditors;

    for (const editor of visibleEditors) {
      const document = editor.document;
      
      // Skip untitled/non-file documents
      if (document.uri.scheme !== 'file') {
        continue;
      }

      const relativePath = path.relative(this.workspaceRoot, document.uri.fsPath);
      
      // Skip files outside workspace
      if (relativePath.startsWith('..')) {
        continue;
      }

      const fileName = path.basename(relativePath);
      const fileExt = path.extname(fileName).toLowerCase();

      files.push({
        id: `open-${relativePath}`,
        path: relativePath,
        name: fileName,
        reason: 'open-editor',
        icon: this.getFileIcon(fileExt),
        priority: editor === vscode.window.activeTextEditor ? 10 : 8,
        content: document.getText()
      });
    }

    return files;
  }

  /**
   * Get recently changed files from git
   */
  private async getRecentlyChangedFiles(): Promise<ContextFile[]> {
    if (!this.workspaceRoot) {
      return [];
    }

    try {
      const { exec } = require('child_process');
      const { promisify } = require('util');
      const execAsync = promisify(exec);

      // Get files changed in the last 3 commits
      const { stdout } = await execAsync('git diff --name-only HEAD~3', {
        cwd: this.workspaceRoot
      });

      const changedFiles = stdout.trim().split('\n').filter(Boolean);
      const files: ContextFile[] = [];

      for (const filePath of changedFiles.slice(0, 5)) { // Limit to 5 files
        const fileName = path.basename(filePath);
        const fileExt = path.extname(fileName).toLowerCase();

        files.push({
          id: `git-${filePath}`,
          path: filePath,
          name: fileName,
          reason: 'recent-change',
          icon: this.getFileIcon(fileExt),
          priority: 6
        });
      }

      return files;
    } catch (error) {
      // Git not available or not a git repo
      return [];
    }
  }

  /**
   * Get files related to terminal errors
   */
  private async getTerminalErrorFiles(): Promise<ContextFile[]> {
    // This is a simplified implementation since we can't easily access terminal history
    // In a full implementation, we might maintain a buffer of recent terminal output
    
    if (!this.workspaceRoot) {
      return [];
    }

    const files: ContextFile[] = [];
    
    // Look for common error log files
    const logFiles = [
      'package.json',
      'tsconfig.json',
      '.eslintrc.js',
      '.eslintrc.json',
      'vite.config.js',
      'vite.config.ts',
      'webpack.config.js'
    ];

    for (const logFile of logFiles) {
      try {
        const fullPath = path.resolve(this.workspaceRoot, logFile);
        const uri = vscode.Uri.file(fullPath);
        await vscode.workspace.fs.stat(uri);
        
        // File exists, add it as potential error context
        files.push({
          id: `error-${logFile}`,
          path: logFile,
          name: logFile,
          reason: 'terminal-error',
          icon: this.getFileIcon(path.extname(logFile)),
          priority: 4
        });
      } catch {
        // File doesn't exist, skip
      }
    }

    return files;
  }

  /**
   * Get dependencies of the currently active file
   */
  private async getActiveFileDependencies(): Promise<ContextFile[]> {
    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor || !this.workspaceRoot) {
      return [];
    }

    const document = activeEditor.document;
    const text = document.getText();
    const files: ContextFile[] = [];
    
    // Parse import statements for TypeScript/JavaScript files
    const fileExt = path.extname(document.uri.fsPath).toLowerCase();
    if (['.ts', '.js', '.tsx', '.jsx'].includes(fileExt)) {
      const importRegex = /import.*from\s+['"`]([^'"`]+)['"`]/g;
      let match;
      
      while ((match = importRegex.exec(text)) !== null) {
        let importPath = match[1];
        
        // Skip node_modules imports
        if (!importPath.startsWith('.')) {
          continue;
        }

        // Resolve relative import
        const currentDir = path.dirname(document.uri.fsPath);
        let resolvedPath = path.resolve(currentDir, importPath);
        
        // Try different extensions if file doesn't exist
        const extensions = ['.ts', '.tsx', '.js', '.jsx'];
        let foundPath: string | null = null;
        
        for (const ext of extensions) {
          const testPath = resolvedPath + ext;
          try {
            await vscode.workspace.fs.stat(vscode.Uri.file(testPath));
            foundPath = testPath;
            break;
          } catch {
            // File doesn't exist with this extension
          }
        }

        if (foundPath) {
          const relativePath = path.relative(this.workspaceRoot, foundPath);
          if (!relativePath.startsWith('..')) {
            const fileName = path.basename(relativePath);
            
            files.push({
              id: `dep-${relativePath}`,
              path: relativePath,
              name: fileName,
              reason: 'dependency',
              icon: this.getFileIcon(path.extname(fileName)),
              priority: 5
            });
          }
        }
      }
    }

    return files.slice(0, 3); // Limit to 3 dependencies
  }

  /**
   * Remove duplicate files, keeping the one with highest priority
   */
  private deduplicateFiles(files: ContextFile[]): ContextFile[] {
    const pathMap = new Map<string, ContextFile>();
    
    for (const file of files) {
      const existing = pathMap.get(file.path);
      if (!existing || file.priority > existing.priority) {
        pathMap.set(file.path, file);
      }
    }
    
    return Array.from(pathMap.values());
  }

  /**
   * Get icon for file based on extension
   */
  private getFileIcon(extension: string): string {
    const iconMap: { [key: string]: string } = {
      '.ts': '📄',
      '.tsx': '⚛️', 
      '.js': '📄',
      '.jsx': '⚛️',
      '.json': '🔧',
      '.md': '📝',
      '.css': '🎨',
      '.scss': '🎨',
      '.html': '🌐',
      '.py': '🐍',
      '.rs': '🦀',
      '.go': '🐹',
      '.java': '☕',
      '.cpp': '⚙️',
      '.c': '⚙️',
      '.h': '⚙️',
      '.yml': '🔧',
      '.yaml': '🔧',
      '.toml': '🔧',
      '.xml': '📄',
      '.sql': '🗃️'
    };

    return iconMap[extension.toLowerCase()] || '📁';
  }

  /**
   * Check if terminal data contains error patterns
   */
  private hasErrorPatterns(data: string): boolean {
    const errorPatterns = [
      /error:/i,
      /failed/i,
      /exception/i,
      /cannot find/i,
      /no such file/i,
      /permission denied/i,
      /compilation error/i,
      /syntax error/i,
      /type error/i,
      /reference error/i
    ];

    return errorPatterns.some(pattern => pattern.test(data));
  }

  /**
   * Dispose of all resources
   */
  dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    
    this.disposables.forEach(d => d.dispose());
    this.disposables = [];
    this.listeners = [];
  }
}