---
description: 查看 DeepSeek 作业状态、耗时及最近进度，可等待结束
argument-hint: "[作业编号] [--wait] [--timeout-ms <毫秒>] [--cwd <目录>] [--json]"
allowed-tools: Bash(node:*)
---

!`CLAUDE_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA}" node "${CLAUDE_PLUGIN_ROOT}/scripts/deepseek-companion.mjs" status $ARGUMENTS`

把输出原样展示给用户。不带编号时查看最近创建的作业；`--wait` 等到终态，`--timeout-ms` 只限制等待时间，超时后作业继续运行。
