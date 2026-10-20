---
description: 取消 DeepSeek 作业并结束其整个进程树
argument-hint: "<作业编号> [--cwd <目录>] [--json]"
allowed-tools: Bash(node:*)
---

!`CLAUDE_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA}" node "${CLAUDE_PLUGIN_ROOT}/scripts/deepseek-companion.mjs" cancel $ARGUMENTS`

把输出原样展示给用户。必须提供作业编号；已经结束的作业保留原终态，重复取消已取消的作业不会重新启动或执行任务。
