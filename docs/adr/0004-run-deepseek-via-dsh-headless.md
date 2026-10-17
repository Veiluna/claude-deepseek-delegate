# 通过本机 `dsh --profile headless` 运行 DeepSeek

取代 ADR-0001。我们改为调用本机 DeepSeek Harness 的 `dsh --profile headless --json`：DeepSeek 线程就是 Harness 的会话，用户能在 Harness 里查看和继续，与 codex 插件在本机 codex 中运行的方式一致；认证使用 Harness 的登录状态，不再需要 `DEEPSEEK_API_KEY`。权限映射到 `DSH_PERMISSION_MODE`（可写任务为 `workspace-write`，只读任务和审阅为 `read-only`），模型和推理强度通过 `--patch` 覆盖文件按次指定。

## Considered Options

- **ACP（`dsh --profile acp`）**：能把授权请求交给插件自动回答，切换模型也更干净，但需要自己实现一个 JSON-RPC 客户端。headless 下需要授权的操作会直接被拒绝（fail closed），不会卡住；只要工作目录是项目根目录，正常写代码不需要授权，所以选了更简单的 headless。

## Consequences

- 工作目录必须是项目根目录，否则写入仓库根目录会越界被拒。
- 每次发给 DeepSeek 的消息都要声明"只在工作区内写入，不请求提升权限"，避免浪费轮次。
- 插件不自动批准任何授权请求。
- headless 的 `--json` 事件里，除 `final` 外的字符串会被截断到 8 KiB，最终回复只能以 `final` 为准。
