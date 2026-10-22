---
name: adversarial-review
description: 用户显式调用时，让 DeepSeek 以只读方式挑战 git 变更的设计选择、权衡与假设。
---

仅在用户显式调用本 skill 时执行对抗式审阅。读取 `../../references/codex-cli.md` 和 `../../references/codex-review.md`，按共用流程先运行 `review-context`，再运行 `adversarial-review`。

接受 `--base`、`--scope`、`--model`、`--effort`、`--background`、`--cwd`、`--json` 及 `--` 后的关注点原文。重点挑战设计选择、权衡、假设及失败模式。关注点通过两次请求相同的 `prompt` 与 `--prompt-stdin` 传递，保留引号、换行、首尾空白和形似选项的文本，不作为位置正文拼接。未提供关注点时两次请求均不写 `prompt` 或 `--prompt-stdin`。

只审阅并原样展示结果，不自动修复；审阅者的选择遵循项目约定。
