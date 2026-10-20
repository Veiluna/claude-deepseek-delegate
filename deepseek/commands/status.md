---
description: 查看 DeepSeek 作业状态、耗时及最近进度，可等待结束
argument-hint: "[作业编号] [--all] [--wait] [--timeout-ms <毫秒>] [--cwd <目录>] [--json]"
allowed-tools: Bash(node:*)
---

!`CLAUDE_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA}" CLAUDE_SESSION_ID="${CLAUDE_SESSION_ID}" node "${CLAUDE_PLUGIN_ROOT}/scripts/deepseek-companion.mjs" status $ARGUMENTS`

把输出原样展示给用户。默认只查看当前 Claude 会话的作业，不带编号时列出全部；`--all` 查看整个项目。`--wait` 等待所列作业全部结束，`--timeout-ms` 只限制等待时间，超时后作业继续运行。`--json` 不带编号时输出数组，带编号时输出单条记录。
