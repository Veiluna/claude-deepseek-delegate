---
name: setup
description: 检查 Node、本机 DeepSeek Harness（dsh）及登录连通性，或按明确指定的旧数据根迁移 deepseek 插件数据。
---

读取本文件目录下 `../../references/codex-cli.md`，按其中的数据传递方式调用共享宿主入口。

将请求的 `args` 设为 `["setup"]`，仅追加用户指定的 `--json` 或 `--migrate-from <旧数据根>`；不支持的选项先报告并停止。迁移只在用户明确指定旧数据根时执行，保留源目录，不自动寻找或合并旧数据。

运行一次后原样展示 stdout、stderr 和退出状态。普通检查会执行一个最小只读任务；按输出说明环境问题，不自行安装 dsh、登录、修改配置或扩大权限。迁移模式只迁移，不执行连通性检查。共享数据根由 `DEEPSEEK_DATA_DIR` 决定，未设置时由宿主入口使用 `~/.deepseek-plugin/`；不要用 Codex 的插件私有目录覆盖它。
