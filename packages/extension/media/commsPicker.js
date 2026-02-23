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
