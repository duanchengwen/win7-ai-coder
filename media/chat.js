/* ============================================
   Win7 AI Coder v5 — Continue-style Chat Panel
   @-mentions + /commands + Settings + Diff +
   History Sidebar + Enhanced Tool Calls + Status Bar
   ============================================ */

(function() {
  var vscode = acquireVsCodeApi();
  var isBusy = false;
  var contextData = null;
  var contextFiles = {};
  var pendingMentions = [];
  var mentionSearchTimeout = null;
  var toolCallTimers = {};
  var sessions = [];
  var currentSessionId = null;
  var configSettings = {
    model: 'default',
    apiKey: '',
    temperature: 0.7,
    maxTokens: 4096
  };
  var tokenCount = 0;
  var connectionStatus = 'connected';

  // ─── DOM refs ────────────────────────────────
  var container = document.getElementById('container');
  var messagesEl = document.getElementById('messages');
  var inputEl = document.getElementById('input');
  var sendBtn = document.getElementById('btn-send');
  var contextBar = document.getElementById('context-bar');
  var contextLabel = document.getElementById('context-label');
  var btnClear = document.getElementById('btn-clear');
  var btnConfig = document.getElementById('btn-config');
  var btnMenu = document.getElementById('btn-menu');
  var btnRemoveCtx = document.getElementById('btn-remove-context');
  var inputRow = document.getElementById('input-row');
  var inputArea = document.getElementById('input-area');
  var thinkingIndicator = document.getElementById('thinking-indicator');
  var thinkingText = document.getElementById('thinking-text');

  // Settings panel
  var settingsOverlay = document.getElementById('settings-overlay');
  var settingsPanel = document.getElementById('settings-panel');
  var settingsClose = document.getElementById('settings-close');
  var settingsModel = document.getElementById('settings-model');
  var settingsApiKey = document.getElementById('settings-apikey');
  var settingsTemp = document.getElementById('settings-temp');
  var settingsTempVal = document.getElementById('settings-temp-val');
  var settingsMaxTokens = document.getElementById('settings-max-tokens');
  var settingsSaveBtn = document.getElementById('settings-save');
  var settingsCancelBtn = document.getElementById('settings-cancel');

  // History sidebar
  var historySidebar = document.getElementById('history-sidebar');
  var historyClose = document.getElementById('history-close');
  var historySearch = document.getElementById('history-search-input');
  var historyList = document.getElementById('history-list');
  var historyClearBtn = document.getElementById('history-clear-btn');

  // Dropdown menu
  var headerDropdown = document.getElementById('header-dropdown');

  // Status bar
  var statusModel = document.getElementById('status-model');
  var statusTokens = document.getElementById('status-tokens');
  var statusDot = document.getElementById('status-dot');

  // Context progress
  var contextProgress = document.getElementById('context-progress');
  var contextProgressFill = document.getElementById('context-progress-fill');
  var contextProgressLabel = document.getElementById('context-progress-label');

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

  // ─── Popup Functions ─────────────────────────

  function createPopup() {
    if (popupEl) return popupEl;
    popupEl = document.createElement('div');
    popupEl.id = 'mention-popup';
    popupEl.className = 'popup-menu';
    inputArea.insertBefore(popupEl, inputRow);
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

  function popupVisible() {
    return popupEl && popupEl.style.display === 'block';
  }

  // ─── Mention System ─────────────────────────────

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

  // ─── Command System ─────────────────────────────

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

  // ─── Input Handling ─────────────────────────────

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

  // ─── Mention Resolution ─────────────────────────

  function resolveMentionsInText(text) {
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
    return (str || '').replace(/\"/g, '&quot;');
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

  // ─── Message Creation ────────────────────────────

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

    // Add response actions for assistant messages
    if (role === 'assistant') {
      d.appendChild(createResponseActions(c));
    }

    messagesEl.appendChild(d);
    return { w: d, c: c };
  }

  // ─── Response Actions (Continue-style) ──────────

  function createResponseActions(contentEl) {
    var actions = document.createElement('div');
    actions.className = 'response-actions';

    // Copy button
    var copyBtn = document.createElement('button');
    copyBtn.className = 'action-btn';
    copyBtn.textContent = '\uD83D\uDCCB';
    copyBtn.title = 'Copy response';
    copyBtn.addEventListener('click', function() {
      var text = contentEl.textContent || '';
      copyText(text, copyBtn);
    });
    actions.appendChild(copyBtn);

    // Delete button
    var delBtn = document.createElement('button');
    delBtn.className = 'action-btn';
    delBtn.textContent = '\uD83D\uDDD1\uFE0F';
    delBtn.title = 'Delete message';
    delBtn.addEventListener('click', function() {
      var msgEl = contentEl.parentElement;
      if (msgEl) msgEl.remove();
    });
    actions.appendChild(delBtn);

    return actions;
  }

  function copyText(text, btn) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function() {
        showCopied(btn);
      }, function() {
        fallbackCopy(text, btn);
      });
    } else {
      fallbackCopy(text, btn);
    }
  }

  function fallbackCopy(text, btn) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); showCopied(btn); } catch(e) {}
    document.body.removeChild(ta);
  }

  function showCopied(btn) {
    var orig = btn.textContent;
    btn.textContent = '\u2705';
    btn.classList.add('copied');
    setTimeout(function() {
      btn.textContent = orig;
      btn.classList.remove('copied');
    }, 1200);
  }

  // ─── Tool Calls (Continue-style) ─────────────────

  function addToolCallStart(name, args, preview) {
    var w = messagesEl.querySelector('.welcome');
    if (w) w.remove();

    var d = document.createElement('div');
    d.className = 'tool-call';
    d.setAttribute('data-tool', name);
    d.setAttribute('data-tool-start', Date.now());

    var iconMap = {
      read_file: '\uD83D\uDCD6', write_file: '\u270F\uFE0F',
      list_dir: '\uD83D\uDCC2', search_code: '\uD83D\uDD0D',
      run_terminal: '\u2328\uFE0F'
    };

    var icon = iconMap[name] || '\uD83D\uDD27';
    var displayName = name.replace(/_/g, ' ').replace(/\b\w/g, function(l) { return l.toUpperCase(); });

    d.innerHTML =
      '<div class="tool-call-header" onclick="__toggleTool(this)">' +
      '  <span class="toggle-chevron">\u25B6</span>' +
      '  <span class="tool-icon">' + icon + '</span>' +
      '  <span class="tool-name">' + esc(displayName) + '</span>' +
      '  <span class="tool-status-text">Running...</span>' +
      '  <span class="tool-spinner">\u23F3</span>' +
      '</div>' +
      '<div class="tool-call-body">' +
      '  <div class="tool-args">' + esc(preview) + '</div>' +
      '  <div class="tool-result"></div>' +
      '  <div class="tool-timing"></div>' +
      '</div>';

    messagesEl.appendChild(d);
    scrollBottom();
    return d;
  }

  // Global toggle handler (referenced by onclick)
  window.__toggleTool = function(header) {
    var body = header.nextElementSibling;
    if (!body || !body.classList) return;
    body.classList.toggle('open');
    header.classList.toggle('active');
    var chevron = header.querySelector('.toggle-chevron');
    if (chevron) chevron.classList.toggle('open');
  };

  function finishToolCall(d, result) {
    var startTime = parseInt(d.getAttribute('data-tool-start')) || Date.now();
    var elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    var header = d.querySelector('.tool-call-header');
    var spinner = header.querySelector('.tool-spinner');
    if (spinner) {
      spinner.className = 'tool-status-icon done';
      spinner.textContent = '\u2705';
    }
    var statusText = header.querySelector('.tool-status-text');
    if (statusText) statusText.textContent = 'Completed (' + elapsed + 's)';

    var body = d.querySelector('.tool-call-body');
    var resDiv = d.querySelector('.tool-result');
    if (resDiv && result) {
      resDiv.textContent = result.substring(0, 600);
      body.classList.add('open');
      header.classList.add('active');
      var chevron = header.querySelector('.toggle-chevron');
      if (chevron) chevron.classList.add('open');
    }
    var timing = d.querySelector('.tool-timing');
    if (timing) timing.textContent = 'Took ' + elapsed + 's';

    scrollBottom();
  }

  function failToolCall(d, error) {
    var header = d.querySelector('.tool-call-header');
    var spinner = header.querySelector('.tool-spinner');
    if (spinner) {
      spinner.className = 'tool-status-icon error';
      spinner.textContent = '\u274C';
    }
    var statusText = header.querySelector('.tool-status-text');
    if (statusText) statusText.textContent = 'Failed';

    var body = d.querySelector('.tool-call-body');
    var resDiv = d.querySelector('.tool-result');
    if (resDiv && error) {
      resDiv.textContent = error.substring(0, 400);
      resDiv.style.color = 'var(--red)';
      body.classList.add('open');
      header.classList.add('active');
      var chevron = header.querySelector('.toggle-chevron');
      if (chevron) chevron.classList.add('open');
    }
    scrollBottom();
  }

  // ─── Diff Preview ────────────────────────────────

  function showDiff(diffText, filePath) {
    var container = document.createElement('div');
    container.className = 'diff-container';

    var lines = (diffText || '').split('\n');
    var hasContent = lines.some(function(l) {
      return l.startsWith('+') || l.startsWith('-');
    });
    if (!hasContent) {
      // If no diff markers, treat as unified diff or new file
      container.innerHTML =
        '<div class="diff-header">' +
        '  <span class="diff-file">' + esc(filePath || 'changes') + '</span>' +
        '  <div class="diff-actions">' +
        '    <button class="diff-accept" onclick="__acceptDiff(this)">\u2714 Accept</button>' +
        '    <button class="diff-reject" onclick="__rejectDiff(this)">\u2718 Reject</button>' +
        '  </div>' +
        '</div>' +
        '<div class="diff-body">' +
        '  <div class="diff-line diff-added">' +
        '    <span class="diff-line-num"></span>' +
        '    <span class="diff-line-content">' + esc(diffText || '') + '</span>' +
        '  </div>' +
        '</div>';
    } else {
      var bodyHtml = '';
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        var cls = 'diff-context';
        if (line.startsWith('+')) cls = 'diff-added';
        else if (line.startsWith('-')) cls = 'diff-removed';
        else if (line.startsWith('@@')) continue; // skip hunk header
        else if (line.startsWith('diff --git') || line.startsWith('index') || line.startsWith('---') || line.startsWith('+++')) continue;

        bodyHtml += '<div class="diff-line ' + cls + '">' +
          '<span class="diff-line-num">' + (i + 1) + '</span>' +
          '<span class="diff-line-content">' + esc(line) + '</span>' +
          '</div>';
      }

      container.innerHTML =
        '<div class="diff-header">' +
        '  <span class="diff-file">' + esc(filePath || 'changes') + '</span>' +
        '  <div class="diff-actions">' +
        '    <button class="diff-accept" onclick="__acceptDiff(this)">\u2714 Accept</button>' +
        '    <button class="diff-reject" onclick="__rejectDiff(this)">\u2718 Reject</button>' +
        '  </div>' +
        '</div>' +
        '<div class="diff-body">' + bodyHtml + '</div>';
    }

    return container;
  }

  // Global diff handlers
  window.__acceptDiff = function(btn) {
    var container = btn.closest('.diff-container');
    if (container) {
      container.style.borderColor = 'var(--green)';
      container.style.opacity = '0.5';
      vscode.postMessage({ type: 'acceptDiff', filePath: container._diffFile || '' });
    }
  };

  window.__rejectDiff = function(btn) {
    var container = btn.closest('.diff-container');
    if (container) {
      container.style.display = 'none';
      vscode.postMessage({ type: 'rejectDiff', filePath: container._diffFile || '' });
    }
  };

  // ─── Thinking Indicator ─────────────────────────

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

  // ─── Settings Panel ──────────────────────────────

  function openSettings() {
    settingsOverlay.classList.add('show');
    settingsPanel.classList.add('open');
    populateSettings();
  }

  function closeSettings() {
    settingsOverlay.classList.remove('show');
    settingsPanel.classList.remove('open');
  }

  function populateSettings() {
    if (settingsModel) settingsModel.value = configSettings.model || 'default';
    if (settingsApiKey) settingsApiKey.value = configSettings.apiKey || '';
    if (settingsTemp) settingsTemp.value = configSettings.temperature || 0.7;
    if (settingsTempVal) settingsTempVal.textContent = configSettings.temperature || 0.7;
    if (settingsMaxTokens) settingsMaxTokens.value = configSettings.maxTokens || 4096;
  }

  function saveSettings() {
    configSettings = {
      model: settingsModel ? settingsModel.value : 'default',
      apiKey: settingsApiKey ? settingsApiKey.value : '',
      temperature: settingsTemp ? parseFloat(settingsTemp.value) : 0.7,
      maxTokens: settingsMaxTokens ? parseInt(settingsMaxTokens.value) : 4096
    };
    updateStatusModel(configSettings.model);
    vscode.postMessage({
      type: 'updateConfig',
      config: configSettings
    });
    closeSettings();
  }

  // ─── History Sidebar ─────────────────────────────

  function openHistory() {
    historySidebar.classList.add('open');
    renderHistory();
  }

  function closeHistory() {
    historySidebar.classList.remove('open');
  }

  function renderHistory() {
    if (!historyList) return;
    if (!sessions || sessions.length === 0) {
      historyList.innerHTML = '<div class="history-empty">No past sessions yet</div>';
      return;
    }

    // Group by date
    var groups = {};
    var now = new Date();
    var today = now.toDateString();
    var yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    var yesterdayStr = yesterday.toDateString();

    sessions.forEach(function(s) {
      var date = new Date(s.date || Date.now());
      var dateStr = date.toDateString();
      var label;
      if (dateStr === today) label = 'Today';
      else if (dateStr === yesterdayStr) label = 'Yesterday';
      else label = dateStr;
      if (!groups[label]) groups[label] = [];
      groups[label].push(s);
    });

    var html = '';
    var groupKeys = Object.keys(groups);
    groupKeys.sort(function(a, b) {
      if (a === 'Today') return -1;
      if (b === 'Today') return 1;
      if (a === 'Yesterday') return -1;
      if (b === 'Yesterday') return 1;
      return new Date(b) - new Date(a);
    });

    groupKeys.forEach(function(label) {
      html += '<div class="history-group-label">' + esc(label) + '</div>';
      groups[label].forEach(function(s) {
        var active = s.sessionId === currentSessionId ? ' active' : '';
        html += '<div class="history-item' + active + '" data-session="' + escAttr(s.sessionId) + '">' +
          '<div class="history-item-title">' + esc(s.title || 'Untitled session') + '</div>' +
          '<div class="history-item-date">' + esc(formatDate(s.date)) + '</div>' +
          '</div>';
      });
    });

    historyList.innerHTML = html;

    // Bind click handlers
    var items = historyList.querySelectorAll('.history-item');
    for (var i = 0; i < items.length; i++) {
      (function(el) {
        el.addEventListener('click', function() {
          var sessionId = el.getAttribute('data-session');
          if (sessionId) {
            vscode.postMessage({ type: 'loadSession', sessionId: sessionId });
            closeHistory();
          }
        });
      })(items[i]);
    }
  }

  function formatDate(dateStr) {
    if (!dateStr) return '';
    var d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    var hours = d.getHours();
    var mins = d.getMinutes();
    var ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12 || 12;
    return hours + ':' + (mins < 10 ? '0' : '') + mins + ' ' + ampm;
  }

  // ─── Context Progress (Continue-style) ──────────

  function setContextProgress(percentage, isPruned) {
    if (!contextProgress || !contextProgressFill || !contextProgressLabel) return;
    if (percentage === undefined || percentage < 50) {
      contextProgress.classList.remove('show');
      return;
    }
    contextProgress.classList.add('show');
    var pct = Math.round(percentage * 100);
    contextProgressFill.style.width = pct + '%';
    contextProgressFill.className = 'context-progress-fill';
    if (isPruned) contextProgressFill.classList.add('critical');
    else if (pct > 80) contextProgressFill.classList.add('critical');
    else if (pct > 60) contextProgressFill.classList.add('warning');
    contextProgressLabel.textContent = isPruned ? 'Pruning oldest messages...' : pct + '% used';
  }

  // ─── Status Bar ──────────────────────────────────

  function updateStatusModel(model) {
    if (!statusModel) return;
    statusModel.textContent = model || 'No model';
    statusModel.title = 'Model: ' + (model || 'none');
  }

  function updateStatusTokens(count) {
    if (!statusTokens) return;
    tokenCount = count || 0;
    statusTokens.textContent = formatTokens(tokenCount);
  }

  function setConnectionStatus(status) {
    if (!statusDot) return;
    connectionStatus = status || 'connected';
    statusDot.className = 'status-dot ' + connectionStatus;
    statusDot.title = status === 'connected' ? 'Connected' :
                      status === 'connecting' ? 'Connecting...' : 'Disconnected';
  }

  function formatTokens(count) {
    if (!count) return '0';
    if (count < 1000) return count.toString();
    return (count / 1000).toFixed(1) + 'K';
  }

  function scrollBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function updateHeight() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
  }

  // ─── Copy Button (global) ───────────────────────

  window.__cc = function(btn) {
    var pre = (btn.parentElement || {}).nextElementSibling;
    if (!pre || pre.tagName !== 'PRE') return;
    var code = pre.textContent || '';
    copyText(code, btn);
  };

  // ─── New Session ─────────────────────────────────

  function newSession() {
    vscode.postMessage({ type: 'newSession' });
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
    isBusy = false;
    sendBtn.disabled = false;
    inputEl.value = '';
    updateHeight();
    closeHistory();
  }

  // ─── Dropdown Menu ───────────────────────────────

  function toggleDropdown() {
    headerDropdown.classList.toggle('show');
  }

  function closeDropdown() {
    headerDropdown.classList.remove('show');
  }

  // ─── Event Handlers ──────────────────────────────

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

    // Hide dropdown on Escape
    if (e.key === 'Escape') {
      closeDropdown();
      closeSettings();
      closeHistory();
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

  // ─── Menu Button ─────────────────────────────────

  if (btnMenu) {
    btnMenu.addEventListener('click', function(e) {
      e.stopPropagation();
      toggleDropdown();
    });
  }

  // Close dropdown on click outside
  document.addEventListener('click', function(e) {
    if (headerDropdown && headerDropdown.classList.contains('show')) {
      if (!btnMenu.contains(e.target) && !headerDropdown.contains(e.target)) {
        closeDropdown();
      }
    }
  });

  // Dropdown items
  var ddNewSession = document.getElementById('dd-new-session');
  var ddSettings = document.getElementById('dd-settings');
  var ddHistory = document.getElementById('dd-history');
  var ddRebuild = document.getElementById('dd-rebuild');
  var ddClearAll = document.getElementById('dd-clear-all');

  if (ddNewSession) {
    ddNewSession.addEventListener('click', function() {
      closeDropdown();
      newSession();
    });
  }

  if (ddSettings) {
    ddSettings.addEventListener('click', function() {
      closeDropdown();
      openSettings();
    });
  }

  if (ddHistory) {
    ddHistory.addEventListener('click', function() {
      closeDropdown();
      openHistory();
    });
  }

  if (ddRebuild) {
    ddRebuild.addEventListener('click', function() {
      closeDropdown();
      vscode.postMessage({ type: 'rebuildIndex' });
    });
  }

  if (ddClearAll) {
    ddClearAll.addEventListener('click', function() {
      closeDropdown();
      vscode.postMessage({ type: 'clear' });
    });
  }

  // ─── Settings Event Handlers ─────────────────────

  if (settingsClose) {
    settingsClose.addEventListener('click', closeSettings);
  }
  if (settingsOverlay) {
    settingsOverlay.addEventListener('click', closeSettings);
  }
  if (settingsSaveBtn) {
    settingsSaveBtn.addEventListener('click', saveSettings);
  }
  if (settingsCancelBtn) {
    settingsCancelBtn.addEventListener('click', closeSettings);
  }
  if (settingsTemp) {
    settingsTemp.addEventListener('input', function() {
      if (settingsTempVal) settingsTempVal.textContent = this.value;
    });
  }
  if (historyClose) {
    historyClose.addEventListener('click', closeHistory);
  }
  if (historyClearBtn) {
    historyClearBtn.addEventListener('click', function() {
      vscode.postMessage({ type: 'clearSessions' });
      sessions = [];
      renderHistory();
    });
  }
  if (historySearch) {
    historySearch.addEventListener('input', function() {
      filterHistory(this.value);
    });
  }

  function filterHistory(query) {
    if (!historyList) return;
    var items = historyList.querySelectorAll('.history-item');
    var q = (query || '').toLowerCase();
    for (var i = 0; i < items.length; i++) {
      var title = items[i].querySelector('.history-item-title');
      if (title) {
        items[i].style.display = title.textContent.toLowerCase().indexOf(q) >= 0 ? 'flex' : 'none';
      }
    }
  }

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

      case 'tool-error':
        var errEl = messagesEl.querySelector('.tool-call[data-tool="' + escAttr(m.name) + '"]:last-child');
        if (errEl) failToolCall(errEl, m.error || 'Tool call failed');
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
        newSession();
        break;

      case 'config':
        if (m.model) {
          configSettings.model = m.model;
          updateStatusModel(m.model);
        }
        if (m.ws) {
          updateStatusTokens(0);
        }
        if (m.inlineComplete !== undefined) {
          // Store inline completion state
        }
        setConnectionStatus('connected');
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
        if (m.model) updateStatusModel(m.model);
        if (m.tokens !== undefined) updateStatusTokens(m.tokens);
        if (m.connection) setConnectionStatus(m.connection);
        if (m.contextPercentage !== undefined) {
          setContextProgress(m.contextPercentage, m.isPruned);
        }
        break;

      case 'sessions':
        sessions = m.sessions || [];
        currentSessionId = m.currentSessionId || null;
        if (historySidebar.classList.contains('open')) {
          renderHistory();
        }
        break;

      case 'diff':
        // Insert diff preview into the last assistant message
        var lastAssistant = messagesEl.querySelector('.msg-assistant:last-child .msg-content');
        if (lastAssistant) {
          var diffEl = showDiff(m.content, m.filePath);
          diffEl._diffFile = m.filePath || '';
          lastAssistant.appendChild(diffEl);
          scrollBottom();
        }
        break;

      case 'tokenCount':
        updateStatusTokens(m.count || 0);
        break;

      case 'connectionChange':
        setConnectionStatus(m.status || 'disconnected');
        break;
    }
  });

  // ─── Init ────────────────────────────────────────

  vscode.postMessage({ type: 'ready' });
  setConnectionStatus('connected');

})();
