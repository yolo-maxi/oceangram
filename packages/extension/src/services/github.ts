import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface PullRequestInfo {
  number: number;
  title: string;
  url: string;
  state: 'open' | 'closed' | 'merged';
  statusCheckState?: 'success' | 'failure' | 'pending' | 'error';
  repository: string;
  lastUpdated: number; // timestamp for caching
}

interface PullRequestCache {
  [prUrl: string]: PullRequestInfo;
}

// Cache PR info for 5 minutes to avoid excessive API calls
const PR_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const prCache: PullRequestCache = {};

/**
 * Extract GitHub PR references from task description
 * Supports:
 * - Full PR URLs: https://github.com/owner/repo/pull/123
 * - Short references: #PR-123 (assumes current repo context)
 */
export function extractPRReferences(description: string): string[] {
  const references: string[] = [];
  
  // Match full GitHub PR URLs
  const urlMatches = description.match(/https:\/\/github\.com\/[^\/]+\/[^\/]+\/pull\/\d+/g);
  if (urlMatches) {
    references.push(...urlMatches);
  }
  
  // Match #PR-123 pattern - for now we'll skip these as they need repo context
  // We could enhance this later to use a configured default repository
  
  return [...new Set(references)]; // dedupe
}

/**
 * Parse GitHub PR URL to extract owner, repo, and PR number
 */
export function parsePRUrl(url: string): { owner: string; repo: string; number: number } | null {
  const match = url.match(/https:\/\/github\.com\/([^\/]+)\/([^\/]+)\/pull\/(\d+)/);
  if (!match) return null;
  
  return {
    owner: match[1],
    repo: match[2],
    number: parseInt(match[3], 10)
  };
}

/**
 * Fetch PR information using GitHub CLI
 */
export async function fetchPRInfo(prUrl: string): Promise<PullRequestInfo | null> {
  // Check cache first
  const cached = prCache[prUrl];
  if (cached && Date.now() - cached.lastUpdated < PR_CACHE_TTL) {
    return cached;
  }
  
  try {
    const parsed = parsePRUrl(prUrl);
    if (!parsed) return null;
    
    const { owner, repo, number } = parsed;
    
    // Use gh CLI to fetch PR info
    const { stdout } = await execAsync(
      `gh pr view ${number} --repo ${owner}/${repo} --json number,title,url,state,statusCheckRollup`
    );
    
    const prData = JSON.parse(stdout);
    
    // Determine status check state
    let statusCheckState: PullRequestInfo['statusCheckState'];
    if (prData.statusCheckRollup && prData.statusCheckRollup.length > 0) {
      const allChecks = prData.statusCheckRollup;
      const hasFailure = allChecks.some((check: any) => 
        check.state === 'FAILURE' || check.state === 'ERROR'
      );
      const hasPending = allChecks.some((check: any) => 
        check.state === 'PENDING' || check.state === 'IN_PROGRESS'
      );
      
      if (hasFailure) {
        statusCheckState = 'failure';
      } else if (hasPending) {
        statusCheckState = 'pending';
      } else {
        statusCheckState = 'success';
      }
    }
    
    const prInfo: PullRequestInfo = {
      number: prData.number,
      title: prData.title,
      url: prData.url,
      state: prData.state.toLowerCase() as PullRequestInfo['state'],
      statusCheckState,
      repository: `${owner}/${repo}`,
      lastUpdated: Date.now()
    };
    
    // Cache the result
    prCache[prUrl] = prInfo;
    return prInfo;
    
  } catch (error) {
    console.error(`Failed to fetch PR info for ${prUrl}:`, error);
    return null;
  }
}

/**
 * Fetch PR info for all references in task descriptions
 */
export async function fetchMultiplePRInfo(prUrls: string[]): Promise<PullRequestInfo[]> {
  const results = await Promise.allSettled(
    prUrls.map(url => fetchPRInfo(url))
  );
  
  return results
    .filter((result): result is PromiseFulfilledResult<PullRequestInfo | null> => 
      result.status === 'fulfilled'
    )
    .map(result => result.value)
    .filter((pr): pr is PullRequestInfo => pr !== null);
}

/**
 * Clear cached PR info (for manual refresh)
 */
export function clearPRCache(): void {
  Object.keys(prCache).forEach(key => delete prCache[key]);
}

/**
 * Get cached PR info without making API calls
 */
export function getCachedPRInfo(prUrl: string): PullRequestInfo | null {
  const cached = prCache[prUrl];
  if (cached && Date.now() - cached.lastUpdated < PR_CACHE_TTL) {
    return cached;
  }
  return null;
}