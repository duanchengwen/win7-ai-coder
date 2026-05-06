#!/usr/bin/env python3
"""Mock OpenAI-compatible API for testing the VSCode extension.
Runs on http://localhost:8080/v1 — compatible with llama.cpp server API.
If a real model is available via Ollama, it can proxy to it.
"""
import os, sys, json, time, threading, http.server

PORT = 8080

class MockHandler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path == '/v1/chat/completions':
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length > 0 else {}
            messages = body.get('messages', [])
            user_msg = messages[-1]['content'] if messages else ''
            stream = body.get('stream', False)

            if stream:
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.send_header('Cache-Control', 'no-cache')
                self.end_headers()

                reply = self._generate_reply(user_msg)
                for ch in reply:
                    chunk = {"choices": [{"delta": {"content": ch}, "index": 0}]}
                    self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
                    self.wfile.flush()
                    time.sleep(0.02)
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()
            else:
                reply = self._generate_reply(user_msg)
                resp = {
                    "choices": [{"message": {"role": "assistant", "content": reply}}],
                    "usage": {"total_tokens": len(reply.split())}
                }
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps(resp, ensure_ascii=False).encode())
        else:
            self.send_response(404)
            self.end_headers()

    def do_GET(self):
        # Health check
        if self.path == '/health' or self.path == '/':
            self.send_response(200)
            self.send_header('Content-Type', 'text/plain')
            self.end_headers()
            self.wfile.write(b"OK - Mock AI Server Running\n")
        elif self.path == '/v1/models':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({"data": [{"id": "mock-ai"}]}).encode())
        else:
            self.send_response(404)
            self.end_headers()

    def _generate_reply(self, msg):
        msg_lower = msg.lower()

        # Code context detection
        if "```" in msg and ("explain" in msg_lower or "解释" in msg):
            return (
                "## 代码分析\n\n"
                "这是你提供的代码，我来逐段解释：\n\n"
                "1. **函数结构** — 代码定义了一个清晰的函数，包含正确的类型注解\n"
                "2. **算法逻辑** — 使用了标准的算法实现，时间复杂度为 O(n log n)\n"
                "3. **边界处理** — 对空输入和单元素情况都有正确处理\n\n"
                "```python\n"
                "# 改进建议：可以添加更详细的文档字符串\n"
                "def improved_version(arr: list) -> list:\n"
                '    """优化版本 — 添加了完整的文档。"""\n'
                "    ...\n"
                "```\n\n"
                "需要我详细解释某个具体部分吗？😊"
            )

        if "fibonacci" in msg_lower or "斐波那契" in msg:
            return (
                "## 当前文件分析\n\n"
                "你打开的 `main.py` 包含两个经典算法：\n\n"
                "### 1. Fibonacci 函数\n"
                "```python\n"
                "def fibonacci(n: int) -> list:\n"
                "    seq = [0, 1]\n"
                "    for _ in range(n - 2):\n"
                "        seq.append(seq[-1] + seq[-2])\n"
                "    return seq[:n]\n"
                "```\n"
                "✅ 时间复杂度 O(n)，空间复杂度 O(n)\n"
                "✅ 正确处理 n≤0 和 n=1 的边界情况\n\n"
                "### 2. Quicksort 实现\n"
                "使用三路分区（Dutch national flag），对重复元素友好。\n\n"
                "**建议改进**: 可以添加文档字符串和参数类型检查。"
            )

        if "怎么说" in msg or "测试" in msg:
            return (
                "🎉 **AI Coder 已成功运行！**\n\n"
                "这是一个模拟的 AI 回复，说明扩展已经正确连接到 API 服务。\n\n"
                "当连接真正的 DeepSeek 或 Qwen 模型时，你会得到：\n"
                "- 实时代码补全建议\n"
                "- 代码解释和优化\n"
                "- 自动生成文档注释\n"
                "- Bug 修复建议\n\n"
                "**配置真实模型**：修改 VSCode 设置中的 `win7-ai-coder.openaiBaseUrl` 指向你的模型服务。"
            )

        return (
            f"💬 收到你的问题：*{msg[:60]}{'...' if len(msg)>60 else ''}*\n\n"
            "这是模拟的 AI 回复。扩展已正确运行！\n\n"
            "要连接真实模型，请：\n"
            "1. 启动模型服务（Ollama / llama.cpp / vLLM）\n"
            "2. 修改配置中的 `openaiBaseUrl` 和 `modelName`\n\n"
            "就可以开始真正的 AI 编程辅助了 🚀"
        )

    def log_message(self, format, *args):
        print(f"[{time.strftime('%H:%M:%S')}] {args[0]}")


if __name__ == '__main__':
    server = http.server.HTTPServer(('0.0.0.0', PORT), MockHandler)
    print(f"🌟 Mock AI Server 已启动: http://localhost:{PORT}")
    print(f"   API: http://localhost:{PORT}/v1/chat/completions")
    print(f"   Ctrl+C 停止")
    server.serve_forever()
