# Injects the delegation policy into the session context.
$root = $env:CLAUDE_PLUGIN_ROOT
$text = Get-Content -Raw -Encoding UTF8 (Join-Path $root 'hooks/policy.md')
$text = $text.Replace('{{SCRIPT}}', (Join-Path $root 'scripts/deepseek-code.ps1'))
[Console]::OutputEncoding = [Text.Encoding]::UTF8
[Console]::Out.Write($text)
