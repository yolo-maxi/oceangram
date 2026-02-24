# 🌊 Oceangram Tray

Minimal Mac menu bar Telegram client. Click the tray icon to open a chat popup.

## What It Does

Oceangram Tray lives in your menu bar. Left-click to open a sleek dark-themed chat popup; right-click for Settings and Quit. No dock icon, no clutter — just the conversations you care about.

On first launch you'll see a login screen. Enter your phone number and verification code (2FA supported). Once logged in, right-click the tray icon → **Settings** to add whitelisted (pinned) contacts from your dialogs.

## Features

- **Menu bar app** — no dock icon, lives in your tray
- **Chat popup** — left-click tray icon to open; frameless, dark-themed (like iMessage)
- **Whitelist (pinned chats)** — pin contacts for quick access; they appear as tabs
- **Active chats** — unread conversations appear as tabs alongside pinned ones
- **Real-time** — WebSocket connection to oceangram-daemon for instant updates
- **Bundled daemon** — auto-spawns oceangram-daemon on startup; no separate install
- **Graceful degradation** — works (or waits quietly) when daemon is offline
- **OpenClaw** — optional AI summaries and smart replies (feature-flagged via `~/.oceangram/config.json`)
- **GitHub** — PR link previews and merge actions (token at `~/.oceangram/github-token`)

## Requirements

- macOS (designed for menu bar)
- Node.js (for the bundled daemon)

## Setup

```bash
pnpm install
pnpm run build:daemon   # Build the bundled daemon (required first time)
pnpm run compile
pnpm start
```

Or from the repo root:

```bash
pnpm build:daemon && cd packages/tray && pnpm start
```

## Development (hot reload)

```bash
pnpm run build:daemon   # Once
pnpm dev               # Watch + rebuild + restart on file changes
```

## Build

```bash
pnpm build   # Creates macOS DMG (bundles daemon, compiles, runs electron-builder)
```

## Configuration

Settings are stored in `~/.oceangram-tray/config.json`:

```json
{
  "whitelist": [
    {
      "userId": "123456",
      "username": "criptodog",
      "displayName": "Fran"
    }
  ],
  "settings": {
    "alwaysOnTop": true,
    "showNotifications": true,
    "theme": "system",
    "pollIntervalMs": 3000
  }
}
```

`whitelist[].userId` can be a user ID or dialog ID (e.g. `chatId:topicId` for forum topics). `theme` options: `system`, `day`, `night`, `tinted`, `arctic`.

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
│  Tray Icon  │     │  oceangram-  │     │   Telegram API   │
│  (main.js)  │────▶│  daemon      │────▶│   (MTProto)      │
└──────┬──────┘     │  :7777       │     └─────────────────┘
       │            └──────▲───────┘
       │                   │ spawns
       │            ┌──────┴───────┐
       │            │ daemon-      │
       │            │ bundle.js    │
       │            └──────────────┘
       │
   ┌───┴───────────────┐
   │                   │
┌──▼──────┐     ┌──────▼──────┐
│ Chat    │     │ Settings /  │
│ Popup   │     │ Login       │
└─────────┘     └─────────────┘
```

The tray spawns the daemon from `resources/daemon-bundle.js` if it isn't already running on port 7777.

## Daemon API

Oceangram Tray connects to oceangram-daemon at `localhost:7777`:

- `GET /health` — health check
- `GET /me` — current user info
- `GET /dialogs` — list dialogs
- `GET /dialogs/:id/messages?limit=30` — messages
- `POST /dialogs/:id/messages` — send message
- `POST /messages/:id/read` — mark as read (body: `{ "dialogId": "..." }`)
- `POST /dialogs/:id/upload` — upload file (body: `{ "data": "base64", "fileName", "mimeType?", "caption?" }`)
- `GET /profile/:userId/photo` — avatar image
- `WS /events` — real-time events

## License

MIT
