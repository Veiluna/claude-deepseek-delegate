# 仅供离线测试夹具使用；不读取命令行或配置。
# 0 成功；2 PID 已复用；3 原进程不存在；1 无法核实。
$ErrorActionPreference = 'Stop'
$candidate = $null
try {
    $targetId = [int]$env:TEST_PROCESS_PID
    $action = $env:TEST_PROCESS_ACTION
    if ($targetId -le 0 -or $action -notin @('capture', 'kill')) { exit 1 }
    try { $candidate = [System.Diagnostics.Process]::GetProcessById($targetId) }
    catch {
        if ($_.Exception -is [System.ArgumentException] -or $_.Exception.InnerException -is [System.ArgumentException]) { exit 3 }
        throw
    }
    # 从读取创建时间直到终止完成都持有同一个句柄，防止核对后 PID 复用。
    $heldHandle = $candidate.Handle
    if ($candidate.HasExited) { exit 3 }
    $started = $candidate.StartTime.ToUniversalTime().Ticks.ToString([System.Globalization.CultureInfo]::InvariantCulture)
    if ($candidate.HasExited) { exit 3 }
    if ($action -eq 'capture') { [Console]::Out.Write($started); exit 0 }
    if ($started -ne $env:TEST_PROCESS_START) { exit 2 }
    if (!$candidate.HasExited) { $candidate.Kill() }
    if (!$candidate.WaitForExit(5000)) { exit 1 }
    exit 0
} catch {
    # 只在已持句柄确认该实例退出时视为消失；其他查询失败仍报错。
    if ($null -ne $candidate) {
        try { if ($candidate.HasExited) { exit 3 } } catch {}
    }
    exit 1
}
finally { if ($null -ne $candidate) { $candidate.Dispose() } }
