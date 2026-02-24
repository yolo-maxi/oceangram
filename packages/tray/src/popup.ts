// popup.ts — Minimal popup: whitelisted + active-conversation tabs
/// <reference path="renderer.d.ts" />

(() => {
  const api = window.oceangram;

  // State
  let myId: string | null = null;
  let selectedDialogId: string | null = null;
  let isUserSelection = false; // true when user explicitly clicked a tab
  let unreadCounts: Record<string, number> = {};
  let replyTarget: { messageId: number; preview: string } | null = null;

  // Tab sources
  let whitelistEntries: TabEntry[] = [];
  let activeChats: TabEntry[] = [];
  // Merged, deduplicated tab list
  let allTabs: TabEntry[] = [];

  // Cached dialogs from daemon (refreshed every 10s)
  let cachedDialogs: Array<{ id: string | number; name?: string; topicName?: string; title?: string; firstName?: string; username?: string; unreadCount?: number; lastMessageOutgoing?: boolean; lastMessageTime?: number }> = [];

  interface TabEntry {
    dialogId: string;
    displayName: string;
    source: 'whitelist' | 'active';
  }

  interface MessageLike {
    id?: number;
    text?: string;
    message?: string;
    date?: number;
    timestamp?: number;
    fromId?: number | string;
    senderId?: number | string;
    senderName?: string;
    firstName?: string;
    isOutgoing?: boolean;
    dialogId?: string;
    chatId?: string;
  }

  // DOM refs
  const contactBar = document.getElementById('contactBar')!;
  const contactName = document.getElementById('contactName')!;
  const tabsEl = document.getElementById('tabs')!;
  const messagesEl = document.getElementById('messages')!;
  const loadingEl = document.getElementById('loadingState')!;
  const composerInput = document.getElementById('composerInput') as HTMLTextAreaElement;
  const sendBtn = document.getElementById('sendBtn') as HTMLButtonElement;
  const composerEl = document.getElementById('composer')!;
  const emptyState = document.getElementById('emptyState')!;
  const connectionBanner = document.getElementById('connectionBanner')!;

  const contactAvatar = document.getElementById('contactAvatar')!;
  const replyBar = document.getElementById('replyBar')!;
  const replyBarText = document.getElementById('replyBarText')!;
  const replyBarCancel = document.getElementById('replyBarCancel')!;

  // OpenClaw agent status DOM refs
  const agentStatus = document.getElementById('agentStatus')!;
  const agentStatusContent = document.getElementById('agentStatusContent')!;

  // OpenClaw state
  let openclawAvailable = false;
  let agentStatusTimer: ReturnType<typeof setTimeout> | null = null;

  /** Strip topic suffix from dialog ID for API calls (e.g. "-123:456" → "-123") */
  function baseDialogId(dialogId: string): string {
    return dialogId.split(':')[0];
  }

  function loadAvatar(entry: TabEntry): void {
    const initial = (entry.displayName || '?').charAt(0).toUpperCase();
    contactAvatar.innerHTML = `<span>${escapeHtml(initial)}</span>`;
    // Try loading photo — strip topic suffix for API
    const userId = baseDialogId(entry.dialogId);
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000));
    Promise.race([api.getProfilePhoto(userId), timeout]).then((dataUrl: string | null) => {
      if (dataUrl && selectedDialogId === entry.dialogId) {
        contactAvatar.innerHTML = `<img src="${dataUrl}" alt="">`;
      }
    }).catch(() => { /* keep initial */ });
  }

  function escapeHtml(str: string): string {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ── Tab merging ──

  function mergeTabs(): void {
    const seen = new Set<string>();
    const result: TabEntry[] = [];

    // Active chats first (left side)
    for (const chat of activeChats) {
      if (!seen.has(chat.dialogId)) {
        seen.add(chat.dialogId);
        result.push({ ...chat, source: 'active' });
      }
    }

    // Pinned chats that aren't already active (right side, dimmed)
    for (const pin of whitelistEntries) {
      if (!seen.has(pin.dialogId)) {
        seen.add(pin.dialogId);
        result.push({ ...pin, source: 'whitelist' });
      }
    }

    allTabs = result;

    // Update CSS variable for stacking density
    const count = allTabs.length;
    const overlap = count > 10 ? -14 : -8;
    document.documentElement.style.setProperty('--tab-overlap', `${overlap}px`);
  }

  // ── OpenClaw Agent Status (feature-flagged) ──

  async function checkOpenClaw(): Promise<void> {
    try {
      openclawAvailable = await api.openclawEnabled();
    } catch {
      openclawAvailable = false;
    }
    agentStatus.style.display = openclawAvailable ? '' : 'none';
    if (openclawAvailable) {
      refreshAgentStatus();
      startAgentStatusPolling();
    }
  }

  function formatTokens(n: number): string {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(0) + 'K';
    return String(n);
  }

  async function refreshAgentStatus(): Promise<void> {
    if (!openclawAvailable) return;
    try {
      const status = await api.openclawGetStatus();
      if (!status) return;

      const model = (status.model || 'unknown').replace(/^anthropic\//, '').replace(/^openai\//, '');
      const sessions = status.activeSessions || 0;
      const totalTokens = status.totalTokens || 0;
      const cost = status.estimatedCost ? `$${status.estimatedCost.toFixed(2)}` : '';

      let html = `<span class="agent-model">\u{1F916} ${escapeHtml(model)}</span>`;
      html += `<span class="agent-sessions">${sessions} session${sessions !== 1 ? 's' : ''}</span>`;
      if (totalTokens > 0) html += `<span class="agent-tokens">${formatTokens(totalTokens)} tok</span>`;
      if (cost) html += `<span class="agent-cost">${cost}</span>`;

      agentStatusContent.innerHTML = html;
    } catch {
      agentStatusContent.innerHTML = '<span class="agent-model">\u{1F916} disconnected</span>';
    }
  }

  function startAgentStatusPolling(): void {
    if (agentStatusTimer) clearInterval(agentStatusTimer);
    if (!openclawAvailable) return;
    agentStatusTimer = setInterval(refreshAgentStatus, 15000) as unknown as ReturnType<typeof setTimeout>;
  }

  // ── Init ──

  /** Apply theme to the app element */
  function applyTheme(theme: string): void {
    const appEl = document.querySelector('.app') as HTMLElement;
    if (!appEl) return;
    if (theme === 'system') {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      appEl.setAttribute('data-theme', prefersDark ? 'night' : 'day');
    } else {
      appEl.setAttribute('data-theme', theme);
    }
  }

  /** Build whitelist entries from config + dialogs, expanding forum topics */
  function buildWhitelistEntries(wl: Array<{ userId: string; username?: string; displayName?: string }>, dialogs: Array<{ id: string | number; name?: string; topicName?: string; title?: string; firstName?: string; username?: string }>): TabEntry[] {
    return wl.flatMap((e) => {
      const uid = String(e.userId);
      // Exact match first (DMs, or full chatId:topicId)
      const exactMatch = dialogs.find((d) => String(d.id) === uid);
      if (exactMatch) {
        return [{
          dialogId: String(exactMatch.id),
          displayName: e.displayName || e.username || uid,
          source: 'whitelist' as const,
        }];
      }
      // For forum groups: userId might be the base chatId — find all topics
      const topicMatches = dialogs.filter((d) => {
        const id = String(d.id);
        return id.startsWith(uid + ':');
      });
      if (topicMatches.length > 0) {
        return topicMatches.map((d) => ({
          dialogId: String(d.id),
          displayName: (d as any).name || (d as any).topicName || String(d.id),
          source: 'whitelist' as const,
        }));
      }
      // Fallback: use userId as-is
      return [{
        dialogId: uid,
        displayName: e.displayName || e.username || uid,
        source: 'whitelist' as const,
      }];
    });
  }

  async function init(): Promise<void> {
    // Apply theme
    try {
      const settings = await api.getSettings();
      applyTheme(settings?.theme || 'arctic');
    } catch { /* default arctic */ }

    // Listen for live theme changes from settings window
    api.onThemeChanged((theme: string) => applyTheme(theme));

    const me = await api.getMe();
    if (me && me.id) myId = String(me.id);

    // Load unread counts
    try {
      unreadCounts = await api.getUnreadCounts();
    } catch { /* ignore */ }

    // Get whitelist — resolve user IDs to actual dialog IDs
    const wl = await api.getWhitelist();
    try {
      cachedDialogs = await api.getDialogs(100);
    } catch { /* ignore */ }

    whitelistEntries = buildWhitelistEntries(wl, cachedDialogs);

    // Get active chats from tracker
    try {
      const ac = await api.getActiveChats();
      activeChats = ac.map((e) => ({
        dialogId: e.dialogId,
        displayName: e.displayName,
        source: 'active' as const,
      }));
    } catch { /* ignore */ }

    mergeTabs();
    renderLayout();

    // Start periodic dialog refresh (every 10s)
    startDialogRefresh();

    // Check if OpenClaw AI enrichments are available
    checkOpenClaw();
  }

  // ── Periodic dialog refresh ──

  let dialogRefreshTimer: ReturnType<typeof setInterval> | null = null;

  function startDialogRefresh(): void {
    if (dialogRefreshTimer) clearInterval(dialogRefreshTimer);
    dialogRefreshTimer = setInterval(refreshDialogs, 10000);
  }

  async function refreshDialogs(): Promise<void> {
    try {
      cachedDialogs = await api.getDialogs(100);
    } catch { return; }

    // Rebuild whitelist entries (forum topics may have changed)
    try {
      const wl = await api.getWhitelist();
      whitelistEntries = buildWhitelistEntries(wl, cachedDialogs);
    } catch { /* keep existing */ }

    // Build active chats from dialogs: any dialog with unreads or recent sent
    const newActive: TabEntry[] = [];
    const whitelistIds = new Set(whitelistEntries.map(e => e.dialogId));

    for (const d of cachedDialogs) {
      const dialogId = String(d.id);
      // Skip if already in whitelist
      if (whitelistIds.has(dialogId)) continue;

      const hasUnread = (d.unreadCount || 0) > 0;
      const displayName = d.name || d.topicName || d.title || d.firstName || d.username || dialogId;

      if (hasUnread) {
        newActive.push({ dialogId, displayName, source: 'active' as const });
      }
    }

    // Also include tracker active chats (covers sent-recently logic)
    try {
      const trackerActive = await api.getActiveChats();
      const seen = new Set(newActive.map(e => e.dialogId));
      for (const chat of trackerActive) {
        if (!seen.has(chat.dialogId) && !whitelistIds.has(chat.dialogId)) {
          seen.add(chat.dialogId);
          newActive.push({ dialogId: chat.dialogId, displayName: chat.displayName, source: 'active' as const });
        }
      }
    } catch { /* ignore */ }

    const oldIds = activeChats.map(t => t.dialogId).sort().join(',');
    const newIds = newActive.map(t => t.dialogId).sort().join(',');

    activeChats = newActive;
    mergeTabs();

    if (oldIds !== newIds) {
      // Tab list changed — rebuild DOM but preserve selection
      renderLayout();
    } else {
      // Just update badges/highlights
      if (allTabs.length > 1) updateTabActive();
    }
  }

  /** Determine layout based on tab count and render accordingly. */
  function renderLayout(): void {
    if (allTabs.length === 0) {
      // No tabs at all — show empty state
      contactBar.style.display = 'none';
      tabsEl.style.display = 'none';
      messagesEl.style.display = 'none';
      composerEl.style.display = 'none';
      emptyState.style.display = '';
      return;
    }

    // We have tabs — ensure messaging UI is visible
    emptyState.style.display = 'none';
    messagesEl.style.display = '';
    composerEl.style.display = '';

    if (allTabs.length === 1) {
      // Single tab — show contact bar, no tabs
      contactBar.style.display = '';
      tabsEl.style.display = 'none';
      // Only auto-select on first load
      if (!selectedDialogId) {
        selectTab(allTabs[0].dialogId, allTabs[0].displayName, false);
      }
    } else {
      // Multiple tabs
      contactBar.style.display = 'none';
      tabsEl.style.display = 'flex';
      renderTabs();
      // Only auto-select on first load when nothing selected
      if (!selectedDialogId) {
        selectTab(allTabs[0].dialogId, allTabs[0].displayName, false);
      }
    }
  }

  // ── Tabs ──

  function renderTabs(): void {
    const activeDialogIds = new Set(activeChats.map((c) => c.dialogId));

    tabsEl.innerHTML = '';
    allTabs.forEach((entry, idx) => {
      const isActive = entry.dialogId === selectedDialogId;
      const hasUnread = (unreadCounts[entry.dialogId] || 0) > 0;
      const isPinned = entry.source === 'whitelist' && !activeDialogIds.has(entry.dialogId);

      const tab = document.createElement('div');
      tab.className = `tab${isActive ? ' active' : ''}${hasUnread ? ' has-unread' : ''}${isPinned ? ' pinned' : ''}`;
      tab.dataset.dialogId = entry.dialogId;
      tab.dataset.tabIndex = String(idx);
      tab.title = entry.displayName;

      // Reverse stacking: leftmost = highest z-index
      tab.style.zIndex = isActive ? '50' : String(allTabs.length - idx);

      const avatar = document.createElement('span');
      avatar.className = 'tab-avatar';
      avatar.textContent = (entry.displayName || '?').charAt(0).toUpperCase();
      tab.appendChild(avatar);

      if (isActive) {
        // Pin/unpin icon
        const pinIcon = document.createElement('span');
        pinIcon.className = `tab-pin${isPinned ? ' is-pinned' : ''}`;
        pinIcon.textContent = '📌';
        pinIcon.title = isPinned ? 'Unpin chat' : 'Pin chat';
        pinIcon.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (isPinned) {
            await api.removeUser(baseDialogId(entry.dialogId));
          } else {
            await api.addUser({ userId: entry.dialogId, displayName: entry.displayName });
          }
          // Refresh whitelist
          try {
            const wl = await api.getWhitelist();
            whitelistEntries = buildWhitelistEntries(wl, cachedDialogs);
            mergeTabs();
            renderTabs();
          } catch { /* ignore */ }
        });
        tab.appendChild(pinIcon);

        const name = document.createElement('span');
        name.className = 'tab-name';
        name.textContent = entry.displayName;
        tab.appendChild(name);
      }

      const badge = document.createElement('span');
      badge.className = 'tab-badge';
      tab.appendChild(badge);

      tab.addEventListener('click', () => {
        if (entry.dialogId !== selectedDialogId) {
          selectTab(entry.dialogId, entry.displayName, true);
        }
      });

      tabsEl.appendChild(tab);

      // Load avatar async
      const photoId = baseDialogId(entry.dialogId);
      const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000));
      Promise.race([api.getProfilePhoto(photoId), timeout]).then((dataUrl: string | null) => {
        if (dataUrl && avatar.parentNode) {
          avatar.innerHTML = `<img src="${dataUrl}" alt="">`;
        }
      }).catch(() => { /* ignore */ });
    });
  }

  function updateTabActive(): void {
    const activeDialogIds = new Set(activeChats.map((c) => c.dialogId));

    tabsEl.querySelectorAll('.tab').forEach((el) => {
      const htmlEl = el as HTMLElement;
      const did = htmlEl.dataset.dialogId;
      const idx = parseInt(htmlEl.dataset.tabIndex || '0', 10);
      const isActive = did === selectedDialogId;
      el.classList.toggle('active', isActive);
      const hasUnread = did ? (unreadCounts[did] || 0) > 0 : false;
      el.classList.toggle('has-unread', hasUnread && !isActive);

      const entry = allTabs.find((t) => t.dialogId === did);
      const isPinned = entry?.source === 'whitelist' && did ? !activeDialogIds.has(did) : false;
      el.classList.toggle('pinned', isPinned);

      // Reverse stacking: leftmost = highest z-index
      htmlEl.style.zIndex = isActive ? '50' : String(allTabs.length - idx);

      // Show/hide name based on active state
      let nameEl = el.querySelector('.tab-name') as HTMLElement | null;
      if (isActive) {
        if (!nameEl) {
          nameEl = document.createElement('span');
          nameEl.className = 'tab-name';
          nameEl.textContent = entry?.displayName || '';
          el.querySelector('.tab-avatar')?.after(nameEl);
        }
      } else if (nameEl) {
        nameEl.remove();
      }
    });
  }

  // ── Select tab (clean rewrite) ──
  // ONLY called by:
  //   1. User clicking a tab (userClick = true)
  //   2. Initial load / first tab (userClick = false)
  //   3. Notification click via onSelectDialog (userClick = true)
  // NEVER called by renderLayout/renderTabs (they only rebuild DOM)

  async function selectTab(dialogId: string, displayName: string, userClick = false): Promise<void> {
    if (userClick) isUserSelection = true;

    const previousUnreads = unreadCounts[dialogId] || 0;
    selectedDialogId = dialogId;

    // Clear pending state when switching tabs
    clearReplyTarget();
    clearAttachment();

    // Update header INSTANTLY (before loading messages)
    contactName.textContent = displayName;
    // Show initial letter immediately, then load photo async
    const initial = (displayName || '?').charAt(0).toUpperCase();
    contactAvatar.innerHTML = `<span>${escapeHtml(initial)}</span>`;
    // Fire-and-forget avatar load
    const photoId = baseDialogId(dialogId);
    const avatarTimeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000));
    Promise.race([api.getProfilePhoto(photoId), avatarTimeout]).then((dataUrl: string | null) => {
      if (dataUrl && selectedDialogId === dialogId) {
        contactAvatar.innerHTML = `<img src="${dataUrl}" alt="">`;
      }
    }).catch(() => { /* keep initial */ });

    // Update tab highlight immediately
    if (allTabs.length > 1) {
      updateTabActive();
    }

    // Show loading only if no cache
    if (!messageCache[dialogId] || messageCache[dialogId].length === 0) {
      loadingEl.style.display = '';
      loadingEl.textContent = 'Loading messages...';
      messagesEl.innerHTML = '';
      messagesEl.appendChild(loadingEl);
    }

    await loadMessages(dialogId);

    // Reset poll tracker for new tab
    const cached = messageCache[dialogId];
    if (cached && cached.length > 0) {
      lastSeenMsgId = Math.max(...cached.map((m: MessageLike) => m.id || 0));
    } else {
      lastSeenMsgId = 0;
    }

    // Mark as read
    api.markRead(dialogId);
    unreadCounts[dialogId] = 0;
    if (allTabs.length > 1) updateTabActive();

    // Focus composer
    setTimeout(() => composerInput.focus(), 100);
  }

  // ── Message cache ──
  const messageCache: Record<string, MessageLike[]> = {};

  async function loadMessages(dialogId: string): Promise<void> {
    // Show cached messages instantly
    if (messageCache[dialogId] && messageCache[dialogId].length > 0) {
      loadingEl.style.display = 'none';
      renderMessages(messageCache[dialogId]);
      return;
    }

    try {
      const messages = await api.getMessages(dialogId, 30);
      loadingEl.style.display = 'none';

      if (!Array.isArray(messages) || messages.length === 0) {
        messagesEl.innerHTML = `<div class="loading">No messages yet</div>`;
        return;
      }

      messageCache[dialogId] = messages;
      renderMessages(messages);
    } catch (err) {
      console.error('[loadMessages] ERROR for', dialogId, err);
      loadingEl.style.display = 'none';
      messagesEl.innerHTML = `<div class="loading">Failed to load messages</div>`;
    }
  }

  // ── Polling fallback for real-time messages ──
  let lastSeenMsgId: number = 0;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  function startPolling(): void {
    if (pollTimer) return;
    pollTimer = setInterval(pollForNewMessages, 500);
  }

  function stopPolling(): void {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  let pollCount = 0;
  async function pollForNewMessages(): Promise<void> {
    if (!selectedDialogId) return;
    pollCount++;
    if (pollCount % 10 === 1) console.log('[poll]', pollCount, 'dialog:', selectedDialogId, 'lastSeen:', lastSeenMsgId);
    try {
      const messages = await api.getMessages(selectedDialogId, 5);
      if (!Array.isArray(messages) || messages.length === 0) return;

      const newest = messages[messages.length - 1];
      const newestId = newest.id || 0;

      if (lastSeenMsgId > 0 && newestId > lastSeenMsgId) {
        // New messages arrived — hide typing indicator
        hideTyping();
        // Find ones we haven't seen
        const newMsgs = messages.filter((m: MessageLike) => (m.id || 0) > lastSeenMsgId);
        for (const msg of newMsgs) {
          // Check if already in DOM
          const existing = messagesEl.querySelector(`[data-msg-id="${msg.id}"]`);
          if (!existing) {
            appendMessage(msg);
          }
        }
        // Update cache
        const cached = messageCache[selectedDialogId] || [];
        const cachedIds = new Set(cached.map((m: MessageLike) => m.id));
        for (const msg of newMsgs) {
          if (!cachedIds.has(msg.id)) cached.push(msg);
        }
        messageCache[selectedDialogId] = cached;

        api.markRead(selectedDialogId);
      }

      lastSeenMsgId = newestId;
    } catch { /* ignore poll errors */ }
  }

  // Start polling immediately
  startPolling();

  // ── Reply bar ──

  function setReplyTarget(messageId: number, preview: string): void {
    replyTarget = { messageId, preview };
    replyBarText.textContent = `Replying to: ${preview}`;
    replyBar.style.display = '';
    // Highlight the target message
    messagesEl.querySelectorAll('.message.reply-target').forEach((el) => el.classList.remove('reply-target'));
    const targetEl = messagesEl.querySelector(`[data-msg-id="${messageId}"]`);
    if (targetEl) targetEl.classList.add('reply-target');
    composerInput.focus();
  }

  function clearReplyTarget(): void {
    replyTarget = null;
    replyBar.style.display = 'none';
    replyBarText.textContent = '';
    messagesEl.querySelectorAll('.message.reply-target').forEach((el) => el.classList.remove('reply-target'));
  }

  replyBarCancel.addEventListener('click', clearReplyTarget);

  // ── Message rendering ──

  function renderMessages(messages: MessageLike[], preserveTyping = true): void {
    const wasTyping = preserveTyping && messagesEl.contains(typingBubble);
    const sorted = [...messages].sort((a, b) => {
      const tA = a.date || a.timestamp || 0;
      const tB = b.date || b.timestamp || 0;
      return tA - tB;
    });

    let html = '';
    let lastDate = '';

    for (const msg of sorted) {
      const date = formatDate(msg.date || msg.timestamp);
      if (date !== lastDate) {
        html += `<div class="date-separator"><span>${date}</span></div>`;
        lastDate = date;
      }

      const fromId = String(msg.fromId || msg.senderId || '');
      const isOutgoing = msg.isOutgoing === true || fromId === myId;
      const text = formatText(msg.text || msg.message || '');
      const time = formatTime(msg.date || msg.timestamp);
      const msgId = msg.id || 0;

      const replyToId = (msg as any).replyToId;
      let replyHtml = '';
      if (replyToId) {
        const replyMsg = sorted.find(m => m.id === replyToId);
        const replyText = replyMsg ? (replyMsg.text || replyMsg.message || '').substring(0, 80) : `Message #${replyToId}`;
        replyHtml = `<div class="reply-context" data-reply-to="${replyToId}">${escapeHtml(replyText)}</div>`;
      }

      html += `
        <div class="message ${isOutgoing ? 'outgoing' : 'incoming'}" data-msg-id="${msgId}">
          ${replyHtml}
          <div class="text">${text}</div>
          <div class="time">${time}</div>
        </div>
      `;
    }

    messagesEl.innerHTML = html;
    if (wasTyping) messagesEl.appendChild(typingBubble);
    bindMessageClicks();
    scrollToBottom();
  }

  function appendMessage(msg: MessageLike): void {
    const fromId = String(msg.fromId || msg.senderId || '');
    const isOutgoing = msg.isOutgoing === true || fromId === myId;
    const text = formatText(msg.text || msg.message || '');
    const time = formatTime(msg.date || msg.timestamp);
    const msgId = msg.id || 0;

    // Remove loading/empty states
    const loading = messagesEl.querySelector('.loading');
    if (loading) loading.remove();

    const div = document.createElement('div');
    div.className = `message ${isOutgoing ? 'outgoing' : 'incoming'}`;
    div.dataset.msgId = String(msgId);
    const replyToId = (msg as any).replyToId;
    let replyHtml = '';
    if (replyToId) {
      const cached = selectedDialogId ? messageCache[selectedDialogId] : null;
      const replyMsg = cached?.find(m => m.id === replyToId);
      const replyText = replyMsg ? (replyMsg.text || replyMsg.message || '').substring(0, 80) : `Message #${replyToId}`;
      replyHtml = `<div class="reply-context" data-reply-to="${replyToId}">${escapeHtml(replyText)}</div>`;
    }

    div.innerHTML = `
      ${replyHtml}
      <div class="text">${text}</div>
      <div class="time">${time}</div>
    `;
    div.addEventListener('click', () => {
      if (msgId) {
        const preview = (msg.text || msg.message || '').substring(0, 50);
        setReplyTarget(msgId, preview);
      }
    });
    messagesEl.appendChild(div);
    scrollToBottom();
  }

  function bindMessageClicks(): void {
    messagesEl.querySelectorAll('.message[data-msg-id]').forEach((el) => {
      el.addEventListener('click', () => {
        const msgId = parseInt((el as HTMLElement).dataset.msgId || '0', 10);
        if (!msgId) return;
        const textEl = el.querySelector('.text');
        const preview = (textEl?.textContent || '').substring(0, 50);
        setReplyTarget(msgId, preview);
      });
    });
    messagesEl.querySelectorAll('.reply-context[data-reply-to]').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const replyTo = (el as HTMLElement).dataset.replyTo;
        if (!replyTo) return;
        const target = messagesEl.querySelector(`.message[data-msg-id="${replyTo}"]`);
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
          target.classList.add('reply-highlight');
          setTimeout(() => target.classList.remove('reply-highlight'), 1500);
        }
      });
    });
  }

  function scrollToBottom(): void {
    requestAnimationFrame(() => {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    });
  }

  // ── GitHub PR detection ──

  let prCardCounter = 0;

  function detectGitHubPRs(html: string): string {
    return html.replace(
      /<a href="(https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+))[^"]*"[^>]*>[^<]*<\/a>/g,
      (_match, url: string, owner: string, repo: string, prNum: string) => {
        const cardId = `pr-card-${++prCardCounter}`;
        const prNumber = parseInt(prNum, 10);
        setTimeout(() => loadPRCard(cardId, owner, repo, prNumber, url), 0);
        return `<div class="gh-pr-card loading" id="${cardId}">` +
          `<div class="gh-pr-header">🔀 PR #${prNum} · ${escapeHtml(owner)}/${escapeHtml(repo)}</div>` +
          `<div class="gh-pr-title">Loading...</div>` +
          `</div>`;
      }
    );
  }

  async function loadPRCard(cardId: string, owner: string, repo: string, prNumber: number, url: string): Promise<void> {
    const card = document.getElementById(cardId);
    if (!card) return;

    try {
      const pr = await api.fetchGitHubPR(owner, repo, prNumber);
      const statusClass = pr.merged ? 'merged' : pr.state === 'closed' ? 'closed' : 'open';
      const statusLabel = pr.merged ? 'Merged' : pr.state === 'closed' ? 'Closed' : 'Open';
      const showMerge = pr.state === 'open' && !pr.merged;

      card.classList.remove('loading');
      card.classList.add(statusClass);
      card.innerHTML =
        `<div class="gh-pr-header">🔀 PR #${pr.number} · ${escapeHtml(owner)}/${escapeHtml(repo)}</div>` +
        `<div class="gh-pr-title">${escapeHtml(pr.title)}</div>` +
        `<div class="gh-pr-meta">` +
          `by @${escapeHtml(pr.user.login)} · ` +
          `<span class="gh-pr-additions">+${pr.additions}</span> ` +
          `<span class="gh-pr-deletions">-${pr.deletions}</span> · ` +
          `<span class="gh-pr-status ${statusClass}">${statusLabel}</span>` +
        `</div>` +
        `<div class="gh-pr-actions">` +
          `<a class="gh-pr-btn view" href="${escapeHtml(url)}" target="_blank" rel="noopener">View</a>` +
          (showMerge ? `<button class="gh-pr-btn merge" data-owner="${escapeHtml(owner)}" data-repo="${escapeHtml(repo)}" data-pr="${pr.number}">Merge</button>` : '') +
        `</div>`;

      const mergeBtn = card.querySelector('.gh-pr-btn.merge') as HTMLButtonElement | null;
      if (mergeBtn) {
        mergeBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          mergeBtn.disabled = true;
          mergeBtn.textContent = 'Merging...';
          try {
            const result = await api.mergeGitHubPR(owner, repo, prNumber);
            if (result.merged) {
              card.classList.remove('open');
              card.classList.add('merged');
              const statusEl = card.querySelector('.gh-pr-status');
              if (statusEl) {
                statusEl.className = 'gh-pr-status merged';
                statusEl.textContent = 'Merged';
              }
              mergeBtn.remove();
            } else {
              mergeBtn.textContent = 'Failed';
              mergeBtn.title = result.message;
              setTimeout(() => {
                mergeBtn.textContent = 'Merge';
                mergeBtn.disabled = false;
              }, 2000);
            }
          } catch {
            mergeBtn.textContent = 'Error';
            setTimeout(() => {
              mergeBtn.textContent = 'Merge';
              mergeBtn.disabled = false;
            }, 2000);
          }
        });
      }

      card.addEventListener('click', (e) => e.stopPropagation());
    } catch {
      card.classList.remove('loading');
      card.classList.add('error');
      card.innerHTML =
        `<div class="gh-pr-header">🔀 PR #${prNumber} · ${escapeHtml(owner)}/${escapeHtml(repo)}</div>` +
        `<div class="gh-pr-actions">` +
          `<a class="gh-pr-btn view" href="${escapeHtml(url)}" target="_blank" rel="noopener">View on GitHub</a>` +
        `</div>`;
      card.addEventListener('click', (e) => e.stopPropagation());
    }
  }

  // ── Formatting ──

  function formatText(text: string): string {
    if (!text) return '';
    let html = escapeHtml(text);
    html = html.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
    html = detectGitHubPRs(html);
    html = html.replace(/```([\s\S]+?)```/g, '<pre>$1</pre>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, '<em>$1</em>');
    html = html.replace(/`([^`]+?)`/g, '<code>$1</code>');
    html = html.replace(/\n/g, '<br>');
    return html;
  }

  function formatDate(ts: number | undefined): string {
    if (!ts) return '';
    const d = typeof ts === 'number' && ts < 1e12 ? new Date(ts * 1000) : new Date(ts);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) return 'Today';
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  function formatTime(ts: number | undefined): string {
    if (!ts) return '';
    const d = typeof ts === 'number' && ts < 1e12 ? new Date(ts * 1000) : new Date(ts);
    return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  }

  // ── Sending ──

  async function sendMessage(): Promise<void> {
    const text = composerInput.value.trim();
    const hasFile = !!pendingFile;
    if (!text && !hasFile) return;
    if (!selectedDialogId) return;

    composerInput.value = '';
    composerInput.style.height = 'auto';
    sendBtn.disabled = true;

    const currentReplyTo = replyTarget?.messageId;
    clearReplyTarget();

    if (hasFile && pendingFile) {
      const file = pendingFile;
      clearAttachment();
      appendMessage({
        fromId: myId || undefined,
        text: text ? `📎 ${text}` : '📎 Photo',
        date: Math.floor(Date.now() / 1000),
        isOutgoing: true,
      });
      try {
        const base64 = await fileToBase64(file);
        await api.sendFile(selectedDialogId, base64, file.name, file.type, text || undefined);
      } catch (err) {
        console.error('File send failed:', err);
      }
    } else {
      appendMessage({
        fromId: myId || undefined,
        text,
        date: Math.floor(Date.now() / 1000),
        isOutgoing: true,
      });
      try {
        await api.sendMessage(selectedDialogId, text, currentReplyTo);
      } catch (err) {
        console.error('Send failed:', err);
      }
    }

    // Bump lastSeenMsgId so the poll doesn't duplicate our sent message
    try {
      const latest = await api.getMessages(selectedDialogId, 1);
      if (Array.isArray(latest) && latest.length > 0) {
        lastSeenMsgId = Math.max(lastSeenMsgId, latest[latest.length - 1].id || 0);
      }
    } catch { /* ignore */ }

    sendBtn.disabled = false;
    composerInput.focus();
  }

  // ── Event handlers ──

  sendBtn.addEventListener('click', sendMessage);

  composerInput.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  composerInput.addEventListener('input', () => {
    composerInput.style.height = 'auto';
    composerInput.style.height = Math.min(composerInput.scrollHeight, 100) + 'px';
  });

  // ── File helper ──

  function fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        const base64 = result.includes(',') ? result.split(',')[1] : result;
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  // ── File preview ──

  const attachmentStrip = document.getElementById('attachmentStrip')!;
  const attachmentThumb = document.getElementById('attachmentThumb') as HTMLImageElement;
  const attachmentName = document.getElementById('attachmentName')!;
  const attachmentRemove = document.getElementById('attachmentRemove')!;
  let pendingFile: File | null = null;
  let isSendingFile = false;

  function attachFile(file: File): void {
    pendingFile = file;
    attachmentName.textContent = file.name;

    if (file.type.startsWith('image/')) {
      const url = URL.createObjectURL(file);
      attachmentThumb.src = url;
      attachmentThumb.style.display = '';
    } else {
      attachmentThumb.style.display = 'none';
    }

    attachmentStrip.style.display = '';
    composerInput.focus();
  }

  function clearAttachment(): void {
    pendingFile = null;
    attachmentStrip.style.display = 'none';
    if (attachmentThumb.src.startsWith('blob:')) {
      URL.revokeObjectURL(attachmentThumb.src);
    }
    attachmentThumb.src = '';
    composerInput.focus();
  }

  attachmentRemove.addEventListener('click', clearAttachment);

  // ── Paste images ──

  function handleImagePaste(e: ClipboardEvent): boolean {
    if (isSendingFile) return false;
    const items = e.clipboardData?.items;
    if (!items) return false;

    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        e.stopPropagation();
        const file = item.getAsFile();
        if (file) attachFile(file);
        return true;
      }
    }
    return false;
  }

  composerInput.addEventListener('paste', (e: ClipboardEvent) => {
    handleImagePaste(e);
  });

  document.addEventListener('paste', (e: ClipboardEvent) => {
    if (e.target === composerInput) return;
    handleImagePaste(e);
  });

  // ── Drag and drop files ──

  const appEl = document.querySelector('.app') as HTMLElement;

  appEl.addEventListener('dragover', (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    appEl.classList.add('drag-over');
  });

  appEl.addEventListener('dragleave', (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    appEl.classList.remove('drag-over');
  });

  appEl.addEventListener('drop', async (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    appEl.classList.remove('drag-over');

    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;

    if (files[0]) attachFile(files[0]);
  });

  // ── Real-time updates ──

  function dialogMatches(eventId: string, tabId: string): boolean {
    if (eventId === tabId) return true;
    const baseId = eventId.split(':')[0];
    return baseId === tabId;
  }

  function findMatchingTab(eventDialogId: string): TabEntry | undefined {
    return allTabs.find((t) => dialogMatches(eventDialogId, t.dialogId));
  }

  api.onNewMessage((data) => {
    hideTyping();
    if (!data || !data.message) return;
    const msg = data.message;
    const msgDialogId = String(msg.dialogId || msg.chatId || data.dialogId || '');

    // Find matching tab (handles forum topic ID mismatches)
    const matchedTab = findMatchingTab(msgDialogId);
    const tabDialogId = matchedTab?.dialogId;

    // Update cache using the tab's dialog ID
    if (tabDialogId && messageCache[tabDialogId]) {
      messageCache[tabDialogId] = [...messageCache[tabDialogId], msg];
    }

    if (tabDialogId && tabDialogId === selectedDialogId) {
      // Current chat — append message
      appendMessage(msg);
      api.markRead(selectedDialogId);
    } else if (tabDialogId) {
      // Other visible tab — update unread
      unreadCounts[tabDialogId] = (unreadCounts[tabDialogId] || 0) + 1;
      updateTabActive();
    }
    // New tabs from non-whitelisted chats are handled by the periodic dialog refresh
  });

  // ── Typing indicator ──
  let typingTimeout: ReturnType<typeof setTimeout> | null = null;
  const typingBubble = document.createElement('div');
  typingBubble.className = 'message typing-indicator';
  typingBubble.innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div>';

  function showTyping(): void {
    if (!messagesEl.contains(typingBubble)) {
      messagesEl.appendChild(typingBubble);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
    if (typingTimeout) clearTimeout(typingTimeout);
    typingTimeout = setTimeout(hideTyping, 12000);
  }

  function hideTyping(): void {
    if (typingTimeout) { clearTimeout(typingTimeout); typingTimeout = null; }
    typingBubble.remove();
  }

  api.onTyping((data) => {
    const matchedTab = findMatchingTab(data.dialogId);
    const tabDialogId = matchedTab?.dialogId;
    if (tabDialogId === selectedDialogId && String(data.userId) !== String(myId)) {
      if (data.action === 'SendMessageCancelAction') {
        hideTyping();
      } else {
        showTyping();
      }
    }
  });

  api.onUnreadCountsUpdated((counts) => {
    unreadCounts = counts;
    updateTabActive();
  });

  api.onActiveChatsChanged((chats) => {
    // Tracker emitted new active chats — merge them in
    const newActive = chats.map((e) => ({
      dialogId: e.dialogId,
      displayName: e.displayName,
      source: 'active' as const,
    }));
    const oldIds = activeChats.map(t => t.dialogId).sort().join(',');
    const newIds = newActive.map(t => t.dialogId).sort().join(',');
    activeChats = newActive;
    if (oldIds !== newIds) {
      mergeTabs();
      renderLayout();
    }
  });

  api.onConnectionChanged((connected: boolean) => {
    connectionBanner.classList.toggle('visible', !connected);
  });

  // Select dialog from main process (e.g., notification click)
  api.onSelectDialog((dialogId) => {
    // Find tab entry or create one on the fly
    const entry = allTabs.find((t) => t.dialogId === dialogId);
    if (entry) {
      selectTab(entry.dialogId, entry.displayName, true);
    } else {
      // Dialog not in tabs yet — add it as active and select
      const displayName = dialogId; // will get resolved on next dialog refresh
      activeChats.push({ dialogId, displayName, source: 'active' });
      mergeTabs();
      renderLayout();
      selectTab(dialogId, displayName, true);
    }
  });

  // ── Keyboard shortcuts ──

  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      api.closePopup();
    }
  });

  // ── Start ──
  init();
})();
