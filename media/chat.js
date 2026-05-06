/* ============================================
   Win7 AI Coder v3 — Chat Panel (Agent Mode)
   ============================================ */

(function() {
  var vscode = acquireVsCodeApi();
  var isBusy = false;
  var contextData = null;

  var messagesEl = document.getElementById('messages');
  var inputEl = document.getElementById('input');
  var sendBtn = document.getElementById('btn-send');
  var contextBar = document.getElementById('context-bar');
  var contextLabel = document.getElementById('context-label');
  var btnClear = document.getElementById('btn-clear');
  var btnConfig = document.getElementById('btn-config');
  var btnRemoveCtx = document.getElementById('btn-remove-context');

  // ─── Escape ──────────────────────────────────────
  function esc(str) {
    if (!str) return '';
    var d = document.createElement('div');
    d.appendChild(document.createTextNode(str));
    return d.innerHTML;
  }

  function escAttr(str) {
    return (str || '').replace(/"/g, '&quot;');
  }

  // ─── Markdown (simple) ───────────────────────────
  function md(html) {
    if (!html) return '';
    html = esc(html);
    html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, function(m, lang, code) {
      return '<div class="code-header"><span>' + esc(lang || 'code') + '</span>' +
             '<button class="copy-btn" onclick="__cc(this)">\u{1F4CB} 复制</button></div>' +
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

  window.__cc = function(btn) {
    var pre = (btn.parentElement || {}).nextElementSibling;
    if (!pre || pre.tagName !== 'PRE') return;
    var code = pre.textContent || '';
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(code).then(function() { setCp(btn); }, function() { fc(code, btn); });
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
    try { document.execCommand('copy'); setCp(btn); } catch(e) { btn.textContent = '\u274C'; }
    document.body.removeChild(ta);
  }

  function setCp(btn) {
    btn.textContent = '\u2705 已复制';
    setTimeout(function() { btn.textContent = '\u{1F4CB} 复制'; }, 1500);
  }

  // ─── DOM helpers ─────────────────────────────────

  function addMsg(role) {
    var w = messagesEl.querySelector('.welcome');
    if (w) w.remove();

    var d = document.createElement('div');
    d.className = 'msg msg-' + role;
    var lbl = document.createElement('div');
    lbl.className = 'msg-label';
    var labels = { user: '\u{1F464} 你', assistant: '\u{1F916} AI', tool: '\u{1F527} 工具', error: '\u274C 错误' };
    lbl.textContent = labels[role] || role;
    d.appendChild(lbl);
    var c = document.createElement('div');
    c.className = 'msg-content';
    d.appendChild(c);
    messagesEl.appendChild(d);
    return { w: d, c: c };
  }

  function scrollBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // ─── Tool call progress ──────────────────────────

  function addToolStart(name, args, preview) {
    var w = messagesEl.querySelector('.welcome');
    if (w) w.remove();

    var d = document.createElement('div');
    d.className = 'tool-call';
    d.setAttribute('data-tool', name);
    var iconMap = {
      read_file: '\u{1F4D6}', write_file: '\u270F\uFE0F',
      list_dir: '\u{1F4C2}', search_code: '\u{1F50D}',
      run_terminal: '\u2328\uFE0F'
    };
    d.innerHTML =
      '<div class="tool-header">' +
      '  <span class="tool-icon">' + (iconMap[name] || '\u{1F527}') + '</span>' +
      '  <span class="tool-name">' + esc(name) + '</span>' +
      '  <span class="tool-spinner">\u23F3</span>' +
      '</div>' +
      '<div class="tool-args">' + esc(preview) + '</div>' +
      '<div class="tool-result" style="display:none;"></div>';
    messagesEl.appendChild(d);
    scrollBottom();
    return d;
  }

  function finishToolStart(d, result) {
    var spinner = d.querySelector('.tool-spinner');
    if (spinner) spinner.textContent = '\u2705';
    var resDiv = d.querySelector('.tool-result');
    if (resDiv) {
      resDiv.style.display = 'block';
      resDiv.textContent = result.substring(0, 600);
    }
    scrollBottom();
  }

  // ─── Send ────────────────────────────────────────

  function send() {
    var text = inputEl.value.trim();
    if (!text || isBusy) return;

    addMsg('user').c.textContent = text;
    scrollBottom();
    inputEl.value = '';
    sendBtn.disabled = true;
    updateHeight();
    isBusy = true;

    vscode.postMessage({
      type: 'chat',
      text: text,
      fileContext: contextData ? contextData.fileContent || '' : ''
    });
  }

  // ─── Event handlers ──────────────────────────────

  inputEl.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  inputEl.addEventListener('input', function() {
    sendBtn.disabled = !inputEl.value.trim() || isBusy;
    updateHeight();
  });
  function updateHeight() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
  }
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
        // Already shown by send(), no-op
        break;

      case 'tool-start':
        addToolStart(m.name, m.args, m.preview || '');
        break;

      case 'tool-end':
        var el = messagesEl.querySelector('.tool-call[data-tool="' + escAttr(m.name) + '"]:last-child');
        if (el) finishToolStart(el, m.result || '');
        break;

      case 'assistant':
        var am = addMsg('assistant');
        am.c.innerHTML = md(m.content || '');
        scrollBottom();
        break;

      case 'agent-start':
        // Show thinking indicator
        break;

      case 'agent-end':
        isBusy = false;
        sendBtn.disabled = !inputEl.value.trim();
        break;

      case 'error':
        var em = addMsg('error');
        em.c.innerHTML = md(m.content || 'Unknown error');
        isBusy = false;
        sendBtn.disabled = !inputEl.value.trim();
        scrollBottom();
        break;

      case 'cleared':
        messagesEl.innerHTML =
          '<div class="welcome">' +
          '  <div class="welcome-icon">\u{1F916}</div>' +
          '  <div class="welcome-title">Win7 AI Coder v3</div>' +
          '  <div class="welcome-sub">Agent mode \u2014 \u8BFB\u9879\u76EE \u2192 \u5206\u6790 \u2192 \u521B\u5EFA\u6587\u4EF6 \u2192 \u5199\u4EE3\u7801</div>' +
          '</div>';
        break;

      case 'config':
        // Not used currently
        break;

      case 'contextSet':
        contextData = { fileContent: m.fileContent || '', label: m.label || '' };
        contextBar.style.display = 'flex';
        contextLabel.textContent = m.label || '';
        break;

      case 'status':
        break;
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
