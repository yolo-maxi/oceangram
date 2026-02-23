// popup.ts — Minimal whitelisted-contacts-only popup
/// <reference path="renderer.d.ts" />

(() => {
  const api = window.oceangram;

  // State
  let myId: string | null = null;
  let selectedDialogId: string | null = null;
  let whitelistEntries: WhitelistEntry[] = [];
  let unreadCounts: Record<string, number> = {};

  interface WhitelistEntry {
    userId: string;
    username: string;
    displayName: string;
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

  function escapeHtml(str: string): string {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
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
    whitelistEntries = await api.getWhitelist();

    if (whitelistEntries.length === 0) {
      // No whitelisted contacts — show empty state
      contactBar.style.display = 'none';
      messagesEl.style.display = 'none';
      composerEl.style.display = 'none';
      emptyState.style.display = '';
      return;
    }

    if (whitelistEntries.length === 1) {
      // Single contact — open directly, no tabs
      tabsEl.style.display = 'none';
      selectContact(whitelistEntries[0]);
    } else {
      // Multiple contacts — show tabs, hide the single contact bar
      contactBar.style.display = 'none';
      tabsEl.style.display = 'flex';
      renderTabs();
      selectContact(whitelistEntries[0]);
    }
  }

  // ── Tabs ──

  function renderTabs(): void {
    tabsEl.innerHTML = whitelistEntries.map((entry) => {
      const isActive = entry.userId === selectedDialogId;
      const hasUnread = (unreadCounts[entry.userId] || 0) > 0;
      return `
        <div class="tab${isActive ? ' active' : ''}${hasUnread ? ' has-unread' : ''}" data-user-id="${escapeHtml(entry.userId)}">
          ${escapeHtml(entry.displayName || entry.username || entry.userId)}
          <span class="tab-badge"></span>
        </div>
      `;
    }).join('');

    tabsEl.querySelectorAll('.tab').forEach((el) => {
      el.addEventListener('click', () => {
        const userId = (el as HTMLElement).dataset.userId;
        if (userId && userId !== selectedDialogId) {
          const entry = whitelistEntries.find((e) => e.userId === userId);
          if (entry) selectContact(entry);
        }
      });
    });
  }

  function updateTabActive(): void {
    tabsEl.querySelectorAll('.tab').forEach((el) => {
      const uid = (el as HTMLElement).dataset.userId;
      el.classList.toggle('active', uid === selectedDialogId);
      const hasUnread = uid ? (unreadCounts[uid] || 0) > 0 : false;
      el.classList.toggle('has-unread', hasUnread && uid !== selectedDialogId);
    });
  }

  // ── Select contact ──

  async function selectContact(entry: WhitelistEntry): Promise<void> {
    selectedDialogId = entry.userId;

    // Update contact bar (single mode)
    contactName.textContent = entry.displayName || entry.username || entry.userId;

    // Update tabs (multi mode)
    updateTabActive();

    // Show loading
    loadingEl.style.display = '';
    loadingEl.textContent = 'Loading messages...';
    messagesEl.innerHTML = '';
    messagesEl.appendChild(loadingEl);

    await loadMessages(entry.userId);

    // Mark as read
    api.markRead(entry.userId);
    unreadCounts[entry.userId] = 0;
    updateTabActive();

    // Focus composer
    setTimeout(() => composerInput.focus(), 100);
  }

  async function loadMessages(dialogId: string): Promise<void> {
    try {
      const messages = await api.getMessages(dialogId, 30);
      loadingEl.style.display = 'none';

      if (!Array.isArray(messages) || messages.length === 0) {
        messagesEl.innerHTML = `
          <div class="loading">No messages yet</div>
        `;
        return;
      }

      renderMessages(messages);
    } catch {
      loadingEl.style.display = 'none';
      messagesEl.innerHTML = `<div class="loading">Failed to load messages</div>`;
    }
  }

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

      html += `
        <div class="message ${isOutgoing ? 'outgoing' : 'incoming'}">
          <div class="text">${text}</div>
          <div class="time">${time}</div>
        </div>
      `;
    }

    messagesEl.innerHTML = html;
    scrollToBottom();
  }

  function appendMessage(msg: MessageLike): void {
    const fromId = String(msg.fromId || msg.senderId || '');
    const isOutgoing = msg.isOutgoing === true || fromId === myId;
    const text = formatText(msg.text || msg.message || '');
    const time = formatTime(msg.date || msg.timestamp);

    // Remove loading/empty states
    const loading = messagesEl.querySelector('.loading');
    if (loading) loading.remove();

    const div = document.createElement('div');
    div.className = `message ${isOutgoing ? 'outgoing' : 'incoming'}`;
    div.innerHTML = `
      <div class="text">${text}</div>
      <div class="time">${time}</div>
    `;
    messagesEl.appendChild(div);
    scrollToBottom();
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

    // Links
    html = html.replace(
      /(https?:\/\/[^\s<]+)/g,
      '<a href="$1" target="_blank" rel="noopener">$1</a>'
    );

    // Code blocks
    html = html.replace(/```([\s\S]+?)```/g, '<pre>$1</pre>');

    // Bold
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

    // Italic
    html = html.replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, '<em>$1</em>');

    // Inline code
    html = html.replace(/`([^`]+?)`/g, '<code>$1</code>');

    // Newlines
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
    if (!text || !selectedDialogId) return;

    composerInput.value = '';
    composerInput.style.height = 'auto';
    sendBtn.disabled = true;

    // Optimistic append
    appendMessage({
      fromId: myId || undefined,
      text,
      date: Math.floor(Date.now() / 1000),
      isOutgoing: true,
    });

    try {
      await api.sendMessage(selectedDialogId, text);
    } catch (err) {
      console.error('Send failed:', err);
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

  // ── Real-time updates ──

  api.onNewMessage((data) => {
    if (!data || !data.message) return;
    const msg = data.message;
    const msgDialogId = String(msg.dialogId || msg.chatId || data.dialogId || '');

    // Only care about whitelisted contacts
    const isWhitelisted = whitelistEntries.some((e) => e.userId === msgDialogId);
    if (!isWhitelisted) return;

    if (msgDialogId === selectedDialogId) {
      // Current chat — append message
      appendMessage(msg);
      api.markRead(selectedDialogId);
    } else {
      // Other whitelisted chat — update unread
      unreadCounts[msgDialogId] = (unreadCounts[msgDialogId] || 0) + 1;
      updateTabActive();
    }
  });

  api.onUnreadCountsUpdated((counts) => {
    unreadCounts = counts;
    updateTabActive();
  });

  api.onConnectionChanged((connected: boolean) => {
    connectionBanner.classList.toggle('visible', !connected);
  });

  // Select dialog from main process (e.g., notification click)
  api.onSelectDialog((dialogId) => {
    const entry = whitelistEntries.find((e) => e.userId === dialogId);
    if (entry) selectContact(entry);
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
