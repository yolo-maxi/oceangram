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
  // Whether the currently selected dialog is a group/forum (show sender names)
  let currentDialogIsGroup = false;
  let blacklistEntries: Array<{ dialogId: string; displayName: string }> = [];
  // Merged, deduplicated tab list (excluding muted/blacklisted)
  let allTabs: TabEntry[] = [];
  // Ad-hoc tabs opened via "Direct chat" from sender context menu
  let adHocTabs: TabEntry[] = [];

  // Cached dialogs from daemon (refreshed every 10s)
  let cachedDialogs: Array<{ id: string | number; name?: string; topicName?: string; title?: string; firstName?: string; username?: string; unreadCount?: number; lastMessageOutgoing?: boolean; lastMessageTime?: number }> = [];

  interface TabEntry {
    dialogId: string;
    displayName: string;
    source: 'whitelist' | 'active' | 'direct';
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
    mediaType?: 'photo' | 'video' | 'voice' | 'file' | 'sticker' | 'gif';
    mediaWidth?: number;
    mediaHeight?: number;
    replyToId?: number;
  }

  // DOM refs
  const contactBar = document.getElementById('contactBar')!;
  const contactName = document.getElementById('contactName')!;
  const tabsEl = document.getElementById('tabs')!;
  const messagesEl = document.getElementById('messages')!;
  const messagesScrollEl = document.getElementById('messagesScroll')!;
  const loadingEl = document.getElementById('loadingState')!;
  const composerInput = document.getElementById('composerInput') as HTMLTextAreaElement;
  const sendBtn = document.getElementById('sendBtn') as HTMLButtonElement;
  const composerEl = document.getElementById('composer')!;
  const mentionDropdown = document.getElementById('mentionDropdown')!;
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

  async function loadMessageImage(
    container: HTMLElement,
    dialogId: string,
    messageId: number,
    width?: number,
    height?: number,
  ): Promise<void> {
    const placeholder = container.querySelector('.msg-media-placeholder');
    try {
      const dataUrl = await api.getMedia(dialogId, messageId);
      if (!dataUrl) return;
      const img = document.createElement('img');
      img.src = dataUrl;
      img.alt = '';
      img.loading = 'lazy';
      if (width != null && height != null && width > 0 && height > 0) {
        const maxW = 220;
        const maxH = 180;
        const r = Math.min(maxW / width, maxH / height, 1);
        img.style.width = `${Math.round(width * r)}px`;
        img.style.height = `${Math.round(height * r)}px`;
      } else {
        img.style.maxWidth = '220px';
        img.style.maxHeight = '180px';
      }
      if (placeholder) placeholder.remove();
      container.appendChild(img);
      (container as HTMLElement).dataset.loadedUrl = dataUrl;
    } catch {
      if (placeholder) (placeholder as HTMLElement).textContent = 'Failed to load';
    }
  }

  function openImageFullscreen(src: string): void {
    if (!src || !src.startsWith('data:')) return;
    const overlay = document.createElement('div');
    overlay.className = 'image-fullscreen-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Image fullscreen');
    overlay.innerHTML = `<img src="${escapeHtml(src)}" alt="Full size">`;
    overlay.addEventListener('click', () => overlay.remove());
    document.body.appendChild(overlay);
  }

  // ── Tab merging ──

  function isBlacklisted(dialogId: string): boolean {
    return blacklistEntries.some((b) => {
      const bid = String(b.dialogId);
      return bid === dialogId || dialogId.startsWith(bid + ':');
    });
  }

  function mergeTabs(): void {
    const seen = new Set<string>();
    const result: TabEntry[] = [];

    // Active chats first (left side) — exclude muted
    for (const chat of activeChats) {
      if (!isBlacklisted(chat.dialogId) && !seen.has(chat.dialogId)) {
        seen.add(chat.dialogId);
        result.push({ ...chat, source: 'active' });
      }
    }

    // Pinned chats that aren't already active (right side, dimmed) — exclude muted
    for (const pin of whitelistEntries) {
      if (!isBlacklisted(pin.dialogId) && !seen.has(pin.dialogId)) {
        seen.add(pin.dialogId);
        result.push({ ...pin, source: 'whitelist' });
      }
    }

    // Ad-hoc direct chats (opened from sender context menu)
    for (const t of adHocTabs) {
      if (!isBlacklisted(t.dialogId) && !seen.has(t.dialogId)) {
        seen.add(t.dialogId);
        result.push({ ...t, source: 'direct' });
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
    if (!selectedDialogId) {
      agentStatus.style.display = 'none';
      return;
    }

    try {
      const session = await api.openclawGetSession(selectedDialogId);
      if (!session) {
        // No session for this dialog — hide the bar
        agentStatus.style.display = 'none';
        return;
      }

      agentStatus.style.display = '';
      const pct = session.contextUsedPct;
      const contextClass = pct >= 90 ? 'context-critical' : pct >= 70 ? 'context-warn' : 'context-ok';

      let html = `<span class="agent-model">${escapeHtml(session.model)}</span>`;
      html += `<span class="agent-context ${contextClass}">${formatTokens(session.totalTokens)}/${formatTokens(session.contextWindow)} (${pct}%)</span>`;

      // Time since last activity
      if (session.updatedAt) {
        const agoMs = Date.now() - session.updatedAt;
        const agoMin = Math.floor(agoMs / 60000);
        if (agoMin < 1) html += `<span class="agent-activity">just now</span>`;
        else if (agoMin < 60) html += `<span class="agent-activity">${agoMin}m ago</span>`;
        else html += `<span class="agent-activity">${Math.floor(agoMin / 60)}h ago</span>`;
      }

      agentStatusContent.innerHTML = html;
    } catch {
      agentStatus.style.display = 'none';
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

  /**
   * Build whitelist entries from config + dialogs.
   * When a pinned entry is a forum (base chatId), we only expand to topics that are "active"
   * (user sent recently + has unreads) so we don't flood the bar with every topic.
   * @param activeDialogIds - optional set of dialog IDs that qualify as active (recent send + unreads)
   */
  function buildWhitelistEntries(
    wl: Array<{ userId: string; username?: string; displayName?: string }>,
    dialogs: Array<{ id: string | number; name?: string; topicName?: string; title?: string; firstName?: string; username?: string }>,
    activeDialogIds?: Set<string>
  ): TabEntry[] {
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
      // For forum groups: userId might be the base chatId — only show topics that are active
      const topicMatches = dialogs.filter((d) => {
        const id = String(d.id);
        return id.startsWith(uid + ':');
      });
      if (topicMatches.length > 0) {
        const toShow = activeDialogIds
          ? topicMatches.filter((d) => activeDialogIds.has(String(d.id)))
          : [];
        return toShow.map((d) => ({
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

    // Get whitelist and blacklist
    const wl = await api.getWhitelist();
    try {
      blacklistEntries = await api.getBlacklist();
    } catch { /* keep empty */ }
    try {
      cachedDialogs = await api.getDialogs(100);
    } catch { /* ignore */ }

    // Get active chats first so we can filter whitelist forum expansion (only show active topics)
    try {
      const ac = await api.getActiveChats();
      activeChats = ac.map((e) => ({
        dialogId: e.dialogId,
        displayName: e.displayName,
        source: 'active' as const,
      }));
    } catch { /* ignore */ }

    const activeIds = new Set(activeChats.map((c) => c.dialogId));
    whitelistEntries = buildWhitelistEntries(wl, cachedDialogs, activeIds);

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

    // Build active chats ONLY from tracker (user sent recently + has unreads)
    const newActive: TabEntry[] = [];
    try {
      const trackerActive = await api.getActiveChats();
      for (const chat of trackerActive) {
        // Try to get a better display name from cached dialogs
        const matchedDialog = cachedDialogs.find(d => String(d.id) === chat.dialogId);
        const displayName = matchedDialog
          ? ((matchedDialog as any).name || (matchedDialog as any).topicName || matchedDialog.title || chat.displayName)
          : chat.displayName;
        newActive.push({ dialogId: chat.dialogId, displayName, source: 'active' as const });
      }
    } catch { /* ignore */ }

    const activeIds = new Set(newActive.map((c) => c.dialogId));

    // Rebuild whitelist entries (forum expansion only includes active topics)
    try {
      const wl = await api.getWhitelist();
      whitelistEntries = buildWhitelistEntries(wl, cachedDialogs, activeIds);
    } catch { /* keep existing */ }

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

      // Right-click context menu
      tab.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        api.showTabContextMenu(entry.dialogId, entry.displayName, isPinned);
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

    // Detect if this is a group/forum (show sender names in messages)
    const dialog = cachedDialogs.find(d => String(d.id) === dialogId);
    const dialogType = (dialog as any)?.type;
    currentDialogIsGroup = dialogId.includes(':') || dialogType === 'group' || dialogType === 'supergroup' || dialogType === 'channel';

    // Clear pending state when switching tabs
    clearReplyTarget();
    clearAttachment();
    clearMentionCacheOnDialogChange();
    hideMentionDropdown();

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
      messagesScrollEl.innerHTML = '';
      messagesScrollEl.appendChild(loadingEl);
    }

    await loadMessages(dialogId);

    // Reset infinite scroll state for new dialog
    resetInfiniteScroll();

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
        messagesScrollEl.innerHTML = `<div class="loading">No messages yet</div>`;
        return;
      }

      messageCache[dialogId] = messages;
      renderMessages(messages);
    } catch (err) {
      console.error('[loadMessages] ERROR for', dialogId, err);
      loadingEl.style.display = 'none';
      messagesScrollEl.innerHTML = `<div class="loading">Failed to load messages</div>`;
    }
  }

  // ── Infinite scroll (load older messages) ──
  let isLoadingOlder = false;
  let noMoreMessages = false; // true when server returns 0 older messages

  function setupInfiniteScroll(): void {
    messagesEl.addEventListener('scroll', async () => {
      // Trigger when scrolled near the top (within 60px)
      if (messagesEl.scrollTop > 60) return;
      if (isLoadingOlder || noMoreMessages || !selectedDialogId) return;

      const cached = messageCache[selectedDialogId];
      if (!cached || cached.length === 0) return;

      // Find oldest message ID for offset
      const sorted = [...cached].sort((a, b) => (a.id || 0) - (b.id || 0));
      const oldestId = sorted[0]?.id;
      if (!oldestId) return;

      isLoadingOlder = true;

      // Show a small loading indicator at top
      const loader = document.createElement('div');
      loader.className = 'loading-older';
      loader.textContent = 'Loading…';
      messagesEl.prepend(loader);

      try {
        const older = await api.getMessages(selectedDialogId, 30, oldestId);
        loader.remove();

        if (!Array.isArray(older) || older.length === 0) {
          noMoreMessages = true;
          isLoadingOlder = false;
          return;
        }

        // Filter out duplicates
        const existingIds = new Set(cached.map(m => m.id));
        const newMsgs = older.filter(m => !existingIds.has(m.id));

        if (newMsgs.length === 0) {
          noMoreMessages = true;
          isLoadingOlder = false;
          return;
        }

        // Preserve scroll position: measure height before, add messages, restore
        const prevHeight = messagesEl.scrollHeight;
        const prevScroll = messagesEl.scrollTop;

        messageCache[selectedDialogId] = [...newMsgs, ...cached];
        renderMessages(messageCache[selectedDialogId]);

        // Restore scroll position so user stays where they were
        const newHeight = messagesEl.scrollHeight;
        messagesEl.scrollTop = prevScroll + (newHeight - prevHeight);
      } catch (err) {
        console.error('[infiniteScroll] Error loading older messages:', err);
        loader.remove();
      }

      isLoadingOlder = false;
    });
  }

  // Reset infinite scroll state when switching dialogs
  function resetInfiniteScroll(): void {
    isLoadingOlder = false;
    noMoreMessages = false;
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
  let suppressPollUntil = 0;
  async function pollForNewMessages(): Promise<void> {
    if (!selectedDialogId) return;
    if (Date.now() < suppressPollUntil) return;
    // After suppress period ends, resync lastSeenMsgId
    if (suppressPollUntil > 0) {
      suppressPollUntil = 0;
      try {
        const latest = await api.getMessages(selectedDialogId, 1);
        if (Array.isArray(latest) && latest.length > 0) {
          lastSeenMsgId = Math.max(lastSeenMsgId, latest[latest.length - 1].id || 0);
        }
      } catch { /* ignore */ }
      return;
    }
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
          // Check if already in DOM by ID
          const existing = messagesScrollEl.querySelector(`[data-msg-id="${msg.id}"]`);
          if (existing) continue;

          // Check for optimistic duplicate (id=0, same text, outgoing)
          const msgText = msg.text || msg.message || '';
          const isOutgoing = msg.isOutgoing === true || String(msg.fromId || msg.senderId || '') === String(myId);
          if (isOutgoing && msgText) {
            const optimistic = messagesScrollEl.querySelector('[data-msg-id="0"]');
            if (optimistic && optimistic.querySelector('.text')?.textContent?.trim() === msgText.trim()) {
              // Replace optimistic with real message (updates the ID)
              optimistic.setAttribute('data-msg-id', String(msg.id || 0));
              continue;
            }
          }

          appendMessage(msg);
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

  // Setup infinite scroll for loading older messages
  setupInfiniteScroll();

  // ── Reply bar ──

  function setReplyTarget(messageId: number, preview: string): void {
    replyTarget = { messageId, preview };
    replyBarText.textContent = `Replying to: ${preview}`;
    replyBar.style.display = '';
    // Highlight the target message
    messagesScrollEl.querySelectorAll('.message.reply-target').forEach((el) => el.classList.remove('reply-target'));
    const targetEl = messagesScrollEl.querySelector(`[data-msg-id="${messageId}"]`);
    if (targetEl) targetEl.classList.add('reply-target');
    composerInput.focus();
  }

  function clearReplyTarget(): void {
    replyTarget = null;
    replyBar.style.display = 'none';
    replyBarText.textContent = '';
    messagesScrollEl.querySelectorAll('.message.reply-target').forEach((el) => el.classList.remove('reply-target'));
  }

  replyBarCancel.addEventListener('click', clearReplyTarget);

  // ── Message rendering ──

  function renderMessages(messages: MessageLike[], preserveTyping = true): void {
    const wasTyping = preserveTyping && messagesScrollEl.contains(typingBubble);
    const sorted = [...messages].sort((a, b) => {
      const tA = a.date || a.timestamp || 0;
      const tB = b.date || b.timestamp || 0;
      return tA - tB;
    });

    let html = '';
    let lastDate = '';
    let prevSenderId = '';

    for (const msg of sorted) {
      const date = formatDate(msg.date || msg.timestamp);
      if (date !== lastDate) {
        html += `<div class="date-separator"><span>${date}</span></div>`;
        lastDate = date;
        prevSenderId = ''; // reset on date change
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

      // Show sender avatar + name in groups for incoming messages (collapse consecutive from same sender)
      let senderHtml = '';
      if (currentDialogIsGroup && !isOutgoing && fromId !== prevSenderId) {
        const name = (msg as any).senderName || '';
        if (name && fromId) {
          const hash = name.split('').reduce((a: number, c: string) => a + c.charCodeAt(0), 0);
          const colors = ['#e17076', '#7bc862', '#e5ca77', '#65aadd', '#a695e7', '#ee7aae', '#6ec9cb', '#faa774'];
          const color = colors[hash % colors.length];
          const initial = name.charAt(0).toUpperCase() || '?';
          senderHtml = `<div class="sender-block" data-user-id="${escapeHtml(String(fromId))}" data-display-name="${escapeHtml(name)}" title="Right-click for options">
            <div class="sender-avatar">${escapeHtml(initial)}</div>
            <div class="sender-name" style="color:${color}">${escapeHtml(name)}</div>
          </div>`;
        }
      }
      prevSenderId = fromId;

      const mediaType = (msg as MessageLike).mediaType ?? (msg as any).media?.type;
      const isImageMedia = mediaType === 'photo' || mediaType === 'gif' || mediaType === 'sticker';
      const w = (msg as MessageLike).mediaWidth ?? (msg as any).mediaWidth;
      const h = (msg as MessageLike).mediaHeight ?? (msg as any).mediaHeight;
      const hasCaption = (text || '').trim().length > 0;

      let mediaHtml = '';
      if (isImageMedia && msgId && selectedDialogId) {
        mediaHtml = `<div class="msg-media img" data-msg-id="${msgId}" data-dialog-id="${escapeHtml(selectedDialogId)}" title="Click to expand">
          <div class="msg-media-placeholder">📷</div>
        </div>`;
      }

      html += `
        <div class="message ${isOutgoing ? 'outgoing' : 'incoming'}" data-msg-id="${msgId}">
          ${replyHtml}
          ${senderHtml}
          ${mediaHtml}
          ${hasCaption || !isImageMedia ? `<div class="text">${text}</div>` : ''}
          <div class="time">${time}</div>
        </div>
      `;
    }

    messagesScrollEl.innerHTML = html;

    // Load images and bind fullscreen for media messages
    messagesScrollEl.querySelectorAll('.msg-media.img').forEach((el) => {
      const mediaEl = el as HTMLElement;
      const msgId = parseInt(mediaEl.dataset.msgId || '0', 10);
      const dialogId = mediaEl.dataset.dialogId;
      if (!msgId || !dialogId) return;
      const msg = sorted.find((m) => m.id === msgId);
      const w = msg ? ((msg as MessageLike).mediaWidth ?? (msg as any).mediaWidth) : undefined;
      const h = msg ? ((msg as MessageLike).mediaHeight ?? (msg as any).mediaHeight) : undefined;
      loadMessageImage(mediaEl, dialogId, msgId, w, h);
      mediaEl.addEventListener('click', async (e) => {
        e.stopPropagation();
        const src = mediaEl.dataset.loadedUrl ?? (mediaEl.querySelector('img') as HTMLImageElement)?.src;
        if (src) {
          openImageFullscreen(src);
        } else {
          const dataUrl = await api.getMedia(dialogId, msgId);
          if (dataUrl) openImageFullscreen(dataUrl);
        }
      });
    });

    // Bind sender context menu + load avatars
    messagesScrollEl.querySelectorAll('.sender-block').forEach((el) => {
      const block = el as HTMLElement;
      const userId = block.dataset.userId;
      const displayName = block.dataset.displayName || '';
      block.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (userId) api.showSenderContextMenu(userId, displayName);
      });
      const avatarEl = block.querySelector('.sender-avatar');
      if (avatarEl && userId) {
        const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000));
        Promise.race([api.getProfilePhoto(userId), timeout]).then((dataUrl: string | null) => {
          if (dataUrl && avatarEl.parentNode) {
            const img = document.createElement('img');
            img.src = dataUrl;
            img.alt = '';
            avatarEl.textContent = '';
            avatarEl.appendChild(img);
          }
        }).catch(() => { /* ignore */ });
      }
    });

    if (wasTyping) messagesScrollEl.appendChild(typingBubble);
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
    const loading = messagesScrollEl.querySelector('.loading');
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

    // Show sender avatar + name in groups/forums for incoming messages
    let senderHtml = '';
    if (currentDialogIsGroup && !isOutgoing) {
      const name = (msg as any).senderName || '';
      const fromIdStr = String(fromId);
      if (name && fromIdStr) {
        const hash = name.split('').reduce((a: number, c: string) => a + c.charCodeAt(0), 0);
        const colors = ['#e17076', '#7bc862', '#e5ca77', '#65aadd', '#a695e7', '#ee7aae', '#6ec9cb', '#faa774'];
        const color = colors[hash % colors.length];
        const initial = name.charAt(0).toUpperCase() || '?';
        senderHtml = `<div class="sender-block" data-user-id="${escapeHtml(fromIdStr)}" data-display-name="${escapeHtml(name)}" title="Right-click for options">
          <div class="sender-avatar">${escapeHtml(initial)}</div>
          <div class="sender-name" style="color:${color}">${escapeHtml(name)}</div>
        </div>`;
      }
    }

    const mediaType = msg.mediaType ?? (msg as any).media?.type;
    const isImageMedia = mediaType === 'photo' || mediaType === 'gif' || mediaType === 'sticker';
    const w = msg.mediaWidth ?? (msg as any).mediaWidth;
    const h = msg.mediaHeight ?? (msg as any).mediaHeight;
    const hasCaption = (text || '').trim().length > 0;

    let mediaHtml = '';
    if (isImageMedia && msgId && selectedDialogId) {
      mediaHtml = `<div class="msg-media img" data-msg-id="${msgId}" data-dialog-id="${escapeHtml(selectedDialogId)}" title="Click to expand">
        <div class="msg-media-placeholder">📷</div>
      </div>`;
    }

    div.innerHTML = `
      ${replyHtml}
      ${senderHtml}
      ${mediaHtml}
      ${hasCaption || !isImageMedia ? `<div class="text">${text}</div>` : ''}
      <div class="time">${time}</div>
    `;

    if (isImageMedia && msgId && selectedDialogId) {
      const mediaEl = div.querySelector('.msg-media.img') as HTMLElement;
      if (mediaEl) {
        loadMessageImage(mediaEl, selectedDialogId, msgId, w, h);
        mediaEl.addEventListener('click', async (e) => {
          e.stopPropagation();
          const src = mediaEl.dataset.loadedUrl ?? (mediaEl.querySelector('img') as HTMLImageElement)?.src;
          if (src) {
            openImageFullscreen(src);
          } else {
            if (!selectedDialogId) return;
            const dataUrl = await api.getMedia(selectedDialogId, msgId);
            if (dataUrl) openImageFullscreen(dataUrl);
          }
        });
      }
    }

    const senderBlock = div.querySelector('.sender-block') as HTMLElement | null;
    if (senderBlock) {
      const uid = senderBlock.dataset.userId;
      const dname = senderBlock.dataset.displayName || '';
      senderBlock.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (uid) api.showSenderContextMenu(uid, dname);
      });
      const avatarEl = senderBlock.querySelector('.sender-avatar');
      if (avatarEl && uid) {
        const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000));
        Promise.race([api.getProfilePhoto(uid), timeout]).then((dataUrl: string | null) => {
          if (dataUrl && avatarEl.parentNode) {
            const img = document.createElement('img');
            img.src = dataUrl;
            img.alt = '';
            avatarEl.textContent = '';
            avatarEl.appendChild(img);
          }
        }).catch(() => { /* ignore */ });
      }
    }

    div.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.msg-media, .sender-block')) return;
      if (msgId) {
        const preview = (msg.text || msg.message || '').substring(0, 50);
        setReplyTarget(msgId, preview);
      }
    });
    messagesScrollEl.appendChild(div);
    scrollToBottom();
  }

  function bindMessageClicks(): void {
    messagesScrollEl.querySelectorAll('.message[data-msg-id]').forEach((el) => {
      el.addEventListener('click', (e: Event) => {
        if ((e.target as HTMLElement).closest('.sender-block, .msg-media')) return;
        const msgId = parseInt((el as HTMLElement).dataset.msgId || '0', 10);
        if (!msgId) return;
        const textEl = el.querySelector('.text');
        const preview = (textEl?.textContent || '').substring(0, 50);
        setReplyTarget(msgId, preview);
      });
    });
    messagesScrollEl.querySelectorAll('.reply-context[data-reply-to]').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const replyTo = (el as HTMLElement).dataset.replyTo;
        if (!replyTo) return;
        const target = messagesScrollEl.querySelector(`.message[data-msg-id="${replyTo}"]`);
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
      messagesScrollEl.scrollTop = messagesScrollEl.scrollHeight;
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

    // Suppress poll duplicates: skip the next few poll cycles
    suppressPollUntil = Date.now() + 3000;

    sendBtn.disabled = false;
    composerInput.focus();
  }

  // ── Event handlers ──

  sendBtn.addEventListener('click', sendMessage);

  // ── @mention ──
  type MemberInfo = { userId: string; firstName: string; lastName: string; username: string; role: string };
  let mentionMembers: MemberInfo[] = [];
  let mentionHighlightIndex = 0;

  function getMentionContext(): { query: string; startOffset: number } | null {
    const text = composerInput.value;
    const cursor = composerInput.selectionStart;
    const before = text.slice(0, cursor);
    const atIdx = before.lastIndexOf('@');
    if (atIdx === -1) return null;
    const afterAt = before.slice(atIdx + 1);
    if (/\s/.test(afterAt)) return null; // space after @ = not mention
    return { query: afterAt, startOffset: atIdx };
  }

  function memberDisplayName(m: MemberInfo): string {
    const full = [m.firstName, m.lastName].filter(Boolean).join(' ');
    return full || m.username || m.userId;
  }

  function memberMentionText(m: MemberInfo): string {
    if (m.username) return `@${m.username}`;
    return memberDisplayName(m);
  }

  function filterMembers(members: MemberInfo[], q: string): MemberInfo[] {
    const low = q.toLowerCase();
    return members.filter((m) => {
      const name = memberDisplayName(m).toLowerCase();
      const uname = (m.username || '').toLowerCase();
      return name.includes(low) || uname.includes(low);
    });
  }

  function hideMentionDropdown(): void {
    mentionDropdown.style.display = 'none';
    mentionDropdown.innerHTML = '';
  }

  function renderMentionDropdown(filtered: MemberInfo[], highlightIdx: number): void {
    if (filtered.length === 0) {
      hideMentionDropdown();
      return;
    }
    mentionDropdown.style.display = '';
    mentionDropdown.innerHTML = filtered
      .map(
        (m, i) =>
          `<div class="mention-item ${i === highlightIdx ? 'highlighted' : ''}" data-index="${i}" data-user-id="${escapeHtml(m.userId)}">
            <div class="mention-item-avatar" data-user-id="${escapeHtml(m.userId)}">${escapeHtml((memberDisplayName(m) || '?').charAt(0).toUpperCase())}</div>
            <div class="mention-item-name">${escapeHtml(memberDisplayName(m))}</div>
            ${m.username ? `<span class="mention-item-username">@${escapeHtml(m.username)}</span>` : ''}
          </div>`,
      )
      .join('');

    mentionDropdown.querySelectorAll('.mention-item').forEach((el) => {
      el.addEventListener('click', () => {
        const idx = parseInt((el as HTMLElement).dataset.index || '0', 10);
        selectMention(filtered[idx]);
      });
    });
  }

  function selectMention(member: MemberInfo): void {
    const ctx = getMentionContext();
    if (!ctx) return;
    const text = composerInput.value;
    const before = text.slice(0, ctx.startOffset);
    const after = text.slice(composerInput.selectionStart);
    const insert = memberMentionText(member) + ' ';
    composerInput.value = before + insert + after;
    const newPos = before.length + insert.length;
    composerInput.setSelectionRange(newPos, newPos);
    hideMentionDropdown();
    composerInput.focus();
    composerInput.dispatchEvent(new Event('input'));
  }

  async function updateMentionDropdown(): Promise<void> {
    const ctx = getMentionContext();
    if (!ctx || !selectedDialogId) {
      hideMentionDropdown();
      return;
    }
    if (mentionMembers.length === 0) {
      const res = await api.getMembers(selectedDialogId, 200);
      if (!res?.members?.length) {
        hideMentionDropdown();
        return;
      }
      mentionMembers = res.members;
    }
    const filtered = filterMembers(mentionMembers, ctx.query);
    mentionHighlightIndex = Math.min(Math.max(0, mentionHighlightIndex), Math.max(0, filtered.length - 1));
    renderMentionDropdown(filtered, mentionHighlightIndex);
  }

  function clearMentionCacheOnDialogChange(): void {
    mentionMembers = [];
  }

  composerInput.addEventListener('keydown', async (e: KeyboardEvent) => {
    const ctx = getMentionContext();
    const isMentionOpen = mentionDropdown.style.display !== 'none' && mentionDropdown.children.length > 0;

    if (isMentionOpen) {
      const filtered = filterMembers(mentionMembers, ctx?.query ?? '');
      if (e.key === 'Enter') {
        e.preventDefault();
        if (filtered[mentionHighlightIndex]) {
          selectMention(filtered[mentionHighlightIndex]);
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        hideMentionDropdown();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        mentionHighlightIndex = Math.min(mentionHighlightIndex + 1, filtered.length - 1);
        renderMentionDropdown(filtered, mentionHighlightIndex);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        mentionHighlightIndex = Math.max(mentionHighlightIndex - 1, 0);
        renderMentionDropdown(filtered, mentionHighlightIndex);
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  composerInput.addEventListener('input', () => {
    composerInput.style.height = 'auto';
    composerInput.style.height = Math.min(composerInput.scrollHeight, 100) + 'px';
    mentionHighlightIndex = 0;
    updateMentionDropdown();
  });

  composerInput.addEventListener('blur', () => {
    setTimeout(() => {
      if (!mentionDropdown.contains(document.activeElement)) hideMentionDropdown();
    }, 150);
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
    if (!messagesScrollEl.contains(typingBubble)) {
      messagesScrollEl.appendChild(typingBubble);
      messagesScrollEl.scrollTop = messagesScrollEl.scrollHeight;
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

  // Whitelist changed from context menu (pin/unpin) — refresh everything
  api.onWhitelistChanged(async () => {
    try {
      const wl = await api.getWhitelist();
      const activeIds = new Set(activeChats.map((c) => c.dialogId));
      whitelistEntries = buildWhitelistEntries(wl, cachedDialogs, activeIds);
      mergeTabs();
      renderLayout();
    } catch { /* ignore */ }
  });

  // Blacklist changed (mute from right-click) — refresh tabs, clear selection if muted
  api.onBlacklistChanged(async () => {
    try {
      blacklistEntries = await api.getBlacklist();
      mergeTabs();
      if (selectedDialogId && !allTabs.some((t) => t.dialogId === selectedDialogId)) {
        const next = allTabs[0];
        if (next) selectTab(next.dialogId, next.displayName, false);
        else {
          selectedDialogId = null;
          renderLayout();
        }
      } else {
        renderLayout();
      }
    } catch { /* ignore */ }
  });

  // Open direct chat (from sender context menu "Direct chat")
  api.onOpenDirectChat(({ dialogId, displayName }) => {
    const existing = adHocTabs.find((t) => t.dialogId === dialogId);
    if (!existing) {
      adHocTabs.push({ dialogId, displayName, source: 'direct' });
      mergeTabs();
    }
    selectTab(dialogId, displayName, true);
    renderLayout();
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
