# Oceangram 🦞

Telegram + AI agent cockpit for your editor. Built for [OpenClaw](https://openclaw.ai) users.

## Features

- **💬 Telegram Chat** — Full Telegram client inside your editor. Pinned chats, message bubbles, replies, reactions, code blocks, inline images, real-time updates via gramJS.
- **📋 Kanban Board** — Markdown-based project board. Your AI agent can read and write tasks. No SaaS required.
- **🤖 Agent Status** — See your OpenClaw agent's context window usage, model, active sessions, and health at a glance.
- **🎨 Telegram Dark Theme** — Full VS Code color theme matching Telegram's dark palette.

## Quick Start

1. Install the extension
2. Open the command palette (`Cmd+Shift+P`) → "Oceangram: Open Comms"
3. Log in with your Telegram phone number
4. Pin your chats and start messaging

### Keyboard Shortcuts

| Shortcut | Panel |
|----------|-------|
| `Cmd+Shift+1` | Comms (Telegram) |
| `Cmd+Shift+2` | Kanban |
| `Cmd+Shift+3` | Resources |
| `Cmd+Shift+4` | Agent Status |

## OpenClaw Integration

If OpenClaw is running on the same machine (or via Remote SSH), Oceangram auto-discovers the configuration and shows:
- Agent session context usage as a pinned banner in chat tabs
- Full session dashboard in the Agent panel
- Model, token count, and active status per session

## Architecture

- **Telegram**: gramJS (user client) — connects directly to Telegram servers for low latency
- **Kanban**: Reads/writes markdown files — agent-friendly, version controlled
- **Agent data**: Reads OpenClaw's `sessions.json` directly — no API needed when running via Remote SSH

## Security

- Telegram session stored locally in `~/.oceangram/config.json`
- No external API calls except Telegram
- No telemetry
- Open source

## License

MIT
