---
description: 检查 Node 与本机 DeepSeek Harness（dsh）是否可用
argument-hint: "[--migrate-from <旧插件数据目录>] [--json]"
allowed-tools: Bash(node:*)
---

运行：

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/deepseek-host.mjs" claude setup $ARGUMENTS
```

把输出原样展示给用户。不要自己尝试修复环境。

正常检查报告共享数据根和项目目录；已知 `CLAUDE_PLUGIN_DATA` 时仅提示旧目录，不猜测其他安装位置，不自动搬迁。用户显式指定 `--migrate-from <旧插件数据目录>` 时只迁移全部项目候选、终态作业与配套日志，不运行 dsh 连通性检查。迁移前停止旧调用；源目录保留，活动作业、目标项目数据、损坏记录或不安全路径都会阻断迁移。
