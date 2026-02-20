import * as vscode from 'vscode';

export type NotificationPriority = 'silent' | 'info' | 'warning' | 'sound';

export interface NotificationResult {
  priority: NotificationPriority;
  reason: string;
}

/**
 * Classify a message into a notification priority level.
 * Agent-aware: heartbeats are silent, errors are warnings, completions are info.
 */
export function classifyMessage(text: string, senderName?: string): NotificationResult {
  if (!text) return { priority: 'silent', reason: 'empty' };

  const lower = text.toLowerCase().trim();

  // Silent: heartbeat messages
  if (lower === 'heartbeat_ok' || lower.startsWith('heartbeat_ok')) {
    return { priority: 'silent', reason: 'heartbeat' };
  }

  // Silent: typing indicators, status updates
  if (lower === '...' || lower === 'typing...') {
    return { priority: 'silent', reason: 'typing' };
  }

  // Warning: agent errors/failures
  const errorPatterns = [
    /\berror\b/i, /\bfailed\b/i, /\bfailure\b/i, /\bcrash(ed)?\b/i,
    /\bpanic\b/i, /\btimeout\b/i, /\bexception\b/i, /\b500\b/,
    /\bout of memory\b/i, /\bkilled\b/i, /\bfatal\b/i,
  ];
  for (const pat of errorPatterns) {
    if (pat.test(text)) {
      return { priority: 'warning', reason: 'error_detected' };
    }
  }

  // Info: sub-agent completion
  const completionPatterns = [
    /\bcompleted?\b.*\btask\b/i, /\btask\b.*\bcompleted?\b/i,
    /\bfinished\b/i, /\bdone\b.*\bwith\b/i, /\bsuccessfully\b/i,
    /\bdeployed\b/i, /\bmerged\b/i, /\bshipped\b/i,
    /sub-?agent.*(?:done|complete|finished)/i,
    /✅.*(?:done|complete|finished|deployed)/i,
  ];
  for (const pat of completionPatterns) {
    if (pat.test(text)) {
      return { priority: 'info', reason: 'task_completion' };
    }
  }

  // Default: regular message (info level, no sound)
  return { priority: 'info', reason: 'regular_message' };
}

/**
 * Check if a message contains a direct mention of the user.
 */
export function hasDirectMention(text: string, username?: string): boolean {
  if (!username) return false;
  const mentionPattern = new RegExp(`@${username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  return mentionPattern.test(text);
}

/**
 * Show a VS Code notification based on the classified priority.
 */
export function showSmartNotification(
  text: string,
  senderName: string,
  chatName: string,
  username?: string
): NotificationResult {
  const config = vscode.workspace.getConfiguration('oceangram');
  const notificationsEnabled = config.get<boolean>('notifications.enabled', true);
  if (!notificationsEnabled) return { priority: 'silent', reason: 'notifications_disabled' };

  // Check for direct mention first (highest priority)
  if (username && hasDirectMention(text, username)) {
    const msg = `💬 ${senderName} mentioned you in ${chatName}`;
    vscode.window.showInformationMessage(msg, 'Open Chat').then(action => {
      if (action === 'Open Chat') {
        vscode.commands.executeCommand('oceangram.openComms');
      }
    });
    return { priority: 'sound', reason: 'direct_mention' };
  }

  const result = classifyMessage(text, senderName);

  switch (result.priority) {
    case 'silent':
      // No notification
      break;
    case 'warning': {
      const msg = `⚠️ ${senderName} in ${chatName}: ${truncateForNotification(text)}`;
      vscode.window.showWarningMessage(msg, 'Open Chat').then(action => {
        if (action === 'Open Chat') {
          vscode.commands.executeCommand('oceangram.openComms');
        }
      });
      break;
    }
    case 'info': {
      const msg = `💬 ${senderName} in ${chatName}: ${truncateForNotification(text)}`;
      vscode.window.showInformationMessage(msg, 'Open Chat').then(action => {
        if (action === 'Open Chat') {
          vscode.commands.executeCommand('oceangram.openComms');
        }
      });
      break;
    }
  }

  return result;
}

function truncateForNotification(text: string, maxLen = 100): string {
  const oneLine = text.replace(/\n/g, ' ').trim();
  if (oneLine.length <= maxLen) return oneLine;
  return oneLine.substring(0, maxLen - 1) + '…';
}
