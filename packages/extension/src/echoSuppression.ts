/**
 * Echo suppression logic — extracted for testability.
 * When a real message arrives that matches a pending optimistic message,
 * we replace the optimistic one instead of duplicating.
 */

export interface SimpleMessage {
  id: number;
  text: string;
  timestamp: number;
  isOutgoing: boolean;
  _optimistic?: string | null;
}

/**
 * Find the index of an optimistic message that matches the incoming real message.
 * Match criteria: same text, outgoing, timestamp within 30 seconds.
 * Returns -1 if no match found.
 */
export function findOptimisticEcho(
  allMessages: SimpleMessage[],
  incoming: SimpleMessage,
  maxAgeSec = 30
): number {
  if (!incoming.isOutgoing) return -1;
  for (let i = allMessages.length - 1; i >= 0; i--) {
    const m = allMessages[i];
    if (
      m._optimistic &&
      m.text === incoming.text &&
      Math.abs(incoming.timestamp - m.timestamp) < maxAgeSec
    ) {
      return i;
    }
  }
  return -1;
}

/**
 * Merge poll results with pending optimistic messages.
 * Returns the merged array sorted by timestamp.
 */
export function mergeWithOptimistic(
  polledMessages: SimpleMessage[],
  currentMessages: SimpleMessage[]
): SimpleMessage[] {
  const stillPending = currentMessages.filter((m) => {
    if (!m._optimistic) return false;
    return !polledMessages.some(
      (rm) =>
        rm.isOutgoing &&
        rm.text === m.text &&
        Math.abs(rm.timestamp - m.timestamp) < 30
    );
  });
  const merged = [...polledMessages, ...stillPending];
  merged.sort((a, b) => a.timestamp - b.timestamp || a.id - b.id);
  return merged;
}
