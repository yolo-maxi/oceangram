# Oceangram Sync Architecture Analysis

## Problem Statement

The Oceangram tray app uses 500ms HTTP polling to a gramJS daemon for new messages and read receipts. This causes:
- **Messages appearing/disappearing** — poll fetches last 5 messages which may shift window
- **Duplicates** — both WS events and polling can deliver the same message
- **Inconsistent read state** — no pts-based ordering, reads and messages race

---

## Part 1: How telegram-tt Does It (The Gold Standard)

### Architecture Overview

telegram-tt implements Telegram's **MTProto update protocol** correctly, using the `pts`/`seq`/`qts` system that Telegram designed for exactly this problem. Key files:

```
src/api/gramjs/updates/
├── updateManager.ts    — pts/seq queue + gap detection + getDifference
├── mtpUpdateHandler.ts — giant updater() switch dispatching to UI
├── apiUpdateEmitter.ts — throttled batched update delivery
├── entityProcessor.ts  — user/chat entity dedup and caching
└── UpdatePts.ts        — local pts update types
```

### The pts/seq System

Every Telegram update carries a `pts` (persistent timestamp) value. This is a **monotonically increasing counter per chat** (or globally for private chats). The system works like TCP sequence numbers:

1. **Server sends update with `pts` and `ptsCount`**
2. **Client checks**: `update.pts === localPts + ptsCount` → apply immediately
3. **Gap detected** (`pts > localPts + ptsCount`) → queue the update, call `getDifference()` to fetch missing updates
4. **Old update** (`pts <= localPts`) → already applied, discard (dedup!)

**Key insight**: This is why telegram-tt **never has duplicates or missing messages** — the pts system provides total ordering and gap detection.

### updateManager.ts — The Heart

```typescript
// State tracking (file: updateManager.ts)
export type State = {
  seq: number;   // global sequence for Updates/UpdatesCombined
  date: number;  // server date
  pts: number;   // global pts for private chats
  qts: number;   // secret chats
};

// Two separate queues
const SEQ_QUEUE = new SortedQueue<SeqUpdate>(seqComparator);  // global updates
const PTS_QUEUE = new Map<string, SortedQueue<PtsUpdate>>();   // per-channel
```

**Flow for a new message (`UpdateNewMessage`):**

1. `processUpdate()` is called by gramJS library
2. Update has `pts` → routed to `savePtsUpdate()`
3. Inserted into `PTS_QUEUE` (sorted by pts value via `SortedQueue`)
4. `popPtsQueue()` checks: does `pts === localPts + ptsCount`?
   - **Yes** → `applyUpdate()` → dispatches to `updater()` in mtpUpdateHandler.ts
   - **No (gap)** → re-queues, schedules `getDifference()` (500ms delay)
   - **Old** → silently discarded

**Gap recovery via `getDifference()`:**

```typescript
async function getDifference() {
  const response = await invoke(new GramJs.updates.GetDifference({
    pts: localDb.commonBoxState.pts,
    date: localDb.commonBoxState.date,
    qts: localDb.commonBoxState.qts,
  }));
  // Processes all missed updates, then continues queue
  processDifference(response);
  applyState(newState);
}
```

### Read Receipt Handling (mtpUpdateHandler.ts)

telegram-tt handles **four types** of read updates:

```typescript
// Private chat inbox: "they read up to message X"
UpdateReadHistoryInbox → {
  '@type': 'updateChatInbox',
  id: chatId,
  lastReadInboxMessageId: update.maxId,
  unreadCount: update.stillUnreadCount,  // ← server provides exact count!
}

// Private chat outbox: "I read up to message X" (from another device)
UpdateReadHistoryOutbox → {
  '@type': 'updateChat',
  chat: { lastReadOutboxMessageId: update.maxId }
}

// Channel inbox
UpdateReadChannelInbox → {
  lastReadInboxMessageId: update.maxId,
  unreadCount: update.stillUnreadCount,
}

// Channel outbox
UpdateReadChannelOutbox → {
  lastReadOutboxMessageId: update.maxId
}
```

**Critical detail**: Read updates also carry `pts` and go through the same queue. This means reads are **ordered relative to messages** — you'll never process a read receipt before the message it refers to.

### Update Throttling (apiUpdateEmitter.ts)

telegram-tt doesn't fire updates one-by-one to the UI. It batches them:

```typescript
function queueUpdate(update: ApiUpdate) {
  pendingUpdates.push(update);
  flushUpdatesThrottled(currentThrottleId);  // throttled per tick
}

function flushUpdates() {
  const currentUpdates = pendingUpdates;
  pendingUpdates = undefined;
  currentUpdates.forEach(onUpdate);  // batch delivery
}
```

### Entity Deduplication (entityProcessor.ts)

When processing updates that contain user/chat data, telegram-tt:
1. Adds entities to `localDb` (in-memory cache)
2. Builds API representations
3. Sends a single `updateEntities` event with all user/chat changes
4. This prevents N+1 lookups when rendering messages

### Summary: Why It Works

| Feature | Implementation |
|---------|---------------|
| No duplicates | pts comparison: `update.pts <= localPts` → discard |
| No gaps | Gap detection + getDifference() backfill |
| Ordered delivery | SortedQueue by pts, pop only when contiguous |
| Read consistency | Read updates flow through same pts queue |
| Efficiency | Batched throttled delivery, no polling |
| Reconnection | On reconnect → getDifference() catches up all missed updates |

---

## Part 2: How Oceangram Currently Does It (What's Broken)

### Daemon Architecture (`packages/daemon/src/`)

**telegram.ts** — gramJS client wrapper:
- Uses gramJS's high-level event API (`NewMessage`, `EditedMessage`, `DeletedMessage`)
- Has a raw update handler for typing + read receipts
- **Does NOT track pts/seq/qts at all**
- **Does NOT call getDifference on reconnect**
- Caches messages in-memory (2s TTL) and SQLite
- Cache keys are `dialogId|limit|offsetId` — fragile, easily stale

**server.ts** — Fastify HTTP + WS server:
- Exposes REST endpoints that call `telegram.getMessages()` (fetches from Telegram API each time)
- WS endpoint at `/events` simply forwards `TelegramEvent` objects from telegram.ts
- **No server-side message store** — daemon is a pass-through proxy
- **No sequence numbers** on events sent to clients

### Tray App Architecture (`packages/tray/src/`)

**daemon.ts** — HTTP/WS client:
- Connects to WS at `ws://localhost:7777/events`
- Emits events: `newMessage`, `readHistory`, `typing`, etc.
- Also does periodic health checks (10s interval)

**tracker.ts** — Dialog tracking:
- Polls `/dialogs?limit=250` every **5 seconds** to get unread counts
- Maintains `unreads` Map and `lastSeenIds`
- Syncs active chats from dialog metadata
- **Bug**: Unread count comes from dialog metadata, not from message-level tracking. If daemon's dialog cache is stale (30s TTL in telegram.ts), counts lag.

**popup.ts** — The 500ms polling loop:
```typescript
pollTimer = setInterval(pollForNewMessages, 500);

async function pollForNewMessages() {
  const messages = await api.getMessages(selectedDialogId, 5);  // fetches last 5
  if (newestId > lastSeenMsgId) {
    const newMsgs = messages.filter(m => m.id > lastSeenMsgId);
    for (const msg of newMsgs) {
      // Check DOM for duplicates
      const existing = messagesScrollEl.querySelector(`[data-msg-id="${msg.id}"]`);
      if (existing) continue;
      appendMessage(msg);
    }
    api.markRead(selectedDialogId, newestId);
  }
  lastSeenMsgId = newestId;
}
```

### Root Causes of Each Bug

#### 1. Messages Appearing/Disappearing

**Root cause**: The poll fetches the **last 5 messages** via `api.getMessages(dialogId, 5)`. Each HTTP request calls `telegram.getMessages()` which has a 2-second memory cache. Between cache refreshes, the underlying Telegram API may return slightly different results due to:
- Messages being edited (reordering in results)
- Deleted messages shifting the window
- Race between cache population and reads

When the poll returns a set of 5 messages that differs from last time (e.g., a deleted message no longer appears), the UI sees different `lastSeenMsgId` values and may skip or re-process messages.

#### 2. Duplicates

**Root cause**: Two delivery paths — both WS events AND 500ms polling can deliver the same message. The dedup logic checks DOM elements by `data-msg-id`, but:
- WS event arrives → `appendMessage()` → DOM updated
- 500ms later, poll fires → fetches last 5 → same message is in results
- If the DOM check races with rendering, duplicate appears
- The `suppressPollUntil` hack (3s after send) partially mitigates but doesn't solve incoming messages

#### 3. Read State Inconsistency

**Root cause**: Multiple issues compound:
- **No pts ordering**: Reads and messages arrive on different paths (WS events for reads, polling for messages). A read receipt can arrive before the message it refers to.
- **Stale dialog cache**: `tracker.ts` polls dialogs every 5s, but daemon's dialog cache has 30s TTL. So unread counts can be 30+ seconds stale.
- **Race on markRead**: popup.ts calls `markRead` immediately on receiving new messages in the active chat. But if the message was delivered via poll and the WS read event arrives before the next dialog poll, the tracker still shows the old unread count.
- **No outbox read tracking in popup**: When another device reads messages (UpdateReadHistoryOutbox), the tray has no way to reflect this until the next dialog poll.

---

## Part 3: Specific Code-Level Recommendations

### Phase 1: Fix the Daemon (Server-Side State)

The daemon must become a **stateful server** that maintains its own message store, not a pass-through proxy.

#### 1.1 Add pts/seq tracking to the daemon

**File: `packages/daemon/src/telegram.ts`**

Add state tracking to `TelegramService`:

```typescript
// New state fields in TelegramService
private commonBoxState: { seq: number; date: number; pts: number; qts: number } | null = null;
private channelPtsById: Map<string, number> = new Map();
```

After connecting, fetch initial state:

```typescript
// In connect(), after authorization:
const state = await this.client.invoke(new Api.updates.GetState());
this.commonBoxState = {
  seq: state.seq,
  date: state.date,
  pts: state.pts,
  qts: state.qts,
};
```

#### 1.2 Replace gramJS high-level events with raw update handler

**File: `packages/daemon/src/telegram.ts`** — `setupEventHandlers()`

The current approach uses `NewMessage`, `EditedMessage`, `DeletedMessage` event builders. These are convenience wrappers that **lose pts information**. Replace with a single raw update handler:

```typescript
private setupEventHandlers(): void {
  if (!this.client) return;

  // Single raw handler that preserves pts
  this.client.addEventHandler((update: Api.TypeUpdate) => {
    this.processUpdate(update);
  });
}

private processUpdate(update: Api.TypeUpdate): void {
  // Route based on update type, track pts
  if (update instanceof Api.UpdateNewMessage) {
    this.handleNewMessage(update.message, update.pts, update.ptsCount);
  } else if (update instanceof Api.UpdateNewChannelMessage) {
    this.handleNewChannelMessage(update.message, update.pts, update.ptsCount);
  } else if (update instanceof Api.UpdateEditMessage) {
    this.handleEditMessage(update.message, update.pts, update.ptsCount);
  } else if (update instanceof Api.UpdateDeleteMessages) {
    this.handleDeleteMessages(update.messages, update.pts, update.ptsCount);
  } else if (update instanceof Api.UpdateReadHistoryInbox) {
    this.handleReadInbox(update);
  } else if (update instanceof Api.UpdateReadHistoryOutbox) {
    this.handleReadOutbox(update);
  } else if (update instanceof Api.UpdateReadChannelInbox) {
    this.handleReadChannelInbox(update);
  } else if (update instanceof Api.UpdateReadChannelOutbox) {
    this.handleReadChannelOutbox(update);
  }
  // ... typing, user status, etc.
}
```

#### 1.3 Add getDifference on reconnect

**File: `packages/daemon/src/telegram.ts`**

```typescript
private async getDifference(): Promise<void> {
  if (!this.client || !this.commonBoxState) return;
  const result = await this.client.invoke(new Api.updates.GetDifference({
    pts: this.commonBoxState.pts,
    date: this.commonBoxState.date,
    qts: this.commonBoxState.qts,
  }));
  // Process missed updates...
  // Update commonBoxState with new pts/seq/date/qts
}
```

#### 1.4 Add sequence numbers to WS events

**File: `packages/daemon/src/server.ts`**

Each event sent over WS should include a monotonic sequence number so clients can detect gaps:

```typescript
let eventSeq = 0;

// In the WS handler:
const unsubscribe = telegram.onEvent((event: TelegramEvent) => {
  try {
    socket.send(JSON.stringify({ ...event, seq: ++eventSeq }));
  } catch { /* disconnected */ }
});
```

### Phase 2: Fix the Tray Client

#### 2.1 Remove 500ms HTTP polling entirely

**File: `packages/tray/src/popup.ts`**

Delete the entire `pollForNewMessages` function and `startPolling`/`stopPolling`. Replace with **WS-only message delivery**:

```typescript
// REMOVE:
// let pollTimer = setInterval(pollForNewMessages, 500);

// KEEP: Initial load via HTTP (getMessages) when switching tabs
// KEEP: WS events for real-time updates via api.onNewMessage()
```

The WS event path (`api.onNewMessage`) already exists and works. The poll is redundant.

#### 2.2 Improve WS event dedup

**File: `packages/tray/src/popup.ts`** — `api.onNewMessage()` handler

Currently dedup checks the DOM. Instead, maintain a Set of seen message IDs:

```typescript
const seenMessageIds = new Set<number>();

api.onNewMessage((data) => {
  const msg = data.message;
  const msgId = msg.id || 0;

  // Dedup by ID (not DOM — DOM may be mid-render)
  if (msgId > 0 && seenMessageIds.has(msgId)) return;
  if (msgId > 0) seenMessageIds.add(msgId);

  // ... rest of handler
});

// When switching tabs, clear and populate from loaded messages:
function switchTab(dialogId: string) {
  seenMessageIds.clear();
  const messages = await api.getMessages(dialogId, 30);
  messages.forEach(m => { if (m.id) seenMessageIds.add(m.id); });
  renderMessages(messages);
}
```

#### 2.3 Fix read receipt flow

**File: `packages/tray/src/popup.ts`** and **`packages/tray/src/tracker.ts`**

Currently reads flow:
1. Popup calls `api.markRead()` → daemon forwards to Telegram
2. Tracker polls dialogs every 5s → gets updated unread count (with 30s cache delay!)

Fix: Use WS `readHistory` events to update state immediately:

```typescript
// In popup.ts — listen for read events from WS
api.onReadHistory((data) => {
  const { dialogId, maxId, direction } = data;
  if (direction === 'incoming') {
    // We (or another client) read messages — clear unreads up to maxId
    unreadCounts[dialogId] = 0;  // or use stillUnreadCount from server
    updateTabActive();
  } else if (direction === 'outgoing') {
    // They read our messages — update read receipts in message bubbles
    updateOutboxReadState(dialogId, maxId);
  }
});
```

**File: `packages/daemon/src/telegram.ts`** — Add `stillUnreadCount` to read events:

```typescript
// In the raw update handler for UpdateReadHistoryInbox:
this.emit({
  type: 'readHistory',
  dialogId,
  maxId: update.maxId,
  direction: 'incoming',
  unreadCount: update.stillUnreadCount,  // ← ADD THIS
});
```

#### 2.4 Reduce dialog polling frequency

**File: `packages/tray/src/tracker.ts`**

The 5-second dialog poll is expensive (fetches 250 dialogs, daemon then calls Telegram API or serves from 30s cache). With WS events delivering read receipts and new messages, reduce to 30–60 seconds for dialog metadata sync:

```typescript
// Change from:
this.pollTimer = setInterval(() => this._poll(), 5000);
// To:
this.pollTimer = setInterval(() => this._poll(), 30000);
```

#### 2.5 Fix message cache invalidation

**File: `packages/daemon/src/telegram.ts`**

The current cache uses `dialogId|limit|offsetId` keys with 2s TTL. This means:
- A request for `dialog|5|0` and `dialog|20|0` are cached separately
- New messages invalidate neither

Replace with a per-dialog message list that the daemon maintains:

```typescript
// Instead of caching API responses, maintain a message ring buffer per dialog
private messageStore: Map<string, MessageInfo[]> = new Map();

// On new message event → append to store
// On edit → update in store
// On delete → remove from store
// HTTP endpoint serves from store (no Telegram API call for recent messages)
```

### Phase 3: Robust Reconnection

#### 3.1 Client-side seq tracking

**File: `packages/tray/src/daemon.ts`**

Track the last received `seq` from WS. On reconnect, request catch-up:

```typescript
private lastSeq = 0;

// In WS message handler:
const event = JSON.parse(data.toString());
if (event.seq) {
  if (this.lastSeq > 0 && event.seq > this.lastSeq + 1) {
    console.warn('[daemon] Missed events:', this.lastSeq + 1, '→', event.seq - 1);
    this.emit('need-resync');
  }
  this.lastSeq = event.seq;
}

// On reconnect: 
// Option A: Send lastSeq in WS connection URL, daemon replays missed events
// Option B: Client does a full getMessages() + getDialogs() resync
```

#### 3.2 Daemon-side event replay buffer

**File: `packages/daemon/src/server.ts`**

Keep last N events in a ring buffer. On WS reconnect with `?since=SEQ`, replay missed events:

```typescript
const EVENT_BUFFER_SIZE = 1000;
const eventBuffer: Array<{ seq: number; event: TelegramEvent }> = [];

// When WS connects with ?since=123:
socket.on('connection', (ws, req) => {
  const since = parseInt(new URL(req.url, 'http://x').searchParams.get('since') || '0');
  if (since > 0) {
    const missed = eventBuffer.filter(e => e.seq > since);
    for (const entry of missed) {
      ws.send(JSON.stringify({ ...entry.event, seq: entry.seq }));
    }
  }
});
```

---

## Part 4: Phased Implementation Plan

### Phase 1 — Stop the Bleeding (1-2 days)
**Goal**: Fix the worst symptoms without major refactoring.

1. **Remove 500ms polling from popup.ts** — The WS path already works. Remove `startPolling()`, `stopPolling()`, `pollForNewMessages()`. Keep HTTP `getMessages()` only for initial tab load and scroll-back.

2. **Add message ID dedup set in popup.ts** — Replace DOM-based dedup with an in-memory `Set<number>`. Clear on tab switch.

3. **Add `stillUnreadCount` to daemon read events** — In telegram.ts raw handler, include `update.stillUnreadCount` in read history events. Use it in tracker.ts to set exact unread count instead of relying on dialog poll.

4. **Reduce dialog poll from 5s to 30s** — In tracker.ts, change interval. With WS-based reads, 30s is fine for metadata.

### Phase 2 — Daemon State (3-5 days)
**Goal**: Make the daemon a stateful server that tracks updates correctly.

1. **Add pts/seq/qts tracking** to TelegramService
2. **Replace high-level gramJS events** with a single raw update handler that routes by type
3. **Add getDifference on reconnect** — when gramJS reconnects, fetch all missed updates
4. **Add server-side message store** — per-dialog recent messages (ring buffer of last 100)
5. **Add seq numbers to WS events** — monotonic counter on each event

### Phase 3 — Robust Client (2-3 days)
**Goal**: Make the tray client handle disconnections gracefully.

1. **Track WS event seq** in daemon.ts client
2. **Add reconnect catch-up** — on WS reconnect, pass `?since=LAST_SEQ`, daemon replays from buffer
3. **Add full resync fallback** — if buffer doesn't cover the gap, do full `getMessages()` + `getDialogs()`
4. **Add outbox read state** — show double-check marks when recipient reads messages

### Phase 4 — Polish (1-2 days)
1. **Remove redundant caches** — daemon's 2s message cache and 30s dialog cache can be replaced by the message store
2. **Add event batching** — like telegram-tt's `apiUpdateEmitter.ts`, batch rapid updates into single UI renders
3. **Optimistic UI for sends** — already partially implemented, but clean up the `suppressPollUntil` hack since polling is gone
4. **Forum topic read state** — use `ReadDiscussion` events for per-topic read tracking

---

## Quick Reference: Event Type Mapping

| Telegram Update | telegram-tt Handler | Oceangram Daemon Should Emit |
|-----------------|--------------------|-----------------------------|
| `UpdateNewMessage` | `updateMessage` (with `isFromNew: true`) | `newMessage` + pts tracking |
| `UpdateNewChannelMessage` | same as above | same |
| `UpdateEditMessage` | `updateMessage` (no `isFromNew`) | `editedMessage` |
| `UpdateDeleteMessages` | `deleteMessages` with ids | `deletedMessage` with ids |
| `UpdateReadHistoryInbox` | `updateChatInbox` with `lastReadInboxMessageId` + `unreadCount` | `readHistory` direction=incoming + `unreadCount` |
| `UpdateReadHistoryOutbox` | `updateChat` with `lastReadOutboxMessageId` | `readHistory` direction=outgoing |
| `UpdateReadChannelInbox` | `updateChat` with `lastReadInboxMessageId` + `unreadCount` | `readHistory` direction=incoming + `unreadCount` |
| `UpdateReadChannelOutbox` | `updateChat` with `lastReadOutboxMessageId` | `readHistory` direction=outgoing |
| `UpdateUserTyping` | `updateChatTypingStatus` | `typing` |

---

## Key Insight

The fundamental difference between telegram-tt and Oceangram is:

- **telegram-tt** treats Telegram updates as a **stream with sequence numbers** (pts/seq). It never polls. It queues, deduplicates, and fills gaps automatically. This is exactly how Telegram's protocol is designed to work.

- **Oceangram** treats Telegram as a **REST API** that it polls every 500ms. The WS events exist but are bolted on as a secondary path, creating two competing sources of truth with no coordination.

The fix is conceptually simple: **make the daemon the single source of truth** for message state, feed it via gramJS's native update stream (not polling), and have the tray client consume only WS events (not poll HTTP).
