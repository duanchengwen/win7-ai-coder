/**
 * Win7 AI Coder — VSCode Extension
 * =================================
 * AI 编程助手扩展，在 VSCode 1.69 上运行，兼容 Windows 7
 *
 * 架构：
 *   Webview (聊天UI) ← postMessage → Extension Host → HTTP → 本地 LLM API
 *
 * 支持的模型后端：
 *   - OpenAI 兼容 API (llama.cpp server / vLLM / LocalAI / Ollama /v1)
 *   - Ollama 原生 API
 */

const vscode = require('vscode');
const http = require('http');
const https = require('https');
const url = require('url');

// ─── 全局状态 ────────────────────────────────────────────
let chatPanel = null;         // WebviewPanel instance
let chatHistory = [];         // [{role, content}]
let extensionContext = null;

// ─── System Prompt ───────────────────────────────────────
const SYSTEM_PROMPT = `你是 Win7 AI Coder，一个集成在 VSCode 中的专业 AI 编程助手。

规则:
- 给出清晰、可直接运行的代码，用 \`\`\`语言
代码块\`\`\` 标注
- 解释关键思路和步骤
- 如果用户粘贴了代码，指出具体问题并提出改进建议
- 可以中英文混合表达，保证准确
- 保持专业、有帮助的语气`;

// ─── 配置读取 ──────────────────────────────────────────

function getConfig() {
    const cfg = vscode.workspace.getConfiguration('win7-ai-coder');
    const provider = cfg.get('provider', 'openai');

    if (provider === 'ollama') {
        return {
            provider: 'ollama',
            apiUrl: cfg.get('ollamaBaseUrl', 'http://localhost:11434').replace(/\/+$/, '') + '/api/chat',
            model: cfg.get('ollamaModel', 'deepseek-coder:6.7b'),
            isOpenAI: false,
            apiKey: '',
        };
    }

    return {
        provider: 'openai',
        apiUrl: cfg.get('openaiBaseUrl', 'http://localhost:8080/v1').replace(/\/+$/, '') + '/chat/completions',
        model: cfg.get('openaiModel', 'deepseek-coder'),
        isOpenAI: true,
        apiKey: cfg.get('openaiApiKey', 'not-needed'),
    };
}

function getChatConfig() {
    const cfg = vscode.workspace.getConfiguration('win7-ai-coder');
    return {
        maxTokens: cfg.get('maxTokens', 8192),
        temperature: cfg.get('temperature', 0.15),
        streaming: cfg.get('enableStreaming', true),
    };
}

// ─── LLM Stream API ────────────────────────────────────

function streamChat(messages, onToken, onError, onDone) {
    const modelCfg = getConfig();
    const chatCfg = getChatConfig();
    const parsed = url.parse(modelCfg.apiUrl);
    const isHttps = parsed.protocol === 'https:';

    const payload = modelCfg.isOpenAI
        ? {
            model: modelCfg.model,
            messages: messages,
            max_tokens: chatCfg.maxTokens,
            temperature: chatCfg.temperature,
            top_p: 0.95,
            stream: true,
          }
        : {
            model: modelCfg.model,
            messages: messages,
            stream: true,
            options: {
                temperature: chatCfg.temperature,
                top_p: 0.95,
                num_predict: chatCfg.maxTokens,
            },
          };

    const body = JSON.stringify(payload);
    const headers = {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
    };
    if (modelCfg.apiKey && modelCfg.apiKey !== 'not-needed') {
        headers['Authorization'] = `Bearer ${modelCfg.apiKey}`;
    }

    const options = {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.path,
        method: 'POST',
        headers: headers,
        timeout: 180000,
    };

    const transport = isHttps ? https : http;
    const req = transport.request(options, (res) => {
        if (res.statusCode !== 200) {
            let errBody = '';
            res.on('data', d => errBody += d);
            res.on('end', () => {
                let msg = 'HTTP ' + res.statusCode;
                try {
                    var parsed = JSON.parse(errBody);
                    var em = (parsed.error && parsed.error.message) || '';
                    if (em) msg = em;
                } catch(e) {}
                onError('**请求失败**\n\n状态码: ' + res.statusCode + '\n错误: ' + msg + '\n\n请确认:\n- 模型推理服务已启动\n- 地址: ' + modelCfg.apiUrl);
            });
            return;
        }

        let buffer = '';
        res.on('data', (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;

                if (modelCfg.isOpenAI) {
                    if (!trimmed.startsWith('data: ')) continue;
                    const data = trimmed.slice(6).trim();
                    if (data === '[DONE]') {
                        return onDone();
                    }
                    try {
                        const json = JSON.parse(data);
                        var choices = json.choices;
                        var delta = (choices && choices.length && choices[0]) ? choices[0].delta : null;
                        if (delta && delta.content) {
                            onToken(delta.content);
                        }
                    } catch(e) {}
                } else {
                    try {
                        const json = JSON.parse(trimmed);
                        if (json.done) return onDone();
                        var msg = json.message;
                        if (msg && msg.content) {
                            onToken(msg.content);
                        }
                    } catch(e) {}
                }
            }
        });

        res.on('end', () => {
            // process remaining buffer
            if (buffer.trim()) {
                try {
                    if (modelCfg.isOpenAI && buffer.startsWith('data: ')) {
                        const data = buffer.slice(6).trim();
                        if (data !== '[DONE]') {
                            const json = JSON.parse(data);
                            var choices2 = json.choices;
                            var delta2 = (choices2 && choices2.length && choices2[0]) ? choices2[0].delta : null;
                            if (delta2 && delta2.content) onToken(delta2.content);
                        }
                    }
                } catch(e) {}
            }
            onDone();
        });

        res.on('error', (e) => {
            onError(`**连接错误**\n\n\`${e.message}\`\n\n请检查模型服务是否正常运行。`);
        });
    });

    req.on('error', (e) => {
        onError(`**无法连接到模型服务**\n\n\`${e.message}\`\n\n请确认:\n- 模型服务已启动\n- 地址正确: \`${modelCfg.apiUrl}\``);
    });

    req.on('timeout', () => {
        req.destroy();
        onError('**请求超时**\n\n模型响应超过 180 秒，请检查模型服务。');
    });

    req.write(body);
    req.end();
}

// ─── Webview HTML 生成 ─────────────────────────────────

function getWebviewHTML(webview) {
    const styleUri = webview.asWebviewUri(
        vscode.Uri.joinPath(extensionContext.extensionUri, 'media', 'chat.css')
    );
    const scriptUri = webview.asWebviewUri(
        vscode.Uri.joinPath(extensionContext.extensionUri, 'media', 'chat.js')
    );
    const codemirrorCss = webview.asWebviewUri(
        vscode.Uri.joinPath(extensionContext.extensionUri, 'media', 'codemirror.css')
    );
    const hljsCss = webview.asWebviewUri(
        vscode.Uri.joinPath(extensionContext.extensionUri, 'media', 'highlight.css')
    );

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none';
               style-src ${webview.cspSource} 'unsafe-inline';
               script-src ${webview.cspSource} 'unsafe-inline';
               font-src ${webview.cspSource};
               img-src ${webview.cspSource} data:;">
<link rel="stylesheet" href="${styleUri}">
<link rel="stylesheet" href="${codemirrorCss}">
<link rel="stylesheet" href="${hljsCss}">
<title>AI Chat</title>
</head>
<body>
  <div id="container">
    <!-- Header -->
    <div id="header">
      <span class="header-title">🤖 AI Chat</span>
      <div class="header-actions">
        <button id="btn-clear" class="icon-btn" title="清空对话">🗑️</button>
        <button id="btn-config" class="icon-btn" title="配置">⚙️</button>
      </div>
    </div>

    <!-- Messages -->
    <div id="messages">
      <div class="welcome">
        <div class="welcome-icon">🤖</div>
        <div class="welcome-title">Win7 AI Coder</div>
        <div class="welcome-sub">本地 DeepSeek 编程助手</div>
        <div class="welcome-hints">
          <div class="hint"><span class="hint-key">打开文件</span> 后提问，AI 能直接分析代码</div>
          <div class="hint"><span class="hint-key">选中代码</span> 右键 → Ask AI</div>
          <div class="hint"><span class="hint-key">Ctrl+Shift+P</span> → AI Chat: Explain Code</div>
        </div>
      </div>
    </div>

    <!-- Input -->
    <div id="input-area">
      <div id="context-bar" style="display:none;">
        <span id="context-label"></span>
        <button id="btn-remove-context" class="small-btn">&times;</button>
      </div>
      <div id="input-row">
        <textarea id="input" rows="2" placeholder="输入编程问题… (Enter 发送, Shift+Enter 换行)"></textarea>
        <button id="btn-send" class="send-btn" disabled>▶</button>
      </div>
    </div>

    <!-- Typing indicator (hidden by default) -->
    <div id="typing" style="display:none;">
      <span class="dot"></span><span class="dot"></span><span class="dot"></span>
    </div>
  </div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
}

// ─── Webview 消息处理 ──────────────────────────────────

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
            // webview is ready, send config
            const cfg = getConfig();
            panel.webview.postMessage({
                type: 'config',
                model: cfg.model,
                provider: cfg.provider,
            });
            break;
        case 'attachFile':
            attachCurrentFile(panel);
            break;
    }
}

function handleChat(panel, message) {
    const text = message.text || '';
    if (!text.trim()) return;

    // Build context
    const fileCtx = message.fileContext || '';
    const selCtx = message.selection || '';

    let userMsg = text;
    const ctxParts = [];
    if (selCtx) ctxParts.push(`用户选中的代码:\n\`\`\`\n${selCtx}\n\`\`\``);
    if (fileCtx) ctxParts.push(`当前文件内容:\n\`\`\`\n${fileCtx}\n\`\`\``);
    if (ctxParts.length) {
        userMsg = ctxParts.join('\n\n') + '\n\n' + text;
    }

    // Init history
    if (chatHistory.length === 0) {
        chatHistory.push({ role: 'system', content: SYSTEM_PROMPT });
    }
    chatHistory.push({ role: 'user', content: userMsg });

    // Notify webview
    panel.webview.postMessage({ type: 'streamStart' });

    let fullResponse = '';

    streamChat(
        chatHistory,
        // onToken
        (token) => {
            fullResponse += token;
            panel.webview.postMessage({ type: 'token', content: token });
        },
        // onError
        (errMsg) => {
            panel.webview.postMessage({ type: 'error', content: errMsg });
        },
        // onDone
        () => {
            if (fullResponse.trim()) {
                chatHistory.push({ role: 'assistant', content: fullResponse });
            }
            panel.webview.postMessage({ type: 'streamEnd' });
        }
    );
}

async function attachCurrentFile(panel) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        panel.webview.postMessage({ type: 'status', text: '没有打开的文件' });
        return;
    }
    const doc = editor.document;
    const sel = editor.selection;
    const hasSelection = !sel.isEmpty;
    const content = hasSelection
        ? doc.getText(sel)
        : doc.getText();
    const label = hasSelection
        ? `已选中: ${doc.fileName.split(/[/\\]/).pop()} (${content.split('\n').length} 行)`
        : `已附加: ${doc.fileName.split(/[/\\]/).pop()}`;

    panel.webview.postMessage({
        type: 'contextSet',
        fileContent: content,
        selection: hasSelection ? content : '',
        label: label,
    });
}

// ─── 扩展激活 ──────────────────────────────────────────

function activate(context) {
    extensionContext = context;
    console.log('Win7 AI Coder activated');

    // 注册命令: 打开聊天面板
    context.subscriptions.push(
        vscode.commands.registerCommand('win7-ai-coder.openChat', () => {
            openChatPanel(context);
        })
    );

    // 注册命令: 询问选中代码
    context.subscriptions.push(
        vscode.commands.registerCommand('win7-ai-coder.askSelection', async () => {
            const panel = openChatPanel(context);
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.selection.isEmpty) {
                vscode.window.showWarningMessage('请先选中代码再使用此功能。');
                return;
            }
            const sel = editor.document.getText(editor.selection);
            panel.webview.postMessage({
                type: 'contextSet',
                fileContent: sel,
                selection: sel,
                label: `已选中: ${editor.document.fileName.split(/[/\\]/).pop()} (${sel.split('\n').length} 行)`,
            });
        })
    );

    // 注册命令: 解释当前文件
    context.subscriptions.push(
        vscode.commands.registerCommand('win7-ai-coder.explainCode', async () => {
            const panel = openChatPanel(context);
            await attachCurrentFile(panel);
            // Auto-send explain request
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                const doc = editor.document;
                const lang = doc.languageId || 'text';
                handleChat(panel, {
                    text: `请详细解释这个 ${lang} 文件的代码结构和功能。`,
                    fileContext: doc.getText(),
                });
            }
        })
    );

    // 注册命令: 生成文档
    context.subscriptions.push(
        vscode.commands.registerCommand('win7-ai-coder.generateDocs', async () => {
            const panel = openChatPanel(context);
            await attachCurrentFile(panel);
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                const doc = editor.document;
                const lang = doc.languageId || 'text';
                handleChat(panel, {
                    text: `请为这段 ${lang} 代码生成完整的文档注释，包括参数说明、返回值、使用示例。`,
                    fileContext: doc.getText(),
                });
            }
        })
    );

    // 注册命令: 清空对话
    context.subscriptions.push(
        vscode.commands.registerCommand('win7-ai-coder.clearChat', () => {
            chatHistory = [];
            if (chatPanel) {
                chatPanel.webview.postMessage({ type: 'cleared' });
            }
        })
    );

    // 注册 Webview View Provider（侧栏视图）
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('win7-ai-coder.chatView', {
            resolveWebviewView(webviewView) {
                webviewView.webview.options = {
                    enableScripts: true,
                    localResourceRoots: [
                        vscode.Uri.joinPath(context.extensionUri, 'media'),
                    ],
                };
                webviewView.webview.html = getWebviewHTML(webviewView.webview);
                webviewView.webview.onDidReceiveMessage(msg => {
                    handleWebviewMessage({ webview: webviewView.webview, reveal: () => webviewView.show(true) }, msg);
                });
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
        'AI Chat',
        vscode.ViewColumn.Two,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [
                vscode.Uri.joinPath(context.extensionUri, 'media'),
            ],
        }
    );

    chatPanel.webview.html = getWebviewHTML(chatPanel.webview);

    chatPanel.webview.onDidReceiveMessage(msg => {
        handleWebviewMessage(chatPanel, msg);
    });

    chatPanel.onDidDispose(() => {
        chatPanel = null;
    });

    return chatPanel;
}

function deactivate() {
    chatPanel = null;
    chatHistory = [];
}

module.exports = { activate, deactivate };
