# deepseek-delegate

Claude Code 插件：让 Claude 在满足条件时，自动把写代码任务交给 DeepSeek（`deepseek-flash`）执行，节省 Claude 额度。Claude 仍负责规划和审阅。

## 工作方式

- **SessionStart 钩子**：每次会话开始时注入分派规则。需求明确的写代码任务（实现函数、写脚本、补测试、按说明重构、批量修改）会自动分派；架构取舍、疑难 bug、安全敏感代码不分派。
- **`deepseek-coder` 子代理**：调用 `scripts/deepseek-code.ps1`，在独立进程里把 Claude Code 指向 DeepSeek 的 Anthropic 兼容接口（`https://api.deepseek.com/anthropic`），以 `acceptEdits` 模式无头执行任务。环境变量只作用于该子进程，不影响主会话。
- Claude 收到结果后审阅改动，再向你汇报。

接入方式参考 [DeepSeek 官方文档](https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/claude_code/)。

## 要求

- Windows + PowerShell（脚本为 `.ps1`）
- 已安装 Claude Code（`claude` 在 PATH 中）
- DeepSeek API Key：<https://platform.deepseek.com/api_keys>

## 安装

```bash
setx DEEPSEEK_API_KEY "你的Key"
claude plugin marketplace add Veiluna/claude-deepseek-delegate
claude plugin install deepseek-delegate@deepseek-delegate
```

重启 Claude Code 生效。可选：`setx DEEPSEEK_MODEL "<模型名>"` 覆盖默认的 `deepseek-flash`。

## 注意

子代理以 `acceptEdits` 模式运行，DeepSeek 可直接修改项目文件并执行 Bash 命令，请在受版本控制的目录中使用。

## 许可

MIT
