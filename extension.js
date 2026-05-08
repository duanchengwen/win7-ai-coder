/* ============================================
   Win7 AI Coder v5 — VSCode Extension
   @-mentions + Slash Commands + Tab Autocomplete
   + Codebase Index + Thinking Animation
   ============================================
   兼容 VSCode 1.69 / Node 12.x
   ============================================ */

var vscode = require('vscode');
var http = require('http');
var https = require('https');
var url = require('url');
var fs = require('fs');
var pathModule = require('path');
var cp = require('child_process');

// ─── 全局 ─────────────────────────────────────────────
var chatPanel = null;
var chatHistory = [];
var extensionContext = null;
var workspaceRoot = '';
var codebaseIndex = null;  // Phase 3: cached codebase index

// ─── 工具定义 ─────────────────────────────────────────

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
      description: 'Search for text or regex pattern in project files (uses prebuilt codebase index if available).',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Text or regex pattern to search for' },
          path: { type: 'string', description: 'Directory or file to search in (defaults to workspace)' },
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
    maxToolRounds: 15,
    enableInlineCompletion: cfg.get('enableInlineCompletion', true),
    inlineCompletionDebounce: cfg.get('inlineCompletionDebounce', 400)
  };
}

function resolvePath(p) {
  if (!p) return workspaceRoot || process.cwd();
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return p;
  var base = workspaceRoot || process.cwd();
  return pathModule.join(base, p);
}

// ─── PHASE 3: Codebase Index ───────────────────────

function getIndexPath() {
  if (!workspaceRoot) return null;
  return pathModule.join(workspaceRoot, '.vscode', 'win7-ai-codebase-index.json');
}

function buildCodebaseIndex(rootDir) {
  var index = { files: {}, tokens: {}, builtAt: Date.now() };

  function walk(dir) {
    try {
      var items = fs.readdirSync(dir);
      for (var i = 0; i < items.length; i++) {
        var name = items[i];
        if (name.startsWith('.')) continue;
        var full = pathModule.join(dir, name);
        try {
          var st = fs.statSync(full);
          if (st.isDirectory()) {
            if (['node_modules','__pycache__','.git','venv','.venv','dist','build','.idea'].indexOf(name) < 0) {
              walk(full);
            }
          } else {
            var ext = pathModule.extname(name).toLowerCase();
            if (['.png','.jpg','.gif','.zip','.exe','.dll','.so','.pyc','.bin','.pdf'].indexOf(ext) >= 0) continue;
            if (st.size > 500 * 1024) continue;
            var relPath = pathModule.relative(rootDir, full);
            var content = fs.readFileSync(full, 'utf-8');
            var lines = content.split('\n');
            index.files[relPath] = { size: st.size, lines: lines.length, mtime: st.mtimeMs };

            // Build keyword inverted index for common words
            var words = content.toLowerCase().split(/[^a-zA-Z0-9_]/);
            var seen = {};
            for (var w = 0; w < words.length; w++) {
              var word = words[w];
              if (word.length < 3 || word.length > 40) continue;
              if (seen[word]) continue;
              seen[word] = true;
              if (!index.tokens[word]) index.tokens[word] = [];
              if (index.tokens[word].length < 20) {
                index.tokens[word].push(relPath);
              }
            }
          }
        } catch(e) {}
      }
    } catch(e) {}
  }

  walk(rootDir);
  return index;
}

function saveCodebaseIndex() {
  var indexPath = getIndexPath();
  if (!indexPath || !workspaceRoot) return;
  try {
    var idx = buildCodebaseIndex(workspaceRoot);
    var dir = pathModule.dirname(indexPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(indexPath, JSON.stringify(idx), 'utf-8');
    codebaseIndex = idx;
    console.log('[Win7 AI] Codebase index built: ' + Object.keys(idx.files).length + ' files');
  } catch(e) {
    console.log('[Win7 AI] Index build failed: ' + e.message);
  }
}

function loadCodebaseIndex() {
  var indexPath = getIndexPath();
  if (!indexPath) return null;
  try {
    if (fs.existsSync(indexPath)) {
      var data = fs.readFileSync(indexPath, 'utf-8');
      var idx = JSON.parse(data);
      codebaseIndex = idx;
      console.log('[Win7 AI] Codebase index loaded: ' + Object.keys(idx.files).length + ' files');
      return idx;
    }
  } catch(e) {}
  return null;
}

function searchIndexedCodebase(pattern, limit) {
  limit = limit || 10;
  if (!codebaseIndex) return null; // Signal to fall back to walk search

  var lowerPattern = pattern.toLowerCase();
  var matchedFiles = {};
  var results = [];
  var count = 0;

  // Exact token match
  if (codebaseIndex.tokens[lowerPattern]) {
    var files = codebaseIndex.tokens[lowerPattern];
    for (var i = 0; i < files.length && count < limit; i++) {
      var f = files[i];
      if (!matchedFiles[f]) {
        matchedFiles[f] = true;
        count++;
        var filePath = pathModule.join(workspaceRoot, f);
        try {
          var content = fs.readFileSync(filePath, 'utf-8');
          var lines = content.split('\n');
          for (var j = 0; j < lines.length; j++) {
            if (lines[j].toLowerCase().indexOf(lowerPattern) >= 0) {
              results.push(f + ':' + (j + 1) + '  ' + lines[j].trim().substring(0, 100));
              break;
            }
          }
        } catch(e) {}
      }
    }
  }

  // Partial token match (prefix/suffix)
  if (results.length < limit) {
    for (var token in codebaseIndex.tokens) {
      if (results.length >= limit) break;
      if (matchedFiles[token]) continue;
      if (token.indexOf(lowerPattern) >= 0) {
        var files2 = codebaseIndex.tokens[token];
        for (var k = 0; k < files2.length && results.length < limit; k++) {
          var f2 = files2[k];
          if (!matchedFiles[f2]) {
            matchedFiles[f2] = true;
            var filePath2 = pathModule.join(workspaceRoot, f2);
            try {
              var content2 = fs.readFileSync(filePath2, 'utf-8');
              var lines2 = content2.split('\n');
              for (var l = 0; l < lines2.length; l++) {
                if (lines2[l].toLowerCase().indexOf(lowerPattern) >= 0) {
                  results.push(f2 + ':' + (l + 1) + '  ' + lines2[l].trim().substring(0, 100));
                  break;
                }
              }
            } catch(e) {}
          }
        }
      }
    }
  }

  return results.length > 0 ? results : null;
}

// ─── PHASE 2: Inline Completion Provider ──────────

var completionDebounceTimer = null;
var lastCompletionRequest = 0;

function InlineCompletionProvider() {}
InlineCompletionProvider.prototype.provideInlineCompletionItems = function(document, position, context, token) {
  var cfg = getConfig();
  if (!cfg.enableInlineCompletion) return [];

  var now = Date.now();
  var debounceMs = cfg.inlineCompletionDebounce;

  // Debounce: skip if we just made a request
  if (now - lastCompletionRequest < debounceMs) return [];

  // Only suggest on new line or after typing/backspace
  if (context.triggerKind === 0) return []; // Invoke: don't suggest on explicit invocation
  // Actually 0 = Invoke, 1 = Auto. We want to trigger on Auto.
  if (context.triggerKind !== 1) return [];

  // Get context: current line prefix
  var linePrefix = document.lineAt(position.line).text.substring(0, position.character);
  var lineText = document.lineAt(position.line).text;

  // Skip if line is empty or only whitespace within a block
  var trimmed = lineText.trim();
  if (!trimmed || trimmed === '{' || trimmed === '(' || trimmed === '[') return [];

  // Skip if in a comment only line
  if (trimmed.indexOf('//') === 0 || trimmed.indexOf('#') === 0 || trimmed.indexOf('--') === 0) return [];

  // Get context above (last 5 lines)
  var contextLines = [];
  var startLine = Math.max(0, position.line - 5);
  for (var i = startLine; i < position.line; i++) {
    contextLines.push(document.lineAt(i).text);
  }
  contextLines.push(linePrefix);

  var contextStr = contextLines.join('\n');
  var lang = document.languageId || 'text';

  // Build quick prompt for inline completion
  var prompt = 'Complete the current line of code (only respond with the completion text, NO explanations, NO code fences):\n\n'
    + '```' + lang + '\n' + contextStr + '\n```\n\n'
    + 'Complete after: "' + linePrefix + '"\n\n'
    + 'Return ONLY the completion text that follows "' + linePrefix + '". No markdown. No explanation.';

  // We need to return a Promise<InlineCompletionItem[]> but Node 12 doesn't have Promise.
  // VSCode API in 1.69 supports thenable (an object with .then()), which is Promise-compatible
  // but we can also use a simple Thenable polyfill.
  // Since the extension host supports Promises even in Node 12 (VSCode provides its own),
  // let's use the callback approach instead.

  var result = [];
  lastCompletionRequest = now;

  // Send async request to API
  var self = this;
  makeInlineCompletionRequest(prompt, function(error, completionText) {
    if (!error && completionText) {
      // Clean up the completion
      completionText = completionText.trim();
      // Remove code fences if the model added them
      completionText = completionText.replace(/^```[\w]*\n?/, '');
      completionText = completionText.replace(/\n?```$/, '');
      // Remove line prefix if model included it
      if (completionText.indexOf(linePrefix) === 0) {
        completionText = completionText.substring(linePrefix.length);
      }
      // Remove leading/trailing whitespace for inline
      completionText = completionText.replace(/^\s+/, '');
      if (completionText) {
        result.push(new vscode.InlineCompletionItem(completionText));
      }
    }
  });

  // Return a thenable (Promise-compatible object)
  return {
    then: function(resolve, reject) {
      // Wait for async completion
      var check = function() {
        if (result.length > 0) {
          resolve(result);
        } else {
          setTimeout(check, 50);
        }
      };
      // Timeout after 3 seconds
      var timeout = setTimeout(function() {
        resolve([]);
      }, 3000);
      check();
    }
  };
};

function makeInlineCompletionRequest(prompt, callback) {
  var cfg = getConfig();

  var payload = {
    model: cfg.model,
    messages: [
      { role: 'system', content: 'You are a code completion engine. Your only job is to complete the current line of code. Return ONLY the completion text. Do NOT include the existing text. Do NOT wrap in code fences. Do NOT explain.' },
      { role: 'user', content: prompt }
    ],
    max_tokens: 64,
    temperature: 0.1,
    top_p: 0.9,
    stream: false
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
    timeout: 5000
  };

  var transport = isHttps ? https : http;
  var req = transport.request(options, function(res) {
    var responseBody = '';
    res.on('data', function(d) { responseBody += d; });
    res.on('end', function() {
      if (res.statusCode !== 200) {
        callback(new Error('HTTP ' + res.statusCode), null);
        return;
      }
      try {
        var data = JSON.parse(responseBody);
        var content = data.choices && data.choices[0] && data.choices[0].message
          ? data.choices[0].message.content : '';
        callback(null, content || '');
      } catch(e) {
        callback(e, null);
      }
    });
  });

  req.on('error', function(e) {
    callback(e, null);
  });
  req.write(body);
  req.end();
}

// ─── 工具执行器 ──────────────────────────────────────

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
        // Phase 3: Try indexed search first, fall back to walk
        var indexed = null;
        if (codebaseIndex && !args.file_glob) {
          indexed = searchIndexedCodebase(args.pattern || '', 20);
        }
        if (indexed) {
          result = 'Found ' + indexed.length + ' matches (indexed):\n\n' + indexed.join('\n');
        } else {
          result = toolSearchCode(args.pattern || '', resolvePath(args.path || workspaceRoot), args.file_glob || '');
        }
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
  var dir = pathModule.dirname(filePath);
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
    var full = pathModule.join(dirPath, name);
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
        var full = pathModule.join(dir, name);
        try {
          var st = fs.statSync(full);
          if (st.isDirectory()) {
            if (!excludeDirs[name]) walk(full);
          } else {
            var ext = pathModule.extname(name).toLowerCase();
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
  if (chatHistory.length === 0) {
    chatHistory.push({ role: 'system', content: SYSTEM_PROMPT });
  }
  chatHistory.push({ role: 'user', content: userText });

  // Phase 4: Send thinking start
  panel.webview.postMessage({ type: 'thinking-start' });
  panel.webview.postMessage({ type: 'agent-start' });
  runLoop(panel, 0);
}

function runLoop(panel, round) {
  var cfg = getConfig();
  if (round >= cfg.maxToolRounds) {
    panel.webview.postMessage({ type: 'error', content: 'Tool round limit reached (' + cfg.maxToolRounds + '). Please rephrase your request.' });
    panel.webview.postMessage({ type: 'agent-end' });
    panel.webview.postMessage({ type: 'thinking-end' });
    return;
  }

  // Phase 4: Update thinking message with current round
  panel.webview.postMessage({
    type: 'thinking-update',
    content: 'Thinking... (round ' + (round + 1) + '/' + cfg.maxToolRounds + ')'
  });

  var payload = {
    model: cfg.model,
    messages: chatHistory,
    max_tokens: cfg.maxTokens,
    temperature: cfg.temperature,
    top_p: 0.95,
    stream: false,
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
        chatHistory.pop();
        panel.webview.postMessage({ type: 'error', content: errMsg });
        panel.webview.postMessage({ type: 'agent-end' });
        panel.webview.postMessage({ type: 'thinking-end' });
        return;
      }

      try {
        var data = JSON.parse(responseBody);
      } catch(e) {
        panel.webview.postMessage({ type: 'error', content: 'JSON parse error from API' });
        panel.webview.postMessage({ type: 'agent-end' });
        panel.webview.postMessage({ type: 'thinking-end' });
        return;
      }

      var msg = data.choices && data.choices[0] ? data.choices[0].message : null;
      if (!msg) {
        panel.webview.postMessage({ type: 'error', content: 'API returned empty response' });
        panel.webview.postMessage({ type: 'agent-end' });
        panel.webview.postMessage({ type: 'thinking-end' });
        return;
      }

      // Phase 4: Show reasoning if available (some models return reasoning_content)
      if (msg.reasoning_content) {
        panel.webview.postMessage({
          type: 'reasoning',
          content: msg.reasoning_content
        });
      }

      // Check for tool calls
      var toolCalls = msg.tool_calls;
      if (toolCalls && toolCalls.length > 0) {
        var assistantMsg = { role: 'assistant', content: msg.content || null };
        assistantMsg.tool_calls = toolCalls;
        chatHistory.push(assistantMsg);

        var toolsToRun = toolCalls.slice();
        executeToolsSequentially(panel, toolsToRun, 0, function() {
          runLoop(panel, round + 1);
        });
        return;
      }

      // Text response
      chatHistory.push({ role: 'assistant', content: msg.content || '' });
      panel.webview.postMessage({ type: 'assistant', content: msg.content || '' });
      panel.webview.postMessage({ type: 'agent-end' });
      panel.webview.postMessage({ type: 'thinking-end' });
    });
  });

  req.on('error', function(e) {
    panel.webview.postMessage({ type: 'error', content: 'Connection error: ' + e.message });
    panel.webview.postMessage({ type: 'agent-end' });
    panel.webview.postMessage({ type: 'thinking-end' });
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

  // Phase 4: Show thinking update with current tool
  panel.webview.postMessage({
    type: 'thinking-update',
    content: 'Running: ' + name + '...'
  });

  var preview = name + ' ' + JSON.stringify(args).substring(0, 80);
  panel.webview.postMessage({ type: 'tool-start', name: name, args: args, preview: preview });

  var result = executeTool(name, args, panel);

  panel.webview.postMessage({ type: 'tool-end', name: name, result: result.substring(0, 500) });

  chatHistory.push({
    role: 'tool',
    tool_call_id: tc.id,
    content: result
  });

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
'<html lang="en">\n' +
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
'    <!-- Header with dropdown menu -->\n' +
'    <div id="header">\n' +
'      <div class="header-left">\n' +
'        <span class="header-title">\u{1F916} AI Agent</span>\n' +
'      </div>\n' +
'      <div class="header-actions">\n' +
'        <button id="btn-clear" class="icon-btn" title="Clear conversation">\u{1F5D1}</button>\n' +
'        <button id="btn-config" class="icon-btn" title="Attach file">\u{1F4CE}</button>\n' +
'        <button id="btn-menu" class="icon-btn" title="Menu">\u{22EF}</button>\n' +
'      </div>\n' +
'      <!-- Dropdown menu -->\n' +
'      <div id="header-dropdown">\n' +
'        <div id="dd-new-session" class="dropdown-item">\n' +
'          <span class="dropdown-icon">\u{2795}</span>\n' +
'          <span class="dropdown-label">New Session</span>\n' +
'        </div>\n' +
'        <div id="dd-settings" class="dropdown-item">\n' +
'          <span class="dropdown-icon">\u{2699}\uFE0F</span>\n' +
'          <span class="dropdown-label">Settings</span>\n' +
'          <span class="dropdown-shortcut">Ctrl+,</span>\n' +
'        </div>\n' +
'        <div id="dd-history" class="dropdown-item">\n' +
'          <span class="dropdown-icon">\u{1F4CB}</span>\n' +
'          <span class="dropdown-label">History</span>\n' +
'          <span class="dropdown-shortcut">Ctrl+H</span>\n' +
'        </div>\n' +
'        <div id="dd-rebuild" class="dropdown-item">\n' +
'          <span class="dropdown-icon">\u{1F504}</span>\n' +
'          <span class="dropdown-label">Rebuild Index</span>\n' +
'        </div>\n' +
'        <div id="dd-clear-all" class="dropdown-item">\n' +
'          <span class="dropdown-icon">\u{1F5D1}\uFE0F</span>\n' +
'          <span class="dropdown-label">Clear All</span>\n' +
'        </div>\n' +
'      </div>\n' +
'    </div>\n' +
'\n' +
'    <!-- Messages area -->\n' +
'    <div id="messages">\n' +
'      <div class="welcome">\n' +
'        <div class="welcome-icon">\u{1F916}</div>\n' +
'        <div class="welcome-title">Win7 AI Coder v5</div>\n' +
'        <div class="welcome-sub">@-mentions \u00B7 /commands \u00B7 Tab autocomplete \u00B7 Codebase index</div>\n' +
'        <div class="welcome-hints">\n' +
'          <div class="hint"><span class="hint-key">@</span> Attach files, search codebase, or run terminal commands</div>\n' +
'          <div class="hint"><span class="hint-key">/</span> Quick commands: /edit, /commit, /test, /explain, /clear</div>\n' +
'          <div class="hint"><span class="hint-key">Tab</span> Inline autocomplete while typing (configurable)</div>\n' +
'        </div>\n' +
'      </div>\n' +
'    </div>\n' +
'\n' +
'    <!-- Input area with context, progress, thinking -->\n' +
'    <div id="input-area">\n' +
'      <!-- Context bar -->\n' +
'      <div id="context-bar" style="display:none;">\n' +
'        <span id="context-label"></span>\n' +
'        <button id="btn-remove-context" class="small-btn">&times;</button>\n' +
'      </div>\n' +
'      <!-- Context progress (Continue-style) -->\n' +
'      <div id="context-progress" class="context-progress">\n' +
'        <div class="context-progress-bar">\n' +
'          <div id="context-progress-fill" class="context-progress-fill"></div>\n' +
'        </div>\n' +
'        <span id="context-progress-label" class="context-progress-label"></span>\n' +
'      </div>\n' +
'      <!-- Thinking indicator -->\n' +
'      <div id="thinking-indicator" style="display:none;" class="thinking-bar">\n' +
'        <span class="thinking-spinner">\u23F3</span>\n' +
'        <span id="thinking-text" class="thinking-text">Thinking...</span>\n' +
'      </div>\n' +
'      <!-- Input row -->\n' +
'      <div id="input-row">\n' +
'        <textarea id="input" rows="2" placeholder="Ask me to read, write, search, or run anything... (Enter to send)"></textarea>\n' +
'        <button id="btn-send" class="send-btn" disabled>\u25B6</button>\n' +
'      </div>\n' +
'    </div>\n' +
'\n' +
'    <!-- Status bar (Continue-style) -->\n' +
'    <div id="status-bar">\n' +
'      <div class="status-left">\n' +
'        <span class="status-item model-select" id="status-model">No model</span>\n' +
'      </div>\n' +
'      <div class="status-right">\n' +
'        <span class="status-item">\n' +
'          <span id="status-dot" class="status-dot connected"></span>\n' +
'        </span>\n' +
'        <span class="status-item">\n' +
'          <span id="status-tokens" class="token-count">0</span> tokens\n' +
'        </span>\n' +
'      </div>\n' +
'    </div>\n' +
'  </div>\n' +
'\n' +
'  <!-- Settings panel (slide-out, Continue-style) -->\n' +
'  <div id="settings-overlay"></div>\n' +
'  <div id="settings-panel">\n' +
'    <div class="settings-header">\n' +
'      <span>Settings</span>\n' +
'      <button id="settings-close" class="settings-close">&times;</button>\n' +
'    </div>\n' +
'    <div class="settings-body">\n' +
'      <div class="settings-group">\n' +
'        <div class="settings-group-label">Model</div>\n' +
'        <div class="settings-row">\n' +
'          <label>Provider</label>\n' +
'          <select id="settings-model">\n' +
'            <option value="openai">OpenAI GPT-4</option>\n' +
'            <option value="gpt35">GPT-3.5 Turbo</option>\n' +
'            <option value="claude">Claude 3.5 Sonnet</option>\n' +
'            <option value="local">Local (Ollama)</option>\n' +
'            <option value="custom">Custom Endpoint</option>\n' +
'          </select>\n' +
'        </div>\n' +
'      </div>\n' +
'      <div class="settings-group">\n' +
'        <div class="settings-group-label">API</div>\n' +
'        <div class="settings-row">\n' +
'          <label>API Key</label>\n' +
'          <input type="text" id="settings-apikey" placeholder="sk-..." />\n' +
'        </div>\n' +
'      </div>\n' +
'      <div class="settings-group">\n' +
'        <div class="settings-group-label">Generation</div>\n' +
'        <div class="settings-row">\n' +
'          <label>Temperature</label>\n' +
'          <input type="range" id="settings-temp" min="0" max="2" step="0.1" value="0.7" />\n' +
'          <span id="settings-temp-val" class="range-value">0.7</span>\n' +
'        </div>\n' +
'        <div class="settings-row">\n' +
'          <label>Max Tokens</label>\n' +
'          <input type="number" id="settings-max-tokens" value="4096" min="256" max="32768" />\n' +
'        </div>\n' +
'      </div>\n' +
'    </div>\n' +
'    <div class="settings-footer">\n' +
'      <button id="settings-cancel" class="settings-btn secondary">Cancel</button>\n' +
'      <button id="settings-save" class="settings-btn">Save</button>\n' +
'    </div>\n' +
'  </div>\n' +
'\n' +
'  <!-- History sidebar (slide-out, Continue-style) -->\n' +
'  <div id="history-sidebar">\n' +
'    <div class="history-header">\n' +
'      <span>Session History</span>\n' +
'      <button id="history-close" class="history-close">&times;</button>\n' +
'    </div>\n' +
'    <div class="history-search">\n' +
'      <input id="history-search-input" type="text" placeholder="Search sessions..." />\n' +
'    </div>\n' +
'    <div id="history-list" class="history-list">\n' +
'      <div class="history-empty">No past sessions yet</div>\n' +
'    </div>\n' +
'    <div class="history-footer">\n' +
'      <button id="history-clear-btn">Clear all sessions</button>\n' +
'    </div>\n' +
'  </div>\n' +
'\n' +
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
    case 'chatWithMentions':
      handleChatWithMentions(panel, message);
      break;
    case 'resolveMention':
      handleResolveMention(panel, message);
      break;
    case 'runCommand':
      handleRunCommand(panel, message);
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
        ws: workspaceRoot || '(no workspace)',
        inlineComplete: cfg.enableInlineCompletion
      });
      break;
    case 'attachFile':
      attachCurrentFile(panel);
      break;
  }
}

// ─── @-mention resolver ───────────────────────────

function handleResolveMention(panel, message) {
  var type = message.mentionType;
  var query = (message.query || '').trim();

  if (!query || !workspaceRoot) {
    panel.webview.postMessage({ type: 'mentionResult', results: [] });
    return;
  }

  if (type === 'file') {
    resolveFileMention(panel, query);
  } else if (type === 'folder') {
    resolveFolderMention(panel, query);
  } else if (type === 'codebase') {
    resolveCodebaseMention(panel, query);
  } else if (type === 'terminal') {
    resolveTerminalMention(panel, query);
  }
}

function resolveFileMention(panel, query) {
  var results = [];
  var found = {};
  var basePath = workspaceRoot;

  function walkDir(dir, depth) {
    if (depth > 3) return;
    if (results.length >= 20) return;
    try {
      var items = fs.readdirSync(dir);
      for (var i = 0; i < items.length; i++) {
        if (results.length >= 20) return;
        var name = items[i];
        if (name.startsWith('.')) continue;
        var full = pathModule.join(dir, name);
        try {
          var st = fs.statSync(full);
          var relPath = pathModule.relative(basePath, full);
          var lowerName = name.toLowerCase();
          var lowerQuery = query.toLowerCase();
          var match = lowerName.indexOf(lowerQuery) >= 0
                   || relPath.toLowerCase().indexOf(lowerQuery) >= 0;
          if (!match && depth === 0) continue;

          if (st.isDirectory()) {
            if (match && !found[relPath]) {
              found[relPath] = true;
              results.push({
                path: relPath,
                name: name + '/',
                isDir: true,
                detail: 'Directory'
              });
            }
            walkDir(full, depth + 1);
          } else {
            if (match && !found[relPath]) {
              found[relPath] = true;
              var sizeKB = Math.round(st.size / 1024);
              results.push({
                path: relPath,
                name: name,
                isDir: false,
                detail: sizeKB + ' KB',
                content: st.size < 100 * 1024 ? fs.readFileSync(full, 'utf-8').substring(0, 5000) : '(file too large)'
              });
            }
          }
        } catch(e) {}
      }
    } catch(e) {}
  }

  try { walkDir(basePath, 0); } catch(e) {}

  panel.webview.postMessage({ type: 'mentionResult', results: results.slice(0, 15) });
}

function resolveFolderMention(panel, query) {
  var dirPath = query;
  if (!pathModule.isAbsolute(dirPath)) {
    dirPath = pathModule.join(workspaceRoot, dirPath);
  }

  var results = [];
  if (!fs.existsSync(dirPath)) {
    var dirs = [];
    try {
      var items = fs.readdirSync(workspaceRoot);
      for (var i = 0; i < items.length; i++) {
        var name = items[i];
        if (name.startsWith('.')) continue;
        var full = pathModule.join(workspaceRoot, name);
        if (fs.statSync(full).isDirectory()) {
          if (name.toLowerCase().indexOf(query.toLowerCase()) >= 0) {
            dirs.push({
              path: name + '/',
              name: name + '/',
              isDir: true,
              detail: 'Directory'
            });
          }
        }
      }
    } catch(e) {}
    panel.webview.postMessage({ type: 'mentionResult', results: dirs.slice(0, 15) });
    return;
  }

  try {
    var entries = fs.readdirSync(dirPath);
    for (var i = 0; i < Math.min(entries.length, 30); i++) {
      var name = entries[i];
      if (name.startsWith('.')) continue;
      var full = pathModule.join(dirPath, name);
      try {
        var st = fs.statSync(full);
        var relPath = pathModule.relative(workspaceRoot, full);
        results.push({
          path: relPath,
          name: name + (st.isDirectory() ? '/' : ''),
          isDir: st.isDirectory(),
          detail: st.isDirectory() ? 'Directory' : Math.round(st.size / 1024) + ' KB'
        });
      } catch(e) {}
    }
  } catch(e) {}

  panel.webview.postMessage({ type: 'mentionResult', results: results.slice(0, 20) });
}

function resolveCodebaseMention(panel, query) {
  var results = [];
  var pattern = query.toLowerCase();

  // Phase 3: Try indexed search first
  var indexed = searchIndexedCodebase(pattern, 10);
  if (indexed) {
    for (var i = 0; i < indexed.length; i++) {
      var parts = indexed[i].split('  ');
      results.push({
        path: parts[0],
        name: parts[0],
        isDir: false,
        detail: parts.length > 1 ? parts[1] : ''
      });
    }
    panel.webview.postMessage({ type: 'mentionResult', results: results });
    return;
  }

  // Fallback to walk
  function walkDir(dir) {
    if (results.length >= 10) return;
    try {
      var items = fs.readdirSync(dir);
      for (var i = 0; i < items.length; i++) {
        if (results.length >= 10) return;
        var name = items[i];
        if (name.startsWith('.')) continue;
        var excludeDirs = { 'node_modules':1, '__pycache__':1, '.git':1, 'venv':1, '.venv':1, 'dist':1, 'build':1 };
        var full = pathModule.join(dir, name);
        try {
          var st = fs.statSync(full);
          if (st.isDirectory()) {
            if (!excludeDirs[name]) walkDir(full);
          } else {
            if (st.size > 100 * 1024) continue;
            var ext = pathModule.extname(name).toLowerCase();
            if (['.png','.jpg','.gif','.zip','.exe','.dll','.so','.pyc','.bin'].indexOf(ext) >= 0) continue;
            var content = fs.readFileSync(full, 'utf-8');
            var lines = content.split('\n');
            for (var j = 0; j < lines.length; j++) {
              if (lines[j].toLowerCase().indexOf(pattern) >= 0) {
                var relPath = pathModule.relative(workspaceRoot, full);
                results.push({
                  path: relPath + ':' + (j + 1),
                  name: relPath,
                  isDir: false,
                  detail: 'Line ' + (j + 1) + ': ' + lines[j].trim().substring(0, 80),
                  content: content.substring(0, 3000)
                });
                break;
              }
            }
          }
        } catch(e) {}
      }
    } catch(e) {}
  }

  try { walkDir(workspaceRoot); } catch(e) {}

  panel.webview.postMessage({ type: 'mentionResult', results: results.slice(0, 10) });
}

function resolveTerminalMention(panel, query) {
  if (!query) {
    panel.webview.postMessage({ type: 'mentionResult', results: [] });
    return;
  }

  try {
    var out = cp.execSync(query, {
      cwd: workspaceRoot || process.cwd(),
      timeout: 15000,
      encoding: 'utf-8',
      maxBuffer: 100 * 1024
    });
    var output = out.toString();
    if (output.length > 3000) output = output.substring(0, 3000) + '\n... (truncated)';

    panel.webview.postMessage({
      type: 'mentionResolved',
      key: 'terminal:' + query,
      label: '$ ' + query,
      content: output
    });
  } catch (e) {
    var errOut = e.stdout ? e.stdout.toString().substring(0, 1000) : '';
    var errMsg = e.stderr ? e.stderr.toString().substring(0, 1000) : '';
    panel.webview.postMessage({
      type: 'mentionResolved',
      key: 'terminal:' + query,
      label: '$ ' + query + ' (exit ' + (e.status || 1) + ')',
      content: errOut || errMsg || e.message
    });
  }
}

// ─── Chat with @-mentions ─────────────────────────

function handleChatWithMentions(panel, message) {
  var text = (message.text || '').trim();
  var mentions = message.mentions || [];
  var extraContext = '';

  for (var i = 0; i < mentions.length; i++) {
    var m = mentions[i];
    var resolved = resolveSingleMention(m.type, m.query);
    if (resolved) {
      extraContext += '\n--- ' + resolved.label + ' ---\n' + resolved.content + '\n';
    }
  }

  if (message.fileContext) {
    extraContext = 'Context file:\n```\n' + message.fileContext + '\n```\n' + extraContext;
  }

  if (extraContext) {
    text = '[Context]\n' + extraContext + '\n\n[User request]\n' + text;
  }

  if (chatHistory.length === 0 && workspaceRoot) {
    text = '[Workspace: ' + workspaceRoot + ']\n\n' + text;
  }

  panel.webview.postMessage({ type: 'user', content: text.substring(0, 500) });
  agentLoop(panel, text);
}

function resolveSingleMention(type, query) {
  if (!query || !workspaceRoot) return null;

  if (type === 'file') {
    var filePath = query;
    if (!pathModule.isAbsolute(filePath)) {
      filePath = pathModule.join(workspaceRoot, filePath);
    }
    if (fs.existsSync(filePath) && !fs.statSync(filePath).isDirectory()) {
      var content = fs.readFileSync(filePath, 'utf-8');
      return { label: 'File: ' + pathModule.relative(workspaceRoot, filePath), content: content.substring(0, 10000) };
    }
    try {
      var found = searchForFile(workspaceRoot, query);
      if (found) {
        var content = fs.readFileSync(found, 'utf-8');
        return { label: 'File: ' + pathModule.relative(workspaceRoot, found), content: content.substring(0, 10000) };
      }
    } catch(e) {}
    return { label: 'File: ' + query, content: '(file not found)' };
  }

  if (type === 'folder') {
    var dirPath = query;
    if (!pathModule.isAbsolute(dirPath)) {
      dirPath = pathModule.join(workspaceRoot, dirPath);
    }
    if (fs.existsSync(dirPath)) {
      var listing = '';
      try {
        var entries = fs.readdirSync(dirPath);
        for (var i = 0; i < entries.length; i++) {
          if (entries[i].startsWith('.')) continue;
          listing += entries[i] + '\n';
        }
      } catch(e) {}
      return { label: 'Folder: ' + query, content: listing.substring(0, 3000) };
    }
    return { label: 'Folder: ' + query, content: '(directory not found)' };
  }

  if (type === 'codebase') {
    var pattern = query;
    var searchResults = [];
    try {
      searchForPattern(workspaceRoot, pattern, searchResults, 0);
    } catch(e) {}
    var output = searchResults.length > 0
      ? searchResults.join('\n').substring(0, 5000)
      : 'No matches found for "' + pattern + '"';
    return { label: 'Codebase search: ' + pattern, content: output };
  }

  if (type === 'terminal') {
    try {
      var out = cp.execSync(query, {
        cwd: workspaceRoot || process.cwd(),
        timeout: 15000,
        encoding: 'utf-8',
        maxBuffer: 100 * 1024
      });
      return { label: '$ ' + query, content: out.toString().substring(0, 3000) };
    } catch (e) {
      var errOut = e.stdout ? e.stdout.toString().substring(0, 1000) : '';
      var errMsg = e.stderr ? e.stderr.toString().substring(0, 1000) : '';
      return { label: '$ ' + query, content: errOut || errMsg || e.message };
    }
  }

  return null;
}

function searchForFile(dir, filename) {
  var excludeDirs = { 'node_modules':1, '__pycache__':1, '.git':1, 'venv':1, '.venv':1, 'dist':1, 'build':1 };
  try {
    var items = fs.readdirSync(dir);
    for (var i = 0; i < items.length; i++) {
      var name = items[i];
      if (name.startsWith('.')) continue;
      var full = pathModule.join(dir, name);
      try {
        var st = fs.statSync(full);
        if (st.isDirectory()) {
          if (!excludeDirs[name]) {
            var found = searchForFile(full, filename);
            if (found) return found;
          }
        } else {
          if (name.indexOf(filename) >= 0 || full.indexOf(filename) >= 0) return full;
        }
      } catch(e) {}
    }
  } catch(e) {}
  return null;
}

function searchForPattern(dir, pattern, results, depth) {
  if (depth > 4) return;
  var excludeDirs = { 'node_modules':1, '__pycache__':1, '.git':1, 'venv':1, '.venv':1, 'dist':1, 'build':1, '.idea':1 };
  var excludeExts = { '.png':1, '.jpg':1, '.gif':1, '.zip':1, '.exe':1, '.dll':1, '.so':1, '.pyc':1, '.bin':1 };
  var lowerPattern = pattern.toLowerCase();
  try {
    var items = fs.readdirSync(dir);
    for (var i = 0; i < items.length; i++) {
      if (results.length >= 10) return;
      var name = items[i];
      if (name.startsWith('.')) continue;
      var full = pathModule.join(dir, name);
      try {
        var st = fs.statSync(full);
        if (st.isDirectory()) {
          if (!excludeDirs[name]) searchForPattern(full, pattern, results, depth + 1);
        } else {
          var ext = pathModule.extname(name).toLowerCase();
          if (excludeExts[ext]) continue;
          if (st.size > 100 * 1024) continue;
          var content = fs.readFileSync(full, 'utf-8');
          var lines = content.split('\n');
          for (var j = 0; j < lines.length; j++) {
            if (lines[j].toLowerCase().indexOf(lowerPattern) >= 0) {
              var relPath = pathModule.relative(workspaceRoot, full);
              results.push(relPath + ':' + (j + 1) + '  ' + lines[j].trim().substring(0, 100));
              break;
            }
          }
        }
      } catch(e) {}
    }
  } catch(e) {}
}

// ─── Slash command executor ───────────────────────

function handleRunCommand(panel, message) {
  var cmd = message.command || '';
  var args = message.args || '';

  switch (cmd) {
    case 'edit':
      handleEditCommand(panel, args);
      break;
    case 'commit':
      handleCommitCommand(panel);
      break;
    case 'test':
      handleTestCommand(panel, args);
      break;
    case 'explain':
      handleExplainCommand(panel, args);
      break;
    case 'so':
      handleSoCommand(panel, args);
      break;
    default:
      panel.webview.postMessage({ type: 'error', content: 'Unknown command: /' + cmd });
      break;
  }
}

function handleEditCommand(panel, instructions) {
  var editor = vscode.window.activeTextEditor;
  if (!editor) {
    panel.webview.postMessage({ type: 'error', content: 'No editor open. Open a file to use /edit.' });
    return;
  }

  var doc = editor.document;
  var sel = editor.selection;
  var selectedText = sel.isEmpty ? doc.getText() : doc.getText(sel);
  var lang = doc.languageId || 'text';

  var editPrompt = 'Edit the following code as instructed. Return ONLY the complete, updated file content in a code block.\n\n'
    + 'Language: ' + lang + '\n'
    + 'File: ' + doc.fileName + '\n'
    + 'Instructions: ' + (instructions || 'Please improve this code') + '\n\n'
    + 'Current code:\n```\n' + selectedText + '\n```\n\n'
    + 'Return the complete updated code in a ```' + lang + ' ... ``` block.';

  panel.webview.postMessage({ type: 'user', content: '/edit ' + (instructions || '(improve code)') });
  agentLoop(panel, editPrompt);
}

function handleCommitCommand(panel) {
  if (!workspaceRoot) {
    panel.webview.postMessage({ type: 'error', content: 'No workspace open. Open a project to use /commit.' });
    return;
  }

  try {
    var diff = cp.execSync('git diff --cached', { cwd: workspaceRoot, timeout: 10000, encoding: 'utf-8' });
    var diffOut = diff.toString().trim();
    if (!diffOut) {
      diff = cp.execSync('git diff', { cwd: workspaceRoot, timeout: 10000, encoding: 'utf-8' });
      diffOut = diff.toString().trim();
    }
    if (!diffOut) {
      panel.webview.postMessage({ type: 'error', content: 'No staged or unstaged changes found.' });
      return;
    }

    var commitPrompt = 'Generate a concise, conventional git commit message for the following diff.\n'
      + 'Format: type(scope): short description\n\n'
      + 'Diff:\n```diff\n' + diffOut.substring(0, 5000) + '\n```\n\n'
      + 'Return ONLY the commit message, nothing else.';

    panel.webview.postMessage({ type: 'user', content: '/commit (generating commit message...)' });
    agentLoop(panel, commitPrompt);
  } catch (e) {
    panel.webview.postMessage({ type: 'error', content: 'Git error: ' + (e.message || 'not a git repo?') });
  }
}

function handleTestCommand(panel, args) {
  var editor = vscode.window.activeTextEditor;
  if (!editor) {
    panel.webview.postMessage({ type: 'error', content: 'Open a file with code to test.' });
    return;
  }

  var doc = editor.document;
  var sel = editor.selection;
  var selectedText = sel.isEmpty ? doc.getText() : doc.getText(sel);
  var lang = doc.languageId || 'text';

  var testPrompt = 'Generate comprehensive unit tests for the following code.\n'
    + 'Language: ' + lang + '\n'
    + (args ? 'Additional instructions: ' + args + '\n' : '')
    + 'Code:\n```\n' + selectedText.substring(0, 5000) + '\n```\n\n'
    + 'Return the tests in a ```' + lang + ' ... ``` code block. Include edge cases.';

  panel.webview.postMessage({ type: 'user', content: '/test ' + (args || '(generate tests)') });
  agentLoop(panel, testPrompt);
}

function handleExplainCommand(panel, args) {
  var editor = vscode.window.activeTextEditor;
  if (!editor) {
    panel.webview.postMessage({ type: 'error', content: 'Open a file to explain.' });
    return;
  }

  var doc = editor.document;
  var sel = editor.selection;
  var selectedText = sel.isEmpty ? doc.getText() : doc.getText(sel);
  var lang = doc.languageId || 'code';

  var explainPrompt = 'Explain the following ' + lang + ' code in detail:\n\n```\n'
    + selectedText.substring(0, 5000) + '\n```\n\n'
    + 'Answer in clear language. Cover: what each part does, the overall algorithm, '
    + 'any design patterns used, and potential issues.';

  panel.webview.postMessage({ type: 'user', content: '/explain' });
  agentLoop(panel, explainPrompt);
}

function handleSoCommand(panel, args) {
  if (!args) {
    panel.webview.postMessage({ type: 'error', content: 'Please add a search query. Usage: /so how to sort array in Python' });
    return;
  }

  var soPrompt = 'The user wants to know: "' + args + '"\n\n'
    + 'Search your knowledge and provide the best answer, including code examples where relevant. '
    + 'Format it like a helpful Stack Overflow answer with explanation and code.';

  panel.webview.postMessage({ type: 'user', content: '/so ' + args });
  agentLoop(panel, soPrompt);
}

function handleChat(panel, message) {
  var text = (message.text || '').trim();
  if (!text) return;

  if (chatHistory.length === 0 && workspaceRoot) {
    text = '[Workspace: ' + workspaceRoot + ']\n\n' + text;
  }

  if (message.fileContext) {
    text = 'Context file:\n```\n' + message.fileContext + '\n```\n\nUser request:\n' + text;
  }

  panel.webview.postMessage({ type: 'user', content: text.substring(0, 500) });
  agentLoop(panel, text);
}

function attachCurrentFile(panel) {
  var editor = vscode.window.activeTextEditor;
  if (!editor) {
    panel.webview.postMessage({ type: 'status', text: 'No file open' });
    return;
  }
  var doc = editor.document;
  var sel = editor.selection;
  var hasSel = !sel.isEmpty;
  var content = hasSel ? doc.getText(sel) : doc.getText();
  var lbl = hasSel
    ? 'Selected: ' + doc.fileName.split(/[/\\]/).pop() + ' (' + content.split('\n').length + ' lines)'
    : 'Attached: ' + doc.fileName.split(/[/\\]/).pop();

  panel.webview.postMessage({
    type: 'contextSet',
    fileContent: content,
    label: lbl
  });
}

// ─── VSCode 激活 ─────────────────────────────────────

function activate(context) {
  extensionContext = context;
  console.log('Win7 AI Coder v5 activated');

  if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
    workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
  }

  // Phase 3: Build codebase index on activation
  if (workspaceRoot) {
    var loaded = loadCodebaseIndex();
    if (!loaded) {
      // Build asynchronously (don't block activation)
      setTimeout(function() {
        saveCodebaseIndex();
      }, 2000);
    }

    // Rebuild on file save
    context.subscriptions.push(
      vscode.workspace.onDidSaveTextDocument(function(doc) {
        var cfg = getConfig();
        if (cfg.enableInlineCompletion) {
          // Debounced rebuild
          if (codebaseIndexRebuildTimer) clearTimeout(codebaseIndexRebuildTimer);
          codebaseIndexRebuildTimer = setTimeout(function() {
            saveCodebaseIndex();
            codebaseIndexRebuildTimer = null;
          }, 5000);
        }
      })
    );
  }

  // Phase 2: Register inline completion provider
  var cfg = getConfig();
  if (cfg.enableInlineCompletion) {
    try {
      context.subscriptions.push(
        vscode.languages.registerInlineCompletionItemProvider(
          { pattern: '**' },
          new InlineCompletionProvider()
        )
      );
      console.log('[Win7 AI] Inline completion provider registered');
    } catch (e) {
      console.log('[Win7 AI] Inline completion provider failed (non-fatal): ' + e.message);
    }
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
        vscode.window.showWarningMessage('Select code first.');
        return;
      }
      var sel = editor.document.getText(editor.selection);
      panel.webview.postMessage({
        type: 'contextSet',
        fileContent: sel,
        label: 'Selected: ' + editor.document.fileName.split(/[/\\]/).pop()
      });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('win7-ai-coder.explainCode', function() {
      var panel = openChatPanel(context);
      var editor = vscode.window.activeTextEditor;
      if (!editor) return;
      var content = editor.document.getText();
      panel.webview.postMessage({
        type: 'contextSet',
        fileContent: content,
        label: 'File: ' + editor.document.fileName.split(/[/\\]/).pop()
      });
      handleChat(panel, {
        text: 'Analyze the project structure, explain each file and their relationships.',
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

  // Workspace changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(function(e) {
      if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
      }
    })
  );

  // Phase 4: Register rebuild index command
  context.subscriptions.push(
    vscode.commands.registerCommand('win7-ai-coder.rebuildIndex', function() {
      saveCodebaseIndex();
      vscode.window.showInformationMessage('Codebase index rebuilt: ' + Object.keys(codebaseIndex.files).length + ' files');
    })
  );

  // Phase 4: Register toggle inline completion command
  context.subscriptions.push(
    vscode.commands.registerCommand('win7-ai-coder.toggleInlineCompletion', function() {
      var cfg2 = vscode.workspace.getConfiguration('win7-ai-coder');
      var current = cfg2.get('enableInlineCompletion', true);
      cfg2.update('enableInlineCompletion', !current, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage('Inline completion: ' + (!current ? 'ON' : 'OFF'));
    })
  );
}

var codebaseIndexRebuildTimer = null;

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
