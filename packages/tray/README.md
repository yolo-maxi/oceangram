# 🌊 Oceangram Tray

Minimal Mac menu bar Telegram client with floating avatar bubbles.

## What It Does

Oceangram Tray lives in your menu bar and shows floating avatar bubbles when whitelisted contacts send you messages. Click a bubble to open a sleek dark-themed chat popup. No dock icon, no clutter — just the conversations you care about.

## Features

- **Menu bar app** — no dock icon, lives in your tray
- **Floating bubbles** — avatar circles appear on screen edge when you have unreads
- **Chat popups** — frameless, dark-themed chat windows (like iMessage)
- **Whitelist** — only contacts you choose trigger notifications/bubbles
- **Real-time** — WebSocket connection to oceangram-daemon for instant updates
- **Graceful degradation** — works (or waits quietly) even when daemon is offline

## Requirements

- macOS (designed for menu bar)
- [oceangram-daemon](https://github.com/...) running at `localhost:7777`

## Setup

```bash
pnpm install
pnpm start
```

## Build

```bash
pnpm build   # Creates macOS DMG
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
    "bubblePosition": "right",
    "showNotifications": true
  }
}
```

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
│  Tray Icon  │     │  oceangram-  │     │   Telegram API   │
│  (main.js)  │────▶│  daemon      │────▶│   (MTProto)      │
└──────┬──────┘     │  :7777       │     └─────────────────┘
       │            └──────────────┘
       │
   ┌───┴───┐
   │       │
┌──▼──┐ ┌──▼──────┐
│Bubbles│ │Chat     │
│(64px) │ │Popup    │
│circles│ │(400x500)│
└──────┘ └─────────┘
```

## Daemon API

Oceangram Tray connects to oceangram-daemon at `localhost:7777`:

- `GET /health` — health check
- `GET /me` — current user info
- `GET /dialogs` — list dialogs
- `GET /dialogs/:id/messages?limit=30` — messages
- `POST /dialogs/:id/messages` — send message
- `POST /messages/:id/read` — mark as read
- `GET /profile/:userId/photo` — avatar image
- `WS /events` — real-time events

## License

MIT
