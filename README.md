# Win7 AI Coder v5 — VSCode Extension

> 🖥️ AI 编程助手，兼容 **Windows 7 + VSCode 1.69**  
> @-mentions · Slash commands · Tab autocomplete · Codebase index · Thinking animation

受 [Continue.dev](https://github.com/continuedev/continue) 启发的 AI coding IDE 体验，专为 Win7 重新实现。

---

## ✨ 功能一览

### 🤖 Agent 模式
- 自主读项目 → 分析 → 创建文件 → 执行命令 → 写代码
- 5 个内置工具：`read_file` / `write_file` / `list_dir` / `search_code` / `run_terminal`
- 最多 15 轮自动工具调用
- 🧠 **实时思考动画** — 显示当前状态（思考中→执行工具→完成）

### 🔗 @-mentions（类似 Continue）
在输入框中键入 `@`，弹出上下文选择菜单：

| @-mention | 作用 |
|-----------|------|
| `@file xxx` | 搜索并附加项目文件内容 |
| `@folder xxx` | 列出目录内容 |
| `@codebase xxx` | 搜索整个项目代码（使用关键词倒排索引加速） |
| `@terminal cmd` | 执行命令并将输出带入对话 |

### ⚡ Slash 命令
输入 `/` 快速启动：

| 命令 | 作用 |
|------|------|
| `/edit make it async` | 修改选中代码 |
| `/commit` | 从 git diff 生成 commit message |
| `/test` | 为选中代码生成单元测试 |
| `/explain` | 详细解释选中代码 |
| `/so how to sort in Python` | 知识问答 |
| `/clear` | 清除对话历史 |

### 🔮 Tab 自动补全（Phase 2）
- 输入时自动弹出 inline 补全建议
- 基于 DeepSeek API 实时生成
- 400ms 防抖（可配置）
- 通过 `AI Chat: Toggle Inline Completion` 开关

### 📚 Codebase 索引（Phase 3）
- 插件启动时自动构建关键词倒排索引
- 存储在 `.vscode/win7-ai-codebase-index.json`
- 文件保存后自动增量更新（5s 防抖）
- 加速 @codebase 搜索和 Agent 的 search_code 工具
- 通过 `AI Chat: Rebuild Codebase Index` 手动重建

### 🎨 其他
- 📎 **右键菜单** — 选中文 → Ask / Explain / Generate Docs
- 🔌 **多 Provider** — OpenAI / Ollama / DeepSeek 兼容 API
- 🎨 **Catppuccin Mocha** 暗色主题
- 🚫 **零 npm 运行时依赖** — 纯 Node.js 内置模块

---

## 📦 安装

### 1. 安装 VSCode 1.69（Win7 最后一个版本）

- 下载：https://code.visualstudio.com/updates/v1_69
- 选择 **Windows x64 System Installer**

### 2. 配置模型

**远程 DeepSeek API（推荐）：**
```json
{
  "win7-ai-coder.openaiBaseUrl": "https://api.deepseek.com/v1",
  "win7-ai-coder.openaiApiKey": "sk-...",
  "win7-ai-coder.openaiModel": "deepseek-chat",
  "win7-ai-coder.temperature": 0.0
}
```

**本地模型（llama.cpp / Ollama）：**
```bat
llama-server.exe -m deepseek-coder.Q4_K_M.gguf --port 8080
:: 或
ollama serve
ollama pull deepseek-coder:6.7b
```

### 3. 安装扩展

```bash
# 复制到 VSCode 扩展目录
cp -r win7-ai-coder ~/.vscode/extensions/
# 重启 VSCode
```

或 `Ctrl+Shift+P` → `Developer: Install Extension from Location...` → 选择本项目

---

## 🎮 使用

| 操作 | 方式 |
|------|------|
| 打开聊天 | 左侧活动栏 🤖 图标，或 `AI Chat: Open Chat Panel` |
| @-mention 上下文 | 输入框打 `@` → 选择文件/文件夹/搜索/命令 |
| Slash 命令 | 输入框打 `/` → 选择或直接输入 |
| 询问选中代码 | 选中代码 → 右键 → `Ask About Selected Code` |
| 解释文件 | 右键 → `Explain This File` |
| 生成文档 | 右键 → `Generate Documentation` |
| 发送 | Enter（Shift+Enter 换行） |

---

## 🏗️ 项目结构

```
win7-ai-coder/
├── package.json          # 扩展清单 (v4)
├── extension.js          # 扩展入口 (1234行) — Agent Loop + @-mention 解析 + 命令执行
├── media/
│   ├── chat.css          # 聊天面板样式 (230行) — 含弹出框样式
│   └── chat.js           # 聊天面板脚本 (731行) — @-mention UI + 命令UI + Markdown渲染
├── resources/
│   └── icon.png
├── .vscodeignore
└── README.md
```

## 🔧 技术栈

| 组件 | 说明 |
|------|------|
| VSCode 1.69 | Win7 最后支持版本（Node 12.x 内置） |
| Webview API | VSCode 自带，无外部依赖 |
| Node.js http/https | 内置模块，直接请求 DeepSeek / OpenAI / Ollama API |
| Catppuccin Mocha | 美观暗色主题 |
| ⚠️ 零 npm 依赖 | 仅使用 `@types/vscode` 做类型提示（devDependency） |

## 🔑 兼容性

- ✅ Windows 7 SP1
- ✅ VSCode 1.69 ~ 1.70
- ✅ 无 Python 依赖（纯 Node.js）
- ✅ 无外部 npm 运行时依赖

## 📄 License

MIT
