# Codex 宿主调用

本文件供 `setup` 与 `task` skills 共用。根据已加载的 `SKILL.md` 绝对路径，向上两级找到插件根目录，再定位 `scripts/deepseek-host.mjs`；路径不基于当前项目目录，也不依赖 shell 中存在 `PLUGIN_ROOT`。

## 以数据文件传递请求

用文件编辑工具创建本次调用专用的临时 UTF-8 JSON 文件，保存于宿主允许写入的临时目录，字段为：

```json
{
  "args": ["task", "--fresh", "--prompt-stdin"],
  "prompt": "原始任务正文"
}
```

按 JSON 字符串规则编码字段，`prompt` 解码后须与原始正文逐字一致。候选查询和 setup 只需要 `args`，不写 `prompt`。文件只保存本次调用的数据；不要写入整个会话、工具输出或凭据。正文通过文件编辑工具作为数据写入，不能拼进 shell 命令、heredoc、PowerShell here-string 或 JavaScript 代码。

通过 Node 的 `spawnSync` 调用宿主入口，`shell:false`、参数数组、`input` 传正文。下面是固定启动代码；仅将两个文件路径作为带正确 shell 引号的独立参数传入，代码本身保持不变。路径也须按当前 shell 的字面量规则引用，不执行字符串替换或命令求值。

```javascript
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const [requestFile, pluginRoot] = process.argv.slice(1);
const request = JSON.parse(fs.readFileSync(requestFile, "utf8"));
const sessionId = process.env.CODEX_THREAD_ID;
const identity = sessionId && sessionId.trim() ? ["--session-id", sessionId] : [];
const result = spawnSync(process.execPath, [path.join(pluginRoot, "scripts", "deepseek-host.mjs"), "codex", ...identity, ...request.args], {
  input: request.prompt,
  encoding: "utf8",
  shell: false,
  windowsHide: true,
  maxBuffer: 16 * 1024 * 1024
});
process.stdout.write(result.stdout || "");
process.stderr.write(result.stderr || "");
if (result.error) process.stderr.write("启动宿主入口失败。\n");
process.exitCode = result.error ? 1 : (result.status ?? 1);
```

固定代码可用 `node -e '<固定代码>' '<请求文件绝对路径>' '<插件根绝对路径>'` 执行；上述代码只使用双引号，在 Bash 与 PowerShell 中可用外层单引号保护代码。路径中的单引号按对应 shell 规则转义。执行时保留当前项目工作目录，用户的目标目录通过请求 `args` 中的 `--cwd` 传入。

`CODEX_THREAD_ID` 使用当前 Codex 执行环境的真实值，作为命令前的显式 `--session-id` 参数；缺失或空白时省略身份参数，保持未知。不能替换成 Claude 编号、随机编号或最近记录。`DEEPSEEK_DATA_DIR` 保留调用环境的设置；不要传入 `PLUGIN_DATA` 或 `CLAUDE_PLUGIN_DATA` 作为共享根。

在执行的 `finally` 中删除本次临时请求文件。命令仍在运行时，继续等待同一进程；不要因为轮询或警告重新启动调用。展示标准错误，即使退出码为 0 也不能丢弃警告。
