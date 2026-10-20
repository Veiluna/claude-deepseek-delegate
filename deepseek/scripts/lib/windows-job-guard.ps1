# 只持有 Job Object 与宿主实例句柄；不接收任务、配置或授权请求。
$ErrorActionPreference = 'Stop'
$hostProcess = $null
$guard = $null
try {
    $hostProcess = [System.Diagnostics.Process]::GetProcessById([int]$env:DEEPSEEK_GUARD_PID)
    $heldHandle = $hostProcess.Handle
    $row = Get-CimInstance Win32_Process -Filter "ProcessId = $($hostProcess.Id)" -Property CommandLine
    if ($hostProcess.HasExited -or !$row.CommandLine) { exit 1 }
    $scriptPattern = '(?:^|\s)(?:"' + [regex]::Escape($env:DEEPSEEK_GUARD_SCRIPT) + '"|' + [regex]::Escape($env:DEEPSEEK_GUARD_SCRIPT) + ')(?=\s|$)'
    $tokenArgument = [regex]::Escape('--deepseek-owner=' + $env:DEEPSEEK_GUARD_TOKEN)
    $marker = '(?:^|\s)(?:"' + $tokenArgument + '"|' + $tokenArgument + ')(?=\s|$)'
    if ($row.CommandLine -notmatch $scriptPattern -or $row.CommandLine -notmatch $marker) { exit 1 }
    Add-Type -Path $env:DEEPSEEK_JOB_NATIVE
    # 此时宿主还未 spawn dsh。后续 cmd/dsh 及其分离后代自动加入此 Job。
    $guard = [DeepseekJobGuard]::new($hostProcess.Id, $heldHandle, $env:DEEPSEEK_GUARD_TOKEN)
    [Console]::Out.WriteLine('ready')
    while (($command = [Console]::In.ReadLine()) -ne $null) {
        if ($command -ne 'clean') { exit 1 }
        $guard.CleanDescendants()
        [Console]::Out.WriteLine('cleaned')
    }
} catch { exit 1 } finally {
    # 宿主崩溃关闭 stdin，或 taskkill /T 结束守护进程，均会由内核结束整个 Job。
    if ($null -ne $guard) { $guard.Dispose() }
    if ($null -ne $hostProcess) { $hostProcess.Dispose() }
}
