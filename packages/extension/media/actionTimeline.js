(function() {
  // VS Code API
  const vscode = acquireVsCodeApi();
  
  // DOM elements
  const sessionSelect = document.getElementById('sessionSelect');
  const toolFilter = document.getElementById('toolFilter');
  const sessionInfo = document.getElementById('sessionInfo');
  const timelineContainer = document.getElementById('timelineContainer');
  const modalOverlay = document.getElementById('modalOverlay');
  const modalTitle = document.getElementById('modalTitle');
  const modalBody = document.getElementById('modalBody');
  const modalClose = document.getElementById('modalClose');

  // State
  let currentSessions = [];
  let currentToolCalls = [];
  let currentToolNames = [];

  // Initialize
  sessionSelect.addEventListener('change', handleSessionChange);
  toolFilter.addEventListener('change', handleToolFilterChange);
  modalClose.addEventListener('click', hideModal);
  modalOverlay.addEventListener('click', handleModalBackdropClick);

  // Send init message when page loads
  vscode.postMessage({ type: 'init' });

  // Handle messages from the extension
  window.addEventListener('message', event => {
    const message = event.data;
    
    switch (message.type) {
      case 'sessions':
        handleSessionsUpdate(message.sessions);
        break;
      case 'toolCalls':
        handleToolCallsUpdate(message.toolCalls, message.toolNames, message.currentFilter, message.sessionInfo);
        break;
      case 'toolCallDetails':
        showToolCallModal(message.toolCall);
        break;
      case 'error':
        showError(message.message);
        break;
      case 'seekResults':
        // Handle seek/scrub results if needed
        break;
    }
  });

  function handleSessionChange() {
    const sessionId = sessionSelect.value;
    if (sessionId) {
      vscode.postMessage({ type: 'selectSession', sessionId: sessionId });
    }
  }

  function handleToolFilterChange() {
    const toolName = toolFilter.value;
    vscode.postMessage({ type: 'filterByTool', toolName: toolName });
  }

  function handleSessionsUpdate(sessions) {
    currentSessions = sessions;
    
    sessionSelect.innerHTML = '';
    
    if (sessions.length === 0) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'No sessions found';
      sessionSelect.appendChild(option);
      return;
    }

    // Add empty option
    const emptyOption = document.createElement('option');
    emptyOption.value = '';
    emptyOption.textContent = 'Select a session...';
    sessionSelect.appendChild(emptyOption);

    // Add session options
    sessions.forEach(session => {
      const option = document.createElement('option');
      option.value = session.id;
      option.textContent = `${session.label} (${formatFileSize(session.size)})`;
      sessionSelect.appendChild(option);
    });
  }

  function handleToolCallsUpdate(toolCalls, toolNames, currentFilter, sessionInfo) {
    currentToolCalls = toolCalls;
    currentToolNames = toolNames;
    
    updateToolFilter(toolNames, currentFilter);
    updateSessionInfo(sessionInfo);
    renderTimeline(toolCalls);
  }

  function updateToolFilter(toolNames, currentFilter) {
    toolFilter.innerHTML = '<option value="all">All tools</option>';
    
    toolNames.forEach(toolName => {
      const option = document.createElement('option');
      option.value = toolName;
      option.textContent = toolName;
      if (toolName === currentFilter) {
        option.selected = true;
      }
      toolFilter.appendChild(option);
    });
  }

  function updateSessionInfo(sessionInfo) {
    if (!sessionInfo) {
      sessionInfo.textContent = '';
      return;
    }

    sessionInfo.textContent = `${sessionInfo.totalCalls} tool calls in ${sessionInfo.label}`;
  }

  function renderTimeline(toolCalls) {
    if (toolCalls.length === 0) {
      timelineContainer.innerHTML = `
        <div class="empty-state">
          <h3>No tool calls found</h3>
          <p>This session has no tool calls, or none match the current filter.</p>
        </div>
      `;
      return;
    }

    const timeline = document.createElement('div');
    timeline.className = 'timeline';

    toolCalls.forEach(toolCall => {
      const entry = createTimelineEntry(toolCall);
      timeline.appendChild(entry);
    });

    timelineContainer.innerHTML = '';
    timelineContainer.appendChild(timeline);
  }

  function createTimelineEntry(toolCall) {
    const entry = document.createElement('div');
    entry.className = `timeline-entry ${toolCall.outputStatus}`;
    entry.setAttribute('data-id', toolCall.id);
    
    entry.innerHTML = `
      <div class="entry-header">
        <div class="entry-title">
          <span class="tool-name">${escapeHtml(toolCall.toolName)}</span>
        </div>
        <div class="entry-meta">
          <span class="timestamp">${formatTimestamp(toolCall.timestamp)}</span>
          ${toolCall.duration ? `<span class="duration">${formatDuration(toolCall.duration)}</span>` : ''}
        </div>
      </div>
      <div class="entry-content">
        <div class="input-summary">→ ${escapeHtml(toolCall.inputSummary)}</div>
        <div class="output-summary ${toolCall.outputStatus}">← ${escapeHtml(toolCall.outputSummary)}</div>
      </div>
      <div class="expand-hint">Click to expand details</div>
    `;

    entry.addEventListener('click', () => {
      vscode.postMessage({ type: 'expandToolCall', id: toolCall.id });
    });

    return entry;
  }

  function showToolCallModal(toolCall) {
    modalTitle.textContent = `${toolCall.toolName} - Tool Call Details`;
    
    const formattedInput = formatJson(toolCall.fullInput);
    const formattedOutput = formatJson(toolCall.fullOutput);
    
    modalBody.innerHTML = `
      <div class="detail-meta">
        <div class="meta-item">
          <span class="meta-label">Tool Name</span>
          <span class="meta-value">${escapeHtml(toolCall.toolName)}</span>
        </div>
        <div class="meta-item">
          <span class="meta-label">Status</span>
          <span class="meta-value status-${toolCall.outputStatus}">${toolCall.outputStatus}</span>
        </div>
        <div class="meta-item">
          <span class="meta-label">Timestamp</span>
          <span class="meta-value">${formatFullTimestamp(toolCall.timestamp)}</span>
        </div>
        ${toolCall.duration ? `
        <div class="meta-item">
          <span class="meta-label">Duration</span>
          <span class="meta-value">${formatDuration(toolCall.duration)}</span>
        </div>` : ''}
      </div>
      
      <div class="detail-section">
        <h4>Input Arguments</h4>
        <div class="detail-content">${formattedInput}</div>
      </div>
      
      <div class="detail-section">
        <h4>Output Result</h4>
        <div class="detail-content">${formattedOutput}</div>
      </div>
    `;
    
    modalOverlay.classList.add('show');
  }

  function hideModal() {
    modalOverlay.classList.remove('show');
  }

  function handleModalBackdropClick(event) {
    if (event.target === modalOverlay) {
      hideModal();
    }
  }

  function showError(message) {
    timelineContainer.innerHTML = `
      <div class="empty-state">
        <h3>Error</h3>
        <p>${escapeHtml(message)}</p>
      </div>
    `;
  }

  // Utility functions
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function formatTimestamp(timestamp) {
    const date = new Date(timestamp);
    return date.toLocaleTimeString();
  }

  function formatFullTimestamp(timestamp) {
    const date = new Date(timestamp);
    return date.toLocaleString();
  }

  function formatDuration(durationMs) {
    if (durationMs < 1000) {
      return `${durationMs}ms`;
    } else if (durationMs < 60000) {
      return `${(durationMs / 1000).toFixed(1)}s`;
    } else {
      const minutes = Math.floor(durationMs / 60000);
      const seconds = Math.floor((durationMs % 60000) / 1000);
      return `${minutes}m ${seconds}s`;
    }
  }

  function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  function formatJson(obj) {
    if (!obj) return '(no data)';
    
    try {
      return JSON.stringify(obj, null, 2);
    } catch {
      return String(obj);
    }
  }

  // Keyboard shortcuts
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      hideModal();
    }
  });

})();