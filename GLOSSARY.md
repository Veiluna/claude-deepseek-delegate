# deepseek 插件

让宿主调用 DeepSeek 完成工作的接口。插件只提供调用能力，何时调用由宿主与用户决定。

## 会话与线程

**宿主**：
发起调用的应用种类，明确为 Claude Code（`claude`）或 Codex（`codex`）；无法确认时保持未知。
_Avoid_: 平台、调用端（表示身份时）

**宿主会话**：
发起调用的一个 Claude 会话或 Codex 会话，由宿主种类与所属会话编号共同标识；未知编号不认领已有记录。
_Avoid_: 会话、session（不加限定时）

**Codex 会话**：
用户正在使用、发起调用的那个 Codex 桌面端或 CLI 会话。
_Avoid_: 会话、session、对话（不加限定时）

**宿主上下文**：
显式选择的宿主种类、所属会话编号、项目根和已登记记录来源；缺少的信息保持未知，不从其他宿主的继承变量推测。
_Avoid_: 当前环境、会话镜像

**Claude 会话**：
用户正在使用、发起调用的那个 Claude Code 会话。
_Avoid_: 会话、session、对话（不加限定时）

**DeepSeek 线程**：
DeepSeek 一侧可被续接的一段连续对话。
_Avoid_: DeepSeek 会话、session、对话

**转交**：
把一个 Claude 会话的要点整理成交接说明，在 dsh 中新开 DeepSeek 线程，由用户在 Harness 或终端继续；原 Claude 会话保持不变。
_Avoid_: 迁移、移交、会话镜像、transfer session

**交接说明**：
转交时作为新 DeepSeek 线程第一条消息的摘要，包含目标、已定决策与约束、涉及文件、验收标准和输出要求，不含文件全文与工具日志。
_Avoid_: handoff packet、上下文转储

## 工作

**任务**：
交给 DeepSeek 的一项工作，可在前台或后台运行；每个任务的读写权限单独决定，不从所续接的线程继承。
_Avoid_: 委派、rescue、run

**作业**：
在后台运行、带编号、可查看状态、结果和取消的任务。
_Avoid_: 后台任务、job

**可续接线程**：
同一项目里最近一个任务所用的 DeepSeek 线程；审阅不会改变它。
_Avoid_: 上次会话、last session

## 本地数据

**共享数据根**：
由 `DEEPSEEK_DATA_DIR` 指定、默认 `~/.deepseek-plugin/` 的目录；`projects/` 保存两种宿主共用的项目候选与作业，`hosts/` 留给宿主登记。
_Avoid_: Claude 数据目录（表示共享根时）

**旧插件数据根**：
旧底层入口按 `CLAUDE_PLUGIN_DATA` 或旧默认目录存储数据的目录，其项目目录直接位于根下。新宿主入口不会静默读取或合并该目录。

**显式迁移**：
用户运行 setup 的 `--migrate-from`，将旧插件数据根全部项目的候选、终态作业和日志复制至共享项目目录，保留源；存在活动作业或冲突时停止。
_Avoid_: 转交（转交用于新开 DeepSeek 线程）、自动升级

## 审阅

**审阅**：
DeepSeek 以只读方式检查 git 变更，给出结论与问题清单。
_Avoid_: 代码审查、review

**对抗式审阅**：
着重挑战设计选择与假设、寻找不应上线理由的审阅。
_Avoid_: 严格审阅、adversarial review

