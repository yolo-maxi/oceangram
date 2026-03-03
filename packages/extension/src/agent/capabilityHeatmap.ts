import * as vscode from 'vscode';
import { readRemoteFile, remoteFileExists } from '../services/remoteFs';
import { ToolCallEntry, getActiveSessionId, getSessionJsonlPath, readToolCallsFromFile } from './liveTools';

// --- Types ---

export interface CapabilityScore {
  capability: string;
  score: number;        // 0-100 scale
  totalCalls: number;
  successRate: number;  // 0-1 scale
  averageDuration: number; // milliseconds
  lastUsed?: number;    // timestamp
  color: string;        // CSS color for heatmap
}

export interface CapabilityHeatmapData {
  scores: CapabilityScore[];
  timeWindow: string;
  totalCalls: number;
  overallScore: number;
  lastUpdated: number;
}

// --- Capability buckets mapping tools to categories ---

const CAPABILITY_BUCKETS: Record<string, string[]> = {
  'File Operations': ['read', 'write', 'edit'],
  'Code & Scripts': ['exec', 'process'],
  'Web & Browser': ['web_search', 'web_fetch', 'browser'],
  'Communication': ['message', 'tts'],
  'Visual & Media': ['image', 'canvas'],
  'System & Nodes': ['nodes'],
};

// --- Scoring configuration ---

const SCORING_CONFIG = {
  // Time window for analysis (24 hours)
  TIME_WINDOW_MS: 24 * 60 * 60 * 1000,
  
  // Minimum calls for meaningful scoring
  MIN_CALLS_FOR_SCORE: 3,
  
  // Weight factors for composite score
  WEIGHTS: {
    successRate: 0.5,      // Success rate is most important
    usage: 0.3,            // Usage frequency matters
    performance: 0.2,      // Speed/efficiency is less critical
  },
  
  // Performance thresholds (milliseconds)
  PERFORMANCE_THRESHOLDS: {
    fast: 2000,    // < 2s = excellent
    medium: 10000, // 2-10s = good  
    slow: 30000,   // 10-30s = poor, >30s = terrible
  }
};

// --- Color mapping for heatmap ---

export function scoreToColor(score: number): string {
  if (score >= 80) return '#22c55e';      // Green - excellent
  if (score >= 60) return '#84cc16';      // Light green - good
  if (score >= 40) return '#eab308';      // Yellow - okay
  if (score >= 20) return '#f97316';      // Orange - poor
  return '#ef4444';                       // Red - terrible
}

export function scoreToIntensity(score: number): number {
  return Math.max(0.3, Math.min(1.0, score / 100));
}

// --- Core analysis functions ---

export function categorizeToolCall(toolName: string): string {
  for (const [category, tools] of Object.entries(CAPABILITY_BUCKETS)) {
    if (tools.includes(toolName)) {
      return category;
    }
  }
  return 'Other'; // Fallback for unmapped tools
}

export function calculatePerformanceScore(averageDuration: number): number {
  const { fast, medium, slow } = SCORING_CONFIG.PERFORMANCE_THRESHOLDS;
  
  if (averageDuration <= fast) return 100;
  if (averageDuration <= medium) return 80;
  if (averageDuration <= slow) return 60;
  return 40; // Very slow operations
}

export function calculateUsageScore(callCount: number, maxCalls: number): number {
  if (maxCalls === 0) return 0;
  const normalized = callCount / maxCalls;
  return Math.min(100, normalized * 100);
}

export function calculateCompositeScore(
  successRate: number,
  usageScore: number, 
  performanceScore: number
): number {
  const { successRate: wSuccess, usage: wUsage, performance: wPerf } = SCORING_CONFIG.WEIGHTS;
  
  return Math.round(
    (successRate * 100 * wSuccess) +
    (usageScore * wUsage) +
    (performanceScore * wPerf)
  );
}

export function analyzeToolCallsForCapabilities(toolCalls: ToolCallEntry[]): CapabilityHeatmapData {
  const now = Date.now();
  const timeWindow = SCORING_CONFIG.TIME_WINDOW_MS;
  
  // Filter to recent calls only
  const recentCalls = toolCalls.filter(call => 
    now - call.startedAt <= timeWindow
  );
  
  if (recentCalls.length === 0) {
    return createEmptyHeatmapData();
  }
  
  // Group calls by capability
  const capabilityGroups = new Map<string, ToolCallEntry[]>();
  
  for (const call of recentCalls) {
    const capability = categorizeToolCall(call.toolName);
    if (!capabilityGroups.has(capability)) {
      capabilityGroups.set(capability, []);
    }
    capabilityGroups.get(capability)!.push(call);
  }
  
  // Calculate scores for each capability
  const scores: CapabilityScore[] = [];
  let maxCalls = 0;
  
  // First pass: find max calls for normalization
  for (const calls of capabilityGroups.values()) {
    maxCalls = Math.max(maxCalls, calls.length);
  }
  
  // Second pass: calculate scores
  for (const [capability, calls] of capabilityGroups.entries()) {
    const score = calculateCapabilityScore(capability, calls, maxCalls);
    scores.push(score);
  }
  
  // Add zero scores for unused capabilities
  for (const capability of Object.keys(CAPABILITY_BUCKETS)) {
    if (!capabilityGroups.has(capability)) {
      scores.push({
        capability,
        score: 0,
        totalCalls: 0,
        successRate: 0,
        averageDuration: 0,
        color: scoreToColor(0)
      });
    }
  }
  
  // Calculate overall metrics
  const totalCalls = recentCalls.length;
  const overallScore = scores.length > 0 
    ? Math.round(scores.reduce((sum, s) => sum + s.score, 0) / scores.length)
    : 0;
  
  return {
    scores: scores.sort((a, b) => b.score - a.score), // Sort by score descending
    timeWindow: '24 hours',
    totalCalls,
    overallScore,
    lastUpdated: now
  };
}

function calculateCapabilityScore(
  capability: string, 
  calls: ToolCallEntry[], 
  maxCalls: number
): CapabilityScore {
  const totalCalls = calls.length;
  const successCalls = calls.filter(call => call.status === 'success').length;
  const successRate = totalCalls > 0 ? successCalls / totalCalls : 0;
  
  // Calculate average duration (excluding pending calls)
  const completedCalls = calls.filter(call => call.durationMs !== undefined);
  const averageDuration = completedCalls.length > 0
    ? completedCalls.reduce((sum, call) => sum + (call.durationMs || 0), 0) / completedCalls.length
    : 0;
  
  // Find most recent usage
  const lastUsed = Math.max(...calls.map(call => call.startedAt));
  
  // Calculate component scores
  const usageScore = calculateUsageScore(totalCalls, maxCalls);
  const performanceScore = calculatePerformanceScore(averageDuration);
  const compositeScore = totalCalls >= SCORING_CONFIG.MIN_CALLS_FOR_SCORE 
    ? calculateCompositeScore(successRate, usageScore, performanceScore)
    : Math.min(30, usageScore); // Low score for insufficient data
  
  return {
    capability,
    score: compositeScore,
    totalCalls,
    successRate,
    averageDuration,
    lastUsed,
    color: scoreToColor(compositeScore)
  };
}

function createEmptyHeatmapData(): CapabilityHeatmapData {
  const scores: CapabilityScore[] = Object.keys(CAPABILITY_BUCKETS).map(capability => ({
    capability,
    score: 0,
    totalCalls: 0,
    successRate: 0,
    averageDuration: 0,
    color: scoreToColor(0)
  }));
  
  return {
    scores,
    timeWindow: '24 hours',
    totalCalls: 0,
    overallScore: 0,
    lastUpdated: Date.now()
  };
}

// --- Data fetching ---

export async function fetchCapabilityHeatmapData(): Promise<CapabilityHeatmapData> {
  try {
    const activeSessionId = await getActiveSessionId();
    if (!activeSessionId) {
      return createEmptyHeatmapData();
    }
    
    const jsonlPath = getSessionJsonlPath(activeSessionId);
    if (!await remoteFileExists(jsonlPath)) {
      return createEmptyHeatmapData();
    }
    
    const toolCalls = await readToolCallsFromFile(jsonlPath);
    return analyzeToolCallsForCapabilities(toolCalls);
  } catch (error) {
    console.error('[CapabilityHeatmap] Error fetching data:', error);
    return createEmptyHeatmapData();
  }
}

// --- HTML Generation ---

export function generateHeatmapHTML(data: CapabilityHeatmapData): string {
  if (data.totalCalls === 0) {
    return `
      <div class="capability-heatmap-empty">
        <div class="empty-state">
          <span class="empty-icon">📊</span>
          <h3>No Recent Activity</h3>
          <p>Capability heatmap will appear once there's some tool usage in the last 24 hours.</p>
        </div>
      </div>
    `;
  }
  
  const heatmapItems = data.scores.map(score => {
    const intensity = scoreToIntensity(score.score);
    const itemClass = score.score === 0 ? 'heatmap-item inactive' : 'heatmap-item';
    
    return `
      <div class="${itemClass}" 
           style="background-color: ${score.color}; opacity: ${intensity};" 
           title="${score.capability}: ${score.score}/100 (${score.totalCalls} calls, ${Math.round(score.successRate * 100)}% success)">
        <div class="capability-name">${score.capability}</div>
        <div class="capability-score">${score.score}</div>
        <div class="capability-details">
          ${score.totalCalls} calls • ${Math.round(score.successRate * 100)}% success
          ${score.averageDuration > 0 ? ` • ${Math.round(score.averageDuration/1000)}s avg` : ''}
        </div>
      </div>
    `;
  }).join('');
  
  return `
    <div class="capability-heatmap">
      <div class="heatmap-header">
        <h3>
          📊 Capability Heatmap 
          <span class="overall-score" style="color: ${scoreToColor(data.overallScore)}">
            ${data.overallScore}/100
          </span>
        </h3>
        <div class="heatmap-meta">
          ${data.totalCalls} calls in ${data.timeWindow} • Updated ${new Date(data.lastUpdated).toLocaleTimeString()}
        </div>
      </div>
      <div class="heatmap-grid">
        ${heatmapItems}
      </div>
      <div class="heatmap-legend">
        <div class="legend-item"><span class="legend-color" style="background: #22c55e;"></span>Excellent (80+)</div>
        <div class="legend-item"><span class="legend-color" style="background: #84cc16;"></span>Good (60+)</div>
        <div class="legend-item"><span class="legend-color" style="background: #eab308;"></span>Okay (40+)</div>
        <div class="legend-item"><span class="legend-color" style="background: #f97316;"></span>Poor (20+)</div>
        <div class="legend-item"><span class="legend-color" style="background: #ef4444;"></span>Terrible (&lt;20)</div>
      </div>
    </div>
  `;
}
