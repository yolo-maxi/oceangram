// popup.ts — Minimal popup: whitelisted + active-conversation tabs
/// <reference path="renderer.d.ts" />

(() => {
  const api = window.oceangram;

  // State
  let myId: string | null = null;
  let selectedDialogId: string | null = null;
  let unreadCounts: Record<string, number> = {};
  let replyTarget: { messageId: number; preview: string } | null = null;

  // Tab sources
  let whitelistEntries: TabEntry[] = [];
  let activeChats: TabEntry[] = [];
  // Merged, deduplicated tab list
  let allTabs: TabEntry[] = [];

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

  function loadAvatar(entry: TabEntry): void {
    const initial = (entry.displayName || '?').charAt(0).toUpperCase();
    contactAvatar.innerHTML = `<span>${escapeHtml(initial)}</span>`;
    // Try loading photo with a 3-second timeout
    const userId = entry.dialogId;
    console.log('[avatar] Loading for', userId, 'displayName:', entry.displayName);
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000));
    Promise.race([api.getProfilePhoto(userId), timeout]).then((dataUrl: string | null) => {
      console.log('[avatar] Result for', userId, ':', dataUrl ? 'got image' : 'null/timeout');
      if (dataUrl && selectedDialogId === entry.dialogId) {
        contactAvatar.innerHTML = `<img src="${dataUrl}" alt="">`;
      }
    }).catch((err) => {
      console.log('[avatar] Error for', userId, ':', err);
      /* keep initial */
    });
  }

  function escapeHtml(str: string): string {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ── Tab merging ──

  function mergeTabs(): void {
    // Whitelist entries first, then active chats not already in whitelist
    const seen = new Set<string>();
    const merged: TabEntry[] = [];

    for (const entry of whitelistEntries) {
      seen.add(entry.dialogId);
      merged.push(entry);
    }

    for (const entry of activeChats) {
      if (!seen.has(entry.dialogId)) {
        seen.add(entry.dialogId);
        merged.push(entry);
      }
    }

    allTabs = merged;
  }

  // ── Init ──

  async function init(): Promise<void> {
    const me = await api.getMe();
    if (me && me.id) myId = String(me.id);

    // Load unread counts
    try {
      unreadCounts = await api.getUnreadCounts();
    } catch { /* ignore */ }

    // Get whitelist
    const wl = await api.getWhitelist();
    whitelistEntries = wl.map((e) => ({
      dialogId: e.userId,
      displayName: e.displayName || e.username || e.userId,
      source: 'whitelist' as const,
    }));

    // Get active chats
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
      if (selectedDialogId !== allTabs[0].dialogId) {
        selectTab(allTabs[0]);
      }
    } else {
      // Multiple tabs
      contactBar.style.display = 'none';
      tabsEl.style.display = 'flex';
      renderTabs();
      // Select first if nothing selected, or re-select current if still valid
      if (!selectedDialogId || !allTabs.some((t) => t.dialogId === selectedDialogId)) {
        selectTab(allTabs[0]);
      } else {
        updateTabActive();
      }
    }
  }

  // ── Tabs ──

  function renderTabs(): void {
    tabsEl.innerHTML = allTabs.map((entry) => {
      const isActive = entry.dialogId === selectedDialogId;
      const hasUnread = (unreadCounts[entry.dialogId] || 0) > 0;
      return `
        <div class="tab${isActive ? ' active' : ''}${hasUnread ? ' has-unread' : ''}" data-dialog-id="${escapeHtml(entry.dialogId)}" title="${escapeHtml(entry.displayName)}">
          <span class="tab-avatar" id="tab-avatar-${escapeHtml(entry.dialogId)}">${escapeHtml((entry.displayName || '?').charAt(0).toUpperCase())}</span>
          ${isActive ? `<span class="tab-name">${escapeHtml(entry.displayName)}</span>` : ''}
          <span class="tab-badge"></span>
        </div>
      `;
    }).join('');

    tabsEl.querySelectorAll('.tab').forEach((el) => {
      el.addEventListener('click', () => {
        const dialogId = (el as HTMLElement).dataset.dialogId;
        if (dialogId && dialogId !== selectedDialogId) {
          const entry = allTabs.find((t) => t.dialogId === dialogId);
          if (entry) selectTab(entry);
        }
      });
    });
  }

  function updateTabActive(): void {
    tabsEl.querySelectorAll('.tab').forEach((el) => {
      const did = (el as HTMLElement).dataset.dialogId;
      el.classList.toggle('active', did === selectedDialogId);
      const hasUnread = did ? (unreadCounts[did] || 0) > 0 : false;
      el.classList.toggle('has-unread', hasUnread && did !== selectedDialogId);
    });
  }

  // ── Select tab ──

  async function selectTab(entry: TabEntry): Promise<void> {
    selectedDialogId = entry.dialogId;

    // Clear pending state when switching tabs
    clearReplyTarget();
    clearAttachment();

    // Update contact bar (single mode)
    contactName.textContent = entry.displayName;
    loadAvatar(entry);

    // Update tabs (multi mode)
    if (allTabs.length > 1) {
      updateTabActive();
    }

    // Show loading only if no cache
    if (!messageCache[entry.dialogId] || messageCache[entry.dialogId].length === 0) {
      loadingEl.style.display = '';
      loadingEl.textContent = 'Loading messages...';
      messagesEl.innerHTML = '';
      messagesEl.appendChild(loadingEl);
    }

    await loadMessages(entry.dialogId);

    // Mark as read
    api.markRead(entry.dialogId);
    unreadCounts[entry.dialogId] = 0;
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
      // Refresh in background
      api.getMessages(dialogId, 30).then((messages: MessageLike[]) => {
        if (Array.isArray(messages) && messages.length > 0 && selectedDialogId === dialogId) {
          messageCache[dialogId] = messages;
          renderMessages(messages);
        }
      }).catch(() => { /* keep cache */ });
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
    } catch {
      loadingEl.style.display = 'none';
      messagesEl.innerHTML = `<div class="loading">Failed to load messages</div>`;
    }
  }

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

  function renderMessages(messages: MessageLike[]): void {
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
      // Try to find in cached messages
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
    // Click message → set reply target
    messagesEl.querySelectorAll('.message[data-msg-id]').forEach((el) => {
      el.addEventListener('click', () => {
        const msgId = parseInt((el as HTMLElement).dataset.msgId || '0', 10);
        if (!msgId) return;
        const textEl = el.querySelector('.text');
        const preview = (textEl?.textContent || '').substring(0, 50);
        setReplyTarget(msgId, preview);
      });
    });
    // Click reply context → scroll to original message
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

  // ── Formatting ──

  function formatText(text: string): string {
    if (!text) return '';
    let html = escapeHtml(text);
    html = html.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
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
      // Send file with optional caption
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
      // Text-only message
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
        // Strip data URL prefix to get raw base64
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
    if (!items) { console.log('[paste] no clipboardData items'); return false; }

    console.log('[paste] items:', Array.from(items).map(i => `${i.kind}:${i.type}`));
    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        e.stopPropagation();
        const file = item.getAsFile();
        console.log('[paste] got image file:', file?.name, file?.size, file?.type);
        if (file) attachFile(file);
        return true;
      }
    }
    return false;
  }

  // Listen on composer for paste
  composerInput.addEventListener('paste', (e: ClipboardEvent) => {
    handleImagePaste(e);
    // Non-image paste falls through to default text paste
  });

  // Window-level fallback — catches paste even when composer isn't focused
  document.addEventListener('paste', (e: ClipboardEvent) => {
    if (e.target === composerInput) return; // already handled above
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

    // Preview first file only
    if (files[0]) attachFile(files[0]);
  });

  // ── Real-time updates ──

  api.onNewMessage((data) => {
    if (!data || !data.message) return;
    const msg = data.message;
    const msgDialogId = String(msg.dialogId || msg.chatId || data.dialogId || '');

    // Only care about tabs we're showing
    const isTabbed = allTabs.some((t) => t.dialogId === msgDialogId);

    // Update cache for any tabbed dialog
    if (isTabbed && messageCache[msgDialogId]) {
      messageCache[msgDialogId] = [...messageCache[msgDialogId], msg];
    }

    if (msgDialogId === selectedDialogId) {
      // Current chat — append message
      appendMessage(msg);
      api.markRead(selectedDialogId);
    } else if (isTabbed) {
      // Other visible tab — update unread
      unreadCounts[msgDialogId] = (unreadCounts[msgDialogId] || 0) + 1;
      updateTabActive();
    }
    // Note: active-chats-changed event from main process will handle
    // adding new tabs for non-whitelisted active conversations
  });

  api.onUnreadCountsUpdated((counts) => {
    unreadCounts = counts;
    updateTabActive();
  });

  api.onActiveChatsChanged((chats) => {
    activeChats = chats.map((e) => ({
      dialogId: e.dialogId,
      displayName: e.displayName,
      source: 'active' as const,
    }));
    mergeTabs();
    renderLayout();
  });

  api.onConnectionChanged((connected: boolean) => {
    connectionBanner.classList.toggle('visible', !connected);
  });

  // Select dialog from main process (e.g., notification click)
  api.onSelectDialog((dialogId) => {
    const entry = allTabs.find((t) => t.dialogId === dialogId);
    if (entry) selectTab(entry);
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
