# oceangram-daemon

Standalone local Telegram client daemon. Exposes [gramjs](https://github.com/nicedayzhu/nicegram-web-z) over HTTP + WebSocket.

Runs on `127.0.0.1:7777` — keeps your Telegram session local for trust/security.

## Quick Start

```bash
pnpm install
pnpm run build
node dist/cli.js start
```

Open http://127.0.0.1:7777/login to authenticate on first run.

## CLI

```bash
oceangram-daemon start   # Start the daemon
oceangram-daemon stop    # Stop the daemon
oceangram-daemon status  # Check if running
```

## Configuration

Stored in `~/.oceangram-daemon/config.json`:
- `session` — Telegram session string (auto-saved after login)
- `apiId` / `apiHash` — Telegram API credentials (defaults built-in)
- `port` — Server port (default 7777)
- `authToken` — Optional bearer token for API auth

Environment variables: `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `PORT`, `AUTH_TOKEN`

## REST API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Service status |
| GET | `/me` | Current user info |
| GET | `/dialogs?limit=100` | Chat list (with forum topics, see below) |

### Forum dialogs (two-pass expansion)

For efficiency, forum groups are expanded into topics in two passes:

1. **Pass 1 — Skip inactive forums:** Only expand forums where `unreadCount > 0` OR the last message is outgoing. Forums with no unreads and no recent send from you are skipped entirely (no `getForumTopics` API call).

2. **Pass 2 — Filter dead topics:** Within active forums, only include topics where `unreadCount > 0` OR `readOutboxMaxId > 0` (you've sent there before). Topics with no unreads and no outbox are excluded.

This prevents large inactive forum groups from consuming the dialog quota with hundreds of dead topics. Downside: whitelisted but inactive forum topics may not appear in the list until they have unreads or you send there.
| GET | `/dialogs/:id/messages?limit=20&offsetId=X` | Messages |
| POST | `/dialogs/:id/messages` | Send message `{text, replyTo?}` |
| GET | `/dialogs/:id/info` | Chat info |
| GET | `/dialogs/:id/search?q=X` | Search messages |
| POST | `/dialogs/:id/typing` | Send typing indicator |
| POST | `/messages/:id/read` | Mark as read `{dialogId}` |
| POST | `/messages/:id/react` | Add reaction `{dialogId, emoji}` |
| PATCH | `/messages/:id` | Edit message `{dialogId, text}` |
| DELETE | `/messages/:id` | Delete message `{dialogId}` |
| GET | `/media/:id?dialogId=X` | Download media |
| GET | `/profile/:userId` | User profile |
| GET | `/profile/:userId/photo` | Profile photo |

## WebSocket

Connect to `ws://127.0.0.1:7777/events` for real-time events:

```json
{"type": "newMessage", "dialogId": "123", "message": {...}}
{"type": "editedMessage", "dialogId": "123", "message": {...}}
{"type": "deletedMessage", "dialogId": "123", "messageIds": [456]}
```

## Auth

If `authToken` is set, include `Authorization: Bearer <token>` header on all requests (except `/health` and `/login`).
