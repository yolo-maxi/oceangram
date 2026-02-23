const vscode = acquireVsCodeApi();

function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function switchTab(tab) {
  vscode.postMessage({ command: 'switchTab', tab });
}

function toggleCron(jobId, enable) {
  vscode.postMessage({ command: 'toggleCron', jobId, enable });
}

function killSubAgent(sessionId) {
  if (confirm('Kill this sub-agent?')) {
    vscode.postMessage({ command: 'killSubAgent', sessionId });
  }
}

function viewSubAgentOutput(sessionId) {
  vscode.postMessage({ command: 'viewSubAgentOutput', sessionId });
}

function viewMemoryFile(path) {
  vscode.postMessage({ command: 'viewMemory', path });
}

function closePreview() {
  document.getElementById('memory-preview').classList.add('hidden');
}

function filterLiveTools(filter) {
  vscode.postMessage({ command: 'liveToolsFilter', filter });
}

function toggleExpand(id) {
  const el = document.getElementById(id);
  if (el) el.classList.toggle('hidden');
}

function switchModel(model) {
  vscode.postMessage({ command: 'switchModel', model });
}

function viewCronOutput(jobId) {
  vscode.postMessage({ command: 'viewCronOutput', jobId });
}

function sendChat() {
  const input = document.getElementById('chatInput');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  vscode.postMessage({ command: 'chatSend', text });
}

function loadChatHistory() {
  vscode.postMessage({ command: 'chatLoadHistory' });
}

function abortChat() {
  vscode.postMessage({ command: 'chatAbort' });
}

function selectChatSession(sessionKey) {
  vscode.postMessage({ command: 'chatSelectSession', sessionKey });
}

window.addEventListener('message', event => {
  const msg = event.data;
  if (msg.command === 'memoryContent') {
    const preview = document.getElementById('memory-preview');
    document.getElementById('preview-path').textContent = msg.path.split('/').pop();
    document.getElementById('preview-content').textContent = msg.content;
    preview.classList.remove('hidden');
  }
  if (msg.command === 'chatUpdate') {
    const container = document.getElementById('chatMessages');
    if (container) {
      const roleMap = { user: '👤 You', assistant: '🤖 Agent', system: '⚙️ System' };
      container.innerHTML = msg.messages.map(m => {
        const roleClass = m.role === 'user' ? 'chat-msg-user' : m.role === 'assistant' ? 'chat-msg-assistant' : 'chat-msg-system';
        return `<div class="chat-msg ${roleClass}"><div class="chat-msg-role">${roleMap[m.role] || m.role}</div><div class="chat-msg-content">${escapeHtml(m.content).replace(/\n/g, '<br>')}</div></div>`;
      }).join('') + (msg.loading ? '<div class="chat-loading">⏳ Agent is thinking...</div>' : '');
      container.scrollTop = container.scrollHeight;
    }
  }
  if (msg.command === 'cronOutput') {
    const el = document.getElementById('cron-output-' + msg.jobId);
    if (el) {
      el.textContent = msg.output;
      el.classList.toggle('hidden');
    }
  }
});
