// popup.ts — Chat client popup renderer logic
/// <reference path="renderer.d.ts" />

(() => {
  const api = window.oceangram;

  // State
  let myId: string | null = null;
  let selectedDialogId: string | null = null;
  let dialogsCache: DialogItem[] = [];
  let unreadCounts: Record<string, number> = {};
  let searchQuery = '';

  interface DialogItem {
    id: string | number;
    userId?: string | number;
    name?: string;
    title?: string;
    firstName?: string;
    username?: string;
    type?: string;
    unreadCount?: number;
    lastMessage?: MessageLike;
    photo?: string;
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
  const chatList = document.getElementById('chatList')!;
  const searchInput = document.getElementById('searchInput') as HTMLInputElement;
  const chatPanel = document.getElementById('chatPanel')!;
  const chatEmpty = document.getElementById('chatEmpty')!;
  const chatView = document.getElementById('chatView')!;
  const chatHeaderName = document.getElementById('chatHeaderName')!;
  const chatHeaderStatus = document.getElementById('chatHeaderStatus')!;
  const chatHeaderLetter = document.getElementById('chatHeaderLetter')!;
  const chatHeaderAvatar = document.getElementById('chatHeaderAvatar')!;
  const chatHeaderAvatarImg = document.getElementById('chatHeaderAvatarImg') as HTMLImageElement;
  const messagesEl = document.getElementById('messages')!;
  const loadingEl = document.getElementById('loadingState')!;
  const composerInput = document.getElementById('composerInput') as HTMLTextAreaElement;
  const sendBtn = document.getElementById('sendBtn') as HTMLButtonElement;
  const closeBtn = document.getElementById('closeBtn')!;
  const settingsBtn = document.getElementById('settingsBtn')!;
  const backBtn = document.getElementById('backBtn')!;
  const connectionBanner = document.getElementById('connectionBanner')!;

  const COLORS = ['#e53935','#d81b60','#8e24aa','#5e35b1','#3949ab','#1e88e5','#00897b','#43a047','#f4511e','#6d4c41'];

  function getColor(id: string | number): string {
    let hash = 0;
    const s = String(id);
    for (let i = 0; i < s.length; i++) hash = ((hash << 5) - hash) + s.charCodeAt(i);
    return COLORS[Math.abs(hash) % COLORS.length];
  }

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

    await loadDialogs();
  }

  // ── Dialog list ──

  async function loadDialogs(): Promise<void> {
    chatList.innerHTML = '<div class="chat-list-loading">Loading chats...</div>';

    try {
      const dialogs = await api.getDialogs(50);
      if (!Array.isArray(dialogs)) {
        chatList.innerHTML = '<div class="chat-list-loading">Failed to load chats</div>';
        return;
      }

      dialogsCache = dialogs as DialogItem[];
      renderDialogList();
    } catch {
      chatList.innerHTML = '<div class="chat-list-loading">Error loading chats</div>';
    }
  }

  function renderDialogList(): void {
    let filtered = dialogsCache;

    // Apply search filter
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      filtered = dialogsCache.filter((d) => {
        const name = getDialogName(d).toLowerCase();
        return name.includes(q);
      });
    }

    // Sort: unread first, then by last message timestamp
    filtered.sort((a, b) => {
      const aUnread = getUnreadCount(a);
      const bUnread = getUnreadCount(b);
      if (aUnread > 0 && bUnread === 0) return -1;
      if (aUnread === 0 && bUnread > 0) return 1;
      const aTime = getLastMessageTime(a);
      const bTime = getLastMessageTime(b);
      return bTime - aTime;
    });

    if (filtered.length === 0) {
      chatList.innerHTML = `<div class="chat-list-loading">${searchQuery ? 'No matching chats' : 'No chats found'}</div>`;
      return;
    }

    chatList.innerHTML = filtered.map((d) => {
      const id = String(d.id);
      const name = getDialogName(d);
      const preview = getLastMessagePreview(d);
      const time = formatChatTime(getLastMessageTime(d));
      const unread = getUnreadCount(d);
      const isActive = id === selectedDialogId;
      const hasUnread = unread > 0;
      const letter = (name[0] || '?').toUpperCase();
      const color = getColor(d.userId || d.id);

      return `
        <div class="chat-item${isActive ? ' active' : ''}${hasUnread ? ' has-unread' : ''}" data-dialog-id="${escapeHtml(id)}">
          <div class="chat-avatar" style="background: ${color}">
            <span>${escapeHtml(letter)}</span>
          </div>
          <div class="chat-info">
            <div class="chat-name">${escapeHtml(name)}</div>
            <div class="chat-preview">${escapeHtml(preview)}</div>
          </div>
          <div class="chat-meta">
            ${time ? `<div class="chat-time">${escapeHtml(time)}</div>` : ''}
            ${hasUnread ? `<div class="chat-badge">${unread > 99 ? '99+' : unread}</div>` : ''}
          </div>
        </div>
      `;
    }).join('');

    // Bind click handlers
    chatList.querySelectorAll('.chat-item').forEach((el) => {
      el.addEventListener('click', () => {
        const dialogId = (el as HTMLElement).dataset.dialogId;
        if (dialogId) selectDialog(dialogId);
      });
    });
  }

  function getDialogName(d: DialogItem): string {
    return d.title || d.name || d.firstName || d.username || String(d.id);
  }

  function getLastMessagePreview(d: DialogItem): string {
    if (!d.lastMessage) return '';
    const text = d.lastMessage.text || d.lastMessage.message || '';
    return text.substring(0, 50).replace(/\n/g, ' ');
  }

  function getLastMessageTime(d: DialogItem): number {
    if (!d.lastMessage) return 0;
    return d.lastMessage.date || d.lastMessage.timestamp || 0;
  }

  function getUnreadCount(d: DialogItem): number {
    const id = String(d.id);
    // Prefer tracker unread counts, fall back to dialog's own count
    if (unreadCounts[id] !== undefined) return unreadCounts[id];
    return d.unreadCount || 0;
  }

  function formatChatTime(ts: number): string {
    if (!ts) return '';
    const d = ts < 1e12 ? new Date(ts * 1000) : new Date(ts);
    const now = new Date();

    if (d.toDateString() === now.toDateString()) {
      return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    }

    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';

    const dayDiff = Math.floor((now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24));
    if (dayDiff < 7) {
      return d.toLocaleDateString('en-US', { weekday: 'short' });
    }

    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  // ── Select dialog ──

  async function selectDialog(dialogId: string): Promise<void> {
    selectedDialogId = dialogId;

    // Update active state in list
    chatList.querySelectorAll('.chat-item').forEach((el) => {
      el.classList.toggle('active', (el as HTMLElement).dataset.dialogId === dialogId);
    });

    // Show chat view
    chatEmpty.style.display = 'none';
    chatView.style.display = 'flex';
    document.querySelector('.app')!.classList.add('chat-open');

    // Find dialog info
    const dialog = dialogsCache.find((d) => String(d.id) === dialogId);
    const name = dialog ? getDialogName(dialog) : dialogId;
    const letter = (name[0] || '?').toUpperCase();
    const color = getColor(dialog?.userId || dialog?.id || dialogId);

    chatHeaderName.textContent = name;
    chatHeaderLetter.textContent = letter;
    chatHeaderAvatar.style.background = color;
    chatHeaderAvatarImg.style.display = 'none';
    chatHeaderLetter.style.display = '';

    // Load avatar
    const userId = dialog ? String(dialog.userId || dialog.id) : dialogId;
    api.getProfilePhoto(userId).then((avatar) => {
      if (avatar) {
        chatHeaderAvatarImg.src = avatar;
        chatHeaderAvatarImg.style.display = 'block';
        chatHeaderLetter.style.display = 'none';
        chatHeaderAvatarImg.onerror = () => {
          chatHeaderAvatarImg.style.display = 'none';
          chatHeaderLetter.style.display = '';
        };
      }
    });

    // Load messages
    loadingEl.style.display = '';
    loadingEl.textContent = 'Loading messages...';
    messagesEl.innerHTML = '';
    messagesEl.appendChild(loadingEl);

    await loadMessages(dialogId);

    // Mark as read
    api.markRead(dialogId);

    // Clear unread for this dialog
    unreadCounts[dialogId] = 0;
    renderDialogList();

    // Focus composer
    setTimeout(() => composerInput.focus(), 100);
  }

  async function loadMessages(dialogId: string): Promise<void> {
    const messages = await api.getMessages(dialogId, 30);
    loadingEl.style.display = 'none';

    if (!Array.isArray(messages) || messages.length === 0) {
      messagesEl.innerHTML = `
        <div class="empty-state">
          <div class="icon">💬</div>
          <div>No messages yet</div>
        </div>
      `;
      return;
    }

    renderMessages(messages);
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
      const senderName = msg.senderName || msg.firstName || '';
      const text = formatText(msg.text || msg.message || '');
      const time = formatTime(msg.date || msg.timestamp);

      html += `
        <div class="message ${isOutgoing ? 'outgoing' : 'incoming'}">
          ${(!isOutgoing && senderName) ? `<div class="sender">${escapeHtml(senderName)}</div>` : ''}
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
    const senderName = msg.senderName || msg.firstName || '';
    const text = formatText(msg.text || msg.message || '');
    const time = formatTime(msg.date || msg.timestamp);

    // Remove empty state if present
    const emptyState = messagesEl.querySelector('.empty-state');
    if (emptyState) emptyState.remove();

    const div = document.createElement('div');
    div.className = `message ${isOutgoing ? 'outgoing' : 'incoming'}`;
    div.innerHTML = `
      ${(!isOutgoing && senderName) ? `<div class="sender">${escapeHtml(senderName)}</div>` : ''}
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

    // Code blocks ```text```
    html = html.replace(/```([\s\S]+?)```/g, '<pre>$1</pre>');

    // Bold **text**
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

    // Italic *text* (but not **)
    html = html.replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, '<em>$1</em>');

    // Code `text`
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

  searchInput.addEventListener('input', () => {
    searchQuery = searchInput.value.trim();
    renderDialogList();
  });

  closeBtn.addEventListener('click', () => {
    api.closePopup();
  });

  settingsBtn.addEventListener('click', () => {
    api.openSettings();
  });

  backBtn.addEventListener('click', () => {
    // Go back to chat list (mobile/narrow mode)
    selectedDialogId = null;
    chatEmpty.style.display = '';
    chatView.style.display = 'none';
    document.querySelector('.app')!.classList.remove('chat-open');
    renderDialogList();
  });

  // ── Real-time updates ──

  api.onNewMessage((data) => {
    if (!data || !data.message) return;
    const msg = data.message;
    const msgDialogId = String(msg.dialogId || msg.chatId || data.dialogId || '');

    // If this message is for the currently selected dialog, append it
    if (msgDialogId === selectedDialogId) {
      appendMessage(msg);
      api.markRead(selectedDialogId);
    } else {
      // Update unread count for the other dialog
      if (msgDialogId) {
        unreadCounts[msgDialogId] = (unreadCounts[msgDialogId] || 0) + 1;
      }
    }

    // Update dialog list (move to top, update preview)
    const existing = dialogsCache.find((d) => String(d.id) === msgDialogId);
    if (existing) {
      existing.lastMessage = msg;
    }
    renderDialogList();
  });

  api.onUnreadCountsUpdated((counts) => {
    unreadCounts = counts;
    renderDialogList();
  });

  api.onConnectionChanged((connected: boolean) => {
    chatHeaderStatus.textContent = connected ? 'online' : 'offline';
    chatHeaderStatus.className = 'chat-header-status ' + (connected ? 'connected' : 'disconnected');
    connectionBanner.classList.toggle('visible', !connected);
  });

  // Select dialog from main process (e.g., notification click)
  api.onSelectDialog((dialogId) => {
    selectDialog(dialogId);
  });

  // ── Keyboard shortcuts ──

  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (selectedDialogId) {
        // Go back to chat list if narrow, otherwise close
        if (window.innerWidth <= 350) {
          backBtn.click();
        } else {
          api.closePopup();
        }
      } else {
        api.closePopup();
      }
    }
  });

  // ── Start ──
  init();
})();
