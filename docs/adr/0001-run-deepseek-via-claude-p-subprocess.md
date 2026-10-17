---
status: superseded by ADR-0004
---

# 通过 `claude -p` 子进程运行 DeepSeek，而非直接调用 DeepSeek API

DeepSeek 提供 Anthropic 兼容接口，我们启动一个环境变量指向 DeepSeek 的 `claude -p` 子进程来执行任务，而不是自己调用 HTTP API。这样 DeepSeek 直接获得 Claude Code 的读写文件、执行命令和续接线程能力，无需自建工具循环；代价是依赖本机安装 Claude Code，且行为随 Claude Code 版本变化。
