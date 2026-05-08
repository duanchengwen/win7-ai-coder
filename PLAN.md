# Continue Win7 Port — 分工计划

## 目标
将 Continue.dev VSCode 扩展的核心功能移植到 Windows 7 + VSCode 1.69
- 输出：一个可在 VSCode 1.69 (Node 12) 上运行的 VSCode 扩展
- 零 npm 运行时依赖，纯 JS（CommonJS），无编译步骤
- 保留 Continue 的核心 UX：Chat + @-mentions + Slash 命令 + Tab 补全 + 代码编辑

## 策略
不是翻译 TS 到 JS（那会是个噩梦），而是：
1. 研究 Continue 的架构、协议、功能
2. 用 win7-ai-coder v5 作为基础框架
3. 按照 Continue 的 Feature Set 逐个加功能

## 团队分工

### 员工 1: 架构分析员 (Architecture Analyst)
- 研究 continue-win7 的 `extensions/vscode/src/` 目录
- 重点文件：extension.ts, ContinueGUIWebviewViewProvider.ts, VsCodeIde.ts, commands.ts, webviewProtocol.ts
- 研究 `gui/src/` 目录了解前端与扩展的通信协议
- 研究 `core/protocol/` 了解 IDE 与 Core 的通信机制
- 输出：架构分析报告（协议、消息类型、组件关系）

### 员工 2: 扩展核心开发者 (Extension Core Developer)
- 基于 win7-ai-coder v5 的 extension.js
- 加入 Continue 的核心功能：
  * Slash 命令系统（从 core/commands/slash/ 提取）
  * Context Provider 系统（从 core/context/providers/ 提取设计）
  * MCP 连接支持（从 core/context/mcp/ 提取协议）
  * @-mention 完整上下文系统
  * Diff/Edit 应用（从 core/edit/ 提取）
- 确保所有代码 Node 12 兼容

### 员工 3: 前端 UI 开发者 (Frontend UI Developer)
- 基于 win7-ai-coder v5 的 media/chat.js 和 chat.css
- 参考 gui/src/ 的设计：
  * Chat 对话界面
  * @-mention 弹出框（类似 Continue 的 context provider 选择）
  * Slash 命令选择器
  * 代码块显示与复制
  * Diff 预览
  * 设置面板
  * 工具调用进度显示
- 暗色 Catppuccin Mocha 主题

### 员工 4: 打包和发布 (Packaging & Release)
- 更新 package.json（commands, config, menus）
- 创建 package.js 脚本生成 VSIX
- 更新 README
- 推送到 GitHub

## 工作流程
1. 员工 1 先分析架构，产出报告
2. 员工 2、3 并行工作
3. 员工 4 最后集成
