import * as vscode from 'vscode';
import { TelegramService, DialogInfo, MessageInfo } from './services/telegram';

export class CommsWebviewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private telegram: TelegramService;
  private connecting = false;

  constructor(private readonly extensionUri: vscode.Uri) {
    this.telegram = new TelegramService();
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.getHtml();

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      try {
        switch (msg.type) {
          case 'init':
            await this.ensureConnected();
            await this.sendPinnedDialogs();
            break;
          case 'search':
            await this.ensureConnected();
            const results = await this.telegram.searchDialogs(msg.query);
            this.postMessage({ type: 'searchResults', dialogs: results });
            break;
          case 'openChat':
            await this.ensureConnected();
            const messages = await this.telegram.getMessages(msg.chatId, 50);
            this.postMessage({ type: 'messages', chatId: msg.chatId, chatName: msg.chatName, messages });
            break;
          case 'sendMessage':
            await this.ensureConnected();
            await this.telegram.sendMessage(msg.chatId, msg.text);
            const updated = await this.telegram.getMessages(msg.chatId, 50);
            this.postMessage({ type: 'messages', chatId: msg.chatId, chatName: msg.chatName, messages: updated });
            break;
          case 'pin':
            this.telegram.pinDialog(msg.chatId);
            await this.sendPinnedDialogs();
            break;
          case 'unpin':
            this.telegram.unpinDialog(msg.chatId);
            await this.sendPinnedDialogs();
            break;
        }
      } catch (err: any) {
        this.postMessage({ type: 'error', message: err.message || 'Unknown error' });
      }
    });
  }

  private async ensureConnected(): Promise<void> {
    if (this.connecting) { return; }
    this.connecting = true;
    try {
      await this.telegram.connect();
    } finally {
      this.connecting = false;
    }
  }

  private async sendPinnedDialogs(): Promise<void> {
    const pinnedIds = this.telegram.getPinnedIds();
    if (pinnedIds.length === 0) {
      this.postMessage({ type: 'dialogs', dialogs: [] });
      return;
    }
    const all = await this.telegram.getDialogs(200);
    const pinned = all.filter(d => pinnedIds.includes(d.id));
    pinned.forEach(d => d.isPinned = true);
    this.postMessage({ type: 'dialogs', dialogs: pinned });
  }

  private postMessage(msg: any): void {
    this.view?.webview.postMessage(msg);
  }

  private getHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: var(--vscode-font-family, system-ui);
  color: var(--vscode-foreground, #ccc);
  background: var(--vscode-sideBar-background, #1e1e1e);
  font-size: 12px;
  height: 100vh;
  display: flex;
  flex-direction: column;
}
.header {
  padding: 8px;
  border-bottom: 1px solid var(--vscode-panel-border, #333);
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.header .back {
  cursor: pointer;
  font-size: 16px;
  display: none;
  padding: 2px 6px;
  border-radius: 4px;
}
.header .back:hover { background: var(--vscode-list-hoverBackground, #2a2a2a); }
.header .title { font-weight: 600; font-size: 13px; flex: 1; }
input[type="text"] {
  width: 100%;
  padding: 6px 8px;
  background: var(--vscode-input-background, #2a2a2a);
  color: var(--vscode-input-foreground, #ccc);
  border: 1px solid var(--vscode-input-border, #444);
  border-radius: 4px;
  font-size: 12px;
  outline: none;
}
input[type="text"]:focus { border-color: var(--vscode-focusBorder, #007acc); }
.search-bar { padding: 6px 8px; flex-shrink: 0; }
.content { flex: 1; overflow-y: auto; }

/* Chat list */
.chat-item {
  display: flex;
  align-items: center;
  padding: 8px;
  gap: 8px;
  cursor: pointer;
  border-bottom: 1px solid var(--vscode-panel-border, #2a2a2a);
}
.chat-item:hover { background: var(--vscode-list-hoverBackground, #2a2a2a); }
.avatar {
  width: 32px; height: 32px;
  border-radius: 50%;
  background: var(--vscode-badge-background, #4a4a4a);
  color: var(--vscode-badge-foreground, #fff);
  display: flex; align-items: center; justify-content: center;
  font-size: 11px; font-weight: 600;
  flex-shrink: 0;
}
.chat-info { flex: 1; min-width: 0; }
.chat-name { font-weight: 600; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.chat-preview { font-size: 11px; opacity: 0.6; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px; }
.chat-meta { text-align: right; flex-shrink: 0; }
.chat-time { font-size: 10px; opacity: 0.5; }
.chat-unread {
  background: var(--vscode-badge-background, #007acc);
  color: var(--vscode-badge-foreground, #fff);
  font-size: 10px; border-radius: 10px;
  padding: 1px 5px; margin-top: 3px;
  display: inline-block;
}
.pin-btn, .unpin-btn {
  cursor: pointer; padding: 2px 4px; border-radius: 3px;
  flex-shrink: 0; font-size: 14px;
}
.pin-btn:hover, .unpin-btn:hover { background: var(--vscode-list-hoverBackground, #333); }

/* Messages */
.messages-list { flex: 1; overflow-y: auto; padding: 8px; }
.msg {
  margin-bottom: 8px;
  max-width: 85%;
}
.msg.outgoing { margin-left: auto; }
.msg-sender { font-size: 10px; font-weight: 600; color: var(--vscode-textLink-foreground, #3794ff); margin-bottom: 2px; }
.msg-bubble {
  background: var(--vscode-editor-background, #252526);
  padding: 6px 10px;
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.4;
  word-wrap: break-word;
}
.msg.outgoing .msg-bubble {
  background: var(--vscode-button-background, #0e639c);
  color: var(--vscode-button-foreground, #fff);
}
.msg-time { font-size: 9px; opacity: 0.4; margin-top: 2px; }
.composer {
  display: flex;
  gap: 6px;
  padding: 8px;
  border-top: 1px solid var(--vscode-panel-border, #333);
  flex-shrink: 0;
}
.composer input { flex: 1; }
.composer button {
  background: var(--vscode-button-background, #0e639c);
  color: var(--vscode-button-foreground, #fff);
  border: none;
  padding: 6px 12px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
}
.composer button:hover { background: var(--vscode-button-hoverBackground, #1177bb); }

.empty { text-align: center; padding: 24px; opacity: 0.5; }
.error { color: var(--vscode-errorForeground, #f44); padding: 8px; font-size: 11px; }
.loading { text-align: center; padding: 16px; opacity: 0.5; }

/* Views */
.view { display: none; flex-direction: column; height: 100%; }
.view.active { display: flex; }
</style>
</head>
<body>

<div id="chatListView" class="view active">
  <div class="header">
    <span class="title">💬 Comms</span>
  </div>
  <div class="search-bar">
    <input type="text" id="searchInput" placeholder="Search chats..." />
  </div>
  <div class="content" id="chatList">
    <div class="loading">Connecting...</div>
  </div>
  <div id="searchResults" style="display:none" class="content"></div>
</div>

<div id="messageView" class="view">
  <div class="header">
    <span class="back" id="backBtn">←</span>
    <span class="title" id="chatTitle"></span>
  </div>
  <div class="messages-list" id="messagesList"></div>
  <div class="composer">
    <input type="text" id="msgInput" placeholder="Type a message..." />
    <button id="sendBtn">Send</button>
  </div>
</div>

<div id="errorBox" class="error" style="display:none"></div>

<script>
const vscode = acquireVsCodeApi();
let currentChatId = null;
let currentChatName = null;

// Elements
const chatListView = document.getElementById('chatListView');
const messageView = document.getElementById('messageView');
const chatList = document.getElementById('chatList');
const searchResults = document.getElementById('searchResults');
const searchInput = document.getElementById('searchInput');
const messagesList = document.getElementById('messagesList');
const chatTitle = document.getElementById('chatTitle');
const backBtn = document.getElementById('backBtn');
const msgInput = document.getElementById('msgInput');
const sendBtn = document.getElementById('sendBtn');
const errorBox = document.getElementById('errorBox');

function showView(view) {
  chatListView.classList.remove('active');
  messageView.classList.remove('active');
  view.classList.add('active');
  if (view === messageView) {
    backBtn.style.display = 'block';
  }
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function renderDialogs(dialogs, container, showPinBtn) {
  if (!dialogs.length) {
    container.innerHTML = '<div class="empty">No pinned chats yet.<br>Search to find and pin chats.</div>';
    return;
  }
  container.innerHTML = dialogs.map(d => {
    const actionBtn = showPinBtn
      ? (d.isPinned ? '' : '<span class="pin-btn" data-id="' + d.id + '" data-name="' + esc(d.name) + '">📌</span>')
      : '<span class="unpin-btn" data-id="' + d.id + '" title="Unpin">✕</span>';
    return '<div class="chat-item" data-id="' + d.id + '" data-name="' + esc(d.name) + '">' +
      '<div class="avatar">' + esc(d.initials) + '</div>' +
      '<div class="chat-info"><div class="chat-name">' + esc(d.name) + '</div>' +
      '<div class="chat-preview">' + esc(d.lastMessage.slice(0, 60)) + '</div></div>' +
      '<div class="chat-meta"><div class="chat-time">' + formatTime(d.lastMessageTime) + '</div>' +
      (d.unreadCount > 0 ? '<div class="chat-unread">' + d.unreadCount + '</div>' : '') + '</div>' +
      actionBtn + '</div>';
  }).join('');

  // Click handlers
  container.querySelectorAll('.chat-item').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.pin-btn') || e.target.closest('.unpin-btn')) return;
      const id = el.dataset.id;
      const name = el.dataset.name;
      openChat(id, name);
    });
  });
  container.querySelectorAll('.pin-btn').forEach(el => {
    el.addEventListener('click', () => vscode.postMessage({ type: 'pin', chatId: el.dataset.id }));
  });
  container.querySelectorAll('.unpin-btn').forEach(el => {
    el.addEventListener('click', () => vscode.postMessage({ type: 'unpin', chatId: el.dataset.id }));
  });
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}

function openChat(id, name) {
  currentChatId = id;
  currentChatName = name;
  chatTitle.textContent = name;
  messagesList.innerHTML = '<div class="loading">Loading...</div>';
  showView(messageView);
  vscode.postMessage({ type: 'openChat', chatId: id, chatName: name });
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

// Search
let searchTimeout;
searchInput.addEventListener('input', () => {
  const q = searchInput.value.trim();
  if (!q) {
    searchResults.style.display = 'none';
    chatList.style.display = 'block';
    return;
  }
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    vscode.postMessage({ type: 'search', query: q });
  }, 300);
});

// Back
backBtn.addEventListener('click', () => {
  currentChatId = null;
  showView(chatListView);
  searchInput.value = '';
  searchResults.style.display = 'none';
  chatList.style.display = 'block';
  vscode.postMessage({ type: 'init' });
});

// Send
function doSend() {
  const text = msgInput.value.trim();
  if (!text || !currentChatId) return;
  msgInput.value = '';
  vscode.postMessage({ type: 'sendMessage', chatId: currentChatId, chatName: currentChatName, text });
}
sendBtn.addEventListener('click', doSend);
msgInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSend(); });

// Messages from extension
window.addEventListener('message', (event) => {
  const msg = event.data;
  switch (msg.type) {
    case 'dialogs':
      renderDialogs(msg.dialogs, chatList, false);
      break;
    case 'searchResults':
      searchResults.style.display = 'block';
      chatList.style.display = 'none';
      renderDialogs(msg.dialogs, searchResults, true);
      break;
    case 'messages':
      renderMessages(msg.messages);
      break;
    case 'error':
      errorBox.textContent = msg.message;
      errorBox.style.display = 'block';
      setTimeout(() => errorBox.style.display = 'none', 5000);
      break;
  }
});

// Init
vscode.postMessage({ type: 'init' });
</script>
</body>
</html>`;
  }
}
