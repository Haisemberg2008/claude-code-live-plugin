#requires -Version 7.0
$ErrorActionPreference = 'Stop'
$scripts = Join-Path $PSScriptRoot '..\scripts'
. (Join-Path $scripts 'claude-live-contract.ps1')
. (Join-Path $scripts 'claude-thread-context.ps1')
. (Join-Path $scripts 'claude-log-reader.ps1')
$root = Join-Path ([IO.Path]::GetTempPath()) ('claude-live-test-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($root) | Out-Null
$processes = [Collections.Generic.List[Diagnostics.Process]]::new()
function Assert-True($Value, $Message) { if (-not $Value) { throw $Message } }
function Read-Result($Name) { Get-Content (Join-Path $root "$Name/resultado.json") -Raw | ConvertFrom-Json }
function Wait-Result($Process) {
    Assert-True ($Process.WaitForExit(15000)) 'Simulated executor timed out'
}
function New-Job($Name, $Resume = $null) {
    $owners = [pscustomobject]@{planning='codex';inspection='claude';implementation='codex';testing='claude';review='codex';commit='codex';push='codex';deploy='codex'}
    $job = [pscustomobject]@{
        workspace=$root; promptFile=(Join-Path $root 'prompt.txt'); mode='verify'
        modelPolicy=[pscustomobject]@{mode='quota-aware';primary='fable';alternate='opus';switchAtRemainingPercent=3}
        coordination=[pscustomobject]@{phase='execution';scopeId='test';approvalRevision=1;planSummary='Test';planApproved=$true;responsibilities=$owners}
        allowedCommands=@([pscustomobject]@{rule='Bash(pwd)';responsibility='inspection'}); resumeFrom=$Resume
    }
    $job | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $root "$Name.json")
    return $job
}
function Start-TestRun($Name, $Thread, $Failure = '', $Delay = 6000) {
    $info = [Diagnostics.ProcessStartInfo]::new((Get-Command pwsh).Source)
    $info.UseShellExecute = $false; $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
    $info.Environment['CODEX_THREAD_ID'] = $Thread
    $null = $info.Environment.Remove('CODEX_SESSION_ID')
    $info.Environment['CLAUDE_LIVE_TEST_ROOT'] = $root
    $info.Environment['CLAUDE_LIVE_TEST_FAILURE'] = $Failure
    $info.Environment['CLAUDE_LIVE_TEST_DELAY'] = [string]$Delay
    foreach ($argValue in @('-NoProfile','-File',(Join-Path $scripts 'start-live.ps1'),'-JobFile',(Join-Path $root "$Name.json"),'-RunDirectory',(Join-Path $root $Name),'-TestAdapter',(Join-Path $PSScriptRoot 'fake-adapter.ps1'),'-TestStateRoot',$root,'-NoPanel')) { $info.ArgumentList.Add($argValue) }
    $p = [Diagnostics.Process]::Start($info)
    $processes.Add($p)
    return $p
}
function Wait-Running($Name) {
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
        $path = Join-Path $root "$Name/status.json"
        if (Test-Path $path) {
            $state = Get-Content $path -Raw | ConvertFrom-Json
            if ($state.status -eq 'RUNNING' -and $state.sessionId) { return }
            if ($state.status -in @('FAIL','BLOCKED')) { throw "Unexpected early failure: $Name" }
        }
        Start-Sleep -Milliseconds 50
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Did not start: $Name"
}
try {
    'test' | Set-Content (Join-Path $root 'prompt.txt')
    $job = New-Job 'a'
    $null = New-Job 'b'
    $threadA = 'test-' + [guid]::NewGuid().ToString('N')
    $threadB = 'test-' + [guid]::NewGuid().ToString('N')
    $a = Start-TestRun 'a' $threadA
    $b = Start-TestRun 'b' $threadB
    Wait-Running 'a'; Wait-Running 'b'
    Assert-True (-not $a.HasExited -and -not $b.HasExited) 'Different tasks must overlap'
    $null = New-Job 'duplicate'
    $duplicate = Start-TestRun 'duplicate' $threadA
    Wait-Result $duplicate
    Assert-True ($duplicate.ExitCode -ne 0 -and -not (Test-Path (Join-Path $root 'duplicate'))) 'Same task must reject concurrent execution'
    'stop' | Set-Content (Join-Path $root 'a/stop.request')
    Wait-Result $a
    Assert-True ((Read-Result 'a').status -eq 'CANCELLED') 'Cancellation must be recorded'
    Assert-True (-not $b.HasExited) 'Cancellation must not affect another task'
    Wait-Result $b
    $prior = Read-Result 'b'
    Assert-True ($prior.status -eq 'COMPLETED' -and $prior.usageCheckedAt) 'Simulated run must complete with dated usage'
    $contract = Resolve-ClaudeLiveContract $job
    Assert-True (Test-ClaudeLiveAutomaticResume $contract $root $threadB $prior) 'Compatible commands must resume'
    $contract.AllowedCommands = @([pscustomobject]@{Rule='Bash(PWD)';Responsibility='inspection'})
    Assert-True (-not (Test-ClaudeLiveAutomaticResume $contract $root $threadB $prior)) 'Command case must remain significant'
    $contract.AllowedCommands = @([pscustomobject]@{Rule='Bash(git status)';Responsibility='inspection'})
    Assert-True (-not (Test-ClaudeLiveAutomaticResume $contract $root $threadB $prior)) 'Changed commands must not automatically resume'
    $rejected = $false
    try { Assert-ClaudeLiveResumeCommands $contract $prior } catch { $rejected = $true }
    Assert-True $rejected 'Changed commands require a newer explicit revision'
    $contract.Coordination.ApprovalRevision = 2
    Assert-ClaudeLiveResumeCommands $contract $prior
    $legacy = $prior.PSObject.Copy(); $legacy.PSObject.Properties.Remove('allowedCommands')
    Assert-True (-not (Test-ClaudeLiveAutomaticResume $contract $root $threadB $legacy)) 'Legacy result cannot automatically resume'
    $contract.Coordination.ApprovalRevision = 1
    $rejected = $false
    try { Assert-ClaudeLiveResumeCommands $contract $legacy } catch { $rejected = $true }
    Assert-True $rejected 'Legacy explicit resume requires revision'
    $contract.Coordination.ApprovalRevision = 2
    Assert-ClaudeLiveResumeCommands $contract $legacy
    $commands = @($prior.allowedCommands) + @([pscustomobject]@{rule='Bash(git status)';responsibility='inspection'})
    $first = ConvertTo-Json -InputObject @(ConvertTo-ClaudeLiveCommandRecord $commands) -Compress
    [array]::Reverse($commands)
    Assert-True ($first -ceq (ConvertTo-Json -InputObject @(ConvertTo-ClaudeLiveCommandRecord $commands) -Compress)) 'Ordering must not change command identity'
    $pointer = Join-Path (Get-ClaudeLiveStateDirectory $root $threadB) 'session.json'
    $saved = Get-Content $pointer -Raw
    foreach ($failure in @('usage','start')) {
        $null = New-Job $failure
        $p = Start-TestRun $failure $threadB $failure 10
        Wait-Result $p
        Assert-True ($p.ExitCode -ne 0) 'Failure must return nonzero'
        Assert-True ((Read-Result $failure).status -in @('FAIL','BLOCKED')) 'Preparation failure must have terminal state'
        Assert-True ((Get-Content $pointer -Raw) -ceq $saved) 'Preparation failure must preserve session pointer'
    }
    $mutex = [Threading.Mutex]::new($false, (Get-ClaudeLiveMutexName Quota))
    $held = $false
    try {
        try { $held = $mutex.WaitOne(5000) } catch [Threading.AbandonedMutexException] { $held=$true }
        Assert-True $held 'Cannot acquire test quota mutex'
        $null = New-Job 'mutex'
        $p = Start-TestRun 'mutex' $threadB 'mutex' 10
        Wait-Result $p
        Assert-True ((Read-Result 'mutex').status -eq 'FAIL') 'Mutex timeout must have final state'
        Assert-True ((Get-Content $pointer -Raw) -ceq $saved) 'Mutex timeout must preserve session'
    } finally { if ($held) { $mutex.ReleaseMutex() }; $mutex.Dispose() }
    $null = New-Job 'resume'
    $p = Start-TestRun 'resume' $threadB '' 10
    Wait-Result $p
    $resumed = Read-Result 'resume'
    Assert-True ($resumed.status -eq 'COMPLETED' -and $resumed.resumeMode -eq 'automatic' -and $resumed.sessionId -eq $prior.sessionId) 'Executor must resume the compatible session'
    $explicitJob = New-Job 'explicit-denied' (Join-Path $root 'b/resultado.json')
    $explicitJob.allowedCommands = @([pscustomobject]@{rule='Bash(git status)';responsibility='inspection'})
    $explicitJob | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $root 'explicit-denied.json')
    $p = Start-TestRun 'explicit-denied' $threadB '' 10
    Wait-Result $p
    Assert-True ((Read-Result 'explicit-denied').status -eq 'FAIL') 'Executor must reject changed commands at same revision'
    $explicitJob.coordination.approvalRevision = 2
    $explicitJob | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $root 'explicit-approved.json')
    $p = Start-TestRun 'explicit-approved' $threadB '' 10
    Wait-Result $p
    $explicit = Read-Result 'explicit-approved'
    Assert-True ($explicit.status -eq 'COMPLETED' -and $explicit.resumeMode -eq 'explicit' -and $explicit.sessionId -eq $prior.sessionId) 'New revision must permit explicit resume'
    $log = Join-Path $root 'log.txt'; $cursor = New-ClaudeLogCursor
    $bytes = [Text.Encoding]::UTF8.GetBytes('á🙂fim')
    [IO.File]::WriteAllBytes($log, $bytes[0..2])
    $text = Read-ClaudeLogDelta $cursor $log
    $stream = [IO.File]::OpenWrite($log)
    $null = $stream.Seek(0,[IO.SeekOrigin]::End); $stream.Write($bytes,3,$bytes.Length-3); $stream.Dispose()
    $text += Read-ClaudeLogDelta $cursor $log
    Assert-True ($text -ceq 'á🙂fim') 'UTF8 split must remain intact'
    Assert-True ((Read-ClaudeLogDelta $cursor $log) -ceq '') 'No duplicate log content'
    [IO.File]::WriteAllText($log,'x')
    Assert-True ((Read-ClaudeLogDelta $cursor $log) -ceq 'x') 'Truncation resets cursor'
    $other = Join-Path $root 'other.txt'; [IO.File]::WriteAllText($other,'other')
    Assert-True ((Read-ClaudeLogDelta $cursor $other) -ceq 'other') 'Switching logs resets cursor'
    Write-Output 'Claude runtime integration and incremental log tests passed'
} finally {
    foreach ($p in $processes) { if (-not $p.HasExited) { $p.Kill($true); $p.WaitForExit() }; $p.Dispose() }
    $resolved = [IO.Path]::GetFullPath($root)
    if ((Split-Path $resolved -Parent) -eq [IO.Path]::GetTempPath().TrimEnd('\') -and (Split-Path $resolved -Leaf) -like 'claude-live-test-*') {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
