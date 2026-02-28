const vscode = acquireVsCodeApi();


const messagesList = document.getElementById('messagesList');
const msgInput = document.getElementById('msgInput');
const sendBtn = document.getElementById('sendBtn');
const errorBox = document.getElementById('errorBox');

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}

const avatarColors = ['#e17076','#eda86c','#a695e7','#7bc862','#6ec9cb','#65aadd','#ee7aae','#6bb2f2'];

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatFileSize(bytes) {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
}

function getFileIcon(name, mime) {
  var ext = (name || '').split('.').pop().toLowerCase();
  if (mime === 'application/pdf' || ext === 'pdf') return '📄';
  if (/^image\//.test(mime)) return '🖼️';
  if (/^audio\//.test(mime)) return '🎵';
  if (/^video\//.test(mime)) return '🎬';
  if (/zip|rar|7z|tar|gz|bz2/.test(ext)) return '📦';
  if (/js|ts|py|rb|go|rs|c|cpp|h|java|kt|swift|sh|json|xml|yaml|yml|toml|css|html|sql/.test(ext)) return '💻';
  if (/txt|md|rst|log|csv/.test(ext)) return '📝';
  if (/doc|docx|odt|rtf/.test(ext)) return '📃';
  if (/xls|xlsx|ods/.test(ext)) return '📊';
  if (/ppt|pptx|odp/.test(ext)) return '📊';
  return '📎';
}

function getFileIconClass(name, mime) {
  var ext = (name || '').split('.').pop().toLowerCase();
  if (mime === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (/^image\//.test(mime)) return 'img';
  if (/^audio\//.test(mime)) return 'audio';
  if (/zip|rar|7z|tar|gz|bz2/.test(ext)) return 'archive';
  if (/js|ts|py|rb|go|rs|c|cpp|h|java|kt|swift|sh|json|xml|yaml|yml|toml|css|html|sql/.test(ext)) return 'code';
  return '';
}

function downloadFile(msgId) {
  vscode.postMessage({ type: 'downloadFile', messageId: msgId });
}

function formatDate(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const msgDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diff = (today - msgDay) / 86400000;
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function linkify(text) {
  return text.replace(/(https?:\\/\\/[^\\s<]+)/g, '<a href="$1" title="$1">$1</a>');
}

function isDiffBlock(language, text) {
  if (language && language.toLowerCase() === 'diff') return true;
  var lines = text.split('\\n');
  var diffLines = 0;
  for (var i = 0; i < Math.min(lines.length, 20); i++) {
    var l = lines[i];
    if (/^[+-]{1}[^+-]/.test(l) || /^@@/.test(l)) diffLines++;
  }
  return lines.length > 2 && diffLines >= 2;
}

function applyDiffLineClasses(html) {
  // Wrap each line in a span with diff class based on first visible char
  return html.split('\\n').map(function(line) {
    // Strip HTML to get the raw text for classification
    var raw = line.replace(/<[^>]*>/g, '');
    var cls = '';
    if (/^\\+/.test(raw)) cls = 'diff-line-add';
    else if (/^-/.test(raw)) cls = 'diff-line-del';
    else if (/^@@/.test(raw)) cls = 'diff-line-hunk';
    return cls ? '<span class="' + cls + '">' + line + '</span>' : line;
  }).join('\\n');
}

function applyEntities(text, entities, msg) {
  if (!entities || entities.length === 0) return linkify(esc(text));
  var sorted = entities.slice().sort(function(a, b) { return b.offset - a.offset; });
  var chars = Array.from(text);
  var escaped = chars.map(function(c) { return esc(c); });
  for (var i = 0; i < sorted.length; i++) {
    var e = sorted[i];
    var slice = escaped.slice(e.offset, e.offset + e.length).join('');
    var replacement;
    switch (e.type) {
      case 'bold': replacement = '<strong>' + slice + '</strong>'; break;
      case 'italic': replacement = '<em>' + slice + '</em>'; break;
      case 'code': replacement = '<code>' + slice + '</code>'; break;
      case 'pre': {
        var hlKey = String(i);
        var headerBtns = '<span class="code-header-actions"><button class="line-nums-btn" onclick="toggleLineNumbers(this)" title="Toggle line numbers">#</button><button class="copy-code-btn" onclick="copyCodeBlock(this)" title="Copy code">📋</button></span>';
        var rawText = chars.slice(e.offset, e.offset + e.length).join('');
        var isDiff = isDiffBlock(e.language, rawText);
        if (msg && msg.highlightedCodeBlocks && msg.highlightedCodeBlocks[hlKey]) {
          var hlHtml = msg.highlightedCodeBlocks[hlKey];
          if (isDiff) hlHtml = applyDiffLineClasses(hlHtml);
          replacement = '<div class="code-block-wrapper">' +
            '<div class="code-block-header"><span class="code-lang">' + esc(e.language || (isDiff ? 'diff' : '')) + '</span>' + headerBtns + '</div>' +
            hlHtml +
            '</div>';
        } else {
          var codeHtml = slice;
          if (isDiff) codeHtml = applyDiffLineClasses(codeHtml);
          replacement = '<div class="code-block-wrapper">' +
            '<div class="code-block-header"><span class="code-lang">' + esc(e.language || (isDiff ? 'diff' : '')) + '</span>' + headerBtns + '</div>' +
            '<pre><code' + (e.language ? ' class="language-' + esc(e.language) + '"' : '') + '>' + codeHtml + '</code></pre>' +
            '</div>';
        }
        break;
      }
      case 'strikethrough': replacement = '<del>' + slice + '</del>'; break;
      case 'text_link': var safeUrl = (e.url || '').match(/^https?:\\/\\//) ? e.url : '#'; replacement = '<a href="' + esc(safeUrl || '#') + '">' + slice + '</a>'; break;
      case 'url': replacement = '<a href="' + slice + '">' + slice + '</a>'; break;
      default: replacement = slice;
    }
    escaped.splice(e.offset, e.length, replacement);
  }
  return escaped.join('');
}

function isEmojiOnly(text) {
  if (!text) return false;
  const stripped = text.replace(/[\\s]/g, '');
  const emojiRe = /^(?:[\\u{1F600}-\\u{1F64F}\\u{1F300}-\\u{1F5FF}\\u{1F680}-\\u{1F6FF}\\u{1F1E0}-\\u{1F1FF}\\u{2600}-\\u{26FF}\\u{2700}-\\u{27BF}\\u{FE00}-\\u{FE0F}\\u{1F900}-\\u{1F9FF}\\u{1FA00}-\\u{1FA6F}\\u{1FA70}-\\u{1FAFF}\\u{200D}\\u{20E3}\\u{E0020}-\\u{E007F}])+$/u;
  return stripped.length <= 10 && emojiRe.test(stripped);
}

// TASK-040: Approval-seeking pattern detection (inline in webview)
var _approvalVerbs = /\\b(deploy|send|delete|merge|restart|proceed|continue|execute|publish|push|remove|update|install|upgrade|migrate|rollback|revert|release|start|stop|kill|drop|overwrite|replace)\\b/i;
var _approvalPatterns = /\\b(should i|want me to|shall i|do you want me to|ready to|go ahead and)\\b/i;
function isApprovalSeeking(text) {
  if (!text) return false;
  var t = text.trim();
  if (!t.endsWith('?')) return false;
  return _approvalPatterns.test(t) || _approvalVerbs.test(t);
}

function handleApproval(btn, action, msgId) {
  var container = btn.parentElement;
  var buttons = container.querySelectorAll('.approval-btn');
  buttons.forEach(function(b) { b.disabled = true; });
  btn.classList.add('chosen');
  var responseText = action === 'approve' ? 'Approved ✓' : 'Rejected ✗';
  // Inject into input and trigger send
  msgInput.value = responseText;
  doSend();
}

// TASK-037: Tool execution viewer - parse tool calls from message text
var TOOL_ICONS = {
  'exec': '⚡', 'read': '📄', 'Read': '📄', 'write': '✏️', 'Write': '✏️',
  'edit': '🔧', 'Edit': '🔧', 'web_search': '🔍', 'web_fetch': '🌐',
  'browser': '🖥️', 'message': '💬', 'tts': '🔊', 'image': '🖼️',
  'canvas': '🎨', 'nodes': '📡', 'process': '⚙️'
};
function getToolIcon(name) { return TOOL_ICONS[name] || '🔨'; }
function truncateStr(s, max) {
  if (!s) return '';
  s = s.trim();
  return s.length <= max ? s : s.slice(0, max) + '…';
}

function parseToolCalls(text) {
  var calls = [];
  if (!text) return calls;
  
  // Check for invoke blocks (both formats)
  var hasInvoke = text.indexOf('<invoke') >= 0 || text.indexOf('<invoke') >= 0;
  if (!hasInvoke) return calls;
  
  // Use regex to find invoke blocks
  var pattern = /<(?:antml:)?invoke\\s+name="([^"]+)"[^>]*>([\\s\\S]*?)<\\/(?:antml:)?invoke>/gi;
  var match;
  var idx = 0;
  
  while ((match = pattern.exec(text)) !== null) {
    var toolName = match[1];
    var content = match[2];
    
    // Extract parameters
    var params = {};
    var paramPattern = /<(?:antml:)?parameter\\s+name="([^"]+)"[^>]*>([\\s\\S]*?)<\\/(?:antml:)?parameter>/gi;
    var pmatch;
    while ((pmatch = paramPattern.exec(content)) !== null) {
      params[pmatch[1]] = pmatch[2];
    }
    
    // Build param summary
    var paramSummary = '';
    if (params.command) paramSummary = truncateStr(params.command, 50);
    else if (params.file_path || params.path) paramSummary = truncateStr(params.file_path || params.path, 50);
    else if (params.query) paramSummary = truncateStr(params.query, 50);
    else if (params.url) paramSummary = truncateStr(params.url, 50);
    else if (params.action) paramSummary = params.action;
    else {
      var keys = Object.keys(params);
      if (keys.length > 0) paramSummary = truncateStr(keys.join(', '), 40);
    }
    
    // Look for result after this block
    var afterMatch = text.slice(match.index + match[0].length);
    var resultMatch = afterMatch.match(/<function_results>([\\s\\S]*?)<\\/function_results>/i);
    var result = resultMatch ? resultMatch[1].trim() : '';
    var isError = result.toLowerCase().indexOf('error') >= 0;
    
    calls.push({
      name: toolName,
      params: paramSummary,
      fullParams: JSON.stringify(params, null, 2),
      result: truncateStr(result, 80),
      fullResult: result,
      isError: isError,
      index: idx++
    });
  }
  
  return calls;
}

function renderToolTimeline(toolCalls) {
  if (!toolCalls || toolCalls.length === 0) return '';
  
  var html = '<div class="tool-timeline">';
  html += '<div class="tool-timeline-header" onclick="this.classList.toggle(\\'expanded\\')">';
  html += '<span class="chevron">›</span> ';
  html += toolCalls.length + ' tool call' + (toolCalls.length > 1 ? 's' : '');
  html += '</div>';
  html += '<div class="tool-timeline-items">';
  
  for (var i = 0; i < toolCalls.length; i++) {
    var tc = toolCalls[i];
    var icon = getToolIcon(tc.name);
    var statusCls = tc.isError ? 'err' : 'ok';
    var statusIcon = tc.isError ? '✗' : '✓';
    
    html += '<div class="tool-item" onclick="toggleToolDetail(this)">';
    html += '<span class="tool-icon">' + icon + '</span>';
    html += '<span class="tool-name">' + esc(tc.name) + '</span>';
    html += '<span class="tool-params">' + esc(tc.params) + '</span>';
    html += '<span class="tool-status ' + statusCls + '">' + statusIcon + '</span>';
    html += '</div>';
    html += '<div class="tool-item-detail" data-full-params="' + esc(tc.fullParams) + '">';
    if (tc.fullResult) {
      html += esc(tc.fullResult.slice(0, 500));
      if (tc.fullResult.length > 500) html += '\\n...truncated';
    } else {
      html += '(no output)';
    }
    html += '</div>';
  }
  
  html += '</div></div>';
  return html;
}

function toggleToolDetail(el) {
  var detail = el.nextElementSibling;
  if (detail && detail.classList.contains('tool-item-detail')) {
    detail.classList.toggle('visible');
  }
}

function renderMessages(msgs) {
  if (!msgs || msgs.length === 0) {
    messagesList.innerHTML =
      '<div class="empty-state">' +
        '<div class="icon">💬</div>' +
        '<div class="label">No messages yet</div>' +
      '</div>';
    return;
  }

  // Group consecutive messages from same sender
  const groups = [];
  for (const m of msgs) {
    const key = (m.isOutgoing ? '__out__' : (m.senderName || ''));
    const last = groups[groups.length - 1];
    if (last && last.key === key && m.timestamp - last.msgs[last.msgs.length - 1].timestamp < 300) {
      last.msgs.push(m);
    } else {
      groups.push({ key, isOutgoing: m.isOutgoing, senderName: m.senderName, senderId: m.senderId, msgs: [m] });
    }
  }

  let html = '';
  let lastDateStr = '';
  for (const g of groups) {
    // Date separator
    const firstTs = g.msgs[0].timestamp;
    const dateStr = formatDate(firstTs);
    if (dateStr && dateStr !== lastDateStr) {
      html += '<div class="date-separator"><span>' + dateStr + '</span></div>';
      lastDateStr = dateStr;
    }

    const dir = g.isOutgoing ? 'outgoing' : 'incoming';
    html += '<div class="msg-group ' + dir + '">';
    if (!g.isOutgoing) {
      // Avatar + messages wrapper for incoming
      var avatarContent = '';
      var sid = g.senderId || '';
      if (profilePhotos[sid]) {
        avatarContent = '<img src="' + profilePhotos[sid] + '" style="width:100%;height:100%;border-radius:50%;object-fit:cover" />';
      } else {
        var initials = (g.senderName || '?').charAt(0).toUpperCase();
        var avatarColor = avatarColors[Math.abs(parseInt(sid || '0', 10)) % avatarColors.length];
        avatarContent = '<span style="color:#fff;font-size:13px;font-weight:600">' + esc(initials) + '</span>';
        avatarContent = '<div style="width:100%;height:100%;border-radius:50%;background:' + avatarColor + ';display:flex;align-items:center;justify-content:center">' + avatarContent + '</div>';
      }
      html += '<div class="msg-group-row">';
      html += '<div class="msg-avatar" data-sender-id="' + esc(sid) + '" onclick="showUserProfile(this, \\'' + esc(sid) + '\\')">' + avatarContent + '</div>';
      html += '<div class="msg-group-content">';
      if (g.senderName) {
        html += '<div class="group-sender" data-sender-id="' + esc(sid) + '" onclick="showUserProfile(this, \\'' + esc(sid) + '\\')">' + esc(g.senderName) + '</div>';
      }
    }
    const len = g.msgs.length;
    for (let i = 0; i < len; i++) {
      const m = g.msgs[i];
      let pos = 'solo';
      if (len > 1) { pos = i === 0 ? 'first' : i === len - 1 ? 'last' : 'middle'; }
      const isLast = i === len - 1;
      const emoji = isEmojiOnly(m.text);
      const bubbleCls = 'msg-bubble' + (emoji ? ' emoji-only' : '');
      const textContent = emoji ? esc(m.text) : applyEntities(m.text, m.entities, m);

      var bubbleInner = '';

      // Forward header
      if (m.forwardFrom) {
        bubbleInner += '<div class="forward-header">Forwarded from <strong>' + esc(m.forwardFrom) + '</strong></div>';
      }

      // Reply quote (skip empty replies — e.g. forum topic root)
      if (m.replyToId && (m.replyToSender || m.replyToText)) {
        bubbleInner += '<div class="reply-quote">';
        if (m.replyToSender) bubbleInner += '<div class="reply-sender">' + esc(m.replyToSender) + '</div>';
        bubbleInner += '<div class="reply-text">' + esc(m.replyToText || '') + '</div>';
        bubbleInner += '</div>';
      }

      // Media
      if (m.mediaType === 'photo' && m.mediaUrl) {
        bubbleInner += '<img class="msg-photo" src="' + esc(m.mediaUrl) + '" onclick="showLightbox(this.src)" />';
      } else if (m.mediaType === 'file') {
        var fName = m.fileName || 'File';
        var fSize = m.fileSize ? formatFileSize(m.fileSize) : '';
        var fMime = m.fileMimeType || '';
        var fIcon = getFileIcon(fName, fMime);
        var fIconClass = getFileIconClass(fName, fMime);
        bubbleInner += '<div class="msg-file" onclick="downloadFile(' + m.id + ')" data-msg-file-id="' + m.id + '">' +
          '<div class="msg-file-icon ' + fIconClass + '">' + fIcon + '</div>' +
          '<div class="msg-file-info">' +
            '<div class="msg-file-name">' + esc(fName) + '</div>' +
            '<div class="msg-file-meta">' + esc(fSize) + (fSize && fMime ? ' · ' : '') + esc(fMime.split('/').pop() || '') + '</div>' +
            '<div class="msg-file-progress" id="file-progress-' + m.id + '"><div class="msg-file-progress-bar"></div></div>' +
          '</div></div>';
      } else if (m.mediaType === 'voice') {
        var voiceDur = m.duration || 0;
        var voiceDurStr = Math.floor(voiceDur / 60) + ':' + ('0' + (voiceDur % 60)).slice(-2);
        var waveformBars = '';
        var waveData = m.waveform && m.waveform.length > 0 ? m.waveform : null;
        var barCount = 40;
        if (waveData) {
          // Resample waveform to barCount bars
          for (var bi = 0; bi < barCount; bi++) {
            var si = Math.floor(bi * waveData.length / barCount);
            var h = Math.max(3, Math.round((waveData[si] / 31) * 28));
            waveformBars += '<div class="vw-bar" style="height:' + h + 'px" data-idx="' + bi + '"></div>';
          }
        } else {
          for (var bi = 0; bi < barCount; bi++) {
            var h = Math.max(3, Math.round(Math.random() * 20 + 4));
            waveformBars += '<div class="vw-bar" style="height:' + h + 'px" data-idx="' + bi + '"></div>';
          }
        }
        var audioSrc = m.mediaUrl ? ' data-src="' + esc(m.mediaUrl) + '"' : '';
        bubbleInner += '<div class="voice-player" data-duration="' + voiceDur + '"' + audioSrc + '>'
          + '<button class="voice-play-btn" onclick="toggleVoice(this)">▶</button>'
          + '<div class="voice-waveform-wrap">'
          + '<div class="voice-waveform" onclick="scrubVoice(event, this)">' + waveformBars + '</div>'
          + '<div class="voice-meta"><span class="voice-time">' + voiceDurStr + '</span>'
          + '<button class="voice-speed-btn" onclick="cycleVoiceSpeed(this)">1×</button></div>'
          + '</div></div>';
      } else if (m.mediaType === 'video') {
        var vidNoteClass = m.isVideoNote ? ' video-note' : '';
        var durationStr = '';
        if (m.duration) {
          var mins = Math.floor(m.duration / 60);
          var secs = m.duration % 60;
          durationStr = mins + ':' + (secs < 10 ? '0' : '') + secs;
        }
        var sizeStr = '';
        if (m.fileSize) {
          if (m.fileSize > 1048576) sizeStr = (m.fileSize / 1048576).toFixed(1) + ' MB';
          else sizeStr = Math.round(m.fileSize / 1024) + ' KB';
        }
        bubbleInner += '<div class="msg-video-container' + vidNoteClass + '" data-msg-id="' + m.id + '" onclick="playVideo(this)">';
        if (m.thumbnailUrl) {
          bubbleInner += '<img class="msg-video-thumb" src="' + esc(m.thumbnailUrl) + '" />';
        } else {
          bubbleInner += '<div class="msg-video-no-thumb">🎬 Video</div>';
        }
        bubbleInner += '<div class="msg-video-play"></div>';
        if (durationStr || sizeStr) {
          bubbleInner += '<div class="msg-video-meta">';
          if (durationStr) bubbleInner += '<span>' + durationStr + '</span>';
          if (sizeStr) bubbleInner += '<span>' + sizeStr + '</span>';
          bubbleInner += '</div>';
        }
        bubbleInner += '</div>';
      } else if (m.mediaType === 'sticker') {
        if (m.mediaUrl) {
          bubbleInner += '<div class="msg-sticker" onclick="showLightbox(this.querySelector(&quot;img&quot;).src)"><img src="' + esc(m.mediaUrl) + '" /></div>';
        } else {
          bubbleInner += '<div class="msg-sticker-placeholder">🏷️ Sticker</div>';
        }
      } else if (m.mediaType === 'gif') {
        if (m.mediaUrl) {
          bubbleInner += '<div class="msg-gif-container" onclick="var v=this.querySelector(&quot;video&quot;);v.paused?v.play():v.pause()"><video autoplay loop muted playsinline src="' + esc(m.mediaUrl) + '"></video></div>';
        } else {
          bubbleInner += '<div class="msg-gif-placeholder">🎞️ GIF</div>';
        }
      }

      // Text
      if (m.text) {
        bubbleInner += textContent;
      }

      // Edited indicator — time is now inline inside bubble
      var timeStr = formatTime(m.timestamp);
      if (m.isEdited) timeStr = '<span class="msg-edited">edited</span>' + timeStr;

      // Link preview
      if (m.linkPreview) {
        bubbleInner += '<div class="link-preview">';
        if (m.linkPreview.imageUrl) bubbleInner += '<img class="lp-image" src="' + esc(m.linkPreview.imageUrl) + '" />';
        if (m.linkPreview.title) bubbleInner += '<div class="lp-title">' + esc(m.linkPreview.title) + '</div>';
        if (m.linkPreview.description) bubbleInner += '<div class="lp-desc">' + esc(m.linkPreview.description) + '</div>';
        bubbleInner += '<div class="lp-url">' + esc(m.linkPreview.url) + '</div>';
        bubbleInner += '</div>';
      }

      // Reactions
      var reactionsHtml = '';
      if (m.reactions && m.reactions.length) {
        reactionsHtml = '<div class="msg-reactions">';
        for (var ri = 0; ri < m.reactions.length; ri++) {
          var r = m.reactions[ri];
          reactionsHtml += '<span class="reaction-chip' + (r.isSelected ? ' selected' : '') + '">' +
            '<span class="reaction-emoji">' + esc(r.emoji) + '</span>' +
            '<span class="reaction-count">' + r.count + '</span></span>';
        }
        reactionsHtml += '</div>';
      }

      // Time goes inside bubble, inline at bottom-right like Telegram
      var timeClass = isLast ? '' : ' hidden';
      var optClass = '';
      var retryHtml = '';
      if (m._optimistic === 'sending') optClass = ' optimistic-sending';
      else if (m._optimistic === 'failed') {
        optClass = ' optimistic-failed';
        retryHtml = '<span class="msg-retry" onclick="retryMessage(' + m.id + ')">⚠️ Failed — tap to retry</span>';
      }

      // Read receipt status icon for outgoing messages
      var statusHtml = '';
      if (g.isOutgoing && !m._optimistic) {
        var statusCls = m.status === 'read' ? 'read' : 'sent';
        var statusIcon = m.status === 'read' ? '✓✓' : '✓✓';
        statusHtml = '<span class="msg-status ' + statusCls + '">' + statusIcon + '</span>';
      }

      // TASK-040: Approval buttons for incoming messages with approval-seeking patterns
      var approvalHtml = '';
      if (!g.isOutgoing && m.text && isApprovalSeeking(m.text)) {
        approvalHtml = '<div class="approval-buttons" data-msg-id="' + m.id + '">' +
          '<button class="approval-btn approve" onclick="handleApproval(this, \'approve\', ' + m.id + ')">✓ Approve</button>' +
          '<button class="approval-btn reject" onclick="handleApproval(this, \'reject\', ' + m.id + ')">✗ Reject</button>' +
          '</div>';
      }

      // TASK-037: Tool execution timeline for messages with tool calls
      var toolTimelineHtml = '';
      if (!g.isOutgoing && m.text) {
        var toolCalls = parseToolCalls(m.text);
        if (toolCalls.length > 0) {
          toolTimelineHtml = renderToolTimeline(toolCalls);
        }
      }

      html += '<div class="msg ' + pos + optClass + '" data-msg-id="' + m.id + '" data-sender="' + esc(m.senderName || '') + '" data-text="' + esc((m.text || '').slice(0, 100)) + '" data-outgoing="' + (g.isOutgoing ? '1' : '0') + '" data-timestamp="' + (m.timestamp || 0) + '">' +
        '<div class="' + bubbleCls + '">' + bubbleInner + '<span class="msg-time' + timeClass + '">' + timeStr + statusHtml + '</span>' + retryHtml + '</div>' +
        toolTimelineHtml +
        reactionsHtml +
        approvalHtml +
        '</div>';
    }
    if (!g.isOutgoing) {
      html += '</div></div>'; // close .msg-group-content and .msg-group-row
    }
    html += '</div>';
  }

  // Check scroll position BEFORE replacing content
  var prevLen = allMessages ? allMessages.length : 0;
  var isFirstRender = messagesList.querySelector('.empty-state') !== null || messagesList.querySelector('.loading') !== null;
  var shouldScroll = isFirstRender || (messagesList.scrollHeight - messagesList.scrollTop - messagesList.clientHeight < 60);
  messagesList.innerHTML = html;
  if (shouldScroll) {
    // Use setTimeout to ensure DOM has fully updated before scrolling
    setTimeout(function() { messagesList.scrollTop = messagesList.scrollHeight; }, 0);
  }

  // Track last message ID for polling
  if (msgs.length > 0) {
    lastMsgId = msgs[msgs.length - 1].id || 0;
  }
  startPolling();
}

// Auto-grow textarea
function autoGrow() {
  msgInput.style.height = 'auto';
  msgInput.style.height = Math.min(msgInput.scrollHeight, 120) + 'px';
}
msgInput.addEventListener('input', autoGrow);

// Reply state
const replyBar = document.getElementById('replyBar');
const replyBarSender = document.getElementById('replyBarSender');
const replyBarText = document.getElementById('replyBarText');
const replyBarClose = document.getElementById('replyBarClose');
let replyToId = null;

function setReply(msgId, sender, text) {
  replyToId = msgId;
  replyBarSender.textContent = sender || 'Unknown';
  replyBarText.textContent = (text || '').slice(0, 100);
  replyBar.classList.add('active');
  msgInput.focus();
}
function clearReply() {
  replyToId = null;
  replyBar.classList.remove('active');
}
replyBarClose.addEventListener('click', clearReply);

// Edit state
const editBar = document.getElementById('editBar');
const editBarText = document.getElementById('editBarText');
const editBarClose = document.getElementById('editBarClose');
let editingMsgId = null;

function setEdit(msgId, text) {
  editingMsgId = msgId;
  editBarText.textContent = (text || '').slice(0, 100);
  editBar.classList.add('active');
  msgInput.value = text || '';
  autoGrow();
  msgInput.focus();
  // Clear reply if active
  clearReply();
}
function clearEdit() {
  editingMsgId = null;
  editBar.classList.remove('active');
  msgInput.value = '';
  msgInput.style.height = 'auto';
}
editBarClose.addEventListener('click', clearEdit);

let optimisticIdCounter = 0;
const pendingOptimistic = new Map(); // tempId -> { text, timestamp }

function doSend() {
  const text = msgInput.value.trim();
  if (!text) return;

  // Handle edit mode
  if (editingMsgId) {
    const msgId = editingMsgId;
    // Optimistic update in-place
    var editIdx = allMessages.findIndex(function(m) { return m.id === msgId; });
    if (editIdx !== -1) {
      allMessages[editIdx].text = text;
      allMessages[editIdx].isEdited = true;
      renderMessages(allMessages);
    }
    vscode.postMessage({ type: 'editMessage', messageId: msgId, text: text });
    clearEdit();
    return;
  }

  msgInput.value = '';
  msgInput.style.height = 'auto';

  // Optimistic: render immediately
  const tempId = --optimisticIdCounter; // negative IDs to avoid collision
  const now = Math.floor(Date.now() / 1000);
  const optimisticMsg = {
    id: tempId,
    text: text,
    isOutgoing: true,
    timestamp: now,
    senderName: '',
    _optimistic: 'sending'
  };
  if (replyToId) optimisticMsg.replyToId = replyToId;

  pendingOptimistic.set(tempId, { text: text, timestamp: now });
  var atBottom = isScrolledToBottom();
  allMessages.push(optimisticMsg);
  renderMessages(allMessages);
  if (atBottom) messagesList.scrollTop = messagesList.scrollHeight;

  // Send in background
  var payload = { type: 'sendMessage', text: text, tempId: tempId };
  if (replyToId) payload.replyToId = replyToId;
  vscode.postMessage(payload);
  clearReply();
}
sendBtn.addEventListener('click', doSend);

// ── Voice Recording ──
var micBtn = document.getElementById('micBtn');
var voiceRecordingBar = document.getElementById('voiceRecordingBar');
var voiceRecTimer = document.getElementById('voiceRecTimer');
var voiceRecWaveform = document.getElementById('voiceRecWaveform');
var voiceRecCancel = document.getElementById('voiceRecCancel');
var voiceRecStop = document.getElementById('voiceRecStop');
var voicePreviewBar = document.getElementById('voicePreviewBar');
var voicePlayBtn = document.getElementById('voicePlayBtn');
var voicePreviewWaveform = document.getElementById('voicePreviewWaveform');
var voicePreviewDuration = document.getElementById('voicePreviewDuration');
var voicePreviewCancel = document.getElementById('voicePreviewCancel');
var voicePreviewSend = document.getElementById('voicePreviewSend');

var voiceState = 'idle'; // idle | recording | preview | sending
var voiceMediaRecorder = null;
var voiceChunks = [];
var voiceStream = null;
var voiceStartTime = 0;
var voiceTimerInterval = null;
var voiceAnalyser = null;
var voiceAnimFrame = null;
var voiceAudioCtx = null;
var voiceRecordedBlob = null;
var voiceRecordedDuration = 0;
var voiceWaveformSamples = [];
var voicePreviewAudio = null;
var voicePreviewPlayInterval = null;

function voiceFormatDuration(sec) {
  var m = Math.floor(sec / 60);
  var s = Math.floor(sec % 60);
  return m + ':' + (s < 10 ? '0' : '') + s;
}

function voiceSetState(newState) {
  voiceState = newState;
  var composerEl = document.querySelector('.composer');
  voiceRecordingBar.classList.toggle('active', newState === 'recording');
  voicePreviewBar.classList.toggle('active', newState === 'preview' || newState === 'sending');
  composerEl.style.display = (newState === 'idle') ? 'flex' : 'none';
}

function voiceStartRecording() {
  navigator.mediaDevices.getUserMedia({ audio: true }).then(function(stream) {
    voiceStream = stream;
    voiceChunks = [];
    voiceWaveformSamples = [];

    // Try ogg/opus first, fall back to webm
    var mimeType = 'audio/ogg; codecs=opus';
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      mimeType = 'audio/webm; codecs=opus';
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        mimeType = 'audio/webm';
      }
    }

    voiceMediaRecorder = new MediaRecorder(stream, { mimeType: mimeType });
    voiceMediaRecorder.ondataavailable = function(e) {
      if (e.data.size > 0) voiceChunks.push(e.data);
    };
    voiceMediaRecorder.onstop = function() {
      voiceRecordedBlob = new Blob(voiceChunks, { type: voiceMediaRecorder.mimeType });
      voiceRecordedDuration = (Date.now() - voiceStartTime) / 1000;
      voiceShowPreview();
    };

    // Audio analyser for waveform
    voiceAudioCtx = new AudioContext();
    var source = voiceAudioCtx.createMediaStreamSource(stream);
    voiceAnalyser = voiceAudioCtx.createAnalyser();
    voiceAnalyser.fftSize = 256;
    source.connect(voiceAnalyser);

    voiceMediaRecorder.start(100);
    voiceStartTime = Date.now();
    voiceSetState('recording');

    // Timer
    voiceTimerInterval = setInterval(function() {
      var elapsed = (Date.now() - voiceStartTime) / 1000;
      voiceRecTimer.textContent = voiceFormatDuration(elapsed);
    }, 200);

    // Waveform animation
    voiceAnimateWaveform();
  }).catch(function(err) {
    console.error('Mic access denied:', err);
  });
}

function voiceAnimateWaveform() {
  if (voiceState !== 'recording' || !voiceAnalyser) return;
  var data = new Uint8Array(voiceAnalyser.frequencyBinCount);
  voiceAnalyser.getByteTimeDomainData(data);

  // Compute RMS amplitude
  var sum = 0;
  for (var i = 0; i < data.length; i++) {
    var v = (data[i] - 128) / 128;
    sum += v * v;
  }
  var rms = Math.sqrt(sum / data.length);
  var level = Math.min(31, Math.round(rms * 200)); // 0-31 like Telegram
  voiceWaveformSamples.push(level);

  // Render bars (last 40)
  var bars = voiceWaveformSamples.slice(-40);
  var html = '';
  for (var j = 0; j < bars.length; j++) {
    var h = Math.max(3, (bars[j] / 31) * 28);
    html += '<div class="bar" style="height:' + h + 'px"></div>';
  }
  voiceRecWaveform.innerHTML = html;

  voiceAnimFrame = requestAnimationFrame(voiceAnimateWaveform);
}

function voiceStopRecording() {
  if (voiceTimerInterval) { clearInterval(voiceTimerInterval); voiceTimerInterval = null; }
  if (voiceAnimFrame) { cancelAnimationFrame(voiceAnimFrame); voiceAnimFrame = null; }
  if (voiceMediaRecorder && voiceMediaRecorder.state !== 'inactive') {
    voiceMediaRecorder.stop();
  }
  if (voiceStream) {
    voiceStream.getTracks().forEach(function(t) { t.stop(); });
    voiceStream = null;
  }
  if (voiceAudioCtx) { voiceAudioCtx.close().catch(function(){}); voiceAudioCtx = null; }
}

function voiceCancelRecording() {
  voiceStopRecording();
  voiceRecordedBlob = null;
  voiceSetState('idle');
  msgInput.focus();
}

function voiceShowPreview() {
  voiceSetState('preview');
  voicePreviewDuration.textContent = voiceFormatDuration(voiceRecordedDuration);

  // Render static waveform for preview (downsample to ~40 bars)
  var targetBars = 40;
  var samples = voiceWaveformSamples;
  var step = Math.max(1, Math.floor(samples.length / targetBars));
  var bars = [];
  for (var i = 0; i < samples.length; i += step) {
    var s = 0, c = 0;
    for (var j = i; j < i + step && j < samples.length; j++) { s += samples[j]; c++; }
    bars.push(c > 0 ? s / c : 0);
  }
  var maxVal = Math.max.apply(null, bars.concat([1]));
  var html = '';
  for (var k = 0; k < bars.length; k++) {
    var h = Math.max(3, (bars[k] / maxVal) * 28);
    html += '<div class="bar" style="height:' + h + 'px"></div>';
  }
  voicePreviewWaveform.innerHTML = html;
}

function voiceTogglePlay() {
  if (voicePreviewAudio && !voicePreviewAudio.paused) {
    voicePreviewAudio.pause();
    voicePlayBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
    if (voicePreviewPlayInterval) { clearInterval(voicePreviewPlayInterval); voicePreviewPlayInterval = null; }
    return;
  }
  if (!voiceRecordedBlob) return;
  var url = URL.createObjectURL(voiceRecordedBlob);
  voicePreviewAudio = new Audio(url);
  voicePreviewAudio.play();
  voicePlayBtn.innerHTML = '<svg viewBox="0 0 24 24"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';

  var allBars = voicePreviewWaveform.querySelectorAll('.bar');
  voicePreviewPlayInterval = setInterval(function() {
    if (!voicePreviewAudio) return;
    var pct = voicePreviewAudio.currentTime / voicePreviewAudio.duration;
    var playedCount = Math.floor(pct * allBars.length);
    for (var i = 0; i < allBars.length; i++) {
      allBars[i].classList.toggle('played', i < playedCount);
    }
    voicePreviewDuration.textContent = voiceFormatDuration(voicePreviewAudio.duration - voicePreviewAudio.currentTime);
  }, 100);

  voicePreviewAudio.onended = function() {
    voicePlayBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
    if (voicePreviewPlayInterval) { clearInterval(voicePreviewPlayInterval); voicePreviewPlayInterval = null; }
    voicePreviewDuration.textContent = voiceFormatDuration(voiceRecordedDuration);
    var allBars2 = voicePreviewWaveform.querySelectorAll('.bar');
    for (var i = 0; i < allBars2.length; i++) allBars2[i].classList.remove('played');
    URL.revokeObjectURL(url);
    voicePreviewAudio = null;
  };
}

function voiceSend() {
  if (!voiceRecordedBlob || voiceState === 'sending') return;
  voiceSetState('sending');
  if (voicePreviewAudio) { voicePreviewAudio.pause(); voicePreviewAudio = null; }

  var reader = new FileReader();
  reader.onloadend = function() {
    var base64 = reader.result.split(',')[1];
    // Downsample waveform to 64 samples (Telegram standard)
    var wf = [];
    var step = Math.max(1, Math.floor(voiceWaveformSamples.length / 64));
    for (var i = 0; i < voiceWaveformSamples.length && wf.length < 64; i += step) {
      wf.push(voiceWaveformSamples[i]);
    }
    var tempId = --optimisticIdCounter;
    vscode.postMessage({
      type: 'sendVoice',
      data: base64,
      duration: voiceRecordedDuration,
      waveform: wf,
      tempId: tempId
    });
  };
  reader.readAsDataURL(voiceRecordedBlob);
}

micBtn.addEventListener('click', function() {
  if (voiceState === 'idle') voiceStartRecording();
});
voiceRecCancel.addEventListener('click', voiceCancelRecording);
voiceRecStop.addEventListener('click', function() { voiceStopRecording(); });
voicePreviewCancel.addEventListener('click', function() {
  if (voicePreviewAudio) { voicePreviewAudio.pause(); voicePreviewAudio = null; }
  voiceRecordedBlob = null;
  voiceSetState('idle');
  msgInput.focus();
});
voicePlayBtn.addEventListener('click', voiceTogglePlay);
voicePreviewSend.addEventListener('click', voiceSend);

window.addEventListener('message', function(event) {
  var msg = event.data;
  if (msg.type === 'voiceSendSuccess') {
    voiceRecordedBlob = null;
    voiceWaveformSamples = [];
    voiceSetState('idle');
    msgInput.focus();
  } else if (msg.type === 'voiceSendFailed') {
    voiceSetState('preview');
  }
});

// ── Image Paste ──
let pastedImageData = null; // { base64, mimeType }
const imagePasteBar = document.getElementById('imagePasteBar');
const imagePasteThumb = document.getElementById('imagePasteThumb');
const imagePasteCaption = document.getElementById('imagePasteCaption');
const imagePasteSend = document.getElementById('imagePasteSend');
const imagePasteCancel = document.getElementById('imagePasteCancel');

function showImagePaste(dataUrl, mimeType) {
  pastedImageData = { dataUrl: dataUrl, mimeType: mimeType };
  imagePasteThumb.src = dataUrl;
  imagePasteCaption.value = '';
  imagePasteBar.classList.add('active');
  setTimeout(function() { imagePasteCaption.focus(); }, 50);
}

function clearImagePaste() {
  pastedImageData = null;
  imagePasteBar.classList.remove('active');
  imagePasteThumb.src = '';
  imagePasteCaption.value = '';
  msgInput.focus();
}

function sendPastedImage() {
  if (!pastedImageData) return;
  var base64 = pastedImageData.dataUrl.split(',')[1];
  var mimeType = pastedImageData.mimeType;
  var ext = mimeType === 'image/png' ? '.png' : mimeType === 'image/jpeg' ? '.jpg' : mimeType === 'image/webp' ? '.webp' : '.png';
  var caption = imagePasteCaption.value.trim();
  var tempId = --optimisticIdCounter;
  vscode.postMessage({
    type: 'sendFile',
    data: base64,
    fileName: 'paste' + ext,
    mimeType: mimeType,
    caption: caption,
    tempId: tempId
  });
  clearImagePaste();
}

imagePasteSend.addEventListener('click', sendPastedImage);
imagePasteCancel.addEventListener('click', clearImagePaste);
imagePasteCaption.addEventListener('keydown', function(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendPastedImage(); }
  if (e.key === 'Escape') { e.preventDefault(); clearImagePaste(); }
});

msgInput.addEventListener('paste', function(e) {
  var items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    if (item.type && item.type.match(/^image\/(png|jpeg|jpg|webp|gif)$/)) {
      e.preventDefault();
      var blob = item.getAsFile();
      if (!blob) return;
      var reader = new FileReader();
      reader.onload = function(ev) {
        showImagePaste(ev.target.result, item.type);
      };
      reader.readAsDataURL(blob);
      return;
    }
  }
});

// ── Emoji Picker ──
(function() {
  const EMOJI_DATA = {
    'recent': { icon: '🕐', label: 'Recently Used', emoji: [] },
    'smileys': { icon: '😀', label: 'Smileys & People', emoji: [
      ['😀','grinning'],['😃','smiley'],['😄','smile'],['😁','grin'],['😆','laughing'],['😅','sweat smile'],['🤣','rofl'],['😂','joy'],['🙂','slightly smiling'],['🙃','upside down'],['😉','wink'],['😊','blush'],['😇','innocent'],['🥰','smiling hearts'],['😍','heart eyes'],['🤩','star struck'],['😘','kissing heart'],['😗','kissing'],['😚','kissing closed eyes'],['😙','kissing smiling'],['🥲','smiling tear'],['😋','yum'],['😛','stuck out tongue'],['😜','stuck out tongue winking'],['🤪','zany'],['😝','stuck out tongue closed eyes'],['🤑','money mouth'],['🤗','hugs'],['🤭','hand over mouth'],['🤫','shushing'],['🤔','thinking'],['🫡','salute'],['🤐','zipper mouth'],['🤨','raised eyebrow'],['😐','neutral'],['😑','expressionless'],['😶','no mouth'],['🫥','dotted line face'],['😏','smirk'],['😒','unamused'],['🙄','rolling eyes'],['😬','grimacing'],['🤥','lying'],['😌','relieved'],['😔','pensive'],['😪','sleepy'],['🤤','drooling'],['😴','sleeping'],['😷','mask'],['🤒','thermometer face'],['🤕','bandage face'],['🤢','nauseated'],['🤮','vomiting'],['🥵','hot face'],['🥶','cold face'],['🥴','woozy'],['😵','dizzy face'],['🤯','exploding head'],['🤠','cowboy'],['🥳','partying'],['🥸','disguised'],['😎','sunglasses'],['🤓','nerd'],['🧐','monocle'],['😕','confused'],['🫤','diagonal mouth'],['😟','worried'],['🙁','slightly frowning'],['☹️','frowning'],['😮','open mouth'],['😯','hushed'],['😲','astonished'],['😳','flushed'],['🥺','pleading'],['🥹','holding back tears'],['😦','frowning open mouth'],['😧','anguished'],['😨','fearful'],['😰','anxious sweat'],['😥','sad relieved'],['😢','crying'],['😭','sobbing'],['😱','screaming'],['😖','confounded'],['😣','persevering'],['😞','disappointed'],['😓','downcast sweat'],['😩','weary'],['😫','tired'],['🥱','yawning'],['😤','steam nose'],['😡','pouting'],['😠','angry'],['🤬','swearing'],['😈','smiling imp'],['👿','imp'],['💀','skull'],['☠️','skull crossbones'],['💩','poop'],['🤡','clown'],['👹','ogre'],['👺','goblin'],['👻','ghost'],['👽','alien'],['👾','alien monster'],['🤖','robot'],['👋','wave'],['🤚','raised back hand'],['🖐️','hand fingers splayed'],['✋','raised hand'],['🖖','vulcan'],['🫱','rightwards hand'],['🫲','leftwards hand'],['👌','ok hand'],['🤌','pinched fingers'],['🤏','pinching'],['✌️','victory'],['🤞','crossed fingers'],['🫰','hand with index and thumb crossed'],['🤟','love you gesture'],['🤘','rock on'],['🤙','call me'],['👈','point left'],['👉','point right'],['👆','point up'],['🖕','middle finger'],['👇','point down'],['☝️','point up 2'],['🫵','point at viewer'],['👍','thumbs up'],['👎','thumbs down'],['✊','fist'],['👊','punch'],['🤛','left fist'],['🤜','right fist'],['👏','clap'],['🙌','raised hands'],['🫶','heart hands'],['👐','open hands'],['🤲','palms up'],['🤝','handshake'],['🙏','pray'],['💪','muscle'],['🫂','hug people'],['👶','baby'],['👦','boy'],['👧','girl'],['👨','man'],['👩','woman'],['🧑','person'],['👴','old man'],['👵','old woman']
    ]},
    'animals': { icon: '🐱', label: 'Animals & Nature', emoji: [
      ['🐶','dog'],['🐱','cat'],['🐭','mouse'],['🐹','hamster'],['🐰','rabbit'],['🦊','fox'],['🐻','bear'],['🐼','panda'],['🐻‍❄️','polar bear'],['🐨','koala'],['🐯','tiger'],['🦁','lion'],['🐮','cow'],['🐷','pig'],['🐸','frog'],['🐵','monkey'],['🙈','see no evil'],['🙉','hear no evil'],['🙊','speak no evil'],['🐒','monkey 2'],['🐔','chicken'],['🐧','penguin'],['🐦','bird'],['🐤','baby chick'],['🦆','duck'],['🦅','eagle'],['🦉','owl'],['🦇','bat'],['🐺','wolf'],['🐗','boar'],['🐴','horse'],['🦄','unicorn'],['🐝','bee'],['🪱','worm'],['🐛','bug'],['🦋','butterfly'],['🐌','snail'],['🐞','ladybug'],['🐜','ant'],['🪰','fly'],['🪲','beetle'],['🦟','mosquito'],['🪳','cockroach'],['🐢','turtle'],['🐍','snake'],['🦎','lizard'],['🦂','scorpion'],['🕷️','spider'],['🐙','octopus'],['🦑','squid'],['🦐','shrimp'],['🦀','crab'],['🐡','blowfish'],['🐠','tropical fish'],['🐟','fish'],['🐬','dolphin'],['🐳','whale'],['🐋','whale 2'],['🦈','shark'],['🐊','crocodile'],['🐅','tiger 2'],['🐆','leopard'],['🦓','zebra'],['🦍','gorilla'],['🐘','elephant'],['🦛','hippo'],['🦏','rhino'],['🐪','camel'],['🐫','two hump camel'],['🦒','giraffe'],['🐃','water buffalo'],['🐂','ox'],['🐄','cow 2'],['🌵','cactus'],['🎄','christmas tree'],['🌲','evergreen'],['🌳','deciduous tree'],['🌴','palm tree'],['🪵','wood'],['🌱','seedling'],['🌿','herb'],['☘️','shamrock'],['🍀','four leaf clover'],['🌸','cherry blossom'],['🌺','hibiscus'],['🌻','sunflower'],['🌹','rose'],['🌷','tulip'],['🌼','blossom'],['🪷','lotus'],['💐','bouquet'],['🍂','fallen leaf'],['🍁','maple leaf'],['🍃','leaves'],['🪺','nest eggs'],['🪹','empty nest']
    ]},
    'food': { icon: '🍕', label: 'Food & Drink', emoji: [
      ['🍎','apple'],['🍊','orange'],['🍋','lemon'],['🍌','banana'],['🍉','watermelon'],['🍇','grapes'],['🍓','strawberry'],['🫐','blueberries'],['🍈','melon'],['🍒','cherries'],['🍑','peach'],['🥭','mango'],['🍍','pineapple'],['🥥','coconut'],['🥝','kiwi'],['🍅','tomato'],['🥑','avocado'],['🍆','eggplant'],['🥔','potato'],['🥕','carrot'],['🌽','corn'],['🌶️','hot pepper'],['🫑','bell pepper'],['🥒','cucumber'],['🥬','leafy green'],['🥦','broccoli'],['🧄','garlic'],['🧅','onion'],['🍄','mushroom'],['🥜','peanuts'],['🫘','beans'],['🌰','chestnut'],['🍞','bread'],['🥐','croissant'],['🥖','baguette'],['🫓','flatbread'],['🥨','pretzel'],['🧀','cheese'],['🥚','egg'],['🍳','cooking'],['🧈','butter'],['🥞','pancakes'],['🧇','waffle'],['🥓','bacon'],['🥩','cut of meat'],['🍗','poultry leg'],['🍖','meat on bone'],['🌭','hot dog'],['🍔','hamburger'],['🍟','fries'],['🍕','pizza'],['🫔','tamale'],['🥪','sandwich'],['🌮','taco'],['🌯','burrito'],['🫕','fondue'],['🥗','salad'],['🍝','spaghetti'],['🍜','ramen'],['🍲','stew'],['🍛','curry'],['🍣','sushi'],['🍱','bento'],['🥟','dumpling'],['🍤','fried shrimp'],['🍙','rice ball'],['🍚','rice'],['🍘','rice cracker'],['🍧','shaved ice'],['🍨','ice cream'],['🎂','birthday cake'],['🍰','shortcake'],['🧁','cupcake'],['🥧','pie'],['🍫','chocolate'],['🍬','candy'],['🍭','lollipop'],['🍮','custard'],['🍯','honey pot'],['🍼','baby bottle'],['🥛','milk'],['☕','coffee'],['🫖','teapot'],['🍵','tea'],['🧃','juice box'],['🥤','cup with straw'],['🧋','bubble tea'],['🍶','sake'],['🍺','beer'],['🍻','cheers'],['🥂','champagne'],['🍷','wine'],['🥃','whiskey'],['🍸','cocktail'],['🍹','tropical drink'],['🧉','mate'],['🍾','bottle with popping cork']
    ]},
    'activity': { icon: '⚽', label: 'Activity', emoji: [
      ['⚽','soccer'],['🏀','basketball'],['🏈','football'],['⚾','baseball'],['🥎','softball'],['🎾','tennis'],['🏐','volleyball'],['🏉','rugby'],['🥏','flying disc'],['🎱','8ball'],['🏓','ping pong'],['🏸','badminton'],['🏒','hockey'],['🥅','goal net'],['⛳','golf'],['🏹','bow and arrow'],['🎣','fishing'],['🤿','diving mask'],['🥊','boxing glove'],['🥋','martial arts'],['🎽','running shirt'],['⛸️','ice skate'],['🛷','sled'],['🎿','ski'],['⛷️','skier'],['🏂','snowboarder'],['🏋️','weight lifter'],['🤼','wrestlers'],['🤸','cartwheeling'],['🤺','fencer'],['🏇','horse racing'],['🧘','yoga'],['🏄','surfing'],['🏊','swimming'],['🚣','rowing'],['🧗','climbing'],['🚴','biking'],['🏆','trophy'],['🥇','1st place'],['🥈','2nd place'],['🥉','3rd place'],['🏅','medal'],['🎖️','military medal'],['🎪','circus tent'],['🎭','performing arts'],['🎨','art'],['🎬','clapper board'],['🎤','microphone'],['🎧','headphones'],['🎼','musical score'],['🎹','piano'],['🥁','drum'],['🎷','saxophone'],['🎺','trumpet'],['🎸','guitar'],['🪕','banjo'],['🎻','violin'],['🎲','game die'],['♟️','chess pawn'],['🎯','dart'],['🎳','bowling'],['🎮','video game'],['🕹️','joystick'],['🎰','slot machine'],['🧩','puzzle piece']
    ]},
    'travel': { icon: '🌍', label: 'Travel & Places', emoji: [
      ['🚗','car'],['🚕','taxi'],['🚙','suv'],['🚌','bus'],['🚎','trolleybus'],['🏎️','racing car'],['🚓','police car'],['🚑','ambulance'],['🚒','fire engine'],['🚐','minibus'],['🛻','pickup truck'],['🚚','truck'],['🚛','articulated lorry'],['🚜','tractor'],['🏍️','motorcycle'],['🛵','motor scooter'],['🚲','bicycle'],['🛴','kick scooter'],['🚂','locomotive'],['🚆','train'],['🚇','metro'],['🚈','light rail'],['🚊','tram'],['🚉','station'],['✈️','airplane'],['🛫','departure'],['🛬','arrival'],['🚀','rocket'],['🛸','flying saucer'],['🚁','helicopter'],['⛵','sailboat'],['🚤','speedboat'],['🛳️','cruise ship'],['⛴️','ferry'],['🚢','ship'],['⚓','anchor'],['🗼','tokyo tower'],['🗽','statue of liberty'],['🏰','castle'],['🏯','japanese castle'],['🎡','ferris wheel'],['🎢','roller coaster'],['🏠','house'],['🏡','garden house'],['🏢','office'],['🏥','hospital'],['🏦','bank'],['🏨','hotel'],['🏪','convenience store'],['🏫','school'],['🏬','department store'],['🏭','factory'],['⛪','church'],['🕌','mosque'],['🛕','hindu temple'],['🕍','synagogue'],['🗾','japan'],['🌍','earth africa'],['🌎','earth americas'],['🌏','earth asia'],['🌋','volcano'],['🗻','mount fuji'],['🏕','camping'],['🏖️','beach'],['🏜️','desert'],['🏝️','desert island'],['🌅','sunrise'],['🌄','sunrise mountains'],['🌠','shooting star'],['🎆','fireworks'],['🎇','sparkler'],['🌃','night stars'],['🌉','bridge night'],['🌌','milky way']
    ]},
    'objects': { icon: '💡', label: 'Objects', emoji: [
      ['⌚','watch'],['📱','phone'],['💻','laptop'],['⌨️','keyboard'],['🖥️','desktop'],['🖨️','printer'],['🖱️','mouse'],['💾','floppy disk'],['💿','cd'],['📀','dvd'],['🎥','movie camera'],['📷','camera'],['📹','video camera'],['📺','television'],['📻','radio'],['🔋','battery'],['🔌','electric plug'],['💡','light bulb'],['🔦','flashlight'],['🕯️','candle'],['🪔','diya lamp'],['📔','notebook'],['📕','book'],['📖','open book'],['📗','green book'],['📘','blue book'],['📙','orange book'],['📚','books'],['📓','notebook 2'],['📒','ledger'],['📃','page curl'],['📜','scroll'],['📄','page'],['📰','newspaper'],['🗞️','rolled newspaper'],['📑','bookmark tabs'],['🔖','bookmark'],['🏷️','label'],['💰','money bag'],['🪙','coin'],['💴','yen'],['💵','dollar'],['💶','euro'],['💷','pound'],['💎','gem'],['🔧','wrench'],['🪛','screwdriver'],['🔩','nut bolt'],['🪜','ladder'],['🧲','magnet'],['🔬','microscope'],['🔭','telescope'],['📡','satellite dish'],['💉','syringe'],['🩸','drop of blood'],['💊','pill'],['🩹','bandage'],['🧬','dna'],['🔑','key'],['🗝️','old key'],['🔒','lock'],['🔓','unlock'],['🛡️','shield'],['⚔️','crossed swords'],['🪄','magic wand'],['📦','package'],['✉️','envelope'],['📧','email'],['📮','postbox'],['🗑️','wastebasket'],['🛒','shopping cart']
    ]},
    'symbols': { icon: '❤️', label: 'Symbols', emoji: [
      ['❤️','red heart'],['🧡','orange heart'],['💛','yellow heart'],['💚','green heart'],['💙','blue heart'],['💜','purple heart'],['🖤','black heart'],['🤍','white heart'],['🤎','brown heart'],['💔','broken heart'],['❤️‍🔥','heart on fire'],['❤️‍🩹','mending heart'],['💕','two hearts'],['💞','revolving hearts'],['💓','heartbeat'],['💗','growing heart'],['💖','sparkling heart'],['💘','cupid'],['💝','gift heart'],['💟','heart decoration'],['☮️','peace'],['✝️','cross'],['☪️','star and crescent'],['🕉️','om'],['☸️','wheel of dharma'],['✡️','star of david'],['🔯','six pointed star'],['☯️','yin yang'],['♈','aries'],['♉','taurus'],['♊','gemini'],['♋','cancer'],['♌','leo'],['♍','virgo'],['♎','libra'],['♏','scorpio'],['♐','sagittarius'],['♑','capricorn'],['♒','aquarius'],['♓','pisces'],['⛎','ophiuchus'],['🆔','id'],['⚛️','atom'],['🉐','accept'],['☢️','radioactive'],['☣️','biohazard'],['📴','mobile phone off'],['📳','vibration mode'],['🈶','u6709'],['🈚','u7121'],['✅','check mark'],['❌','cross mark'],['❓','question'],['❗','exclamation'],['‼️','double exclamation'],['⁉️','exclamation question'],['💯','100'],['🔅','dim'],['🔆','bright'],['⚠️','warning'],['🚸','children crossing'],['🔱','trident'],['♻️','recycle'],['✳️','eight spoked asterisk'],['❇️','sparkle'],['🔰','beginner'],['💠','diamond shape dot'],['Ⓜ️','m circled'],['🔴','red circle'],['🟠','orange circle'],['🟡','yellow circle'],['🟢','green circle'],['🔵','blue circle'],['🟣','purple circle'],['⚫','black circle'],['⚪','white circle'],['🟤','brown circle'],['🔺','red triangle up'],['🔻','red triangle down'],['🔸','small orange diamond'],['🔹','small blue diamond'],['🔶','large orange diamond'],['🔷','large blue diamond'],['💬','speech bubble'],['💭','thought bubble'],['🗯️','anger bubble'],['🏁','checkered flag'],['🚩','red flag'],['🏴','black flag'],['🏳️','white flag']
    ]},
    'flags': { icon: '🚩', label: 'Flags', emoji: [
      ['🇺🇸','us flag'],['🇬🇧','gb flag'],['🇫🇷','france flag'],['🇩🇪','germany flag'],['🇮🇹','italy flag'],['🇪🇸','spain flag'],['🇵🇹','portugal flag'],['🇧🇷','brazil flag'],['🇦🇷','argentina flag'],['🇲🇽','mexico flag'],['🇨🇦','canada flag'],['🇦🇺','australia flag'],['🇯🇵','japan flag'],['🇰🇷','korea flag'],['🇨🇳','china flag'],['🇮🇳','india flag'],['🇷🇺','russia flag'],['🇹🇷','turkey flag'],['🇸🇦','saudi arabia flag'],['🇦🇪','uae flag'],['🇹🇭','thailand flag'],['🇻🇳','vietnam flag'],['🇮🇩','indonesia flag'],['🇵🇭','philippines flag'],['🇳🇬','nigeria flag'],['🇿🇦','south africa flag'],['🇪🇬','egypt flag'],['🇰🇪','kenya flag'],['🇨🇴','colombia flag'],['🇨🇱','chile flag'],['🇵🇪','peru flag'],['🇳🇱','netherlands flag'],['🇧🇪','belgium flag'],['🇨🇭','switzerland flag'],['🇦🇹','austria flag'],['🇸🇪','sweden flag'],['🇳🇴','norway flag'],['🇩🇰','denmark flag'],['🇫🇮','finland flag'],['🇵🇱','poland flag'],['🇬🇷','greece flag'],['🇮🇪','ireland flag'],['🇮🇱','israel flag'],['🇺🇦','ukraine flag'],['🇷🇴','romania flag'],['🇭🇺','hungary flag'],['🇨🇿','czech flag'],['🇸🇬','singapore flag'],['🇲🇾','malaysia flag'],['🇳🇿','new zealand flag'],['🏳️‍🌈','rainbow flag'],['🏴‍☠️','pirate flag']
    ]}
  };

  const picker = document.getElementById('emojiPicker');
  const emojiBtn = document.getElementById('emojiBtn');
  const emojiSearch = document.getElementById('emojiSearch');
  const emojiTabs = document.getElementById('emojiTabs');
  const emojiGridWrap = document.getElementById('emojiGridWrap');
  let pickerOpen = false;
  let activeCategory = 'smileys';

  // Recently used (localStorage)
  const RECENT_KEY = 'oceangram-recent-emoji';
  function getRecent() {
    try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; }
  }
  function addRecent(em) {
    let r = getRecent().filter(e => e !== em);
    r.unshift(em);
    if (r.length > 24) r = r.slice(0, 24);
    localStorage.setItem(RECENT_KEY, JSON.stringify(r));
    EMOJI_DATA.recent.emoji = r.map(e => [e, '']);
  }

  // Init recent
  EMOJI_DATA.recent.emoji = getRecent().map(e => [e, '']);

  // Build tabs
  function buildTabs() {
    emojiTabs.innerHTML = '';
    for (const [key, cat] of Object.entries(EMOJI_DATA)) {
      if (key === 'recent' && cat.emoji.length === 0) continue;
      const btn = document.createElement('button');
      btn.className = 'emoji-tab' + (key === activeCategory ? ' active' : '');
      btn.textContent = cat.icon;
      btn.title = cat.label;
      btn.onclick = () => { activeCategory = key; buildTabs(); renderGrid(); };
      emojiTabs.appendChild(btn);
    }
  }

  // Render grid
  function renderGrid(filter) {
    emojiGridWrap.innerHTML = '';
    const cats = filter ? Object.entries(EMOJI_DATA) : [[activeCategory, EMOJI_DATA[activeCategory]]];
    for (const [key, cat] of cats) {
      if (key === 'recent' && cat.emoji.length === 0) continue;
      let emojis = cat.emoji;
      if (filter) {
        emojis = emojis.filter(e => e[1] && e[1].includes(filter));
        if (emojis.length === 0) continue;
      }
      const label = document.createElement('div');
      label.className = 'emoji-cat-label';
      label.textContent = cat.label;
      emojiGridWrap.appendChild(label);
      const grid = document.createElement('div');
      grid.className = 'emoji-grid';
      for (const [em] of emojis) {
        const span = document.createElement('span');
        span.textContent = em;
        span.title = emojis.find(e => e[0] === em)?.[1] || '';
        span.onclick = () => insertEmoji(em);
        grid.appendChild(span);
      }
      emojiGridWrap.appendChild(grid);
    }
  }

  function insertEmoji(em) {
    addRecent(em);
    const ta = document.getElementById('msgInput');
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const val = ta.value;
    ta.value = val.slice(0, start) + em + val.slice(end);
    const pos = start + em.length;
    ta.selectionStart = ta.selectionEnd = pos;
    ta.focus();
    ta.dispatchEvent(new Event('input'));
    closePicker();
  }

  function openPicker() {
    pickerOpen = true;
    picker.style.display = 'flex';
    emojiBtn.classList.add('active');
    emojiSearch.value = '';
    activeCategory = getRecent().length > 0 ? 'recent' : 'smileys';
    EMOJI_DATA.recent.emoji = getRecent().map(e => [e, '']);
    buildTabs();
    renderGrid();
    emojiSearch.focus();
  }

  function closePicker() {
    pickerOpen = false;
    picker.style.display = 'none';
    emojiBtn.classList.remove('active');
  }

  emojiBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    pickerOpen ? closePicker() : openPicker();
  });

  emojiSearch.addEventListener('input', () => {
    const q = emojiSearch.value.trim().toLowerCase();
    if (q) {
      renderGrid(q);
    } else {
      renderGrid();
    }
  });

  document.addEventListener('click', (e) => {
    if (pickerOpen && !picker.contains(e.target) && e.target !== emojiBtn) closePicker();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && pickerOpen) { closePicker(); e.stopPropagation(); }
  });
})();

msgInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    doSend();
  }
  if (e.key === 'Escape') {
    if (pastedImageData) { clearImagePaste(); }
    else if (editingMsgId) { clearEdit(); }
    else if (replyToId) { clearReply(); }
  }
});

// Track all messages for prepending older ones
let allMessages = [];
let loadingOlder = false;
let oldestId = 0;
let prevMsgIds = '';
const profilePhotos = {}; // senderId -> base64 data URI
const newMsgsBtn = document.getElementById('newMsgsBtn');
let newMsgCount = 0;

function isScrolledToBottom() {
  return messagesList.scrollHeight - messagesList.scrollTop - messagesList.clientHeight < 60;
}
function scrollToBottom() {
  messagesList.scrollTop = messagesList.scrollHeight;
  newMsgsBtn.style.display = 'none';
  newMsgCount = 0;
}

window.addEventListener('message', (event) => {
  const msg = event.data;
  switch (msg.type) {
    case 'messages':
      if (msg.error && (!msg.messages || msg.messages.length === 0)) {
        messagesList.innerHTML = '<div class="empty-state">⚠️ ' + msg.error + '<br><small>Try reopening the chat</small></div>';
        break;
      }
      var wasAtBottom = isScrolledToBottom();
      var prevLen = allMessages.length;
      // Merge server messages with optimistic ones — in-place replacement, no flicker
      var newMsgs = msg.messages;
      var optimisticList = allMessages.filter(function(m) { return m._optimistic; });
      // Replace optimistic messages that now have real echoes
      for (var oi = 0; oi < optimisticList.length; oi++) {
        var opt = optimisticList[oi];
        var matchIdx = -1;
        for (var ni = 0; ni < newMsgs.length; ni++) {
          if (newMsgs[ni].isOutgoing && newMsgs[ni].text === opt.text && Math.abs(newMsgs[ni].timestamp - opt.timestamp) < 30) {
            matchIdx = ni;
            break;
          }
        }
        if (matchIdx !== -1) {
          // Real message found — drop the optimistic one
          pendingOptimistic.delete(opt.id);
          optimisticList.splice(oi, 1);
          oi--;
        }
      }
      // Merge: server messages + any still-pending optimistic ones
      allMessages = newMsgs.concat(optimisticList);
      allMessages.sort(function(a, b) { return a.timestamp - b.timestamp || a.id - b.id; });
      if (allMessages.length > 0) oldestId = allMessages[0].id || 0;
      // Skip re-render if nothing actually changed (avoid flicker)
      var newIds = allMessages.map(function(m) { return m.id; }).join(',');
      var prevIds = (prevLen > 0) ? null : ''; // force render on first load
      var isFirstLoad = prevLen === 0;
      if (!isFirstLoad && newIds === prevMsgIds) break;
      prevMsgIds = newIds;
      renderMessages(allMessages);
      if (isFirstLoad) { setTimeout(function() { messagesList.scrollTop = messagesList.scrollHeight; }, 0); }
      if (!wasAtBottom && allMessages.length > prevLen && prevLen > 0) {
        newMsgCount += allMessages.length - prevLen;
        newMsgsBtn.textContent = '↓ ' + newMsgCount + ' new message' + (newMsgCount > 1 ? 's' : '');
        newMsgsBtn.style.display = 'block';
      }
      break;
    case 'newMessage':
      // Clear typing indicator for this sender
      if (msg.message && msg.message.senderId && typingUsers[msg.message.senderId]) {
        clearTimeout(typingUsers[msg.message.senderId].timeout);
        delete typingUsers[msg.message.senderId];
        updateTypingDisplay();
      }
      // Real-time: append single new message
      if (msg.message && !allMessages.some(function(m) { return m.id === msg.message.id; })) {
        // Echo suppression: if this matches a pending optimistic message, replace it
        var echoIdx = -1;
        if (msg.message.isOutgoing) {
          for (var ei = allMessages.length - 1; ei >= 0; ei--) {
            var om = allMessages[ei];
            if (om._optimistic && om.text === msg.message.text && Math.abs(msg.message.timestamp - om.timestamp) < 30) {
              echoIdx = ei;
              pendingOptimistic.delete(om.id);
              break;
            }
          }
        }
        var atBottom = isScrolledToBottom();
        if (echoIdx !== -1) {
          allMessages[echoIdx] = msg.message; // replace optimistic with real
        } else {
          allMessages.push(msg.message);
        }
        if (allMessages.length > 0) lastMsgId = allMessages[allMessages.length - 1].id || 0;
        renderMessages(allMessages);
        if (atBottom) { messagesList.scrollTop = messagesList.scrollHeight; }
        else if (echoIdx === -1) {
          newMsgCount++;
          newMsgsBtn.textContent = '↓ ' + newMsgCount + ' new message' + (newMsgCount > 1 ? 's' : '');
          newMsgsBtn.style.display = 'block';
        }
      }
      break;
    case 'editMessage':
      // Real-time: update edited message in place
      if (msg.message) {
        var idx = allMessages.findIndex(function(m) { return m.id === msg.message.id; });
        if (idx !== -1) {
          // Detect reaction changes for flash animation
          var oldReactions = JSON.stringify((allMessages[idx].reactions || []).map(function(r) { return r.emoji + r.count; }).sort());
          var newReactions = JSON.stringify((msg.message.reactions || []).map(function(r) { return r.emoji + r.count; }).sort());
          var reactionsChanged = oldReactions !== newReactions;
          allMessages[idx] = msg.message;
          renderMessages(allMessages);
          if (reactionsChanged) {
            var flashEl = messagesList.querySelector('.msg[data-msg-id="' + msg.message.id + '"]');
            if (flashEl) {
              flashEl.classList.add('reaction-flash');
              setTimeout(function() { flashEl.classList.remove('reaction-flash'); }, 1000);
            }
          }
        }
      }
      break;
    case 'deleteMessages':
      // Real-time: remove deleted messages with fade-out
      if (msg.messageIds && msg.messageIds.length > 0) {
        var delSet = new Set(msg.messageIds);
        msg.messageIds.forEach(function(id) {
          var el = messagesList.querySelector('.msg[data-msg-id="' + id + '"]');
          if (el) el.classList.add('fade-out');
        });
        setTimeout(function() {
          var before = allMessages.length;
          allMessages = allMessages.filter(function(m) { return !delSet.has(m.id); });
          if (allMessages.length !== before) renderMessages(allMessages);
        }, 300);
      }
      break;
    case 'typing':
      if (msg.userId && msg.userName) {
        handleTypingEvent(msg.userId, msg.userName);
      }
      break;
    case 'userStatus':
      if (msg.userId && msg.status) {
        updateUserStatus(msg.userId, msg.status);
      }
      break;
    case 'reactionUpdate':
      // Real-time: update reactions on a specific message
      if (msg.messageId && msg.reactions !== undefined) {
        var rIdx = allMessages.findIndex(function(m) { return m.id === msg.messageId; });
        if (rIdx !== -1) {
          allMessages[rIdx].reactions = msg.reactions;
          var msgEl = messagesList.querySelector('.msg[data-msg-id="' + msg.messageId + '"]');
          if (msgEl) {
            // Update reactions in-place
            var oldReactionsEl = msgEl.querySelector('.msg-reactions');
            var newReactionsHtml = '';
            if (msg.reactions && msg.reactions.length) {
              newReactionsHtml = '<div class="msg-reactions">';
              for (var rri = 0; rri < msg.reactions.length; rri++) {
                var rr = msg.reactions[rri];
                newReactionsHtml += '<span class="reaction-chip' + (rr.isSelected ? ' selected' : '') + '">' +
                  '<span class="reaction-emoji">' + esc(rr.emoji) + '</span>' +
                  '<span class="reaction-count">' + rr.count + '</span></span>';
              }
              newReactionsHtml += '</div>';
            }
            var bubbleEl = msgEl.querySelector('.msg-bubble');
            if (bubbleEl) {
              if (oldReactionsEl) oldReactionsEl.remove();
              if (newReactionsHtml) {
                bubbleEl.insertAdjacentHTML('beforeend', newReactionsHtml);
              }
              msgEl.classList.add('reaction-flash');
              setTimeout(function() { msgEl.classList.remove('reaction-flash'); }, 1000);
            }
          }
        }
      }
      break;
    case 'readOutbox':
      // Update outgoing message statuses to 'read' for ids <= maxId
      if (msg.maxId) {
        var changed = false;
        for (var ri = allMessages.length - 1; ri >= 0; ri--) {
          var rm = allMessages[ri];
          if (rm.isOutgoing && rm.id > 0 && rm.id <= msg.maxId && rm.status !== 'read') {
            rm.status = 'read';
            changed = true;
          }
        }
        if (changed) {
          // Update status icons in-place without full re-render
          var statusEls = messagesList.querySelectorAll('.msg[data-outgoing="1"] .msg-status');
          statusEls.forEach(function(el) {
            var msgEl = el.closest('.msg');
            var msgId = msgEl ? parseInt(msgEl.dataset.msgId) : 0;
            if (msgId > 0 && msgId <= msg.maxId) {
              el.className = 'msg-status read';
            }
          });
        }
      }
      break;
    case 'olderMessages':
      loadingOlder = false;
      if (msg.messages && msg.messages.length > 0) {
        // Prepend older messages, avoid duplicates
        const existingIds = new Set(allMessages.map(m => m.id));
        const newOlder = msg.messages.filter(m => !existingIds.has(m.id));
        if (newOlder.length > 0) {
          allMessages = [...newOlder, ...allMessages];
          oldestId = allMessages[0].id || 0;
          // Save scroll height to maintain position
          const prevHeight = messagesList.scrollHeight;
          renderMessages(allMessages);
          // Restore scroll position
          messagesList.scrollTop = messagesList.scrollHeight - prevHeight;
        }
      }
      break;
    case 'sendSuccess':
      // Remove optimistic flag — real message will arrive via newMessage event
      var sIdx = allMessages.findIndex(function(m) { return m.id === msg.tempId; });
      if (sIdx !== -1) {
        allMessages[sIdx]._optimistic = null;
        renderMessages(allMessages);
      }
      break;
    case 'sendFailed':
      var fIdx = allMessages.findIndex(function(m) { return m.id === msg.tempId; });
      if (fIdx !== -1) {
        allMessages[fIdx]._optimistic = 'failed';
        renderMessages(allMessages);
      }
      pendingOptimistic.delete(msg.tempId);
      break;
    case 'editFailed':
      // Edit failed — the real-time event will eventually correct, but show error
      console.warn('Edit failed for message ' + msg.messageId + ': ' + msg.error);
      break;
    case 'profilePhotos':
      // Store profile photos and update existing avatars in DOM
      if (msg.photos) {
        for (var pid in msg.photos) {
          profilePhotos[pid] = msg.photos[pid];
        }
        // Update all avatar elements with matching sender IDs
        document.querySelectorAll('.msg-avatar[data-sender-id]').forEach(function(el) {
          var sid = el.getAttribute('data-sender-id');
          if (sid && profilePhotos[sid]) {
            el.innerHTML = '<img src="' + profilePhotos[sid] + '" style="width:100%;height:100%;border-radius:50%;object-fit:cover" />';
          }
        });
      }
      break;
    case 'videoData': {
      var vidMsgId = String(msg.messageId);
      var vidContainer = window._videoPending && window._videoPending[vidMsgId];
      if (vidContainer) {
        var vidLoader = vidContainer.querySelector('.msg-video-loading');
        if (vidLoader) vidLoader.remove();
        if (msg.error || !msg.dataUrl) {
          // Show error, restore play button
          var vidPlayBtn = vidContainer.querySelector('.msg-video-play');
          if (vidPlayBtn) vidPlayBtn.style.display = '';
          console.warn('Video download failed:', msg.error);
        } else {
          // Remove thumbnail and meta, insert video player
          var vidThumb = vidContainer.querySelector('.msg-video-thumb, .msg-video-no-thumb');
          if (vidThumb) vidThumb.remove();
          var vidMeta = vidContainer.querySelector('.msg-video-meta');
          if (vidMeta) vidMeta.remove();
          var video = document.createElement('video');
          video.src = msg.dataUrl;
          video.controls = true;
          video.autoplay = true;
          video.style.width = '100%';
          if (vidContainer.classList.contains('video-note')) {
            video.style.borderRadius = '50%';
            video.style.objectFit = 'cover';
          }
          vidContainer.insertBefore(video, vidContainer.firstChild);
        }
        delete window._videoPending[vidMsgId];
      }
      break;
    }
    case 'downloadProgress': {
      var progEl = document.getElementById('file-progress-' + msg.messageId);
      if (progEl) {
        progEl.classList.add('active');
        var bar = progEl.querySelector('.msg-file-progress-bar');
        if (bar) bar.style.width = msg.progress + '%';
      }
      break;
    }
    case 'downloadComplete': {
      var progEl2 = document.getElementById('file-progress-' + msg.messageId);
      if (progEl2) {
        progEl2.classList.remove('active');
        var bar2 = progEl2.querySelector('.msg-file-progress-bar');
        if (bar2) bar2.style.width = '0%';
      }
      break;
    }
    case 'downloadError': {
      var progEl3 = document.getElementById('file-progress-' + msg.messageId);
      if (progEl3) progEl3.classList.remove('active');
      console.error('Download failed:', msg.error);
      break;
    }
    case 'fileSendSuccess':
      // File upload completed successfully
      break;
    case 'fileSendFailed':
      // File upload failed — show error
      console.error('File send failed:', msg.error);
      errorBox.textContent = 'File send failed: ' + (msg.error || 'Unknown error');
      errorBox.style.display = 'block';
      setTimeout(function() { errorBox.style.display = 'none'; }, 10000);
      break;
    case 'uploadProgress':
      // Upload progress indicator (future enhancement)
      break;
    case 'agentInfo':
      updateAgentBanner(msg.info);
      break;
    case 'pinnedMessages':
      handlePinnedMessages(msg.messages);
      break;
    case 'agentDetails':
      renderAgentDetails(msg.data);
      break;
    case 'toolCalls':
      renderToolTimeline(msg.data);
      break;
    case 'connectionState': {
      var rcBanner = document.getElementById('reconnectBanner');
      var rcText = document.getElementById('reconnectText');
      if (msg.state === 'connected') {
        if (rcBanner) rcBanner.classList.remove('visible');
      } else if (msg.state === 'reconnecting') {
        if (rcBanner) rcBanner.classList.add('visible');
        if (rcText) rcText.textContent = 'Reconnecting' + (msg.attempt > 1 ? ' (attempt ' + msg.attempt + ')' : '') + '...';
      } else if (msg.state === 'disconnected') {
        if (rcBanner) rcBanner.classList.add('visible');
        if (rcText) rcText.textContent = 'Disconnected — waiting to reconnect...';
      }
      break;
    }
    case 'error':
      errorBox.textContent = msg.message;
      errorBox.style.display = 'block';
      setTimeout(() => errorBox.style.display = 'none', 30000);
      break;
    case 'showDigest':
      if (msg.digest) {
        showSessionDigest(msg.digest);
      }
      break;
    case 'scrollToMessage':
      if (msg.messageId) {
        scrollToMessageById(msg.messageId);
      }
      break;
    // TASK-035: Semantic Search Response Handlers
    case 'searchIndexStats':
      isSemanticSearchAvailable = msg.stats.isAvailable;
      if (!isSemanticSearchAvailable) {
        semanticToggle.disabled = true;
        semanticToggle.parentElement.innerHTML = `
          <button class="index-button" onclick="indexMessagesManually()" title="Index this chat for semantic search">
            🧠 Index Chat
          </button>
        `;
      } else {
        semanticToggle.disabled = false;
        semanticToggle.parentElement.innerHTML = `
          <input type="checkbox" id="semanticToggle" title="Enable semantic search" />
          <span class="search-toggle-text">🧠 Semantic</span>
        `;
        // Re-assign the toggle reference since we recreated the element
        semanticToggle = document.getElementById('semanticToggle');
        semanticToggle.addEventListener('change', function() {
          var query = searchInput.value.trim();
          if (query) {
            if (semanticToggle.checked && isSemanticSearchAvailable) {
              doSemanticSearch(query);
            } else {
              doLocalSearch();
            }
          }
        });
        semanticToggle.parentElement.title = `${msg.stats.dialogCount} messages indexed`;
      }
      break;
    case 'autoIndexingComplete':
      if (msg.messageCount > 0) {
        isSemanticSearchAvailable = true;
        semanticToggle.disabled = false;
        semanticToggle.parentElement.title = `${msg.messageCount} messages indexed for semantic search`;
        // Show a brief notification
        searchCount.textContent = `🧠 Indexed ${msg.messageCount} messages`;
        setTimeout(() => {
          if (searchCount.textContent.includes('🧠 Indexed')) {
            searchCount.textContent = '';
          }
        }, 3000);
      }
      break;
    case 'indexingComplete':
      if (msg.stats && msg.stats.totalMessages > 0) {
        isSemanticSearchAvailable = true;
        semanticToggle.disabled = false;
        semanticToggle.parentElement.title = `${msg.stats.totalMessages} messages indexed`;
        searchCount.textContent = `✅ Indexed ${msg.stats.totalMessages} messages`;
        setTimeout(() => {
          if (searchCount.textContent.includes('✅ Indexed')) {
            searchCount.textContent = '';
          }
        }, 3000);
      }
      break;
    case 'semanticSearchResults':
      handleSemanticSearchResults(msg.messages, msg.query);
      break;
    case 'indexingError':
    case 'semanticSearchError':
      searchCount.textContent = '❌ Search failed';
      setTimeout(() => {
        if (searchCount.textContent.includes('❌ Search failed')) {
          searchCount.textContent = '';
        }
      }, 3000);
      break;
  }
});

// Agent banner
const agentBanner = document.getElementById('agentBanner');
const agentModel = document.getElementById('agentModel');
const agentStatus = document.getElementById('agentStatus');
const agentContextFill = document.getElementById('agentContextFill');
const agentContextLabel = document.getElementById('agentContextLabel');
const agentSubagentIndicator = document.getElementById('agentSubagentIndicator');
const agentSubagentCount = document.getElementById('agentSubagentCount');
const agentDetailsPanel = document.getElementById('agentDetailsPanel');
const agentDetailsContent = document.getElementById('agentDetailsContent');

// Pinned messages
const pinnedBanner = document.getElementById('pinnedBanner');
const pinnedText = document.getElementById('pinnedText');
const pinnedCount = document.getElementById('pinnedCount');
const pinnedClose = document.getElementById('pinnedClose');
let pinnedMessages = [];
let pinnedIndex = 0;

function handlePinnedMessages(msgs) {
  pinnedMessages = msgs || [];
  pinnedIndex = 0;
  if (pinnedMessages.length === 0) {
    pinnedBanner.style.display = 'none';
    return;
  }
  updatePinnedBanner();
  pinnedBanner.style.display = 'flex';
}

function updatePinnedBanner() {
  var m = pinnedMessages[pinnedIndex];
  var text = (m.text || '').replace(/\\n/g, ' ');
  if (text.length > 60) text = text.slice(0, 60) + '…';
  pinnedText.textContent = text || '(media)';
  pinnedCount.textContent = pinnedMessages.length > 1 ? (pinnedIndex + 1) + '/' + pinnedMessages.length : '';
}

pinnedBanner.addEventListener('click', function(e) {
  if (e.target === pinnedClose || e.target.closest('.pin-close')) return;
  var m = pinnedMessages[pinnedIndex];
  if (!m) return;
  // Cycle to next pinned message on next click
  if (pinnedMessages.length > 1) {
    pinnedIndex = (pinnedIndex + 1) % pinnedMessages.length;
    updatePinnedBanner();
  }
  // Scroll to the pinned message
  var el = document.querySelector('[data-msg-id="' + m.id + '"]');
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('msg-highlight');
    setTimeout(function() { el.classList.remove('msg-highlight'); }, 1500);
  }
});

pinnedClose.addEventListener('click', function(e) {
  e.stopPropagation();
  pinnedBanner.style.display = 'none';
});

let agentPanelExpanded = false;
let currentAgentInfo = null;
let currentAgentDetails = null;

function updateAgentBanner(info) {
  if (!info) {
    agentBanner.style.display = 'none';
    agentDetailsPanel.classList.remove('expanded');
    agentPanelExpanded = false;
    return;
  }
  currentAgentInfo = info;
  agentBanner.style.display = 'flex';
  var modelName = (info.model || 'unknown').replace(/^anthropic\\//, '').replace(/^openai\\//, '');
  agentModel.textContent = modelName;
  var ago = Math.round((Date.now() - info.updatedAt) / 1000);
  var agoText;
  if (ago < 60) agoText = 'just now';
  else if (ago < 3600) agoText = Math.round(ago / 60) + 'm ago';
  else agoText = Math.round(ago / 3600) + 'h ago';
  agentStatus.textContent = info.isActive ? '● active' : '○ ' + agoText;
  agentStatus.className = 'agent-status' + (info.isActive ? ' active' : '');
  var pct = info.contextPercent || 0;
  agentContextFill.style.width = pct + '%';
  agentContextFill.className = 'agent-context-fill' + (pct > 80 ? ' critical' : pct > 60 ? ' warn' : '');
  agentContextLabel.textContent = Math.round(info.totalTokens / 1000) + 'k/' + Math.round(info.contextTokens / 1000) + 'k';
}

function toggleAgentPanel() {
  agentPanelExpanded = !agentPanelExpanded;
  if (agentPanelExpanded) {
    agentDetailsPanel.classList.add('expanded');
    // Request detailed info
    vscode.postMessage({ type: 'getAgentDetails' });
  } else {
    agentDetailsPanel.classList.remove('expanded');
  }
}

function closeAgentPanel() {
  if (agentPanelExpanded) {
    agentPanelExpanded = false;
    agentDetailsPanel.classList.remove('expanded');
  }
}

agentBanner.addEventListener('click', toggleAgentPanel);

function formatChars(chars) {
  if (chars >= 1000000) return (chars / 1000000).toFixed(1) + 'M';
  if (chars >= 1000) return (chars / 1000).toFixed(1) + 'k';
  return chars.toString();
}

function formatRelativeTime(ts) {
  var ago = Math.round((Date.now() - ts) / 1000);
  if (ago < 60) return 'just now';
  if (ago < 3600) return Math.round(ago / 60) + 'm ago';
  return Math.round(ago / 3600) + 'h ago';
}

function renderAgentDetails(data) {
  if (!data) {
    agentDetailsContent.innerHTML = '<div class="sessions-empty">Failed to load details</div>';
    return;
  }
  currentAgentDetails = data;
  
  // Update sub-agent indicator in banner
  if (data.subAgents && data.subAgents.length > 0) {
    agentSubagentIndicator.style.display = 'flex';
    agentSubagentCount.textContent = data.subAgents.length + ' agent' + (data.subAgents.length > 1 ? 's' : '');
  } else {
    agentSubagentIndicator.style.display = 'none';
  }
  
  var html = '';
  
  // Context Usage section
  var totalTokens = data.totalTokens || 0;
  var contextTokens = data.contextTokens || 200000;
  var totalChars = totalTokens * 4; // rough estimate
  var maxChars = contextTokens * 4;
  
  var sysChars = data.systemPromptChars || 0;
  var projChars = data.projectContextChars || 0;
  var skillChars = data.totalSkillChars || 0;
  var toolChars = data.totalToolChars || 0;
  var convChars = data.conversationChars || 0;
  
  var sysPct = Math.min(100, (sysChars / maxChars) * 100);
  var projPct = Math.min(100 - sysPct, (projChars / maxChars) * 100);
  var skillPct = Math.min(100 - sysPct - projPct, (skillChars / maxChars) * 100);
  var toolPct = Math.min(100 - sysPct - projPct - skillPct, (toolChars / maxChars) * 100);
  var convPct = Math.min(100 - sysPct - projPct - skillPct - toolPct, (convChars / maxChars) * 100);
  
  html += '<div class="agent-details-section">';
  html += '<div class="agent-details-section-header"><span class="icon">📊</span> Context Usage</div>';
  html += '<div class="context-bar-full">';
  html += '<div class="segment system" style="width:' + sysPct + '%"></div>';
  html += '<div class="segment project" style="width:' + projPct + '%"></div>';
  html += '<div class="segment skills" style="width:' + skillPct + '%"></div>';
  html += '<div class="segment tools" style="width:' + toolPct + '%"></div>';
  html += '<div class="segment conversation" style="width:' + convPct + '%"></div>';
  html += '</div>';
  html += '<div class="context-legend">';
  html += '<div class="context-legend-item"><span class="context-legend-dot system"></span>System ' + formatChars(sysChars) + '</div>';
  html += '<div class="context-legend-item"><span class="context-legend-dot project"></span>Project ' + formatChars(projChars) + '</div>';
  html += '<div class="context-legend-item"><span class="context-legend-dot skills"></span>Skills ' + formatChars(skillChars) + '</div>';
  html += '<div class="context-legend-item"><span class="context-legend-dot tools"></span>Tools ' + formatChars(toolChars) + '</div>';
  html += '<div class="context-legend-item"><span class="context-legend-dot conversation"></span>Conversation ' + formatChars(convChars) + '</div>';
  html += '</div>';
  html += '<div class="context-total">' + Math.round(totalTokens / 1000) + 'k / ' + Math.round(contextTokens / 1000) + 'k tokens (' + data.contextPercent + '%)</div>';
  html += '</div>';
  
  // Workspace Files section
  var wsFiles = data.workspaceFiles || [];
  if (wsFiles.length > 0) {
    var standardFiles = ['AGENTS.md', 'SOUL.md', 'USER.md', 'TOOLS.md', 'MEMORY.md'];
    html += '<div class="agent-details-section">';
    html += '<div class="agent-details-section-header"><span class="icon">📁</span> Workspace Files (' + wsFiles.length + ')</div>';
    html += '<div class="workspace-files-list">';
    for (var i = 0; i < wsFiles.length; i++) {
      var f = wsFiles[i];
      var isStandard = standardFiles.indexOf(f.name) !== -1;
      html += '<div class="workspace-file-item' + (isStandard ? '' : ' custom') + '">';
      html += '<span class="workspace-file-name">' + esc(f.name);
      if (f.truncated) html += ' <span class="truncated">✂️</span>';
      html += '</span>';
      html += '<span class="workspace-file-size">' + formatChars(f.chars) + '</span>';
      html += '</div>';
    }
    html += '</div></div>';
  }
  
  // Skills section
  var skills = data.skills || [];
  if (skills.length > 0) {
    html += '<div class="agent-details-section">';
    html += '<div class="agent-details-section-header"><span class="icon">🧩</span> Skills (' + skills.length + ')</div>';
    html += '<div class="skills-list">';
    
    // Group by source
    var bundled = skills.filter(function(s) { return s.source === 'openclaw-bundled' || s.source === 'bundled'; });
    var workspace = skills.filter(function(s) { return s.source === 'openclaw-workspace' || s.source === 'workspace'; });
    var custom = skills.filter(function(s) { return s.source !== 'openclaw-bundled' && s.source !== 'bundled' && s.source !== 'openclaw-workspace' && s.source !== 'workspace'; });
    
    if (bundled.length > 0) {
      html += '<div class="skills-group-label bundled">Bundled</div>';
      html += '<div class="skills-items">';
      for (var bi = 0; bi < bundled.length; bi++) {
        html += '<span class="skill-chip">' + esc(bundled[bi].name) + '<span class="size">' + formatChars(bundled[bi].chars) + '</span></span>';
      }
      html += '</div>';
    }
    if (workspace.length > 0) {
      html += '<div class="skills-group-label workspace">Workspace</div>';
      html += '<div class="skills-items">';
      for (var wi = 0; wi < workspace.length; wi++) {
        html += '<span class="skill-chip">' + esc(workspace[wi].name) + '<span class="size">' + formatChars(workspace[wi].chars) + '</span></span>';
      }
      html += '</div>';
    }
    if (custom.length > 0) {
      html += '<div class="skills-group-label custom">Custom</div>';
      html += '<div class="skills-items">';
      for (var ci = 0; ci < custom.length; ci++) {
        html += '<span class="skill-chip">' + esc(custom[ci].name) + '<span class="size">' + formatChars(custom[ci].chars) + '</span></span>';
      }
      html += '</div>';
    }
    
    html += '<div class="skills-total">Total: ' + formatChars(data.totalSkillChars || 0) + ' chars</div>';
    html += '</div></div>';
  }
  
  // Tools section
  var tools = data.tools || [];
  if (tools.length > 0) {
    html += '<div class="agent-details-section">';
    html += '<div class="agent-details-section-header"><span class="icon">🔧</span> Tools</div>';
    html += '<div class="tools-summary">' + tools.length + ' tools available (' + formatChars(data.totalToolChars || 0) + ' chars)</div>';
    html += '<div class="tools-list">';
    for (var ti = 0; ti < tools.length; ti++) {
      html += '<span class="tool-chip">' + esc(tools[ti].name) + '</span>';
    }
    html += '</div></div>';
  }
  
  // Active Sessions section
  html += '<div class="agent-details-section">';
  html += '<div class="agent-details-section-header"><span class="icon">🤖</span> Active Sessions</div>';
  var subAgents = data.subAgents || [];
  if (subAgents.length > 0) {
    html += '<div class="sessions-list">';
    for (var si = 0; si < subAgents.length; si++) {
      var sa = subAgents[si];
      var saModel = (sa.model || 'unknown').replace(/^anthropic\\//, '').replace(/^openai\\//, '');
      var saKey = sa.sessionKey || '';
      // Shorten session key for display
      var saKeyShort = saKey.length > 40 ? saKey.slice(0, 20) + '...' + saKey.slice(-15) : saKey;
      html += '<div class="session-item">';
      html += '<div class="session-info">';
      html += '<span class="session-key" title="' + esc(saKey) + '">' + esc(saKeyShort) + '</span>';
      html += '<span class="session-model">' + esc(saModel) + '</span>';
      html += '</div>';
      html += '<div class="session-time">' + formatRelativeTime(sa.updatedAt) + '</div>';
      html += '<div class="session-status"></div>';
      html += '</div>';
    }
    html += '</div>';
  } else {
    html += '<div class="sessions-empty">No active sub-agents</div>';
  }
  html += '</div>';
  
  agentDetailsContent.innerHTML = html;
}

// Infinite scroll — load older on scroll to top, hide new msg btn at bottom
messagesList.addEventListener('scroll', () => {
  if (messagesList.scrollTop < 80 && !loadingOlder && oldestId > 0) {
    loadingOlder = true;
    vscode.postMessage({ type: 'loadOlder', beforeId: oldestId });
  }
  if (isScrolledToBottom()) {
    newMsgsBtn.style.display = 'none';
    if (newMsgCount > 0) {
      newMsgCount = 0;
      vscode.postMessage({ type: 'tabFocused' });
    }
  }
});

// Context menu for messages
let activeCtxMenu = null;
function removeCtxMenu() {
  if (activeCtxMenu) { activeCtxMenu.remove(); activeCtxMenu = null; }
}
document.addEventListener('click', removeCtxMenu);
document.addEventListener('contextmenu', (e) => {
  removeCtxMenu();
  const msgEl = e.target.closest('.msg[data-msg-id]');
  if (!msgEl) return;
  e.preventDefault();
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';
  const isOutgoing = msgEl.dataset.outgoing === '1';
  const msgTimestamp = parseInt(msgEl.dataset.timestamp || '0') * 1000;
  const canDeleteForEveryone = isOutgoing && (Date.now() - msgTimestamp) < 48 * 60 * 60 * 1000;
  const hasText = !!(msgEl.dataset.text);
  let menuHtml =
    '<div class="ctx-menu-item" data-action="reply">↩️ Reply</div>' +
    '<div class="ctx-menu-item" data-action="copy">📋 Copy text</div>';
  if (isOutgoing && hasText) {
    menuHtml += '<div class="ctx-menu-item" data-action="edit">✏️ Edit message</div>';
  }
  menuHtml +=
    '<div class="ctx-menu-sep"></div>' +
    '<div class="ctx-menu-item danger" data-action="deleteForMe">🗑 Delete for me</div>';
  if (canDeleteForEveryone) {
    menuHtml += '<div class="ctx-menu-item danger" data-action="deleteForAll">🗑 Delete for everyone</div>';
  }
  menuHtml += '<div class="ctx-menu-sep"></div>' +
    '<div class="ctx-menu-item" data-action="exportChat">📥 Export chat</div>';
  menu.innerHTML = menuHtml;
  menu.querySelectorAll('.ctx-menu-item').forEach(item => {
    item.addEventListener('click', () => {
      const action = item.dataset.action;
      const msgId = parseInt(msgEl.dataset.msgId);
      if (action === 'reply') {
        setReply(msgId, msgEl.dataset.sender, msgEl.dataset.text);
      } else if (action === 'copy') {
        navigator.clipboard.writeText(msgEl.dataset.text || '');
      } else if (action === 'edit') {
        // Find the full message text from allMessages (data-text is truncated to 100 chars)
        var fullMsg = allMessages.find(function(m) { return m.id === msgId; });
        setEdit(msgId, fullMsg ? fullMsg.text : msgEl.dataset.text);
      } else if (action === 'deleteForMe') {
        vscode.postMessage({ type: 'deleteMessage', messageIds: [msgId], revoke: false });
      } else if (action === 'deleteForAll') {
        vscode.postMessage({ type: 'deleteMessage', messageIds: [msgId], revoke: true });
      } else if (action === 'exportChat') {
        showExportMenu();
      }
      removeCtxMenu();
    });
  });
  document.body.appendChild(menu);
  activeCtxMenu = menu;
});

function copyCodeBlock(btn) {
  var wrapper = btn.closest('.code-block-wrapper');
  if (!wrapper) return;
  var pre = wrapper.querySelector('pre');
  if (!pre) return;
  var code = pre.textContent || '';
  navigator.clipboard.writeText(code).then(function() {
    btn.textContent = '✅';
    btn.classList.add('copied');
    setTimeout(function() {
      btn.textContent = '📋';
      btn.classList.remove('copied');
    }, 2000);
  });
}

function toggleLineNumbers(btn) {
  var wrapper = btn.closest('.code-block-wrapper');
  if (!wrapper) return;
  var pre = wrapper.querySelector('pre');
  if (!pre) return;
  var code = pre.querySelector('code');
  if (!code) return;
  var existing = code.querySelector('.code-line-numbered');
  if (existing) {
    // Remove line numbers - restore original
    code.textContent = existing.textContent;
    btn.classList.remove('active');
    try { localStorage.setItem('oceangram-line-numbers', 'off'); } catch(e){}
  } else {
    // Add line numbers
    var text = code.textContent || '';
    var lines = text.split('\\n');
    if (lines[lines.length - 1] === '') lines.pop();
    var container = document.createElement('div');
    container.className = 'code-line-numbered';
    lines.forEach(function(line, idx) {
      var row = document.createElement('div');
      row.className = 'code-line';
      var num = document.createElement('span');
      num.className = 'code-line-num';
      num.textContent = String(idx + 1);
      var content = document.createElement('span');
      content.className = 'code-line-content';
      content.textContent = line;
      row.appendChild(num);
      row.appendChild(content);
      container.appendChild(row);
    });
    code.textContent = '';
    code.appendChild(container);
    btn.classList.add('active');
    try { localStorage.setItem('oceangram-line-numbers', 'on'); } catch(e){}
  }
}

/* Voice player */
var _voiceAudios = {};
var _voiceCurrentId = null;

function _getVoicePlayer(btn) {
  return btn.closest('.voice-player');
}

function toggleVoice(btn) {
  var player = _getVoicePlayer(btn);
  if (!player) return;
  var src = player.getAttribute('data-src');
  if (!src) return;

  // Create or get audio element
  var id = src.substring(0, 60); // use as key
  if (!_voiceAudios[id]) {
    var audio = new Audio(src);
    audio._player = player;
    audio._btn = btn;
    audio.addEventListener('timeupdate', function() { _updateVoiceProgress(audio); });
    audio.addEventListener('ended', function() {
      btn.textContent = '▶';
      _voiceCurrentId = null;
      _resetVoiceBars(player);
    });
    _voiceAudios[id] = audio;
  }
  var audio = _voiceAudios[id];

  // Stop any other playing voice
  if (_voiceCurrentId && _voiceCurrentId !== id && _voiceAudios[_voiceCurrentId]) {
    _voiceAudios[_voiceCurrentId].pause();
    _voiceAudios[_voiceCurrentId]._btn.textContent = '▶';
    _resetVoiceBars(_voiceAudios[_voiceCurrentId]._player);
  }

  if (audio.paused) {
    audio.play();
    btn.textContent = '⏸';
    _voiceCurrentId = id;
  } else {
    audio.pause();
    btn.textContent = '▶';
    _voiceCurrentId = null;
  }
}

function _updateVoiceProgress(audio) {
  var player = audio._player;
  if (!player || !audio.duration) return;
  var pct = audio.currentTime / audio.duration;
  var bars = player.querySelectorAll('.vw-bar');
  var playedCount = Math.floor(pct * bars.length);
  for (var i = 0; i < bars.length; i++) {
    if (i < playedCount) bars[i].classList.add('vw-played');
    else bars[i].classList.remove('vw-played');
  }
  var t = Math.floor(audio.currentTime);
  var timeEl = player.querySelector('.voice-time');
  if (timeEl) timeEl.textContent = Math.floor(t / 60) + ':' + ('0' + (t % 60)).slice(-2);
}

function _resetVoiceBars(player) {
  var bars = player.querySelectorAll('.vw-bar');
  for (var i = 0; i < bars.length; i++) bars[i].classList.remove('vw-played');
  var dur = parseInt(player.getAttribute('data-duration') || '0');
  var timeEl = player.querySelector('.voice-time');
  if (timeEl) timeEl.textContent = Math.floor(dur / 60) + ':' + ('0' + (dur % 60)).slice(-2);
}

function scrubVoice(event, waveformEl) {
  var player = waveformEl.closest('.voice-player');
  if (!player) return;
  var src = player.getAttribute('data-src');
  if (!src) return;
  var id = src.substring(0, 60);
  var audio = _voiceAudios[id];
  if (!audio || !audio.duration) return;
  var rect = waveformEl.getBoundingClientRect();
  var pct = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  audio.currentTime = pct * audio.duration;
}

function cycleVoiceSpeed(btn) {
  var player = btn.closest('.voice-player');
  if (!player) return;
  var src = player.getAttribute('data-src');
  if (!src) return;
  var id = src.substring(0, 60);
  var audio = _voiceAudios[id];
  var speeds = [1, 1.5, 2];
  var labels = ['1×', '1.5×', '2×'];
  var current = speeds.indexOf(audio ? audio.playbackRate : 1);
  var next = (current + 1) % speeds.length;
  if (audio) audio.playbackRate = speeds[next];
  btn.textContent = labels[next];
}

function playVideo(container) {
  var msgId = container.dataset.msgId;
  if (!msgId) return;
  // If already has a video element, toggle play/pause
  var existingVideo = container.querySelector('video');
  if (existingVideo) {
    if (existingVideo.paused) existingVideo.play();
    else existingVideo.pause();
    return;
  }
  // Show loading indicator
  var playBtn = container.querySelector('.msg-video-play');
  if (playBtn) playBtn.style.display = 'none';
  var loader = document.createElement('div');
  loader.className = 'msg-video-loading';
  loader.textContent = 'Loading…';
  container.appendChild(loader);
  // Request video download from extension
  vscode.postMessage({ type: 'downloadVideo', messageId: parseInt(msgId) });
  // Store container ref for callback
  if (!window._videoPending) window._videoPending = {};
  window._videoPending[msgId] = container;
}

function showLightbox(src) {
  var overlay = document.createElement('div');
  overlay.className = 'lightbox-overlay';
  overlay.innerHTML = '<img src="' + src + '" />';
  overlay.addEventListener('click', function() { overlay.remove(); });
  document.body.appendChild(overlay);
}

function retryMessage(tempId) {
  var idx = allMessages.findIndex(function(m) { return m.id === tempId; });
  if (idx === -1) return;
  var m = allMessages[idx];
  m._optimistic = 'sending';
  pendingOptimistic.set(tempId, { text: m.text, timestamp: m.timestamp });
  renderMessages(allMessages);
  var payload = { type: 'sendMessage', text: m.text, tempId: tempId };
  if (m.replyToId) payload.replyToId = m.replyToId;
  vscode.postMessage(payload);
}

// Real-time polling for new messages
let pollInterval;
let lastMsgId = 0;
const POLL_FOCUSED = 2000;
const POLL_HIDDEN = 4000;
function startPolling() {
  stopPolling();
  var interval = document.hidden ? POLL_HIDDEN : POLL_FOCUSED;
  pollInterval = setInterval(() => {
    vscode.postMessage({ type: 'poll', afterId: lastMsgId });
  }, interval);
}
function stopPolling() {
  if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
}
document.addEventListener('visibilitychange', () => {
  startPolling(); // restart with appropriate interval
});

// User profile popup
let activeProfilePopup = null;
let activeProfileOverlay = null;
const profileColors = ['#e17076','#eda86c','#a695e7','#7bc862','#6ec9cb','#65aadd','#ee7aae','#6bb2f2'];
function pickProfileColor(id) { return profileColors[Math.abs(parseInt(id || '0', 10)) % profileColors.length]; }

function closeProfilePopup() {
  if (activeProfileOverlay) { activeProfileOverlay.remove(); activeProfileOverlay = null; }
  if (activeProfilePopup) { activeProfilePopup.remove(); activeProfilePopup = null; }
}

function showUserProfile(el, userId) {
  if (!userId) return;
  closeProfilePopup();

  var rect = el.getBoundingClientRect();

  var overlay = document.createElement('div');
  overlay.className = 'user-profile-overlay';
  overlay.addEventListener('click', closeProfilePopup);
  document.body.appendChild(overlay);
  activeProfileOverlay = overlay;

  var popup = document.createElement('div');
  popup.className = 'user-profile-popup';
  popup.innerHTML = '<div class="profile-loading">Loading…</div>';

  var top = rect.bottom + 6;
  var left = rect.left;
  if (top + 300 > window.innerHeight) top = rect.top - 306;
  if (left + 280 > window.innerWidth) left = window.innerWidth - 290;
  if (left < 10) left = 10;
  popup.style.top = top + 'px';
  popup.style.left = left + 'px';

  document.body.appendChild(popup);
  activeProfilePopup = popup;

  vscode.postMessage({ type: 'getUserInfo', userId: userId });
}

document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape' && activeProfilePopup) { closeProfilePopup(); }
});

// Handle userInfo responses in the existing message handler
var origOnMessage = window.onmessage;
window.addEventListener('message', function(event) {
  var msg = event.data;
  if (msg.type === 'userInfo' && activeProfilePopup) {
    var info = msg.info;
    var html = '';
    if (info.photo) {
      html += '<img class="profile-avatar" src="' + info.photo + '" />';
    } else {
      var initials = info.name.split(' ').map(function(w) { return w[0]; }).filter(Boolean).slice(0, 2).join('').toUpperCase();
      html += '<div class="profile-avatar-placeholder" style="background:' + pickProfileColor(info.id) + '">' + esc(initials) + '</div>';
    }
    html += '<div class="profile-name">' + esc(info.name) + '</div>';
    if (info.username) html += '<div class="profile-username">@' + esc(info.username) + '</div>';
    if (info.lastSeen) {
      var isOnline = info.lastSeen === 'online';
      html += '<div class="profile-status' + (isOnline ? ' online' : '') + '">' + esc(info.lastSeen) + '</div>';
    }
    if (info.bio) html += '<div class="profile-bio">' + esc(info.bio) + '</div>';
    if (info.phone) html += '<div class="profile-detail">📱 +' + esc(info.phone) + '</div>';
    html += '<div class="profile-detail">ID: ' + esc(info.id) + '</div>';
    if (info.isBot) html += '<div class="profile-detail">🤖 Bot</div>';
    html += '<div class="profile-actions">';
    html += '<button class="profile-action-btn" onclick="profileSendMessage(\'' + esc(info.id) + '\', \'' + esc(info.name) + '\')">💬 Message</button>';
    if (info.username) html += '<button class="profile-action-btn" onclick="profileCopyUsername(\'' + esc(info.username) + '\')">📋 @' + esc(info.username) + '</button>';
    html += '</div>';
    activeProfilePopup.innerHTML = html;
  } else if (msg.type === 'userInfoError' && activeProfilePopup) {
    activeProfilePopup.innerHTML = '<div class="profile-loading">Failed to load profile</div>';
  }
});

// --- Search (Ctrl+F) ---
var searchBar = document.getElementById('searchBar');
var searchInput = document.getElementById('searchInput');
var searchCount = document.getElementById('searchCount');
var searchMatches = [];
var searchIdx = -1;

function openSearch() {
  searchBar.classList.add('visible');
  searchInput.focus();
  searchInput.select();
}
function closeSearch() {
  searchBar.classList.remove('visible');
  searchInput.value = '';
  clearSearchHighlights();
  searchMatches = [];
  searchIdx = -1;
  searchCount.textContent = '';
}
function clearSearchHighlights() {
  document.querySelectorAll('.msg-bubble.search-highlight, .msg-bubble.search-current').forEach(function(el) {
    el.classList.remove('search-highlight', 'search-current');
  });
}
function doLocalSearch() {
  var q = (searchInput.value || '').toLowerCase().trim();
  clearSearchHighlights();
  searchMatches = [];
  searchIdx = -1;
  if (!q) { searchCount.textContent = ''; return; }
  var bubbles = document.querySelectorAll('.msg-bubble');
  bubbles.forEach(function(b) {
    if ((b.textContent || '').toLowerCase().indexOf(q) !== -1) {
      b.classList.add('search-highlight');
      searchMatches.push(b);
    }
  });
  if (searchMatches.length > 0) {
    searchIdx = searchMatches.length - 1;
    navigateSearch(0);
  }
  searchCount.textContent = searchMatches.length > 0 ? (searchIdx + 1) + ' / ' + searchMatches.length : 'No results';
}
function navigateSearch(delta) {
  if (searchMatches.length === 0) return;
  if (searchIdx >= 0 && searchIdx < searchMatches.length) {
    searchMatches[searchIdx].classList.remove('search-current');
    searchMatches[searchIdx].classList.add('search-highlight');
  }
  searchIdx = (searchIdx + delta + searchMatches.length) % searchMatches.length;
  searchMatches[searchIdx].classList.remove('search-highlight');
  searchMatches[searchIdx].classList.add('search-current');
  searchMatches[searchIdx].scrollIntoView({ behavior: 'smooth', block: 'center' });
  searchCount.textContent = (searchIdx + 1) + ' / ' + searchMatches.length;
}

// TASK-035: Semantic Search Variables
var semanticToggle = document.getElementById('semanticToggle');
var isSemanticSearchAvailable = false;
var semanticSearchResults = [];

// Check if semantic search is available
function checkSemanticSearchAvailability() {
  vscode.postMessage({ type: 'getSearchIndexStats' });
}

// Manually index messages for semantic search
function indexMessagesManually() {
  if (isSemanticSearchAvailable) return;
  
  semanticToggle.parentElement.innerHTML = '<span class="search-toggle-text">🧠 Indexing...</span>';
  vscode.postMessage({ 
    type: 'indexMessagesForSearch',
    limit: 1000 
  });
}

// Perform semantic search
function doSemanticSearch(query) {
  if (!query || query.trim().length < 2) {
    searchCount.textContent = '';
    return;
  }
  
  searchCount.textContent = 'Searching...';
  vscode.postMessage({ 
    type: 'searchSemantic', 
    query: query,
    limit: 50 
  });
}

// Handle search input with debouncing
var searchDebounce;
searchInput.addEventListener('input', function() {
  clearTimeout(searchDebounce);
  var query = searchInput.value.trim();
  
  if (semanticToggle.checked && isSemanticSearchAvailable) {
    searchDebounce = setTimeout(function() { doSemanticSearch(query); }, 300);
  } else {
    searchDebounce = setTimeout(doLocalSearch, 150);
  }
});

// Toggle between semantic and keyword search
semanticToggle.addEventListener('change', function() {
  var query = searchInput.value.trim();
  if (query) {
    if (semanticToggle.checked && isSemanticSearchAvailable) {
      doSemanticSearch(query);
    } else {
      doLocalSearch();
    }
  }
});

searchInput.addEventListener('keydown', function(e) {
  if (e.key === 'Enter') { e.preventDefault(); navigateSearch(e.shiftKey ? -1 : 1); }
  if (e.key === 'Escape') { e.preventDefault(); closeSearch(); }
});
document.getElementById('searchUp').addEventListener('click', function() { navigateSearch(-1); });
document.getElementById('searchDown').addEventListener('click', function() { navigateSearch(1); });
document.getElementById('searchClose').addEventListener('click', closeSearch);

// TASK-035: Handle semantic search results
function handleSemanticSearchResults(messages, query) {
  clearSearchHighlights();
  searchMatches = [];
  searchIdx = -1;
  
  if (!messages || messages.length === 0) {
    searchCount.textContent = 'No results';
    return;
  }
  
  // Create virtual search highlights for semantic results
  for (var i = 0; i < messages.length; i++) {
    var msg = messages[i];
    var msgEl = document.querySelector('.msg[data-msg-id="' + msg.id + '"]');
    
    if (msgEl) {
      var bubble = msgEl.querySelector('.msg-bubble');
      if (bubble) {
        bubble.classList.add('search-highlight', 'semantic-result');
        
        // Add semantic score indicator
        var scoreEl = bubble.querySelector('.semantic-score');
        if (scoreEl) scoreEl.remove();
        
        if (msg.semanticScore) {
          var scoreIndicator = document.createElement('div');
          scoreIndicator.className = 'semantic-score';
          scoreIndicator.textContent = `${Math.round(msg.semanticScore * 100)}% match`;
          scoreIndicator.title = `Semantic relevance: ${msg.semanticScore.toFixed(3)}`;
          bubble.appendChild(scoreIndicator);
        }
        
        searchMatches.push(bubble);
      }
    }
  }
  
  if (searchMatches.length > 0) {
    searchIdx = 0;
    searchMatches[0].classList.add('search-current');
    searchMatches[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  
  searchCount.textContent = searchMatches.length + ' semantic match' + (searchMatches.length === 1 ? '' : 'es');
}

document.addEventListener('keydown', function(e) {
  if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
    e.preventDefault();
    openSearch();
  }
  if (e.key === 'Escape') {
    if (searchBar.classList.contains('visible')) {
      closeSearch();
    } else if (agentPanelExpanded) {
      closeAgentPanel();
    }
  }
});

// Floating date header on scroll
var floatingDate = document.getElementById('floatingDate');
var floatingDateSpan = floatingDate.querySelector('span');
var floatingDateTimeout = null;

function updateFloatingDate() {
  var separators = messagesList.querySelectorAll('.date-separator');
  if (separators.length === 0) { floatingDate.classList.add('hidden'); return; }

  var containerTop = messagesList.getBoundingClientRect().top;
  var bestSep = null;
  var bestSepRect = null;

  for (var i = 0; i < separators.length; i++) {
    var rect = separators[i].getBoundingClientRect();
    if (rect.top <= containerTop + 40) {
      bestSep = separators[i];
      bestSepRect = rect;
    }
  }

  if (!bestSep) {
    floatingDate.classList.add('hidden');
    return;
  }

  // Hide if the real separator is visible near the top to avoid doubling
  if (bestSepRect && bestSepRect.top > containerTop - 5 && bestSepRect.bottom < containerTop + 50) {
    floatingDate.classList.add('hidden');
    return;
  }

  var dateText = bestSep.querySelector('span').textContent;
  floatingDateSpan.textContent = dateText;
  floatingDate.classList.remove('hidden');

  clearTimeout(floatingDateTimeout);
  floatingDateTimeout = setTimeout(function() {
    floatingDate.classList.add('hidden');
  }, 2000);
}

var floatingDateRaf = false;
messagesList.addEventListener('scroll', function() {
  if (!floatingDateRaf) {
    floatingDateRaf = true;
    requestAnimationFrame(function() {
      floatingDateRaf = false;
      updateFloatingDate();
    });
  }
}, { passive: true });

// --- Typing indicators ---
var typingIndicator = document.getElementById('typingIndicator');
var typingUsers = {}; // userId -> { name, timeout }

function updateTypingDisplay() {
  var names = Object.values(typingUsers).map(function(u) { return u.name; });
  if (names.length === 0) {
    typingIndicator.classList.remove('visible');
    return;
  }
  var text = names.length === 1
    ? names[0] + ' is typing'
    : names.slice(0, 2).join(' and ') + (names.length > 2 ? ' and others' : '') + ' are typing';
  typingIndicator.innerHTML = esc(text) + ' <span class="typing-dots"><span>.</span><span>.</span><span>.</span></span>';
  typingIndicator.classList.add('visible');
}

// --- User Status (online/offline) ---
function formatLastSeen(status) {
  if (!status) return '';
  if (status.online) return 'online';
  if (status.lastSeen) {
    var now = Math.floor(Date.now() / 1000);
    var diff = now - status.lastSeen;
    if (diff < 60) return 'last seen just now';
    if (diff < 3600) return 'last seen ' + Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return 'last seen ' + Math.floor(diff / 3600) + 'h ago';
    var d = new Date(status.lastSeen * 1000);
    return 'last seen ' + d.toLocaleDateString();
  }
  if (status.approximate === 'recently') return 'last seen recently';
  if (status.approximate === 'lastWeek') return 'last seen within a week';
  if (status.approximate === 'lastMonth') return 'last seen within a month';
  if (status.hidden) return '';
  return '';
}

function updateUserStatus(userId, status) {
  var headerStatus = document.getElementById('chatHeaderStatus');
  if (!headerStatus) return;
  var text = formatLastSeen(status);
  if (!text) {
    headerStatus.innerHTML = '';
    return;
  }
  var dotClass = status.online ? 'online' : 'offline';
  headerStatus.innerHTML = '<span class="status-dot ' + dotClass + '"></span>' + esc(text);
}

function handleTypingEvent(userId, userName) {
  if (typingUsers[userId]) clearTimeout(typingUsers[userId].timeout);
  typingUsers[userId] = {
    name: userName,
    timeout: setTimeout(function() {
      delete typingUsers[userId];
      updateTypingDisplay();
    }, 6000)
  };
  updateTypingDisplay();
}

// Debounced sendTyping on keydown in composer (max once per 5s)
var lastTypingSent = 0;
msgInput.addEventListener('keydown', function(e) {
  if (e.key === 'Enter' || e.key === 'Escape' || e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') return;
  var now = Date.now();
  if (now - lastTypingSent > 5000) {
    lastTypingSent = now;
    vscode.postMessage({ type: 'sendTyping' });
  }
});

// --- Drag & Drop file sending ---
var dropOverlay = document.getElementById('dropZoneOverlay');
var filePreviewBar = document.getElementById('filePreviewBar');
var filePreviewItems = document.getElementById('filePreviewItems');
var filePreviewCancel = document.getElementById('filePreviewCancel');
var filePreviewSend = document.getElementById('filePreviewSend');
var pendingFiles = [];

var dragCounter = 0;
document.addEventListener('dragenter', function(e) {
  e.preventDefault();
  dragCounter++;
  if (e.dataTransfer && e.dataTransfer.types.indexOf('Files') !== -1) {
    dropOverlay.classList.add('active');
  }
});
document.addEventListener('dragleave', function(e) {
  e.preventDefault();
  dragCounter--;
  if (dragCounter <= 0) {
    dragCounter = 0;
    dropOverlay.classList.remove('active');
  }
});
document.addEventListener('dragover', function(e) {
  e.preventDefault();
});
document.addEventListener('drop', function(e) {
  e.preventDefault();
  dragCounter = 0;
  dropOverlay.classList.remove('active');
  if (!e.dataTransfer) return;

  // Check for VS Code explorer file URIs (text/uri-list)
  var uriList = e.dataTransfer.getData('text/uri-list');
  if (uriList) {
    var uris = uriList.split('\n').map(function(u) { return u.trim(); }).filter(function(u) {
      return u && !u.startsWith('#') && u.startsWith('file://');
    });
    if (uris.length > 0) {
      uris.forEach(function(uri) {
        // Decode file URI to path
        var filePath;
        try {
          filePath = decodeURIComponent(uri.replace(/^file:\/\//, ''));
        } catch(ex) {
          filePath = uri.replace(/^file:\/\//, '');
        }
        // On Windows, strip leading / from /C:/path
        if (/^\/[a-zA-Z]:/.test(filePath)) filePath = filePath.slice(1);
        var fileName = filePath.split('/').pop() || filePath.split('\\').pop() || 'file';
        pendingFiles.push({
          name: fileName,
          size: 0,
          type: guessFileType(fileName),
          dataUrl: '',
          base64: '',
          filePath: filePath
        });
      });
      renderFilePreview();
      return;
    }
  }

  // Standard browser file drop
  if (e.dataTransfer.files.length > 0) {
    handleDroppedFiles(e.dataTransfer.files);
  }
});

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024*1024) return (bytes/1024).toFixed(1) + ' KB';
  return (bytes/(1024*1024)).toFixed(1) + ' MB';
}

function guessFileType(name) {
  var ext = (name || '').split('.').pop().toLowerCase();
  var map = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
    webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp',
    mp4: 'video/mp4', mov: 'video/quicktime', avi: 'video/x-msvideo', webm: 'video/webm',
    mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac',
    pdf: 'application/pdf', zip: 'application/zip', json: 'application/json',
    js: 'text/javascript', ts: 'text/typescript', py: 'text/x-python',
    md: 'text/markdown', txt: 'text/plain', html: 'text/html', css: 'text/css',
    xml: 'text/xml', csv: 'text/csv', yaml: 'text/yaml', yml: 'text/yaml',
  };
  return map[ext] || 'application/octet-stream';
}

function handleDroppedFiles(fileList) {
  for (var i = 0; i < fileList.length; i++) {
    (function(file) {
      var reader = new FileReader();
      reader.onload = function(ev) {
        var dataUrl = ev.target.result;
        var base64 = dataUrl.split(',')[1];
        pendingFiles.push({
          name: file.name,
          size: file.size,
          type: file.type || 'application/octet-stream',
          dataUrl: dataUrl,
          base64: base64
        });
        renderFilePreview();
      };
      reader.readAsDataURL(file);
    })(fileList[i]);
  }
}

function renderFilePreview() {
  if (pendingFiles.length === 0) {
    filePreviewBar.style.display = 'none';
    return;
  }
  filePreviewBar.style.display = 'flex';
  filePreviewItems.innerHTML = '';
  pendingFiles.forEach(function(f, idx) {
    var item = document.createElement('div');
    item.className = 'file-preview-item';
    var isImage = f.type.startsWith('image/');
    if (isImage && f.dataUrl) {
      item.innerHTML = '<img src="' + f.dataUrl + '" alt="" />';
    } else {
      var icon = getFileIcon(f.name, f.type);
      item.innerHTML = '<span class="file-icon">' + icon + '</span>';
    }
    var sizeStr = f.size ? formatFileSize(f.size) : '';
    item.innerHTML += '<span class="file-name">' + esc(f.name) + '</span>'
      + (sizeStr ? '<span class="file-size">' + sizeStr + '</span>' : '')
      + '<button class="file-remove" data-idx="' + idx + '">✕</button>';
    filePreviewItems.appendChild(item);
  });
  filePreviewItems.querySelectorAll('.file-remove').forEach(function(btn) {
    btn.addEventListener('click', function() {
      pendingFiles.splice(parseInt(btn.dataset.idx), 1);
      renderFilePreview();
    });
  });
}

filePreviewCancel.addEventListener('click', function() {
  pendingFiles = [];
  renderFilePreview();
});

filePreviewSend.addEventListener('click', function() {
  if (pendingFiles.length === 0) return;
  pendingFiles.forEach(function(f) {
    var tempId = 'file_' + Date.now() + '_' + Math.random().toString(36).slice(2);
    if (f.filePath) {
      // File from VS Code explorer — send path, extension host will read it
      vscode.postMessage({
        type: 'sendLocalFile',
        tempId: tempId,
        filePath: f.filePath,
        fileName: f.name,
        mimeType: f.type,
        caption: ''
      });
    } else {
      // File from browser drag/paste — send base64 data
      vscode.postMessage({
        type: 'sendFile',
        tempId: tempId,
        fileName: f.name,
        mimeType: f.type,
        data: f.base64,
        caption: ''
      });
    }
  });
  pendingFiles = [];
  renderFilePreview();
});

// ── Chat Info Panel ──
var chatInfoPanel = document.getElementById('chatInfoPanel');
var chatInfoOverlay = document.getElementById('chatInfoOverlay');
var infoPanelContent = document.getElementById('infoPanelContent');
var infoPanelOpen = false;
var chatInfoData = null;
var chatMembersData = null;
var sharedMediaData = { photo: null, video: null, file: null, link: null };
var currentMediaTab = 'photo';

function showExportMenu() {
  // Remove any existing export menu
  var existing = document.querySelector('.export-menu');
  if (existing) { existing.remove(); return; }
  var menu = document.createElement('div');
  menu.className = 'ctx-menu export-menu';
  var headerBar = document.getElementById('chatHeaderBar');
  var rect = headerBar.getBoundingClientRect();
  menu.style.right = '60px';
  menu.style.top = (rect.bottom + 4) + 'px';
  menu.style.left = 'auto';
  menu.innerHTML =
    '<div class="ctx-menu-item" data-action="md">📝 Export as Markdown</div>' +
    '<div class="ctx-menu-item" data-action="json">📋 Export as JSON</div>';
  menu.querySelectorAll('.ctx-menu-item').forEach(function(item) {
    item.addEventListener('click', function() {
      var format = item.dataset.action;
      vscode.postMessage({ type: 'exportChat', format: format, messages: allMessages });
      menu.remove();
    });
  });
  document.body.appendChild(menu);
  setTimeout(function() {
    document.addEventListener('click', function handler() {
      menu.remove();
      document.removeEventListener('click', handler);
    }, { once: true });
  }, 0);
}

function openInfoPanel() {
  infoPanelOpen = true;
  chatInfoPanel.classList.add('open');
  chatInfoOverlay.classList.add('open');
  if (!chatInfoData) {
    vscode.postMessage({ type: 'getChatInfo' });
  }
}

function closeInfoPanel() {
  infoPanelOpen = false;
  chatInfoPanel.classList.remove('open');
  chatInfoOverlay.classList.remove('open');
}

function renderInfoPanel() {
  if (!chatInfoData) {
    infoPanelContent.innerHTML = '<div class="info-loading">Loading...</div>';
    return;
  }
  var html = '';
  var avatarColor = avatarColors[Math.abs(Date.now()) % avatarColors.length];
  var initials = (chatInfoData.title || '?').split(' ').map(function(w) { return w[0]; }).join('').slice(0, 2).toUpperCase();
  var avatarHtml = chatInfoData.photo
    ? '<img src="' + chatInfoData.photo + '" alt="" />'
    : '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:' + avatarColor + ';border-radius:50%">' + esc(initials) + '</div>';
  var verifiedBadge = chatInfoData.isVerified ? '<span class="verified">✓</span>' : '';
  var metaText = chatInfoData.type === 'channel' ? ((chatInfoData.memberCount || 0) + ' subscribers')
    : chatInfoData.type === 'group' ? ((chatInfoData.memberCount || 0) + ' members')
    : 'Private chat';

  html += '<div class="info-profile">';
  html += '<div class="info-avatar">' + avatarHtml + '</div>';
  html += '<div class="info-name">' + esc(chatInfoData.title) + verifiedBadge + '</div>';
  if (chatInfoData.username) html += '<div class="info-username">@' + esc(chatInfoData.username) + '</div>';
  html += '<div class="info-meta">' + esc(metaText) + '</div>';
  if (chatInfoData.description) html += '<div class="info-description">' + esc(chatInfoData.description) + '</div>';
  html += '</div>';

  // Members section (for groups)
  if (chatInfoData.type === 'group') {
    html += '<div class="info-section">';
    html += '<div class="info-section-header"><span class="info-section-title">Members</span>';
    if (chatMembersData) html += '<span class="info-section-count">' + chatMembersData.length + '</span>';
    html += '</div><div class="info-members-list" id="infoMembersList">';
    if (chatMembersData && chatMembersData.length > 0) {
      chatMembersData.forEach(function(m) {
        var mColor = avatarColors[Math.abs(parseInt(m.id || '0', 10)) % avatarColors.length];
        var mInit = (m.name || '?').split(' ').map(function(w) { return w ? w[0] : ''; }).join('').slice(0, 2).toUpperCase();
        var mAvatar = m.photo
          ? '<img src="' + m.photo + '" alt="" />'
          : '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:' + mColor + ';border-radius:50%;font-size:14px">' + esc(mInit) + '</div>';
        var roleHtml = m.isOwner ? '<span class="role">Owner</span>' : m.isAdmin ? '<span class="role">Admin</span>' : '';
        var statusText = m.status === 'online' ? 'online' : m.status === 'recently' ? 'recently' : '';
        var statusClass = m.status === 'online' ? ' online' : '';
        html += '<div class="info-member-item" data-id="' + esc(m.id) + '">';
        html += '<div class="info-member-avatar">' + mAvatar + '</div>';
        html += '<div class="info-member-info">';
        html += '<div class="info-member-name">' + esc(m.name) + roleHtml + '</div>';
        if (statusText) html += '<div class="info-member-status' + statusClass + '">' + statusText + '</div>';
        else if (m.username) html += '<div class="info-member-status">@' + esc(m.username) + '</div>';
        html += '</div></div>';
      });
    } else if (chatMembersData === null) {
      html += '<div class="info-loading">Loading members...</div>';
    } else {
      html += '<div class="info-media-empty">No members found</div>';
    }
    html += '</div></div>';
    if (chatMembersData === null) vscode.postMessage({ type: 'getChatMembers', limit: 50 });
  }

  // Shared media section
  html += '<div class="info-section">';
  html += '<div class="info-section-header"><span class="info-section-title">Shared Media</span></div>';
  html += '<div class="info-media-tabs">';
  html += '<button class="info-media-tab' + (currentMediaTab === 'photo' ? ' active' : '') + '" onclick="switchMediaTab(\\'photo\\')">📷</button>';
  html += '<button class="info-media-tab' + (currentMediaTab === 'video' ? ' active' : '') + '" onclick="switchMediaTab(\\'video\\')">🎬</button>';
  html += '<button class="info-media-tab' + (currentMediaTab === 'file' ? ' active' : '') + '" onclick="switchMediaTab(\\'file\\')">📄</button>';
  html += '<button class="info-media-tab' + (currentMediaTab === 'link' ? ' active' : '') + '" onclick="switchMediaTab(\\'link\\')">🔗</button>';
  html += '</div><div id="infoMediaContent">' + renderMediaContent(currentMediaTab) + '</div></div>';
  infoPanelContent.innerHTML = html;
}

function renderMediaContent(mediaType) {
  var items = sharedMediaData[mediaType];
  if (items === null) {
    vscode.postMessage({ type: 'getSharedMedia', mediaType: mediaType, limit: 20 });
    return '<div class="info-loading">Loading...</div>';
  }
  if (!items || items.length === 0) return '<div class="info-media-empty">No ' + mediaType + 's shared</div>';

  if (mediaType === 'photo' || mediaType === 'video') {
    var h = '<div class="info-media-grid">';
    items.forEach(function(item) {
      var icon = mediaType === 'video' ? '🎬' : '🖼️';
      h += item.thumbnailUrl
        ? '<div class="info-media-item" onclick="scrollToMessage(' + item.messageId + ')"><img src="' + item.thumbnailUrl + '" alt="" /></div>'
        : '<div class="info-media-item" onclick="scrollToMessage(' + item.messageId + ')"><span class="media-icon">' + icon + '</span></div>';
    });
    return h + '</div>';
  }
  if (mediaType === 'link') {
    var h = '<div class="info-links-list">';
    items.forEach(function(item) {
      h += '<div class="info-link-item"><span class="info-link-icon">🔗</span><div class="info-link-content">';
      h += '<div class="info-link-title">' + esc(item.title || item.url || 'Link') + '</div>';
      if (item.url) h += '<div class="info-link-url">' + esc(item.url) + '</div>';
      h += '</div></div>';
    });
    return h + '</div>';
  }
  if (mediaType === 'file') {
    var h = '<div class="info-files-list">';
    items.forEach(function(item) {
      var icon = getFileIcon(item.fileName || 'file', '');
      var size = item.fileSize ? formatFileSize(item.fileSize) : '';
      h += '<div class="info-file-item" onclick="downloadFile(' + item.messageId + ')">';
      h += '<span class="info-file-icon">' + icon + '</span><div class="info-file-info">';
      h += '<div class="info-file-name">' + esc(item.fileName || 'File') + '</div>';
      if (size) h += '<div class="info-file-meta">' + size + '</div>';
      h += '</div></div>';
    });
    return h + '</div>';
  }
  return '';
}

function switchMediaTab(tab) {
  currentMediaTab = tab;
  document.querySelectorAll('.info-media-tab').forEach(function(btn, i) {
    btn.classList.toggle('active', ['photo', 'video', 'file', 'link'][i] === tab);
  });
  var el = document.getElementById('infoMediaContent');
  if (el) el.innerHTML = renderMediaContent(tab);
}

function scrollToMessage(msgId) {
  closeInfoPanel();
  var el = messagesList.querySelector('.msg[data-msg-id="' + msgId + '"]');
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('msg-highlight');
    setTimeout(function() { el.classList.remove('msg-highlight'); }, 1500);
  }
}

// Handle info panel messages in the main message handler
(function() {
  var origHandler = window.onmessage;
  window.addEventListener('message', function(event) {
    var msg = event.data;
    if (msg.type === 'chatInfo') {
      chatInfoData = msg.info;
      renderInfoPanel();
    } else if (msg.type === 'chatMembers') {
      chatMembersData = msg.members || [];
      renderInfoPanel();
    } else if (msg.type === 'sharedMedia') {
      sharedMediaData[msg.mediaType] = msg.media || [];
      if (currentMediaTab === msg.mediaType) {
        var el = document.getElementById('infoMediaContent');
        if (el) el.innerHTML = renderMediaContent(msg.mediaType);
      }
    }
  });
})();

// --- Mention Autocomplete (@user) ---
(function() {
  var mentionDropdown = document.getElementById('mentionDropdown');
  var groupMembers = []; // Cached members for this chat
  var membersLoaded = false;
  var mentionActive = false;
  var mentionQuery = '';
  var mentionStart = -1; // cursor position where @ was typed
  var mentionSelectedIdx = 0;
  var filteredMembers = [];

  // Request group members on init (after a short delay)
  setTimeout(function() {
    vscode.postMessage({ type: 'getGroupMembers' });
  }, 500);

  // Handle groupMembers response
  window.addEventListener('message', function(event) {
    var msg = event.data;
    if (msg.type === 'groupMembers' && msg.members) {
      groupMembers = msg.members;
      membersLoaded = true;
    }
  });

  function pickMentionColor(id) {
    var colors = ['#e17076','#eda86c','#a695e7','#7bc862','#6ec9cb','#65aadd','#ee7aae','#6bb2f2'];
    return colors[Math.abs(parseInt(id || '0', 10)) % colors.length];
  }

  function renderMentionDropdown() {
    if (filteredMembers.length === 0) {
      mentionDropdown.innerHTML = '<div class="mention-empty">No members found</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < filteredMembers.length; i++) {
      var m = filteredMembers[i];
      var selectedCls = i === mentionSelectedIdx ? ' selected' : '';
      var avatarHtml;
      if (m.photo) {
        avatarHtml = '<img src="' + esc(m.photo) + '" />';
      } else {
        avatarHtml = '<span style="width:32px;height:32px;border-radius:50%;background:' + pickMentionColor(m.id) + ';display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;color:#fff">' + esc(m.initials || '?') + '</span>';
      }
      html += '<div class="mention-item' + selectedCls + '" data-idx="' + i + '">';
      html += '<div class="mention-avatar">' + avatarHtml + '</div>';
      html += '<div class="mention-info">';
      html += '<div class="mention-name">' + esc(m.name) + '</div>';
      if (m.username) html += '<div class="mention-username">@' + esc(m.username) + '</div>';
      html += '</div></div>';
    }
    mentionDropdown.innerHTML = html;
    // Bind click handlers
    mentionDropdown.querySelectorAll('.mention-item').forEach(function(el) {
      el.addEventListener('click', function() {
        selectMention(parseInt(el.dataset.idx));
      });
    });
  }

  function showMentionDropdown() {
    mentionDropdown.classList.add('visible');
    mentionActive = true;
    mentionSelectedIdx = 0;
    filterMembers();
  }

  function hideMentionDropdown() {
    mentionDropdown.classList.remove('visible');
    mentionActive = false;
    mentionQuery = '';
    mentionStart = -1;
    filteredMembers = [];
  }

  function filterMembers() {
    var q = mentionQuery.toLowerCase();
    if (!q) {
      filteredMembers = groupMembers.slice(0, 10);
    } else {
      filteredMembers = groupMembers.filter(function(m) {
        return (m.name && m.name.toLowerCase().indexOf(q) !== -1) ||
               (m.username && m.username.toLowerCase().indexOf(q) !== -1);
      }).slice(0, 10);
    }
    if (mentionSelectedIdx >= filteredMembers.length) {
      mentionSelectedIdx = Math.max(0, filteredMembers.length - 1);
    }
    renderMentionDropdown();
  }

  function selectMention(idx) {
    if (idx < 0 || idx >= filteredMembers.length) return;
    var m = filteredMembers[idx];
    var ta = document.getElementById('msgInput');
    var val = ta.value;
    // Replace @query with @username or @name
    var insertText = m.username ? '@' + m.username : '@' + m.name.replace(/\\s+/g, '_');
    var before = val.slice(0, mentionStart);
    var after = val.slice(ta.selectionStart);
    ta.value = before + insertText + ' ' + after;
    var newPos = before.length + insertText.length + 1;
    ta.selectionStart = ta.selectionEnd = newPos;
    ta.focus();
    ta.dispatchEvent(new Event('input'));
    hideMentionDropdown();
  }

  // Listen for input in the composer to detect @ mentions
  msgInput.addEventListener('input', function() {
    var val = msgInput.value;
    var pos = msgInput.selectionStart;
    // Find the nearest @ before cursor
    var atIdx = -1;
    for (var i = pos - 1; i >= 0; i--) {
      var c = val[i];
      if (c === '@') { atIdx = i; break; }
      if (c === ' ' || c === '\\n') break; // stop at whitespace
    }
    if (atIdx !== -1 && membersLoaded) {
      // Check if this @ is at start or preceded by whitespace
      if (atIdx === 0 || /\\s/.test(val[atIdx - 1])) {
        mentionStart = atIdx;
        mentionQuery = val.slice(atIdx + 1, pos);
        if (!mentionActive) {
          showMentionDropdown();
        } else {
          filterMembers();
        }
        return;
      }
    }
    // No valid @ found — hide dropdown
    if (mentionActive) hideMentionDropdown();
  });

  // Keyboard navigation for mention dropdown
  msgInput.addEventListener('keydown', function(e) {
    if (!mentionActive) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      mentionSelectedIdx = (mentionSelectedIdx + 1) % Math.max(1, filteredMembers.length);
      renderMentionDropdown();
      scrollMentionIntoView();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      mentionSelectedIdx = (mentionSelectedIdx - 1 + Math.max(1, filteredMembers.length)) % Math.max(1, filteredMembers.length);
      renderMentionDropdown();
      scrollMentionIntoView();
    } else if (e.key === 'Enter' && filteredMembers.length > 0) {
      e.preventDefault();
      e.stopPropagation();
      selectMention(mentionSelectedIdx);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      hideMentionDropdown();
    } else if (e.key === 'Tab' && filteredMembers.length > 0) {
      e.preventDefault();
      selectMention(mentionSelectedIdx);
    }
  });

  function scrollMentionIntoView() {
    var selected = mentionDropdown.querySelector('.mention-item.selected');
    if (selected) {
      selected.scrollIntoView({ block: 'nearest' });
    }
  }

  // Close dropdown on blur (with small delay for click handling)
  msgInput.addEventListener('blur', function() {
    setTimeout(function() {
      if (!mentionDropdown.matches(':hover')) {
        hideMentionDropdown();
      }
    }, 150);
  });

  // Re-focus textarea after clicking mention
  mentionDropdown.addEventListener('mousedown', function(e) {
    e.preventDefault(); // Prevent blur
  });
})();

// TASK-037: Tool execution timeline
var _toolCallsData = [];

function requestToolCalls() {
  vscode.postMessage({ type: 'getToolCalls' });
}

function renderToolTimeline(data) {
  _toolCallsData = data || [];
  if (!_toolCallsData.length) return;

  // Attach to the last bot message bubble
  var allMsgs = document.querySelectorAll('.msg-group.incoming .msg');
  if (!allMsgs.length) return;
  var lastBotMsg = allMsgs[allMsgs.length - 1];
  var bubble = lastBotMsg ? lastBotMsg.querySelector('.msg-bubble') : null;
  if (!bubble) return;
  
  var existing = bubble.querySelector('.tool-timeline');
  if (existing) existing.remove();

  var totalCalls = _toolCallsData.length;
  var errorCount = _toolCallsData.filter(function(t) { return t.isError; }).length;
  var totalDuration = _toolCallsData.reduce(function(s, t) { return s + (t.durationMs || 0); }, 0);
  var durLabel = totalDuration < 1000 ? totalDuration + 'ms' : (totalDuration / 1000).toFixed(1) + 's';

  var summaryText = totalCalls + ' tool call' + (totalCalls !== 1 ? 's' : '') + ' \\u00b7 ' + durLabel;
  if (errorCount > 0) summaryText += ' \\u00b7 ' + errorCount + ' error' + (errorCount !== 1 ? 's' : '');

  var html = '<div class="tool-timeline">';
  html += '<div class="tool-timeline-header" onclick="this.classList.toggle(\\\'expanded\\\')"><span class="chevron">\\u203a</span> \\ud83d\\udd27 ' + summaryText + '</div>';
  html += '<div class="tool-timeline-items">';

  for (var i = 0; i < _toolCallsData.length; i++) {
    var t = _toolCallsData[i];
    var statusCls = t.isError ? 'err' : 'ok';
    var statusIcon = t.isError ? '\\u2717' : '\\u2713';
    html += '<div class="tool-item" onclick="toggleToolDetail(this)">';
    html += '<span class="tool-icon">' + (t.icon || '\\ud83d\\udd28') + '</span>';
    html += '<span class="tool-name">' + esc(t.name) + '</span>';
    html += '<span class="tool-params">' + esc(t.paramsSummary || '') + '</span>';
    html += '<span class="tool-duration">' + esc(t.durationLabel || '') + '</span>';
    html += '<span class="tool-status ' + statusCls + '">' + statusIcon + '</span>';
    html += '</div>';
    html += '<div class="tool-item-detail" data-tool-idx="' + i + '">' + esc(t.resultPreview || '') + '</div>';
  }

  html += '</div></div>';
  bubble.insertAdjacentHTML('beforeend', html);
}

function toggleToolDetail(el) {
  var detail = el.nextElementSibling;
  if (detail && detail.classList.contains('tool-item-detail')) {
    detail.classList.toggle('visible');
  }
}

// Auto-request tool calls when messages render
(function() {
  var _toolTimer = null;
  var observer = new MutationObserver(function() {
    if (_toolTimer) clearTimeout(_toolTimer);
    _toolTimer = setTimeout(requestToolCalls, 500);
  });
  observer.observe(messagesList, { childList: true, subtree: false });
})();


// --- Session Digest ---
const digestBanner = document.getElementById('digestBanner');
const digestContent = document.getElementById('digestContent');
const digestMeta = document.getElementById('digestMeta');
const digestClose = document.getElementById('digestClose');

function showSessionDigest(digest) {
  if (!digest.hasActivity || digest.items.length === 0) {
    return;
  }

  // Populate digest content
  let html = '';
  for (let i = 0; i < digest.items.length; i++) {
    const item = digest.items[i];
    const iconMap = {
      'task': '✅',
      'deploy': '🚀',
      'error': '❌',
      'cost': '💰'
    };
    const icon = iconMap[item.type] || '📋';
    const timeAgo = formatDigestTime(item.timestamp);
    
    html += '<div class="digest-item" onclick="handleDigestItemClick(\'' + esc(item.messageId || '') + '\')">';
    html += '<span class="digest-item-icon">' + icon + '</span>';
    html += '<div class="digest-item-content">';
    html += '<div class="digest-item-title">' + esc(item.title) + '</div>';
    html += '<div class="digest-item-details">' + esc(item.details) + '</div>';
    html += '</div>';
    html += '<span class="digest-item-time">' + esc(timeAgo) + '</span>';
    html += '</div>';
  }
  
  digestContent.innerHTML = html;
  
  // Update meta info
  let metaText = digest.sessionCount + ' session' + (digest.sessionCount !== 1 ? 's' : '');
  if (digest.totalCost > 0) {
    metaText += ' • <span class="digest-cost">$' + digest.totalCost.toFixed(3) + '</span> cost';
  }
  digestMeta.innerHTML = metaText;
  
  // Show the banner
  digestBanner.style.display = 'flex';
}

function handleDigestItemClick(messageId) {
  if (messageId) {
    vscode.postMessage({ type: 'digestItemClick', messageId: messageId });
  }
}

function dismissDigest() {
  digestBanner.style.display = 'none';
  vscode.postMessage({ type: 'dismissDigest' });
}

function formatDigestTime(timestamp) {
  try {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / (1000 * 60));
    
    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return diffMins + 'm ago';
    
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return diffHours + 'h ago';
    
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return diffDays + ' days ago';
    
    return date.toLocaleDateString();
  } catch {
    return 'Unknown';
  }
}

function scrollToMessageById(messageId) {
  const msgEl = document.querySelector('[data-msg-id="' + messageId + '"]');
  if (msgEl) {
    msgEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    msgEl.classList.add('msg-highlight');
    setTimeout(function() { msgEl.classList.remove('msg-highlight'); }, 1500);
  }
}

// Wire up digest close button
if (digestClose) {
  digestClose.addEventListener('click', dismissDigest);
}

// Initialize: request messages from extension
vscode.postMessage({ type: 'init' });

// TASK-035: Initialize semantic search availability check
setTimeout(function() {
  checkSemanticSearchAvailability();
}, 1000);
