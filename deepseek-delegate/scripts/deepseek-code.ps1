# Run a headless Claude Code process backed by DeepSeek (Anthropic-compatible API).
# Usage: deepseek-code.ps1 -Prompt "task" [-Dir workdir]
# Requires DEEPSEEK_API_KEY; optional DEEPSEEK_MODEL overrides the model.
param(
    [Parameter(Mandatory = $true)][string]$Prompt,
    [string]$Dir = (Get-Location).Path
)

$key = $env:DEEPSEEK_API_KEY
if (-not $key) { $key = [Environment]::GetEnvironmentVariable('DEEPSEEK_API_KEY', 'User') }
if (-not $key) { Write-Error 'DEEPSEEK_API_KEY is not set'; exit 1 }

$model = $env:DEEPSEEK_MODEL
if (-not $model) { $model = [Environment]::GetEnvironmentVariable('DEEPSEEK_MODEL', 'User') }
if (-not $model) { $model = 'deepseek-flash' }

# Scoped to this process and its children only
$env:ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic'
$env:ANTHROPIC_AUTH_TOKEN = $key
Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue
Remove-Item Env:CLAUDE_CODE_OAUTH_TOKEN -ErrorAction SilentlyContinue
$env:ANTHROPIC_MODEL = $model
$env:ANTHROPIC_DEFAULT_OPUS_MODEL = $model
$env:ANTHROPIC_DEFAULT_SONNET_MODEL = $model
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL = $model
$env:CLAUDE_CODE_SUBAGENT_MODEL = $model
$env:CLAUDE_CODE_EFFORT_LEVEL = 'max'
$env:CLAUDE_CODE_AUTO_COMPACT_WINDOW = '786432'
$OutputEncoding = [Console]::OutputEncoding = [Text.Encoding]::UTF8

Set-Location $Dir
$Prompt | claude -p --model $model --permission-mode acceptEdits --allowedTools 'Read,Edit,Write,Glob,Grep,Bash'
exit $LASTEXITCODE
