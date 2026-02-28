import * as fs from 'fs';
import * as path from 'path';

export interface DigestItem {
  id: string;
  type: 'task' | 'deploy' | 'error' | 'cost';
  title: string;
  details: string;
  timestamp: string;
  messageId?: string; // For linking to specific message
  cost?: number; // For cost items
}

export interface SessionDigest {
  totalCost: number;
  items: DigestItem[];
  hasActivity: boolean;
  sessionCount: number;
}

export function generateSessionDigest(sinceTimestamp: number): SessionDigest {
  const sessionsPath = path.join(process.env.HOME || '/home/xiko', '.openclaw', 'agents', 'main', 'sessions');
  
  if (!fs.existsSync(sessionsPath)) {
    return {
      totalCost: 0,
      items: [],
      hasActivity: false,
      sessionCount: 0
    };
  }

  try {
    // Get all active session files (not deleted)
    const sessionFiles = fs.readdirSync(sessionsPath)
      .filter(file => file.endsWith('.jsonl') && !file.includes('.deleted.'))
      .map(file => ({
        name: file,
        path: path.join(sessionsPath, file),
        mtime: fs.statSync(path.join(sessionsPath, file)).mtime.getTime()
      }))
      .filter(file => file.mtime > sinceTimestamp) // Only files modified since last check
      .sort((a, b) => b.mtime - a.mtime); // Newest first

    if (sessionFiles.length === 0) {
      return {
        totalCost: 0,
        items: [],
        hasActivity: false,
        sessionCount: 0
      };
    }

    const items: DigestItem[] = [];
    let totalCost = 0;

    for (const sessionFile of sessionFiles) {
      const sessionItems = parseSessionFile(sessionFile.path, sinceTimestamp);
      items.push(...sessionItems.items);
      totalCost += sessionItems.cost;
    }

    // Sort items by timestamp, newest first
    items.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    return {
      totalCost,
      items: items.slice(0, 20), // Limit to 20 most recent items
      hasActivity: items.length > 0 || totalCost > 0,
      sessionCount: sessionFiles.length
    };
  } catch (error) {
    console.error('Error generating session digest:', error);
    return {
      totalCost: 0,
      items: [],
      hasActivity: false,
      sessionCount: 0
    };
  }
}

function parseSessionFile(filePath: string, sinceTimestamp: number): { items: DigestItem[], cost: number } {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n').filter(line => line.trim());
    
    const items: DigestItem[] = [];
    let totalCost = 0;

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        
        // Skip entries older than our threshold
        if (entry.timestamp && new Date(entry.timestamp).getTime() <= sinceTimestamp) {
          continue;
        }

        // Extract different types of events
        if (entry.type === 'message') {
          const message = entry.message;
          
          // Check for costs in assistant messages
          if (message?.role === 'assistant' && message?.usage?.cost?.total) {
            totalCost += message.usage.cost.total;
          }

          // Check for tool calls indicating tasks/deploys/errors
          if (message?.content) {
            const toolCallItems = extractToolCallItems(message.content, entry.id, entry.timestamp);
            items.push(...toolCallItems);
          }

          // Check for task completion patterns in assistant messages
          if (message?.role === 'assistant') {
            const taskItems = extractTaskCompletionItems(message.content, entry.id, entry.timestamp);
            items.push(...taskItems);
          }

          // Check for error patterns in tool results
          if (message?.role === 'toolResult' && message?.details?.isError) {
            const errorItem = extractErrorItem(message, entry.id, entry.timestamp);
            if (errorItem) {
              items.push(errorItem);
            }
          }
        }
      } catch (parseError) {
        // Skip malformed lines
        continue;
      }
    }

    return { items, cost: totalCost };
  } catch (error) {
    console.error(`Error parsing session file ${filePath}:`, error);
    return { items: [], cost: 0 };
  }
}

function extractToolCallItems(content: any[], messageId: string, timestamp: string): DigestItem[] {
  const items: DigestItem[] = [];
  
  if (!Array.isArray(content)) {
    return items;
  }

  for (const item of content) {
    if (item.type === 'toolCall') {
      const toolName = item.name;
      const args = item.arguments || {};
      
      // Check for deploy commands
      if (toolName === 'exec' && args.command) {
        const command = args.command.toLowerCase();
        if (command.includes('deploy') || command.includes('npm run build') || command.includes('pnpm run build')) {
          items.push({
            id: `${messageId}-${item.id}`,
            type: 'deploy',
            title: 'Deployment executed',
            details: truncateCommand(args.command),
            timestamp,
            messageId
          });
        }
      }

      // Check for file operations that might indicate task completion
      if (toolName === 'Write' || toolName === 'Edit') {
        const filePath = args.file_path || args.path || '';
        if (filePath) {
          items.push({
            id: `${messageId}-${item.id}`,
            type: 'task',
            title: `File ${toolName.toLowerCase()}d`,
            details: path.basename(filePath),
            timestamp,
            messageId
          });
        }
      }

      // Check for browser automation
      if (toolName === 'browser' && args.action) {
        items.push({
          id: `${messageId}-${item.id}`,
          type: 'task',
          title: 'Browser automation',
          details: `${args.action}${args.targetUrl ? ` on ${new URL(args.targetUrl).hostname}` : ''}`,
          timestamp,
          messageId
        });
      }
    }
  }

  return items;
}

function extractTaskCompletionItems(content: any[], messageId: string, timestamp: string): DigestItem[] {
  const items: DigestItem[] = [];
  
  if (!Array.isArray(content)) {
    return items;
  }

  for (const item of content) {
    if (item.type === 'text' && typeof item.text === 'string') {
      const text = item.text.toLowerCase();
      
      // Look for completion patterns
      const completionPatterns = [
        /(?:task|work|implementation|feature)\s+(?:completed|finished|done)/i,
        /successfully\s+(?:created|implemented|deployed|built)/i,
        /(?:pr|pull request)\s+(?:created|opened|merged)/i,
        /(?:commit|committed|pushed)\s+(?:changes|code)/i,
        /✅.*(?:done|complete|finished)/i,
        /done.*✅/i
      ];

      for (const pattern of completionPatterns) {
        if (pattern.test(text)) {
          // Extract the relevant part of the message
          const sentences = item.text.split(/[.!?]+/);
          const matchingSentence = sentences.find(s => pattern.test(s)) || sentences[0];
          
          items.push({
            id: `${messageId}-completion`,
            type: 'task',
            title: 'Task completed',
            details: matchingSentence.trim().substring(0, 100) + (matchingSentence.length > 100 ? '...' : ''),
            timestamp,
            messageId
          });
          break; // Only add one item per message
        }
      }
    }
  }

  return items;
}

function extractErrorItem(toolResult: any, messageId: string, timestamp: string): DigestItem | null {
  if (!toolResult.details?.error && !toolResult.content) {
    return null;
  }

  let errorText = '';
  if (toolResult.details?.error) {
    errorText = toolResult.details.error;
  } else if (Array.isArray(toolResult.content)) {
    const textContent = toolResult.content.find(c => c.type === 'text');
    if (textContent?.text) {
      errorText = textContent.text;
    }
  }

  if (!errorText) {
    return null;
  }

  // Extract the first line or meaningful error message
  const firstLine = errorText.split('\n')[0];
  const errorSummary = firstLine.length > 100 ? firstLine.substring(0, 100) + '...' : firstLine;

  return {
    id: `${messageId}-error`,
    type: 'error',
    title: 'Command failed',
    details: errorSummary,
    timestamp,
    messageId
  };
}

function truncateCommand(command: string): string {
  // Remove common prefixes and clean up
  const cleaned = command
    .replace(/^(sudo\s+)?/i, '')
    .replace(/\s+>/g, ' >')
    .replace(/\s+2>&1$/g, '');
  
  return cleaned.length > 80 ? cleaned.substring(0, 80) + '...' : cleaned;
}

export function formatTimestamp(timestamp: string): string {
  try {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / (1000 * 60));
    
    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return `${diffDays} days ago`;
    
    return date.toLocaleDateString();
  } catch {
    return 'Unknown';
  }
}