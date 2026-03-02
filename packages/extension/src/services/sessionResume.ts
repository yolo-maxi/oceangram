import * as vscode from 'vscode';

export interface ResumeItem {
  type: 'message' | 'agent_action' | 'status_change' | 'error';
  content: string;
  timestamp: number;
  chatId?: string;
  chatName?: string;
  priority: 'low' | 'normal' | 'high';
}

export interface ResumeData {
  messageCount: number;
  keyEvents: ResumeItem[];
  errors: ResumeItem[];
  lastResumeTimestamp: number;
}

/**
 * Service for managing session resume summaries.
 * Tracks user interactions and generates "what changed while you were away" summaries.
 */
export class SessionResumeService {
  private static readonly STORAGE_KEY = 'oceangram.sessionResume';
  private static readonly MIN_AWAY_TIME = 30 * 60 * 1000; // 30 minutes in milliseconds

  constructor(private context: vscode.ExtensionContext) {}

  /**
   * Record that the user interacted with a specific chat
   */
  async recordInteraction(chatId: string): Promise<void> {
    const now = Date.now();
    const interactions = this.context.globalState.get<Record<string, number>>('oceangram.lastInteractions', {});
    interactions[chatId] = now;
    await this.context.globalState.update('oceangram.lastInteractions', interactions);
  }

  /**
   * Get the last interaction timestamp for a chat
   */
  getLastInteraction(chatId: string): number {
    const interactions = this.context.globalState.get<Record<string, number>>('oceangram.lastInteractions', {});
    return interactions[chatId] || 0;
  }

  /**
   * Check if the user has been away long enough to show a resume summary
   */
  shouldShowResume(chatId: string): boolean {
    const lastInteraction = this.getLastInteraction(chatId);
    if (lastInteraction === 0) {
      return false; // First time opening this chat
    }
    const timeSinceLastInteraction = Date.now() - lastInteraction;
    return timeSinceLastInteraction > SessionResumeService.MIN_AWAY_TIME;
  }

  /**
   * Generate a resume summary based on what happened while the user was away
   */
  async generateResumeSummary(chatId: string, messages: any[]): Promise<ResumeData | null> {
    const lastInteraction = this.getLastInteraction(chatId);
    if (lastInteraction === 0) {
      return null;
    }

    // Filter messages received while away
    const messagesWhileAway = messages.filter(msg => 
      msg.timestamp * 1000 > lastInteraction && !msg.isOutgoing
    );

    if (messagesWhileAway.length === 0) {
      return null;
    }

    const resumeData: ResumeData = {
      messageCount: messagesWhileAway.length,
      keyEvents: [],
      errors: [],
      lastResumeTimestamp: Date.now()
    };

    // Process messages to extract key events
    for (const msg of messagesWhileAway) {
      // Look for agent actions in message text
      if (this.containsAgentAction(msg.text)) {
        resumeData.keyEvents.push({
          type: 'agent_action',
          content: this.extractAgentAction(msg.text),
          timestamp: msg.timestamp * 1000,
          priority: this.getActionPriority(msg.text)
        });
      }

      // Look for error messages
      if (this.containsError(msg.text)) {
        resumeData.errors.push({
          type: 'error',
          content: this.extractErrorMessage(msg.text),
          timestamp: msg.timestamp * 1000,
          priority: 'high'
        });
      }

      // Look for status changes
      if (this.containsStatusChange(msg.text)) {
        resumeData.keyEvents.push({
          type: 'status_change',
          content: this.extractStatusChange(msg.text),
          timestamp: msg.timestamp * 1000,
          priority: 'normal'
        });
      }
    }

    // Sort by priority and timestamp
    resumeData.keyEvents.sort((a, b) => {
      const priorityOrder = { high: 3, normal: 2, low: 1 };
      const aPriority = priorityOrder[a.priority];
      const bPriority = priorityOrder[b.priority];
      if (aPriority !== bPriority) {
        return bPriority - aPriority; // Higher priority first
      }
      return b.timestamp - a.timestamp; // More recent first
    });

    resumeData.errors.sort((a, b) => b.timestamp - a.timestamp);

    // Limit to most important events
    resumeData.keyEvents = resumeData.keyEvents.slice(0, 5);
    resumeData.errors = resumeData.errors.slice(0, 3);

    return resumeData;
  }

  /**
   * Mark a resume summary as dismissed for a chat
   */
  async dismissResume(chatId: string): Promise<void> {
    const dismissals = this.context.globalState.get<Record<string, number>>('oceangram.resumeDismissals', {});
    dismissals[chatId] = Date.now();
    await this.context.globalState.update('oceangram.resumeDismissals', dismissals);
  }

  /**
   * Check if resume was recently dismissed for this chat
   */
  wasRecentlyDismissed(chatId: string): boolean {
    const dismissals = this.context.globalState.get<Record<string, number>>('oceangram.resumeDismissals', {});
    const lastDismissal = dismissals[chatId] || 0;
    const timeSinceDismissal = Date.now() - lastDismissal;
    return timeSinceDismissal < SessionResumeService.MIN_AWAY_TIME;
  }

  private containsAgentAction(text: string): boolean {
    if (!text) return false;
    const actionPatterns = [
      /\bcommit/i,
      /\bdeploy/i,
      /\bfile changes?/i,
      /\bexec\(/i,
      /\bprocess\(/i,
      /\bfixed\b/i,
      /\bupdated\b/i,
      /\bcreated\b/i,
      /\binstalled\b/i,
      /\brestarted\b/i,
      /\bpm2\b/i,
      /\.git\b/i,
      /\bpush/i,
      /\bpull/i,
      /\bbuild/i,
    ];
    return actionPatterns.some(pattern => pattern.test(text));
  }

  private extractAgentAction(text: string): string {
    // Extract a concise description of the agent action
    const lines = text.split('\n');
    const firstLine = lines[0];
    if (firstLine.length > 80) {
      return firstLine.substring(0, 77) + '...';
    }
    return firstLine;
  }

  private getActionPriority(text: string): 'low' | 'normal' | 'high' {
    if (this.containsError(text)) return 'high';
    if (/\b(deploy|restart|fix|error|fail)/i.test(text)) return 'high';
    if (/\b(commit|update|install|build)/i.test(text)) return 'normal';
    return 'low';
  }

  private containsError(text: string): boolean {
    if (!text) return false;
    const errorPatterns = [
      /\berror\b/i,
      /\bfail/i,
      /\bcrash/i,
      /\bexception/i,
      /\b500\b/i,
      /\b404\b/i,
      /\btimeout/i,
      /\bunable\b/i,
      /\bcannot\b/i,
      /\brefused\b/i,
    ];
    return errorPatterns.some(pattern => pattern.test(text));
  }

  private extractErrorMessage(text: string): string {
    const lines = text.split('\n');
    const errorLine = lines.find(line => this.containsError(line)) || lines[0];
    if (errorLine.length > 100) {
      return errorLine.substring(0, 97) + '...';
    }
    return errorLine;
  }

  private containsStatusChange(text: string): boolean {
    if (!text) return false;
    const statusPatterns = [
      /\bstarted\b/i,
      /\bstopped\b/i,
      /\bcompleted\b/i,
      /\bfinished\b/i,
      /\bready\b/i,
      /\bonline\b/i,
      /\boffline\b/i,
    ];
    return statusPatterns.some(pattern => pattern.test(text));
  }

  private extractStatusChange(text: string): string {
    const lines = text.split('\n');
    const statusLine = lines.find(line => this.containsStatusChange(line)) || lines[0];
    if (statusLine.length > 80) {
      return statusLine.substring(0, 77) + '...';
    }
    return statusLine;
  }
}