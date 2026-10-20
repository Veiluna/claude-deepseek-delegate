---
description: 让 DeepSeek 以只读方式挑战 git 变更的设计选择与假设
argument-hint: "[--base <引用>] [--scope auto|working-tree|branch] [--model <模型名>] [--effort off|low|high|max] [--background] [--cwd <目录>] [--json] [-- 关注点]"
disable-model-invocation: true
allowed-tools: Bash(node:*), AskUserQuestion
---

用户明确调用本命令时，运行对抗式审阅并原样展示结果。重点挑战设计选择、权衡、假设及失败模式；不是单纯更严格地寻找实现缺陷。只审阅，不自动修复；审阅者的选择遵循项目 CLAUDE.md。

用户参数与关注点：

$ARGUMENTS

下面示例中的 `$ARGUMENTS` 是参数占位符。实际调用 Bash 时，逐参数使用安全的 shell 引号，不能把关注点或用户原文直接拼进命令；空格、引号、`$()` 等字符必须原样作为数据传递。

用同一组参数预检范围与规模，不启动 dsh：

```bash
CLAUDE_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA}" CLAUDE_SESSION_ID="${CLAUDE_SESSION_ID}" node "${CLAUDE_PLUGIN_ROOT}/scripts/deepseek-companion.mjs" review-context $ARGUMENTS
```

预检失败时展示错误并停止。`empty` 为 true 时展示“没有可审阅的变更。”并停止。最多 2 个文件且差异不超过 64 KiB 时建议前台；更多文件、更大差异或规模不明时建议后台。未跟踪文件也计入规模。

用户已指定 `--background` 时直接沿用；用户已明确选择前台时不再询问。否则说明建议，用一次 `AskUserQuestion` 提供“前台等待”“后台运行”两个选项，推荐项放在前面。后台选择增加 `--background`，且必须放在 `--` 之前；前台选择不传该参数。完整保留用户关注点，不增删、不改写。

```bash
CLAUDE_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA}" CLAUDE_SESSION_ID="${CLAUDE_SESSION_ID}" node "${CLAUDE_PLUGIN_ROOT}/scripts/deepseek-companion.mjs" adversarial-review $ARGUMENTS
```

`--scope auto` 在有本地变更时审阅暂存、未暂存和未跟踪内容，工作树干净时审阅分支。`--scope working-tree` 固定本地范围；`--scope branch` 固定提交范围。`--base` 指定分支比较的基准，使用共同祖先，不包含本地未提交内容，不能与 `--scope working-tree` 同用。自动基准依次查找 origin/HEAD、main、master、trunk；无法确定时报错，不 fetch。

`--model`、`--effort` 只覆盖本次审阅，未指定时沿用 Harness 设置。后台立即返回对抗式审阅作业编号，用 `/deepseek:status <编号> --wait`、`/deepseek:result <编号>`、`/deepseek:cancel <编号>` 管理。`--json` 返回运行结果及结构化 `review`；解析失败保留原始最终回复和错误。审阅始终只读，不改变可续接线程。
