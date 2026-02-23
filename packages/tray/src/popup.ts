// popup.ts — Chat popup renderer logic
/// <reference path="renderer.d.ts" />

(() => {
  const api = window.oceangram;

  let userId: string | null = null;
  let dialogId: string | null = null;
  let myId: string | null = null;
  let displayName = '';

  // DOM refs
  const messagesEl = document.getElementById('messages')!;
  const loadingEl = document.getElementById('loadingState')!;
  const composerInput = document.getElementById('composerInput') as HTMLTextAreaElement;
  const sendBtn = document.getElementById('sendBtn') as HTMLButtonElement;
  const closeBtn = document.getElementById('closeBtn')!;
  const headerName = document.getElementById('headerName')!;
  const headerStatus = document.getElementById('headerStatus')!;
  const headerLetter = document.getElementById('headerLetter')!;
  const headerAvatarImg = document.getElementById('headerAvatarImg') as HTMLImageElement;
  const connectionBanner = document.getElementById('connectionBanner')!;

  const COLORS = ['#e53935','#d81b60','#8e24aa','#5e35b1','#3949ab','#1e88e5','#00897b','#43a047','#f4511e','#6d4c41'];

  function getColor(id: string): string {
    let hash = 0;
    const s = String(id);
    for (let i = 0; i < s.length; i++) hash = ((hash << 5) - hash) + s.charCodeAt(i);
    return COLORS[Math.abs(hash) % COLORS.length];
  }

  // ── Init ──

  api.onPopupInit(async (data) => {
    userId = data.userId;
    dialogId = data.dialogId;
    displayName = data.displayName || userId;

    headerName.textContent = displayName;
    headerLetter.textContent = (displayName[0] || '?').toUpperCase();
    document.getElementById('headerAvatar')!.style.background = getColor(userId);

    // Load avatar
    const avatar = await api.getProfilePhoto(userId);
    if (avatar) {
      headerAvatarImg.src = avatar;
      headerAvatarImg.style.display = 'block';
      headerLetter.style.display = 'none';
      headerAvatarImg.onerror = () => {
        headerAvatarImg.style.display = 'none';
        headerLetter.style.display = '';
      };
    }

    // Get my user ID
    const me = await api.getMe();
    if (me && me.id) myId = String(me.id);

    // Load messages
    await loadMessages();

    // Mark as read
    api.markRead(userId);
  });

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
    dialogId?: string;
    chatId?: string;
  }

  async function loadMessages(): Promise<void> {
    if (!dialogId) {
      loadingEl.textContent = 'No dialog found';
      return;
    }

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

  function renderMessages(messages: MessageLike[]): void {
    // Sort oldest first
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
      const isOutgoing = fromId === myId;
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
    const isOutgoing = fromId === myId;
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

  function escapeHtml(str: string): string {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function formatText(text: string): string {
    if (!text) return '';
    let html = escapeHtml(text);

    // Links
    html = html.replace(
      /(https?:\/\/[^\s<]+)/g,
      '<a href="$1" target="_blank" rel="noopener">$1</a>'
    );

    // Bold **text**
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

    // Italic *text* (but not **)
    html = html.replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, '<em>$1</em>');

    // Code `text`
    html = html.replace(/`([^`]+?)`/g, '<code>$1</code>');

    // Code blocks ```text```
    html = html.replace(/```([\s\S]+?)```/g, '<pre>$1</pre>');

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
    if (!text || !dialogId) return;

    composerInput.value = '';
    composerInput.style.height = 'auto';
    sendBtn.disabled = true;

    // Optimistic append
    appendMessage({
      fromId: myId || undefined,
      text,
      date: Math.floor(Date.now() / 1000),
    });

    try {
      await api.sendMessage(dialogId, text);
    } catch (err) {
      console.error('Send failed:', err);
    }

    sendBtn.disabled = false;
    composerInput.focus();
  }

  sendBtn.addEventListener('click', sendMessage);

  composerInput.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Auto-resize textarea
  composerInput.addEventListener('input', () => {
    composerInput.style.height = 'auto';
    composerInput.style.height = Math.min(composerInput.scrollHeight, 120) + 'px';
  });

  // ── Close ──

  closeBtn.addEventListener('click', () => {
    api.closePopup();
  });

  // ── Real-time updates ──

  api.onNewMessage((data) => {
    if (!data || !data.message) return;
    const msg = data.message;
    const msgDialogId = String(msg.dialogId || msg.chatId || '');

    // Only show messages for this dialog
    if (msgDialogId === dialogId || String(data.userId) === userId) {
      appendMessage(msg);
      api.markRead(userId!);
    }
  });

  api.onConnectionChanged((connected: boolean) => {
    headerStatus.textContent = connected ? 'online' : 'offline';
    headerStatus.className = 'header-status ' + (connected ? 'connected' : 'disconnected');
    connectionBanner.classList.toggle('visible', !connected);
  });

  // ── Keyboard shortcuts ──

  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      api.closePopup();
    }
  });

  // Focus input on load
  setTimeout(() => composerInput.focus(), 100);
})();
