import * as vscode from 'vscode';
import { readRemoteFile, readRemoteDir, remoteFileExists, watchRemoteFile } from './services/remoteFs';
import * as path from 'path';

export interface ToolCall {
  id: string;
  messageId: string;
  timestamp: number;
  toolName: string;
  inputSummary: string;
  outputStatus: 'success' | 'error' | 'warning' | 'unknown';
  outputSummary: string;
  duration?: number;
  fullInput?: any;
  fullOutput?: any;
  parentId?: string;
}

export interface SessionInfo {
  id: string;
  path: string;
  label: string;
  lastModified: number;
  size: number;
}

export class ActionTimelinePanel {
  private static current: ActionTimelinePanel | undefined;
  private panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private sessions: SessionInfo[] = [];
  private currentSession: SessionInfo | undefined;
  private toolCalls: ToolCall[] = [];
  private fileWatcher: vscode.FileSystemWatcher | undefined;
  private currentFilter: string | null = null;

  static createOrShow(context: vscode.ExtensionContext) {
    if (ActionTimelinePanel.current) {
      ActionTimelinePanel.current.panel.reveal(vscode.ViewColumn.One);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'oceangram.actionTimeline', 
      '⏱️ Action Timeline', 
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    ActionTimelinePanel.current = new ActionTimelinePanel(panel, context);
  }

  private constructor(panel: vscode.WebviewPanel, private context: vscode.ExtensionContext) {
    this.panel = panel;
    this.panel.webview.html = this.getHtml();

    this.panel.onDidDispose(() => {
      ActionTimelinePanel.current = undefined;
      this.stopWatching();
      this.disposables.forEach(d => d.dispose());
    }, null, this.disposables);

    this.panel.webview.onDidReceiveMessage(async (msg) => {
      try {
        switch (msg.type) {
          case 'init':
            await this.loadSessions();
            break;

          case 'selectSession':
            await this.selectSession(msg.sessionId);
            break;

          case 'filterByTool':
            this.currentFilter = msg.toolName === 'all' ? null : msg.toolName;
            this.sendToolCalls();
            break;

          case 'expandToolCall':
            const toolCall = this.toolCalls.find(tc => tc.id === msg.id);
            if (toolCall) {
              this.panel.webview.postMessage({
                type: 'toolCallDetails',
                toolCall: {
                  ...toolCall,
                  fullInput: toolCall.fullInput,
                  fullOutput: toolCall.fullOutput
                }
              });
            }
            break;

          case 'seekToTime':
            // Filter tool calls to those before/at the specified time
            const seekTime = msg.timestamp;
            const filteredCalls = this.toolCalls.filter(tc => tc.timestamp <= seekTime);
            this.panel.webview.postMessage({
              type: 'seekResults',
              toolCalls: filteredCalls,
              timestamp: seekTime
            });
            break;
        }
      } catch (e: any) {
        this.panel.webview.postMessage({ type: 'error', message: e.message });
      }
    }, null, this.disposables);
  }

  private async loadSessions() {
    try {
      const openclawConfig = vscode.workspace.getConfiguration('oceangram');
      const openclawDir = openclawConfig.get<string>('openclawConfigPath') || '/home/xiko/.openclaw';
      const sessionsDir = path.join(openclawDir, 'agents', 'main', 'sessions');

      if (!(await remoteFileExists(sessionsDir))) {
        this.panel.webview.postMessage({ 
          type: 'error', 
          message: 'Sessions directory not found. Check openclawConfigPath setting.' 
        });
        return;
      }

      const entries = await readRemoteDir(sessionsDir);
      this.sessions = [];

      for (const [fileName, fileType] of entries) {
        if (fileType === vscode.FileType.File && fileName.endsWith('.jsonl')) {
          const sessionId = fileName.replace('.jsonl', '');
          const filePath = path.join(sessionsDir, fileName);
          
          try {
            const stats = await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
            this.sessions.push({
              id: sessionId,
              path: filePath,
              label: this.formatSessionLabel(sessionId),
              lastModified: stats.mtime,
              size: stats.size
            });
          } catch {
            // Skip files we can't stat
          }
        }
      }

      // Sort by last modified descending
      this.sessions.sort((a, b) => b.lastModified - a.lastModified);

      this.panel.webview.postMessage({
        type: 'sessions',
        sessions: this.sessions.map(s => ({
          id: s.id,
          label: s.label,
          lastModified: s.lastModified,
          size: s.size
        }))
      });

      // Auto-select the most recent session if available
      if (this.sessions.length > 0) {
        await this.selectSession(this.sessions[0].id);
      }

    } catch (error: any) {
      this.panel.webview.postMessage({ type: 'error', message: `Failed to load sessions: ${error.message}` });
    }
  }

  private formatSessionLabel(sessionId: string): string {
    // Try to create a human-readable label from the session ID
    // This is a simplified version - could be enhanced with session metadata
    if (sessionId.length > 20) {
      return `${sessionId.slice(0, 8)}...${sessionId.slice(-8)}`;
    }
    return sessionId;
  }

  private async selectSession(sessionId: string) {
    this.currentSession = this.sessions.find(s => s.id === sessionId);
    if (!this.currentSession) {
      this.panel.webview.postMessage({ type: 'error', message: 'Session not found' });
      return;
    }

    this.stopWatching();
    
    try {
      await this.parseSessionToolCalls(this.currentSession.path);
      this.sendToolCalls();
      this.startWatching(this.currentSession.path);
    } catch (error: any) {
      this.panel.webview.postMessage({ type: 'error', message: `Failed to parse session: ${error.message}` });
    }
  }

  private async parseSessionToolCalls(sessionPath: string) {
    const content = await readRemoteFile(sessionPath);
    const lines = content.split('\n').filter(line => line.trim());
    
    this.toolCalls = [];
    const messageMap = new Map<string, any>();
    const toolCallMap = new Map<string, any>();

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        
        if (entry.type === 'message') {
          messageMap.set(entry.id, entry);
          
          // Check for assistant messages with tool calls
          if (entry.message?.role === 'assistant' && entry.message?.content) {
            const content = entry.message.content;
            
            for (const item of content) {
              if (item.type === 'toolCall') {
                const toolCall: ToolCall = {
                  id: item.id || entry.id,
                  messageId: entry.id,
                  timestamp: new Date(entry.timestamp).getTime(),
                  toolName: item.name || 'unknown',
                  inputSummary: this.summarizeInput(item.arguments),
                  outputStatus: 'unknown',
                  outputSummary: 'Waiting for result...',
                  parentId: entry.parentId,
                  fullInput: item.arguments
                };

                toolCallMap.set(item.id, toolCall);
                this.toolCalls.push(toolCall);
              }
            }
          }
          
          // Check for tool result messages
          if (entry.message?.role === 'toolResult') {
            const toolCallId = entry.message.toolCallId;
            const toolCall = toolCallMap.get(toolCallId);
            
            if (toolCall) {
              const resultContent = entry.message.content?.[0];
              const isError = entry.message.isError || false;
              
              toolCall.outputStatus = isError ? 'error' : 'success';
              toolCall.outputSummary = this.summarizeOutput(resultContent, isError);
              toolCall.fullOutput = entry.message.content;
              
              // Calculate duration if we have both timestamps
              const resultTimestamp = new Date(entry.timestamp).getTime();
              if (toolCall.timestamp) {
                toolCall.duration = resultTimestamp - toolCall.timestamp;
              }
            }
          }
        }
      } catch {
        // Skip malformed JSON lines
      }
    }

    // Sort by timestamp
    this.toolCalls.sort((a, b) => a.timestamp - b.timestamp);
  }

  private summarizeInput(args: any): string {
    if (!args) return 'No arguments';
    
    const argsCopy = { ...args };
    
    // Handle common tool patterns
    if (argsCopy.command) {
      return `cmd: ${String(argsCopy.command).slice(0, 50)}${String(argsCopy.command).length > 50 ? '...' : ''}`;
    }
    if (argsCopy.file_path || argsCopy.path) {
      const filePath = argsCopy.file_path || argsCopy.path;
      return `file: ${path.basename(filePath)}`;
    }
    if (argsCopy.url) {
      return `url: ${argsCopy.url}`;
    }
    if (argsCopy.query) {
      return `query: ${String(argsCopy.query).slice(0, 40)}...`;
    }
    
    // Generic fallback
    const str = JSON.stringify(argsCopy);
    return str.length > 60 ? `${str.slice(0, 57)}...` : str;
  }

  private summarizeOutput(content: any, isError: boolean): string {
    if (!content) return isError ? 'Error occurred' : 'No output';
    
    if (typeof content === 'string') {
      return content.slice(0, 80) + (content.length > 80 ? '...' : '');
    }
    
    if (content.type === 'text' && content.text) {
      const text = content.text;
      return text.slice(0, 80) + (text.length > 80 ? '...' : '');
    }
    
    if (isError) {
      return content.error || content.message || 'Error occurred';
    }
    
    return JSON.stringify(content).slice(0, 80) + '...';
  }

  private sendToolCalls() {
    const filteredCalls = this.currentFilter 
      ? this.toolCalls.filter(tc => tc.toolName === this.currentFilter)
      : this.toolCalls;

    // Get unique tool names for filter dropdown
    const toolNames = [...new Set(this.toolCalls.map(tc => tc.toolName))].sort();

    this.panel.webview.postMessage({
      type: 'toolCalls',
      toolCalls: filteredCalls,
      toolNames: toolNames,
      currentFilter: this.currentFilter,
      sessionInfo: this.currentSession ? {
        id: this.currentSession.id,
        label: this.currentSession.label,
        totalCalls: this.toolCalls.length
      } : null
    });
  }

  private startWatching(filePath: string) {
    try {
      this.fileWatcher = watchRemoteFile(filePath);
      this.fileWatcher.onDidChange(async () => {
        // Debounce file changes
        setTimeout(async () => {
          try {
            await this.parseSessionToolCalls(filePath);
            this.sendToolCalls();
          } catch {
            // Ignore parse errors during file updates
          }
        }, 500);
      });
    } catch {
      // Watch not supported - silent fail
    }
  }

  private stopWatching() {
    if (this.fileWatcher) {
      this.fileWatcher.dispose();
      this.fileWatcher = undefined;
    }
  }

  private getHtml(): string {
    const cssUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'actionTimeline.css')
    );
    const jsUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'actionTimeline.js')
    );
    
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Action Timeline</title>
    <link rel="stylesheet" href="${cssUri}">
</head>
<body>
    <div class="toolbar">
        <select id="sessionSelect" title="Select a session">
            <option value="">Loading sessions...</option>
        </select>
        <select id="toolFilter" title="Filter by tool type">
            <option value="all">All tools</option>
        </select>
        <div class="session-info" id="sessionInfo"></div>
    </div>

    <div class="timeline-container" id="timelineContainer">
        <div class="loading">Loading timeline...</div>
    </div>

    <!-- Tool call detail modal -->
    <div class="modal-overlay" id="modalOverlay">
        <div class="modal-content" id="modalContent">
            <div class="modal-header">
                <h3 id="modalTitle">Tool Call Details</h3>
                <button class="modal-close" id="modalClose">&times;</button>
            </div>
            <div class="modal-body" id="modalBody">
                <!-- Content will be populated by JS -->
            </div>
        </div>
    </div>

    <script src="${jsUri}"></script>
</body>
</html>`;
  }
}