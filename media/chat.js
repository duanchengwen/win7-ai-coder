/* ============================================
   Win7 AI Coder v5 — Chat Panel
   @-mentions + /commands + Thinking Animation
   ============================================ */

(function() {
  var vscode = acquireVsCodeApi();
  var isBusy = false;
  var contextData = null;
  var contextFiles = {};
  var pendingMentions = [];
  var mentionSearchTimeout = null;

  var container = document.getElementById('container');
  var messagesEl = document.getElementById('messages');
  var inputEl = document.getElementById('input');
  var sendBtn = document.getElementById('btn-send');
  var contextBar = document.getElementById('context-bar');
  var contextLabel = document.getElementById('context-label');
  var btnClear = document.getElementById('btn-clear');
  var btnConfig = document.getElementById('btn-config');
  var btnRemoveCtx = document.getElementById('btn-remove-context');
  var inputRow = document.getElementById('input-row');
  var thinkingIndicator = document.getElementById('thinking-indicator');
  var thinkingText = document.getElementById('thinking-text');

  // ─── Popup system ────────────────────────────────
  var popupEl = null;
  var popupItems = [];
  var popupIndex = 0;
  var popupCallback = null;
  var popupFilter = null;

  var MENTION_ITEMS = [
    { id: 'file',     label: 'File',     icon: '\uD83D\uDCC4', desc: 'Attach a file from the project' },
    { id: 'folder',   label: 'Folder',   icon: '\uD83D\uDCC2', desc: 'List directory contents' },
    { id: 'codebase', label: 'Codebase', icon: '\uD83D\uDD0D', desc: 'Search across the project' },
    { id: 'terminal', label: 'Terminal', icon: '\uD83D\uDCBB', desc: 'Run a terminal command' },
  ];

  var COMMAND_ITEMS = [
    { id: 'edit',    label: '/edit',    icon: '\u270F\uFE0F', desc: 'Edit selected code with instructions' },
    { id: 'commit',  label: '/commit',  icon: '\uD83D\uDCBE', desc: 'Generate commit message from git diff' },
    { id: 'test',    label: '/test',    icon: '\uD83E\uDDEA', desc: 'Generate tests for selected code' },
    { id: 'explain', label: '/explain', icon: '\uD83D\uDCD6', desc: 'Explain the selected code' },
    { id: 'so',      label: '/so',      icon: '\uD83D\uDD0D', desc: 'Stack Overflow style Q&A' },
    { id: 'clear',   label: '/clear',   icon: '\uD83D\uDDD1\uFE0F', desc: 'Clear chat history' },
  ];

  function createPopup() {
    if (popupEl) return popupEl;
    popupEl = document.createElement('div');
    popupEl.id = 'mention-popup';
    popupEl.className = 'popup-menu';
    inputRow.parentNode.insertBefore(popupEl, inputRow);
    return popupEl;
  }

  function showPopup(items, idx, onSelect, filterFn) {
    createPopup();
    popupItems = items;
    popupIndex = Math.max(0, Math.min(idx, items.length - 1));
    popupCallback = onSelect;
    popupFilter = filterFn || null;
    renderPopup();
    popupEl.style.display = 'block';
  }

  function hidePopup() {
    if (!popupEl) return;
    popupEl.style.display = 'none';
    popupItems = [];
    popupIndex = 0;
    popupCallback = null;
    popupFilter = null;
  }

  function renderPopup() {
    if (!popupEl) return;
    var query = getQueryText();
    var items = popupItems;
    if (popupFilter) {
      items = items.filter(function(item) { return popupFilter(item, query); });
    }
    if (items.length === 0) {
      popupEl.innerHTML = '<div class="popup-empty">No matches</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < Math.min(items.length, 10); i++) {
      var item = items[i];
      var active = (i === popupIndex) ? ' active' : '';
      html += '<div class="popup-item' + active + '" data-idx="' + i + '">'
        + '<span class="popup-icon">' + (item.icon || '') + '</span>'
        + '<span class="popup-label">' + esc(item.label) + '</span>'
        + '<span class="popup-desc">' + esc(item.desc || '') + '</span>'
        + '</div>';
    }
    popupEl.innerHTML = html;
    popupEl.scrollTop = 0;

    var itemEls = popupEl.querySelectorAll('.popup-item');
    for (var j = 0; j < itemEls.length; j++) {
      (function(idx) {
        itemEls[j].addEventListener('click', function() {
          var selectedItems = items;
          if (popupFilter) selectedItems = items.filter(function(it) { return popupFilter(it, getQueryText()); });
          if (idx < selectedItems.length && popupCallback) popupCallback(selectedItems[idx]);
          hidePopup();
        });
      })(j);
    }
  }

  function popupNavigate(delta) {
    var items = popupItems;
    if (popupFilter) items = items.filter(function(it) { return popupFilter(it, getQueryText()); });
    if (items.length === 0) return;
    popupIndex = (popupIndex + delta + items.length) % items.length;
    renderPopup();
  }

  function popupSelect() {
    var items = popupItems;
    if (popupFilter) items = items.filter(function(it) { return popupFilter(it, getQueryText()); });
    if (items.length > 0 && popupIndex >= 0 && popupIndex < items.length) {
      if (popupCallback) popupCallback(items[popupIndex]);
      hidePopup();
      return true;
    }
    return false;
  }

  var mentionState = null;
  var isMentionActive = false;

  function getQueryText() {
    if (!mentionState) return '';
    return mentionState.query || '';
  }

  function getCursorWord() {
    var val = inputEl.value;
    var pos = inputEl.selectionStart;
    if (pos <= 0) return '';
    var start = pos;
    while (start > 0 && val[start - 1] !== ' ' && val[start - 1] !== '\n') start--;
    return val.substring(start, pos);
  }

  function insertAtCursor(text) {
    var val = inputEl.value;
    var pos = inputEl.selectionStart || val.length;
    inputEl.value = val.substring(0, pos) + text + val.substring(inputEl.selectionEnd || pos);
    var newPos = pos + text.length;
    inputEl.selectionStart = newPos;
    inputEl.selectionEnd = newPos;
    inputEl.focus();
    updateHeight();
  }

  function replaceMentionInInput(type, query) {
    var val = inputEl.value;
    var pattern = '@' + type + ' ' + query;
    var idx = val.indexOf(pattern);
    if (idx >= 0) {
      inputEl.value = val.substring(0, idx) + val.substring(idx + pattern.length);
      updateHeight();
    }
  }

  function startMention() {
    isMentionActive = true;
    mentionState = null;
    showPopup(MENTION_ITEMS, 0, function(item) {
      var insertText = '@' + item.id + ' ';
      insertAtCursor(insertText);
      mentionState = { type: item.id, query: '' };
      if (item.id === 'file' || item.id === 'folder' || item.id === 'codebase') {
        requestMentionResults(item.id, '');
      }
    });
  }

  function requestMentionResults(type, query) {
    if (mentionSearchTimeout) clearTimeout(mentionSearchTimeout);
    mentionSearchTimeout = setTimeout(function() {
      vscode.postMessage({
        type: 'resolveMention',
        mentionType: type,
        query: query
      });
      mentionSearchTimeout = null;
    }, 200);
  }

  function handleInputChange() {
    var val = inputEl.value;
    var pos = inputEl.selectionStart;
    var cursorChar = pos > 0 ? val[pos - 1] : '';

    sendBtn.disabled = !val.trim() || isBusy;

    if (cursorChar === '@' && !isMentionActive && !popupVisible()) {
      var before = val.substring(0, pos - 1);
      var lastSpace = before.lastIndexOf(' ');
      var lastNewline = before.lastIndexOf('\n');
      var lastBreak = Math.max(lastSpace, lastNewline);
      var wordBefore = before.substring(lastBreak + 1);
      if (wordBefore === '' || wordBefore.match(/[\s\n]$/)) {
        startMention();
        return;
      }
    }

    if (cursorChar === '/' && !isMentionActive && !popupVisible()) {
      var beforeSlash = val.substring(0, pos - 1);
      if (beforeSlash.trim() === '' || beforeSlash.endsWith('\n')) {
        startCommand();
        return;
      }
    }

    if (isMentionActive && mentionState) {
      var before = val.substring(0, pos);
      var mentionMatch = before.match(/@(file|folder|codebase|terminal)\s+(.*)$/);
      if (mentionMatch) {
        mentionState.type = mentionMatch[1];
        mentionState.query = mentionMatch[2];
        if (mentionMatch[1] !== 'terminal') {
          requestMentionResults(mentionMatch[1], mentionMatch[2]);
        }
      } else if (before.match(/@(file|folder|codebase|terminal)$/)) {
        mentionState.query = '';
      } else {
        if (popupVisible()) hidePopup();
      }
    }
  }

  function popupVisible() {
    return popupEl && popupEl.style.display === 'block';
  }

  function startCommand() {
    showPopup(COMMAND_ITEMS, 0, function(item) {
      executeSlashCommand(item.id);
    }, function(item, query) {
      var val = inputEl.value;
      var pos = inputEl.selectionStart;
      var before = val.substring(0, pos);
      var cmdText = before.match(/\/(\w*)$/);
      var q = cmdText ? cmdText[1].toLowerCase() : '';
      return item.id.indexOf(q) >= 0;
    });
  }

  function executeSlashCommand(cmdId) {
    switch (cmdId) {
      case 'edit':
        inputEl.value = '/edit ';
        break;
      case 'commit':
        inputEl.value = '/commit';
        break;
      case 'test':
        inputEl.value = '/test ';
        break;
      case 'explain':
        inputEl.value = '/explain';
        break;
      case 'so':
        inputEl.value = '/so ';
        break;
      case 'clear':
        vscode.postMessage({ type: 'clear' });
        inputEl.value = '';
        break;
    }
    inputEl.selectionStart = inputEl.selectionEnd = inputEl.value.length;
    inputEl.focus();
    updateHeight();
  }

  function resolveMentionsInText(text) {
    var newContext = {};
    var contextList = [];

    text = text.replace(/@file\s+(\S+(?:\s+\S+)*)/g, function(match, filepath) {
      var key = 'file:' + filepath;
      contextList.push({ type: 'file', query: filepath, key: key });
      return '';
    });

    text = text.replace(/@folder\s+(\S+)/g, function(match, folderpath) {
      var key = 'folder:' + folderpath;
      contextList.push({ type: 'folder', query: folderpath, key: key });
      return '';
    });

    text = text.replace(/@codebase\s+(.+)/g, function(match, pattern) {
      var key = 'codebase:' + pattern;
      contextList.push({ type: 'codebase', query: pattern, key: key });
      return '';
    });

    text = text.replace(/@terminal\s+(.+)/g, function(match, command) {
      var key = 'terminal:' + command;
      contextList.push({ type: 'terminal', query: command, key: key });
      return '';
    });

    return { text: text.trim(), mentions: contextList };
  }

  // ─── Send ────────────────────────────────────────

  function send() {
    var raw = inputEl.value.trim();
    if (!raw || isBusy) return;

    var cmdMatch = raw.match(/^\/(\w+)\s*(.*)$/);
    if (cmdMatch) {
      var cmd = cmdMatch[1];
      var args = cmdMatch[2].trim();
      if (cmd === 'clear') {
        vscode.postMessage({ type: 'clear' });
        inputEl.value = '';
        return;
      }
      addMsg('user').c.textContent = raw;
      scrollBottom();
      inputEl.value = '';
      sendBtn.disabled = true;
      isBusy = true;
      vscode.postMessage({
        type: 'runCommand',
        command: cmd,
        args: args
      });
      return;
    }

    var resolved = resolveMentionsInText(raw);
    var text = resolved.text;
    var mentions = resolved.mentions;

    if (!text && mentions.length === 0) return;

    addMsg('user').c.textContent = raw;
    scrollBottom();
    inputEl.value = '';
    sendBtn.disabled = true;
    updateHeight();
    isBusy = true;

    var allContext = contextData ? contextData.fileContent || '' : '';
    var mentionContexts = [];

    if (mentions.length > 0) {
      mentions.forEach(function(m) {
        var mc = addMsg('tool');
        mc.c.textContent = 'Resolving: @' + m.type + ' ' + m.query + '...';
        mentionContexts.push(m);
      });
    }

    if (mentionContexts.length > 0) {
      vscode.postMessage({
        type: 'chatWithMentions',
        text: text,
        fileContext: allContext,
        mentions: mentionContexts
      });
    } else {
      var extraContext = '';
      for (var k in contextFiles) {
        if (contextFiles.hasOwnProperty(k)) {
          extraContext += '\n--- ' + contextFiles[k].label + ' ---\n' + contextFiles[k].content + '\n';
        }
      }

      vscode.postMessage({
        type: 'chat',
        text: text,
        fileContext: allContext + (extraContext ? '\n\n[Attached context]\n' + extraContext : '')
      });
    }
  }

  // ─── DOM helpers ─────────────────────────────────

  function esc(str) {
    if (!str) return '';
    var d = document.createElement('div');
    d.appendChild(document.createTextNode(str));
    return d.innerHTML;
  }

  function escAttr(str) {
    return (str || '').replace(/"/g, '&quot;');
  }

  function md(html) {
    if (!html) return '';
    html = esc(html);
    html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, function(m, lang, code) {
      return '<div class="code-header"><span>' + esc(lang || 'code') + '</span>' +
             '<button class="copy-btn" onclick="__cc(this)">\uD83D\uDCCB Copy</button></div>' +
             '<pre><code>' + esc(code.trim()) + '</code></pre>';
    });
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    html = html.replace(/\n\n+/g, '</p><p>');
    html = html.replace(/\n/g, '<br>');
    if (html.indexOf('<p>') !== 0 && html.indexOf('<h') !== 0 &&
        html.indexOf('<div') !== 0 && html.indexOf('<pre') !== 0) {
      html = '<p>' + html + '</p>';
    }
    return html;
  }

  function addMsg(role) {
    var w = messagesEl.querySelector('.welcome');
    if (w) w.remove();

    var d = document.createElement('div');
    d.className = 'msg msg-' + role;
    var lbl = document.createElement('div');
    lbl.className = 'msg-label';
    var labels = {
      user: '\uD83D\uDC64 You',
      assistant: '\uD83E\uDD16 AI',
      tool: '\uD83D\uDD27 Tool',
      error: '\u274C Error',
      reasoning: '\uD83E\uDDE0 Reasoning'
    };
    lbl.textContent = labels[role] || role;
    d.appendChild(lbl);
    var c = document.createElement('div');
    c.className = 'msg-content';
    d.appendChild(c);
    messagesEl.appendChild(d);
    return { w: d, c: c };
  }

  function addToolCallStart(name, args, preview) {
    var w = messagesEl.querySelector('.welcome');
    if (w) w.remove();

    var d = document.createElement('div');
    d.className = 'tool-call';
    d.setAttribute('data-tool', name);
    var iconMap = {
      read_file: '\uD83D\uDCD6', write_file: '\u270F\uFE0F',
      list_dir: '\uD83D\uDCC2', search_code: '\uD83D\uDD0D',
      run_terminal: '\u2328\uFE0F'
    };
    d.innerHTML =
      '<div class="tool-header">' +
      '  <span class="tool-icon">' + (iconMap[name] || '\uD83D\uDD27') + '</span>' +
      '  <span class="tool-name">' + esc(name) + '</span>' +
      '  <span class="tool-spinner">\u23F3</span>' +
      '</div>' +
      '<div class="tool-args">' + esc(preview) + '</div>' +
      '<div class="tool-result" style="display:none;"></div>';
    messagesEl.appendChild(d);
    scrollBottom();
    return d;
  }

  function finishToolCall(d, result) {
    var spinner = d.querySelector('.tool-spinner');
    if (spinner) spinner.textContent = '\u2705';
    var resDiv = d.querySelector('.tool-result');
    if (resDiv) {
      resDiv.style.display = 'block';
      resDiv.textContent = result.substring(0, 600);
    }
    scrollBottom();
  }

  function scrollBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function updateHeight() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
  }

  // ─── Phase 4: Thinking indicator ────────────────

  function showThinking(text) {
    if (!thinkingIndicator) return;
    thinkingIndicator.style.display = 'flex';
    if (thinkingText) thinkingText.textContent = text || 'Thinking...';
    scrollBottom();
  }

  function updateThinking(text) {
    if (!thinkingIndicator) return;
    thinkingIndicator.style.display = 'flex';
    if (thinkingText) thinkingText.textContent = text || 'Thinking...';
  }

  function hideThinking() {
    if (!thinkingIndicator) return;
    thinkingIndicator.style.display = 'none';
  }

  window.__cc = function(btn) {
    var pre = (btn.parentElement || {}).nextElementSibling;
    if (!pre || pre.tagName !== 'PRE') return;
    var code = pre.textContent || '';
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(code).then(function() { showCopied(btn); }, function() { fc(code, btn); });
    } else {
      fc(code, btn);
    }
  };

  function fc(text, btn) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); showCopied(btn); } catch(e) { btn.textContent = '\u274C'; }
    document.body.removeChild(ta);
  }

  function showCopied(btn) {
    btn.textContent = '\u2705 Copied';
    setTimeout(function() { btn.textContent = '\uD83D\uDCCB Copy'; }, 1500);
  }

  // ─── Event handlers ──────────────────────────────

  inputEl.addEventListener('keydown', function(e) {
    if (popupVisible()) {
      if (e.key === 'ArrowDown') { e.preventDefault(); popupNavigate(1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); popupNavigate(-1); return; }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (popupSelect()) return; }
      if (e.key === 'Tab') { e.preventDefault(); popupSelect(); return; }
      if (e.key === 'Escape') { e.preventDefault(); hidePopup(); isMentionActive = false; return; }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (isMentionActive) {
        hidePopup();
        isMentionActive = false;
        send();
      } else {
        send();
      }
    }
  });

  inputEl.addEventListener('input', function() {
    var wasMention = isMentionActive;
    handleInputChange();
    if (!wasMention && !isMentionActive) {
      sendBtn.disabled = !inputEl.value.trim() || isBusy;
    }
    updateHeight();
  });

  inputEl.addEventListener('blur', function() {
    setTimeout(function() {
      if (popupVisible()) return;
      hidePopup();
      isMentionActive = false;
    }, 200);
  });

  sendBtn.addEventListener('click', send);

  btnClear.addEventListener('click', function() {
    vscode.postMessage({ type: 'clear' });
  });

  btnConfig.addEventListener('click', function() {
    vscode.postMessage({ type: 'attachFile' });
  });

  btnRemoveCtx.addEventListener('click', function() {
    contextData = null;
    contextBar.style.display = 'none';
    contextLabel.textContent = '';
  });

  // ─── Messages from Extension ─────────────────────

  window.addEventListener('message', function(e) {
    var m = e.data;

    switch (m.type) {

      case 'user':
        break;

      case 'tool-start':
        addToolCallStart(m.name, m.args, m.preview || '');
        break;

      case 'tool-end':
        var el = messagesEl.querySelector('.tool-call[data-tool="' + escAttr(m.name) + '"]:last-child');
        if (el) finishToolCall(el, m.result || '');
        break;

      case 'assistant':
        var am = addMsg('assistant');
        am.c.innerHTML = md(m.content || '');
        scrollBottom();
        break;

      case 'agent-start':
        showThinking('Thinking...');
        break;

      case 'thinking-start':
        showThinking(m.content || 'Thinking...');
        break;

      case 'thinking-update':
        updateThinking(m.content || 'Thinking...');
        break;

      case 'thinking-end':
        hideThinking();
        break;

      case 'reasoning':
        // Phase 4: Show reasoning content if model provides it
        if (m.content) {
          var rm = addMsg('reasoning');
          rm.c.innerHTML = md(m.content.substring(0, 2000));
          scrollBottom();
        }
        break;

      case 'agent-end':
        isBusy = false;
        sendBtn.disabled = !inputEl.value.trim();
        hideThinking();
        break;

      case 'error':
        var em = addMsg('error');
        em.c.innerHTML = md(m.content || 'Unknown error');
        isBusy = false;
        sendBtn.disabled = !inputEl.value.trim();
        scrollBottom();
        hideThinking();
        break;

      case 'cleared':
        messagesEl.innerHTML =
          '<div class="welcome">' +
          '  <div class="welcome-icon">\uD83E\uDD16</div>' +
          '  <div class="welcome-title">Win7 AI Coder v5</div>' +
          '  <div class="welcome-sub">@-mentions · /commands · Tab autocomplete · Codebase index</div>' +
          '  <div class="welcome-hints">' +
          '    <div class="hint"><span class="hint-key">@</span> Attach files, search codebase, or run terminal commands' +
          '    <div class="hint"><span class="hint-key">/</span> Quick commands: /edit, /commit, /test, /explain, /clear' +
          '    <div class="hint"><span class="hint-key">Tab</span> Inline autocomplete while typing (configurable)' +
          '  </div>' +
          '</div>';
        hideThinking();
        break;

      case 'config':
        break;

      case 'contextSet':
        contextData = { fileContent: m.fileContent || '', label: m.label || '' };
        contextBar.style.display = 'flex';
        contextLabel.textContent = m.label || '';
        break;

      case 'mentionResult':
        if (m.results && m.results.length > 0) {
          var results = m.results.map(function(r) {
            return {
              id: r.path || r.name,
              label: r.path || r.name,
              icon: r.isDir ? '\uD83D\uDCC1' : '\uD83D\uDCC4',
              desc: r.detail || '',
              content: r.content || '',
              isDir: r.isDir || false
            };
          });
          showPopup(results, 0, function(item) {
            contextFiles[item.id] = {
              content: item.content || '(resolved)',
              label: item.label
            };
            contextBar.style.display = 'flex';
            contextLabel.textContent = '\uD83D\uDCCE ' + item.label;
            var val = inputEl.value;
            if (mentionState) {
              replaceMentionInInput(mentionState.type, mentionState.query || '');
            }
            isMentionActive = false;
            hidePopup();
            inputEl.focus();
          });
        } else {
          popupCallback = null;
        }
        break;

      case 'mentionResolved':
        if (m.key) {
          contextFiles[m.key] = {
            content: m.content || '',
            label: m.label || m.key
          };
          contextBar.style.display = 'flex';
          contextLabel.textContent = '\uD83D\uDCCE ' + (m.label || m.key);
        }
        break;

      case 'status':
        break;
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
