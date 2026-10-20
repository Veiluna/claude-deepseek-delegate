# 退出码：0 归属一致或成功；2 归属不符；3 已退出；1 未核实或失败。
$ErrorActionPreference = 'Stop'
$candidate = $null
$terminating = $false
$jobHandle = [IntPtr]::Zero
$tree = [System.Collections.Generic.Dictionary[int,object]]::new()

function Capture-Descendants {
    # 只取 PID/父 PID，不读取其他进程命令行。句柄与创建时间防止核对期间 PID 复用。
    $rows = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId)
    do {
        $added = $false
        foreach ($entry in $rows) {
            $childId = [int]$entry.ProcessId
            $parentId = [int]$entry.ParentProcessId
            if (!$tree.ContainsKey($parentId) -or $tree.ContainsKey($childId)) { continue }
            $child = $null
            try {
                try { $child = [System.Diagnostics.Process]::GetProcessById($childId) }
                catch {
                    if ($_.Exception -is [System.ArgumentException] -or $_.Exception.InnerException -is [System.ArgumentException]) { continue }
                    throw
                }
                $handle = $child.Handle
                if ($child.HasExited) { continue }
                $current = Get-CimInstance Win32_Process -Filter "ProcessId = $childId" -Property ParentProcessId
                if ($child.HasExited) { continue }
                if (!$current) { throw 'Process ancestry query failed' }
                $started = $child.StartTime
                if ([int]$current.ParentProcessId -ne $parentId -or $started -lt $tree[$parentId].StartedAt) { continue }
                $tree.Add($childId, [pscustomobject]@{ Process = $child; StartedAt = $started })
                $child = $null
                $added = $true
            } finally { if ($null -ne $child) { $child.Dispose() } }
        }
    } while ($added)
}
try {
    $targetProcessId = [int]$env:DEEPSEEK_TREE_PID
    $ownerScript = $env:DEEPSEEK_TREE_SCRIPT
    $ownerToken = $env:DEEPSEEK_TREE_TOKEN
    $action = $env:DEEPSEEK_TREE_ACTION
    if ($targetProcessId -le 0 -or $action -notin @('check', 'kill', 'birthtime', 'check-birthtime')) { exit 1 }
    if ($action -in @('check', 'kill') -and (!$ownerScript -or !$ownerToken)) { exit 1 }
    try {
        $candidate = [System.Diagnostics.Process]::GetProcessById($targetProcessId)
    } catch {
        if ($_.Exception -is [System.ArgumentException] -or $_.Exception.InnerException -is [System.ArgumentException]) { exit 3 }
        throw
    }
    # 保持进程句柄直到 taskkill 返回，阻止核对与终止之间的 PID 复用。
    $heldHandle = $candidate.Handle
    if ($candidate.HasExited) { exit 3 }
    if ($action -in @('birthtime', 'check-birthtime')) {
        $birthtime = $candidate.StartTime.ToUniversalTime().Ticks.ToString([System.Globalization.CultureInfo]::InvariantCulture)
        if ($candidate.HasExited) { exit 3 }
        if ($action -eq 'birthtime') { [Console]::Out.Write($birthtime); exit 0 }
        if ($birthtime -eq $env:DEEPSEEK_TREE_BIRTHTIME) { exit 0 }
        exit 2
    }
    $row = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $targetProcessId" -Property CommandLine
    if ($candidate.HasExited) { exit 3 }
    if (!$row -or !$row.CommandLine) { exit 1 }
    $scriptPattern = '(?:^|\s)(?:"' + [regex]::Escape($ownerScript) + '"|' + [regex]::Escape($ownerScript) + ')(?=\s|$)'
    $tokenArgument = [regex]::Escape('--deepseek-owner=' + $ownerToken)
    $marker = '(?:^|\s)(?:"' + $tokenArgument + '"|' + $tokenArgument + ')(?=\s|$)'
    if ($row.CommandLine -notmatch $scriptPattern -or $row.CommandLine -notmatch $marker) { exit 2 }
    if ($action -eq 'check') { exit 0 }
    if ([System.IO.Path]::GetFileName($ownerScript) -eq 'deepseek-dsh-host.mjs') {
        Add-Type -Path $env:DEEPSEEK_JOB_NATIVE
        $jobHandle = [DeepseekJobGuard]::OpenForProcess($ownerToken, $heldHandle)
    }
    $tree.Add($targetProcessId, [pscustomobject]@{ Process = $candidate; StartedAt = $candidate.StartTime })
    Capture-Descendants
    $terminating = $true
    & "$env:SystemRoot\System32\taskkill.exe" /T /F /PID $targetProcessId
    if ($jobHandle -ne [IntPtr]::Zero) {
        # 持有 Job 句柄跨过 taskkill，避免守护进程退出先触发整组终止，令
        # taskkill 因成员已消失返回失败。显式结束已核实的 Job 也覆盖孤儿。
        [DeepseekJobGuard]::Terminate($jobHandle)
    }
    if (!$candidate.WaitForExit(5000)) { exit 1 }
    # taskkill 可能对正在退出的辅助进程返回非零。必须核实整棵已持句柄的树，
    # 并补查清理期间出生的后代；不能仅凭根已退出把清理失败当作成功。
    Capture-Descendants
    foreach ($item in $tree.Values) { if (!$item.Process.WaitForExit(5000)) { exit 1 } }
    exit 0
} catch {
    # 不打印异常，避免 WMI 诊断包含命令行；终止失败不能按根已退出冒充成功。
    if (!$terminating -and $null -ne $candidate) {
        try { if ($candidate.HasExited) { exit 3 } } catch {}
    }
    exit 1
} finally {
    if ($jobHandle -ne [IntPtr]::Zero) { [DeepseekJobGuard]::Close($jobHandle) }
    foreach ($item in $tree.Values) { if ($item.Process -ne $candidate) { $item.Process.Dispose() } }
    if ($null -ne $candidate) { $candidate.Dispose() }
}
