---
name: review
description: 用户显式调用时，让 DeepSeek 以只读方式审阅 git 变更，返回结论与问题清单。
---

仅在用户显式调用本 skill 时执行审阅。读取 `../../references/codex-cli.md` 和 `../../references/codex-review.md`，按共用流程先运行 `review-context`，再运行 `review`。

接受 `--base`、`--scope`、`--model`、`--effort`、`--background`、`--cwd`、`--json`，普通审阅不接收附加关注点。只审阅并原样展示结果，不自动修复；审阅者的选择遵循项目约定。
