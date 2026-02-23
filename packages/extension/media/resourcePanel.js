const vscode = acquireVsCodeApi();

function postMsg(type, value) {
  if (type === 'openUrl') vscode.postMessage({type, url: value});
  else if (type === 'openFile') vscode.postMessage({type, path: value});
  else if (type === 'copyKey') vscode.postMessage({type, value});
}

function revealKey(idx) {
  const el = document.getElementById('key-' + idx);
  if (!el) return;
  el.textContent = el.dataset.raw;
  el.classList.add('revealed');
  setTimeout(() => {
    el.textContent = el.dataset.masked;
    el.classList.remove('revealed');
  }, 5000);
}

function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function pm2Do(type, name) {
  vscode.postMessage({type, name});
}

let pendingConfirm = null;

function pm2Confirm(type, name) {
  document.getElementById('confirm-msg').textContent = 'Are you sure you want to ' + type.replace('pm2','').toLowerCase() + ' "' + name + '"?';
  document.getElementById('confirm-dialog').style.display = 'flex';
  pendingConfirm = {type, name};
  document.getElementById('confirm-yes').onclick = function() {
    if (pendingConfirm) pm2Do(pendingConfirm.type, pendingConfirm.name);
    hideConfirm();
  };
}

function hideConfirm() {
  document.getElementById('confirm-dialog').style.display = 'none';
  pendingConfirm = null;
}

function saveBrief() {
  var ta = document.getElementById('briefTextarea');
  if (ta) vscode.postMessage({type:'saveBrief', content: ta.value});
}

window.addEventListener('message', function(event) {
  const msg = event.data;
  if (msg.type === 'healthUpdate') {
    document.querySelectorAll('.health-dot').forEach(dot => {
      if (dot.dataset.url === msg.url) {
        dot.textContent = msg.status === true ? '🟢' : msg.status === false ? '🔴' : '⚪';
      }
    });
  }
  if (msg.type === 'pm2LogsResult') {
    const procs = document.querySelectorAll('.pm2-card');
    procs.forEach(function(card) {
      const nameEl = card.querySelector('.pm2-name');
      if (nameEl && nameEl.textContent === msg.name) {
        const logArea = card.querySelector('.pm2-log-area');
        logArea.innerHTML = '<pre>' + escapeHtml(msg.logs) + '</pre>';
        logArea.style.display = logArea.style.display === 'none' ? 'block' : 'none';
      }
    });
  }
  if (msg.type === 'pm2Update') {
    // Could refresh PM2 cards dynamically in the future
  }
});

var autoSaveTimer = null;
document.addEventListener('focusout', function(e) {
  if (e.target && e.target.id === 'briefTextarea') {
    if (autoSaveTimer) clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(function() {
      var ta = document.getElementById('briefTextarea');
      if (ta) vscode.postMessage({type:'autoSaveBrief', content: ta.value});
    }, 2000);
  }
});
document.addEventListener('focusin', function(e) {
  if (e.target && e.target.id === 'briefTextarea' && autoSaveTimer) {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = null;
  }
});
