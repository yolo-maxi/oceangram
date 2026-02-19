import { findOptimisticEcho, mergeWithOptimistic, SimpleMessage } from './echoSuppression';

function msg(overrides: Partial<SimpleMessage>): SimpleMessage {
  return { id: 1, text: 'hello', timestamp: 1000, isOutgoing: true, ...overrides };
}

// --- findOptimisticEcho ---

console.log('findOptimisticEcho tests:');

// Should match optimistic message with same text and close timestamp
{
  const messages: SimpleMessage[] = [
    msg({ id: -1, _optimistic: 'sending', timestamp: 1000 }),
  ];
  const incoming = msg({ id: 42, timestamp: 1005 });
  const idx = findOptimisticEcho(messages, incoming);
  console.assert(idx === 0, 'should find match at index 0, got ' + idx);
  console.log('  ✓ matches same text within 30s');
}

// Should NOT match if text differs
{
  const messages: SimpleMessage[] = [
    msg({ id: -1, _optimistic: 'sending', text: 'different' }),
  ];
  const incoming = msg({ id: 42, text: 'hello' });
  console.assert(findOptimisticEcho(messages, incoming) === -1, 'should not match different text');
  console.log('  ✓ rejects different text');
}

// Should NOT match if timestamp too far apart
{
  const messages: SimpleMessage[] = [
    msg({ id: -1, _optimistic: 'sending', timestamp: 900 }),
  ];
  const incoming = msg({ id: 42, timestamp: 1000 });
  console.assert(findOptimisticEcho(messages, incoming) === -1, 'should reject >30s gap');
  console.log('  ✓ rejects timestamp > 30s apart');
}

// Should NOT match incoming messages (non-outgoing)
{
  const messages: SimpleMessage[] = [
    msg({ id: -1, _optimistic: 'sending' }),
  ];
  const incoming = msg({ id: 42, isOutgoing: false });
  console.assert(findOptimisticEcho(messages, incoming) === -1, 'should skip non-outgoing');
  console.log('  ✓ skips non-outgoing messages');
}

// Should NOT match non-optimistic messages
{
  const messages: SimpleMessage[] = [
    msg({ id: 5 }), // no _optimistic flag
  ];
  const incoming = msg({ id: 42 });
  console.assert(findOptimisticEcho(messages, incoming) === -1, 'should skip non-optimistic');
  console.log('  ✓ skips non-optimistic messages');
}

// --- mergeWithOptimistic ---

console.log('\nmergeWithOptimistic tests:');

// Should drop optimistic when echo found in poll
{
  const current: SimpleMessage[] = [
    msg({ id: -1, _optimistic: 'sending', timestamp: 1000 }),
  ];
  const polled: SimpleMessage[] = [
    msg({ id: 42, timestamp: 1002 }),
  ];
  const result = mergeWithOptimistic(polled, current);
  console.assert(result.length === 1, 'should have 1 message, got ' + result.length);
  console.assert(result[0].id === 42, 'should be the real message');
  console.log('  ✓ drops echoed optimistic');
}

// Should keep optimistic if no echo yet
{
  const current: SimpleMessage[] = [
    msg({ id: -1, _optimistic: 'sending', text: 'new msg', timestamp: 2000 }),
  ];
  const polled: SimpleMessage[] = [
    msg({ id: 10, text: 'old msg', timestamp: 900 }),
  ];
  const result = mergeWithOptimistic(polled, current);
  console.assert(result.length === 2, 'should have 2 messages');
  console.assert(result[1].id === -1, 'optimistic should be kept at end');
  console.log('  ✓ keeps un-echoed optimistic');
}

console.log('\nAll tests passed! ✅');
