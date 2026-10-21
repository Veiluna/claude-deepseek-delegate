---
description: 取回 DeepSeek 作业结果，默认取最近完成的作业
argument-hint: "[作业编号] [--cwd <目录>] [--json]"
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/deepseek-host.mjs" claude result $ARGUMENTS`

把输出原样展示给用户。未结束的作业会报告错误；不带编号时选择当前项目中最近完成的作业。只有 `final` 是最终回复，进度文本不能替代结果。
