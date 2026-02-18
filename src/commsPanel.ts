import * as vscode from 'vscode';
import { TelegramService } from './services/telegram';
import { OpenClawService, AgentSessionInfo } from './services/openclaw';

// Shared telegram service across all panels
let sharedTelegram: TelegramService | undefined;
function getTelegram(): TelegramService {
  if (!sharedTelegram) sharedTelegram = new TelegramService();
  return sharedTelegram;
}

// Shared OpenClaw service
let sharedOpenClaw: OpenClawService | undefined;
function getOpenClaw(): OpenClawService {
  if (!sharedOpenClaw) sharedOpenClaw = new OpenClawService();
  return sharedOpenClaw;
}

/**
 * Chat picker — shown via Cmd+Shift+1.
 * Lists pinned chats + search. Clicking opens a ChatTab.
 */
export class CommsPicker {
  private static current: CommsPicker | undefined;
  private panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private context: vscode.ExtensionContext;

  static show(context: vscode.ExtensionContext) {
    if (CommsPicker.current) {
      CommsPicker.current.panel.reveal(vscode.ViewColumn.One);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'oceangram.commsPicker', '💬 Chats', vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    CommsPicker.current = new CommsPicker(panel, context);
  }

  private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
    this.panel = panel;
    this.context = context;
    this.panel.webview.html = this.getHtml();

    this.panel.onDidDispose(() => {
      CommsPicker.current = undefined;
      this.disposables.forEach(d => d.dispose());
    }, null, this.disposables);

    this.panel.webview.onDidReceiveMessage(async (msg) => {
      const tg = getTelegram();
      try {
        switch (msg.type) {
          case 'init':
            await tg.connect();
            await this.sendPinnedDialogs();
            break;
          case 'search':
            await tg.connect();
            const results = await tg.searchDialogs(msg.query);
            this.panel.webview.postMessage({ type: 'searchResults', dialogs: results });
            break;
          case 'openChat':
            ChatTab.createOrShow(msg.chatId, msg.chatName, this.context);
            break;
          case 'pin':
            tg.pinDialog(msg.chatId);
            await this.sendPinnedDialogs();
            break;
          case 'unpin':
            tg.unpinDialog(msg.chatId);
            await this.sendPinnedDialogs();
            break;
        }
      } catch (err: any) {
        this.panel.webview.postMessage({ type: 'error', message: err.message || 'Unknown error' });
      }
    }, null, this.disposables);
  }

  private async sendPinnedDialogs(): Promise<void> {
    const tg = getTelegram();
    const pinnedIds = tg.getPinnedIds();
    if (pinnedIds.length === 0) {
      this.panel.webview.postMessage({ type: 'dialogs', dialogs: [] });
      return;
    }
    const all = await tg.getDialogs(200);
    const pinned = all.filter(d => pinnedIds.includes(d.id));
    pinned.forEach(d => d.isPinned = true);
    this.panel.webview.postMessage({ type: 'dialogs', dialogs: pinned });
  }

  private getHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: var(--vscode-font-family, system-ui);
  color: var(--vscode-foreground, #ccc);
  background: var(--vscode-editor-background, #1e1e1e);
  font-size: 13px;
  height: 100vh;
  display: flex;
  flex-direction: column;
}
.search-bar { padding: 12px 16px; flex-shrink: 0; }
input[type="text"] {
  width: 100%;
  padding: 10px 14px;
  background: var(--vscode-input-background, #2a2a2a);
  color: var(--vscode-input-foreground, #ccc);
  border: 1px solid var(--vscode-input-border, #444);
  border-radius: 8px;
  font-size: 14px;
  outline: none;
}
input[type="text"]:focus { border-color: var(--vscode-focusBorder, #007acc); }
.content { flex: 1; overflow-y: auto; }
.chat-item {
  display: flex;
  align-items: center;
  padding: 10px 16px;
  gap: 12px;
  cursor: pointer;
  border-bottom: 1px solid var(--vscode-panel-border, #2a2a2a);
}
.chat-item:hover { background: var(--vscode-list-hoverBackground, #2a2a2a); }
.avatar {
  width: 40px; height: 40px;
  border-radius: 50%;
  background: var(--vscode-badge-background, #4a4a4a);
  color: var(--vscode-badge-foreground, #fff);
  display: flex; align-items: center; justify-content: center;
  font-size: 14px; font-weight: 600;
  flex-shrink: 0;
}
.chat-info { flex: 1; min-width: 0; }
.chat-name { font-weight: 600; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.chat-preview { font-size: 12px; opacity: 0.6; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 3px; }
.chat-group-name { font-size: 11px; opacity: 0.55; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-bottom: 2px; }
.chat-topic-name { font-weight: 600; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.avatar { position: relative; }
.topic-badge {
  position: absolute; bottom: -2px; right: -2px;
  width: 16px; height: 16px; border-radius: 50%;
  background: var(--vscode-badge-background, #007acc);
  color: var(--vscode-badge-foreground, #fff);
  font-size: 10px; font-weight: 700;
  display: flex; align-items: center; justify-content: center;
  border: 2px solid var(--vscode-editor-background, #1e1e1e);
}
.chat-meta { text-align: right; flex-shrink: 0; }
.chat-time { font-size: 11px; opacity: 0.5; }
.chat-unread {
  background: var(--vscode-badge-background, #007acc);
  color: var(--vscode-badge-foreground, #fff);
  font-size: 11px; border-radius: 10px;
  padding: 2px 6px; margin-top: 4px;
  display: inline-block;
}
.pin-btn, .unpin-btn {
  cursor: pointer; padding: 4px 6px; border-radius: 4px;
  flex-shrink: 0; font-size: 16px; opacity: 0.6;
}
.pin-btn:hover, .unpin-btn:hover { background: var(--vscode-list-hoverBackground, #333); opacity: 1; }
.empty { text-align: center; padding: 40px 20px; opacity: 0.5; font-size: 14px; line-height: 1.6; }
.error { color: var(--vscode-errorForeground, #f44); padding: 12px 16px; font-size: 12px; }
.loading { text-align: center; padding: 24px; opacity: 0.5; }
</style>
</head>
<body>
<div class="search-bar">
  <input type="text" id="searchInput" placeholder="Search chats..." autofocus />
</div>
<div class="content" id="chatList">
  <div class="loading">Connecting...</div>
</div>
<div id="searchResults" style="display:none" class="content"></div>
<div id="errorBox" class="error" style="display:none"></div>

<script>
const vscode = acquireVsCodeApi();
const chatList = document.getElementById('chatList');
const searchResults = document.getElementById('searchResults');
const searchInput = document.getElementById('searchInput');
const errorBox = document.getElementById('errorBox');

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function renderDialogs(dialogs, container, showPinBtn) {
  if (!dialogs.length) {
    container.innerHTML = '<div class="empty">No pinned chats yet.<br>Search to find and pin chats.</div>';
    return;
  }
  container.innerHTML = dialogs.map(d => {
    const actionBtn = showPinBtn
      ? (d.isPinned ? '' : '<span class="pin-btn" data-id="' + d.id + '">📌</span>')
      : '<span class="unpin-btn" data-id="' + d.id + '" title="Unpin">✕</span>';

    const isTopic = d.groupName && d.topicName;
    const avatarHtml = isTopic
      ? '<div class="avatar">' + esc(d.initials) + '<span class="topic-badge">#</span></div>'
      : '<div class="avatar">' + esc(d.initials) + '</div>';

    const infoHtml = isTopic
      ? '<div class="chat-info">' +
          '<div class="chat-group-name">⌗ ' + esc(d.groupName) + '</div>' +
          '<div class="chat-topic-name">' + esc(d.topicEmoji || '') + ' ' + esc(d.topicName) + '</div>' +
        '</div>'
      : '<div class="chat-info"><div class="chat-name">' + esc(d.name) + '</div>' +
        '<div class="chat-preview">' + esc(d.lastMessage.slice(0, 80)) + '</div></div>';

    return '<div class="chat-item" data-id="' + d.id + '" data-name="' + esc(d.name) + '">' +
      avatarHtml + infoHtml +
      '<div class="chat-meta"><div class="chat-time">' + formatTime(d.lastMessageTime) + '</div>' +
      (d.unreadCount > 0 ? '<div class="chat-unread">' + d.unreadCount + '</div>' : '') + '</div>' +
      actionBtn + '</div>';
  }).join('');

  container.querySelectorAll('.chat-item').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.pin-btn') || e.target.closest('.unpin-btn')) return;
      vscode.postMessage({ type: 'openChat', chatId: el.dataset.id, chatName: el.dataset.name });
    });
  });
  container.querySelectorAll('.pin-btn').forEach(el => {
    el.addEventListener('click', () => vscode.postMessage({ type: 'pin', chatId: el.dataset.id }));
  });
  container.querySelectorAll('.unpin-btn').forEach(el => {
    el.addEventListener('click', () => vscode.postMessage({ type: 'unpin', chatId: el.dataset.id }));
  });
}

let searchTimeout;
searchInput.addEventListener('input', () => {
  const q = searchInput.value.trim();
  if (!q) { searchResults.style.display = 'none'; chatList.style.display = 'block'; return; }
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => vscode.postMessage({ type: 'search', query: q }), 300);
});

window.addEventListener('message', (event) => {
  const msg = event.data;
  switch (msg.type) {
    case 'dialogs': renderDialogs(msg.dialogs, chatList, false); break;
    case 'searchResults':
      searchResults.style.display = 'block';
      chatList.style.display = 'none';
      renderDialogs(msg.dialogs, searchResults, true);
      break;
    case 'error':
      errorBox.textContent = msg.message;
      errorBox.style.display = 'block';
      setTimeout(() => errorBox.style.display = 'none', 5000);
      break;
  }
});

vscode.postMessage({ type: 'init' });
</script>
</body>
</html>`;
  }
}

/**
 * Individual chat tab — one per conversation.
 * Tab title is the chat name, e.g. "💬 Pilou"
 */
export class ChatTab {
  private static tabs: Map<string, ChatTab> = new Map();
  private panel: vscode.WebviewPanel;
  private chatId: string;
  private chatName: string;
  private disposables: vscode.Disposable[] = [];

  static createOrShow(chatId: string, chatName: string, context: vscode.ExtensionContext) {
    const existing = ChatTab.tabs.get(chatId);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'oceangram.chat', `💬 ${chatName}`, vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    ChatTab.tabs.set(chatId, new ChatTab(panel, chatId, chatName));
  }

  private constructor(panel: vscode.WebviewPanel, chatId: string, chatName: string) {
    this.panel = panel;
    this.chatId = chatId;
    this.chatName = chatName;
    this.panel.webview.html = this.getHtml();

    // Start OpenClaw session polling if configured
    const openclaw = getOpenClaw();
    if (openclaw.isConfigured) {
      const { chatId: rawChatId, topicId } = TelegramService.parseDialogId(chatId);
      openclaw.startPolling(rawChatId, topicId, (info) => {
        this.panel.webview.postMessage({ type: 'agentInfo', info });
      });
    }

    this.panel.onDidDispose(() => {
      ChatTab.tabs.delete(this.chatId);
      const { chatId: rawChatId, topicId } = TelegramService.parseDialogId(this.chatId);
      getOpenClaw().stopPolling(rawChatId, topicId);
      this.disposables.forEach(d => d.dispose());
    }, null, this.disposables);

    this.panel.webview.onDidReceiveMessage(async (msg) => {
      const tg = getTelegram();
      try {
        switch (msg.type) {
          case 'init':
            await tg.connect();
            const messages = await tg.getMessages(this.chatId, 50);
            this.panel.webview.postMessage({ type: 'messages', messages });
            break;
          case 'sendMessage':
            await tg.connect();
            await tg.sendMessage(this.chatId, msg.text, msg.replyToId);
            const updated = await tg.getMessages(this.chatId, 50);
            this.panel.webview.postMessage({ type: 'messages', messages: updated });
            break;
          case 'loadOlder':
            await tg.connect();
            const older = await tg.getMessages(this.chatId, 30, msg.beforeId);
            this.panel.webview.postMessage({ type: 'olderMessages', messages: older });
            break;
          case 'poll':
            await tg.connect();
            const polled = await tg.getMessages(this.chatId, 50);
            // Only send update if there are new messages
            const lastKnown = msg.afterId || 0;
            const hasNew = polled.some((m: any) => m.id > lastKnown);
            if (hasNew) {
              this.panel.webview.postMessage({ type: 'messages', messages: polled });
            }
            break;
        }
      } catch (err: any) {
        this.panel.webview.postMessage({ type: 'error', message: err.message || 'Unknown error' });
      }
    }, null, this.disposables);
  }

  private getHtml(): string {
    const name = this.chatName.replace(/'/g, '&#39;').replace(/"/g, '&quot;');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  --tg-bg: #0e1621;
  --tg-bg-secondary: #17212b;
  --tg-msg-in-bg: #182533;
  --tg-msg-out-bg: #2b5278;
  --tg-msg-in-border: rgba(255,255,255,0.04);
  --tg-text: #f5f5f5;
  --tg-text-secondary: #6d7f8f;
  --tg-link: #6ab2f2;
  --tg-accent: #6ab2f2;
  --tg-sender-colors: #e06c75, #e5c07b, #61afef, #c678dd, #56b6c2, #98c379, #d19a66, #be5046;
  --tg-composer-bg: #17212b;
  --tg-composer-input-bg: #242f3d;
  --tg-time: #5a6e7e;
  --tg-date-bg: rgba(0,0,0,0.35);
  --tg-reply-bar: #2b5278;
  --tg-scrollbar: rgba(255,255,255,0.08);
}
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  color: var(--tg-text);
  background: var(--tg-bg);
  font-size: 14px;
  height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* Scrollable message area */
.messages-list {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 8px 48px 8px;
  scroll-behavior: smooth;
}
.messages-list::-webkit-scrollbar { width: 5px; }
.messages-list::-webkit-scrollbar-track { background: transparent; }
.messages-list::-webkit-scrollbar-thumb {
  background: var(--tg-scrollbar);
  border-radius: 5px;
}
.messages-list::-webkit-scrollbar-thumb:hover {
  background: rgba(255,255,255,0.15);
}

/* Empty state */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  opacity: 0.35;
  user-select: none;
}
.empty-state .icon { font-size: 48px; margin-bottom: 12px; }
.empty-state .label { font-size: 14px; color: var(--tg-text-secondary); }

/* Message groups */
.msg-group { margin-bottom: 4px; display: flex; flex-direction: column; }
.msg-group.outgoing { align-items: flex-end; }
.msg-group.incoming { align-items: flex-start; }

.msg-group .group-sender {
  font-size: 13px;
  font-weight: 500;
  margin-bottom: 2px;
  margin-left: 12px;
}
/* Rotate sender colors like Telegram */
.msg-group:nth-child(7n+1) .group-sender { color: #e06c75; }
.msg-group:nth-child(7n+2) .group-sender { color: #e5c07b; }
.msg-group:nth-child(7n+3) .group-sender { color: #61afef; }
.msg-group:nth-child(7n+4) .group-sender { color: #c678dd; }
.msg-group:nth-child(7n+5) .group-sender { color: #56b6c2; }
.msg-group:nth-child(7n+6) .group-sender { color: #98c379; }
.msg-group:nth-child(7n+7) .group-sender { color: #d19a66; }

/* Individual message row */
.msg {
  max-width: 480px;
  position: relative;
  display: flex;
  flex-direction: column;
}
.msg-group.outgoing .msg { align-items: flex-end; }
.msg-group.incoming .msg { align-items: flex-start; }

/* Bubble */
.msg-bubble {
  padding: 6px 11px 7px;
  font-size: 14px;
  line-height: 1.35;
  word-wrap: break-word;
  overflow-wrap: break-word;
  white-space: pre-wrap;
  position: relative;
}
.msg-bubble a {
  color: var(--tg-link);
  text-decoration: none;
}
.msg-bubble a:hover { text-decoration: underline; }

/* Incoming bubbles */
.msg-group.incoming .msg-bubble {
  background: var(--tg-msg-in-bg);
  color: var(--tg-text);
  border: none;
}

/* Outgoing bubbles */
.msg-group.outgoing .msg-bubble {
  background: var(--tg-msg-out-bg);
  color: var(--tg-text);
  border: none;
}

/* Border radius — Telegram-style grouped bubbles */
.msg-group.incoming .msg.solo .msg-bubble { border-radius: 12px 12px 12px 4px; }
.msg-group.incoming .msg.first .msg-bubble { border-radius: 12px 12px 12px 4px; }
.msg-group.incoming .msg.middle .msg-bubble { border-radius: 4px 12px 12px 4px; }
.msg-group.incoming .msg.last .msg-bubble { border-radius: 4px 12px 12px 12px; }

.msg-group.outgoing .msg.solo .msg-bubble { border-radius: 12px 12px 4px 12px; }
.msg-group.outgoing .msg.first .msg-bubble { border-radius: 12px 12px 4px 12px; }
.msg-group.outgoing .msg.middle .msg-bubble { border-radius: 12px 4px 4px 12px; }
.msg-group.outgoing .msg.last .msg-bubble { border-radius: 12px 4px 12px 12px; }

/* Spacing between messages in a group */
.msg + .msg { margin-top: 2px; }

/* Timestamp — inline at bottom-right of bubble like Telegram */
.msg-time {
  font-size: 11px;
  color: var(--tg-time);
  float: right;
  margin-left: 8px;
  margin-top: 4px;
  position: relative;
  top: 4px;
  user-select: none;
  white-space: nowrap;
  opacity: 1;
}
/* Outgoing time is lighter */
.msg-group.outgoing .msg-time { color: rgba(255,255,255,0.45); }
/* Hide time on non-last messages in group, show on hover */
.msg-time.hidden { display: none; }
.msg:hover .msg-time.hidden { display: inline; }

/* Forward header */
.forward-header {
  font-size: 13px;
  color: var(--tg-accent);
  margin-bottom: 4px;
  font-style: italic;
}

/* Reply quote */
.reply-quote {
  border-left: 2px solid var(--tg-accent);
  padding: 4px 8px;
  margin-bottom: 6px;
  font-size: 13px;
  border-radius: 2px;
  background: rgba(255,255,255,0.05);
  max-width: 100%;
  overflow: hidden;
  cursor: pointer;
}
.reply-sender {
  font-weight: 500;
  font-size: 13px;
  color: var(--tg-accent);
}
.reply-text {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--tg-text-secondary);
  font-size: 13px;
  margin-top: 1px;
}

/* Media */
.msg-photo {
  max-width: 100%;
  border-radius: 6px;
  margin-bottom: 4px;
  cursor: pointer;
}
.msg-photo:hover { opacity: 0.92; }
.msg-file, .msg-voice, .msg-video, .msg-sticker, .msg-gif {
  font-size: 13px;
  padding: 4px 0;
  color: var(--tg-text-secondary);
}

/* Reactions */
.msg-reactions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
}
.reaction-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 8px;
  border-radius: 12px;
  font-size: 13px;
  background: rgba(106,178,242,0.1);
  border: 1px solid rgba(106,178,242,0.15);
  cursor: default;
  user-select: none;
}
.reaction-chip.selected {
  border-color: var(--tg-accent);
  background: rgba(106,178,242,0.2);
}
.reaction-emoji { font-size: 15px; }
.reaction-count { font-size: 12px; color: var(--tg-text-secondary); }

/* New messages indicator */
.new-msgs-btn {
  position: sticky;
  bottom: 8px;
  left: 50%;
  transform: translateX(-50%);
  padding: 8px 20px;
  border-radius: 20px;
  background: var(--tg-bg-secondary);
  color: var(--tg-accent);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  border: none;
  box-shadow: 0 2px 12px rgba(0,0,0,0.4);
  z-index: 10;
  display: none;
  width: fit-content;
  margin: 0 auto;
}
.new-msgs-btn:hover { background: #1e2c3a; }

/* Date separator */
.date-separator {
  text-align: center;
  padding: 8px 0 6px;
  user-select: none;
}
.date-separator span {
  font-size: 13px;
  font-weight: 500;
  color: #fff;
  background: var(--tg-date-bg);
  padding: 4px 12px;
  border-radius: 16px;
}

/* Edited label */
.msg-edited {
  font-size: 11px;
  color: var(--tg-time);
  margin-right: 4px;
  font-style: italic;
}

/* Link preview card */
.link-preview {
  border-left: 2px solid var(--tg-accent);
  padding: 6px 10px;
  margin-top: 6px;
  border-radius: 4px;
  background: rgba(255,255,255,0.04);
  font-size: 13px;
}
.lp-image {
  max-width: 100%;
  border-radius: 4px;
  margin-bottom: 4px;
}
.lp-title {
  font-weight: 500;
  margin-bottom: 2px;
  color: var(--tg-text);
}
.lp-desc {
  color: var(--tg-text-secondary);
  margin-bottom: 2px;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.lp-url {
  font-size: 12px;
  color: var(--tg-accent);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Code styling */
.msg-bubble code {
  background: rgba(0,0,0,0.2);
  padding: 2px 5px;
  border-radius: 4px;
  font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
  font-size: 13px;
}
.msg-bubble pre {
  background: rgba(0,0,0,0.25);
  padding: 10px 12px;
  border-radius: 6px;
  overflow-x: auto;
  margin: 6px 0;
  font-size: 13px;
}
.msg-bubble pre code {
  background: transparent;
  padding: 0;
}

/* Image lightbox overlay */
.lightbox-overlay {
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(0,0,0,0.92);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  cursor: pointer;
  animation: fadeIn 0.15s ease;
}
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
.lightbox-overlay img {
  max-width: 95vw;
  max-height: 95vh;
  object-fit: contain;
  border-radius: 4px;
}

/* Emoji-only messages */
.msg-bubble.emoji-only {
  background: transparent !important;
  border: none !important;
  padding: 2px 4px;
  font-size: 36px;
  line-height: 1.2;
}

/* Reply bar */
.reply-bar {
  display: none;
  align-items: center;
  gap: 10px;
  padding: 8px 16px 8px 14px;
  border-top: 1px solid rgba(255,255,255,0.06);
  border-left: 3px solid var(--tg-accent);
  background: var(--tg-composer-bg);
  flex-shrink: 0;
}
.reply-bar.active { display: flex; }
.reply-bar-content { flex: 1; min-width: 0; }
.reply-bar-sender { font-size: 13px; font-weight: 500; color: var(--tg-accent); }
.reply-bar-text { font-size: 13px; color: var(--tg-text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.reply-bar-close {
  cursor: pointer; padding: 4px; border-radius: 50%; opacity: 0.5;
  font-size: 14px; flex-shrink: 0; background: none; border: none;
  color: var(--tg-text);
  width: 28px; height: 28px;
  display: flex; align-items: center; justify-content: center;
}
.reply-bar-close:hover { opacity: 1; background: rgba(255,255,255,0.08); }

/* Context menu */
.ctx-menu {
  position: fixed;
  background: var(--tg-bg-secondary);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 10px;
  padding: 6px 0;
  min-width: 140px;
  box-shadow: 0 4px 16px rgba(0,0,0,0.5);
  z-index: 100;
  font-size: 14px;
  animation: fadeIn 0.1s ease;
}
.ctx-menu-item {
  padding: 8px 16px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 10px;
}
.ctx-menu-item:hover { background: rgba(255,255,255,0.06); }

/* Composer */
.composer {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 8px 12px 10px;
  flex-shrink: 0;
  background: var(--tg-composer-bg);
}
.composer textarea {
  flex: 1;
  padding: 9px 14px;
  background: var(--tg-composer-input-bg);
  color: var(--tg-text);
  border: none;
  border-radius: 20px;
  font-size: 14px;
  font-family: inherit;
  line-height: 1.35;
  outline: none;
  resize: none;
  max-height: 120px;
  overflow-y: auto;
}
.composer textarea:focus {
  background: var(--tg-composer-input-bg);
}
.composer textarea::placeholder {
  color: var(--tg-text-secondary);
}
.send-btn {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: none;
  background: transparent;
  color: var(--tg-accent);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: background 0.15s, transform 0.1s;
}
.send-btn:hover { background: rgba(106,178,242,0.1); }
.send-btn:active { transform: scale(0.92); }
.send-btn svg { width: 20px; height: 20px; fill: currentColor; }

/* Loading & error */
.loading {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--tg-text-secondary);
}
.error {
  color: #ef5350;
  padding: 8px 16px;
  font-size: 13px;
  background: rgba(239,83,80,0.08);
  border-top: 1px solid rgba(239,83,80,0.2);
  flex-shrink: 0;
}

/* Agent banner — pinned Telegram-style */
.agent-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 16px;
  background: var(--tg-bg-secondary);
  border-bottom: 1px solid rgba(255,255,255,0.05);
  flex-shrink: 0;
  cursor: pointer;
  transition: background 0.15s;
  gap: 12px;
}
.agent-banner:hover { background: #1e2c3a; }
.agent-banner-left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.agent-icon { font-size: 14px; flex-shrink: 0; }
.agent-model {
  font-size: 12px;
  font-weight: 500;
  color: var(--tg-accent);
  white-space: nowrap;
}
.agent-status {
  font-size: 11px;
  color: var(--tg-text-secondary);
  white-space: nowrap;
}
.agent-status.active { color: #98c379; }
.agent-banner-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.agent-context-bar {
  width: 80px;
  height: 4px;
  background: rgba(255,255,255,0.08);
  border-radius: 2px;
  overflow: hidden;
}
.agent-context-fill {
  height: 100%;
  border-radius: 2px;
  transition: width 0.5s ease, background 0.3s;
  background: var(--tg-accent);
}
.agent-context-fill.warn { background: #e5c07b; }
.agent-context-fill.critical { background: #e06c75; }
.agent-context-label {
  font-size: 11px;
  color: var(--tg-text-secondary);
  white-space: nowrap;
  min-width: 36px;
  text-align: right;
}
</style>
</head>
<body>
<!-- Agent banner (hidden if no OpenClaw session) -->
<div class="agent-banner" id="agentBanner" style="display:none">
  <div class="agent-banner-left">
    <span class="agent-icon">🦞</span>
    <span class="agent-model" id="agentModel"></span>
    <span class="agent-status" id="agentStatus"></span>
  </div>
  <div class="agent-banner-right">
    <div class="agent-context-bar">
      <div class="agent-context-fill" id="agentContextFill"></div>
    </div>
    <span class="agent-context-label" id="agentContextLabel"></span>
  </div>
</div>
<div class="messages-list" id="messagesList">
  <div class="loading">Loading…</div>
</div>
<button class="new-msgs-btn" id="newMsgsBtn" onclick="scrollToBottom()">↓ New messages</button>
<div class="reply-bar" id="replyBar">
  <div class="reply-bar-content">
    <div class="reply-bar-sender" id="replyBarSender"></div>
    <div class="reply-bar-text" id="replyBarText"></div>
  </div>
  <button class="reply-bar-close" id="replyBarClose">✕</button>
</div>
<div class="composer">
  <textarea id="msgInput" rows="1" placeholder="Message ${name}…" autofocus></textarea>
  <button class="send-btn" id="sendBtn" title="Send">
    <svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
  </button>
</div>
<div id="errorBox" class="error" style="display:none"></div>

<script>
const vscode = acquireVsCodeApi();
const messagesList = document.getElementById('messagesList');
const msgInput = document.getElementById('msgInput');
const sendBtn = document.getElementById('sendBtn');
const errorBox = document.getElementById('errorBox');

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDate(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const msgDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diff = (today - msgDay) / 86400000;
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function linkify(text) {
  return text.replace(/(https?:\\/\\/[^\\s<]+)/g, '<a href="$1" title="$1">$1</a>');
}

function applyEntities(text, entities) {
  if (!entities || entities.length === 0) return linkify(esc(text));
  var sorted = entities.slice().sort(function(a, b) { return b.offset - a.offset; });
  var chars = Array.from(text);
  var escaped = chars.map(function(c) { return esc(c); });
  for (var i = 0; i < sorted.length; i++) {
    var e = sorted[i];
    var slice = escaped.slice(e.offset, e.offset + e.length).join('');
    var replacement;
    switch (e.type) {
      case 'bold': replacement = '<strong>' + slice + '</strong>'; break;
      case 'italic': replacement = '<em>' + slice + '</em>'; break;
      case 'code': replacement = '<code>' + slice + '</code>'; break;
      case 'pre': replacement = '<pre><code' + (e.language ? ' class="language-' + esc(e.language) + '"' : '') + '>' + slice + '</code></pre>'; break;
      case 'strikethrough': replacement = '<del>' + slice + '</del>'; break;
      case 'text_link': var safeUrl = (e.url || '').match(/^https?:\\/\\//) ? e.url : '#'; replacement = '<a href="' + esc(safeUrl || '#') + '">' + slice + '</a>'; break;
      case 'url': replacement = '<a href="' + slice + '">' + slice + '</a>'; break;
      default: replacement = slice;
    }
    escaped.splice(e.offset, e.length, replacement);
  }
  return escaped.join('');
}

function isEmojiOnly(text) {
  if (!text) return false;
  const stripped = text.replace(/[\\s]/g, '');
  const emojiRe = /^(?:[\\u{1F600}-\\u{1F64F}\\u{1F300}-\\u{1F5FF}\\u{1F680}-\\u{1F6FF}\\u{1F1E0}-\\u{1F1FF}\\u{2600}-\\u{26FF}\\u{2700}-\\u{27BF}\\u{FE00}-\\u{FE0F}\\u{1F900}-\\u{1F9FF}\\u{1FA00}-\\u{1FA6F}\\u{1FA70}-\\u{1FAFF}\\u{200D}\\u{20E3}\\u{E0020}-\\u{E007F}])+$/u;
  return stripped.length <= 10 && emojiRe.test(stripped);
}

function renderMessages(msgs) {
  if (!msgs || msgs.length === 0) {
    messagesList.innerHTML =
      '<div class="empty-state">' +
        '<div class="icon">💬</div>' +
        '<div class="label">No messages yet</div>' +
      '</div>';
    return;
  }

  // Group consecutive messages from same sender
  const groups = [];
  for (const m of msgs) {
    const key = (m.isOutgoing ? '__out__' : (m.senderName || ''));
    const last = groups[groups.length - 1];
    if (last && last.key === key && m.timestamp - last.msgs[last.msgs.length - 1].timestamp < 300) {
      last.msgs.push(m);
    } else {
      groups.push({ key, isOutgoing: m.isOutgoing, senderName: m.senderName, msgs: [m] });
    }
  }

  let html = '';
  let lastDateStr = '';
  for (const g of groups) {
    // Date separator
    const firstTs = g.msgs[0].timestamp;
    const dateStr = formatDate(firstTs);
    if (dateStr && dateStr !== lastDateStr) {
      html += '<div class="date-separator"><span>' + dateStr + '</span></div>';
      lastDateStr = dateStr;
    }

    const dir = g.isOutgoing ? 'outgoing' : 'incoming';
    html += '<div class="msg-group ' + dir + '">';
    if (!g.isOutgoing && g.senderName) {
      html += '<div class="group-sender">' + esc(g.senderName) + '</div>';
    }
    const len = g.msgs.length;
    for (let i = 0; i < len; i++) {
      const m = g.msgs[i];
      let pos = 'solo';
      if (len > 1) { pos = i === 0 ? 'first' : i === len - 1 ? 'last' : 'middle'; }
      const isLast = i === len - 1;
      const emoji = isEmojiOnly(m.text);
      const bubbleCls = 'msg-bubble' + (emoji ? ' emoji-only' : '');
      const textContent = emoji ? esc(m.text) : applyEntities(m.text, m.entities);

      var bubbleInner = '';

      // Forward header
      if (m.forwardFrom) {
        bubbleInner += '<div class="forward-header">Forwarded from <strong>' + esc(m.forwardFrom) + '</strong></div>';
      }

      // Reply quote
      if (m.replyToId) {
        bubbleInner += '<div class="reply-quote">';
        if (m.replyToSender) bubbleInner += '<div class="reply-sender">' + esc(m.replyToSender) + '</div>';
        bubbleInner += '<div class="reply-text">' + esc(m.replyToText || '') + '</div>';
        bubbleInner += '</div>';
      }

      // Media
      if (m.mediaType === 'photo' && m.mediaUrl) {
        bubbleInner += '<img class="msg-photo" src="' + esc(m.mediaUrl) + '" onclick="showLightbox(this.src)" />';
      } else if (m.mediaType === 'file' && m.fileName) {
        bubbleInner += '<div class="msg-file">📎 ' + esc(m.fileName) + (m.fileSize ? ' (' + Math.round(m.fileSize / 1024) + ' KB)' : '') + '</div>';
      } else if (m.mediaType === 'voice') {
        bubbleInner += '<div class="msg-voice">🎤 Voice message</div>';
      } else if (m.mediaType === 'video') {
        bubbleInner += '<div class="msg-video">🎬 Video</div>';
      } else if (m.mediaType === 'sticker') {
        bubbleInner += '<div class="msg-sticker">🏷️ Sticker</div>';
      } else if (m.mediaType === 'gif') {
        bubbleInner += '<div class="msg-gif">🎞️ GIF</div>';
      }

      // Text
      if (m.text) {
        bubbleInner += textContent;
      }

      // Edited indicator — time is now inline inside bubble
      var timeStr = formatTime(m.timestamp);
      if (m.isEdited) timeStr = '<span class="msg-edited">edited</span>' + timeStr;

      // Link preview
      if (m.linkPreview) {
        bubbleInner += '<div class="link-preview">';
        if (m.linkPreview.imageUrl) bubbleInner += '<img class="lp-image" src="' + esc(m.linkPreview.imageUrl) + '" />';
        if (m.linkPreview.title) bubbleInner += '<div class="lp-title">' + esc(m.linkPreview.title) + '</div>';
        if (m.linkPreview.description) bubbleInner += '<div class="lp-desc">' + esc(m.linkPreview.description) + '</div>';
        bubbleInner += '<div class="lp-url">' + esc(m.linkPreview.url) + '</div>';
        bubbleInner += '</div>';
      }

      // Reactions
      var reactionsHtml = '';
      if (m.reactions && m.reactions.length) {
        reactionsHtml = '<div class="msg-reactions">';
        for (var ri = 0; ri < m.reactions.length; ri++) {
          var r = m.reactions[ri];
          reactionsHtml += '<span class="reaction-chip' + (r.isSelected ? ' selected' : '') + '">' +
            '<span class="reaction-emoji">' + esc(r.emoji) + '</span>' +
            '<span class="reaction-count">' + r.count + '</span></span>';
        }
        reactionsHtml += '</div>';
      }

      // Time goes inside bubble, inline at bottom-right like Telegram
      var timeClass = isLast ? '' : ' hidden';
      html += '<div class="msg ' + pos + '" data-msg-id="' + m.id + '" data-sender="' + esc(m.senderName || '') + '" data-text="' + esc((m.text || '').slice(0, 100)) + '">' +
        '<div class="' + bubbleCls + '">' + bubbleInner + '<span class="msg-time' + timeClass + '">' + timeStr + '</span></div>' +
        reactionsHtml +
        '</div>';
    }
    html += '</div>';
  }

  // Check scroll position BEFORE replacing content
  var shouldScroll = messagesList.scrollHeight - messagesList.scrollTop - messagesList.clientHeight < 60;
  messagesList.innerHTML = html;
  if (shouldScroll) {
    messagesList.scrollTop = messagesList.scrollHeight;
  }

  // Track last message ID for polling
  if (msgs.length > 0) {
    lastMsgId = msgs[msgs.length - 1].id || 0;
  }
  startPolling();
}

// Auto-grow textarea
function autoGrow() {
  msgInput.style.height = 'auto';
  msgInput.style.height = Math.min(msgInput.scrollHeight, 120) + 'px';
}
msgInput.addEventListener('input', autoGrow);

// Reply state
const replyBar = document.getElementById('replyBar');
const replyBarSender = document.getElementById('replyBarSender');
const replyBarText = document.getElementById('replyBarText');
const replyBarClose = document.getElementById('replyBarClose');
let replyToId = null;

function setReply(msgId, sender, text) {
  replyToId = msgId;
  replyBarSender.textContent = sender || 'Unknown';
  replyBarText.textContent = (text || '').slice(0, 100);
  replyBar.classList.add('active');
  msgInput.focus();
}
function clearReply() {
  replyToId = null;
  replyBar.classList.remove('active');
}
replyBarClose.addEventListener('click', clearReply);

function doSend() {
  const text = msgInput.value.trim();
  if (!text) return;
  msgInput.value = '';
  msgInput.style.height = 'auto';
  var payload = { type: 'sendMessage', text: text };
  if (replyToId) payload.replyToId = replyToId;
  vscode.postMessage(payload);
  clearReply();
}
sendBtn.addEventListener('click', doSend);
msgInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    doSend();
  }
  if (e.key === 'Escape' && replyToId) {
    clearReply();
  }
});

// Track all messages for prepending older ones
let allMessages = [];
let loadingOlder = false;
let oldestId = 0;
const newMsgsBtn = document.getElementById('newMsgsBtn');
let newMsgCount = 0;

function isScrolledToBottom() {
  return messagesList.scrollHeight - messagesList.scrollTop - messagesList.clientHeight < 60;
}
function scrollToBottom() {
  messagesList.scrollTop = messagesList.scrollHeight;
  newMsgsBtn.style.display = 'none';
  newMsgCount = 0;
}

window.addEventListener('message', (event) => {
  const msg = event.data;
  switch (msg.type) {
    case 'messages':
      var wasAtBottom = isScrolledToBottom();
      var prevLen = allMessages.length;
      allMessages = msg.messages;
      if (allMessages.length > 0) oldestId = allMessages[0].id || 0;
      var isFirstLoad = prevLen === 0;
      renderMessages(allMessages);
      if (isFirstLoad) { messagesList.scrollTop = messagesList.scrollHeight; }
      if (!wasAtBottom && allMessages.length > prevLen && prevLen > 0) {
        newMsgCount += allMessages.length - prevLen;
        newMsgsBtn.textContent = '↓ ' + newMsgCount + ' new message' + (newMsgCount > 1 ? 's' : '');
        newMsgsBtn.style.display = 'block';
      }
      break;
    case 'olderMessages':
      loadingOlder = false;
      if (msg.messages && msg.messages.length > 0) {
        // Prepend older messages, avoid duplicates
        const existingIds = new Set(allMessages.map(m => m.id));
        const newOlder = msg.messages.filter(m => !existingIds.has(m.id));
        if (newOlder.length > 0) {
          allMessages = [...newOlder, ...allMessages];
          oldestId = allMessages[0].id || 0;
          // Save scroll height to maintain position
          const prevHeight = messagesList.scrollHeight;
          renderMessages(allMessages);
          // Restore scroll position
          messagesList.scrollTop = messagesList.scrollHeight - prevHeight;
        }
      }
      break;
    case 'agentInfo':
      updateAgentBanner(msg.info);
      break;
    case 'error':
      errorBox.textContent = msg.message;
      errorBox.style.display = 'block';
      setTimeout(() => errorBox.style.display = 'none', 5000);
      break;
  }
});

// Agent banner
const agentBanner = document.getElementById('agentBanner');
const agentModel = document.getElementById('agentModel');
const agentStatus = document.getElementById('agentStatus');
const agentContextFill = document.getElementById('agentContextFill');
const agentContextLabel = document.getElementById('agentContextLabel');

function updateAgentBanner(info) {
  if (!info) {
    agentBanner.style.display = 'none';
    return;
  }
  agentBanner.style.display = 'flex';
  var modelName = (info.model || 'unknown').replace(/^anthropic\\//, '').replace(/^openai\\//, '');
  agentModel.textContent = modelName;
  var ago = Math.round((Date.now() - info.updatedAt) / 1000);
  var agoText;
  if (ago < 60) agoText = 'just now';
  else if (ago < 3600) agoText = Math.round(ago / 60) + 'm ago';
  else agoText = Math.round(ago / 3600) + 'h ago';
  agentStatus.textContent = info.isActive ? '● active' : '○ ' + agoText;
  agentStatus.className = 'agent-status' + (info.isActive ? ' active' : '');
  var pct = info.contextPercent || 0;
  agentContextFill.style.width = pct + '%';
  agentContextFill.className = 'agent-context-fill' + (pct > 80 ? ' critical' : pct > 60 ? ' warn' : '');
  agentContextLabel.textContent = Math.round(info.totalTokens / 1000) + 'k/' + Math.round(info.contextTokens / 1000) + 'k';
}

// Infinite scroll — load older on scroll to top, hide new msg btn at bottom
messagesList.addEventListener('scroll', () => {
  if (messagesList.scrollTop < 80 && !loadingOlder && oldestId > 0) {
    loadingOlder = true;
    vscode.postMessage({ type: 'loadOlder', beforeId: oldestId });
  }
  if (isScrolledToBottom()) {
    newMsgsBtn.style.display = 'none';
    newMsgCount = 0;
  }
});

// Context menu for messages
let activeCtxMenu = null;
function removeCtxMenu() {
  if (activeCtxMenu) { activeCtxMenu.remove(); activeCtxMenu = null; }
}
document.addEventListener('click', removeCtxMenu);
document.addEventListener('contextmenu', (e) => {
  removeCtxMenu();
  const msgEl = e.target.closest('.msg[data-msg-id]');
  if (!msgEl) return;
  e.preventDefault();
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';
  menu.innerHTML =
    '<div class="ctx-menu-item" data-action="reply">↩️ Reply</div>' +
    '<div class="ctx-menu-item" data-action="copy">📋 Copy text</div>';
  menu.querySelectorAll('.ctx-menu-item').forEach(item => {
    item.addEventListener('click', () => {
      const action = item.dataset.action;
      if (action === 'reply') {
        setReply(parseInt(msgEl.dataset.msgId), msgEl.dataset.sender, msgEl.dataset.text);
      } else if (action === 'copy') {
        navigator.clipboard.writeText(msgEl.dataset.text || '');
      }
      removeCtxMenu();
    });
  });
  document.body.appendChild(menu);
  activeCtxMenu = menu;
});

function showLightbox(src) {
  var overlay = document.createElement('div');
  overlay.className = 'lightbox-overlay';
  overlay.innerHTML = '<img src="' + src + '" />';
  overlay.addEventListener('click', function() { overlay.remove(); });
  document.body.appendChild(overlay);
}

// Real-time polling for new messages
let pollInterval;
let lastMsgId = 0;
function startPolling() {
  if (pollInterval) return;
  pollInterval = setInterval(() => {
    vscode.postMessage({ type: 'poll', afterId: lastMsgId });
  }, 4000);
}
function stopPolling() {
  if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopPolling(); else startPolling();
});

vscode.postMessage({ type: 'init' });
</script>
</body>
</html>`;
  }
}
