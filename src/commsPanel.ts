import * as vscode from 'vscode';
import { TelegramService, ChatEvent, DialogInfo, ConnectionState } from './services/telegram';
import { OpenClawService, AgentSessionInfo, AgentDetailedInfo } from './services/openclaw';
import { highlightMessageCodeBlocks, disposeHighlighter } from './services/highlighter';

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
  private unsubDialogUpdate?: () => void;

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
      if (this.unsubDialogUpdate) this.unsubDialogUpdate();
      this.disposables.forEach(d => d.dispose());
    }, null, this.disposables);

    this.panel.webview.onDidReceiveMessage(async (msg) => {
      const tg = getTelegram();
      try {
        switch (msg.type) {
          case 'init':
            await tg.connect();
            // Subscribe to dialog cache updates (stale-while-revalidate)
            if (!this.unsubDialogUpdate) {
              this.unsubDialogUpdate = tg.onDialogUpdate((dialogs) => {
                this.sendPinnedDialogsFrom(dialogs);
                this.sendRecentChats(dialogs);
              });
            }
            await this.sendPinnedDialogs();
            this.sendRecentChats();
            break;
          case 'searchLocal': {
            // Client-side search from cache — instant
            const cached = tg.searchDialogsFromCache(msg.query);
            const collapsed = msg.groupChatId
              ? cached.filter(d => d.isForum && d.chatId === msg.groupChatId && d.topicId && (d.topicName || '').toLowerCase().includes(msg.query.toLowerCase()))
              : this.collapseForumGroups(cached);
            this.panel.webview.postMessage({ type: msg.groupChatId ? 'topicsList' : 'searchResultsLocal', groupName: msg.groupName, groupChatId: msg.groupChatId, dialogs: collapsed });
            break;
          }
          case 'search':
            await tg.connect();
            const results = msg.groupChatId
              ? (await tg.getDialogs(200)).filter(d => d.isForum && d.chatId === msg.groupChatId && d.topicId && (d.topicName || '').toLowerCase().includes(msg.query.toLowerCase()))
              : this.collapseForumGroups(await tg.searchDialogs(msg.query));
            this.panel.webview.postMessage({ type: msg.groupChatId ? 'topicsList' : 'searchResults', groupName: msg.groupName, groupChatId: msg.groupChatId, dialogs: results });
            break;
          case 'openChat':
            tg.trackRecentChat(msg.chatId);
            ChatTab.createOrShow(msg.chatId, msg.chatName, this.context);
            break;
          case 'getTopics':
            await tg.connect();
            const allDialogs = await tg.getDialogs(200);
            const topics = allDialogs.filter(d => d.isForum && d.groupName === msg.groupName && d.topicId);
            this.panel.webview.postMessage({ type: 'topicsList', groupName: msg.groupName, groupChatId: msg.groupChatId, dialogs: topics });
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

  private sendPinnedDialogsFrom(dialogs: DialogInfo[]): void {
    const tg = getTelegram();
    const pinnedIds = tg.getPinnedIds();
    if (pinnedIds.length === 0) {
      this.panel.webview.postMessage({ type: 'dialogs', dialogs: [] });
      return;
    }
    const pinned = dialogs.filter(d => pinnedIds.includes(d.id));
    pinned.forEach(d => d.isPinned = true);
    this.panel.webview.postMessage({ type: 'dialogs', dialogs: pinned });
  }

  private sendRecentChats(allDialogs?: DialogInfo[]): void {
    const tg = getTelegram();
    const recentEntries = tg.getRecentChats();
    if (recentEntries.length === 0) return;
    const dialogs = allDialogs || tg.getCachedDialogs() || [];
    const recentIds = new Set(recentEntries.map(r => r.id));
    const pinnedIds = new Set(tg.getPinnedIds());
    // Filter: recent but not pinned (pinned already shown)
    const recent = recentEntries
      .filter(r => !pinnedIds.has(r.id))
      .map(r => dialogs.find(d => d.id === r.id))
      .filter(Boolean) as DialogInfo[];
    this.panel.webview.postMessage({ type: 'recentChats', dialogs: recent });
  }

  /** Collapse forum topics into group-level entries for search results */
  private collapseForumGroups(dialogs: DialogInfo[]): DialogInfo[] {
    const pinnedIds = getTelegram().getPinnedIds();
    const forumGroups = new Map<string, { group: DialogInfo, topicCount: number, totalUnread: number, latestTime: number }>();
    const result: DialogInfo[] = [];

    for (const d of dialogs) {
      // Pinned forum topics stay as individual entries
      if (d.isForum && d.topicId && pinnedIds.includes(d.id)) {
        result.push(d);
        continue;
      }
      // Collapse non-pinned forum topics into their group
      if (d.isForum && d.topicId && d.groupName) {
        const key = d.chatId;
        const existing = forumGroups.get(key);
        if (existing) {
          existing.topicCount++;
          existing.totalUnread += d.unreadCount || 0;
          if ((d.lastMessageTime || 0) > existing.latestTime) existing.latestTime = d.lastMessageTime || 0;
        } else {
          forumGroups.set(key, {
            group: { ...d, id: d.chatId, topicId: undefined, topicName: undefined, topicEmoji: undefined, name: d.groupName! },
            topicCount: 1,
            totalUnread: d.unreadCount || 0,
            latestTime: d.lastMessageTime || 0,
          });
        }
        continue;
      }
      result.push(d);
    }

    // Add collapsed forum groups
    for (const [, entry] of forumGroups) {
      const g = entry.group;
      g.unreadCount = entry.totalUnread;
      g.lastMessageTime = entry.latestTime;
      (g as any)._topicCount = entry.topicCount;
      (g as any)._isForumGroup = true;
      result.push(g);
    }

    return result;
  }

  private getHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
:root {
  --tg-bg: #0e1621;
  --tg-bg-secondary: #17212b;
  --tg-surface: #202b36;
  --tg-accent: #6ab2f2;
  --tg-text: #f5f5f5;
  --tg-text-secondary: #6d7f8f;
  --tg-border: #101921;
  --tg-hover: #1e2c3a;
  --tg-selected: #2b5278;
  --tg-unread: #6ab2f2;
  --tg-badge-text: #fff;
  --tg-danger: #e05d5d;
  --tg-green: #8bc34a;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  color: var(--tg-text);
  background: var(--tg-bg);
  font-size: 13px;
  height: 100vh;
  display: flex;
  flex-direction: column;
}
.search-bar { padding: 8px 10px; flex-shrink: 0; background: var(--tg-bg-secondary); }
input[type="text"] {
  width: 100%;
  padding: 8px 12px;
  background: var(--tg-surface);
  color: var(--tg-text);
  border: none;
  border-radius: 20px;
  font-size: 14px;
  outline: none;
}
input[type="text"]::placeholder { color: var(--tg-text-secondary); }
input[type="text"]:focus { background: var(--tg-hover); }
.content { flex: 1; overflow-y: auto; }
.content::-webkit-scrollbar { width: 5px; }
.content::-webkit-scrollbar-thumb { background: var(--tg-surface); border-radius: 3px; }
.chat-item {
  display: flex;
  align-items: center;
  padding: 8px 10px;
  gap: 10px;
  cursor: pointer;
  border-radius: 0;
}
.chat-item:hover { background: var(--tg-hover); }
.chat-item.selected { background: var(--tg-selected); }
.avatar {
  position: relative;
  width: 48px; height: 48px;
  border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 16px; font-weight: 600;
  flex-shrink: 0;
  color: #fff;
}
.chat-info { flex: 1; min-width: 0; }
.chat-name-row { display: flex; align-items: center; gap: 4px; }
.chat-name { font-weight: 500; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--tg-text); flex: 1; min-width: 0; }
.chat-time { font-size: 12px; color: var(--tg-text-secondary); flex-shrink: 0; }
.chat-time.has-unread { color: var(--tg-accent); }
.chat-preview-row { display: flex; align-items: center; gap: 4px; margin-top: 2px; }
.chat-preview { font-size: 13px; color: var(--tg-text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0; }
.chat-group-name { font-size: 11px; color: var(--tg-text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-bottom: 1px; }
.chat-topic-name { font-weight: 500; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--tg-text); }
.topic-badge {
  position: absolute; bottom: -1px; right: -1px;
  width: 18px; height: 18px; border-radius: 50%;
  background: var(--tg-accent);
  color: #fff;
  font-size: 10px; font-weight: 700;
  display: flex; align-items: center; justify-content: center;
  border: 2px solid var(--tg-bg);
}
.unread-badge {
  background: var(--tg-unread);
  color: var(--tg-badge-text);
  font-size: 11px; font-weight: 600; border-radius: 12px;
  padding: 1px 7px; min-width: 20px; text-align: center;
  flex-shrink: 0;
}
.pin-btn, .unpin-btn {
  cursor: pointer; padding: 4px 6px; border-radius: 4px;
  flex-shrink: 0; font-size: 14px; color: var(--tg-text-secondary);
}
.pin-btn:hover, .unpin-btn:hover { background: var(--tg-surface); color: var(--tg-text); }
.forum-chevron {
  font-size: 14px; color: var(--tg-text-secondary); flex-shrink: 0; margin-left: 4px;
}
.topic-count {
  font-size: 11px; color: var(--tg-text-secondary); flex-shrink: 0;
}
.back-btn {
  display: flex; align-items: center; gap: 6px; padding: 10px 12px;
  background: var(--tg-bg-secondary); cursor: pointer; font-size: 14px;
  color: var(--tg-accent); font-weight: 500; flex-shrink: 0;
  border-bottom: 1px solid var(--tg-border);
}
.back-btn:hover { background: var(--tg-hover); }
.empty { text-align: center; padding: 40px 20px; color: var(--tg-text-secondary); font-size: 14px; line-height: 1.6; }
.error { color: var(--tg-danger); padding: 12px 16px; font-size: 12px; background: var(--tg-bg-secondary); }
.loading { text-align: center; padding: 24px; color: var(--tg-text-secondary); }
</style>
</head>
<body>
<div class="search-bar">
  <input type="text" id="searchInput" placeholder="Search chats..." autofocus />
</div>
<div id="backBar" class="back-btn" style="display:none"></div>
<div class="content" id="chatList">
  <div class="loading">Connecting...</div>
</div>
<div id="searchResults" style="display:none" class="content"></div>
<div id="topicsList" style="display:none" class="content"></div>
<div id="errorBox" class="error" style="display:none"></div>

<script>
const vscode = acquireVsCodeApi();
const chatList = document.getElementById('chatList');
const searchResults = document.getElementById('searchResults');
const topicsList = document.getElementById('topicsList');
const searchInput = document.getElementById('searchInput');
const errorBox = document.getElementById('errorBox');
const backBar = document.getElementById('backBar');

const avatarColors = ['#e17076','#eda86c','#a695e7','#7bc862','#6ec9cb','#65aadd','#ee7aae','#6bb2f2'];
function pickColor(id) { return avatarColors[Math.abs(parseInt(id || '0', 10)) % avatarColors.length]; }

let selectedIndex = -1;
let currentForumGroup = null; // { chatId, groupName }

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}

function relativeTime(ts) {
  if (!ts) return '';
  const now = Math.floor(Date.now() / 1000);
  const diff = now - ts;
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff / 60) + 'm';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h';
  const d = new Date(ts * 1000);
  const today = new Date();
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  if (diff < 604800) return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()];
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function updateSelection(container) {
  const items = container.querySelectorAll('.chat-item');
  items.forEach((el, i) => el.classList.toggle('selected', i === selectedIndex));
  if (selectedIndex >= 0 && items[selectedIndex]) {
    items[selectedIndex].scrollIntoView({ block: 'nearest' });
  }
}

function getActiveContainer() {
  if (topicsList.style.display !== 'none') return topicsList;
  if (searchResults.style.display !== 'none') return searchResults;
  return chatList;
}

function showView(view) {
  chatList.style.display = view === 'main' ? 'block' : 'none';
  searchResults.style.display = view === 'search' ? 'block' : 'none';
  topicsList.style.display = view === 'topics' ? 'block' : 'none';
  backBar.style.display = view === 'topics' ? 'flex' : 'none';
  var recentEl = document.getElementById('recentList');
  if (recentEl) recentEl.style.display = view === 'main' ? 'block' : 'none';
  if (view !== 'topics') currentForumGroup = null;
}

function exitTopicsView() {
  showView(searchInput.value.trim() ? 'search' : 'main');
  currentForumGroup = null;
  searchInput.placeholder = 'Search chats...';
  searchInput.value = '';
  selectedIndex = -1;
  searchInput.focus();
}

function enterForumGroup(chatId, groupName) {
  currentForumGroup = { chatId: chatId, groupName: groupName };
  backBar.innerHTML = '\u2190 ' + esc(groupName);
  searchInput.placeholder = 'Search topics in ' + groupName + '...';
  searchInput.value = '';
  showView('topics');
  topicsList.innerHTML = '<div class="loading">Loading topics...</div>';
  vscode.postMessage({ type: 'getTopics', groupChatId: chatId, groupName: groupName });
}

function renderDialogs(dialogs, container, showPinBtn) {
  selectedIndex = -1;
  if (!dialogs.length) {
    container.innerHTML = '<div class="empty">No pinned chats yet.<br>Search to find and pin chats.</div>';
    return;
  }
  container.innerHTML = dialogs.map(d => {
    const isForumGroup = d._isForumGroup;
    const actionBtn = isForumGroup ? '' : (showPinBtn
      ? (d.isPinned ? '' : '<span class="pin-btn" data-id="' + d.id + '">\ud83d\udccc</span>')
      : '<span class="unpin-btn" data-id="' + d.id + '" title="Unpin">\u2715</span>');

    const hasUnread = d.unreadCount > 0;
    const isTopic = d.groupName && d.topicName;
    const color = pickColor(d.chatId || d.id);

    let avatarHtml;
    if (isForumGroup) {
      avatarHtml = '<div class="avatar" style="background:' + color + '">' + esc(d.initials) + '<span class="topic-badge">\u2317</span></div>';
    } else if (isTopic) {
      avatarHtml = '<div class="avatar" style="background:' + color + '">' + esc(d.initials) + '<span class="topic-badge">#</span></div>';
    } else {
      avatarHtml = '<div class="avatar" style="background:' + color + '">' + esc(d.initials) + '</div>';
    }

    const preview = d.lastMessage ? esc(d.lastMessage.slice(0, 80)) : '';
    const timeStr = relativeTime(d.lastMessageTime);
    const timeClass = 'chat-time' + (hasUnread ? ' has-unread' : '');
    const unreadHtml = hasUnread ? '<span class="unread-badge">' + d.unreadCount + '</span>' : '';

    let infoHtml;
    if (isForumGroup) {
      const countLabel = d._topicCount + ' topic' + (d._topicCount !== 1 ? 's' : '');
      infoHtml = '<div class="chat-info">' +
        '<div class="chat-name-row"><span class="chat-name">' + esc(d.name) + '</span><span class="' + timeClass + '">' + timeStr + '</span></div>' +
        '<div class="chat-preview-row"><span class="topic-count">' + countLabel + '</span>' + unreadHtml + '<span class="forum-chevron">\u203a</span></div>' +
      '</div>';
    } else if (isTopic) {
      infoHtml = '<div class="chat-info">' +
        '<div class="chat-name-row"><div class="chat-group-name">\u2317 ' + esc(d.groupName) + '</div><span class="' + timeClass + '">' + timeStr + '</span></div>' +
        '<div class="chat-name-row"><div class="chat-topic-name">' + esc(d.topicEmoji || '') + ' ' + esc(d.topicName) + '</div></div>' +
        '<div class="chat-preview-row"><span class="chat-preview">' + preview + '</span>' + unreadHtml + '</div>' +
      '</div>';
    } else {
      infoHtml = '<div class="chat-info">' +
        '<div class="chat-name-row"><span class="chat-name">' + esc(d.name) + '</span><span class="' + timeClass + '">' + timeStr + '</span></div>' +
        '<div class="chat-preview-row"><span class="chat-preview">' + preview + '</span>' + unreadHtml + '</div>' +
      '</div>';
    }

    const extraData = isForumGroup ? ' data-forum-group="1" data-chat-id="' + d.chatId + '" data-group-name="' + esc(d.name) + '"' : '';
    return '<div class="chat-item" data-id="' + d.id + '" data-name="' + esc(d.name) + '"' + extraData + '>' +
      avatarHtml + infoHtml + actionBtn + '</div>';
  }).join('');

  bindChatItemEvents(container);
}

function renderTopics(dialogs, container) {
  selectedIndex = -1;
  if (!dialogs.length) {
    container.innerHTML = '<div class="empty">No topics found.</div>';
    return;
  }
  container.innerHTML = dialogs.map(d => {
    const hasUnread = d.unreadCount > 0;
    const timeStr = relativeTime(d.lastMessageTime);
    const timeClass = 'chat-time' + (hasUnread ? ' has-unread' : '');
    const unreadHtml = hasUnread ? '<span class="unread-badge">' + d.unreadCount + '</span>' : '';
    const emoji = d.topicEmoji || '\u2317';

    return '<div class="chat-item" data-id="' + d.id + '" data-name="' + esc(d.name) + '">' +
      '<div class="avatar" style="background:transparent;font-size:22px">' + esc(emoji) + '</div>' +
      '<div class="chat-info">' +
        '<div class="chat-name-row"><span class="chat-name">' + esc(d.topicName || d.name) + '</span><span class="' + timeClass + '">' + timeStr + '</span></div>' +
        '<div class="chat-preview-row"><span class="chat-preview">' + (d.lastMessage ? esc(d.lastMessage.slice(0, 80)) : '') + '</span>' + unreadHtml + '</div>' +
      '</div>' +
      (d.isPinned ? '' : '<span class="pin-btn" data-id="' + d.id + '">\ud83d\udccc</span>') +
    '</div>';
  }).join('');

  bindChatItemEvents(container);
}

function bindChatItemEvents(container) {
  container.querySelectorAll('.chat-item').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.pin-btn') || e.target.closest('.unpin-btn')) return;
      if (el.dataset.forumGroup) {
        enterForumGroup(el.dataset.chatId, el.dataset.groupName);
      } else {
        vscode.postMessage({ type: 'openChat', chatId: el.dataset.id, chatName: el.dataset.name });
      }
    });
  });
  container.querySelectorAll('.pin-btn').forEach(el => {
    el.addEventListener('click', () => vscode.postMessage({ type: 'pin', chatId: el.dataset.id }));
  });
  container.querySelectorAll('.unpin-btn').forEach(el => {
    el.addEventListener('click', () => vscode.postMessage({ type: 'unpin', chatId: el.dataset.id }));
  });
}

backBar.addEventListener('click', exitTopicsView);

let searchTimeout;
let apiSearchTimeout;
searchInput.addEventListener('input', () => {
  const q = searchInput.value.trim();
  if (currentForumGroup) {
    clearTimeout(searchTimeout);
    clearTimeout(apiSearchTimeout);
    if (!q) {
      vscode.postMessage({ type: 'getTopics', groupChatId: currentForumGroup.chatId, groupName: currentForumGroup.groupName });
      return;
    }
    // Search within topics: local then API
    vscode.postMessage({ type: 'searchLocal', query: q, groupChatId: currentForumGroup.chatId, groupName: currentForumGroup.groupName });
    apiSearchTimeout = setTimeout(() => vscode.postMessage({ type: 'search', query: q, groupChatId: currentForumGroup.chatId, groupName: currentForumGroup.groupName }), 150);
    return;
  }
  if (!q) { showView('main'); selectedIndex = -1; clearTimeout(searchTimeout); clearTimeout(apiSearchTimeout); return; }
  vscode.postMessage({ type: 'searchLocal', query: q });
  clearTimeout(apiSearchTimeout);
  apiSearchTimeout = setTimeout(() => vscode.postMessage({ type: 'search', query: q }), 150);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    if (currentForumGroup) { exitTopicsView(); return; }
    searchInput.value = '';
    showView('main');
    selectedIndex = -1;
    searchInput.focus();
    return;
  }

  const container = getActiveContainer();
  const items = container.querySelectorAll('.chat-item');
  const count = items.length;
  if (!count) return;

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    selectedIndex = selectedIndex < count - 1 ? selectedIndex + 1 : 0;
    updateSelection(container);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    selectedIndex = selectedIndex > 0 ? selectedIndex - 1 : count - 1;
    updateSelection(container);
  } else if (e.key === 'Enter' && selectedIndex >= 0 && items[selectedIndex]) {
    e.preventDefault();
    const el = items[selectedIndex];
    if (el.dataset.forumGroup) {
      enterForumGroup(el.dataset.chatId, el.dataset.groupName);
    } else {
      vscode.postMessage({ type: 'openChat', chatId: el.dataset.id, chatName: el.dataset.name });
    }
  }
});

window.addEventListener('message', (event) => {
  const msg = event.data;
  switch (msg.type) {
    case 'dialogs': renderDialogs(msg.dialogs, chatList, false); break;
    case 'recentChats':
      if (msg.dialogs && msg.dialogs.length > 0) {
        var recentDiv = document.getElementById('recentList');
        if (!recentDiv) {
          recentDiv = document.createElement('div');
          recentDiv.id = 'recentList';
          chatList.parentNode.insertBefore(recentDiv, chatList);
        }
        recentDiv.innerHTML = '<div style="padding:6px 12px;font-size:12px;color:var(--tg-text-secondary);font-weight:600;text-transform:uppercase;letter-spacing:0.5px">Recent</div>';
        var recentContainer = document.createElement('div');
        recentDiv.appendChild(recentContainer);
        renderDialogs(msg.dialogs, recentContainer, true);
      }
      break;
    case 'searchResultsLocal':
      if (currentForumGroup) {
        showView('topics');
        renderTopics(msg.dialogs, topicsList);
      } else {
        showView('search');
        renderDialogs(msg.dialogs, searchResults, true);
      }
      break;
    case 'searchResults':
      if (currentForumGroup) {
        // Should not happen (search with groupChatId returns topicsList)
        break;
      }
      showView('search');
      renderDialogs(msg.dialogs, searchResults, true);
      break;
    case 'topicsList':
      showView('topics');
      if (!currentForumGroup && msg.groupName) {
        currentForumGroup = { chatId: msg.groupChatId, groupName: msg.groupName };
        backBar.innerHTML = '\u2190 ' + esc(msg.groupName);
        searchInput.placeholder = 'Search topics in ' + msg.groupName + '...';
      }
      renderTopics(msg.dialogs, topicsList);
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
 * Process messages to include syntax-highlighted code blocks.
 * Adds `highlightedCodeBlocks` map to each message that has code entities.
 */
async function addSyntaxHighlighting(messages: any[]): Promise<any[]> {
  const results = await Promise.all(messages.map(async (m: any) => {
    if (!m.text || !m.entities) { return m; }
    const hasCode = m.entities.some((e: any) => e.type === 'pre');
    if (!hasCode) { return m; }
    try {
      const highlighted = await highlightMessageCodeBlocks(m.text, m.entities);
      if (highlighted.size === 0) { return m; }
      // Convert Map to plain object for JSON serialization
      const codeBlocksHtml: Record<number, string> = {};
      highlighted.forEach((html, idx) => { codeBlocksHtml[idx] = html; });
      return { ...m, highlightedCodeBlocks: codeBlocksHtml };
    } catch {
      return m;
    }
  }));
  return results;
}

async function addSyntaxHighlightingSingle(m: any): Promise<any> {
  const result = await addSyntaxHighlighting([m]);
  return result[0];
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
  private unsubscribeEvents?: () => void;
  private unreadCount: number = 0;
  private isActive: boolean = true;

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

  private updateTitle() {
    if (this.unreadCount > 0) {
      this.panel.title = `(${this.unreadCount}) 💬 ${this.chatName}`;
    } else {
      this.panel.title = `💬 ${this.chatName}`;
    }
  }

  private constructor(panel: vscode.WebviewPanel, chatId: string, chatName: string) {
    this.panel = panel;
    this.chatId = chatId;
    this.chatName = chatName;
    this.panel.webview.html = this.getHtml();

    // Track tab visibility for unread badge
    this.panel.onDidChangeViewState((e) => {
      this.isActive = e.webviewPanel.active;
      if (this.isActive) {
        this.unreadCount = 0;
        this.updateTitle();
      }
    }, null, this.disposables);

    // Start OpenClaw session polling if configured
    const openclaw = getOpenClaw();
    if (openclaw.isConfigured) {
      const { chatId: rawChatId, topicId } = TelegramService.parseDialogId(chatId);
      openclaw.startPolling(rawChatId, topicId, (info) => {
        this.panel.webview.postMessage({ type: 'agentInfo', info });
      });
    }

    // Subscribe to connection state changes
    const tgForState = getTelegram();
    const unsubConnState = tgForState.onConnectionStateChange((state, attempt) => {
      this.panel.webview.postMessage({ type: 'connectionState', state, attempt });
    });

    this.panel.onDidDispose(() => {
      ChatTab.tabs.delete(this.chatId);
      if (this.unsubscribeEvents) this.unsubscribeEvents();
      unsubConnState();
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
            const messages = await addSyntaxHighlighting(await tg.getMessages(this.chatId, 20));
            this.panel.webview.postMessage({ type: 'messages', messages });
            // Fetch profile photos for senders
            this.fetchAndSendProfilePhotos(tg, messages);
            // Fetch pinned messages
            tg.getPinnedMessages(this.chatId).then(pinned => {
              if (pinned.length > 0) {
                this.panel.webview.postMessage({ type: 'pinnedMessages', messages: pinned });
              }
            }).catch(() => {});
            // Subscribe to real-time events
            if (!this.unsubscribeEvents) {
              this.unsubscribeEvents = tg.onChatEvent(this.chatId, async (event: ChatEvent) => {
                switch (event.type) {
                  case 'newMessage':
                    if (!this.isActive) {
                      this.unreadCount++;
                      this.updateTitle();
                    }
                    const hlMsg = await addSyntaxHighlightingSingle(event.message);
                    this.panel.webview.postMessage({ type: 'newMessage', message: hlMsg });
                    // Fetch profile photo for new sender
                    if (hlMsg.senderId && !hlMsg.isOutgoing) {
                      this.fetchAndSendProfilePhotos(tg, [hlMsg]);
                    }
                    break;
                  case 'editMessage':
                    this.panel.webview.postMessage({ type: 'editMessage', message: await addSyntaxHighlightingSingle(event.message) });
                    break;
                  case 'deleteMessages':
                    this.panel.webview.postMessage({ type: 'deleteMessages', messageIds: event.messageIds });
                    break;
                  case 'typing':
                    this.panel.webview.postMessage({ type: 'typing', userId: event.userId, userName: event.userName });
                    break;
                  case 'readOutbox':
                    this.panel.webview.postMessage({ type: 'readOutbox', maxId: event.maxId });
                    break;
                  case 'reconnected':
                    // Fetch missed messages after reconnect
                    try {
                      const missed = await tg.fetchMissedMessages(this.chatId);
                      if (missed.length > 0) {
                        const hlMissed = await addSyntaxHighlighting(missed);
                        for (const m of hlMissed) {
                          tg.trackMessageId(this.chatId, m.id);
                          this.panel.webview.postMessage({ type: 'newMessage', message: m });
                        }
                      }
                    } catch { /* ignore */ }
                    break;
                  default:
                    // Handle messagesRefreshed from cache background refresh
                    if ((event as any).type === 'messagesRefreshed') {
                      const refreshed = await addSyntaxHighlighting((event as any).messages);
                      this.panel.webview.postMessage({ type: 'messages', messages: refreshed });
                    }
                    break;
                }
              });
            }
            break;
          case 'sendMessage':
            await tg.connect();
            try {
              await tg.sendMessage(this.chatId, msg.text, msg.replyToId);
              this.panel.webview.postMessage({ type: 'sendSuccess', tempId: msg.tempId });
            } catch (sendErr: any) {
              this.panel.webview.postMessage({ type: 'sendFailed', tempId: msg.tempId, error: sendErr.message || 'Send failed' });
            }
            break;
          case 'sendFile':
            await tg.connect();
            try {
              const fileBuffer = Buffer.from(msg.data, 'base64');
              await tg.sendFile(this.chatId, fileBuffer, msg.fileName, msg.mimeType, msg.caption);
              this.panel.webview.postMessage({ type: 'fileSendSuccess', tempId: msg.tempId });
            } catch (fileErr: any) {
              this.panel.webview.postMessage({ type: 'fileSendFailed', tempId: msg.tempId, error: fileErr.message || 'File send failed' });
            }
            break;
          case 'downloadFile':
            await tg.connect();
            try {
              this.panel.webview.postMessage({ type: 'downloadProgress', messageId: msg.messageId, progress: 0 });
              const fileResult = await tg.downloadFile(this.chatId, msg.messageId, (downloaded, total) => {
                const pct = total > 0 ? Math.round((downloaded / total) * 100) : 0;
                this.panel.webview.postMessage({ type: 'downloadProgress', messageId: msg.messageId, progress: pct });
              });
              // Save file using VS Code save dialog
              const uri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(fileResult.fileName),
                filters: { 'All Files': ['*'] }
              });
              if (uri) {
                await vscode.workspace.fs.writeFile(uri, fileResult.buffer);
                this.panel.webview.postMessage({ type: 'downloadComplete', messageId: msg.messageId });
              } else {
                this.panel.webview.postMessage({ type: 'downloadComplete', messageId: msg.messageId });
              }
            } catch (dlErr: any) {
              this.panel.webview.postMessage({ type: 'downloadError', messageId: msg.messageId, error: dlErr.message || 'Download failed' });
            }
            break;
          case 'editMessage':
            await tg.connect();
            try {
              await tg.editMessage(this.chatId, msg.messageId, msg.text);
              this.panel.webview.postMessage({ type: 'editSuccess', messageId: msg.messageId });
            } catch (editErr: any) {
              this.panel.webview.postMessage({ type: 'editFailed', messageId: msg.messageId, error: editErr.message || 'Edit failed' });
            }
            break;
          case 'getUserInfo':
            await tg.connect();
            try {
              const userInfo = await tg.getUserInfo(msg.userId);
              this.panel.webview.postMessage({ type: 'userInfo', info: userInfo });
            } catch (uErr: any) {
              this.panel.webview.postMessage({ type: 'userInfoError', error: uErr.message || 'Failed to fetch user info' });
            }
            break;
          case 'searchMessages':
            await tg.connect();
            const searchResults = await addSyntaxHighlighting(await tg.searchMessages(this.chatId, msg.query, msg.limit || 20));
            this.panel.webview.postMessage({ type: 'searchResults', messages: searchResults });
            break;
          case 'deleteMessage':
            await tg.connect();
            try {
              await tg.deleteMessages(this.chatId, msg.messageIds, msg.revoke);
              this.panel.webview.postMessage({ type: 'deleteMessages', messageIds: msg.messageIds });
            } catch (delErr: any) {
              this.panel.webview.postMessage({ type: 'deleteError', error: delErr.message || 'Delete failed' });
            }
            break;
          case 'downloadVideo':
            await tg.connect();
            try {
              const videoDataUrl = await tg.downloadVideo(this.chatId, msg.messageId);
              this.panel.webview.postMessage({ type: 'videoData', messageId: msg.messageId, dataUrl: videoDataUrl });
            } catch (vErr: any) {
              this.panel.webview.postMessage({ type: 'videoData', messageId: msg.messageId, error: vErr.message || 'Download failed' });
            }
            break;
          case 'loadOlder':
            await tg.connect();
            const older = await addSyntaxHighlighting(await tg.getMessages(this.chatId, 30, msg.beforeId));
            this.panel.webview.postMessage({ type: 'olderMessages', messages: older });
            this.fetchAndSendProfilePhotos(tg, older);
            break;
          case 'tabFocused':
            this.unreadCount = 0;
            this.updateTitle();
            break;
          case 'sendTyping':
            await tg.connect();
            await tg.sendTyping(this.chatId);
            break;
          case 'poll':
            await tg.connect();
            const polled = await tg.getMessages(this.chatId, 50);
            // Only send update if there are new messages
            const lastKnown = msg.afterId || 0;
            const hasNew = polled.some((m: any) => m.id > lastKnown);
            if (hasNew) {
              this.panel.webview.postMessage({ type: 'messages', messages: await addSyntaxHighlighting(polled) });
            }
            break;
          case 'getAgentDetails': {
            const openclaw = getOpenClaw();
            const { chatId: rawChatId, topicId: rawTopicId } = TelegramService.parseDialogId(this.chatId);
            const details = openclaw.getDetailedSession(rawChatId, rawTopicId);
            this.panel.webview.postMessage({ type: 'agentDetails', data: details });
            break;
          }
        }
      } catch (err: any) {
        this.panel.webview.postMessage({ type: 'error', message: err.message || 'Unknown error' });
      }
    }, null, this.disposables);
  }

  /**
   * Fetch profile photos for unique senders in messages and send to webview.
   */
  private async fetchAndSendProfilePhotos(tg: TelegramService, messages: any[]): Promise<void> {
    const senderIds = [...new Set(
      messages
        .filter((m: any) => m.senderId && !m.isOutgoing)
        .map((m: any) => String(m.senderId))
    )];
    if (senderIds.length === 0) return;

    // Only fetch those not already cached
    const toFetch = senderIds.filter(id => tg.getProfilePhoto(id) === undefined);
    if (toFetch.length === 0) {
      // Send cached values
      const photos: Record<string, string> = {};
      for (const id of senderIds) {
        const cached = tg.getProfilePhoto(id);
        if (cached) photos[id] = cached;
      }
      if (Object.keys(photos).length > 0) {
        this.panel.webview.postMessage({ type: 'profilePhotos', photos });
      }
      return;
    }

    try {
      const result = await tg.fetchProfilePhotos(toFetch);
      const photos: Record<string, string> = {};
      for (const id of senderIds) {
        const cached = tg.getProfilePhoto(id);
        if (cached) photos[id] = cached;
      }
      result.forEach((val, key) => {
        if (val) photos[key] = val;
      });
      if (Object.keys(photos).length > 0) {
        this.panel.webview.postMessage({ type: 'profilePhotos', photos });
      }
    } catch { /* ignore photo fetch errors */ }
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

/* Avatar + messages row layout */
.msg-group-row {
  display: flex;
  align-items: flex-end;
  gap: 8px;
}
.msg-avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  flex-shrink: 0;
  cursor: pointer;
  overflow: hidden;
  margin-bottom: 2px;
}
.msg-group-content {
  display: flex;
  flex-direction: column;
  min-width: 0;
  align-items: flex-start;
}

.msg-group .group-sender {
  font-size: 13px;
  font-weight: 500;
  margin-bottom: 2px;
  margin-left: 0;
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

/* Read receipt check icons */
.msg-status { display: inline; margin-left: 3px; font-size: 11px; vertical-align: middle; }
.msg-status.sent { color: rgba(255,255,255,0.45); }
.msg-status.read { color: #53bdeb; }
.msg-group:not(.outgoing) .msg-status { display: none; }

/* Optimistic message states */
.msg.optimistic-sending .msg-bubble { opacity: 0.7; }
.msg.optimistic-sending .msg-time::before { content: '🕐 '; font-size: 10px; }
.msg.optimistic-failed .msg-bubble { border-left: 2px solid #e06c75; opacity: 0.85; }
.msg.optimistic-failed .msg-retry { display: inline-block; color: #e06c75; font-size: 11px; cursor: pointer; margin-left: 6px; }
.msg.optimistic-failed .msg-retry:hover { text-decoration: underline; }

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
.msg-file {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 4px;
  cursor: pointer;
  border-radius: 6px;
  transition: background 0.15s;
}
.msg-file:hover { background: rgba(255,255,255,0.05); }
.msg-file-icon {
  width: 40px; height: 40px; border-radius: 8px;
  display: flex; align-items: center; justify-content: center;
  font-size: 18px; flex-shrink: 0;
  background: rgba(106,178,242,0.15);
  color: var(--tg-accent);
}
.msg-file-icon.pdf { background: rgba(224,93,93,0.15); color: #e05d5d; }
.msg-file-icon.img { background: rgba(152,195,121,0.15); color: #98c379; }
.msg-file-icon.archive { background: rgba(229,192,123,0.15); color: #e5c07b; }
.msg-file-icon.code { background: rgba(198,120,221,0.15); color: #c678dd; }
.msg-file-icon.audio { background: rgba(86,182,194,0.15); color: #56b6c2; }
.msg-file-info { flex: 1; min-width: 0; }
.msg-file-name {
  font-size: 14px; font-weight: 500; color: var(--tg-accent);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.msg-file-meta {
  font-size: 12px; color: var(--tg-text-secondary); margin-top: 1px;
}
.msg-file-progress {
  width: 100%; height: 3px; border-radius: 2px;
  background: rgba(255,255,255,0.08); margin-top: 4px; overflow: hidden;
  display: none;
}
.msg-file-progress.active { display: block; }
.msg-file-progress-bar {
  height: 100%; background: var(--tg-accent); border-radius: 2px;
  transition: width 0.2s; width: 0%;
}
.msg-sticker, .msg-gif {
  font-size: 13px;
  padding: 4px 0;
  color: var(--tg-text-secondary);
}

/* Video message */
.msg-video-container {
  position: relative;
  max-width: 320px;
  border-radius: 8px;
  overflow: hidden;
  cursor: pointer;
  margin-bottom: 4px;
  background: #000;
}
.msg-video-container.video-note {
  width: 240px;
  height: 240px;
  border-radius: 50%;
}
.msg-video-container.video-note .msg-video-thumb {
  width: 240px;
  height: 240px;
  object-fit: cover;
}
.msg-video-container.video-note video {
  width: 240px;
  height: 240px;
  object-fit: cover;
  border-radius: 50%;
}
.msg-video-thumb {
  width: 100%;
  display: block;
  border-radius: 8px;
}
.msg-video-play {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 48px;
  height: 48px;
  background: rgba(0,0,0,0.6);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  transition: background 0.15s;
}
.msg-video-container:hover .msg-video-play {
  background: rgba(0,0,0,0.8);
}
.msg-video-play::after {
  content: '';
  display: block;
  width: 0; height: 0;
  border-style: solid;
  border-width: 10px 0 10px 18px;
  border-color: transparent transparent transparent #fff;
  margin-left: 3px;
}
.msg-video-meta {
  position: absolute;
  bottom: 6px;
  left: 6px;
  display: flex;
  gap: 8px;
  font-size: 11px;
  color: #fff;
  text-shadow: 0 1px 3px rgba(0,0,0,0.7);
}
.msg-video-no-thumb {
  width: 100%;
  min-height: 180px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255,255,255,0.05);
  border-radius: 8px;
  color: var(--tg-text-secondary);
  font-size: 13px;
}
.msg-video-loading {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  color: #fff;
  font-size: 12px;
  background: rgba(0,0,0,0.6);
  padding: 6px 12px;
  border-radius: 12px;
}
.msg-video-container video {
  width: 100%;
  border-radius: 8px;
  display: block;
}
.msg-video-fallback {
  font-size: 13px;
  padding: 4px 0;
  color: var(--tg-text-secondary);
}

/* Voice message player */
.voice-player {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 4px;
  min-width: 220px;
  max-width: 300px;
}
.voice-play-btn {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: none;
  background: var(--tg-accent, #3390ec);
  color: #fff;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  font-size: 14px;
  transition: background 0.15s;
}
.voice-play-btn:hover { background: var(--tg-accent-hover, #2b7fd4); }
.voice-waveform-wrap {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.voice-waveform {
  display: flex;
  align-items: flex-end;
  height: 28px;
  gap: 1px;
  cursor: pointer;
  position: relative;
}
.voice-waveform .vw-bar {
  flex: 1;
  min-width: 2px;
  max-width: 4px;
  border-radius: 1px;
  background: var(--tg-text-secondary);
  opacity: 0.35;
  transition: opacity 0.1s;
}
.voice-waveform .vw-bar.vw-played {
  opacity: 1;
  background: var(--tg-accent, #3390ec);
}
.voice-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11px;
  color: var(--tg-text-secondary);
}
.voice-speed-btn {
  background: none;
  border: 1px solid var(--tg-text-secondary);
  border-radius: 8px;
  color: var(--tg-text-secondary);
  font-size: 10px;
  padding: 0 5px;
  cursor: pointer;
  line-height: 16px;
}
.voice-speed-btn:hover { color: var(--tg-accent, #3390ec); border-color: var(--tg-accent, #3390ec); }

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
@keyframes reactionPulse {
  0% { background: rgba(106,178,242,0.15); }
  50% { background: rgba(106,178,242,0.08); }
  100% { background: transparent; }
}
.msg.reaction-flash > .msg-bubble {
  animation: reactionPulse 1s ease-out;
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
  margin: 0;
  font-size: 13px;
}
.msg-bubble pre code {
  background: transparent;
  padding: 0;
}
/* Shiki pre overrides */
.code-block-wrapper pre.shiki {
  background: rgba(0,0,0,0.25) !important;
  padding: 10px 12px;
  border-radius: 0 0 6px 6px;
  overflow-x: auto;
  margin: 0;
  font-size: 13px;
  font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
}
.code-block-wrapper pre.shiki code {
  background: transparent;
  padding: 0;
  font-family: inherit;
}
.code-block-wrapper {
  position: relative;
  margin: 6px 0;
  border-radius: 6px;
  overflow: hidden;
}
.code-block-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: rgba(0,0,0,0.35);
  padding: 4px 10px;
  font-size: 11px;
}
.code-lang {
  color: rgba(255,255,255,0.5);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.copy-code-btn {
  background: transparent;
  border: none;
  color: rgba(255,255,255,0.5);
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 12px;
  transition: all 0.15s;
}
.copy-code-btn:hover {
  background: rgba(255,255,255,0.1);
  color: rgba(255,255,255,0.9);
}
.copy-code-btn.copied {
  color: #4ec9b0;
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

/* Image paste preview bar */
.image-paste-bar {
  display: none;
  align-items: center;
  gap: 10px;
  padding: 8px 16px 8px 14px;
  border-top: 1px solid rgba(255,255,255,0.06);
  border-left: 3px solid #98c379;
  background: var(--tg-composer-bg);
  flex-shrink: 0;
  animation: editBarSlideIn 0.15s ease-out;
}
.image-paste-bar.active { display: flex; }
.image-paste-thumb {
  width: 56px;
  height: 56px;
  border-radius: 6px;
  object-fit: cover;
  flex-shrink: 0;
  background: rgba(0,0,0,0.2);
}
.image-paste-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.image-paste-label { font-size: 13px; font-weight: 500; color: #98c379; }
.image-paste-caption {
  width: 100%;
  padding: 5px 10px;
  background: var(--tg-composer-input-bg);
  color: var(--tg-text);
  border: none;
  border-radius: 8px;
  font-size: 13px;
  font-family: inherit;
  outline: none;
}
.image-paste-caption::placeholder { color: var(--tg-text-secondary); }
.image-paste-caption:focus { background: var(--tg-composer-input-bg); }
.image-paste-actions { display: flex; gap: 6px; flex-shrink: 0; }
.image-paste-send, .image-paste-cancel {
  border: none; border-radius: 6px; padding: 6px 12px; font-size: 13px;
  cursor: pointer; font-family: inherit; font-weight: 500;
}
.image-paste-send { background: #98c379; color: #000; }
.image-paste-send:hover { background: #a9d48a; }
.image-paste-cancel { background: rgba(255,255,255,0.08); color: var(--tg-text-secondary); }
.image-paste-cancel:hover { background: rgba(255,255,255,0.12); color: var(--tg-text); }

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

/* Edit bar */
.edit-bar {
  display: none;
  align-items: center;
  gap: 10px;
  padding: 8px 16px 8px 14px;
  border-top: 1px solid rgba(255,255,255,0.06);
  border-left: 3px solid #3a95d5;
  background: var(--tg-composer-bg);
  flex-shrink: 0;
  animation: editBarSlideIn 0.15s ease-out;
}
.edit-bar.active { display: flex; }
.edit-bar-content { flex: 1; min-width: 0; }
.edit-bar-label { font-size: 13px; font-weight: 500; color: #3a95d5; }
.edit-bar-text { font-size: 13px; color: var(--tg-text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.edit-bar-close {
  cursor: pointer; padding: 4px; border-radius: 50%; opacity: 0.5;
  font-size: 14px; flex-shrink: 0; background: none; border: none;
  color: var(--tg-text);
  width: 28px; height: 28px;
  display: flex; align-items: center; justify-content: center;
}
.edit-bar-close:hover { opacity: 1; background: rgba(255,255,255,0.08); }
@keyframes editBarSlideIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }

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
.ctx-menu-item.danger { color: #e06c75; }
.ctx-menu-item.danger:hover { background: rgba(224,108,117,0.12); }
.ctx-menu-sep { height: 1px; background: rgba(255,255,255,0.08); margin: 4px 0; }
.msg.fade-out { opacity: 0; transform: scale(0.95); transition: opacity 0.3s, transform 0.3s; }

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

/* Drop zone overlay */
.drop-zone-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.65);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.2s ease;
}
.drop-zone-overlay.active {
  opacity: 1;
  pointer-events: auto;
}
.drop-zone-content {
  border: 2px dashed var(--tg-accent);
  border-radius: 16px;
  padding: 48px 64px;
  text-align: center;
  background: rgba(23, 33, 43, 0.9);
}
.drop-zone-icon {
  font-size: 48px;
  margin-bottom: 12px;
}
.drop-zone-text {
  font-size: 16px;
  color: var(--tg-text);
  font-weight: 500;
}

/* File preview bar */
.file-preview-bar {
  background: var(--tg-bg-secondary);
  border-top: 1px solid rgba(255,255,255,0.06);
  padding: 8px 12px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.file-preview-items {
  flex: 1;
  display: flex;
  gap: 8px;
  overflow-x: auto;
  min-width: 0;
}
.file-preview-item {
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--tg-composer-input-bg);
  border-radius: 8px;
  padding: 6px 10px;
  min-width: 0;
  max-width: 200px;
  flex-shrink: 0;
}
.file-preview-item img {
  width: 36px;
  height: 36px;
  object-fit: cover;
  border-radius: 4px;
  flex-shrink: 0;
}
.file-preview-item .file-icon {
  font-size: 20px;
  flex-shrink: 0;
}
.file-preview-item .file-name {
  font-size: 12px;
  color: var(--tg-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.file-preview-item .file-size {
  font-size: 11px;
  color: var(--tg-text-secondary);
  white-space: nowrap;
}
.file-preview-item .file-remove {
  background: none;
  border: none;
  color: var(--tg-text-secondary);
  cursor: pointer;
  font-size: 14px;
  padding: 0 2px;
  flex-shrink: 0;
}
.file-preview-item .file-remove:hover { color: #e06c75; }
.file-preview-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}
.file-preview-cancel, .file-preview-send {
  border: none;
  border-radius: 6px;
  padding: 6px 14px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
}
.file-preview-cancel {
  background: transparent;
  color: var(--tg-text-secondary);
}
.file-preview-cancel:hover { color: var(--tg-text); }
.file-preview-send {
  background: var(--tg-accent);
  color: #fff;
}
.file-preview-send:hover { opacity: 0.85; }

/* Emoji button */
.emoji-btn {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: none;
  background: transparent;
  color: var(--tg-text-secondary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  font-size: 20px;
  transition: background 0.15s, color 0.15s;
}
.emoji-btn:hover { background: rgba(106,178,242,0.1); color: var(--tg-accent); }
.emoji-btn.active { color: var(--tg-accent); }

/* Emoji picker */
.emoji-picker {
  position: absolute;
  bottom: 100%;
  left: 0;
  right: 0;
  max-height: 300px;
  background: var(--tg-bg-secondary, #1e2c3a);
  border-top: 1px solid var(--tg-border, rgba(255,255,255,0.08));
  display: flex;
  flex-direction: column;
  z-index: 200;
  animation: emojiSlideUp 0.15s ease-out;
}
@keyframes emojiSlideUp {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}
.emoji-picker-search {
  padding: 8px;
  flex-shrink: 0;
}
.emoji-picker-search input {
  width: 100%;
  box-sizing: border-box;
  padding: 6px 10px;
  background: var(--tg-composer-input-bg);
  color: var(--tg-text);
  border: 1px solid var(--tg-border, rgba(255,255,255,0.08));
  border-radius: 8px;
  font-size: 13px;
  outline: none;
}
.emoji-picker-search input:focus { border-color: var(--tg-accent); }
.emoji-picker-search input::placeholder { color: var(--tg-text-secondary); }
.emoji-tabs {
  display: flex;
  gap: 2px;
  padding: 0 8px 4px;
  flex-shrink: 0;
  overflow-x: auto;
}
.emoji-tabs::-webkit-scrollbar { display: none; }
.emoji-tab {
  padding: 4px 6px;
  font-size: 18px;
  cursor: pointer;
  border: none;
  background: transparent;
  border-radius: 6px;
  opacity: 0.5;
  transition: opacity 0.15s, background 0.15s;
  flex-shrink: 0;
}
.emoji-tab:hover { opacity: 0.8; background: rgba(255,255,255,0.05); }
.emoji-tab.active { opacity: 1; background: rgba(106,178,242,0.15); }
.emoji-grid-wrap {
  flex: 1;
  overflow-y: auto;
  padding: 0 8px 8px;
}
.emoji-grid-wrap::-webkit-scrollbar { width: 4px; }
.emoji-grid-wrap::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 2px; }
.emoji-cat-label {
  font-size: 11px;
  color: var(--tg-text-secondary);
  padding: 6px 2px 2px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.emoji-grid {
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  gap: 2px;
}
.emoji-grid span {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 20px;
  cursor: pointer;
  border-radius: 6px;
  transition: background 0.1s;
}
.emoji-grid span:hover { background: rgba(255,255,255,0.1); }

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
/* Pinned message banner */
.pinned-banner {
  display: none;
  align-items: center;
  padding: 4px 12px;
  height: 28px;
  background: var(--tg-bg-secondary);
  border-bottom: 1px solid rgba(255,255,255,0.05);
  flex-shrink: 0;
  cursor: pointer;
  transition: background 0.15s;
  gap: 8px;
  font-size: 12px;
  color: var(--tg-text-secondary);
  box-sizing: border-box;
}
.pinned-banner:hover { background: #1e2c3a; }
.pinned-banner .pin-icon { flex-shrink: 0; }
.pinned-banner .pin-text {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--tg-text-primary);
}
.pinned-banner .pin-count {
  font-size: 10px;
  color: var(--tg-accent);
  flex-shrink: 0;
}
.pinned-banner .pin-close {
  flex-shrink: 0;
  background: none;
  border: none;
  color: var(--tg-text-secondary);
  cursor: pointer;
  font-size: 14px;
  padding: 0 2px;
  line-height: 1;
}
.pinned-banner .pin-close:hover { color: var(--tg-text-primary); }
.msg-highlight {
  animation: msgFlash 1.5s ease-out;
}
@keyframes msgFlash {
  0%, 15% { background: rgba(106,166,227,0.25); }
  100% { background: transparent; }
}
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
.agent-subagent-indicator {
  font-size: 11px;
  color: var(--tg-accent);
  display: flex;
  align-items: center;
  gap: 3px;
  white-space: nowrap;
}
.agent-subagent-indicator .pulse {
  animation: subagentPulse 1.5s ease-in-out infinite;
}
@keyframes subagentPulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

/* Agent details expanded panel */
.agent-details-panel {
  max-height: 0;
  overflow: hidden;
  transition: max-height 0.3s ease, padding 0.3s ease;
  background: var(--tg-bg-secondary);
  border-bottom: 1px solid rgba(255,255,255,0.05);
}
.agent-details-panel.expanded {
  max-height: 600px;
  overflow-y: auto;
}
.agent-details-panel::-webkit-scrollbar { width: 4px; }
.agent-details-panel::-webkit-scrollbar-thumb { background: var(--tg-scrollbar); border-radius: 2px; }

.agent-details-content {
  padding: 12px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.agent-details-section {
  background: #1e2c3a;
  border-radius: 8px;
  padding: 10px 12px;
}
.agent-details-section-header {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--tg-text-secondary);
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.agent-details-section-header .icon {
  font-size: 12px;
}

/* Context usage bar */
.context-bar-full {
  height: 8px;
  background: rgba(255,255,255,0.05);
  border-radius: 4px;
  overflow: hidden;
  display: flex;
  margin-bottom: 8px;
}
.context-bar-full .segment {
  height: 100%;
  transition: width 0.3s ease;
}
.context-bar-full .segment.system { background: #6ab2f2; }
.context-bar-full .segment.project { background: #98c379; }
.context-bar-full .segment.skills { background: #c678dd; }
.context-bar-full .segment.tools { background: #e5c07b; }
.context-bar-full .segment.conversation { background: #e06c75; }
.context-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 12px;
  font-size: 11px;
}
.context-legend-item {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--tg-text-secondary);
}
.context-legend-dot {
  width: 8px;
  height: 8px;
  border-radius: 2px;
}
.context-legend-dot.system { background: #6ab2f2; }
.context-legend-dot.project { background: #98c379; }
.context-legend-dot.skills { background: #c678dd; }
.context-legend-dot.tools { background: #e5c07b; }
.context-legend-dot.conversation { background: #e06c75; }
.context-total {
  font-size: 12px;
  color: var(--tg-text);
  margin-top: 8px;
  text-align: right;
}

/* Workspace files list */
.workspace-files-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.workspace-file-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 12px;
  padding: 4px 6px;
  border-radius: 4px;
  background: rgba(255,255,255,0.03);
}
.workspace-file-item.custom {
  border-left: 2px solid var(--tg-accent);
}
.workspace-file-name {
  color: var(--tg-text);
  display: flex;
  align-items: center;
  gap: 4px;
}
.workspace-file-name .truncated {
  color: #e5c07b;
  font-size: 10px;
}
.workspace-file-size {
  color: var(--tg-text-secondary);
  font-size: 11px;
}

/* Skills list */
.skills-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.skills-group-label {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--tg-text-secondary);
  margin-top: 4px;
}
.skills-group-label.bundled { color: #6d7f8f; }
.skills-group-label.workspace { color: #6ab2f2; }
.skills-group-label.custom { color: #c678dd; }
.skills-items {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.skill-chip {
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 4px;
  background: rgba(255,255,255,0.05);
  color: var(--tg-text);
  display: flex;
  align-items: center;
  gap: 4px;
}
.skill-chip .size {
  color: var(--tg-text-secondary);
  font-size: 10px;
}
.skills-total {
  font-size: 11px;
  color: var(--tg-text-secondary);
  margin-top: 4px;
}

/* Tools list */
.tools-summary {
  font-size: 12px;
  color: var(--tg-text);
  margin-bottom: 6px;
}
.tools-list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.tool-chip {
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 3px;
  background: rgba(255,255,255,0.04);
  color: var(--tg-text-secondary);
}

/* Active sessions */
.sessions-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.session-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 12px;
  padding: 6px 8px;
  border-radius: 4px;
  background: rgba(255,255,255,0.03);
}
.session-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.session-key {
  color: var(--tg-text);
  font-size: 11px;
  max-width: 200px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.session-model {
  color: var(--tg-accent);
  font-size: 11px;
}
.session-time {
  color: var(--tg-text-secondary);
  font-size: 10px;
}
.session-status {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #98c379;
  animation: sessionPulse 2s ease-in-out infinite;
}
@keyframes sessionPulse {
  0%, 100% { opacity: 1; box-shadow: 0 0 4px #98c379; }
  50% { opacity: 0.6; box-shadow: none; }
}
.sessions-empty {
  font-size: 12px;
  color: var(--tg-text-secondary);
  font-style: italic;
}

/* User profile popup */
.group-sender { cursor: pointer; }
.group-sender:hover { text-decoration: underline; }

.user-profile-overlay {
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  z-index: 500;
}
.user-profile-popup {
  position: fixed;
  z-index: 501;
  background: var(--tg-bg-secondary);
  border-radius: 12px;
  padding: 20px;
  width: 280px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.6);
  animation: popupFadeIn 0.15s ease;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}
@keyframes popupFadeIn { from { opacity: 0; transform: scale(0.95); } to { opacity: 1; transform: scale(1); } }
.profile-avatar {
  width: 64px; height: 64px;
  border-radius: 50%;
  object-fit: cover;
}
.profile-avatar-placeholder {
  width: 64px; height: 64px;
  border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 24px; font-weight: 600; color: #fff;
}
.profile-name { font-size: 16px; font-weight: 600; color: var(--tg-text); text-align: center; }
.profile-username { font-size: 14px; color: var(--tg-accent); }
.profile-bio { font-size: 13px; color: var(--tg-text-secondary); text-align: center; max-width: 240px; word-break: break-word; }
.profile-detail { font-size: 12px; color: var(--tg-text-secondary); }
.profile-status { font-size: 12px; color: var(--tg-text-secondary); }
.profile-status.online { color: #98c379; }
.profile-loading { color: var(--tg-text-secondary); font-size: 13px; padding: 20px 0; }

/* Search bar */
.search-bar {
  display: none;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  background: var(--tg-bg-secondary);
  border-bottom: 1px solid rgba(255,255,255,0.06);
  flex-shrink: 0;
}
.search-bar.visible { display: flex; }
.search-bar input {
  flex: 1;
  background: var(--tg-composer-input-bg);
  border: none;
  border-radius: 8px;
  padding: 6px 10px;
  color: var(--tg-text);
  font-size: 13px;
  outline: none;
}
.search-bar input::placeholder { color: var(--tg-text-secondary); }
.search-bar .search-count {
  color: var(--tg-text-secondary);
  font-size: 12px;
  white-space: nowrap;
  min-width: 60px;
  text-align: center;
}
.search-bar button {
  background: none;
  border: none;
  color: var(--tg-text-secondary);
  cursor: pointer;
  font-size: 16px;
  padding: 4px 6px;
  border-radius: 4px;
  line-height: 1;
}
.search-bar button:hover { color: var(--tg-text); background: rgba(255,255,255,0.06); }
.msg-bubble.search-highlight { box-shadow: 0 0 0 2px var(--tg-accent); }
.msg-bubble.search-current { box-shadow: 0 0 0 2px #e5c07b; background: rgba(229,192,123,0.12); }

/* Floating date header */
.floating-date {
  position: sticky;
  top: 8px;
  z-index: 10;
  text-align: center;
  pointer-events: none;
  transition: opacity 0.3s ease;
}
.floating-date span {
  font-size: 13px;
  font-weight: 500;
  color: #fff;
  background: var(--tg-date-bg);
  padding: 4px 12px;
  border-radius: 16px;
}
.floating-date.hidden { opacity: 0; }

/* Typing indicator */
.typing-indicator {
  padding: 4px 16px 4px 62px;
  font-size: 12px;
  color: var(--tg-accent);
  height: 20px;
  overflow: hidden;
  flex-shrink: 0;
  opacity: 0;
  transition: opacity 0.2s;
}
.typing-indicator.visible { opacity: 1; }
.typing-indicator .typing-dots {
  display: inline-block;
}
.typing-indicator .typing-dots span {
  animation: typingDot 1.4s infinite;
  display: inline-block;
}
.typing-indicator .typing-dots span:nth-child(2) { animation-delay: 0.2s; }
.typing-indicator .typing-dots span:nth-child(3) { animation-delay: 0.4s; }
@keyframes typingDot {
  0%, 60%, 100% { opacity: 0.3; transform: translateY(0); }
  30% { opacity: 1; transform: translateY(-2px); }
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
    <span class="agent-subagent-indicator" id="agentSubagentIndicator" style="display:none">
      <span class="pulse">🔄</span>
      <span id="agentSubagentCount"></span>
    </span>
    <div class="agent-context-bar">
      <div class="agent-context-fill" id="agentContextFill"></div>
    </div>
    <span class="agent-context-label" id="agentContextLabel"></span>
  </div>
</div>
<!-- Agent details expanded panel -->
<div class="agent-details-panel" id="agentDetailsPanel">
  <div class="agent-details-content" id="agentDetailsContent">
    <!-- Dynamically populated -->
  </div>
</div>
<!-- Pinned message banner -->
<div class="pinned-banner" id="pinnedBanner">
  <span class="pin-icon">📌</span>
  <span class="pin-text" id="pinnedText"></span>
  <span class="pin-count" id="pinnedCount"></span>
  <button class="pin-close" id="pinnedClose" title="Dismiss">✕</button>
</div>
<div class="search-bar" id="searchBar">
  <input type="text" id="searchInput" placeholder="Search messages…" />
  <span class="search-count" id="searchCount"></span>
  <button id="searchUp" title="Previous">▲</button>
  <button id="searchDown" title="Next">▼</button>
  <button id="searchClose" title="Close">✕</button>
</div>
<div class="messages-list" id="messagesList">
  <div class="floating-date hidden" id="floatingDate"><span></span></div>
  <div class="loading">Loading…</div>
</div>
<div class="drop-zone-overlay" id="dropZoneOverlay">
  <div class="drop-zone-content">
    <div class="drop-zone-icon">📎</div>
    <div class="drop-zone-text">Drop files to send</div>
  </div>
</div>
<div class="file-preview-bar" id="filePreviewBar" style="display:none">
  <div class="file-preview-items" id="filePreviewItems"></div>
  <div class="file-preview-actions">
    <button class="file-preview-cancel" id="filePreviewCancel">✕ Cancel</button>
    <button class="file-preview-send" id="filePreviewSend">Send</button>
  </div>
</div>
<button class="new-msgs-btn" id="newMsgsBtn" onclick="scrollToBottom()">↓ New messages</button>
<div class="typing-indicator" id="typingIndicator"></div>
<div class="image-paste-bar" id="imagePasteBar">
  <img class="image-paste-thumb" id="imagePasteThumb" src="" alt="preview" />
  <div class="image-paste-info">
    <div class="image-paste-label">📷 Paste image</div>
    <input class="image-paste-caption" id="imagePasteCaption" type="text" placeholder="Add a caption…" />
  </div>
  <div class="image-paste-actions">
    <button class="image-paste-send" id="imagePasteSend">Send</button>
    <button class="image-paste-cancel" id="imagePasteCancel">✕</button>
  </div>
</div>
<div class="reply-bar" id="replyBar">
  <div class="reply-bar-content">
    <div class="reply-bar-sender" id="replyBarSender"></div>
    <div class="reply-bar-text" id="replyBarText"></div>
  </div>
  <button class="reply-bar-close" id="replyBarClose">✕</button>
</div>
<div class="edit-bar" id="editBar">
  <div class="edit-bar-content">
    <div class="edit-bar-label">✏️ Editing</div>
    <div class="edit-bar-text" id="editBarText"></div>
  </div>
  <button class="edit-bar-close" id="editBarClose">✕</button>
</div>
<div style="position:relative">
  <div class="emoji-picker" id="emojiPicker" style="display:none">
    <div class="emoji-picker-search"><input type="text" id="emojiSearch" placeholder="Search emoji…" /></div>
    <div class="emoji-tabs" id="emojiTabs"></div>
    <div class="emoji-grid-wrap" id="emojiGridWrap"></div>
  </div>
  <div class="composer">
    <textarea id="msgInput" rows="1" placeholder="Message ${name}…" autofocus></textarea>
    <button class="emoji-btn" id="emojiBtn" title="Emoji">😊</button>
    <button class="send-btn" id="sendBtn" title="Send">
      <svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
    </button>
  </div>
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

const avatarColors = ['#e17076','#eda86c','#a695e7','#7bc862','#6ec9cb','#65aadd','#ee7aae','#6bb2f2'];

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatFileSize(bytes) {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
}

function getFileIcon(name, mime) {
  var ext = (name || '').split('.').pop().toLowerCase();
  if (mime === 'application/pdf' || ext === 'pdf') return '📄';
  if (/^image\//.test(mime)) return '🖼️';
  if (/^audio\//.test(mime)) return '🎵';
  if (/^video\//.test(mime)) return '🎬';
  if (/zip|rar|7z|tar|gz|bz2/.test(ext)) return '📦';
  if (/js|ts|py|rb|go|rs|c|cpp|h|java|kt|swift|sh|json|xml|yaml|yml|toml|css|html|sql/.test(ext)) return '💻';
  if (/txt|md|rst|log|csv/.test(ext)) return '📝';
  if (/doc|docx|odt|rtf/.test(ext)) return '📃';
  if (/xls|xlsx|ods/.test(ext)) return '📊';
  if (/ppt|pptx|odp/.test(ext)) return '📊';
  return '📎';
}

function getFileIconClass(name, mime) {
  var ext = (name || '').split('.').pop().toLowerCase();
  if (mime === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (/^image\//.test(mime)) return 'img';
  if (/^audio\//.test(mime)) return 'audio';
  if (/zip|rar|7z|tar|gz|bz2/.test(ext)) return 'archive';
  if (/js|ts|py|rb|go|rs|c|cpp|h|java|kt|swift|sh|json|xml|yaml|yml|toml|css|html|sql/.test(ext)) return 'code';
  return '';
}

function downloadFile(msgId) {
  vscode.postMessage({ type: 'downloadFile', messageId: msgId });
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

function applyEntities(text, entities, msg) {
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
      case 'pre': {
        var hlKey = String(i);
        if (msg && msg.highlightedCodeBlocks && msg.highlightedCodeBlocks[hlKey]) {
          replacement = '<div class="code-block-wrapper">' +
            '<div class="code-block-header"><span class="code-lang">' + esc(e.language || '') + '</span><button class="copy-code-btn" onclick="copyCodeBlock(this)" title="Copy code">📋</button></div>' +
            msg.highlightedCodeBlocks[hlKey] +
            '</div>';
        } else {
          replacement = '<div class="code-block-wrapper">' +
            '<div class="code-block-header"><span class="code-lang">' + esc(e.language || '') + '</span><button class="copy-code-btn" onclick="copyCodeBlock(this)" title="Copy code">📋</button></div>' +
            '<pre><code' + (e.language ? ' class="language-' + esc(e.language) + '"' : '') + '>' + slice + '</code></pre>' +
            '</div>';
        }
        break;
      }
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
      groups.push({ key, isOutgoing: m.isOutgoing, senderName: m.senderName, senderId: m.senderId, msgs: [m] });
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
    if (!g.isOutgoing) {
      // Avatar + messages wrapper for incoming
      var avatarContent = '';
      var sid = g.senderId || '';
      if (profilePhotos[sid]) {
        avatarContent = '<img src="' + profilePhotos[sid] + '" style="width:100%;height:100%;border-radius:50%;object-fit:cover" />';
      } else {
        var initials = (g.senderName || '?').charAt(0).toUpperCase();
        var avatarColor = avatarColors[Math.abs(parseInt(sid || '0', 10)) % avatarColors.length];
        avatarContent = '<span style="color:#fff;font-size:13px;font-weight:600">' + esc(initials) + '</span>';
        avatarContent = '<div style="width:100%;height:100%;border-radius:50%;background:' + avatarColor + ';display:flex;align-items:center;justify-content:center">' + avatarContent + '</div>';
      }
      html += '<div class="msg-group-row">';
      html += '<div class="msg-avatar" data-sender-id="' + esc(sid) + '" onclick="showUserProfile(this, \\'' + esc(sid) + '\\')">' + avatarContent + '</div>';
      html += '<div class="msg-group-content">';
      if (g.senderName) {
        html += '<div class="group-sender" data-sender-id="' + esc(sid) + '" onclick="showUserProfile(this, \\'' + esc(sid) + '\\')">' + esc(g.senderName) + '</div>';
      }
    }
    const len = g.msgs.length;
    for (let i = 0; i < len; i++) {
      const m = g.msgs[i];
      let pos = 'solo';
      if (len > 1) { pos = i === 0 ? 'first' : i === len - 1 ? 'last' : 'middle'; }
      const isLast = i === len - 1;
      const emoji = isEmojiOnly(m.text);
      const bubbleCls = 'msg-bubble' + (emoji ? ' emoji-only' : '');
      const textContent = emoji ? esc(m.text) : applyEntities(m.text, m.entities, m);

      var bubbleInner = '';

      // Forward header
      if (m.forwardFrom) {
        bubbleInner += '<div class="forward-header">Forwarded from <strong>' + esc(m.forwardFrom) + '</strong></div>';
      }

      // Reply quote (skip empty replies — e.g. forum topic root)
      if (m.replyToId && (m.replyToSender || m.replyToText)) {
        bubbleInner += '<div class="reply-quote">';
        if (m.replyToSender) bubbleInner += '<div class="reply-sender">' + esc(m.replyToSender) + '</div>';
        bubbleInner += '<div class="reply-text">' + esc(m.replyToText || '') + '</div>';
        bubbleInner += '</div>';
      }

      // Media
      if (m.mediaType === 'photo' && m.mediaUrl) {
        bubbleInner += '<img class="msg-photo" src="' + esc(m.mediaUrl) + '" onclick="showLightbox(this.src)" />';
      } else if (m.mediaType === 'file') {
        var fName = m.fileName || 'File';
        var fSize = m.fileSize ? formatFileSize(m.fileSize) : '';
        var fMime = m.fileMimeType || '';
        var fIcon = getFileIcon(fName, fMime);
        var fIconClass = getFileIconClass(fName, fMime);
        bubbleInner += '<div class="msg-file" onclick="downloadFile(' + m.id + ')" data-msg-file-id="' + m.id + '">' +
          '<div class="msg-file-icon ' + fIconClass + '">' + fIcon + '</div>' +
          '<div class="msg-file-info">' +
            '<div class="msg-file-name">' + esc(fName) + '</div>' +
            '<div class="msg-file-meta">' + esc(fSize) + (fSize && fMime ? ' · ' : '') + esc(fMime.split('/').pop() || '') + '</div>' +
            '<div class="msg-file-progress" id="file-progress-' + m.id + '"><div class="msg-file-progress-bar"></div></div>' +
          '</div></div>';
      } else if (m.mediaType === 'voice') {
        var voiceDur = m.duration || 0;
        var voiceDurStr = Math.floor(voiceDur / 60) + ':' + ('0' + (voiceDur % 60)).slice(-2);
        var waveformBars = '';
        var waveData = m.waveform && m.waveform.length > 0 ? m.waveform : null;
        var barCount = 40;
        if (waveData) {
          // Resample waveform to barCount bars
          for (var bi = 0; bi < barCount; bi++) {
            var si = Math.floor(bi * waveData.length / barCount);
            var h = Math.max(3, Math.round((waveData[si] / 31) * 28));
            waveformBars += '<div class="vw-bar" style="height:' + h + 'px" data-idx="' + bi + '"></div>';
          }
        } else {
          for (var bi = 0; bi < barCount; bi++) {
            var h = Math.max(3, Math.round(Math.random() * 20 + 4));
            waveformBars += '<div class="vw-bar" style="height:' + h + 'px" data-idx="' + bi + '"></div>';
          }
        }
        var audioSrc = m.mediaUrl ? ' data-src="' + esc(m.mediaUrl) + '"' : '';
        bubbleInner += '<div class="voice-player" data-duration="' + voiceDur + '"' + audioSrc + '>'
          + '<button class="voice-play-btn" onclick="toggleVoice(this)">▶</button>'
          + '<div class="voice-waveform-wrap">'
          + '<div class="voice-waveform" onclick="scrubVoice(event, this)">' + waveformBars + '</div>'
          + '<div class="voice-meta"><span class="voice-time">' + voiceDurStr + '</span>'
          + '<button class="voice-speed-btn" onclick="cycleVoiceSpeed(this)">1×</button></div>'
          + '</div></div>';
      } else if (m.mediaType === 'video') {
        var vidNoteClass = m.isVideoNote ? ' video-note' : '';
        var durationStr = '';
        if (m.duration) {
          var mins = Math.floor(m.duration / 60);
          var secs = m.duration % 60;
          durationStr = mins + ':' + (secs < 10 ? '0' : '') + secs;
        }
        var sizeStr = '';
        if (m.fileSize) {
          if (m.fileSize > 1048576) sizeStr = (m.fileSize / 1048576).toFixed(1) + ' MB';
          else sizeStr = Math.round(m.fileSize / 1024) + ' KB';
        }
        bubbleInner += '<div class="msg-video-container' + vidNoteClass + '" data-msg-id="' + m.id + '" onclick="playVideo(this)">';
        if (m.thumbnailUrl) {
          bubbleInner += '<img class="msg-video-thumb" src="' + esc(m.thumbnailUrl) + '" />';
        } else {
          bubbleInner += '<div class="msg-video-no-thumb">🎬 Video</div>';
        }
        bubbleInner += '<div class="msg-video-play"></div>';
        if (durationStr || sizeStr) {
          bubbleInner += '<div class="msg-video-meta">';
          if (durationStr) bubbleInner += '<span>' + durationStr + '</span>';
          if (sizeStr) bubbleInner += '<span>' + sizeStr + '</span>';
          bubbleInner += '</div>';
        }
        bubbleInner += '</div>';
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
      var optClass = '';
      var retryHtml = '';
      if (m._optimistic === 'sending') optClass = ' optimistic-sending';
      else if (m._optimistic === 'failed') {
        optClass = ' optimistic-failed';
        retryHtml = '<span class="msg-retry" onclick="retryMessage(' + m.id + ')">⚠️ Failed — tap to retry</span>';
      }

      // Read receipt status icon for outgoing messages
      var statusHtml = '';
      if (g.isOutgoing && !m._optimistic) {
        var statusCls = m.status === 'read' ? 'read' : 'sent';
        var statusIcon = m.status === 'read' ? '✓✓' : '✓✓';
        statusHtml = '<span class="msg-status ' + statusCls + '">' + statusIcon + '</span>';
      }

      html += '<div class="msg ' + pos + optClass + '" data-msg-id="' + m.id + '" data-sender="' + esc(m.senderName || '') + '" data-text="' + esc((m.text || '').slice(0, 100)) + '" data-outgoing="' + (g.isOutgoing ? '1' : '0') + '" data-timestamp="' + (m.timestamp || 0) + '">' +
        '<div class="' + bubbleCls + '">' + bubbleInner + '<span class="msg-time' + timeClass + '">' + timeStr + statusHtml + '</span>' + retryHtml + '</div>' +
        reactionsHtml +
        '</div>';
    }
    if (!g.isOutgoing) {
      html += '</div></div>'; // close .msg-group-content and .msg-group-row
    }
    html += '</div>';
  }

  // Check scroll position BEFORE replacing content
  var prevLen = allMessages ? allMessages.length : 0;
  var isFirstRender = messagesList.querySelector('.empty-state') !== null || messagesList.querySelector('.loading') !== null;
  var shouldScroll = isFirstRender || (messagesList.scrollHeight - messagesList.scrollTop - messagesList.clientHeight < 60);
  messagesList.innerHTML = html;
  if (shouldScroll) {
    // Use setTimeout to ensure DOM has fully updated before scrolling
    setTimeout(function() { messagesList.scrollTop = messagesList.scrollHeight; }, 0);
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

// Edit state
const editBar = document.getElementById('editBar');
const editBarText = document.getElementById('editBarText');
const editBarClose = document.getElementById('editBarClose');
let editingMsgId = null;

function setEdit(msgId, text) {
  editingMsgId = msgId;
  editBarText.textContent = (text || '').slice(0, 100);
  editBar.classList.add('active');
  msgInput.value = text || '';
  autoGrow();
  msgInput.focus();
  // Clear reply if active
  clearReply();
}
function clearEdit() {
  editingMsgId = null;
  editBar.classList.remove('active');
  msgInput.value = '';
  msgInput.style.height = 'auto';
}
editBarClose.addEventListener('click', clearEdit);

let optimisticIdCounter = 0;
const pendingOptimistic = new Map(); // tempId -> { text, timestamp }

function doSend() {
  const text = msgInput.value.trim();
  if (!text) return;

  // Handle edit mode
  if (editingMsgId) {
    const msgId = editingMsgId;
    // Optimistic update in-place
    var editIdx = allMessages.findIndex(function(m) { return m.id === msgId; });
    if (editIdx !== -1) {
      allMessages[editIdx].text = text;
      allMessages[editIdx].isEdited = true;
      renderMessages(allMessages);
    }
    vscode.postMessage({ type: 'editMessage', messageId: msgId, text: text });
    clearEdit();
    return;
  }

  msgInput.value = '';
  msgInput.style.height = 'auto';

  // Optimistic: render immediately
  const tempId = --optimisticIdCounter; // negative IDs to avoid collision
  const now = Math.floor(Date.now() / 1000);
  const optimisticMsg = {
    id: tempId,
    text: text,
    isOutgoing: true,
    timestamp: now,
    senderName: '',
    _optimistic: 'sending'
  };
  if (replyToId) optimisticMsg.replyToId = replyToId;

  pendingOptimistic.set(tempId, { text: text, timestamp: now });
  var atBottom = isScrolledToBottom();
  allMessages.push(optimisticMsg);
  renderMessages(allMessages);
  if (atBottom) messagesList.scrollTop = messagesList.scrollHeight;

  // Send in background
  var payload = { type: 'sendMessage', text: text, tempId: tempId };
  if (replyToId) payload.replyToId = replyToId;
  vscode.postMessage(payload);
  clearReply();
}
sendBtn.addEventListener('click', doSend);

// ── Image Paste ──
let pastedImageData = null; // { base64, mimeType }
const imagePasteBar = document.getElementById('imagePasteBar');
const imagePasteThumb = document.getElementById('imagePasteThumb');
const imagePasteCaption = document.getElementById('imagePasteCaption');
const imagePasteSend = document.getElementById('imagePasteSend');
const imagePasteCancel = document.getElementById('imagePasteCancel');

function showImagePaste(dataUrl, mimeType) {
  pastedImageData = { dataUrl: dataUrl, mimeType: mimeType };
  imagePasteThumb.src = dataUrl;
  imagePasteCaption.value = '';
  imagePasteBar.classList.add('active');
  setTimeout(function() { imagePasteCaption.focus(); }, 50);
}

function clearImagePaste() {
  pastedImageData = null;
  imagePasteBar.classList.remove('active');
  imagePasteThumb.src = '';
  imagePasteCaption.value = '';
  msgInput.focus();
}

function sendPastedImage() {
  if (!pastedImageData) return;
  var base64 = pastedImageData.dataUrl.split(',')[1];
  var mimeType = pastedImageData.mimeType;
  var ext = mimeType === 'image/png' ? '.png' : mimeType === 'image/jpeg' ? '.jpg' : mimeType === 'image/webp' ? '.webp' : '.png';
  var caption = imagePasteCaption.value.trim();
  var tempId = --optimisticIdCounter;
  vscode.postMessage({
    type: 'sendFile',
    data: base64,
    fileName: 'paste' + ext,
    mimeType: mimeType,
    caption: caption,
    tempId: tempId
  });
  clearImagePaste();
}

imagePasteSend.addEventListener('click', sendPastedImage);
imagePasteCancel.addEventListener('click', clearImagePaste);
imagePasteCaption.addEventListener('keydown', function(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendPastedImage(); }
  if (e.key === 'Escape') { e.preventDefault(); clearImagePaste(); }
});

msgInput.addEventListener('paste', function(e) {
  var items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    if (item.type && item.type.match(/^image\/(png|jpeg|jpg|webp|gif)$/)) {
      e.preventDefault();
      var blob = item.getAsFile();
      if (!blob) return;
      var reader = new FileReader();
      reader.onload = function(ev) {
        showImagePaste(ev.target.result, item.type);
      };
      reader.readAsDataURL(blob);
      return;
    }
  }
});

// ── Emoji Picker ──
(function() {
  const EMOJI_DATA = {
    'recent': { icon: '🕐', label: 'Recently Used', emoji: [] },
    'smileys': { icon: '😀', label: 'Smileys & People', emoji: [
      ['😀','grinning'],['😃','smiley'],['😄','smile'],['😁','grin'],['😆','laughing'],['😅','sweat smile'],['🤣','rofl'],['😂','joy'],['🙂','slightly smiling'],['🙃','upside down'],['😉','wink'],['😊','blush'],['😇','innocent'],['🥰','smiling hearts'],['😍','heart eyes'],['🤩','star struck'],['😘','kissing heart'],['😗','kissing'],['😚','kissing closed eyes'],['😙','kissing smiling'],['🥲','smiling tear'],['😋','yum'],['😛','stuck out tongue'],['😜','stuck out tongue winking'],['🤪','zany'],['😝','stuck out tongue closed eyes'],['🤑','money mouth'],['🤗','hugs'],['🤭','hand over mouth'],['🤫','shushing'],['🤔','thinking'],['🫡','salute'],['🤐','zipper mouth'],['🤨','raised eyebrow'],['😐','neutral'],['😑','expressionless'],['😶','no mouth'],['🫥','dotted line face'],['😏','smirk'],['😒','unamused'],['🙄','rolling eyes'],['😬','grimacing'],['🤥','lying'],['😌','relieved'],['😔','pensive'],['😪','sleepy'],['🤤','drooling'],['😴','sleeping'],['😷','mask'],['🤒','thermometer face'],['🤕','bandage face'],['🤢','nauseated'],['🤮','vomiting'],['🥵','hot face'],['🥶','cold face'],['🥴','woozy'],['😵','dizzy face'],['🤯','exploding head'],['🤠','cowboy'],['🥳','partying'],['🥸','disguised'],['😎','sunglasses'],['🤓','nerd'],['🧐','monocle'],['😕','confused'],['🫤','diagonal mouth'],['😟','worried'],['🙁','slightly frowning'],['☹️','frowning'],['😮','open mouth'],['😯','hushed'],['😲','astonished'],['😳','flushed'],['🥺','pleading'],['🥹','holding back tears'],['😦','frowning open mouth'],['😧','anguished'],['😨','fearful'],['😰','anxious sweat'],['😥','sad relieved'],['😢','crying'],['😭','sobbing'],['😱','screaming'],['😖','confounded'],['😣','persevering'],['😞','disappointed'],['😓','downcast sweat'],['😩','weary'],['😫','tired'],['🥱','yawning'],['😤','steam nose'],['😡','pouting'],['😠','angry'],['🤬','swearing'],['😈','smiling imp'],['👿','imp'],['💀','skull'],['☠️','skull crossbones'],['💩','poop'],['🤡','clown'],['👹','ogre'],['👺','goblin'],['👻','ghost'],['👽','alien'],['👾','alien monster'],['🤖','robot'],['👋','wave'],['🤚','raised back hand'],['🖐️','hand fingers splayed'],['✋','raised hand'],['🖖','vulcan'],['🫱','rightwards hand'],['🫲','leftwards hand'],['👌','ok hand'],['🤌','pinched fingers'],['🤏','pinching'],['✌️','victory'],['🤞','crossed fingers'],['🫰','hand with index and thumb crossed'],['🤟','love you gesture'],['🤘','rock on'],['🤙','call me'],['👈','point left'],['👉','point right'],['👆','point up'],['🖕','middle finger'],['👇','point down'],['☝️','point up 2'],['🫵','point at viewer'],['👍','thumbs up'],['👎','thumbs down'],['✊','fist'],['👊','punch'],['🤛','left fist'],['🤜','right fist'],['👏','clap'],['🙌','raised hands'],['🫶','heart hands'],['👐','open hands'],['🤲','palms up'],['🤝','handshake'],['🙏','pray'],['💪','muscle'],['🫂','hug people'],['👶','baby'],['👦','boy'],['👧','girl'],['👨','man'],['👩','woman'],['🧑','person'],['👴','old man'],['👵','old woman']
    ]},
    'animals': { icon: '🐱', label: 'Animals & Nature', emoji: [
      ['🐶','dog'],['🐱','cat'],['🐭','mouse'],['🐹','hamster'],['🐰','rabbit'],['🦊','fox'],['🐻','bear'],['🐼','panda'],['🐻‍❄️','polar bear'],['🐨','koala'],['🐯','tiger'],['🦁','lion'],['🐮','cow'],['🐷','pig'],['🐸','frog'],['🐵','monkey'],['🙈','see no evil'],['🙉','hear no evil'],['🙊','speak no evil'],['🐒','monkey 2'],['🐔','chicken'],['🐧','penguin'],['🐦','bird'],['🐤','baby chick'],['🦆','duck'],['🦅','eagle'],['🦉','owl'],['🦇','bat'],['🐺','wolf'],['🐗','boar'],['🐴','horse'],['🦄','unicorn'],['🐝','bee'],['🪱','worm'],['🐛','bug'],['🦋','butterfly'],['🐌','snail'],['🐞','ladybug'],['🐜','ant'],['🪰','fly'],['🪲','beetle'],['🦟','mosquito'],['🪳','cockroach'],['🐢','turtle'],['🐍','snake'],['🦎','lizard'],['🦂','scorpion'],['🕷️','spider'],['🐙','octopus'],['🦑','squid'],['🦐','shrimp'],['🦀','crab'],['🐡','blowfish'],['🐠','tropical fish'],['🐟','fish'],['🐬','dolphin'],['🐳','whale'],['🐋','whale 2'],['🦈','shark'],['🐊','crocodile'],['🐅','tiger 2'],['🐆','leopard'],['🦓','zebra'],['🦍','gorilla'],['🐘','elephant'],['🦛','hippo'],['🦏','rhino'],['🐪','camel'],['🐫','two hump camel'],['🦒','giraffe'],['🐃','water buffalo'],['🐂','ox'],['🐄','cow 2'],['🌵','cactus'],['🎄','christmas tree'],['🌲','evergreen'],['🌳','deciduous tree'],['🌴','palm tree'],['🪵','wood'],['🌱','seedling'],['🌿','herb'],['☘️','shamrock'],['🍀','four leaf clover'],['🌸','cherry blossom'],['🌺','hibiscus'],['🌻','sunflower'],['🌹','rose'],['🌷','tulip'],['🌼','blossom'],['🪷','lotus'],['💐','bouquet'],['🍂','fallen leaf'],['🍁','maple leaf'],['🍃','leaves'],['🪺','nest eggs'],['🪹','empty nest']
    ]},
    'food': { icon: '🍕', label: 'Food & Drink', emoji: [
      ['🍎','apple'],['🍊','orange'],['🍋','lemon'],['🍌','banana'],['🍉','watermelon'],['🍇','grapes'],['🍓','strawberry'],['🫐','blueberries'],['🍈','melon'],['🍒','cherries'],['🍑','peach'],['🥭','mango'],['🍍','pineapple'],['🥥','coconut'],['🥝','kiwi'],['🍅','tomato'],['🥑','avocado'],['🍆','eggplant'],['🥔','potato'],['🥕','carrot'],['🌽','corn'],['🌶️','hot pepper'],['🫑','bell pepper'],['🥒','cucumber'],['🥬','leafy green'],['🥦','broccoli'],['🧄','garlic'],['🧅','onion'],['🍄','mushroom'],['🥜','peanuts'],['🫘','beans'],['🌰','chestnut'],['🍞','bread'],['🥐','croissant'],['🥖','baguette'],['🫓','flatbread'],['🥨','pretzel'],['🧀','cheese'],['🥚','egg'],['🍳','cooking'],['🧈','butter'],['🥞','pancakes'],['🧇','waffle'],['🥓','bacon'],['🥩','cut of meat'],['🍗','poultry leg'],['🍖','meat on bone'],['🌭','hot dog'],['🍔','hamburger'],['🍟','fries'],['🍕','pizza'],['🫔','tamale'],['🥪','sandwich'],['🌮','taco'],['🌯','burrito'],['🫕','fondue'],['🥗','salad'],['🍝','spaghetti'],['🍜','ramen'],['🍲','stew'],['🍛','curry'],['🍣','sushi'],['🍱','bento'],['🥟','dumpling'],['🍤','fried shrimp'],['🍙','rice ball'],['🍚','rice'],['🍘','rice cracker'],['🍧','shaved ice'],['🍨','ice cream'],['🎂','birthday cake'],['🍰','shortcake'],['🧁','cupcake'],['🥧','pie'],['🍫','chocolate'],['🍬','candy'],['🍭','lollipop'],['🍮','custard'],['🍯','honey pot'],['🍼','baby bottle'],['🥛','milk'],['☕','coffee'],['🫖','teapot'],['🍵','tea'],['🧃','juice box'],['🥤','cup with straw'],['🧋','bubble tea'],['🍶','sake'],['🍺','beer'],['🍻','cheers'],['🥂','champagne'],['🍷','wine'],['🥃','whiskey'],['🍸','cocktail'],['🍹','tropical drink'],['🧉','mate'],['🍾','bottle with popping cork']
    ]},
    'activity': { icon: '⚽', label: 'Activity', emoji: [
      ['⚽','soccer'],['🏀','basketball'],['🏈','football'],['⚾','baseball'],['🥎','softball'],['🎾','tennis'],['🏐','volleyball'],['🏉','rugby'],['🥏','flying disc'],['🎱','8ball'],['🏓','ping pong'],['🏸','badminton'],['🏒','hockey'],['🥅','goal net'],['⛳','golf'],['🏹','bow and arrow'],['🎣','fishing'],['🤿','diving mask'],['🥊','boxing glove'],['🥋','martial arts'],['🎽','running shirt'],['⛸️','ice skate'],['🛷','sled'],['🎿','ski'],['⛷️','skier'],['🏂','snowboarder'],['🏋️','weight lifter'],['🤼','wrestlers'],['🤸','cartwheeling'],['🤺','fencer'],['🏇','horse racing'],['🧘','yoga'],['🏄','surfing'],['🏊','swimming'],['🚣','rowing'],['🧗','climbing'],['🚴','biking'],['🏆','trophy'],['🥇','1st place'],['🥈','2nd place'],['🥉','3rd place'],['🏅','medal'],['🎖️','military medal'],['🎪','circus tent'],['🎭','performing arts'],['🎨','art'],['🎬','clapper board'],['🎤','microphone'],['🎧','headphones'],['🎼','musical score'],['🎹','piano'],['🥁','drum'],['🎷','saxophone'],['🎺','trumpet'],['🎸','guitar'],['🪕','banjo'],['🎻','violin'],['🎲','game die'],['♟️','chess pawn'],['🎯','dart'],['🎳','bowling'],['🎮','video game'],['🕹️','joystick'],['🎰','slot machine'],['🧩','puzzle piece']
    ]},
    'travel': { icon: '🌍', label: 'Travel & Places', emoji: [
      ['🚗','car'],['🚕','taxi'],['🚙','suv'],['🚌','bus'],['🚎','trolleybus'],['🏎️','racing car'],['🚓','police car'],['🚑','ambulance'],['🚒','fire engine'],['🚐','minibus'],['🛻','pickup truck'],['🚚','truck'],['🚛','articulated lorry'],['🚜','tractor'],['🏍️','motorcycle'],['🛵','motor scooter'],['🚲','bicycle'],['🛴','kick scooter'],['🚂','locomotive'],['🚆','train'],['🚇','metro'],['🚈','light rail'],['🚊','tram'],['🚉','station'],['✈️','airplane'],['🛫','departure'],['🛬','arrival'],['🚀','rocket'],['🛸','flying saucer'],['🚁','helicopter'],['⛵','sailboat'],['🚤','speedboat'],['🛳️','cruise ship'],['⛴️','ferry'],['🚢','ship'],['⚓','anchor'],['🗼','tokyo tower'],['🗽','statue of liberty'],['🏰','castle'],['🏯','japanese castle'],['🎡','ferris wheel'],['🎢','roller coaster'],['🏠','house'],['🏡','garden house'],['🏢','office'],['🏥','hospital'],['🏦','bank'],['🏨','hotel'],['🏪','convenience store'],['🏫','school'],['🏬','department store'],['🏭','factory'],['⛪','church'],['🕌','mosque'],['🛕','hindu temple'],['🕍','synagogue'],['🗾','japan'],['🌍','earth africa'],['🌎','earth americas'],['🌏','earth asia'],['🌋','volcano'],['🗻','mount fuji'],['🏕','camping'],['🏖️','beach'],['🏜️','desert'],['🏝️','desert island'],['🌅','sunrise'],['🌄','sunrise mountains'],['🌠','shooting star'],['🎆','fireworks'],['🎇','sparkler'],['🌃','night stars'],['🌉','bridge night'],['🌌','milky way']
    ]},
    'objects': { icon: '💡', label: 'Objects', emoji: [
      ['⌚','watch'],['📱','phone'],['💻','laptop'],['⌨️','keyboard'],['🖥️','desktop'],['🖨️','printer'],['🖱️','mouse'],['💾','floppy disk'],['💿','cd'],['📀','dvd'],['🎥','movie camera'],['📷','camera'],['📹','video camera'],['📺','television'],['📻','radio'],['🔋','battery'],['🔌','electric plug'],['💡','light bulb'],['🔦','flashlight'],['🕯️','candle'],['🪔','diya lamp'],['📔','notebook'],['📕','book'],['📖','open book'],['📗','green book'],['📘','blue book'],['📙','orange book'],['📚','books'],['📓','notebook 2'],['📒','ledger'],['📃','page curl'],['📜','scroll'],['📄','page'],['📰','newspaper'],['🗞️','rolled newspaper'],['📑','bookmark tabs'],['🔖','bookmark'],['🏷️','label'],['💰','money bag'],['🪙','coin'],['💴','yen'],['💵','dollar'],['💶','euro'],['💷','pound'],['💎','gem'],['🔧','wrench'],['🪛','screwdriver'],['🔩','nut bolt'],['🪜','ladder'],['🧲','magnet'],['🔬','microscope'],['🔭','telescope'],['📡','satellite dish'],['💉','syringe'],['🩸','drop of blood'],['💊','pill'],['🩹','bandage'],['🧬','dna'],['🔑','key'],['🗝️','old key'],['🔒','lock'],['🔓','unlock'],['🛡️','shield'],['⚔️','crossed swords'],['🪄','magic wand'],['📦','package'],['✉️','envelope'],['📧','email'],['📮','postbox'],['🗑️','wastebasket'],['🛒','shopping cart']
    ]},
    'symbols': { icon: '❤️', label: 'Symbols', emoji: [
      ['❤️','red heart'],['🧡','orange heart'],['💛','yellow heart'],['💚','green heart'],['💙','blue heart'],['💜','purple heart'],['🖤','black heart'],['🤍','white heart'],['🤎','brown heart'],['💔','broken heart'],['❤️‍🔥','heart on fire'],['❤️‍🩹','mending heart'],['💕','two hearts'],['💞','revolving hearts'],['💓','heartbeat'],['💗','growing heart'],['💖','sparkling heart'],['💘','cupid'],['💝','gift heart'],['💟','heart decoration'],['☮️','peace'],['✝️','cross'],['☪️','star and crescent'],['🕉️','om'],['☸️','wheel of dharma'],['✡️','star of david'],['🔯','six pointed star'],['☯️','yin yang'],['♈','aries'],['♉','taurus'],['♊','gemini'],['♋','cancer'],['♌','leo'],['♍','virgo'],['♎','libra'],['♏','scorpio'],['♐','sagittarius'],['♑','capricorn'],['♒','aquarius'],['♓','pisces'],['⛎','ophiuchus'],['🆔','id'],['⚛️','atom'],['🉐','accept'],['☢️','radioactive'],['☣️','biohazard'],['📴','mobile phone off'],['📳','vibration mode'],['🈶','u6709'],['🈚','u7121'],['✅','check mark'],['❌','cross mark'],['❓','question'],['❗','exclamation'],['‼️','double exclamation'],['⁉️','exclamation question'],['💯','100'],['🔅','dim'],['🔆','bright'],['⚠️','warning'],['🚸','children crossing'],['🔱','trident'],['♻️','recycle'],['✳️','eight spoked asterisk'],['❇️','sparkle'],['🔰','beginner'],['💠','diamond shape dot'],['Ⓜ️','m circled'],['🔴','red circle'],['🟠','orange circle'],['🟡','yellow circle'],['🟢','green circle'],['🔵','blue circle'],['🟣','purple circle'],['⚫','black circle'],['⚪','white circle'],['🟤','brown circle'],['🔺','red triangle up'],['🔻','red triangle down'],['🔸','small orange diamond'],['🔹','small blue diamond'],['🔶','large orange diamond'],['🔷','large blue diamond'],['💬','speech bubble'],['💭','thought bubble'],['🗯️','anger bubble'],['🏁','checkered flag'],['🚩','red flag'],['🏴','black flag'],['🏳️','white flag']
    ]},
    'flags': { icon: '🚩', label: 'Flags', emoji: [
      ['🇺🇸','us flag'],['🇬🇧','gb flag'],['🇫🇷','france flag'],['🇩🇪','germany flag'],['🇮🇹','italy flag'],['🇪🇸','spain flag'],['🇵🇹','portugal flag'],['🇧🇷','brazil flag'],['🇦🇷','argentina flag'],['🇲🇽','mexico flag'],['🇨🇦','canada flag'],['🇦🇺','australia flag'],['🇯🇵','japan flag'],['🇰🇷','korea flag'],['🇨🇳','china flag'],['🇮🇳','india flag'],['🇷🇺','russia flag'],['🇹🇷','turkey flag'],['🇸🇦','saudi arabia flag'],['🇦🇪','uae flag'],['🇹🇭','thailand flag'],['🇻🇳','vietnam flag'],['🇮🇩','indonesia flag'],['🇵🇭','philippines flag'],['🇳🇬','nigeria flag'],['🇿🇦','south africa flag'],['🇪🇬','egypt flag'],['🇰🇪','kenya flag'],['🇨🇴','colombia flag'],['🇨🇱','chile flag'],['🇵🇪','peru flag'],['🇳🇱','netherlands flag'],['🇧🇪','belgium flag'],['🇨🇭','switzerland flag'],['🇦🇹','austria flag'],['🇸🇪','sweden flag'],['🇳🇴','norway flag'],['🇩🇰','denmark flag'],['🇫🇮','finland flag'],['🇵🇱','poland flag'],['🇬🇷','greece flag'],['🇮🇪','ireland flag'],['🇮🇱','israel flag'],['🇺🇦','ukraine flag'],['🇷🇴','romania flag'],['🇭🇺','hungary flag'],['🇨🇿','czech flag'],['🇸🇬','singapore flag'],['🇲🇾','malaysia flag'],['🇳🇿','new zealand flag'],['🏳️‍🌈','rainbow flag'],['🏴‍☠️','pirate flag']
    ]}
  };

  const picker = document.getElementById('emojiPicker');
  const emojiBtn = document.getElementById('emojiBtn');
  const emojiSearch = document.getElementById('emojiSearch');
  const emojiTabs = document.getElementById('emojiTabs');
  const emojiGridWrap = document.getElementById('emojiGridWrap');
  let pickerOpen = false;
  let activeCategory = 'smileys';

  // Recently used (localStorage)
  const RECENT_KEY = 'oceangram-recent-emoji';
  function getRecent() {
    try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; }
  }
  function addRecent(em) {
    let r = getRecent().filter(e => e !== em);
    r.unshift(em);
    if (r.length > 24) r = r.slice(0, 24);
    localStorage.setItem(RECENT_KEY, JSON.stringify(r));
    EMOJI_DATA.recent.emoji = r.map(e => [e, '']);
  }

  // Init recent
  EMOJI_DATA.recent.emoji = getRecent().map(e => [e, '']);

  // Build tabs
  function buildTabs() {
    emojiTabs.innerHTML = '';
    for (const [key, cat] of Object.entries(EMOJI_DATA)) {
      if (key === 'recent' && cat.emoji.length === 0) continue;
      const btn = document.createElement('button');
      btn.className = 'emoji-tab' + (key === activeCategory ? ' active' : '');
      btn.textContent = cat.icon;
      btn.title = cat.label;
      btn.onclick = () => { activeCategory = key; buildTabs(); renderGrid(); };
      emojiTabs.appendChild(btn);
    }
  }

  // Render grid
  function renderGrid(filter) {
    emojiGridWrap.innerHTML = '';
    const cats = filter ? Object.entries(EMOJI_DATA) : [[activeCategory, EMOJI_DATA[activeCategory]]];
    for (const [key, cat] of cats) {
      if (key === 'recent' && cat.emoji.length === 0) continue;
      let emojis = cat.emoji;
      if (filter) {
        emojis = emojis.filter(e => e[1] && e[1].includes(filter));
        if (emojis.length === 0) continue;
      }
      const label = document.createElement('div');
      label.className = 'emoji-cat-label';
      label.textContent = cat.label;
      emojiGridWrap.appendChild(label);
      const grid = document.createElement('div');
      grid.className = 'emoji-grid';
      for (const [em] of emojis) {
        const span = document.createElement('span');
        span.textContent = em;
        span.title = emojis.find(e => e[0] === em)?.[1] || '';
        span.onclick = () => insertEmoji(em);
        grid.appendChild(span);
      }
      emojiGridWrap.appendChild(grid);
    }
  }

  function insertEmoji(em) {
    addRecent(em);
    const ta = document.getElementById('msgInput');
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const val = ta.value;
    ta.value = val.slice(0, start) + em + val.slice(end);
    const pos = start + em.length;
    ta.selectionStart = ta.selectionEnd = pos;
    ta.focus();
    ta.dispatchEvent(new Event('input'));
    closePicker();
  }

  function openPicker() {
    pickerOpen = true;
    picker.style.display = 'flex';
    emojiBtn.classList.add('active');
    emojiSearch.value = '';
    activeCategory = getRecent().length > 0 ? 'recent' : 'smileys';
    EMOJI_DATA.recent.emoji = getRecent().map(e => [e, '']);
    buildTabs();
    renderGrid();
    emojiSearch.focus();
  }

  function closePicker() {
    pickerOpen = false;
    picker.style.display = 'none';
    emojiBtn.classList.remove('active');
  }

  emojiBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    pickerOpen ? closePicker() : openPicker();
  });

  emojiSearch.addEventListener('input', () => {
    const q = emojiSearch.value.trim().toLowerCase();
    if (q) {
      renderGrid(q);
    } else {
      renderGrid();
    }
  });

  document.addEventListener('click', (e) => {
    if (pickerOpen && !picker.contains(e.target) && e.target !== emojiBtn) closePicker();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && pickerOpen) { closePicker(); e.stopPropagation(); }
  });
})();

msgInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    doSend();
  }
  if (e.key === 'Escape') {
    if (pastedImageData) { clearImagePaste(); }
    else if (editingMsgId) { clearEdit(); }
    else if (replyToId) { clearReply(); }
  }
});

// Track all messages for prepending older ones
let allMessages = [];
let loadingOlder = false;
let oldestId = 0;
let prevMsgIds = '';
const profilePhotos = {}; // senderId -> base64 data URI
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
      // Merge server messages with optimistic ones — in-place replacement, no flicker
      var newMsgs = msg.messages;
      var optimisticList = allMessages.filter(function(m) { return m._optimistic; });
      // Replace optimistic messages that now have real echoes
      for (var oi = 0; oi < optimisticList.length; oi++) {
        var opt = optimisticList[oi];
        var matchIdx = -1;
        for (var ni = 0; ni < newMsgs.length; ni++) {
          if (newMsgs[ni].isOutgoing && newMsgs[ni].text === opt.text && Math.abs(newMsgs[ni].timestamp - opt.timestamp) < 30) {
            matchIdx = ni;
            break;
          }
        }
        if (matchIdx !== -1) {
          // Real message found — drop the optimistic one
          pendingOptimistic.delete(opt.id);
          optimisticList.splice(oi, 1);
          oi--;
        }
      }
      // Merge: server messages + any still-pending optimistic ones
      allMessages = newMsgs.concat(optimisticList);
      allMessages.sort(function(a, b) { return a.timestamp - b.timestamp || a.id - b.id; });
      if (allMessages.length > 0) oldestId = allMessages[0].id || 0;
      // Skip re-render if nothing actually changed (avoid flicker)
      var newIds = allMessages.map(function(m) { return m.id; }).join(',');
      var prevIds = (prevLen > 0) ? null : ''; // force render on first load
      var isFirstLoad = prevLen === 0;
      if (!isFirstLoad && newIds === prevMsgIds) break;
      prevMsgIds = newIds;
      renderMessages(allMessages);
      if (isFirstLoad) { setTimeout(function() { messagesList.scrollTop = messagesList.scrollHeight; }, 0); }
      if (!wasAtBottom && allMessages.length > prevLen && prevLen > 0) {
        newMsgCount += allMessages.length - prevLen;
        newMsgsBtn.textContent = '↓ ' + newMsgCount + ' new message' + (newMsgCount > 1 ? 's' : '');
        newMsgsBtn.style.display = 'block';
      }
      break;
    case 'newMessage':
      // Clear typing indicator for this sender
      if (msg.message && msg.message.senderId && typingUsers[msg.message.senderId]) {
        clearTimeout(typingUsers[msg.message.senderId].timeout);
        delete typingUsers[msg.message.senderId];
        updateTypingDisplay();
      }
      // Real-time: append single new message
      if (msg.message && !allMessages.some(function(m) { return m.id === msg.message.id; })) {
        // Echo suppression: if this matches a pending optimistic message, replace it
        var echoIdx = -1;
        if (msg.message.isOutgoing) {
          for (var ei = allMessages.length - 1; ei >= 0; ei--) {
            var om = allMessages[ei];
            if (om._optimistic && om.text === msg.message.text && Math.abs(msg.message.timestamp - om.timestamp) < 30) {
              echoIdx = ei;
              pendingOptimistic.delete(om.id);
              break;
            }
          }
        }
        var atBottom = isScrolledToBottom();
        if (echoIdx !== -1) {
          allMessages[echoIdx] = msg.message; // replace optimistic with real
        } else {
          allMessages.push(msg.message);
        }
        if (allMessages.length > 0) lastMsgId = allMessages[allMessages.length - 1].id || 0;
        renderMessages(allMessages);
        if (atBottom) { messagesList.scrollTop = messagesList.scrollHeight; }
        else if (echoIdx === -1) {
          newMsgCount++;
          newMsgsBtn.textContent = '↓ ' + newMsgCount + ' new message' + (newMsgCount > 1 ? 's' : '');
          newMsgsBtn.style.display = 'block';
        }
      }
      break;
    case 'editMessage':
      // Real-time: update edited message in place
      if (msg.message) {
        var idx = allMessages.findIndex(function(m) { return m.id === msg.message.id; });
        if (idx !== -1) {
          // Detect reaction changes for flash animation
          var oldReactions = JSON.stringify((allMessages[idx].reactions || []).map(function(r) { return r.emoji + r.count; }).sort());
          var newReactions = JSON.stringify((msg.message.reactions || []).map(function(r) { return r.emoji + r.count; }).sort());
          var reactionsChanged = oldReactions !== newReactions;
          allMessages[idx] = msg.message;
          renderMessages(allMessages);
          if (reactionsChanged) {
            var flashEl = messagesList.querySelector('.msg[data-msg-id="' + msg.message.id + '"]');
            if (flashEl) {
              flashEl.classList.add('reaction-flash');
              setTimeout(function() { flashEl.classList.remove('reaction-flash'); }, 1000);
            }
          }
        }
      }
      break;
    case 'deleteMessages':
      // Real-time: remove deleted messages with fade-out
      if (msg.messageIds && msg.messageIds.length > 0) {
        var delSet = new Set(msg.messageIds);
        msg.messageIds.forEach(function(id) {
          var el = messagesList.querySelector('.msg[data-msg-id="' + id + '"]');
          if (el) el.classList.add('fade-out');
        });
        setTimeout(function() {
          var before = allMessages.length;
          allMessages = allMessages.filter(function(m) { return !delSet.has(m.id); });
          if (allMessages.length !== before) renderMessages(allMessages);
        }, 300);
      }
      break;
    case 'typing':
      if (msg.userId && msg.userName) {
        handleTypingEvent(msg.userId, msg.userName);
      }
      break;
    case 'readOutbox':
      // Update outgoing message statuses to 'read' for ids <= maxId
      if (msg.maxId) {
        var changed = false;
        for (var ri = allMessages.length - 1; ri >= 0; ri--) {
          var rm = allMessages[ri];
          if (rm.isOutgoing && rm.id > 0 && rm.id <= msg.maxId && rm.status !== 'read') {
            rm.status = 'read';
            changed = true;
          }
        }
        if (changed) {
          // Update status icons in-place without full re-render
          var statusEls = messagesList.querySelectorAll('.msg[data-outgoing="1"] .msg-status');
          statusEls.forEach(function(el) {
            var msgEl = el.closest('.msg');
            var msgId = msgEl ? parseInt(msgEl.dataset.msgId) : 0;
            if (msgId > 0 && msgId <= msg.maxId) {
              el.className = 'msg-status read';
            }
          });
        }
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
    case 'sendSuccess':
      // Remove optimistic flag — real message will arrive via newMessage event
      var sIdx = allMessages.findIndex(function(m) { return m.id === msg.tempId; });
      if (sIdx !== -1) {
        allMessages[sIdx]._optimistic = null;
        renderMessages(allMessages);
      }
      break;
    case 'sendFailed':
      var fIdx = allMessages.findIndex(function(m) { return m.id === msg.tempId; });
      if (fIdx !== -1) {
        allMessages[fIdx]._optimistic = 'failed';
        renderMessages(allMessages);
      }
      pendingOptimistic.delete(msg.tempId);
      break;
    case 'editFailed':
      // Edit failed — the real-time event will eventually correct, but show error
      console.warn('Edit failed for message ' + msg.messageId + ': ' + msg.error);
      break;
    case 'profilePhotos':
      // Store profile photos and update existing avatars in DOM
      if (msg.photos) {
        for (var pid in msg.photos) {
          profilePhotos[pid] = msg.photos[pid];
        }
        // Update all avatar elements with matching sender IDs
        document.querySelectorAll('.msg-avatar[data-sender-id]').forEach(function(el) {
          var sid = el.getAttribute('data-sender-id');
          if (sid && profilePhotos[sid]) {
            el.innerHTML = '<img src="' + profilePhotos[sid] + '" style="width:100%;height:100%;border-radius:50%;object-fit:cover" />';
          }
        });
      }
      break;
    case 'videoData': {
      var vidMsgId = String(msg.messageId);
      var vidContainer = window._videoPending && window._videoPending[vidMsgId];
      if (vidContainer) {
        var vidLoader = vidContainer.querySelector('.msg-video-loading');
        if (vidLoader) vidLoader.remove();
        if (msg.error || !msg.dataUrl) {
          // Show error, restore play button
          var vidPlayBtn = vidContainer.querySelector('.msg-video-play');
          if (vidPlayBtn) vidPlayBtn.style.display = '';
          console.warn('Video download failed:', msg.error);
        } else {
          // Remove thumbnail and meta, insert video player
          var vidThumb = vidContainer.querySelector('.msg-video-thumb, .msg-video-no-thumb');
          if (vidThumb) vidThumb.remove();
          var vidMeta = vidContainer.querySelector('.msg-video-meta');
          if (vidMeta) vidMeta.remove();
          var video = document.createElement('video');
          video.src = msg.dataUrl;
          video.controls = true;
          video.autoplay = true;
          video.style.width = '100%';
          if (vidContainer.classList.contains('video-note')) {
            video.style.borderRadius = '50%';
            video.style.objectFit = 'cover';
          }
          vidContainer.insertBefore(video, vidContainer.firstChild);
        }
        delete window._videoPending[vidMsgId];
      }
      break;
    }
    case 'downloadProgress': {
      var progEl = document.getElementById('file-progress-' + msg.messageId);
      if (progEl) {
        progEl.classList.add('active');
        var bar = progEl.querySelector('.msg-file-progress-bar');
        if (bar) bar.style.width = msg.progress + '%';
      }
      break;
    }
    case 'downloadComplete': {
      var progEl2 = document.getElementById('file-progress-' + msg.messageId);
      if (progEl2) {
        progEl2.classList.remove('active');
        var bar2 = progEl2.querySelector('.msg-file-progress-bar');
        if (bar2) bar2.style.width = '0%';
      }
      break;
    }
    case 'downloadError': {
      var progEl3 = document.getElementById('file-progress-' + msg.messageId);
      if (progEl3) progEl3.classList.remove('active');
      console.error('Download failed:', msg.error);
      break;
    }
    case 'agentInfo':
      updateAgentBanner(msg.info);
      break;
    case 'pinnedMessages':
      handlePinnedMessages(msg.messages);
      break;
    case 'agentDetails':
      renderAgentDetails(msg.data);
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
const agentSubagentIndicator = document.getElementById('agentSubagentIndicator');
const agentSubagentCount = document.getElementById('agentSubagentCount');
const agentDetailsPanel = document.getElementById('agentDetailsPanel');
const agentDetailsContent = document.getElementById('agentDetailsContent');

// Pinned messages
const pinnedBanner = document.getElementById('pinnedBanner');
const pinnedText = document.getElementById('pinnedText');
const pinnedCount = document.getElementById('pinnedCount');
const pinnedClose = document.getElementById('pinnedClose');
let pinnedMessages = [];
let pinnedIndex = 0;

function handlePinnedMessages(msgs) {
  pinnedMessages = msgs || [];
  pinnedIndex = 0;
  if (pinnedMessages.length === 0) {
    pinnedBanner.style.display = 'none';
    return;
  }
  updatePinnedBanner();
  pinnedBanner.style.display = 'flex';
}

function updatePinnedBanner() {
  var m = pinnedMessages[pinnedIndex];
  var text = (m.text || '').replace(/\\n/g, ' ');
  if (text.length > 60) text = text.slice(0, 60) + '…';
  pinnedText.textContent = text || '(media)';
  pinnedCount.textContent = pinnedMessages.length > 1 ? (pinnedIndex + 1) + '/' + pinnedMessages.length : '';
}

pinnedBanner.addEventListener('click', function(e) {
  if (e.target === pinnedClose || e.target.closest('.pin-close')) return;
  var m = pinnedMessages[pinnedIndex];
  if (!m) return;
  // Cycle to next pinned message on next click
  if (pinnedMessages.length > 1) {
    pinnedIndex = (pinnedIndex + 1) % pinnedMessages.length;
    updatePinnedBanner();
  }
  // Scroll to the pinned message
  var el = document.querySelector('[data-msg-id="' + m.id + '"]');
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('msg-highlight');
    setTimeout(function() { el.classList.remove('msg-highlight'); }, 1500);
  }
});

pinnedClose.addEventListener('click', function(e) {
  e.stopPropagation();
  pinnedBanner.style.display = 'none';
});

let agentPanelExpanded = false;
let currentAgentInfo = null;
let currentAgentDetails = null;

function updateAgentBanner(info) {
  if (!info) {
    agentBanner.style.display = 'none';
    agentDetailsPanel.classList.remove('expanded');
    agentPanelExpanded = false;
    return;
  }
  currentAgentInfo = info;
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

function toggleAgentPanel() {
  agentPanelExpanded = !agentPanelExpanded;
  if (agentPanelExpanded) {
    agentDetailsPanel.classList.add('expanded');
    // Request detailed info
    vscode.postMessage({ type: 'getAgentDetails' });
  } else {
    agentDetailsPanel.classList.remove('expanded');
  }
}

function closeAgentPanel() {
  if (agentPanelExpanded) {
    agentPanelExpanded = false;
    agentDetailsPanel.classList.remove('expanded');
  }
}

agentBanner.addEventListener('click', toggleAgentPanel);

function formatChars(chars) {
  if (chars >= 1000000) return (chars / 1000000).toFixed(1) + 'M';
  if (chars >= 1000) return (chars / 1000).toFixed(1) + 'k';
  return chars.toString();
}

function formatRelativeTime(ts) {
  var ago = Math.round((Date.now() - ts) / 1000);
  if (ago < 60) return 'just now';
  if (ago < 3600) return Math.round(ago / 60) + 'm ago';
  return Math.round(ago / 3600) + 'h ago';
}

function renderAgentDetails(data) {
  if (!data) {
    agentDetailsContent.innerHTML = '<div class="sessions-empty">Failed to load details</div>';
    return;
  }
  currentAgentDetails = data;
  
  // Update sub-agent indicator in banner
  if (data.subAgents && data.subAgents.length > 0) {
    agentSubagentIndicator.style.display = 'flex';
    agentSubagentCount.textContent = data.subAgents.length + ' agent' + (data.subAgents.length > 1 ? 's' : '');
  } else {
    agentSubagentIndicator.style.display = 'none';
  }
  
  var html = '';
  
  // Context Usage section
  var totalTokens = data.totalTokens || 0;
  var contextTokens = data.contextTokens || 200000;
  var totalChars = totalTokens * 4; // rough estimate
  var maxChars = contextTokens * 4;
  
  var sysChars = data.systemPromptChars || 0;
  var projChars = data.projectContextChars || 0;
  var skillChars = data.totalSkillChars || 0;
  var toolChars = data.totalToolChars || 0;
  var convChars = data.conversationChars || 0;
  
  var sysPct = Math.min(100, (sysChars / maxChars) * 100);
  var projPct = Math.min(100 - sysPct, (projChars / maxChars) * 100);
  var skillPct = Math.min(100 - sysPct - projPct, (skillChars / maxChars) * 100);
  var toolPct = Math.min(100 - sysPct - projPct - skillPct, (toolChars / maxChars) * 100);
  var convPct = Math.min(100 - sysPct - projPct - skillPct - toolPct, (convChars / maxChars) * 100);
  
  html += '<div class="agent-details-section">';
  html += '<div class="agent-details-section-header"><span class="icon">📊</span> Context Usage</div>';
  html += '<div class="context-bar-full">';
  html += '<div class="segment system" style="width:' + sysPct + '%"></div>';
  html += '<div class="segment project" style="width:' + projPct + '%"></div>';
  html += '<div class="segment skills" style="width:' + skillPct + '%"></div>';
  html += '<div class="segment tools" style="width:' + toolPct + '%"></div>';
  html += '<div class="segment conversation" style="width:' + convPct + '%"></div>';
  html += '</div>';
  html += '<div class="context-legend">';
  html += '<div class="context-legend-item"><span class="context-legend-dot system"></span>System ' + formatChars(sysChars) + '</div>';
  html += '<div class="context-legend-item"><span class="context-legend-dot project"></span>Project ' + formatChars(projChars) + '</div>';
  html += '<div class="context-legend-item"><span class="context-legend-dot skills"></span>Skills ' + formatChars(skillChars) + '</div>';
  html += '<div class="context-legend-item"><span class="context-legend-dot tools"></span>Tools ' + formatChars(toolChars) + '</div>';
  html += '<div class="context-legend-item"><span class="context-legend-dot conversation"></span>Conversation ' + formatChars(convChars) + '</div>';
  html += '</div>';
  html += '<div class="context-total">' + Math.round(totalTokens / 1000) + 'k / ' + Math.round(contextTokens / 1000) + 'k tokens (' + data.contextPercent + '%)</div>';
  html += '</div>';
  
  // Workspace Files section
  var wsFiles = data.workspaceFiles || [];
  if (wsFiles.length > 0) {
    var standardFiles = ['AGENTS.md', 'SOUL.md', 'USER.md', 'TOOLS.md', 'MEMORY.md'];
    html += '<div class="agent-details-section">';
    html += '<div class="agent-details-section-header"><span class="icon">📁</span> Workspace Files (' + wsFiles.length + ')</div>';
    html += '<div class="workspace-files-list">';
    for (var i = 0; i < wsFiles.length; i++) {
      var f = wsFiles[i];
      var isStandard = standardFiles.indexOf(f.name) !== -1;
      html += '<div class="workspace-file-item' + (isStandard ? '' : ' custom') + '">';
      html += '<span class="workspace-file-name">' + esc(f.name);
      if (f.truncated) html += ' <span class="truncated">✂️</span>';
      html += '</span>';
      html += '<span class="workspace-file-size">' + formatChars(f.chars) + '</span>';
      html += '</div>';
    }
    html += '</div></div>';
  }
  
  // Skills section
  var skills = data.skills || [];
  if (skills.length > 0) {
    html += '<div class="agent-details-section">';
    html += '<div class="agent-details-section-header"><span class="icon">🧩</span> Skills (' + skills.length + ')</div>';
    html += '<div class="skills-list">';
    
    // Group by source
    var bundled = skills.filter(function(s) { return s.source === 'openclaw-bundled' || s.source === 'bundled'; });
    var workspace = skills.filter(function(s) { return s.source === 'openclaw-workspace' || s.source === 'workspace'; });
    var custom = skills.filter(function(s) { return s.source !== 'openclaw-bundled' && s.source !== 'bundled' && s.source !== 'openclaw-workspace' && s.source !== 'workspace'; });
    
    if (bundled.length > 0) {
      html += '<div class="skills-group-label bundled">Bundled</div>';
      html += '<div class="skills-items">';
      for (var bi = 0; bi < bundled.length; bi++) {
        html += '<span class="skill-chip">' + esc(bundled[bi].name) + '<span class="size">' + formatChars(bundled[bi].chars) + '</span></span>';
      }
      html += '</div>';
    }
    if (workspace.length > 0) {
      html += '<div class="skills-group-label workspace">Workspace</div>';
      html += '<div class="skills-items">';
      for (var wi = 0; wi < workspace.length; wi++) {
        html += '<span class="skill-chip">' + esc(workspace[wi].name) + '<span class="size">' + formatChars(workspace[wi].chars) + '</span></span>';
      }
      html += '</div>';
    }
    if (custom.length > 0) {
      html += '<div class="skills-group-label custom">Custom</div>';
      html += '<div class="skills-items">';
      for (var ci = 0; ci < custom.length; ci++) {
        html += '<span class="skill-chip">' + esc(custom[ci].name) + '<span class="size">' + formatChars(custom[ci].chars) + '</span></span>';
      }
      html += '</div>';
    }
    
    html += '<div class="skills-total">Total: ' + formatChars(data.totalSkillChars || 0) + ' chars</div>';
    html += '</div></div>';
  }
  
  // Tools section
  var tools = data.tools || [];
  if (tools.length > 0) {
    html += '<div class="agent-details-section">';
    html += '<div class="agent-details-section-header"><span class="icon">🔧</span> Tools</div>';
    html += '<div class="tools-summary">' + tools.length + ' tools available (' + formatChars(data.totalToolChars || 0) + ' chars)</div>';
    html += '<div class="tools-list">';
    for (var ti = 0; ti < tools.length; ti++) {
      html += '<span class="tool-chip">' + esc(tools[ti].name) + '</span>';
    }
    html += '</div></div>';
  }
  
  // Active Sessions section
  html += '<div class="agent-details-section">';
  html += '<div class="agent-details-section-header"><span class="icon">🤖</span> Active Sessions</div>';
  var subAgents = data.subAgents || [];
  if (subAgents.length > 0) {
    html += '<div class="sessions-list">';
    for (var si = 0; si < subAgents.length; si++) {
      var sa = subAgents[si];
      var saModel = (sa.model || 'unknown').replace(/^anthropic\\//, '').replace(/^openai\\//, '');
      var saKey = sa.sessionKey || '';
      // Shorten session key for display
      var saKeyShort = saKey.length > 40 ? saKey.slice(0, 20) + '...' + saKey.slice(-15) : saKey;
      html += '<div class="session-item">';
      html += '<div class="session-info">';
      html += '<span class="session-key" title="' + esc(saKey) + '">' + esc(saKeyShort) + '</span>';
      html += '<span class="session-model">' + esc(saModel) + '</span>';
      html += '</div>';
      html += '<div class="session-time">' + formatRelativeTime(sa.updatedAt) + '</div>';
      html += '<div class="session-status"></div>';
      html += '</div>';
    }
    html += '</div>';
  } else {
    html += '<div class="sessions-empty">No active sub-agents</div>';
  }
  html += '</div>';
  
  agentDetailsContent.innerHTML = html;
}

// Infinite scroll — load older on scroll to top, hide new msg btn at bottom
messagesList.addEventListener('scroll', () => {
  if (messagesList.scrollTop < 80 && !loadingOlder && oldestId > 0) {
    loadingOlder = true;
    vscode.postMessage({ type: 'loadOlder', beforeId: oldestId });
  }
  if (isScrolledToBottom()) {
    newMsgsBtn.style.display = 'none';
    if (newMsgCount > 0) {
      newMsgCount = 0;
      vscode.postMessage({ type: 'tabFocused' });
    }
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
  const isOutgoing = msgEl.dataset.outgoing === '1';
  const msgTimestamp = parseInt(msgEl.dataset.timestamp || '0') * 1000;
  const canDeleteForEveryone = isOutgoing && (Date.now() - msgTimestamp) < 48 * 60 * 60 * 1000;
  const hasText = !!(msgEl.dataset.text);
  let menuHtml =
    '<div class="ctx-menu-item" data-action="reply">↩️ Reply</div>' +
    '<div class="ctx-menu-item" data-action="copy">📋 Copy text</div>';
  if (isOutgoing && hasText) {
    menuHtml += '<div class="ctx-menu-item" data-action="edit">✏️ Edit message</div>';
  }
  menuHtml +=
    '<div class="ctx-menu-sep"></div>' +
    '<div class="ctx-menu-item danger" data-action="deleteForMe">🗑 Delete for me</div>';
  if (canDeleteForEveryone) {
    menuHtml += '<div class="ctx-menu-item danger" data-action="deleteForAll">🗑 Delete for everyone</div>';
  }
  menu.innerHTML = menuHtml;
  menu.querySelectorAll('.ctx-menu-item').forEach(item => {
    item.addEventListener('click', () => {
      const action = item.dataset.action;
      const msgId = parseInt(msgEl.dataset.msgId);
      if (action === 'reply') {
        setReply(msgId, msgEl.dataset.sender, msgEl.dataset.text);
      } else if (action === 'copy') {
        navigator.clipboard.writeText(msgEl.dataset.text || '');
      } else if (action === 'edit') {
        // Find the full message text from allMessages (data-text is truncated to 100 chars)
        var fullMsg = allMessages.find(function(m) { return m.id === msgId; });
        setEdit(msgId, fullMsg ? fullMsg.text : msgEl.dataset.text);
      } else if (action === 'deleteForMe') {
        vscode.postMessage({ type: 'deleteMessage', messageIds: [msgId], revoke: false });
      } else if (action === 'deleteForAll') {
        vscode.postMessage({ type: 'deleteMessage', messageIds: [msgId], revoke: true });
      }
      removeCtxMenu();
    });
  });
  document.body.appendChild(menu);
  activeCtxMenu = menu;
});

function copyCodeBlock(btn) {
  var wrapper = btn.closest('.code-block-wrapper');
  if (!wrapper) return;
  var pre = wrapper.querySelector('pre');
  if (!pre) return;
  var code = pre.textContent || '';
  navigator.clipboard.writeText(code).then(function() {
    btn.textContent = '✅';
    btn.classList.add('copied');
    setTimeout(function() {
      btn.textContent = '📋';
      btn.classList.remove('copied');
    }, 2000);
  });
}

/* Voice player */
var _voiceAudios = {};
var _voiceCurrentId = null;

function _getVoicePlayer(btn) {
  return btn.closest('.voice-player');
}

function toggleVoice(btn) {
  var player = _getVoicePlayer(btn);
  if (!player) return;
  var src = player.getAttribute('data-src');
  if (!src) return;

  // Create or get audio element
  var id = src.substring(0, 60); // use as key
  if (!_voiceAudios[id]) {
    var audio = new Audio(src);
    audio._player = player;
    audio._btn = btn;
    audio.addEventListener('timeupdate', function() { _updateVoiceProgress(audio); });
    audio.addEventListener('ended', function() {
      btn.textContent = '▶';
      _voiceCurrentId = null;
      _resetVoiceBars(player);
    });
    _voiceAudios[id] = audio;
  }
  var audio = _voiceAudios[id];

  // Stop any other playing voice
  if (_voiceCurrentId && _voiceCurrentId !== id && _voiceAudios[_voiceCurrentId]) {
    _voiceAudios[_voiceCurrentId].pause();
    _voiceAudios[_voiceCurrentId]._btn.textContent = '▶';
    _resetVoiceBars(_voiceAudios[_voiceCurrentId]._player);
  }

  if (audio.paused) {
    audio.play();
    btn.textContent = '⏸';
    _voiceCurrentId = id;
  } else {
    audio.pause();
    btn.textContent = '▶';
    _voiceCurrentId = null;
  }
}

function _updateVoiceProgress(audio) {
  var player = audio._player;
  if (!player || !audio.duration) return;
  var pct = audio.currentTime / audio.duration;
  var bars = player.querySelectorAll('.vw-bar');
  var playedCount = Math.floor(pct * bars.length);
  for (var i = 0; i < bars.length; i++) {
    if (i < playedCount) bars[i].classList.add('vw-played');
    else bars[i].classList.remove('vw-played');
  }
  var t = Math.floor(audio.currentTime);
  var timeEl = player.querySelector('.voice-time');
  if (timeEl) timeEl.textContent = Math.floor(t / 60) + ':' + ('0' + (t % 60)).slice(-2);
}

function _resetVoiceBars(player) {
  var bars = player.querySelectorAll('.vw-bar');
  for (var i = 0; i < bars.length; i++) bars[i].classList.remove('vw-played');
  var dur = parseInt(player.getAttribute('data-duration') || '0');
  var timeEl = player.querySelector('.voice-time');
  if (timeEl) timeEl.textContent = Math.floor(dur / 60) + ':' + ('0' + (dur % 60)).slice(-2);
}

function scrubVoice(event, waveformEl) {
  var player = waveformEl.closest('.voice-player');
  if (!player) return;
  var src = player.getAttribute('data-src');
  if (!src) return;
  var id = src.substring(0, 60);
  var audio = _voiceAudios[id];
  if (!audio || !audio.duration) return;
  var rect = waveformEl.getBoundingClientRect();
  var pct = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  audio.currentTime = pct * audio.duration;
}

function cycleVoiceSpeed(btn) {
  var player = btn.closest('.voice-player');
  if (!player) return;
  var src = player.getAttribute('data-src');
  if (!src) return;
  var id = src.substring(0, 60);
  var audio = _voiceAudios[id];
  var speeds = [1, 1.5, 2];
  var labels = ['1×', '1.5×', '2×'];
  var current = speeds.indexOf(audio ? audio.playbackRate : 1);
  var next = (current + 1) % speeds.length;
  if (audio) audio.playbackRate = speeds[next];
  btn.textContent = labels[next];
}

function playVideo(container) {
  var msgId = container.dataset.msgId;
  if (!msgId) return;
  // If already has a video element, toggle play/pause
  var existingVideo = container.querySelector('video');
  if (existingVideo) {
    if (existingVideo.paused) existingVideo.play();
    else existingVideo.pause();
    return;
  }
  // Show loading indicator
  var playBtn = container.querySelector('.msg-video-play');
  if (playBtn) playBtn.style.display = 'none';
  var loader = document.createElement('div');
  loader.className = 'msg-video-loading';
  loader.textContent = 'Loading…';
  container.appendChild(loader);
  // Request video download from extension
  vscode.postMessage({ type: 'downloadVideo', messageId: parseInt(msgId) });
  // Store container ref for callback
  if (!window._videoPending) window._videoPending = {};
  window._videoPending[msgId] = container;
}

function showLightbox(src) {
  var overlay = document.createElement('div');
  overlay.className = 'lightbox-overlay';
  overlay.innerHTML = '<img src="' + src + '" />';
  overlay.addEventListener('click', function() { overlay.remove(); });
  document.body.appendChild(overlay);
}

function retryMessage(tempId) {
  var idx = allMessages.findIndex(function(m) { return m.id === tempId; });
  if (idx === -1) return;
  var m = allMessages[idx];
  m._optimistic = 'sending';
  pendingOptimistic.set(tempId, { text: m.text, timestamp: m.timestamp });
  renderMessages(allMessages);
  var payload = { type: 'sendMessage', text: m.text, tempId: tempId };
  if (m.replyToId) payload.replyToId = m.replyToId;
  vscode.postMessage(payload);
}

// Real-time polling for new messages
let pollInterval;
let lastMsgId = 0;
const POLL_FOCUSED = 2000;
const POLL_HIDDEN = 4000;
function startPolling() {
  stopPolling();
  var interval = document.hidden ? POLL_HIDDEN : POLL_FOCUSED;
  pollInterval = setInterval(() => {
    vscode.postMessage({ type: 'poll', afterId: lastMsgId });
  }, interval);
}
function stopPolling() {
  if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
}
document.addEventListener('visibilitychange', () => {
  startPolling(); // restart with appropriate interval
});

// User profile popup
let activeProfilePopup = null;
let activeProfileOverlay = null;
const profileColors = ['#e17076','#eda86c','#a695e7','#7bc862','#6ec9cb','#65aadd','#ee7aae','#6bb2f2'];
function pickProfileColor(id) { return profileColors[Math.abs(parseInt(id || '0', 10)) % profileColors.length]; }

function closeProfilePopup() {
  if (activeProfileOverlay) { activeProfileOverlay.remove(); activeProfileOverlay = null; }
  if (activeProfilePopup) { activeProfilePopup.remove(); activeProfilePopup = null; }
}

function showUserProfile(el, userId) {
  if (!userId) return;
  closeProfilePopup();

  var rect = el.getBoundingClientRect();

  var overlay = document.createElement('div');
  overlay.className = 'user-profile-overlay';
  overlay.addEventListener('click', closeProfilePopup);
  document.body.appendChild(overlay);
  activeProfileOverlay = overlay;

  var popup = document.createElement('div');
  popup.className = 'user-profile-popup';
  popup.innerHTML = '<div class="profile-loading">Loading…</div>';

  var top = rect.bottom + 6;
  var left = rect.left;
  if (top + 300 > window.innerHeight) top = rect.top - 306;
  if (left + 280 > window.innerWidth) left = window.innerWidth - 290;
  if (left < 10) left = 10;
  popup.style.top = top + 'px';
  popup.style.left = left + 'px';

  document.body.appendChild(popup);
  activeProfilePopup = popup;

  vscode.postMessage({ type: 'getUserInfo', userId: userId });
}

document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape' && activeProfilePopup) { closeProfilePopup(); }
});

// Handle userInfo responses in the existing message handler
var origOnMessage = window.onmessage;
window.addEventListener('message', function(event) {
  var msg = event.data;
  if (msg.type === 'userInfo' && activeProfilePopup) {
    var info = msg.info;
    var html = '';
    if (info.photo) {
      html += '<img class="profile-avatar" src="' + info.photo + '" />';
    } else {
      var initials = info.name.split(' ').map(function(w) { return w[0]; }).filter(Boolean).slice(0, 2).join('').toUpperCase();
      html += '<div class="profile-avatar-placeholder" style="background:' + pickProfileColor(info.id) + '">' + esc(initials) + '</div>';
    }
    html += '<div class="profile-name">' + esc(info.name) + '</div>';
    if (info.username) html += '<div class="profile-username">@' + esc(info.username) + '</div>';
    if (info.lastSeen) {
      var isOnline = info.lastSeen === 'online';
      html += '<div class="profile-status' + (isOnline ? ' online' : '') + '">' + esc(info.lastSeen) + '</div>';
    }
    if (info.bio) html += '<div class="profile-bio">' + esc(info.bio) + '</div>';
    if (info.phone) html += '<div class="profile-detail">📱 +' + esc(info.phone) + '</div>';
    html += '<div class="profile-detail">ID: ' + esc(info.id) + '</div>';
    if (info.isBot) html += '<div class="profile-detail">🤖 Bot</div>';
    activeProfilePopup.innerHTML = html;
  } else if (msg.type === 'userInfoError' && activeProfilePopup) {
    activeProfilePopup.innerHTML = '<div class="profile-loading">Failed to load profile</div>';
  }
});

// --- Search (Ctrl+F) ---
var searchBar = document.getElementById('searchBar');
var searchInput = document.getElementById('searchInput');
var searchCount = document.getElementById('searchCount');
var searchMatches = [];
var searchIdx = -1;

function openSearch() {
  searchBar.classList.add('visible');
  searchInput.focus();
  searchInput.select();
}
function closeSearch() {
  searchBar.classList.remove('visible');
  searchInput.value = '';
  clearSearchHighlights();
  searchMatches = [];
  searchIdx = -1;
  searchCount.textContent = '';
}
function clearSearchHighlights() {
  document.querySelectorAll('.msg-bubble.search-highlight, .msg-bubble.search-current').forEach(function(el) {
    el.classList.remove('search-highlight', 'search-current');
  });
}
function doLocalSearch() {
  var q = (searchInput.value || '').toLowerCase().trim();
  clearSearchHighlights();
  searchMatches = [];
  searchIdx = -1;
  if (!q) { searchCount.textContent = ''; return; }
  var bubbles = document.querySelectorAll('.msg-bubble');
  bubbles.forEach(function(b) {
    if ((b.textContent || '').toLowerCase().indexOf(q) !== -1) {
      b.classList.add('search-highlight');
      searchMatches.push(b);
    }
  });
  if (searchMatches.length > 0) {
    searchIdx = searchMatches.length - 1;
    navigateSearch(0);
  }
  searchCount.textContent = searchMatches.length > 0 ? (searchIdx + 1) + ' / ' + searchMatches.length : 'No results';
}
function navigateSearch(delta) {
  if (searchMatches.length === 0) return;
  if (searchIdx >= 0 && searchIdx < searchMatches.length) {
    searchMatches[searchIdx].classList.remove('search-current');
    searchMatches[searchIdx].classList.add('search-highlight');
  }
  searchIdx = (searchIdx + delta + searchMatches.length) % searchMatches.length;
  searchMatches[searchIdx].classList.remove('search-highlight');
  searchMatches[searchIdx].classList.add('search-current');
  searchMatches[searchIdx].scrollIntoView({ behavior: 'smooth', block: 'center' });
  searchCount.textContent = (searchIdx + 1) + ' / ' + searchMatches.length;
}

var searchDebounce;
searchInput.addEventListener('input', function() {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(doLocalSearch, 150);
});
searchInput.addEventListener('keydown', function(e) {
  if (e.key === 'Enter') { e.preventDefault(); navigateSearch(e.shiftKey ? -1 : 1); }
  if (e.key === 'Escape') { e.preventDefault(); closeSearch(); }
});
document.getElementById('searchUp').addEventListener('click', function() { navigateSearch(-1); });
document.getElementById('searchDown').addEventListener('click', function() { navigateSearch(1); });
document.getElementById('searchClose').addEventListener('click', closeSearch);

document.addEventListener('keydown', function(e) {
  if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
    e.preventDefault();
    openSearch();
  }
  if (e.key === 'Escape') {
    if (searchBar.classList.contains('visible')) {
      closeSearch();
    } else if (agentPanelExpanded) {
      closeAgentPanel();
    }
  }
});

// Floating date header on scroll
var floatingDate = document.getElementById('floatingDate');
var floatingDateSpan = floatingDate.querySelector('span');
var floatingDateTimeout = null;

function updateFloatingDate() {
  var separators = messagesList.querySelectorAll('.date-separator');
  if (separators.length === 0) { floatingDate.classList.add('hidden'); return; }

  var containerTop = messagesList.getBoundingClientRect().top;
  var bestSep = null;
  var bestSepRect = null;

  for (var i = 0; i < separators.length; i++) {
    var rect = separators[i].getBoundingClientRect();
    if (rect.top <= containerTop + 40) {
      bestSep = separators[i];
      bestSepRect = rect;
    }
  }

  if (!bestSep) {
    floatingDate.classList.add('hidden');
    return;
  }

  // Hide if the real separator is visible near the top to avoid doubling
  if (bestSepRect && bestSepRect.top > containerTop - 5 && bestSepRect.bottom < containerTop + 50) {
    floatingDate.classList.add('hidden');
    return;
  }

  var dateText = bestSep.querySelector('span').textContent;
  floatingDateSpan.textContent = dateText;
  floatingDate.classList.remove('hidden');

  clearTimeout(floatingDateTimeout);
  floatingDateTimeout = setTimeout(function() {
    floatingDate.classList.add('hidden');
  }, 2000);
}

var floatingDateRaf = false;
messagesList.addEventListener('scroll', function() {
  if (!floatingDateRaf) {
    floatingDateRaf = true;
    requestAnimationFrame(function() {
      floatingDateRaf = false;
      updateFloatingDate();
    });
  }
}, { passive: true });

// --- Typing indicators ---
var typingIndicator = document.getElementById('typingIndicator');
var typingUsers = {}; // userId -> { name, timeout }

function updateTypingDisplay() {
  var names = Object.values(typingUsers).map(function(u) { return u.name; });
  if (names.length === 0) {
    typingIndicator.classList.remove('visible');
    return;
  }
  var text = names.length === 1
    ? names[0] + ' is typing'
    : names.slice(0, 2).join(' and ') + (names.length > 2 ? ' and others' : '') + ' are typing';
  typingIndicator.innerHTML = esc(text) + ' <span class="typing-dots"><span>.</span><span>.</span><span>.</span></span>';
  typingIndicator.classList.add('visible');
}

function handleTypingEvent(userId, userName) {
  if (typingUsers[userId]) clearTimeout(typingUsers[userId].timeout);
  typingUsers[userId] = {
    name: userName,
    timeout: setTimeout(function() {
      delete typingUsers[userId];
      updateTypingDisplay();
    }, 6000)
  };
  updateTypingDisplay();
}

// Debounced sendTyping on keydown in composer (max once per 5s)
var lastTypingSent = 0;
msgInput.addEventListener('keydown', function(e) {
  if (e.key === 'Enter' || e.key === 'Escape' || e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') return;
  var now = Date.now();
  if (now - lastTypingSent > 5000) {
    lastTypingSent = now;
    vscode.postMessage({ type: 'sendTyping' });
  }
});

// --- Drag & Drop file sending ---
var dropOverlay = document.getElementById('dropZoneOverlay');
var filePreviewBar = document.getElementById('filePreviewBar');
var filePreviewItems = document.getElementById('filePreviewItems');
var filePreviewCancel = document.getElementById('filePreviewCancel');
var filePreviewSend = document.getElementById('filePreviewSend');
var pendingFiles = [];

var dragCounter = 0;
document.addEventListener('dragenter', function(e) {
  e.preventDefault();
  dragCounter++;
  if (e.dataTransfer && e.dataTransfer.types.indexOf('Files') !== -1) {
    dropOverlay.classList.add('active');
  }
});
document.addEventListener('dragleave', function(e) {
  e.preventDefault();
  dragCounter--;
  if (dragCounter <= 0) {
    dragCounter = 0;
    dropOverlay.classList.remove('active');
  }
});
document.addEventListener('dragover', function(e) {
  e.preventDefault();
});
document.addEventListener('drop', function(e) {
  e.preventDefault();
  dragCounter = 0;
  dropOverlay.classList.remove('active');
  if (!e.dataTransfer || !e.dataTransfer.files.length) return;
  handleDroppedFiles(e.dataTransfer.files);
});

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024*1024) return (bytes/1024).toFixed(1) + ' KB';
  return (bytes/(1024*1024)).toFixed(1) + ' MB';
}

function handleDroppedFiles(fileList) {
  for (var i = 0; i < fileList.length; i++) {
    (function(file) {
      var reader = new FileReader();
      reader.onload = function(ev) {
        var dataUrl = ev.target.result;
        var base64 = dataUrl.split(',')[1];
        pendingFiles.push({
          name: file.name,
          size: file.size,
          type: file.type || 'application/octet-stream',
          dataUrl: dataUrl,
          base64: base64
        });
        renderFilePreview();
      };
      reader.readAsDataURL(file);
    })(fileList[i]);
  }
}

function renderFilePreview() {
  if (pendingFiles.length === 0) {
    filePreviewBar.style.display = 'none';
    return;
  }
  filePreviewBar.style.display = 'flex';
  filePreviewItems.innerHTML = '';
  pendingFiles.forEach(function(f, idx) {
    var item = document.createElement('div');
    item.className = 'file-preview-item';
    var isImage = f.type.startsWith('image/');
    if (isImage) {
      item.innerHTML = '<img src="' + f.dataUrl + '" alt="" />';
    } else {
      item.innerHTML = '<span class="file-icon">📄</span>';
    }
    item.innerHTML += '<span class="file-name">' + esc(f.name) + '</span>'
      + '<span class="file-size">' + formatFileSize(f.size) + '</span>'
      + '<button class="file-remove" data-idx="' + idx + '">✕</button>';
    filePreviewItems.appendChild(item);
  });
  filePreviewItems.querySelectorAll('.file-remove').forEach(function(btn) {
    btn.addEventListener('click', function() {
      pendingFiles.splice(parseInt(btn.dataset.idx), 1);
      renderFilePreview();
    });
  });
}

filePreviewCancel.addEventListener('click', function() {
  pendingFiles = [];
  renderFilePreview();
});

filePreviewSend.addEventListener('click', function() {
  if (pendingFiles.length === 0) return;
  pendingFiles.forEach(function(f) {
    var tempId = 'file_' + Date.now() + '_' + Math.random().toString(36).slice(2);
    vscode.postMessage({
      type: 'sendFile',
      tempId: tempId,
      fileName: f.name,
      mimeType: f.type,
      data: f.base64,
      caption: ''
    });
  });
  pendingFiles = [];
  renderFilePreview();
});

vscode.postMessage({ type: 'init' });
</script>
</body>
</html>`;
  }
}
