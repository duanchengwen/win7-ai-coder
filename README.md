# Win7 AI Coder — VSCode Extension

> 🖥️ AI 编程助手 VSCode 扩展，调用本地 DeepSeek 模型，兼容 **Windows 7 + VSCode 1.69**

## ✨ 功能

- 🤖 **AI 对话面板** — 侧栏聊天，流式输出
- 📎 **上下文感知** — 自动附带当前文件/选中代码
- 🖱️ **右键菜单** — 选中文 → Ask AI / Explain / Generate Docs
- 🔌 **本地模型** — OpenAI 兼容 API（llama.cpp / vLLM / LocalAI / Ollama）
- 🎨 **暗色主题** — Catppuccin Mocha 配色
- 📋 **代码复制** — 一键复制 AI 回复中的代码块

## 📦 安装

### 1. 装 VSCode 1.69（Win7 最后一个版本）

- 下载：https://code.visualstudio.com/updates/v1_69
- 选 **Windows x64 System Installer**

### 2. 搭建本地模型

```bat
:: llama.cpp
llama-server.exe -m deepseek-coder.Q4_K_M.gguf --port 8080

:: 或 Ollama
ollama serve
ollama pull deepseek-coder:6.7b
```

### 3. 安装扩展

```
复制本项目到 C:\Users\<你>\.vscode\extensions\win7-ai-coder\
重启 VSCode
```

或在 VSCode 中按 `Ctrl+Shift+P` → `Developer: Install Extension from Location...` → 选择本项目文件夹

### 4. 配置

VSCode 设置 (`Ctrl+,`) → 搜索 `win7-ai-coder`：

| 设置项 | 默认值 | 说明 |
|---|---|---|
| Provider | `openai` | API 格式 |
| OpenAI Base URL | `http://localhost:8080/v1` | 模型 API 地址 |
| Model | `deepseek-coder` | 模型名 |
| Max Tokens | `8192` | 最大输出长度 |
| Temperature | `0.15` | 越低越确定 |

## 🎮 使用

| 操作 | 方式 |
|---|---|
| 打开聊天 | 左侧活动栏 🤖 图标，或 Ctrl+Shift+P → `AI Chat: Open` |
| 询问代码 | 选中代码 → 右键 → `Ask About Selected Code` |
| 解释文件 | 右键 → `Explain This File` |
| 生成文档 | 右键 → `Generate Documentation` |
| 发送消息 | Enter（Shift+Enter 换行） |

## 🏗️ 项目结构

```
win7-ai-coder/
├── package.json          # 扩展清单
├── extension.js          # 扩展入口（Node.js）
├── media/
│   ├── chat.css          # 聊天面板样式
│   └── chat.js           # 聊天面板脚本
├── resources/
│   └── icon.png          # 扩展图标
├── .vscodeignore
└── README.md
```

## 🔧 技术栈

| 组件 | 说明 |
|---|---|
| VSCode 1.69 | Win7 最后支持版本（Node 12.x 内置） |
| Webview API | VSCode 自带，无需额外安装 |
| Node.js http/https | 内置模块，直接请求本地 API |
| Catppuccin Mocha | 美观暗色主题 |

## 📝 兼容性

- ✅ Windows 7 SP1
- ✅ VSCode 1.69 ~ 1.70
- ✅ Python 不需要（完全 Node.js）
- ✅ 无外部 npm 依赖

## 📄 License

MIT
