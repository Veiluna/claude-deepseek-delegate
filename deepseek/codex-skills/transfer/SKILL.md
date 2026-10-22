---
name: transfer
description: 将 Codex 主线程记录整理成交接说明，在 DeepSeek 中只读新开线程，供用户继续。
---

仅在用户显式调用本 skill 时转交。读取 `../../references/codex-cli.md`，按其中的数据文件与固定启动代码调用共享宿主入口。

## 调用

只接收 `--source <记录.jsonl>`、`--max-chars <512-64000>`、`--cwd <目录>`、`--json`。把请求 `args` 设为 `["transfer", <用户选项>]`，不写 `prompt`。交接说明由本地适配器生成，临时请求文件只包含本次选项。

默认使用当前真实主线程的 SessionStart 登记；明确宿主来源优先于登记，用户的 `--source` 优先于两者。默认或明确宿主来源绑定当前真实编号；用户通过 `--source` 可选择同项目另一合法主线程，即使当前编号未知也可使用。来源缺失、身份不符或记录不支持时展示错误并停止，按正常 `/hooks` 流程检查登记，不选择其他记录。

只启动一次并等待同一进程完成。成功时原样展示线程 ID、项目根、Harness 指引和 `dsh tui --resume` 命令；失败时原样展示错误和退出状态。转交以只读方式新开 DeepSeek 线程，仅要求确认收到并等待用户继续；原宿主记录、登记与项目可续接线程保持不变。

## 支持范围

只读取 `CODEX_HOME/sessions`（默认 `~/.codex/sessions`）内的普通 `.jsonl`，核对真实路径、首条 metadata 的主线程身份和项目根。仅支持已核实的 `cli`、`vscode`、`exec`、`mcp` 来源；subagent、未知来源及未知格式停止，不扫描最新文件。

只保留 `response_item` 中用户的 `input_text` 和助手明确 `phase: final_answer` 的 `output_text`；`event_msg` 消息不重复消费。缺失、未知或其他 phase 的助手文字省略；工具仅保留固定概况，分析、工具正文、文件全文和常见凭据由共用过滤器排除。event-only 记录不支持，缺失内容保持未知。

交接说明共用五部分结构及长度预算，默认 12000 个 UTF-16 单元；先省略旧工具概况，再压缩早期文字，并报告计数。Harness 尚未登记工作区时，按输出手动登记项目根；`tui` 需要本机已有对应 profile，插件不自动安装或修改配置。
