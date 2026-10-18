# claude-deepseek-delegate

Claude Code plugin marketplace hosting the `deepseek` plugin, which lets Claude call DeepSeek.

## 仓库结构

- `deepseek/`：新插件，经本机 `dsh --profile headless --json` 运行 DeepSeek（ADR-0004）。新功能都做在这里。
- `deepseek-delegate/`：旧插件，将被 `deepseek` 取代，只修阻断性问题，不再加功能。
- 测试：在 `deepseek/` 下运行 `npm test`（`node --test`，用 `tests/fake-dsh.mjs` 代替真实 dsh，不联网、不需要登录）。

## 协作分工

本仓库沿用用户全局的模型分工，这里只写本项目的具体落点。实现模型的规则见 `AGENTS.md`。

- **设计**由 Claude 负责：术语进 `GLOSSARY.md`，取舍进 `docs/adr/`，拆票进 GitHub Issues。
- **实现**由 Codex `gpt-6.1-sol` 或 DeepSeek 承担，Claude 每次分派时选择。本仓库里涉及鉴权、权限映射（`DSH_PERMISSION_MODE`）、子进程与作业恢复、后台作业状态一致性的票优先给 sol；补测试、改文案、按说明重构优先给 DeepSeek。
- **DeepSeek 的调用方式**：用本仓库自己的 `deepseek` 插件（`/deepseek:task`、`deepseek-agent` 子代理）。这顺便是对插件的实际使用检验，遇到的问题记成 issue。
- **评审**一律由 Codex `gpt-6.1-sol` 在全新会话里只审 diff，Claude 不做代码评审。
- **提交**：实现模型不提交；评审没有剩余意见后，由 Claude 只暂存该票涉及的文件代为提交，提交信息写票号（如 `（#3）`）。没过评审的改动不进 Git。

## 不要做的事

- 不要把"何时分派给 DeepSeek"的规则或自动评审关卡加回插件（ADR-0002）。分派策略写在本文件或用户自己的 CLAUDE.md 里，插件只提供调用接口。
- 不要让插件自动批准 dsh 的授权请求（ADR-0004）。

## 文档查询

用到 Claude Code 插件规范（commands、agents、hooks、`plugin.json`、`marketplace.json`）或 Node 内置模块（`node:test`、`child_process`）的具体参数时，先用 context7 查当前文档；影响了实现的结论写进票据证据。dsh 没有公开文档，以本机 `dsh --help` 的输出为准，并在票据里注明。

## Agent skills

### Issue tracker

Issues live in GitHub Issues (Veiluna/claude-deepseek-delegate), via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary (needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `GLOSSARY.md` + `docs/adr/`. See `docs/agents/domain.md`.
