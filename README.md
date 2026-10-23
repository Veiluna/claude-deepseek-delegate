# deepseek

Claude Code 与 Codex 插件：通过本机 DeepSeek Harness 的 `dsh` 调用 DeepSeek。两种宿主均支持环境检查、前台任务、后台作业、跨宿主续接 DeepSeek 线程、只读审阅、对抗式审阅及宿主会话转交。

插件提供调用接口，调用时机由宿主与用户决定。版本为 `0.3.5`；marketplace 名仍为 `deepseek-delegate`，插件名为 `deepseek`。

## 前置条件

- 已安装 Claude Code 或 Codex，对应的 `claude` 或 `codex` 可在终端运行。Codex CLI 接口以本机 `0.162.1` 为基线。
- 已安装 Node.js 18 或更高版本，`node` 可在宿主使用的终端运行。本仓库在 Node.js 24 下验证。
- 已在本机安装 DeepSeek Harness 并完成登录；`dsh` 支持 `--profile headless --json`。认证使用 Harness 的登录状态，不需要为本插件配置 `DEEPSEEK_API_KEY`。
- 在要工作的项目目录中启动宿主。插件会将 dsh 的工作目录设为项目根目录；可用命令的 `--cwd <目录>` 明确指定项目。

插件依次从环境变量 `DSH_BIN`、`PATH` 和默认安装位置查找 dsh。若找不到，可将 `DSH_BIN` 设置为 dsh 的完整路径（Windows 上通常是 `dsh.cmd`），重新启动宿主后运行对应的 setup 入口。

## 安装、更新与卸载

### Claude Code

在终端执行：

```bash
claude plugin marketplace add Veiluna/claude-deepseek-delegate
claude plugin install deepseek@deepseek-delegate --scope user
```

若已添加该 marketplace，先运行 `claude plugin marketplace update deepseek-delegate` 刷新目录，再安装。上述命令安装到用户范围；团队项目可按需将 `--scope user` 改为 `--scope project`，仅本项目本机使用可改为 `--scope local`。

更新已安装插件：

```bash
claude plugin marketplace update deepseek-delegate
claude plugin update deepseek@deepseek-delegate --scope user
```

卸载插件：

```bash
claude plugin uninstall deepseek@deepseek-delegate --scope user
```

更新、卸载的 scope 应与原安装一致；多范围安装须分别处理。先等待或取消本插件运行中的作业，再更新或卸载。卸载插件不会执行本插件的共享数据迁移或删除操作；共享数据根由用户单独管理，保留它可供重新安装后继续使用。

安装或更新后打开新的 Claude 会话，确认 `/deepseek:setup`、`/deepseek:task`、`/deepseek:status`、`/deepseek:result`、`/deepseek:cancel`、`/deepseek:review`、`/deepseek:adversarial-review`、`/deepseek:transfer` 八个命令及 `deepseek:deepseek-agent` 子代理可见。卸载后在新会话确认这些入口不再加载。检查环境时运行：

```text
/deepseek:setup
```

它会报告共享数据根、项目目录、Node 版本、dsh 路径和版本，并通过一个最小只读任务检查 Harness 登录及调用是否可用。检查失败时按输出处理环境问题；插件不会自行修复环境。

### Codex

在终端运行正常插件安装命令：

```bash
codex plugin marketplace add Veiluna/claude-deepseek-delegate --ref main --json
codex plugin add deepseek@deepseek-delegate --json
codex plugin list --json
```

已有 marketplace 时刷新目录并重新安装，以取得更新后的插件：

```bash
codex plugin marketplace upgrade deepseek-delegate --json
codex plugin add deepseek@deepseek-delegate --json
codex plugin list --json
```

卸载插件：

```bash
codex plugin remove deepseek@deepseek-delegate --json
codex plugin list --json
```

先等待或取消本插件运行中的作业，再更新或卸载。卸载移除插件安装及缓存；本插件不会因此迁移或删除 `DEEPSEEK_DATA_DIR` 中的共享项目数据。重新安装仍可使用原共享根，不要为重装清空它。

本地开发可将 marketplace add 的仓库来源替换为仓库根目录的绝对路径。原生目录清单位于 `.agents/plugins/marketplace.json`，组件保留在 `deepseek/` 内；Codex skills 放在清单显式指定的 `codex-skills/`，避免覆盖 Claude 默认发现的同名命令。

安装或更新后，分别打开新的 Codex 桌面聊天与 CLI 会话，确认 `deepseek:setup`、`deepseek:task`、`deepseek:status`、`deepseek:result`、`deepseek:cancel`、`deepseek:review`、`deepseek:adversarial-review`、`deepseek:transfer` 八个 skills 可见。卸载后在新会话确认入口不再加载。检查环境与执行任务时显式调用：

```text
$deepseek:setup
$deepseek:task --fresh -- 为日期转换函数补充边界测试并实现修复
$deepseek:task --resume --read-only -- 解释上次修改涉及的调用关系
```

任务、环境检查与作业 skills 保持按能力可发现，不附带分派策略。task 支持 `--background`、`--resume`、`--fresh`、`--read-only`、`--cwd`、`--model`、`--effort` 及 `--json`，续接选择规则与 Claude 相同。正文以 stdin 数据传递，保留原文及换行；有候选时询问一次，确认后候选变化则停止，不自动重试。后台返回编号后可用 `$deepseek:status`、`$deepseek:result`、`$deepseek:cancel` 管理作业；默认只作用当前宿主会话，`status --all` 显式查看项目全部。

审阅 skills 仅供用户显式调用，使用 `policy.allow_implicit_invocation: false`，插件命名空间自动生成 `deepseek:review` 与 `deepseek:adversarial-review`：

```text
$deepseek:review --scope working-tree
$deepseek:review --base main --background --json
$deepseek:adversarial-review --scope branch -- 重点检查恢复流程的假设
```

两种审阅支持 `--scope`、`--base`、`--model`、`--effort`、`--background`、`--cwd`、`--json`，与 Claude 使用同一范围采集、schema、作业及结果核心。先预检未跟踪文件在内的规模，空范围直接结束，未明确执行方式时按建议询问一次前台或后台。对抗式关注点用 stdin 保留原文。审阅始终只读，不自动修复，不改变可续接线程；失败时展示核心给出的错误与保留结果，不将截断进度当 `final`。

#### 正常钩子信任与会话结束

安装或启用插件不会自动信任 hooks。在 Codex 的启动审阅界面或 `/hooks` 中，检查 deepseek 的 SessionStart、SessionEnd 定义及它们指向的已安装脚本，再通过正常界面信任并启用本插件的钩子。更新后若定义变化而再次要求审阅，按新定义重新确认；不要跳过 hook trust。

完成信任后新开一个 Codex 主线程，验证 SessionStart 登记。后台作业需要有效的主线程登记；身份未知时可执行前台任务，不能伪造编号或登记来启动后台作业。SessionStart 只登记宿主上下文，不注入分派规则。

只有真正结束宿主会话才清理所属作业；回合结束、切换聊天以及恢复同一会话不会清理新作业。桌面端验证时，在合成会话创建运行中作业，先完成回合并切换后返回，再归档或删除仍打开的该合成聊天，核对两次动作后的作业状态。CLI 则正常退出该合成会话并核对所属作业。不要用 Stop 或手动发送钩子输入代替真实结束操作。

#### Codex 调用权限

Codex 的工具沙箱决定插件进程能访问哪些目录及网络。普通 `workspace-write` 不保证共享根 `~/.deepseek-plugin/`、Harness 运行数据和联网已获允许；安装插件、信任 hooks 或获得 `PLUGIN_DATA` 环境变量也不能作为这些权限已授予的证据。

需要额外权限时，由 Codex 对本次具体调用发起正常授权，说明子命令、项目根、共享数据目录以及实际所需的 Harness 数据和网络访问。审阅请求后决定是否批准；不要为此开启全局 full-access、跳过沙箱或批准通用 `node` 执行前缀。`--add-dir` 只增加可写目录，不授予网络访问。Codex 0.162.1 默认未启用 `request_permissions` 和命令内细粒度权限申请，按当前客户端实际提供的工具处理；skill 的执行细则见 [Codex 宿主调用](deepseek/references/codex-cli.md)。

宿主对具体调用的批准仅解决启动环境权限。dsh 仍按每次任务的 `workspace-write` 或 `read-only` 执行，插件不会自动批准 dsh 请求。调用被拒绝时停止；任务已经启动后遇到错误，先核对是否已有线程或作业，不自动重新启动。

Codex 的审阅与其它 skill 需要在宿主允许写入的临时目录中创建临时请求 JSON 文件来安全传参（实测多建在项目根），调用结束即删除。若宿主安装了在“审阅/只读模式”下禁止任何写入的第三方守卫钩子，调用会在启动 dsh 之前被拦下。此时需要用户按该守卫自己的方式授权本次写入，插件不会绕过或修改守卫。

离线测试使用复制后的安装包、合成钩子与假 dsh，能验证插件的输入、状态和权限映射；Windows 11 桌面端及 CLI 的实际安装、信任、工具沙箱和 Harness 连通性须分别记录实机结果。

### Codex 会话转交

用户显式调用 `$deepseek:transfer`，或用 `$deepseek:transfer --source "<记录.jsonl>" --max-chars 12000 --json` 选择来源。该 skill 使用 `policy.allow_implicit_invocation: false`，与 Claude 共用交接说明生成、隐私过滤和长度预算。只读新开 DeepSeek 线程，仅要求确认收到等待继续；原记录、宿主登记和项目可续接线程保持不变。

来源优先级为命令的 `--source`、命令前的 `--transcript-source` 宿主上下文、SessionStart 真实登记。`--source` 可选择同项目另一合法主线程，无需当前编号；另外两种来源必须与明确传入的当前 `--session-id` 匹配，不用记录内容补齐未知身份。宿主上下文来源无需先登记；默认登记缺失或其来源为 null 时明确失败，不扫描其他记录。Codex 不使用继承的 Claude 来源变量。

所有来源均限制在 `CODEX_HOME/sessions/`（默认 `~/.codex/sessions/`）内的普通 `.jsonl`，检查真实路径和 metadata 的项目根，拒绝目录、伪前缀、链接逃逸和跨项目。首条 `session_meta` 决定文件身份；旧记录缺少 `session_id` 时按官方兼容使用 `id`，存在时须与 `id` 相同，后续 fork 历史 metadata 不重定义身份。

首版以 [Codex 0.162.1 官方记录格式](https://github.com/openai/codex/tree/7a078f6bb4ce0dc2a81408b334ce52979d92c603/codex-rs/history/src) 为据，只支持主线程的 `cli`、`vscode`、`exec`、`mcp` 来源；custom、internal、subagent、缺失或未知来源均失败。仅纳入 `response_item` 用户 `input_text` 与助手明确 `phase: final_answer` 的 `output_text`；缺失及其他 phase 的助手文字省略，`event_msg` 不重复消费。event-only、未知消息格式和损坏 JSON 均停止，不回显原记录。分析、文件全文、工具正文和常见凭据过滤，工具仅留结果未核实的有限概况。默认预算为 12000 个 UTF-16 单元，`--max-chars` 可设为 512 到 64000；缺失信息保持未知。

成功后按输出的真实项目根和线程 ID 在 Harness 打开线程。该项目根必须已登记为 Harness 工作区；登记父目录不代表其子项目已登记，必要时在 Harness 中手动登记输出中的确切项目根。打开后发送一条新的合成消息，确认能在同一线程继续。

终端方式为输出中的 `dsh tui --resume <线程ID>`，需要本机已有对应 `tui` profile。缺少 profile 时终端续接不可用，应保留实际错误并使用 Harness 的已登记工作区查找线程；插件不会自动安装 profile、登记工作区或修改 Harness 配置。

## 共享数据与从 0.2.0 迁移

Claude 与 Codex 入口使用 `DEEPSEEK_DATA_DIR`，未设置时使用 `~/.deepseek-plugin/`。项目候选、作业和日志位于 `projects/<项目键>/`；`hosts/` 保存宿主登记。两端使用同一个共享根，项目的 DeepSeek 线程可以跨宿主续接，作业默认按宿主种类和真实会话编号隔离。

各宿主须从启动时继承同一个共享根设置。只给某一条命令临时覆盖 `DEEPSEEK_DATA_DIR`，不会让已启动桌面会话的 SessionStart/SessionEnd 改用该目录；变更设置后重新启动相关宿主，并核对 setup 报告的根目录。不要用 `PLUGIN_DATA` 或 `CLAUDE_PLUGIN_DATA` 覆盖新入口的共享根。实机检查使用唯一合成项目与真实宿主身份，保留根目录里其他项目和会话的数据。

旧底层脚本仍兼容直接调用：未设置 `DEEPSEEK_DATA_DIR` 时使用 `CLAUDE_PLUGIN_DATA` 或旧默认目录，项目目录直接位于旧根下；设置共享变量后则使用其 `projects/`。新入口不会自动合并旧数据。普通 setup 若能读取 `CLAUDE_PLUGIN_DATA`，只提示该路径，不猜测旧目录。

升级已有 `deepseek` 0.2.0 数据时，先停止旧调用，在运行任何项目任务或候选查询前显式执行（路径以实际旧插件数据目录为准）：

```text
/deepseek:setup --migrate-from "<旧插件数据目录>"
```

Codex 使用 `$deepseek:setup --migrate-from "<旧插件数据目录>"` 显式调用同一迁移接口。

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

Claude 转交只接受 Claude 配置目录 `projects/` 下当前登记或通过 `--source` 指定的普通 `.jsonl` 记录；Codex 的范围见上文。交接说明包含目标、已定决策与约束、涉及文件、验收标准和输出要求；过滤工具正文、文件全文和常见凭据格式，不发送完整记录。缺失的信息保持未知。它以只读方式新开 DeepSeek 线程，仅确认收到并等待用户继续，不自动执行交接任务；原宿主会话保持不变。

成功转交后按输出给出的线程 ID 与打开方式继续。终端续接使用 `dsh tui --resume <线程ID>`，需要本机存在对应 `tui` profile；缺少时保留错误，不自动安装。Harness 仅在已登记工作区显示线程；在 Harness 中核对输出的确切项目根是否登记，父目录登记不代替子项目登记。

在 Windows 上实测 DeepSeek Harness（dsh 0.2.1-rc.2 桌面端）：凡经 `dsh --profile headless` 创建的线程，无论是本插件的任务线程、转交线程，还是不经插件直接用 dsh headless 创建的线程，在 Harness 桌面界面续聊时都会报错 `tools: at least one tool must have defer_loading=false`；Harness 内新建的线程正常。这是 dsh/Harness 的兼容问题，不是插件问题。在其修复前，可用 `dsh --profile headless --session-id <线程ID> "<新消息>"` 在命令行继续同一线程。

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

外部 CLI 接口 `node deepseek/scripts/deepseek-host.mjs codex [--session-id <真实编号>] task --fresh --prompt-stdin` 从 stdin 读取正文；`review-context --prompt-stdin` 与 `adversarial-review --prompt-stdin` 使用同一读取方式接收关注点，普通 `review` 拒绝附加关注点。身份参数放在命令前，缺失时保持未知。`--prompt-stdin` 与位置正文互斥，空白正文报错；不使用该选项的旧 CLI 参数语义保持兼容。skills 用固定 Node 启动代码从临时 JSON 请求文件构造参数数组，将正文放进子进程 stdin，不拼接到 shell。安装包测试会从原生 marketplace 复制完整目录，并以假 dsh 调用包内入口检查环境和转交合成记录；这不代表宿主的真实沙箱或 UI 已验收。

## 许可

MIT
