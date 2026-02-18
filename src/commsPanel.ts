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
  font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, system-ui, sans-serif);
  color: var(--vscode-foreground, #ccc);
  background: var(--vscode-editor-background, #1e1e1e);
  font-size: 13px;
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
  padding: 16px 16px 8px;
  scroll-behavior: smooth;
}
.messages-list::-webkit-scrollbar { width: 6px; }
.messages-list::-webkit-scrollbar-track { background: transparent; }
.messages-list::-webkit-scrollbar-thumb {
  background: var(--vscode-scrollbarSlider-background, rgba(255,255,255,0.1));
  border-radius: 3px;
}
.messages-list::-webkit-scrollbar-thumb:hover {
  background: var(--vscode-scrollbarSlider-hoverBackground, rgba(255,255,255,0.2));
}

/* Empty state */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  opacity: 0.4;
  user-select: none;
}
.empty-state .icon { font-size: 48px; margin-bottom: 12px; }
.empty-state .label { font-size: 14px; }

/* Message groups */
.msg-group { margin-bottom: 12px; display: flex; flex-direction: column; }
.msg-group.outgoing { align-items: flex-end; }
.msg-group.incoming { align-items: flex-start; }

.msg-group .group-sender {
  font-size: 11px;
  font-weight: 600;
  color: var(--vscode-textLink-foreground, #3794ff);
  margin-bottom: 3px;
  margin-left: 8px;
}

/* Individual message row */
.msg {
  max-width: 75%;
  position: relative;
  display: flex;
  flex-direction: column;
}
.msg-group.outgoing .msg { align-items: flex-end; }
.msg-group.incoming .msg { align-items: flex-start; }

/* Bubble */
.msg-bubble {
  padding: 7px 12px;
  font-size: 13px;
  line-height: 1.45;
  word-wrap: break-word;
  overflow-wrap: break-word;
  white-space: pre-wrap;
  position: relative;
}
.msg-bubble a {
  color: inherit;
  text-decoration: underline;
  text-underline-offset: 2px;
}
.msg-bubble a:hover { opacity: 0.8; }

/* Incoming bubbles */
.msg-group.incoming .msg-bubble {
  background: var(--vscode-input-background, #2a2d2e);
  border: 1px solid var(--vscode-panel-border, rgba(255,255,255,0.06));
  color: var(--vscode-foreground, #ccc);
}

/* Outgoing bubbles */
.msg-group.outgoing .msg-bubble {
  background: var(--vscode-button-background, #0e639c);
  color: var(--vscode-button-foreground, #fff);
  border: none;
}

/* Border radius — Telegram-style grouped bubbles */
/* Incoming: solo */
.msg-group.incoming .msg.solo .msg-bubble { border-radius: 4px 16px 16px 4px; }
/* Incoming: first of group */
.msg-group.incoming .msg.first .msg-bubble { border-radius: 16px 16px 16px 4px; }
/* Incoming: middle of group */
.msg-group.incoming .msg.middle .msg-bubble { border-radius: 4px 16px 16px 4px; }
/* Incoming: last of group */
.msg-group.incoming .msg.last .msg-bubble { border-radius: 4px 16px 16px 16px; }

/* Outgoing: solo */
.msg-group.outgoing .msg.solo .msg-bubble { border-radius: 16px 4px 4px 16px; }
/* Outgoing: first of group */
.msg-group.outgoing .msg.first .msg-bubble { border-radius: 16px 16px 4px 16px; }
/* Outgoing: middle of group */
.msg-group.outgoing .msg.middle .msg-bubble { border-radius: 16px 4px 4px 16px; }
/* Outgoing: last of group */
.msg-group.outgoing .msg.last .msg-bubble { border-radius: 16px 4px 16px 16px; }

/* Spacing between messages in a group */
.msg + .msg { margin-top: 2px; }

/* Timestamp — shown on last msg of group or on hover */
.msg-time {
  font-size: 10px;
  opacity: 0;
  margin-top: 2px;
  padding: 0 4px;
  color: var(--vscode-descriptionForeground, #888);
  transition: opacity 0.15s;
  user-select: none;
  white-space: nowrap;
}
.msg-time.visible { opacity: 0.5; }
.msg:hover .msg-time { opacity: 0.5; }

/* Emoji-only messages */
.msg-bubble.emoji-only {
  background: transparent !important;
  border: none !important;
  padding: 2px 4px;
  font-size: 32px;
  line-height: 1.2;
}

/* Composer */
.composer {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 10px 16px 12px;
  border-top: 1px solid var(--vscode-panel-border, rgba(255,255,255,0.08));
  flex-shrink: 0;
  background: var(--vscode-editor-background, #1e1e1e);
}
.composer textarea {
  flex: 1;
  padding: 8px 14px;
  background: var(--vscode-input-background, #2a2a2a);
  color: var(--vscode-input-foreground, #ccc);
  border: 1px solid var(--vscode-input-border, rgba(255,255,255,0.1));
  border-radius: 18px;
  font-size: 13px;
  font-family: inherit;
  line-height: 1.4;
  outline: none;
  resize: none;
  max-height: 120px;
  overflow-y: auto;
  rows: 1;
}
.composer textarea:focus {
  border-color: var(--vscode-focusBorder, #007acc);
}
.composer textarea::placeholder {
  color: var(--vscode-input-placeholderForeground, #666);
}
.send-btn {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  border: none;
  background: var(--vscode-button-background, #0e639c);
  color: var(--vscode-button-foreground, #fff);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: background 0.15s, transform 0.1s;
}
.send-btn:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
.send-btn:active { transform: scale(0.92); }
.send-btn svg { width: 16px; height: 16px; fill: currentColor; }

/* Loading & error */
.loading {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  opacity: 0.4;
}
.error {
  color: var(--vscode-errorForeground, #f44);
  padding: 8px 16px;
  font-size: 12px;
  background: var(--vscode-inputValidation-errorBackground, rgba(255,0,0,0.1));
  border-top: 1px solid var(--vscode-inputValidation-errorBorder, rgba(255,0,0,0.3));
  flex-shrink: 0;
}
</style>
</head>
<body>
<div class="messages-list" id="messagesList">
  <div class="loading">Loading…</div>
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
  for (const g of groups) {
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
      const content = emoji ? esc(m.text) : linkify(esc(m.text));
      html += '<div class="msg ' + pos + '">' +
        '<div class="' + bubbleCls + '">' + content + '</div>' +
        '<div class="msg-time' + (isLast ? ' visible' : '') + '">' + formatTime(m.timestamp) + '</div>' +
        '</div>';
    }
    html += '</div>';
  }

  messagesList.innerHTML = html;
  messagesList.scrollTop = messagesList.scrollHeight;
}

// Auto-grow textarea
function autoGrow() {
  msgInput.style.height = 'auto';
  msgInput.style.height = Math.min(msgInput.scrollHeight, 120) + 'px';
}
msgInput.addEventListener('input', autoGrow);

function doSend() {
  const text = msgInput.value.trim();
  if (!text) return;
  msgInput.value = '';
  msgInput.style.height = 'auto';
  vscode.postMessage({ type: 'sendMessage', text });
}
sendBtn.addEventListener('click', doSend);
msgInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    doSend();
  }
});

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
