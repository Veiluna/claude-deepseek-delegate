# 插件只提供调用接口，不规定何时调用

旧版通过 SessionStart 注入"满足条件就分派给 DeepSeek"的规则。我们有意删除了它：插件只提供命令、子代理和运行时，调用时机由 Claude 与用户判断，子代理描述只写能力、不写强制使用条件。不要把分派规则加回插件；需要的用户可写进自己的 CLAUDE.md。

同理，插件不提供自动审查关卡（Stop 钩子）。审查者（DeepSeek、Claude 或 Codex）由项目自己的 CLAUDE.md 分工指定，由 Claude Opus 调度；需要自动关卡时使用 codex 插件自带的那个。
