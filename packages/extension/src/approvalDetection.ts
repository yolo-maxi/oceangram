/**
 * TASK-040: Detect approval-seeking patterns in AI agent messages.
 * Returns true if a message likely needs Approve/Reject buttons.
 */

const ACTION_VERBS = [
  'deploy', 'send', 'delete', 'merge', 'restart', 'proceed',
  'continue', 'execute', 'publish', 'push', 'remove', 'update',
  'install', 'upgrade', 'migrate', 'rollback', 'revert', 'release',
  'start', 'stop', 'kill', 'drop', 'overwrite', 'replace',
];

const VERB_PATTERN = new RegExp(`\\b(${ACTION_VERBS.join('|')})\\b`, 'i');

const SHOULD_I_PATTERN = /\b(should i|want me to|shall i|do you want me to|ready to|go ahead and)\b/i;

/**
 * Detect if a message text contains an approval-seeking pattern.
 * Requirements:
 * - Message ends with '?' (after trimming)
 * - Contains an action verb OR a "Should I..." / "Want me to..." pattern
 */
export function isApprovalSeeking(text: string): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (!trimmed.endsWith('?')) return false;
  
  // Check for "Should I..." / "Want me to..." patterns
  if (SHOULD_I_PATTERN.test(trimmed)) return true;
  
  // Check for action verbs
  if (VERB_PATTERN.test(trimmed)) return true;
  
  return false;
}
