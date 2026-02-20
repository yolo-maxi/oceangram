import * as vscode from 'vscode';
import { TelegramService, ChatEvent, DialogInfo, ConnectionState, UserStatus, GroupMember, ChatInfoResult, ChatMember, SharedMediaItem } from './services/telegram';
import { TelegramApiClient } from './services/telegramApi';
import { getTelegramApi } from './extension';
import { OpenClawService, AgentSessionInfo, AgentDetailedInfo } from './services/openclaw';
import { ToolCall, getToolIcon, truncateParams, formatDuration, groupToolCallsByMessage, parseToolCallsFromText, messageHasToolCalls, EmbeddedToolCall, truncateString } from './services/toolExecution';
import { highlightMessageCodeBlocks, disposeHighlighter } from './services/highlighter';
import { showSmartNotification } from './services/notifications';

/** Union type for either direct gramjs or daemon API client */
type TelegramBackend = TelegramService | TelegramApiClient;

// Shared telegram service — prefers daemon API client, falls back to direct gramjs
let sharedTelegram: TelegramBackend | undefined;
function getTelegram(): TelegramBackend {
  // Try daemon API client first
  const apiClient = getTelegramApi();
  if (apiClient) {
    sharedTelegram = apiClient;
    return apiClient;
  }
  // Fallback to direct gramjs
  if (!sharedTelegram || sharedTelegram instanceof TelegramApiClient) {
    sharedTelegram = new TelegramService();
  }
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
            console.log('[Oceangram] openChat:', msg.chatId, msg.chatName);
            tg.trackRecentChat(msg.chatId);
            ChatTab.createOrShow(msg.chatId, msg.chatName, this.context);
            break;
          case 'openDM':
            tg.trackRecentChat(msg.userId);
            ChatTab.createOrShow(msg.userId, msg.name || 'DM', this.context);
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
    // TASK-108: Sort by most recent message time
    pinned.sort((a, b) => (b.lastMessageTime || 0) - (a.lastMessageTime || 0));
    // TASK-109: Group forum topics under their parent for collapsible tree
    const grouped = this.groupForumTopics(pinned, all);
    this.panel.webview.postMessage({ type: 'dialogs', dialogs: grouped });
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
    // TASK-108: Sort by most recent message time
    pinned.sort((a, b) => (b.lastMessageTime || 0) - (a.lastMessageTime || 0));
    // TASK-109: Group forum topics under their parent for collapsible tree
    const grouped = this.groupForumTopics(pinned, dialogs);
    this.panel.webview.postMessage({ type: 'dialogs', dialogs: grouped });
  }

  private sendRecentChats(allDialogs?: DialogInfo[]): void {
    const tg = getTelegram();
    const recentEntries = tg.getRecentChats();
    if (recentEntries.length === 0) {
      this.panel.webview.postMessage({ type: 'recentChats', dialogs: [] });
      return;
    }
    const dialogs = allDialogs || tg.getCachedDialogs() || [];
    const pinnedIds = new Set(tg.getPinnedIds());
    // Filter: recent but not pinned (pinned already shown)
    // TASK-108: Sort by lastMessageTime (recent entries already ordered by access time, 
    // but we also sort by last message for better UX)
    const recent = recentEntries
      .filter(r => !pinnedIds.has(r.id))
      .map(r => dialogs.find(d => d.id === r.id))
      .filter(Boolean) as DialogInfo[];
    // Sort by last message time
    recent.sort((a, b) => (b.lastMessageTime || 0) - (a.lastMessageTime || 0));
    // TASK-109: Group forum topics for collapsible tree
    const grouped = this.groupForumTopics(recent, dialogs);
    this.panel.webview.postMessage({ type: 'recentChats', dialogs: grouped });
  }

  /**
   * TASK-109: Group forum topics under their parent group for collapsible tree view.
   * Each forum group gets a _topics array with its child topics.
   * Aggregates unread counts on parent when topics exist.
   */
  private groupForumTopics(dialogs: DialogInfo[], allDialogs: DialogInfo[]): DialogInfo[] {
    const forumGroups = new Map<string, { parent: DialogInfo & { _topics?: DialogInfo[]; _isForumParent?: boolean; _totalUnread?: number }, topics: DialogInfo[] }>();
    const result: DialogInfo[] = [];

    for (const d of dialogs) {
      // If it's a forum topic (has topicId), group it under its parent
      if (d.isForum && d.topicId && d.groupName) {
        const key = d.chatId;
        if (!forumGroups.has(key)) {
          // Find or create parent group entry
          const parentDialog = allDialogs.find(ad => ad.chatId === d.chatId && !ad.topicId);
          const parent: DialogInfo & { _topics?: DialogInfo[]; _isForumParent?: boolean; _totalUnread?: number } = parentDialog
            ? { ...parentDialog }
            : {
                id: d.chatId,
                chatId: d.chatId,
                name: d.groupName,
                lastMessage: '',
                lastMessageTime: d.lastMessageTime || 0,
                unreadCount: 0,
                initials: d.initials,
                isPinned: false,
                isForum: true,
              };
          parent._topics = [];
          parent._isForumParent = true;
          parent._totalUnread = 0;
          forumGroups.set(key, { parent, topics: [] });
        }
        const entry = forumGroups.get(key)!;
        entry.topics.push(d);
        entry.parent._totalUnread! += d.unreadCount || 0;
        // Update parent's lastMessageTime to most recent topic
        if ((d.lastMessageTime || 0) > (entry.parent.lastMessageTime || 0)) {
          entry.parent.lastMessageTime = d.lastMessageTime;
        }
      } else if (d.isForum && !d.topicId) {
        // Forum group without topic - might have topics added later
        const key = d.chatId;
        if (!forumGroups.has(key)) {
          const parent: DialogInfo & { _topics?: DialogInfo[]; _isForumParent?: boolean; _totalUnread?: number } = { ...d };
          parent._topics = [];
          parent._isForumParent = true;
          parent._totalUnread = d.unreadCount || 0;
          forumGroups.set(key, { parent, topics: [] });
        }
      } else {
        // Regular chat, not a forum
        result.push(d);
      }
    }

    // Add forum groups with their topics
    for (const [, entry] of forumGroups) {
      // Sort topics by last message time
      entry.topics.sort((a, b) => (b.lastMessageTime || 0) - (a.lastMessageTime || 0));
      entry.parent._topics = entry.topics;
      entry.parent.unreadCount = entry.parent._totalUnread || 0;
      result.push(entry.parent);
    }

    // Final sort by lastMessageTime
    result.sort((a, b) => (b.lastMessageTime || 0) - (a.lastMessageTime || 0));

    return result;
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
/* TASK-109: Collapsible forum topics tree */
.forum-parent { position: relative; }
.forum-parent .expand-toggle {
  cursor: pointer; padding: 4px 6px; border-radius: 4px;
  flex-shrink: 0; font-size: 14px; color: var(--tg-text-secondary);
  transition: transform 0.2s;
}
.forum-parent .expand-toggle:hover { background: var(--tg-surface); color: var(--tg-text); }
.forum-parent.expanded .expand-toggle { transform: rotate(90deg); }
.forum-topics-container {
  display: none;
  padding-left: 20px;
  border-left: 2px solid var(--tg-surface);
  margin-left: 34px;
}
.forum-parent.expanded + .forum-topics-container { display: block; }
.forum-topics-container .chat-item {
  padding: 6px 10px;
}
.forum-topics-container .avatar {
  width: 36px; height: 36px; font-size: 18px;
}
.section-header {
  padding: 10px 12px 6px;
  font-size: 12px;
  color: var(--tg-text-secondary);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
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
  // Show/hide recent list based on view
  var recentEl = document.getElementById('recentList');
  if (recentEl) recentEl.style.display = view === 'main' ? 'block' : 'none';
  if (view !== 'topics') currentForumGroup = null;
  // Restore expanded state for forum parents when switching to main view
  if (view === 'main') {
    document.querySelectorAll('.forum-parent').forEach(el => {
      const chatId = el.dataset.chatId;
      if (expandedForums.has(chatId)) {
        el.classList.add('expanded');
        const topicsContainer = el.nextElementSibling;
        if (topicsContainer && topicsContainer.classList.contains('forum-topics-container')) {
          topicsContainer.style.display = 'block';
        }
      }
    });
  }
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

// Track expanded forum groups (persisted across renders)
const expandedForums = new Set();

function renderDialogs(dialogs, container, showPinBtn) {
  selectedIndex = -1;
  if (!dialogs.length) {
    container.innerHTML = '<div class="empty">No pinned chats yet.<br>Search to find and pin chats.</div>';
    return;
  }

  let html = '';
  for (const d of dialogs) {
    const isForumParent = d._isForumParent && d._topics && d._topics.length > 0;
    const isForumGroup = d._isForumGroup; // Legacy collapsed group (for search results)
    const hasUnread = d.unreadCount > 0;
    const isTopic = d.groupName && d.topicName && !isForumParent;
    const color = pickColor(d.chatId || d.id);
    const isExpanded = expandedForums.has(d.chatId);

    // TASK-109: Forum parent with collapsible topics
    if (isForumParent) {
      const topicCount = d._topics.length;
      const countLabel = topicCount + ' topic' + (topicCount !== 1 ? 's' : '');
      const timeStr = relativeTime(d.lastMessageTime);
      const timeClass = 'chat-time' + (hasUnread ? ' has-unread' : '');
      const unreadHtml = hasUnread ? '<span class="unread-badge">' + d.unreadCount + '</span>' : '';

      html += '<div class="chat-item forum-parent' + (isExpanded ? ' expanded' : '') + '" data-forum-parent="1" data-chat-id="' + d.chatId + '" data-group-name="' + esc(d.name) + '">' +
        '<div class="avatar" style="background:' + color + '">' + esc(d.initials) + '<span class="topic-badge">\u2317</span></div>' +
        '<div class="chat-info">' +
          '<div class="chat-name-row"><span class="chat-name">' + esc(d.name) + '</span><span class="' + timeClass + '">' + timeStr + '</span></div>' +
          '<div class="chat-preview-row"><span class="topic-count">' + countLabel + '</span>' + unreadHtml + '</div>' +
        '</div>' +
        '<span class="expand-toggle" title="Expand/collapse topics">\u203a</span>' +
      '</div>';

      // TASK-109: Collapsible topics container
      html += '<div class="forum-topics-container" data-parent-chat="' + d.chatId + '">';
      for (const topic of d._topics) {
        const tHasUnread = topic.unreadCount > 0;
        const tTimeStr = relativeTime(topic.lastMessageTime);
        const tTimeClass = 'chat-time' + (tHasUnread ? ' has-unread' : '');
        const tUnreadHtml = tHasUnread ? '<span class="unread-badge">' + topic.unreadCount + '</span>' : '';
        const tEmoji = topic.topicEmoji || '\u2317';
        const tPreview = topic.lastMessage ? esc(topic.lastMessage.slice(0, 60)) : '';
        const pinBtn = showPinBtn && !topic.isPinned ? '<span class="pin-btn" data-id="' + topic.id + '">\ud83d\udccc</span>' : '';

        html += '<div class="chat-item" data-id="' + topic.id + '" data-name="' + esc(topic.name) + '">' +
          '<div class="avatar" style="background:transparent;font-size:18px">' + esc(tEmoji) + '</div>' +
          '<div class="chat-info">' +
            '<div class="chat-name-row"><span class="chat-name">' + esc(topic.topicName || topic.name) + '</span><span class="' + tTimeClass + '">' + tTimeStr + '</span></div>' +
            '<div class="chat-preview-row"><span class="chat-preview">' + tPreview + '</span>' + tUnreadHtml + '</div>' +
          '</div>' +
          pinBtn +
        '</div>';
      }
      html += '</div>';
      continue;
    }

    // Legacy forum group (collapsed, for search results)
    if (isForumGroup) {
      const countLabel = d._topicCount + ' topic' + (d._topicCount !== 1 ? 's' : '');
      const timeStr = relativeTime(d.lastMessageTime);
      const timeClass = 'chat-time' + (hasUnread ? ' has-unread' : '');
      const unreadHtml = hasUnread ? '<span class="unread-badge">' + d.unreadCount + '</span>' : '';

      html += '<div class="chat-item" data-forum-group="1" data-chat-id="' + d.chatId + '" data-group-name="' + esc(d.name) + '">' +
        '<div class="avatar" style="background:' + color + '">' + esc(d.initials) + '<span class="topic-badge">\u2317</span></div>' +
        '<div class="chat-info">' +
          '<div class="chat-name-row"><span class="chat-name">' + esc(d.name) + '</span><span class="' + timeClass + '">' + timeStr + '</span></div>' +
          '<div class="chat-preview-row"><span class="topic-count">' + countLabel + '</span>' + unreadHtml + '<span class="forum-chevron">\u203a</span></div>' +
        '</div>' +
      '</div>';
      continue;
    }

    // Individual topic (pinned topic shown separately)
    if (isTopic) {
      const timeStr = relativeTime(d.lastMessageTime);
      const timeClass = 'chat-time' + (hasUnread ? ' has-unread' : '');
      const unreadHtml = hasUnread ? '<span class="unread-badge">' + d.unreadCount + '</span>' : '';
      const preview = d.lastMessage ? esc(d.lastMessage.slice(0, 80)) : '';
      const actionBtn = showPinBtn
        ? (d.isPinned ? '' : '<span class="pin-btn" data-id="' + d.id + '">\ud83d\udccc</span>')
        : '<span class="unpin-btn" data-id="' + d.id + '" title="Unpin">\u2715</span>';

      html += '<div class="chat-item" data-id="' + d.id + '" data-name="' + esc(d.name) + '">' +
        '<div class="avatar" style="background:' + color + '">' + esc(d.initials) + '<span class="topic-badge">#</span></div>' +
        '<div class="chat-info">' +
          '<div class="chat-name-row"><div class="chat-group-name">\u2317 ' + esc(d.groupName) + '</div><span class="' + timeClass + '">' + timeStr + '</span></div>' +
          '<div class="chat-name-row"><div class="chat-topic-name">' + esc(d.topicEmoji || '') + ' ' + esc(d.topicName) + '</div></div>' +
          '<div class="chat-preview-row"><span class="chat-preview">' + preview + '</span>' + unreadHtml + '</div>' +
        '</div>' +
        actionBtn +
      '</div>';
      continue;
    }

    // Regular chat
    const preview = d.lastMessage ? esc(d.lastMessage.slice(0, 80)) : '';
    const timeStr = relativeTime(d.lastMessageTime);
    const timeClass = 'chat-time' + (hasUnread ? ' has-unread' : '');
    const unreadHtml = hasUnread ? '<span class="unread-badge">' + d.unreadCount + '</span>' : '';
    const actionBtn = showPinBtn
      ? (d.isPinned ? '' : '<span class="pin-btn" data-id="' + d.id + '">\ud83d\udccc</span>')
      : '<span class="unpin-btn" data-id="' + d.id + '" title="Unpin">\u2715</span>';

    html += '<div class="chat-item" data-id="' + d.id + '" data-name="' + esc(d.name) + '">' +
      '<div class="avatar" style="background:' + color + '">' + esc(d.initials) + '</div>' +
      '<div class="chat-info">' +
        '<div class="chat-name-row"><span class="chat-name">' + esc(d.name) + '</span><span class="' + timeClass + '">' + timeStr + '</span></div>' +
        '<div class="chat-preview-row"><span class="chat-preview">' + preview + '</span>' + unreadHtml + '</div>' +
      '</div>' +
      actionBtn +
    '</div>';
  }

  container.innerHTML = html;
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
  // TASK-109: Handle forum parent expand/collapse
  container.querySelectorAll('.chat-item.forum-parent').forEach(el => {
    const toggle = el.querySelector('.expand-toggle');
    if (toggle) {
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        const chatId = el.dataset.chatId;
        const isExpanded = el.classList.toggle('expanded');
        if (isExpanded) {
          expandedForums.add(chatId);
        } else {
          expandedForums.delete(chatId);
        }
        // Toggle visibility of topics container
        const topicsContainer = el.nextElementSibling;
        if (topicsContainer && topicsContainer.classList.contains('forum-topics-container')) {
          topicsContainer.style.display = isExpanded ? 'block' : 'none';
        }
      });
    }
    // Clicking the parent row (not toggle) expands if collapsed, or opens General topic
    el.addEventListener('click', (e) => {
      if (e.target.closest('.expand-toggle')) return;
      const isExpanded = el.classList.contains('expanded');
      if (!isExpanded) {
        // Expand on first click
        el.classList.add('expanded');
        expandedForums.add(el.dataset.chatId);
        const topicsContainer = el.nextElementSibling;
        if (topicsContainer && topicsContainer.classList.contains('forum-topics-container')) {
          topicsContainer.style.display = 'block';
        }
      }
    });
  });

  // Regular chat items and topics
  container.querySelectorAll('.chat-item:not(.forum-parent)').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.pin-btn') || e.target.closest('.unpin-btn')) return;
      if (el.dataset.forumGroup) {
        // Legacy: navigate to topics view for search results
        enterForumGroup(el.dataset.chatId, el.dataset.groupName);
      } else {
        vscode.postMessage({ type: 'openChat', chatId: el.dataset.id, chatName: el.dataset.name });
      }
    });
  });

  // Also bind events in forum topics containers
  container.querySelectorAll('.forum-topics-container .chat-item').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.pin-btn') || e.target.closest('.unpin-btn')) return;
      vscode.postMessage({ type: 'openChat', chatId: el.dataset.id, chatName: el.dataset.name });
    });
  });

  container.querySelectorAll('.pin-btn').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: 'pin', chatId: el.dataset.id });
    });
  });
  container.querySelectorAll('.unpin-btn').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: 'unpin', chatId: el.dataset.id });
    });
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
    case 'dialogs':
      // Add Pinned header if there are pinned chats
      if (msg.dialogs && msg.dialogs.length > 0) {
        chatList.innerHTML = '<div class="section-header">Pinned</div>';
        var pinnedContainer = document.createElement('div');
        chatList.appendChild(pinnedContainer);
        renderDialogs(msg.dialogs, pinnedContainer, false);
      } else {
        chatList.innerHTML = '<div class="empty">No pinned chats yet.<br>Search to find and pin chats.</div>';
      }
      break;
    case 'recentChats':
      var recentDiv = document.getElementById('recentList');
      if (msg.dialogs && msg.dialogs.length > 0) {
        if (!recentDiv) {
          recentDiv = document.createElement('div');
          recentDiv.id = 'recentList';
          // Insert after chatList
          chatList.parentNode.insertBefore(recentDiv, chatList.nextSibling);
        }
        recentDiv.innerHTML = '<div class="section-header">Recent</div>';
        var recentContainer = document.createElement('div');
        recentDiv.appendChild(recentContainer);
        renderDialogs(msg.dialogs, recentContainer, true);
      } else if (recentDiv) {
        recentDiv.innerHTML = '';
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
      setTimeout(() => errorBox.style.display = 'none', 30000);
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
  private context: vscode.ExtensionContext;
  private disposables: vscode.Disposable[] = [];
  private unsubscribeEvents?: () => void;
  private unreadCount: number = 0;
  private isActive: boolean = true;

  static createOrShow(chatId: string, chatName: string, context: vscode.ExtensionContext) {
    console.log('[Oceangram] ChatTab.createOrShow:', chatId, chatName, 'existing:', ChatTab.tabs.has(chatId));
    const existing = ChatTab.tabs.get(chatId);
    if (existing) {
      console.log('[Oceangram] ChatTab: revealing existing tab');
      existing.panel.reveal();
      return;
    }
    const mediaUri = vscode.Uri.joinPath(context.extensionUri, 'media');
    const panel = vscode.window.createWebviewPanel(
      'oceangram.chat', `💬 ${chatName}`, vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [mediaUri] }
    );
    ChatTab.tabs.set(chatId, new ChatTab(panel, chatId, chatName, context));
  }

  private updateTitle() {
    if (this.unreadCount > 0) {
      this.panel.title = `(${this.unreadCount}) 💬 ${this.chatName}`;
    } else {
      this.panel.title = `💬 ${this.chatName}`;
    }
  }

  private constructor(panel: vscode.WebviewPanel, chatId: string, chatName: string, context: vscode.ExtensionContext) {
    this.panel = panel;
    this.chatId = chatId;
    this.chatName = chatName;
    this.context = context;
    // NOTE: webview.html is set AFTER onDidReceiveMessage is registered (end of constructor)
    // to prevent the webview's 'init' message from firing before the listener exists.

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
    openclaw.initialize().then(async () => {
      if (await openclaw.checkIsConfigured()) {
        const { chatId: rawChatId, topicId } = TelegramService.parseDialogId(chatId);
        openclaw.startPolling(rawChatId, topicId, (info) => {
          this.panel.webview.postMessage({ type: 'agentInfo', info });
        });
      }
    });

    // Subscribe to connection state changes
    const tgForState = getTelegram();
    const unsubConnState = tgForState.onConnectionStateChange((state, attempt) => {
      this.panel.webview.postMessage({ type: 'connectionState', state, attempt });
    });

    // Subscribe to user status changes (online/offline)
    const unsubUserStatus = tgForState.onUserStatusChange((userId, status) => {
      this.panel.webview.postMessage({ type: 'userStatus', userId, status });
    });

    this.panel.onDidDispose(() => {
      ChatTab.tabs.delete(this.chatId);
      if (this.unsubscribeEvents) this.unsubscribeEvents();
      unsubConnState();
      unsubUserStatus();
      const { chatId: rawChatId, topicId } = TelegramService.parseDialogId(this.chatId);
      getOpenClaw().stopPolling(rawChatId, topicId);
      this.disposables.forEach(d => d.dispose());
    }, null, this.disposables);

    this.panel.webview.onDidReceiveMessage(async (msg) => {
      console.log('[Oceangram] ChatTab received message:', msg.type, 'chatId:', this.chatId);
      const tg = getTelegram();
      try {
        switch (msg.type) {
          case 'init':
            console.log('[Oceangram] INIT: chatId=', this.chatId, 'backend=', tg.constructor.name);
            try {
              await tg.connect();
              console.log('[Oceangram] INIT: connect() done');
            } catch (connErr: any) {
              console.error('[Oceangram] INIT: connect() FAILED:', connErr);
              this.panel.webview.postMessage({ type: 'messages', messages: [], error: `Connect failed: ${connErr.message}` });
              break;
            }
            let messages: any[];
            try {
              console.log('[Oceangram] INIT: calling getMessages...');
              const raw = await tg.getMessages(this.chatId, 20);
              console.log('[Oceangram] INIT: getMessages returned', raw?.length, 'msgs');
              messages = await addSyntaxHighlighting(raw);
              console.log('[Oceangram] INIT: highlight done, posting to webview');
            } catch (initErr: any) {
              console.error('[Oceangram] INIT: getMessages FAILED:', initErr?.message, initErr?.stack?.split('\n')[1]);
              this.panel.webview.postMessage({ type: 'messages', messages: [], error: `${initErr.message || 'Failed'} (${tg.constructor.name})` });
              break;
            }
            this.panel.webview.postMessage({ type: 'messages', messages });
            // Track last message ID for gap detection
            if (messages.length > 0) {
              tg.trackMessageId(this.chatId, messages[messages.length - 1].id);
            }
            // Fetch profile photos for senders
            this.fetchAndSendProfilePhotos(tg, messages);
            // Fetch user status for DM chats (non-negative chatId = user)
            {
              const { chatId: rawChatId } = TelegramService.parseDialogId(this.chatId);
              if (!rawChatId.startsWith('-')) {
                tg.fetchUserStatus(rawChatId).then(status => {
                  this.panel.webview.postMessage({ type: 'userStatus', userId: rawChatId, status });
                }).catch(() => {});
              }
            }
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
                      // Smart notification for background tabs
                      if (event.message && !event.message.isOutgoing) {
                        showSmartNotification(
                          event.message.text || '',
                          event.message.senderName || 'Unknown',
                          this.chatName
                        );
                      }
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
                  case 'reactionUpdate':
                    this.panel.webview.postMessage({ type: 'reactionUpdate', messageId: event.messageId, reactions: event.reactions });
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
          case 'sendVoice':
            await tg.connect();
            try {
              const voiceBuffer = Buffer.from(msg.data, 'base64');
              await tg.sendVoice(this.chatId, voiceBuffer, msg.duration, msg.waveform);
              this.panel.webview.postMessage({ type: 'voiceSendSuccess', tempId: msg.tempId });
            } catch (voiceErr: any) {
              this.panel.webview.postMessage({ type: 'voiceSendFailed', tempId: msg.tempId, error: voiceErr.message || 'Voice send failed' });
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
            const details = await openclaw.getDetailedSession(rawChatId, rawTopicId);
            this.panel.webview.postMessage({ type: 'agentDetails', data: details });
            break;
          }
          case 'getToolCalls': {
            const oc = getOpenClaw();
            const { chatId: cId, topicId: tId } = TelegramService.parseDialogId(this.chatId);
            const toolCalls = await oc.getSessionToolCalls(cId, tId);
            // Send enriched tool calls with icons and truncated params
            const enriched = toolCalls.map(tc => ({
              ...tc,
              icon: getToolIcon(tc.name),
              paramsSummary: truncateParams(tc.arguments),
              durationLabel: formatDuration(tc.durationMs),
            }));
            this.panel.webview.postMessage({ type: 'toolCalls', data: enriched });
            break;
          }
          case 'getGroupMembers': {
            await tg.connect();
            const { chatId: rawChatId } = TelegramService.parseDialogId(this.chatId);
            const members = await tg.getGroupMembers(rawChatId, 100);
            // Include cached profile photos
            const membersWithPhotos = members.map(m => ({
              ...m,
              photo: m.photo || tg.getProfilePhoto(m.id) || undefined,
            }));
            this.panel.webview.postMessage({ type: 'groupMembers', members: membersWithPhotos });
            break;
          }
          case 'getChatInfo': {
            await tg.connect();
            const chatInfo = await tg.getChatInfo(this.chatId);
            this.panel.webview.postMessage({ type: 'chatInfo', info: chatInfo });
            break;
          }
          case 'getChatMembers': {
            await tg.connect();
            const chatMembers = await tg.getChatMembersForInfo(this.chatId, msg.limit || 50);
            this.panel.webview.postMessage({ type: 'chatMembers', members: chatMembers });
            break;
          }
          case 'getSharedMedia': {
            await tg.connect();
            const media = await tg.getSharedMedia(this.chatId, msg.mediaType || 'photo', msg.limit || 20);
            this.panel.webview.postMessage({ type: 'sharedMedia', mediaType: msg.mediaType, media: media });
            break;
          }
          case 'exportChat': {
            const messages: any[] = msg.messages || [];
            const format: string = msg.format || 'md';
            const defaultExt = format === 'json' ? 'json' : 'md';
            const safeName = this.chatName.replace(/[^a-zA-Z0-9_-]/g, '_');
            const uri = await vscode.window.showSaveDialog({
              defaultUri: vscode.Uri.file(`${safeName}_export.${defaultExt}`),
              filters: format === 'json'
                ? { 'JSON': ['json'] }
                : { 'Markdown': ['md'] },
            });
            if (uri) {
              let content: string;
              if (format === 'json') {
                content = JSON.stringify(messages, null, 2);
              } else {
                content = `# ${this.chatName} — Chat Export\n\n`;
                content += `_Exported ${messages.length} messages_\n\n---\n\n`;
                for (const m of messages) {
                  const ts = m.timestamp ? new Date(m.timestamp * 1000).toLocaleString() : '';
                  const sender = m.senderName || (m.isOutgoing ? 'You' : 'Unknown');
                  content += `**${sender}** — _${ts}_\n\n`;
                  content += `${m.text || '_(media)_'}\n\n---\n\n`;
                }
              }
              await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'));
              vscode.window.showInformationMessage(`Chat exported to ${uri.fsPath}`);
            }
            break;
          }
        }
      } catch (err: any) {
        this.panel.webview.postMessage({ type: 'error', message: err.message || 'Unknown error' });
      }
    }, null, this.disposables);

    // Set HTML LAST — webview sends 'init' on load, listener must exist first
    this.panel.webview.html = this.getHtml();
  }

  /**
   * Fetch profile photos for unique senders in messages and send to webview.
   */
  private async fetchAndSendProfilePhotos(tg: TelegramBackend, messages: any[]): Promise<void> {
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
    
    // Get webview URIs for external CSS and JS files
    const cssUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'chatTab.css')
    );
    const jsUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'chatTab.js')
    );
    
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<link rel="stylesheet" href="${cssUri}">
</head>
<body>
<!-- Chat header bar - clickable to open info panel -->
<div class="chat-header-bar" id="chatHeaderBar" onclick="openInfoPanel()">
  <div>
    <div class="chat-header-name" id="chatHeaderName">${name}</div>
    <div class="chat-header-status" id="chatHeaderStatus"></div>
  </div>
  <span class="chat-header-export-btn" title="Export chat" onclick="event.stopPropagation(); showExportMenu()">📥</span>
  <span class="chat-header-info-btn">ℹ️</span>
</div>
<!-- Chat info panel overlay -->
<div class="chat-info-overlay" id="chatInfoOverlay" onclick="closeInfoPanel()"></div>
<!-- Chat info panel - slides in from right -->
<div class="chat-info-panel" id="chatInfoPanel">
  <div class="info-panel-header">
    <button class="info-panel-close" onclick="closeInfoPanel()">✕</button>
    <span class="info-panel-title">Chat Info</span>
  </div>
  <div class="info-panel-content" id="infoPanelContent">
    <div class="info-loading">Loading...</div>
  </div>
</div>
<!-- Reconnecting banner -->
<div class="reconnect-banner" id="reconnectBanner">
  <span class="spinner"></span>
  <span id="reconnectText">Reconnecting...</span>
</div>
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
  <div class="mention-dropdown" id="mentionDropdown"></div>
  <div class="voice-recording-bar" id="voiceRecordingBar">
    <span class="voice-rec-dot"></span>
    <span class="voice-rec-timer" id="voiceRecTimer">0:00</span>
    <div class="voice-rec-waveform" id="voiceRecWaveform"></div>
    <button class="voice-rec-cancel" id="voiceRecCancel" title="Cancel">✕</button>
    <button class="voice-rec-stop" id="voiceRecStop" title="Stop">
      <svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
    </button>
  </div>
  <div class="voice-preview-bar" id="voicePreviewBar">
    <button class="voice-play-btn" id="voicePlayBtn" title="Play">
      <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
    </button>
    <div class="voice-preview-waveform" id="voicePreviewWaveform"></div>
    <span class="voice-preview-duration" id="voicePreviewDuration">0:00</span>
    <button class="voice-preview-cancel" id="voicePreviewCancel" title="Discard">✕</button>
    <button class="voice-preview-send" id="voicePreviewSend" title="Send voice message">
      <svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
    </button>
  </div>
  <div class="composer">
    <textarea id="msgInput" rows="1" placeholder="Message ${name}…" autofocus></textarea>
    <button class="emoji-btn" id="emojiBtn" title="Emoji">😊</button>
    <button class="mic-btn" id="micBtn" title="Voice message">
      <svg viewBox="0 0 24 24"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm-1-9c0-.55.45-1 1-1s1 .45 1 1v6c0 .55-.45 1-1 1s-1-.45-1-1V5zm6 6c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg>
    </button>
    <button class="send-btn" id="sendBtn" title="Send">
      <svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
    </button>
  </div>
</div>
<div id="errorBox" class="error" style="display:none"></div>

<script src="${jsUri}"></script>
</body>
</html>`;
  }
}