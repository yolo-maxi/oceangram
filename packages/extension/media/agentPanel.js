const vscode = acquireVsCodeApi();

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

window.addEventListener('message', event => {
  const msg = event.data;
  if (msg.command === 'memoryContent') {
    const preview = document.getElementById('memory-preview');
    document.getElementById('preview-path').textContent = msg.path.split('/').pop();
    document.getElementById('preview-content').textContent = msg.content;
    preview.classList.remove('hidden');
  }
  if (msg.command === 'cronOutput') {
    const el = document.getElementById('cron-output-' + msg.jobId);
    if (el) {
      el.textContent = msg.output;
      el.classList.toggle('hidden');
    }
  }
});
