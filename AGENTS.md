# AGENTS.md

给在本仓库领票实现或评审的 Codex 与 DeepSeek 看。设计结论以 `GLOSSARY.md`、`docs/adr/` 和票据为准；发现与设计冲突时写进票据，不要自行改设计。

## 实现

- 票据是 GitHub Issue（Veiluna/claude-deepseek-delegate），用 `gh issue view <n>` 读。
- 先写测试再实现。测试在 `deepseek/tests/`，用 `node --test`，在 `deepseek/` 下运行 `npm test`；需要模拟 dsh 时扩展 `tests/fake-dsh.mjs`，不要调用真实 dsh 或联网。
- 运行 DeepSeek 的子进程，工作目录必须是项目根目录；发给 DeepSeek 的消息要声明"只在工作区内写入，不请求提升权限"（ADR-0004）。
- 不要把分派规则或自动评审关卡写进插件（ADR-0002）。
- 新功能只做在 `deepseek/`；`deepseek-delegate/` 是旧插件，只修阻断性问题。
- 命名领域概念时用 `GLOSSARY.md` 里的词（如"DeepSeek 线程""作业""审阅"），不要用它列在 _Avoid_ 里的同义词。
- 不要提交。改动留在工作树，跑完测试后把命令和结果写回票据评论。
- 对 Claude Code 插件规范或 Node 内置模块的参数不确定时，用 context7 查；dsh 以本机 `dsh --help` 为准。查不到就在票据里写"未核实"，不要按猜测写。

## 评审

- 只审 diff，在全新会话里进行。
- 本仓库重点看：权限模式是否映射正确（可写任务 `workspace-write`，只读任务与审阅 `read-only`）、是否有自动批准授权请求、子进程工作目录是否为项目根、后台作业状态在中断后能否恢复、`final` 之外被截断的事件是否被误当作最终回复、凭据或 Harness 登录信息是否可能外泄。

## 输出

一律简体中文；代码、命令、路径和专有名词保持原样。
