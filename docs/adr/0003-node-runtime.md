# 运行时用 Node 而非 PowerShell

最初版本是 PowerShell 脚本，但 Windows PowerShell 5.1 会把无 BOM 的 UTF-8 中文读成乱码导致解析失败，且只能在 Windows 运行。改用 Node（Claude Code 本身已依赖 Node），可跨平台并与 codex 插件的 companion 结构保持一致。
