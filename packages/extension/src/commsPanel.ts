import * as vscode from 'vscode';
import { TelegramService, ChatEvent, DialogInfo, ConnectionState, UserStatus, GroupMember, ChatInfoResult, ChatMember, SharedMediaItem } from './services/telegram';
import { TelegramApiClient } from './services/telegramApi';
import { getTelegramApi, isAgentEnabled } from './extension';
import { OpenClawService, AgentSessionInfo, AgentDetailedInfo } from './agent/openclaw';
import { ToolCall, getToolIcon, truncateParams, formatDuration, groupToolCallsByMessage, parseToolCallsFromText, messageHasToolCalls, EmbeddedToolCall, truncateString } from './agent/toolExecution';
import { highlightMessageCodeBlocks, disposeHighlighter } from './services/highlighter';
import { showSmartNotification } from './services/notifications';
import { ChatsTreeProvider } from './chatsTreeProvider';

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
    const mediaUri = vscode.Uri.joinPath(context.extensionUri, 'media');
    const panel = vscode.window.createWebviewPanel(
      'oceangram.commsPicker', '💬 Chats', vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [mediaUri] }
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
          case 'muteChat':
            this.handleMuteChat(msg.chatId, msg.duration);
            break;
          case 'unmuteChat':
            this.handleUnmuteChat(msg.chatId);
            break;
          case 'searchLocal': {
            // Client-side search from cache — instant
            const cached = tg.searchDialogsFromCache(msg.query);
            const collapsed = msg.groupChatId
              ? cached.filter(d => d.isForum && d.chatId === msg.groupChatId && d.topicId && (d.topicName || '').toLowerCase().includes(msg.query.toLowerCase()))
              : this.collapseForumGroups(cached);
            // Add mute status to search results
            collapsed.forEach(d => (d as any)._isMuted = this.isChatMuted(d.id));
            this.panel.webview.postMessage({ type: msg.groupChatId ? 'topicsList' : 'searchResultsLocal', groupName: msg.groupName, groupChatId: msg.groupChatId, dialogs: collapsed });
            break;
          }
          case 'search':
            await tg.connect();
            const results = msg.groupChatId
              ? (await tg.getDialogs(200)).filter(d => d.isForum && d.chatId === msg.groupChatId && d.topicId && (d.topicName || '').toLowerCase().includes(msg.query.toLowerCase()))
              : this.collapseForumGroups(await tg.searchDialogs(msg.query));
            // Add mute status to search results
            results.forEach(d => (d as any)._isMuted = this.isChatMuted(d.id));
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
            // Add mute status to topics
            topics.forEach(d => (d as any)._isMuted = this.isChatMuted(d.id));
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
    pinned.forEach(d => {
      d.isPinned = true;
      (d as any)._isMuted = this.isChatMuted(d.id);
    });
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
    pinned.forEach(d => {
      d.isPinned = true;
      (d as any)._isMuted = this.isChatMuted(d.id);
    });
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
    
    // Add mute status to recent chats
    recent.forEach(d => {
      (d as any)._isMuted = this.isChatMuted(d.id);
    });
    
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
        // Add mute status to topic
        (d as any)._isMuted = this.isChatMuted(d.id);
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

  private handleMuteChat(chatId: string, duration: 'MUTE_1H' | 'MUTE_8H' | 'MUTE_FOREVER'): void {
    const muteSettings = this.context.globalState.get<Record<string, number>>('oceangram.chatMuteSettings', {});
    const muteUntil = duration === 'MUTE_FOREVER' ? Number.MAX_SAFE_INTEGER :
                     duration === 'MUTE_8H' ? Date.now() + (8 * 60 * 60 * 1000) :
                     Date.now() + (60 * 60 * 1000); // MUTE_1H
    
    muteSettings[chatId] = muteUntil;
    this.context.globalState.update('oceangram.chatMuteSettings', muteSettings);
    
    // Refresh the chat list to show mute icon
    this.sendPinnedDialogs();
    this.sendRecentChats();
  }

  private handleUnmuteChat(chatId: string): void {
    const muteSettings = this.context.globalState.get<Record<string, number>>('oceangram.chatMuteSettings', {});
    delete muteSettings[chatId];
    this.context.globalState.update('oceangram.chatMuteSettings', muteSettings);
    
    // Refresh the chat list to show mute icon removed
    this.sendPinnedDialogs();
    this.sendRecentChats();
  }

  private isChatMuted(chatId: string): boolean {
    const muteSettings = this.context.globalState.get<Record<string, number>>('oceangram.chatMuteSettings', {});
    const muteUntil = muteSettings[chatId];
    return muteUntil && muteUntil > Date.now();
  }

  private getHtml(): string {
    const cssUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'commsPicker.css')
    );
    const jsUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'commsPicker.js')
    );
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<link rel="stylesheet" href="${cssUri}">
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
<script src="${jsUri}"></script>
</body>
</html>`;
  }
}

/**
 * Check if a chat is currently muted based on stored settings
 */
export function isChatMuted(context: vscode.ExtensionContext, chatId: string): boolean {
  const muteSettings = context.globalState.get<Record<string, number>>('oceangram.chatMuteSettings', {});
  const muteUntil = muteSettings[chatId];
  return muteUntil && muteUntil > Date.now();
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
        // Notify the tree provider to update the badge
        const treeProvider = ChatsTreeProvider.getInstance();
        if (treeProvider) {
          treeProvider.resetUnreadForChat(this.chatId);
        }
      }
    }, null, this.disposables);

    // Start OpenClaw session polling if configured and agent features enabled
    if (isAgentEnabled()) {
      const openclaw = getOpenClaw();
      openclaw.initialize().then(async () => {
        if (await openclaw.checkIsConfigured()) {
          const { chatId: rawChatId, topicId } = TelegramService.parseDialogId(chatId);
          openclaw.startPolling(rawChatId, topicId, (info) => {
            this.panel.webview.postMessage({ type: 'agentInfo', info });
          });
        }
      });
    }

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
      if (isAgentEnabled()) {
        const { chatId: rawChatId, topicId } = TelegramService.parseDialogId(this.chatId);
        getOpenClaw().stopPolling(rawChatId, topicId);
      }
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
                      // Smart notification for background tabs (only if not muted)
                      if (event.message && !event.message.isOutgoing && !isChatMuted(this.context, this.chatId)) {
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
              // Track this chat as recently used after successfully sending a message
              tg.trackRecentChat(this.chatId);
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
          case 'sendLocalFile':
            // File path from VS Code explorer drag-and-drop
            await tg.connect();
            try {
              const fileUri = vscode.Uri.file(msg.filePath);
              const fileData = await vscode.workspace.fs.readFile(fileUri);
              const fileBuffer = Buffer.from(fileData);
              const fileName = msg.fileName || msg.filePath.split(/[\\/]/).pop() || 'file';
              const fileMimeType = msg.mimeType || 'application/octet-stream';
              // Show upload progress
              this.panel.webview.postMessage({ type: 'uploadProgress', tempId: msg.tempId, progress: 50 });
              await tg.sendFile(this.chatId, fileBuffer, fileName, fileMimeType, msg.caption);
              this.panel.webview.postMessage({ type: 'fileSendSuccess', tempId: msg.tempId });
            } catch (localFileErr: any) {
              this.panel.webview.postMessage({ type: 'fileSendFailed', tempId: msg.tempId, error: localFileErr.message || 'File send failed' });
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
          case 'openFile': {
            try {
              let filePath: string = msg.path || '';
              const line: number | null = msg.line || null;

              // Expand ~ to home directory
              if (filePath.startsWith('~/')) {
                const remoteHome = vscode.workspace.getConfiguration('oceangram').get<string>('remoteHome') || process.env.HOME || '/home/xiko';
                filePath = require('path').join(remoteHome, filePath.slice(2));
              }

              // Resolve relative paths against workspace root
              if (!filePath.startsWith('/')) {
                const workspaceFolders = vscode.workspace.workspaceFolders;
                if (workspaceFolders && workspaceFolders.length > 0) {
                  filePath = require('path').join(workspaceFolders[0].uri.fsPath, filePath);
                }
              }

              const uri = vscode.Uri.file(filePath);
              const doc = await vscode.workspace.openTextDocument(uri);
              const editor = await vscode.window.showTextDocument(doc, { preview: true });

              // If line number provided, move cursor and reveal
              if (line && line > 0) {
                const pos = new vscode.Position(line - 1, 0);
                editor.selection = new vscode.Selection(pos, pos);
                editor.revealRange(
                  new vscode.Range(pos, pos),
                  vscode.TextEditorRevealType.InCenter
                );
              }
            } catch (openErr: any) {
              vscode.window.showWarningMessage(`Could not open file: ${openErr.message || msg.path}`);
            }
            break;
          }
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
            if (!isAgentEnabled()) { break; }
            const openclaw = getOpenClaw();
            const { chatId: rawChatId, topicId: rawTopicId } = TelegramService.parseDialogId(this.chatId);
            const details = await openclaw.getDetailedSession(rawChatId, rawTopicId);
            this.panel.webview.postMessage({ type: 'agentDetails', data: details });
            break;
          }
          case 'getToolCalls': {
            if (!isAgentEnabled()) { break; }
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