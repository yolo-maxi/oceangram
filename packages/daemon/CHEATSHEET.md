# Oceangram Daemon — Developer Cheat Sheet

## Architecture

```
┌─────────────┐     HTTP :7777      ┌──────────────┐     gramJS      ┌──────────┐
│  Tray App   │ ◄──────────────────► │    Daemon    │ ◄─────────────► │ Telegram │
│  (Electron) │     WS /events      │  (Fastify)   │                 │   API    │
└─────────────┘                     └──────────────┘                 └──────────┘
```

- **Daemon** = local Fastify server wrapping gramJS (user account, NOT bot API)
- **Single Telegram session** on your machine — daemon owns it
- **Tray app** = Electron renderer, polls daemon via HTTP, receives events via WS
- Everything runs locally — no cloud, no server

## Key Gotchas ⚠️

### Forum Groups Are Expanded Into Topics
`GET /dialogs` does NOT return forum groups as single entries. Each forum group is expanded into **individual topic entries** with `id: "chatId:topicId"` format.

```
Regular chat:  { id: "123456", name: "Alice", isForum: false }
Forum topic:   { id: "-1001234:8547", chatId: "-1001234", topicId: 8547, name: "Group / Topic Name", isForum: true }
```

**Why this matters:** If you're looking for a specific forum topic, match on the full `id` (e.g. `-1001234:8547`), not just the group ID.

### Dialog IDs Are Strings, Not Numbers
Even though Telegram uses numeric IDs internally, the daemon returns all IDs as strings. Channel IDs are prefixed: `-100{channelId}`.

### Messages Endpoint Handles Forum Topics
When calling `/dialogs/:dialogId/messages` with a forum topic ID like `-1001234:8547`, the daemon splits on `:` and uses `topicId` to filter messages within that topic.

### Caching (Three Tiers)
1. **L1 — In-memory** (daemon process):
   - Dialogs: 30s TTL
   - Forum topics: 30s TTL
   - Messages: **2s TTL** (for near-real-time polling)
   - Profile photos: 1h TTL

2. **L2 — SQLite** (optional, on disk):
   - Persistent cache for dialogs and messages
   - Falls back to no-op if `better-sqlite3` unavailable

3. **L3 — Telegram API** (network):
   - Only hit on cache miss

**Implication:** After sending a message, there's up to 2s before it appears in GET responses. The tray works around this by injecting an optimistic message into the DOM immediately.

### `lastMessageOutgoing` vs `lastOutgoingTime`
- `lastMessageOutgoing`: true only if the **most recent** message in the dialog was sent by you
- `lastOutgoingTime`: timestamp of your last outgoing message, even if someone replied after

**For forum topics**, `lastMessageOutgoing` is derived from the actual top message object. `lastOutgoingTime` uses `readOutboxMaxId` to detect sends even when the latest message isn't yours.

### Media Is Not Inline
Messages with media return metadata only (`mediaType`, `mediaWidth`, `fileName`, etc). To get the actual file content, call `GET /media/:messageId?dialogId=xxx` which returns a base64 data URL.

### Profile Photos Return Base64
`GET /profile/:userId/photo` returns `{ photo: "data:image/jpeg;base64,..." }` or `{ photo: null }`.

## Data Schemas

### DialogInfo (from `GET /dialogs`)
```typescript
{
  id: string;              // "123456" or "-1001234:8547" for forum topics
  chatId: string;          // base chat ID (without topic suffix)
  topicId?: number;        // forum topic ID (only for isForum: true)
  name: string;            // display name ("Alice" or "Group / Topic Name")
  lastMessage: string;     // text of last message (can be empty for topics)
  lastMessageTime: number; // unix timestamp (SECONDS, not ms!)
  lastMessageOutgoing?: boolean;
  lastOutgoingTime?: number; // unix timestamp of your last send (SECONDS)
  unreadCount: number;
  isForum: boolean;
  groupName?: string;      // parent group name (forum topics only)
  topicName?: string;      // topic title (forum topics only)
  hasPhoto?: boolean;
  type?: 'user' | 'group' | 'supergroup' | 'channel';
}
```

**⚠️ Timestamps are in SECONDS (unix epoch), not milliseconds.** The tray converts with: `ts < 1e12 ? ts * 1000 : ts`

### MessageInfo (from `GET /dialogs/:id/messages`)
```typescript
{
  id: number;
  senderId: string;
  senderName: string;      // resolved display name of sender
  text: string;
  timestamp: number;       // unix SECONDS
  isOutgoing: boolean;
  mediaType?: 'photo' | 'video' | 'voice' | 'file' | 'sticker' | 'gif';
  mediaWidth?: number;
  mediaHeight?: number;
  mediaDuration?: number;
  mediaMimeType?: string;
  fileName?: string;
  fileSize?: number;
  replyToId?: number;      // message ID this replies to
  forwardFrom?: string;
  isEdited?: boolean;
  reactions?: { emoji: string; count: number }[];
}
```

### WebSocket Events (via `GET /events`)
```typescript
{ type: 'newMessage';      dialogId: string; message: MessageInfo }
{ type: 'editedMessage';   dialogId: string; message: MessageInfo }
{ type: 'deletedMessage';  dialogId: string; messageIds: number[] }
{ type: 'typing';          dialogId: string; userId: string; action: string }
{ type: 'userStatus';      userId: string; online: boolean; lastSeen?: number }
{ type: 'readHistory';     dialogId: string; maxId: number; direction: 'incoming' | 'outgoing' }
```

## API Reference

### Auth
| Method | Path | Notes |
|--------|------|-------|
| GET | `/health` | `{ status, loggedIn, user? }` |
| GET | `/login` | `{ loggedIn, needsLogin }` |
| POST | `/login/phone` | Body: `{ phone }` → `{ phoneCodeHash }` |
| POST | `/login/code` | Body: `{ phone, code, phoneCodeHash }` → `{ success }` or `{ needs2FA, hint? }` |
| POST | `/login/2fa` | Body: `{ password }` → `{ success }` |
| POST | `/logout` | Ends session |

### Dialogs
| Method | Path | Notes |
|--------|------|-------|
| GET | `/dialogs?limit=100` | Returns DialogInfo[]. **Forums expanded into topics.** |
| GET | `/dialogs/:id/info` | Single dialog info |
| GET | `/dialogs/:id/messages?limit=20&offsetId=` | MessageInfo[]. Newest first from API, sorted by caller. |
| POST | `/dialogs/:id/messages` | Body: `{ text, replyTo? }` — Send message |
| POST | `/dialogs/:id/typing` | Send typing indicator |
| POST | `/dialogs/:id/readAll` | Mark all as read |
| POST | `/dialogs/:id/read` | Body: `{ maxId? }` — Read up to message ID |
| GET | `/dialogs/:id/pinned` | Get pinned messages |
| GET | `/dialogs/:id/scheduled` | Get scheduled messages |
| GET | `/dialogs/:id/draft` | Get draft |
| PUT | `/dialogs/:id/draft` | Body: `{ text, replyTo? }` |
| DELETE | `/dialogs/:id/draft` | Clear draft |
| POST | `/dialogs/:id/archive` | Archive |
| POST | `/dialogs/:id/unarchive` | Unarchive |
| POST | `/dialogs/:id/mute` | Body: `{ until? }` |
| POST | `/dialogs/:id/leave` | Leave group/channel |
| DELETE | `/dialogs/:id/history` | Delete chat history |
| GET | `/dialogs/:id/search?q=&limit=` | Search within dialog |

### Messages
| Method | Path | Notes |
|--------|------|-------|
| GET | `/messages/:id?dialogId=` | Get single message |
| POST | `/messages/:id/read` | Body: `{ dialogId }` |
| POST | `/messages/:id/react` | Body: `{ dialogId, emoji }` |
| PUT | `/messages/:id` | Body: `{ dialogId, text }` — Edit |
| DELETE | `/messages/:id` | Body: `{ dialogId, revoke? }` |
| POST | `/messages/:id/forward` | Body: `{ fromDialogId, toDialogId }` |
| POST | `/messages/:id/pin` | Body: `{ dialogId, notify? }` |
| POST | `/messages/:id/unpin` | Body: `{ dialogId }` |

### Media
| Method | Path | Notes |
|--------|------|-------|
| POST | `/dialogs/:id/upload` | Body: `{ data (base64), filename, caption? }` |
| POST | `/dialogs/:id/voice` | Body: `{ data (base64), duration }` |
| GET | `/media/:messageId?dialogId=` | Returns `{ data: "data:..." }` base64 |

### Profiles
| Method | Path | Notes |
|--------|------|-------|
| GET | `/me` | Current user info |
| GET | `/profile/:userId` | User profile |
| GET | `/profile/:userId/photo` | Returns `{ photo: "data:..." \| null }` |

### Search
| Method | Path | Notes |
|--------|------|-------|
| GET | `/search?q=&limit=&offsetId=` | Global message search |
| GET | `/search/dialogs?q=&limit=` | Search dialog/contact names |

### Group/Channel Admin
| Method | Path | Notes |
|--------|------|-------|
| PUT | `/dialogs/:id` | Body: `{ title?, about? }` — Edit chat info |
| PUT | `/dialogs/:id/photo` | Body: `{ data (base64) }` |
| GET | `/dialogs/:id/members?limit=&offset=&filter=&q=` | List members |
| POST | `/dialogs/:id/members` | Body: `{ userIds[] }` — Add members |
| DELETE | `/dialogs/:id/members/:userId` | Body: `{ ban? }` — Remove |
| POST | `/dialogs/:id/ban` | Body: `{ userId, deleteMessages? }` |
| POST | `/dialogs/:id/unban` | Body: `{ userId }` |
| PUT | `/dialogs/:id/members/:userId/permissions` | Set user permissions |
| POST | `/dialogs/:id/admins/:userId` | Body: `{ rights }` — Promote |
| DELETE | `/dialogs/:id/admins/:userId` | Demote |
| GET | `/dialogs/:id/invite-links` | Get invite links |
| POST | `/dialogs/:id/invite-links` | Create invite link |

### Forum Topics
| Method | Path | Notes |
|--------|------|-------|
| GET | `/dialogs/:id/topics?limit=&offsetDate=&offsetId=` | List topics |
| POST | `/dialogs/:id/topics` | Body: `{ title, iconColor?, iconEmojiId? }` |
| DELETE | `/dialogs/:id/topics/:topicId` | Delete topic |
| POST | `/dialogs/:id/topics/:topicId/close` | Close topic |
| POST | `/dialogs/:id/topics/:topicId/reopen` | Reopen topic |

### Settings
| Method | Path | Notes |
|--------|------|-------|
| GET/PUT | `/settings/privacy` | Privacy settings |
| GET/PUT | `/settings/account` | Name, bio |
| PUT | `/settings/username` | Change username |
| PUT | `/settings/photo` | Set profile photo (base64) |
| DELETE | `/settings/photo` | Remove profile photo |
| GET/PUT/DELETE | `/settings/2fa` | Two-factor auth |
| GET | `/settings/sessions` | Active sessions |
| DELETE | `/settings/sessions/:hash` | Terminate session |
| DELETE | `/settings/sessions` | Terminate all other sessions |
| GET/POST/DELETE | `/settings/blocked` | Block list |
| GET/PUT | `/settings/notifications` | Notification settings |
| GET/PUT | `/settings/autodownload` | Auto-download settings |

### Folders
| Method | Path | Notes |
|--------|------|-------|
| GET | `/folders` | List folders |
| POST | `/folders` | Create folder |
| PUT | `/folders/:id` | Update folder |
| DELETE | `/folders/:id` | Delete folder |

### Other
| Method | Path | Notes |
|--------|------|-------|
| POST | `/groups` | Body: `{ title, userIds[] }` — Create group |
| POST | `/inline` | Body: `{ botUsername, query, dialogId? }` — Inline query |
| POST | `/inline/send` | Send inline result |
| POST | `/callbacks` | Body: `{ messageId, dialogId, data }` — Callback button |
| GET | `/stickers?limit=` | Recent stickers |
| GET | `/stickers/search?q=&limit=` | Search stickers |
| GET | `/gifs?limit=&offsetId=` | Saved GIFs |
| GET | `/events` | **WebSocket** — real-time events |
| GET | `/debug/ws-test` | Test WS connectivity |

## Tray App Architecture

### Real-Time: Polling > WebSocket
The tray uses **500ms HTTP polling** as the primary real-time mechanism. WS is connected but proved unreliable in Electron (events don't always reach the renderer).

```
Every 500ms:
  GET /dialogs/:selectedId/messages?limit=5
  → Compare with lastSeenMsgId
  → Append new messages to DOM
  → Dedup via data-msg-id attribute
```

### Tracker (tracker.ts)
Polls `/dialogs` every 5s to maintain:
- `unreads` map — dialog → unread count
- `lastSentTimes` map — dialog → timestamp of last outgoing message
- `dialogNames` map — dialog → display name

**Active chats = sent recently (1h window) AND has unreads.** This is the spam filter — prevents every unread group from appearing as a tab.

### Tab System
```
allTabs = dedupe(whitelistEntries + activeChats)
         ↓
  Whitelist tabs: always shown, dimmed if no activity (70% opacity)
  Active tabs: only shown while they qualify (sent + unreads)
```

### Message Flow (Sending)
1. User types → POST `/dialogs/:id/messages`
2. Optimistic message injected into DOM immediately (id=0)
3. Next poll picks up real message from daemon
4. Dedup: if text matches an id=0 message, replace it

### Message Flow (Receiving)
1. Poll fetches latest 5 messages
2. Compare each `msg.id` against `lastSeenMsgId`
3. New messages (id > lastSeenMsgId) appended to DOM
4. `lastSeenMsgId` updated
