# deepseek

Claude Code 插件：通过本机 DeepSeek Harness 的 `dsh` 调用 DeepSeek，支持前台任务、后台作业、续接 DeepSeek 线程、只读审阅，以及把当前 Claude 会话整理成交接说明后转交。

插件提供调用接口，调用时机由 Claude 与用户决定。版本为 `0.3.0`；marketplace 名仍为 `deepseek-delegate`，插件名已改为 `deepseek`。

## 前置条件

- 已安装 Claude Code，`claude` 可在终端运行。
- 已安装 Node.js 18 或更高版本，`node` 可在 Claude Code 使用的终端运行。本仓库在 Node.js 24 下验证。
- 已在本机安装 DeepSeek Harness 并完成登录；`dsh` 支持 `--profile headless --json`。认证使用 Harness 的登录状态，不需要为本插件配置 `DEEPSEEK_API_KEY`。
- 在要工作的项目目录中启动 Claude Code。插件会将 dsh 的工作目录设为项目根目录；可用命令的 `--cwd <目录>` 明确指定项目。

插件依次从环境变量 `DSH_BIN`、`PATH` 和默认安装位置查找 dsh。若找不到，可将 `DSH_BIN` 设置为 dsh 的完整路径（Windows 上通常是 `dsh.cmd`），重新启动 Claude Code 后运行 `/deepseek:setup`。

## 安装

在终端执行：

```bash
claude plugin marketplace add Veiluna/claude-deepseek-delegate
claude plugin install deepseek@deepseek-delegate --scope user
```

若已添加该 marketplace，先运行 `claude plugin marketplace update deepseek-delegate` 刷新目录，再安装。上述命令安装到用户范围；团队项目可按需将 `--scope user` 改为 `--scope project`，仅本项目本机使用可改为 `--scope local`。

打开新的 Claude 会话，运行：

```text
/deepseek:setup
```

它会报告共享数据根、项目目录、Node 版本、dsh 路径和版本，并通过一个最小只读任务检查 Harness 登录及调用是否可用。检查失败时按输出处理环境问题；插件不会自行修复环境。

## 共享数据与从 0.2.0 迁移

新的 Claude 入口使用 `DEEPSEEK_DATA_DIR`，未设置时使用 `~/.deepseek-plugin/`。项目候选、作业和日志位于 `projects/<项目键>/`；`hosts/` 为宿主登记保留。Claude 与后续 Codex 入口使用同一个共享根，项目的 DeepSeek 线程可以跨宿主续接。

旧底层脚本仍兼容直接调用：未设置 `DEEPSEEK_DATA_DIR` 时使用 `CLAUDE_PLUGIN_DATA` 或旧默认目录，项目目录直接位于旧根下；设置共享变量后则使用其 `projects/`。新入口不会自动合并旧数据。普通 setup 若能读取 `CLAUDE_PLUGIN_DATA`，只提示该路径，不猜测旧目录。

升级已有 `deepseek` 0.2.0 数据时，先停止旧调用，在运行任何项目任务或候选查询前显式执行（路径以实际旧插件数据目录为准）：

```text
/deepseek:setup --migrate-from "<旧插件数据目录>"
```

迁移复制旧根的全部项目候选、明确终态作业及日志，保留未知字段并调整日志路径，源目录保持可用；本次不运行 dsh 连通性检查。活动作业、目标 `projects/` 已有任何数据（包括初始化的空项目目录）、损坏记录或不安全路径都会停止，不能用它覆盖合并目标。已有 `hosts/` 登记和普通环境检查不会阻断迁移。失败或中断不会发布半成品；停止旧调用后可显式重试，同级 `.projects.migration-*.tmp/` 暂存目录不会自动删除。新普通入口等待迁移完整发布后才读取项目。

## 从旧版迁移

旧版 `deepseek-delegate` 使用 API Key、PowerShell 脚本和自动分派规则，已停止发布。先卸载旧插件，再刷新 marketplace 并安装新插件：

```bash
claude plugin uninstall deepseek-delegate@deepseek-delegate --scope user
claude plugin marketplace update deepseek-delegate
claude plugin install deepseek@deepseek-delegate --scope user
```

卸载范围应与原安装一致：原来安装在 `project` 或 `local` 范围的，将卸载命令的 `--scope user` 改为对应范围。若旧插件安装在多个范围，分别卸载，避免旧规则继续加载。

不再需要本插件专用的 `DEEPSEEK_API_KEY`、`DEEPSEEK_MODEL`；确认其他工具不依赖后可自行移除。新插件不读取这些变量，默认模型与推理强度沿用 Harness 设置，仅在命令显式指定时覆盖本次调用。已退役 `deepseek-delegate` 的状态不会转换为新插件的可续接线程或作业；已有 `deepseek` 0.2.0 数据按上节显式迁移。

退出旧 Claude 会话并打开新会话，确认 `/deepseek:*` 命令和 `deepseek:deepseek-agent` 子代理可见，再运行 `/deepseek:setup`。新会话开始时不应出现旧版自动分派规则；新插件的会话钩子只登记 Claude 会话信息，并在会话结束时清理所属后台作业。

## 命令

在 Claude Code 中使用以下命令。`--model` 与 `--effort off|low|high|max` 只覆盖本次调用；不指定时使用 Harness 当前设置。任务描述或关注点以 `--` 与选项分开，可避免以 `--` 开头的正文被当作参数。

| 命令 | 用途与主要选项 |
| --- | --- |
| `/deepseek:setup [--migrate-from <旧插件数据目录>] [--json]` | 报告数据根并检查 Node、dsh；显式迁移时只复制旧数据。 |
| `/deepseek:task [选项] -- <任务描述>` | 执行任务；支持 `--background`、`--resume` 或 `--fresh`、`--model <模型名>`、`--effort <强度>`、`--read-only`、`--cwd <目录>`。 |
| `/deepseek:status [作业编号] [选项]` | 查看状态、耗时及最近进度；支持 `--all`、`--wait`、`--timeout-ms <毫秒>`、`--cwd <目录>`、`--json`。 |
| `/deepseek:result [作业编号] [--cwd <目录>] [--json]` | 取回最终结果；省略编号时取当前项目最近完成的作业。 |
| `/deepseek:cancel <作业编号> [--cwd <目录>] [--json]` | 取消作业，结束其进程树。 |
| `/deepseek:review [选项]` | 只读审阅 git 变更；支持 `--base <引用>`、`--scope auto|working-tree|branch`、`--model <模型名>`、`--effort <强度>`、`--background`、`--cwd <目录>`、`--json`。 |
| `/deepseek:adversarial-review [选项] [-- 关注点]` | 以只读方式挑战设计选择与假设，选项与 `review` 相同。 |
| `/deepseek:transfer [选项]` | 将当前 Claude 会话整理成交接说明，在 DeepSeek 中新开线程；支持 `--source <Claude 项目记录.jsonl>`、`--max-chars <512-64000>`、`--cwd <目录>`、`--json`。 |

### 任务与线程

```text
/deepseek:task --fresh -- 为日期转换函数补充边界测试并实现修复
/deepseek:task --resume --read-only -- 解释上次修改涉及的调用关系
/deepseek:task --background --fresh --model deepseek-flash --effort max -- 按验收标准实现功能并运行测试
```

未指定 `--resume` 或 `--fresh` 时，插件先查询当前项目的可续接线程。有候选时展示上次任务摘要，询问继续或新开；没有候选时新开。显式选择后不再询问。每次调用独立决定读写权限，不继承所续接线程的权限。成功任务更新可续接线程；审阅与转交不改变它。

`deepseek:deepseek-agent` 也可由 Claude 调用，负责将任务转发给 dsh 并原样返回最终回复。

### 后台作业

```text
/deepseek:status
/deepseek:status <作业编号> --wait --timeout-ms 30000
/deepseek:status --all
/deepseek:result <作业编号>
/deepseek:cancel <作业编号>
```

作业创建后立即返回编号。`status` 默认查看当前 Claude 会话的作业；`--all` 查看整个项目。等待超时只结束等待，作业继续执行。每项目最多保留 50 个作业，创建新作业时淘汰最旧的记录和日志；若其仍在运行，先结束进程树。会话结束时清理所属运行中作业。进度文本可能被截断，只有 dsh 的 `final` 事件是最终回复。

### 审阅与转交

```text
/deepseek:review --scope working-tree
/deepseek:review --base main --background
/deepseek:adversarial-review --scope branch -- 重点检查恢复流程的假设
/deepseek:transfer
```

审阅先预检范围与规模，小规模建议前台，较大或规模未知时建议后台；未明确选择时询问一次。`--scope auto` 有本地变更时检查暂存、未暂存及未跟踪内容，工作树干净时检查分支。`--scope working-tree` 固定本地范围；`--scope branch` 固定提交范围。`--base` 使用与指定引用的共同祖先，不包含本地未提交内容，不能与 `--scope working-tree` 同用。自动基准依次查找 `origin/HEAD`、`main`、`master`、`trunk`；找不到时停止，不自动 fetch。审阅不自动修复。

转交只接受 Claude 配置目录 `projects/` 下当前登记或通过 `--source` 指定的普通 `.jsonl` 记录。交接说明包含目标、已定决策与约束、涉及文件、验收标准和输出要求；过滤工具正文、文件全文和常见凭据格式，不发送完整记录。缺失的信息保持未知。它以只读方式新开 DeepSeek 线程，仅确认收到并等待用户继续，不自动执行交接任务；原 Claude 会话保持不变。

成功转交后按输出给出的线程 ID 与打开方式继续。终端续接使用 `dsh tui --resume <线程ID>`，需要本机存在对应 `tui` profile。Harness 仅在已登记工作区显示线程；必要时先手动登记输出中的项目根目录。

## 可写权限

任务默认使用 `DSH_PERMISSION_MODE=workspace-write`：DeepSeek 可以在项目工作区内修改文件和执行命令。请在受版本控制的项目中使用，检查改动后再提交。只需调查或解释时显式使用 `--read-only`；审阅和转交始终使用 `read-only`。

插件不自动批准 dsh 授权请求。headless 模式下，需要额外授权的操作会被拒绝；每次任务都会要求“只在工作区内写入，不请求提升权限”。遇到权限错误时按输出处理，不会自动切换为更宽权限。

## 可复制的 CLAUDE.md 分工示例

下面是可按项目需要复制到自己 `CLAUDE.md` 的示例。插件不会注入这段内容，也不提供自动评审关卡。

```markdown
## 工作分工（项目自定）

- Claude 负责澄清需求、确定设计和验收标准，并决定何时调用 DeepSeek。
- 适合交给 DeepSeek 的任务先说明目标、约束、涉及文件和验证命令，再通过 `/deepseek:task` 或 `deepseek:deepseek-agent` 执行。
- 调查任务使用 `--read-only`；需要修改文件时明确允许工作区内写入，禁止请求提升权限。
- 实现完成后，按本项目约定选择审阅者。需要 DeepSeek 审阅时显式调用 `/deepseek:review`；需要挑战设计假设时调用 `/deepseek:adversarial-review`。
- 提交前检查实际 diff 与测试结果，提交、推送由项目约定的负责人执行。
```

## 开发验证

在仓库根目录运行插件校验：

```bash
claude plugin validate ./deepseek
claude plugin validate ./.claude-plugin/marketplace.json
```

在 `deepseek/` 下运行 `npm test`。测试使用 fake dsh，不调用真实 dsh、不联网、不需要 Harness 登录。

## 许可

MIT
