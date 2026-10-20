---
description: 把一项任务交给 DeepSeek 执行
argument-hint: "[--background] [--resume | --fresh] [--model <模型名>] [--effort <off|low|high|max>] [--read-only] [--cwd <目录>] <任务描述>"
---

把下面的任务交给 DeepSeek 执行：

$ARGUMENTS

用户指定 `--background` 时，原样传给子代理的 companion 调用。命令立即返回作业编号，任务在分离的 worker 中继续运行；用 `/deepseek:status <作业编号> [--wait] [--timeout-ms <毫秒>]` 查询，`/deepseek:result [作业编号]` 取结果，`/deepseek:cancel <作业编号>` 取消。每项目最多保留 50 个作业，创建新作业时淘汰最旧的记录和日志；若最旧作业仍在运行，先结束其进程树。后台启动时显式传入 `CLAUDE_SESSION_ID="${CLAUDE_SESSION_ID}"`，记录所属 Claude 会话；续接选择和权限规则仍逐次适用。

`--model <模型名>` 和 `--effort <off|low|high|max>` 只覆盖本次任务，可以与 `--resume` 或 `--fresh` 配合；只有用户明确指定时才传给子代理。未指定时沿用 Harness 当前设置。指定覆盖时，companion 先读取当前配置并合并字段，临时覆盖文件用完即删；配置读取或解析失败时停止，不使用固定默认值。参数放在任务描述前；`--` 后的文字始终是任务正文。

`--effort` 覆盖 `llm-deepseek.reasoningEffort`；若 `agent-default-model` 当前 config 已有 `reasoningEffort` 键，也同步覆盖，未有该键则不新增。仅指定 `--effort` 时允许没有 `agent-default-model` 条目。临时目录删除失败时会向 stderr 输出含目录路径的警告，任务结果与线程保存仍按任务本身的结果处理。

先在当前 Claude 会话里完成线程选择，再调用子代理：

1. 用 Bash 查询当前项目的可续接线程：

   ```bash
   CLAUDE_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA}" node "${CLAUDE_PLUGIN_ROOT}/scripts/deepseek-companion.mjs" task-resume-candidate --json
   ```

   `CLAUDE_PLUGIN_DATA` 的值使用 Claude Code 在本 Markdown 中展开的路径，在每次 Bash 调用中显式传入，不能依赖 Bash 已导出它。用户指定 `--cwd <目录>` 时，查询也传同一个 `--cwd <目录>`，用正确的 shell 引号保护路径。保留这次查询返回的 `threadId` 和 `summary`，只查询候选，不执行任务。查询失败时展示错误并停止，不把查询失败当成没有候选。

2. 只有候选查询退出码为 0 且 JSON 解析成功时才继续；状态读取失败、状态损坏或查询输出无法解析时，展示错误并停止，不能默认 `--fresh`。只把任务描述前的 `--resume`、`--fresh` 当作路由参数；`--` 后的文字属于任务描述。两者同时出现时提示互斥并停止。用户已明确指定其中一个时沿用选择，不再询问。没有指定时：
   - `available` 为 `false`：选择 `--fresh`，不询问。
   - `available` 为 `true`：显示 `summary`（上次任务摘要），用一次 `AskUserQuestion` 询问“继续可续接线程，还是新开 DeepSeek 线程？”，提供“继续”和“新开”两个选项。选择“继续”转成 `--resume`，选择“新开”转成 `--fresh`。拿到选择前不启动任务；用户取消或没有明确选择时停止，不代选、不重复询问。

3. 调用 `deepseek:deepseek-agent` 子代理，把选定的路由参数 `--resume` 或 `--fresh`、用户的其他参数（包括 `--background`、`--read-only`、`--cwd`）和任务原文交给它。同时传入此处展开的所属 Claude 会话 ID `${CLAUDE_SESSION_ID}`，要求子代理把该值赋给 `CLAUDE_SESSION_ID`，不能改成子代理自己的编号。选择 `--resume`（包括用户显式指定）且本次查询有候选时，必须同时传 `--expected-thread-id <本次查询的 threadId>`，绑定已展示或选定的线程；不能重新查询并替换这个 ID。选择 `--fresh` 时不传 `--expected-thread-id`。路由参数必须与任务正文分开，放在 `--` 前，不能写进任务描述。子代理不再查询候选或询问用户；companion 报告候选变化时原样返回并停止，不自动重试或再次询问。

子代理返回后，把 DeepSeek 的输出原样展示给用户，再按需要审阅改动。成功结果伴随“可续接线程未能保存”警告时，也展示警告及其中的线程 ID；任务已经完成，不因保存警告重新执行任务。
