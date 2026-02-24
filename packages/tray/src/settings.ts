// settings.ts — Settings renderer logic
/// <reference path="renderer.d.ts" />

(() => {
  const api = window.oceangram;

  const COLORS = ['#e53935', '#d81b60', '#8e24aa', '#5e35b1', '#3949ab', '#1e88e5', '#00897b', '#43a047', '#f4511e', '#6d4c41'];

  function getColor(id: string): string {
    let hash = 0;
    const s = String(id);
    for (let i = 0; i < s.length; i++) hash = ((hash << 5) - hash) + s.charCodeAt(i);
    return COLORS[Math.abs(hash) % COLORS.length];
  }

  // DOM
  const statusDot = document.getElementById('statusDot')!;
  const statusText = document.getElementById('statusText')!;
  const statusDetail = document.getElementById('statusDetail')!;
  const whitelistList = document.getElementById('whitelistList')!;
  const blacklistList = document.getElementById('blacklistList')!;
  const dialogSelect = document.getElementById('dialogSelect') as HTMLSelectElement;
  const addBtn = document.getElementById('addBtn') as HTMLButtonElement;
  const closeBtn = document.getElementById('closeBtn')!;
  const alwaysOnTopToggle = document.getElementById('alwaysOnTop') as HTMLInputElement;
  const themeSelect = document.getElementById('themeSelect') as HTMLSelectElement;

  // ── Theme ──

  function applySettingsTheme(theme: string): void {
    let resolved = theme;
    if (theme === 'system') {
      resolved = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'night' : 'day';
    }
    document.documentElement.setAttribute('data-theme', resolved);
  }

  // ── Load state ──

  async function init(): Promise<void> {
    await loadStatus();
    await loadWhitelist();
    await loadBlacklist();
    await loadDialogs();
    await loadSettings();
  }

  async function loadStatus(): Promise<void> {
    const status = await api.getDaemonStatus();
    if (status) {
      statusDot.classList.add('connected');
      statusText.textContent = 'Connected';
      statusDetail.textContent = 'oceangram-daemon at localhost:7777';
    } else {
      statusDot.classList.remove('connected');
      statusText.textContent = 'Disconnected';
      statusDetail.textContent = 'Cannot reach daemon at localhost:7777';
    }
  }

  async function loadWhitelist(): Promise<void> {
    const list = await api.getWhitelist();
    if (!list || list.length === 0) {
      whitelistList.innerHTML = '<div class="whitelist-empty">No pinned chats yet</div>';
      return;
    }

    whitelistList.innerHTML = list.map((user) => `
      <div class="whitelist-item" data-user-id="${user.userId}">
        <div class="whitelist-avatar" style="background: ${getColor(user.userId)}">
          ${(user.displayName || '?')[0].toUpperCase()}
        </div>
        <div class="whitelist-info">
          <div class="whitelist-name">${escapeHtml(user.displayName || user.username || user.userId)}</div>
          <div class="whitelist-username">${user.username ? '@' + escapeHtml(user.username) : ''}</div>
        </div>
        <button class="whitelist-remove" data-user-id="${user.userId}" title="Remove">✕</button>
      </div>
    `).join('');

    // Bind remove buttons
    whitelistList.querySelectorAll('.whitelist-remove').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const uid = (btn as HTMLElement).dataset.userId;
        if (uid) {
          await api.removeUser(uid);
          await loadWhitelist();
          await loadDialogs();
        }
      });
    });
  }

  async function loadBlacklist(): Promise<void> {
    const list = await api.getBlacklist();
    if (!list || list.length === 0) {
      blacklistList.innerHTML = '<div class="blacklist-empty">No muted chats</div>';
      return;
    }

    blacklistList.innerHTML = list.map((b) => `
      <div class="blacklist-item" data-dialog-id="${escapeHtml(b.dialogId)}">
        <div class="blacklist-avatar" style="background: ${getColor(b.dialogId)}">
          ${(b.displayName || '?')[0].toUpperCase()}
        </div>
        <div class="blacklist-info">
          <div class="blacklist-name">${escapeHtml(b.displayName || b.dialogId)}</div>
        </div>
        <button class="blacklist-unmute" data-dialog-id="${escapeHtml(b.dialogId)}">Unmute</button>
      </div>
    `).join('');

    blacklistList.querySelectorAll('.blacklist-unmute').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const dialogId = (btn as HTMLElement).dataset.dialogId;
        if (!dialogId) return;
        try {
          await api.unmuteChat(dialogId);
          await loadBlacklist();
        } catch (e) {
          console.error('Unmute error:', e);
        }
      });
    });
  }

  async function loadDialogs(): Promise<void> {
    // Fetch more dialogs so we can filter to "where I last posted" and still have 100
    const dialogs = await api.getDialogs(500);
    const whitelistData = await api.getWhitelist();
    const whitelistedIds = new Set((whitelistData || []).map((u) => String(u.userId)));

    dialogSelect.innerHTML = '<option value="">— Select a chat to pin —</option>';
    if (!Array.isArray(dialogs)) return;

    // Only dialogs where I was the last to send (lastMessageOutgoing), then by recency, cap 100
    const whereIPosted = dialogs
      .filter((d) => (d as { lastMessageOutgoing?: boolean }).lastMessageOutgoing === true)
      .sort((a, b) => (b.lastMessageTime ?? 0) - (a.lastMessageTime ?? 0))
      .slice(0, 100);

    // Filter out already-whitelisted
    const available = whereIPosted.filter((d) => {
      const uid = String(d.userId || d.id);
      return uid && !whitelistedIds.has(uid);
    });

    for (const d of available) {
      const opt = document.createElement('option');
      opt.value = JSON.stringify({
        userId: String(d.userId || d.id),
        username: d.username || '',
        displayName: d.title || d.name || d.firstName || d.username || String(d.id),
      });
      const label = d.title || d.name || d.firstName || d.username || d.id;
      opt.textContent = String(label) + (d.username ? ` (@${d.username})` : '');
      dialogSelect.appendChild(opt);
    }
  }

  async function loadSettings(): Promise<void> {
    const settings = await api.getSettings();
    if (!settings) return;

    alwaysOnTopToggle.checked = settings.alwaysOnTop !== false;
    const theme = settings.theme || 'arctic';
    themeSelect.value = theme;
    applySettingsTheme(theme);
  }

  // ── Events ──

  dialogSelect.addEventListener('change', () => {
    addBtn.disabled = !dialogSelect.value;
  });

  addBtn.addEventListener('click', async () => {
    if (!dialogSelect.value) return;
    try {
      const user = JSON.parse(dialogSelect.value);
      await api.addUser(user);
      await loadWhitelist();
      await loadDialogs();
    } catch (e) {
      console.error('Add user error:', e);
    }
  });

  alwaysOnTopToggle.addEventListener('change', () => {
    api.updateSettings({ alwaysOnTop: alwaysOnTopToggle.checked });
  });

  themeSelect.addEventListener('change', () => {
    const newTheme = themeSelect.value as 'system' | 'day' | 'night' | 'tinted' | 'arctic';
    api.updateSettings({ theme: newTheme });
    applySettingsTheme(newTheme);
    // Notify popup window of theme change
    api.notifyThemeChanged(newTheme);
  });

  closeBtn.addEventListener('click', () => {
    api.closePopup();
  });

  api.onBlacklistChanged(() => {
    loadBlacklist();
  });

  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape') api.closePopup();
  });

  function escapeHtml(str: string): string {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ── Init ──
  init();
})();
