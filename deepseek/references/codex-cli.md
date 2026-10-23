# Codex 宿主调用

本文件供 Codex skills 共用。根据已加载的 `SKILL.md` 绝对路径，向上两级找到插件根目录，再定位 `scripts/deepseek-host.mjs`；路径不基于当前项目目录，也不依赖 shell 中存在 `PLUGIN_ROOT`。

## 执行前核对宿主权限

先核对当前执行工具实际允许的项目路径、额外可写目录与网络。保留宿主已继承的 `DEEPSEEK_DATA_DIR`；未设置时共享宿主入口使用 `~/.deepseek-plugin/`。不要只为单条调用换根，或将 `PLUGIN_DATA`、`CLAUDE_PLUGIN_DATA` 当成共享根。SessionStart/SessionEnd 与普通命令必须使用同一根；需要变更环境时由用户重新启动宿主后核对，不在 skill 内修改用户配置。

候选查询和作业操作可能更新共享状态；作业操作还可能核对进程身份并结束所属进程树。普通 setup、任务、审阅和转交会调用本机 dsh，使用 Harness 的登录与线程数据并联网。显式迁移读取旧根、取得源项目锁并写共享目标，不运行 dsh 连通性任务。按当前子命令说明实际需要的访问，不读取或展示凭据、完整配置或无关会话。

Codex 0.162.1 的 `workspace-write` 只允许写当前工作区和明确的 writable roots，网络另行控制。`--add-dir` 只增加可写目录，不能据此宣称网络已允许。插件安装、skill 加载与 hooks 信任不能作为普通执行工具已获这些权限的证据；`PLUGIN_DATA` 环境变量也不代表共享根自动可写。

需要授权时：

1. 先准备并核对本次请求文件，明确子命令、项目根、共享根和所需 Harness/网络访问。固定启动代码与请求文件分离，按下节方式传递数据。
2. 以当前工具暴露的 schema 为准。如果支持 `with_additional_permissions` 或 `request_permissions`，只申请必要目录与网络；Codex 0.162.1 的这两项能力默认关闭，不要求用户为插件开启实验功能。
3. 当前执行工具只有普通提权接口时，对这条已审调用使用 `sandbox_permissions: "require_escalated"`，在 `justification` 中询问是否允许本次具体操作，并说明所需访问。无需为此切换全局 full-access、跳过沙箱或 hook trust；不申请 `["node"]`、`["node", "-e"]` 等通用执行前缀。
4. 等待客户端的正常批准结果。批准解决的是 Codex 启动环境权限，不能修改 dsh 的任务权限、自动回答 dsh 授权请求，或自动更换配置。用户拒绝或自动审批拒绝时停止，准确报告原因。
5. 调用启动后继续等待同一进程。若沙箱、网络或候选保存报错，先核对是否已经创建线程或作业；展示现有结果与警告，不因为错误而重新启动任务。只有确认原调用未启动或用户明确要求新的调用时，才准备下一次请求。

规则依据：[0.162.1 普通授权](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/prompts/templates/permissions/approval_policy/on_request.md)、[执行工具权限参数](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/core/src/tools/handlers/shell_spec.rs)与[默认 feature 状态](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/features/src/lib.rs)。实际桌面端与 CLI 仍须分别验收，离线假 dsh 不能证明宿主沙箱已允许这些访问。

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

固定代码可用 `node -e '<固定代码>' '<请求文件绝对路径>' '<插件根绝对路径>'` 执行。在 Bash 中用外层单引号保护固定代码；Windows 上此形式已在本机 PowerShell 7.6.5、`$PSNativeCommandArgumentPassing=Windows` 下验证。PowerShell 7.3 及以上的 `Windows` 或 `Standard` 模式会保留传给 `node.exe` 的内嵌双引号，Windows PowerShell 5.1 与 `Legacy` 模式不与之等价，不能据此声称支持。

调用前核对实际 shell 版本和参数传递模式；若是 Windows PowerShell 5.1 或 `Legacy`，停止并说明该形式未经验证，使用已验证的 shell 后再调用，不自动改写用户设置。不要用 `--%` 拼接路径；它仍会展开 `%环境变量%`。路径中的单引号按对应 shell 的字面量规则转义。执行时保留当前项目工作目录，用户的目标目录通过请求 `args` 中的 `--cwd` 传入。参数行为见 [PowerShell 官方 about_Parsing](https://github.com/microsoftdocs/powershell-docs/blob/main/reference/7.7/Microsoft.PowerShell.Core/About/about_Parsing.md)。

`CODEX_THREAD_ID` 使用当前 Codex 执行环境的真实值，作为命令前的显式 `--session-id` 参数；缺失或空白时省略身份参数，保持未知。不能替换成 Claude 编号、随机编号或最近记录。`DEEPSEEK_DATA_DIR` 保留调用环境的设置；不要传入 `PLUGIN_DATA` 或 `CLAUDE_PLUGIN_DATA` 作为共享根。

在执行的 `finally` 中删除本次临时请求文件。命令仍在运行时，继续等待同一进程；不要因为轮询或警告重新启动调用。展示标准错误，即使退出码为 0 也不能丢弃警告。
