---
description: 将当前 Claude 会话整理成交接说明，在 DeepSeek 中新开线程继续
argument-hint: "[--source <Claude 项目记录.jsonl>] [--max-chars <512-64000>] [--cwd <目录>] [--json]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

用户明确调用本命令时，将 Claude 会话转交给 DeepSeek。原 Claude 会话不受影响；不会关闭、切换或改写其记录，也不改变项目的可续接线程。

用户参数：

$ARGUMENTS

```bash
CLAUDE_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA}" CLAUDE_TRANSCRIPT_PATH="${CLAUDE_TRANSCRIPT_PATH}" node "${CLAUDE_PLUGIN_ROOT}/scripts/deepseek-companion.mjs" transfer $ARGUMENTS
```

示例中的 `$ARGUMENTS` 是参数占位符。实际调用 Bash 时逐参数使用安全的 shell 引号，路径中的空格、引号、`$()` 等字符作为数据传递，不把用户原文直接拼入 shell 命令。

默认来源是 SessionStart 登记的 `CLAUDE_TRANSCRIPT_PATH`；也可用 `--source` 明确选择记录。只接受 `~/.claude/projects/` 下的普通 `.jsonl`；设置 `CLAUDE_CONFIG_DIR` 时使用该目录的 `projects/`。不扫描其他 Claude 会话、不猜最新记录、不跟随逃逸该目录的链接。来源缺失、格式损坏或没有可转交文字时停止，不改用其他来源。

本地先整理五部分交接说明：目标；已定决策与约束（含不要做的事）；涉及文件（路径与变更概况）；验收标准；输出要求。保留用户与 Claude 的文字往来，按标题和明确关键词归类；没有明确记载的部分保持未知。工具调用只保留一行概况，并区分请求与已核实的结果。

过滤工具正文、文件代码块、明确标记的文件全文与思考区，以及常见凭据格式。不会把原始 JSONL 或完整工具输出交给 dsh。长度预算默认 12000 个 UTF-16 单元，`--max-chars` 可设为 512 到 64000；先删除最旧工具概况，再截取早期文字摘要，仍不足时省略最早文字。预算内保留五部分结构，输出中报告省略与压缩数量。

整理后以只读方式新建一个 DeepSeek 线程，把交接说明作为首条消息，仅要求确认收到并等待用户继续，不自动执行交接任务，不请求提升权限。只有成功完成且收到有效线程 ID 时，才展示线程 ID、`dsh tui --resume <线程ID>` 与 Harness 打开方式。`tui` 命令需要本机存在对应 profile；本插件不自动安装或修改 Harness profile。

Harness 按已登记工作区显示线程。输出会给出实际项目根目录；尚未登记时，先在 Harness 中将该目录登记为工作区，再查找对应线程。插件不自动修改桌面端的工作区登记。

把 companion 输出原样展示给用户，失败时展示错误并停止，不把不完整返回当作转交成功。
