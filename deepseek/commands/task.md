---
description: 把一项任务交给 DeepSeek 执行
argument-hint: "[--read-only] <任务描述>"
---

把下面的任务交给 `deepseek:deepseek-agent` 子代理执行，参数原样转发（包括 `--read-only`）：

$ARGUMENTS

子代理返回后，把 DeepSeek 的输出原样展示给用户，再按需要审阅改动。
