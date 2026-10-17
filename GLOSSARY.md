# deepseek 插件

让 Claude 在 Claude Code 里调用 DeepSeek 完成工作的接口。插件只提供调用能力，何时调用由 Claude 与用户决定。

## 会话与线程

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

## 审阅

**审阅**：
DeepSeek 以只读方式检查 git 变更，给出结论与问题清单。
_Avoid_: 代码审查、review

**对抗式审阅**：
着重挑战设计选择与假设、寻找不应上线理由的审阅。
_Avoid_: 严格审阅、adversarial review

