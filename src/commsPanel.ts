import * as vscode from 'vscode';
import { TelegramService } from './services/telegram';

// Shared telegram service across all panels
let sharedTelegram: TelegramService | undefined;
function getTelegram(): TelegramService {
  if (!sharedTelegram) sharedTelegram = new TelegramService();
  return sharedTelegram;
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
    return '<div class="chat-item" data-id="' + d.id + '" data-name="' + esc(d.name) + '">' +
      '<div class="avatar">' + esc(d.initials) + '</div>' +
      '<div class="chat-info"><div class="chat-name">' + esc(d.name) + '</div>' +
      '<div class="chat-preview">' + esc(d.lastMessage.slice(0, 80)) + '</div></div>' +
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

    this.panel.onDidDispose(() => {
      ChatTab.tabs.delete(this.chatId);
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
            await tg.sendMessage(this.chatId, msg.text);
            const updated = await tg.getMessages(this.chatId, 50);
            this.panel.webview.postMessage({ type: 'messages', messages: updated });
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
body {
  font-family: var(--vscode-font-family, system-ui);
  color: var(--vscode-foreground, #ccc);
  background: var(--vscode-editor-background, #1e1e1e);
  font-size: 13px;
  height: 100vh;
  display: flex;
  flex-direction: column;
}
.messages-list { flex: 1; overflow-y: auto; padding: 12px 16px; }
.msg { margin-bottom: 10px; max-width: 70%; }
.msg.outgoing { margin-left: auto; }
.msg-sender { font-size: 11px; font-weight: 600; color: var(--vscode-textLink-foreground, #3794ff); margin-bottom: 3px; }
.msg-bubble {
  background: var(--vscode-editor-background, #252526);
  border: 1px solid var(--vscode-panel-border, #333);
  padding: 8px 12px;
  border-radius: 12px;
  font-size: 13px;
  line-height: 1.5;
  word-wrap: break-word;
}
.msg.outgoing .msg-bubble {
  background: var(--vscode-button-background, #0e639c);
  color: var(--vscode-button-foreground, #fff);
  border-color: transparent;
}
.msg-time { font-size: 10px; opacity: 0.4; margin-top: 3px; }
.composer {
  display: flex;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--vscode-panel-border, #333);
  flex-shrink: 0;
}
.composer input {
  flex: 1;
  padding: 10px 14px;
  background: var(--vscode-input-background, #2a2a2a);
  color: var(--vscode-input-foreground, #ccc);
  border: 1px solid var(--vscode-input-border, #444);
  border-radius: 8px;
  font-size: 13px;
  outline: none;
}
.composer input:focus { border-color: var(--vscode-focusBorder, #007acc); }
.composer button {
  background: var(--vscode-button-background, #0e639c);
  color: var(--vscode-button-foreground, #fff);
  border: none;
  padding: 10px 18px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 13px;
}
.composer button:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
.loading { text-align: center; padding: 24px; opacity: 0.5; }
.error { color: var(--vscode-errorForeground, #f44); padding: 12px 16px; font-size: 12px; }
</style>
</head>
<body>
<div class="messages-list" id="messagesList">
  <div class="loading">Loading...</div>
</div>
<div class="composer">
  <input type="text" id="msgInput" placeholder="Message ${name}..." autofocus />
  <button id="sendBtn">Send</button>
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

function renderMessages(msgs) {
  messagesList.innerHTML = msgs.map(m => {
    const cls = m.isOutgoing ? 'msg outgoing' : 'msg';
    return '<div class="' + cls + '">' +
      (!m.isOutgoing ? '<div class="msg-sender">' + esc(m.senderName) + '</div>' : '') +
      '<div class="msg-bubble">' + esc(m.text) + '</div>' +
      '<div class="msg-time">' + formatTime(m.timestamp) + '</div></div>';
  }).join('');
  messagesList.scrollTop = messagesList.scrollHeight;
}

function doSend() {
  const text = msgInput.value.trim();
  if (!text) return;
  msgInput.value = '';
  vscode.postMessage({ type: 'sendMessage', text });
}
sendBtn.addEventListener('click', doSend);
msgInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSend(); });

window.addEventListener('message', (event) => {
  const msg = event.data;
  switch (msg.type) {
    case 'messages': renderMessages(msg.messages); break;
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
