/* ============================================
   Win7 AI Coder — Chat Panel (Webview Script)
   在 VSCode Webview 内运行，通过 postMessage 与扩展通信
   ============================================ */

(function() {
  const vscode = acquireVsCodeApi();

  // ── State ─────────────────────────────────────────
  let isStreaming = false;
  let currentAssistantMsg = null;   // DOM element of current streaming message
  let currentContentDiv = null;
  let contextData = null;            // { fileContent, selection, label }

  // ── DOM refs ─────────────────────────────────────
  const messagesEl = document.getElementById('messages');
  const inputEl = document.getElementById('input');
  const sendBtn = document.getElementById('btn-send');
  const contextBar = document.getElementById('context-bar');
  const contextLabel = document.getElementById('context-label');
  const btnClear = document.getElementById('btn-clear');
  const btnConfig = document.getElementById('btn-config');
  const btnRemoveCtx = document.getElementById('btn-remove-context');
  const typingEl = document.getElementById('typing');

  // ── Markdown Renderer ────────────────────────────
  function escapeHtml(str) {
    if (!str) return '';
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

  function renderMarkdown(text) {
    if (!text) return '';
    var html = escapeHtml(text);

    // Code blocks with language header
    html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, function(m, lang, code) {
      lang = lang || 'code';
      return '<div class="code-header"><span>' + escapeHtml(lang) + '</span>' +
             '<button class="copy-btn" onclick="window.__copyCode(this)">📋 复制</button></div>' +
             '<pre><code class="language-' + escapeHtml(lang) + '">' +
             escapeHtml(code.trim()) + '</code></pre>';
    });

    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Bold, italic
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

    // Triple newline → paragraph break
    html = html.replace(/\n\n+/g, '</p><p>');
    html = html.replace(/\n/g, '<br>');

    // Headers
    html = html.replace(/^### (.+)$/gm, '<h4>$1</h4>');
    html = html.replace(/^## (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^# (.+)$/gm, '<h2>$1</h2>');

    // Wrap in paragraph if not already wrapped
    if (html.indexOf('<p>') !== 0 && html.indexOf('<h') !== 0 &&
        html.indexOf('<div') !== 0 && html.indexOf('<pre') !== 0) {
      html = '<p>' + html + '</p>';
    }

    return html;
  }

  // ── Copy code handler ────────────────────────────
  window.__copyCode = function(btn) {
    var header = btn.parentElement;
    var pre = header.nextElementSibling;
    if (!pre || pre.tagName !== 'PRE') return;
    var code = pre.textContent || '';

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(code).then(function() {
        setCopied(btn);
      }).catch(function() {
        fallbackCopy(code, btn);
      });
    } else {
      fallbackCopy(code, btn);
    }
  };

  function fallbackCopy(text, btn) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      setCopied(btn);
    } catch(e) {
      btn.textContent = '❌';
    }
    document.body.removeChild(ta);
  }

  function setCopied(btn) {
    btn.textContent = '✅ 已复制';
    setTimeout(function() { btn.textContent = '📋 复制'; }, 1500);
  }

  // ── DOM Helpers ──────────────────────────────────

  function createMsgDiv(role) {
    var div = document.createElement('div');
    div.className = 'msg msg-' + role;
    var label = document.createElement('div');
    label.className = 'msg-label';
    label.textContent = role === 'user' ? '你' : (role === 'error' ? '错误' : 'AI');
    div.appendChild(label);

    var content = document.createElement('div');
    content.className = 'msg-content';
    div.appendChild(content);

    return { wrapper: div, content: content };
  }

  function addUserMessage(text) {
    var msg = createMsgDiv('user');
    msg.content.textContent = text;
    messagesEl.appendChild(msg.wrapper);
  }

  function addAssistantMessage() {
    // Remove welcome if present
    var welcome = messagesEl.querySelector('.welcome');
    if (welcome) welcome.remove();

    var msg = createMsgDiv('assistant');
    // Add cursor for streaming
    var cursor = document.createElement('span');
    cursor.className = 'msg-cursor';
    msg.wrapper.appendChild(cursor);
    messagesEl.appendChild(msg.wrapper);

    currentAssistantMsg = msg.wrapper;
    currentContentDiv = msg.content;
    return msg;
  }

  function addErrorMessage(text) {
    var welcome = messagesEl.querySelector('.welcome');
    if (welcome) welcome.remove();

    var msg = createMsgDiv('error');
    msg.content.innerHTML = renderMarkdown(text);
    messagesEl.appendChild(msg.wrapper);
  }

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function clearWelcome() {
    var welcome = messagesEl.querySelector('.welcome');
    if (welcome) welcome.remove();
  }

  function resetChat() {
    messagesEl.innerHTML = '<div class="welcome">' +
      '<div class="welcome-icon">🤖</div>' +
      '<div class="welcome-title">Win7 AI Coder</div>' +
      '<div class="welcome-sub">本地 DeepSeek 编程助手</div>' +
      '<div class="welcome-hints">' +
      '<div class="hint"><span class="hint-key">打开文件</span> 后提问，AI 能直接分析代码</div>' +
      '<div class="hint"><span class="hint-key">选中代码</span> 右键 → Ask AI</div>' +
      '<div class="hint"><span class="hint-key">Ctrl+Shift+P</span> → AI Chat: Explain Code</div>' +
      '</div></div>';
    currentAssistantMsg = null;
    currentContentDiv = null;
    isStreaming = false;
  }

  // ── Send message ─────────────────────────────────

  function sendMessage() {
    var text = inputEl.value.trim();
    if (!text || isStreaming) return;

    addUserMessage(text);
    scrollToBottom();

    inputEl.value = '';
    sendBtn.disabled = true;
    updateInputHeight();

    var msg = addAssistantMessage();
    scrollToBottom();

    isStreaming = true;

    // Send to extension host
    vscode.postMessage({
      type: 'chat',
      text: text,
      fileContext: contextData ? contextData.fileContent : '',
      selection: contextData ? contextData.selection : '',
    });
  }

  // ── Event Handlers ───────────────────────────────

  inputEl.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  inputEl.addEventListener('input', function() {
    sendBtn.disabled = !inputEl.value.trim() || isStreaming;
    updateInputHeight();
  });

  function updateInputHeight() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
  }

  sendBtn.addEventListener('click', sendMessage);

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

  // ── Message from Extension Host ──────────────────

  window.addEventListener('message', function(event) {
    var msg = event.data;

    switch (msg.type) {
      case 'token':
        if (currentContentDiv) {
          // Append raw text during streaming
          var currentText = currentContentDiv.textContent || '';
          currentText += msg.content;
          currentContentDiv.textContent = currentText;
          scrollToBottom();
        }
        break;

      case 'streamEnd':
        isStreaming = false;
        sendBtn.disabled = !inputEl.value.trim();
        if (currentContentDiv && currentAssistantMsg) {
          // Final render with markdown
          var rawText = currentContentDiv.textContent || '';
          currentContentDiv.innerHTML = renderMarkdown(rawText);
          var cursor = currentAssistantMsg.querySelector('.msg-cursor');
          if (cursor) cursor.style.display = 'none';
        }
        scrollToBottom();
        break;

      case 'error':
        isStreaming = false;
        sendBtn.disabled = !inputEl.value.trim();
        if (currentAssistantMsg) {
          currentAssistantMsg.remove();
          currentAssistantMsg = null;
          currentContentDiv = null;
        }
        addErrorMessage(msg.content);
        scrollToBottom();
        break;

      case 'cleared':
        resetChat();
        break;

      case 'streamStart':
        // Handled by addAssistantMessage() in sendMessage()
        break;

      case 'config':
        // Model name shown in UI if needed
        break;

      case 'contextSet':
        contextData = {
          fileContent: msg.fileContent || '',
          selection: msg.selection || '',
          label: msg.label || '文件已附加',
        };
        contextBar.style.display = 'flex';
        contextLabel.textContent = msg.label || '文件已附加';
        break;

      case 'status':
        // Simple status notification
        break;
    }
  });

  // ── Init ─────────────────────────────────────────
  vscode.postMessage({ type: 'ready' });

})();
