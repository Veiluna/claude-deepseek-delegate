# 仅替换 WMI 边界，实际运行守卫并持有探针自身的真实进程句柄。
# 无需授予 WMI 查询或终止进程权限。
$env:DEEPSEEK_TREE_PID = [string]$PID
function Get-CimInstance {
    param($ClassName, $Filter, $Property)
    if ($env:FAKE_WINDOWS_QUERY_FAIL -eq '1') { throw 'private-command-line' }
    [pscustomobject]@{ CommandLine = $env:FAKE_WINDOWS_COMMAND_LINE }
}
& ([scriptblock]::Create([System.IO.File]::ReadAllText($env:FAKE_WINDOWS_GUARD)))
