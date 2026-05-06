/**
 * Win7 AI Coder v3 — VSCode Extension with Codex-style Agent Loop
 * =================================================================
 *
 * 架构:
 *   Webview ← postMessage → Agent Loop → DeepSeek API (tool calling) → 读/写/搜文件
 *
 * 支持的 DeepSeek 模型:
 *   deepseek-chat       → V4 Flash (快速，代码场景推荐)
 *   deepseek-reasoner   → R1 (深度推理)
 *
 * 兼容 VSCode 1.69 / Node 12.x (无可选链、无模板字符串)
 */

const vscode = require('vscode');
const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

// ─── 全局 ─────────────────────────────────────────────
var chatPanel = null;
var chatHistory = [];
var extensionContext = null;
var workspaceRoot = '';

// ─── 工具定义 (OpenAI function-calling 格式) ──────────

var TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file. Returns the file content with line numbers.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or relative path to the file' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create a new file or overwrite an existing file with the given content.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to write the file' },
          content: { type: 'string', description: 'Full file content to write' }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List files and subdirectories in a directory.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path (defaults to workspace root)' }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_code',
      description: 'Search for text or regex pattern in project files.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Text or regex pattern to search for' },
          path: { type: 'string', description: 'Directory to search in (defaults to workspace)' },
          file_glob: { type: 'string', description: 'Optional file glob filter, e.g. *.py' }
        },
        required: ['pattern']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_terminal',
      description: 'Execute a shell command and return its output.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to run' },
          cwd: { type: 'string', description: 'Working directory (defaults to workspace)' }
        },
        required: ['command']
      }
    }
  }
];

var SYSTEM_PROMPT = (
  'You are an AI coding assistant integrated into VSCode. You have access to tools that let you '
  + 'read files, write files, search code, list directories, and run terminal commands.\n\n'
  + 'Rules:\n'
  + '- Proactively use tools to understand the codebase before answering.\n'
  + '- When asked to implement a feature, use write_file to create or modify files.\n'
  + '- When asked a question about code, use read_file or search_code first.\n'
  + '- Run terminal commands (git status, npm install, pytest, etc.) when needed.\n'
  + '- Give clear explanations of what you did and why.\n'
  + '- Keep responses professional and helpful.'
);

// ─── 配置 ────────────────────────────────────────────

function getConfig() {
  var cfg = vscode.workspace.getConfiguration('win7-ai-coder');
  var provider = cfg.get('provider', 'openai');
  var apiKey = cfg.get('openaiApiKey', 'not-needed');
  var baseUrl = cfg.get('openaiBaseUrl', 'http://localhost:8080/v1');
  var model = cfg.get('openaiModel', 'deepseek-chat');

  return {
    provider: provider,
    apiUrl: baseUrl.replace(/\/+$/, '') + '/chat/completions',
    model: model,
    apiKey: apiKey,
    maxTokens: cfg.get('maxTokens', 8192),
    temperature: cfg.get('temperature', 0.0),
    streaming: cfg.get('enableStreaming', true),
    maxToolRounds: 15
  };
}

// ─── 工具执行器 ──────────────────────────────────────

function resolvePath(p) {
  if (!p) return workspaceRoot || process.cwd();
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return p;
  var base = workspaceRoot || process.cwd();
  return path.join(base, p);
}

function executeTool(name, args, panel) {
  var result;
  try {
    switch (name) {
      case 'read_file':
        result = toolReadFile(resolvePath(args.path || ''));
        break;
      case 'write_file':
        result = toolWriteFile(resolvePath(args.path || ''), args.content || '');
        break;
      case 'list_dir':
        result = toolListDir(resolvePath(args.path || workspaceRoot));
        break;
      case 'search_code':
        result = toolSearchCode(args.pattern || '', resolvePath(args.path || workspaceRoot), args.file_glob || '');
        break;
      case 'run_terminal':
        result = toolRunTerminal(args.command || '', resolvePath(args.cwd || workspaceRoot));
        break;
      default:
        result = '[error] Unknown tool: ' + name;
    }
  } catch (e) {
    result = '[error] Tool execution failed: ' + (e.message || e.toString());
  }
  return result;
}

function toolReadFile(filePath) {
  if (!fs.existsSync(filePath)) return '[error] File not found: ' + filePath;
  var stat = fs.statSync(filePath);
  if (stat.isDirectory()) return '[error] Path is a directory: ' + filePath;
  if (stat.size > 500 * 1024) return '[error] File too large (' + (stat.size / 1024).toFixed(0) + ' KB)';
  var content = fs.readFileSync(filePath, 'utf-8');
  var lines = content.split('\n');
  var out = '';
  for (var i = 0; i < lines.length; i++) {
    out += (i + 1) + '\t' + lines[i] + '\n';
  }
  return out;
}

function toolWriteFile(filePath, content) {
  var dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
  return '[ok] File written: ' + filePath + ' (' + content.length + ' chars)';
}

function toolListDir(dirPath) {
  if (!fs.existsSync(dirPath)) return '[error] Directory not found: ' + dirPath;
  var entries = fs.readdirSync(dirPath);
  var out = 'Directory: ' + dirPath + '\n\n';
  var dirs = [];
  var files = [];
  for (var i = 0; i < entries.length; i++) {
    var name = entries[i];
    if (name.startsWith('.')) continue;
    var full = path.join(dirPath, name);
    try {
      var st = fs.statSync(full);
      if (st.isDirectory()) {
        dirs.push('  [DIR]  ' + name + '/');
      } else {
        var sz = st.size > 1024 ? (st.size / 1024).toFixed(1) + 'K' : st.size + 'B';
        files.push('  [FILE] ' + name + '  (' + sz + ')');
      }
    } catch(e) {}
  }
  out += dirs.join('\n') + '\n' + files.join('\n');
  if (out.length > 4000) out = out.substring(0, 4000) + '\n... (truncated)';
  return out;
}

function toolSearchCode(pattern, dirPath, fileGlob) {
  if (!fs.existsSync(dirPath)) return '[error] Directory not found: ' + dirPath;
  var results = [];
  var excludeDirs = { '.git':1, 'node_modules':1, '__pycache__':1, '.hg':1, '.svn':1,
                      'venv':1, '.venv':1, 'env':1, 'dist':1, 'build':1, '.idea':1, '.vscode':1 };
  var excludeExts = { '.png':1, '.jpg':1, '.gif':1, '.zip':1, '.tar':1, '.gz':1,
                      '.exe':1, '.dll':1, '.so':1, '.pyc':1, '.bin':1, '.pdf':1 };

  function walk(dir) {
    if (results.length >= 100) return;
    try {
      var items = fs.readdirSync(dir);
      for (var i = 0; i < items.length; i++) {
        if (results.length >= 100) return;
        var name = items[i];
        if (name.startsWith('.')) continue;
        var full = path.join(dir, name);
        try {
          var st = fs.statSync(full);
          if (st.isDirectory()) {
            if (!excludeDirs[name]) walk(full);
          } else {
            var ext = path.extname(name).toLowerCase();
            if (excludeExts[ext]) continue;
            if (fileGlob && !matchGlob(name, fileGlob)) continue;
            if (st.size > 200 * 1024) continue;
            try {
              var content = fs.readFileSync(full, 'utf-8');
              var lines = content.split('\n');
              for (var j = 0; j < lines.length; j++) {
                if (lines[j].toLowerCase().indexOf(pattern.toLowerCase()) >= 0) {
                  results.push(full + ':' + (j + 1) + '  ' + lines[j].trim().substring(0, 150));
                  if (results.length >= 100) return;
                }
              }
            } catch(e2) {}
          }
        } catch(e3) {}
      }
    } catch(e4) {}
  }
  walk(dirPath);
  if (results.length === 0) return 'No matches found for "' + pattern + '"';
  return 'Found ' + results.length + ' matches:\n\n' + results.join('\n');
}

function matchGlob(name, glob) {
  var re = '^' + glob.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$';
  return new RegExp(re, 'i').test(name);
}

function toolRunTerminal(command, cwd) {
  var dir = cwd || workspaceRoot || process.cwd();
  try {
    var out = cp.execSync(command, { cwd: dir, timeout: 30000, encoding: 'utf-8', maxBuffer: 500 * 1024 });
    var output = out.toString().trim();
    if (output.length > 3000) output = output.substring(0, 3000) + '\n... (truncated)';
    return '[exit 0]\n' + output;
  } catch (e) {
    var errOut = e.stdout ? e.stdout.toString().trim().substring(0, 1000) : '';
    var errMsg = e.stderr ? e.stderr.toString().trim().substring(0, 1000) : '';
    return '[exit ' + (e.status || 1) + ']\n' + (errOut || errMsg || e.message);
  }
}

// ─── Agent Loop ──────────────────────────────────────

function agentLoop(panel, userText) {
  // Initialize
  if (chatHistory.length === 0) {
    chatHistory.push({ role: 'system', content: SYSTEM_PROMPT });
  }
  chatHistory.push({ role: 'user', content: userText });

  panel.webview.postMessage({ type: 'agent-start' });
  runLoop(panel, 0);
}

function runLoop(panel, round) {
  var cfg = getConfig();
  if (round >= cfg.maxToolRounds) {
    // Force stop
    panel.webview.postMessage({ type: 'error', content: '已超过最大工具轮数 (' + cfg.maxToolRounds + ')，请重述你的问题。' });
    panel.webview.postMessage({ type: 'agent-end' });
    return;
  }

  var payload = {
    model: cfg.model,
    messages: chatHistory,
    max_tokens: cfg.maxTokens,
    temperature: cfg.temperature,
    top_p: 0.95,
    stream: false,       // Agent loop uses non-streaming for tool detection
    tools: TOOLS,
    tool_choice: 'auto'
  };

  var body = JSON.stringify(payload);
  var parsed = url.parse(cfg.apiUrl);
  var isHttps = parsed.protocol === 'https:';

  var headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body, 'utf-8')
  };
  if (cfg.apiKey && cfg.apiKey !== 'not-needed') {
    headers['Authorization'] = 'Bearer ' + cfg.apiKey;
  }

  var options = {
    hostname: parsed.hostname,
    port: parsed.port || (isHttps ? 443 : 80),
    path: parsed.path,
    method: 'POST',
    headers: headers,
    timeout: 180000
  };

  var transport = isHttps ? https : http;
  var req = transport.request(options, function(res) {
    var responseBody = '';
    res.on('data', function(d) { responseBody += d; });
    res.on('end', function() {
      if (res.statusCode !== 200) {
        var errMsg = 'HTTP ' + res.statusCode;
        try {
          var ej = JSON.parse(responseBody);
          var em = (ej.error && ej.error.message) || '';
          if (em) errMsg = em;
        } catch(e) {}
        chatHistory.pop(); // Remove the failed user message
        panel.webview.postMessage({ type: 'error', content: errMsg });
        panel.webview.postMessage({ type: 'agent-end' });
        return;
      }

      try {
        var data = JSON.parse(responseBody);
      } catch(e) {
        panel.webview.postMessage({ type: 'error', content: 'JSON parse error from API' });
        panel.webview.postMessage({ type: 'agent-end' });
        return;
      }

      var msg = data.choices && data.choices[0] ? data.choices[0].message : null;
      if (!msg) {
        panel.webview.postMessage({ type: 'error', content: 'API returned empty response' });
        panel.webview.postMessage({ type: 'agent-end' });
        return;
      }

      // Check for tool calls
      var toolCalls = msg.tool_calls;
      if (toolCalls && toolCalls.length > 0) {
        // Add assistant message with tool calls
        var assistantMsg = { role: 'assistant', content: msg.content || null };
        assistantMsg.tool_calls = toolCalls;
        chatHistory.push(assistantMsg);

        // Execute all tools sequentially
        var toolsToRun = toolCalls.slice(); // copy
        executeToolsSequentially(panel, toolsToRun, 0, function() {
          runLoop(panel, round + 1);
        });
        return;
      }

      // Text response — stream it
      chatHistory.push({ role: 'assistant', content: msg.content || '' });
      panel.webview.postMessage({ type: 'assistant', content: msg.content || '' });
      panel.webview.postMessage({ type: 'agent-end' });
    });
  });

  req.on('error', function(e) {
    panel.webview.postMessage({ type: 'error', content: 'Connection error: ' + e.message });
    panel.webview.postMessage({ type: 'agent-end' });
  });
  req.write(body);
  req.end();
}

function executeToolsSequentially(panel, toolCalls, index, done) {
  if (index >= toolCalls.length) {
    done();
    return;
  }

  var tc = toolCalls[index];
  var fn = tc.function;
  var name = fn.name;
  var args = {};
  try {
    args = JSON.parse(fn.arguments);
  } catch(e) {
    args = {};
  }

  // Notify webview
  var preview = name + ' ' + JSON.stringify(args).substring(0, 80);
  panel.webview.postMessage({ type: 'tool-start', name: name, args: args, preview: preview });

  // Execute
  var result = executeTool(name, args, panel);

  // Notify webview
  panel.webview.postMessage({ type: 'tool-end', name: name, result: result.substring(0, 500) });

  // Add tool result to history
  chatHistory.push({
    role: 'tool',
    tool_call_id: tc.id,
    content: result
  });

  // Small delay before next tool
  setTimeout(function() {
    executeToolsSequentially(panel, toolCalls, index + 1, done);
  }, 100);
}

// ─── Webview HTML ────────────────────────────────────

function getWebviewHTML(webview) {
  var cssUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionContext.extensionUri, 'media', 'chat.css')
  );
  var jsUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionContext.extensionUri, 'media', 'chat.js')
  );

  return '<!DOCTYPE html>\n' +
'<html lang="zh-CN">\n' +
'<head>\n' +
'<meta charset="UTF-8">\n' +
'<meta http-equiv="Content-Security-Policy"\n' +
'      content="default-src \'none\';\n' +
'               style-src ' + webview.cspSource + ' \'unsafe-inline\';\n' +
'               script-src ' + webview.cspSource + ' \'unsafe-inline\';">\n' +
'<link rel="stylesheet" href="' + cssUri + '">\n' +
'<title>AI Agent</title>\n' +
'</head>\n' +
'<body>\n' +
'  <div id="container">\n' +
'    <div id="header">\n' +
'      <span class="header-title">\u{1F916} AI Agent</span>\n' +
'      <div class="header-actions">\n' +
'        <button id="btn-clear" class="icon-btn" title="清除">\u{1F5D1}</button>\n' +
'        <button id="btn-config" class="icon-btn" title="附加文件">\u{1F4CE}</button>\n' +
'      </div>\n' +
'    </div>\n' +
'    <div id="messages">\n' +
'      <div class="welcome">\n' +
'        <div class="welcome-icon">\u{1F916}</div>\n' +
'        <div class="welcome-title">Win7 AI Coder v3</div>\n' +
'        <div class="welcome-sub">Agent mode — 读项目 \u2192 分析 \u2192 创建文件 \u2192 写代码</div>\n' +
'        <div class="welcome-hints">\n' +
'          <div class="hint"><span class="hint-key">\u{1F4C2}</span> 加载工程后直接说\"帮我做一个xxx\"</div>\n' +
'          <div class="hint"><span class="hint-key">\u{1F527}</span> AI 会自动读代码、创建文件、执行命令</div>\n' +
'          <div class="hint"><span class="hint-key">\u231B</span> 左侧观察工具调用过程</div>\n' +
'        </div>\n' +
'      </div>\n' +
'    </div>\n' +
'    <div id="input-area">\n' +
'      <div id="context-bar" style="display:none;">\n' +
'        <span id="context-label"></span>\n' +
'        <button id="btn-remove-context" class="small-btn">&times;</button>\n' +
'      </div>\n' +
'      <div id="input-row">\n' +
'        <textarea id="input" rows="2" placeholder="告诉我你要做什么，我来读项目、写代码... (Enter 发送)"></textarea>\n' +
'        <button id="btn-send" class="send-btn" disabled>\u25B6</button>\n' +
'      </div>\n' +
'    </div>\n' +
'  </div>\n' +
'  <script src="' + jsUri + '"></script>\n' +
'</body>\n' +
'</html>';
}

// ─── Webview 消息分发 ────────────────────────────────

function handleWebviewMessage(panel, message) {
  switch (message.type) {
    case 'chat':
      handleChat(panel, message);
      break;
    case 'clear':
      chatHistory = [];
      panel.webview.postMessage({ type: 'cleared' });
      break;
    case 'ready':
      var cfg = getConfig();
      panel.webview.postMessage({
        type: 'config',
        model: cfg.model,
        ws: workspaceRoot || '(无工作区)'
      });
      break;
    case 'attachFile':
      attachCurrentFile(panel);
      break;
  }
}

function handleChat(panel, message) {
  var text = (message.text || '').trim();
  if (!text) return;

  // Attach workspace info if first message
  if (chatHistory.length === 0 && workspaceRoot) {
    text = '[Workspace: ' + workspaceRoot + ']\n\n' + text;
  }

  // Attach file context
  if (message.fileContext) {
    text = 'Context file:\n```\n' + message.fileContext + '\n```\n\nUser request:\n' + text;
  }

  // Show user message
  panel.webview.postMessage({ type: 'user', content: text.substring(0, 500) });

  agentLoop(panel, text);
}

function attachCurrentFile(panel) {
  var editor = vscode.window.activeTextEditor;
  if (!editor) {
    panel.webview.postMessage({ type: 'status', text: '没有打开的文件' });
    return;
  }
  var doc = editor.document;
  var sel = editor.selection;
  var hasSel = !sel.isEmpty;
  var content = hasSel ? doc.getText(sel) : doc.getText();
  var lbl = hasSel
    ? '已选中: ' + doc.fileName.split(/[/\\]/).pop() + ' (' + content.split('\n').length + ' 行)'
    : '已附加: ' + doc.fileName.split(/[/\\]/).pop();

  panel.webview.postMessage({
    type: 'contextSet',
    fileContent: content,
    label: lbl
  });
}

// ─── VSCode 激活 ─────────────────────────────────────

function activate(context) {
  extensionContext = context;
  console.log('Win7 AI Coder v3 (Agent Mode) activated');

  // Detect workspace
  if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
    workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
  }

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('win7-ai-coder.openChat', function() {
      openChatPanel(context);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('win7-ai-coder.askSelection', function() {
      var panel = openChatPanel(context);
      var editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        vscode.window.showWarningMessage('请先选中代码。');
        return;
      }
      var sel = editor.document.getText(editor.selection);
      panel.webview.postMessage({
        type: 'contextSet',
        fileContent: sel,
        label: '已选中: ' + editor.document.fileName.split(/[/\\]/).pop()
      });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('win7-ai-coder.explainCode', function() {
      var panel = openChatPanel(context);
      var editor = vscode.window.activeTextEditor;
      if (!editor) return;
      var content = editor.document.getText();
      var lang = editor.document.languageId || 'code';
      panel.webview.postMessage({
        type: 'contextSet',
        fileContent: content,
        label: '剖析: ' + editor.document.fileName.split(/[/\\]/).pop()
      });
      handleChat(panel, {
        text: '请详细分析项目结构，解释每个文件的作用和它们之间的关系。',
        fileContext: content
      });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('win7-ai-coder.clearChat', function() {
      chatHistory = [];
      if (chatPanel) chatPanel.webview.postMessage({ type: 'cleared' });
    })
  );

  // Sidebar view
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('win7-ai-coder.chatView', {
      resolveWebviewView: function(webviewView) {
        webviewView.webview.options = {
          enableScripts: true,
          localResourceRoots: [
            vscode.Uri.joinPath(context.extensionUri, 'media')
          ]
        };
        webviewView.webview.html = getWebviewHTML(webviewView.webview);
        webviewView.webview.onDidReceiveMessage(function(msg) {
          handleWebviewMessage(
            { webview: webviewView.webview, reveal: function() { webviewView.show(true); } },
            msg
          );
        });
      }
    })
  );

  // Listen for workspace changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(function(e) {
      if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
      }
    })
  );
}

function openChatPanel(context) {
  if (chatPanel) {
    chatPanel.reveal();
    return chatPanel;
  }

  chatPanel = vscode.window.createWebviewPanel(
    'win7-ai-coder.chat',
    'AI Agent',
    vscode.ViewColumn.Two,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.joinPath(context.extensionUri, 'media')
      ]
    }
  );

  chatPanel.webview.html = getWebviewHTML(chatPanel.webview);
  chatPanel.webview.onDidReceiveMessage(function(msg) {
    handleWebviewMessage(chatPanel, msg);
  });
  chatPanel.onDidDispose(function() {
    chatPanel = null;
  });

  return chatPanel;
}

function deactivate() {
  chatPanel = null;
  chatHistory = [];
}

module.exports = { activate: activate, deactivate: deactivate };
