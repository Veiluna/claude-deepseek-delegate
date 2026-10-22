# Codex 审阅流程

本流程供 review 与 adversarial-review 两种显式调用的 skills 共用。使用 `codex-cli.md` 的临时 JSON 请求文件及固定启动代码，调用共享 `deepseek-host.mjs codex` 入口；用户数据始终保存在 `args` 数组或 stdin `prompt` 中，不拼进 shell。

## 预检与执行方式

1. 只解析 `--` 前的选项：`--base <引用>`、`--scope auto|working-tree|branch`、`--model <模型名>`、`--effort off|low|high|max`、`--background`、`--cwd <目录>`、`--json`。完整保留范围、模型和强度。附加关注点仅由 adversarial-review 接收，使用 `--prompt-stdin` 时与位置正文互斥，只有空白的正文报错；仅用 trim 判空，实际传递的原文保持不变。
2. 先发送 `args: ["review-context", <用户选项>]`；有关注点时加 `--prompt-stdin` 并写 `prompt`。预检不启动 dsh。退出码非 0 或 JSON 无效时展示错误并停止。`empty:true` 时展示“没有可审阅的变更。”并停止。未跟踪文件计入文件数和差异大小；不能仅凭已跟踪 diff 为空判定范围为空。
3. 最多 2 个文件且差异不超过 64 KiB 时建议前台；更多文件、更大差异或规模不明时建议后台。用户已指定 `--background` 或明确选择前台时沿用，不再询问。否则说明建议，只询问一次，提供“前台等待”“后台运行”两个选项，推荐项放在前面。使用当前宿主可用的提问工具；没有该工具时向用户提问并等待下一条回复。选择明确前不执行审阅；取消或没有选择时停止，不代选或重复询问。
4. 将命令替换为 skill 指定的 `review` 或 `adversarial-review`，保留同一项目目录、范围、模型、强度、JSON 选项和关注点原文。后台选择添加 `--background`，前台选择不传该参数，所有选项均放在 `--` 之前。只启动一次；继续等待同一执行进程，不因轮询而重启。

## 范围与结果

`--scope auto` 有本地变更时审阅暂存、未暂存和未跟踪内容，工作树干净时审阅分支；`--scope working-tree` 固定本地范围，`--scope branch` 固定提交范围。`--base` 使用与指定引用的共同祖先，不包含本地未提交内容，不能与 `--scope working-tree` 同用。自动基准依次查找 `origin/HEAD`、`main`、`master`、`trunk`；无法确定时报错，不 fetch。

审阅始终以 `read-only` 权限在项目根目录运行，不替换可续接线程。`--model` 与 `--effort` 只覆盖本次，未指定时沿用 Harness 设置。`--json` 返回运行结果和结构化 `review`；最终结果仅以共享核心返回的 `final` 为准，截断进度不能当最终回复。原样展示 stdout、stderr、警告与退出状态；成功、解析失败和外部失败均保留核心给出的结果。解析失败时展示保留的原始最终回复；临时模型配置失败时沿用核心隐藏敏感原始输出的保护。

调用失败、授权被拒或结果解析失败时停止，不自动重试、修复或扩大权限。后台立即返回作业编号，可按用户请求通过 `$deepseek:status <编号> --wait`、`$deepseek:result <编号>`、`$deepseek:cancel <编号>` 管理。默认仅当前宿主会话可查询与取消。后台要求当前 Codex 主线程有有效的 SessionStart 登记；未知或未登记身份展示错误，按正常 `/hooks` 流程检查启用与信任，不生成身份、猜测父线程或改写登记。前台不依赖登记。
