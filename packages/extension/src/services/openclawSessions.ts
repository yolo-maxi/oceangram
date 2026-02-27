import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

export interface AgentSession {
  id: string;
  name: string;
  status: 'online' | 'idle' | 'busy' | 'offline';
  model: string;
  contextUsage: number; // 0-100 percentage
  activeTask: string;
  lastActivity: string;
  timestamp: string;
}

export function getOpenclawSessionsPath(): string {
  return path.join(process.env.HOME || '/home/xiko', '.openclaw', 'agents', 'main', 'sessions');
}

export function readOpenclawSessions(): AgentSession[] {
  const sessionsPath = getOpenclawSessionsPath();
  
  if (!fs.existsSync(sessionsPath)) {
    return [];
  }

  try {
    const sessionFiles = fs.readdirSync(sessionsPath)
      .filter(file => file.endsWith('.jsonl') && !file.includes('.deleted.'))
      .sort((a, b) => {
        // Sort by modification time, newest first
        const aPath = path.join(sessionsPath, a);
        const bPath = path.join(sessionsPath, b);
        return fs.statSync(bPath).mtime.getTime() - fs.statSync(aPath).mtime.getTime();
      });

    const sessions: AgentSession[] = [];

    for (const sessionFile of sessionFiles.slice(0, 20)) { // Limit to most recent 20
      const sessionPath = path.join(sessionsPath, sessionFile);
      const session = parseSessionFile(sessionPath, sessionFile);
      if (session) {
        sessions.push(session);
      }
    }

    return sessions;
  } catch (error) {
    console.error('Error reading OpenClaw sessions:', error);
    return [];
  }
}

function parseSessionFile(filePath: string, fileName: string): AgentSession | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n').filter(line => line.trim());
    
    if (lines.length === 0) {
      return null;
    }

    // Parse first line to get session metadata
    const firstLine = JSON.parse(lines[0]);
    if (firstLine.type !== 'session') {
      return null;
    }

    let model = 'Unknown';
    let lastActivity = 'No recent activity';
    let contextUsage = 0;
    let activeTask = 'Idle';

    // Parse subsequent lines for model changes and messages
    for (let i = 1; i < lines.length && i < 50; i++) { // Look at first 50 lines
      try {
        const line = JSON.parse(lines[i]);
        
        if (line.type === 'model_change' && line.modelId) {
          model = formatModelName(line.modelId);
        }
        
        if (line.type === 'message' && line.message?.role === 'user') {
          // Extract task from user message
          const userMessage = line.message.content?.[0]?.text || '';
          if (userMessage.length > 0) {
            activeTask = extractTaskSummary(userMessage);
            lastActivity = formatTimestamp(line.timestamp);
          }
        }
      } catch (parseError) {
        // Skip malformed lines
        continue;
      }
    }

    // Estimate context usage based on file size (rough approximation)
    const stats = fs.statSync(filePath);
    const fileSizeKB = stats.size / 1024;
    contextUsage = Math.min(Math.round((fileSizeKB / 2048) * 100), 100); // Assume 2MB = 100%

    // Determine status based on file modification time
    const lastModified = stats.mtime.getTime();
    const now = Date.now();
    const minutesAgo = (now - lastModified) / (1000 * 60);
    
    let status: 'online' | 'idle' | 'busy' | 'offline';
    if (minutesAgo < 5) {
      status = 'busy';
    } else if (minutesAgo < 30) {
      status = 'online';
    } else if (minutesAgo < 120) {
      status = 'idle';
    } else {
      status = 'offline';
    }

    const sessionName = extractSessionName(fileName, firstLine);

    return {
      id: firstLine.id || fileName.replace('.jsonl', ''),
      name: sessionName,
      status,
      model,
      contextUsage,
      activeTask,
      lastActivity,
      timestamp: firstLine.timestamp || new Date().toISOString()
    };
  } catch (error) {
    console.error(`Error parsing session file ${fileName}:`, error);
    return null;
  }
}

function extractSessionName(fileName: string, sessionData: any): string {
  // Extract topic from filename if available
  const topicMatch = fileName.match(/-topic-(\d+)\.jsonl$/);
  if (topicMatch) {
    return `Agent (Topic ${topicMatch[1]})`;
  }

  // Check for subagent pattern
  if (fileName.includes('subagent')) {
    return 'Subagent';
  }

  // Use first 8 characters of session ID
  const id = sessionData.id || fileName.replace('.jsonl', '');
  return `Agent (${id.substring(0, 8)})`;
}

function formatModelName(modelId: string): string {
  if (modelId.includes('claude')) {
    if (modelId.includes('sonnet')) return 'Claude Sonnet';
    if (modelId.includes('haiku')) return 'Claude Haiku';
    if (modelId.includes('opus')) return 'Claude Opus';
    return 'Claude';
  }
  
  if (modelId.includes('gpt')) {
    if (modelId.includes('5.3')) return 'GPT-5.3';
    if (modelId.includes('5.2')) return 'GPT-5.2';
    if (modelId.includes('4')) return 'GPT-4';
    return 'GPT';
  }
  
  return modelId.substring(0, 20); // Truncate long model names
}

function extractTaskSummary(userMessage: string): string {
  // Try to extract meaningful task summary from user message
  const message = userMessage.substring(0, 200); // Limit length
  
  // Remove timestamp pattern at start
  const cleanMessage = message.replace(/^\[.*?\]\s*/, '');
  
  // Extract first sentence or meaningful part
  const firstSentence = cleanMessage.split(/[.!?]/)[0];
  if (firstSentence.length > 10 && firstSentence.length < 100) {
    return firstSentence.trim();
  }
  
  // Fallback to first 80 characters
  return cleanMessage.substring(0, 80).trim() + (cleanMessage.length > 80 ? '...' : '') || 'Working on task';
}

function formatTimestamp(timestamp: string): string {
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
    return `${diffDays}d ago`;
  } catch {
    return 'Unknown';
  }
}