---
description: 检查 Node 与本机 DeepSeek Harness（dsh）是否可用
argument-hint: "[--json]"
allowed-tools: Bash(node:*)
---

运行：

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/deepseek-companion.mjs" setup $ARGUMENTS
```

把输出原样展示给用户。不要自己尝试修复环境。
