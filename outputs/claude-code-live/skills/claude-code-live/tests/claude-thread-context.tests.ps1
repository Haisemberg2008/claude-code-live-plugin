#requires -Version 7.0
$ErrorActionPreference = 'Stop'

$contractScript = Join-Path $PSScriptRoot '..\scripts\claude-live-contract.ps1'
$threadScript = Join-Path $PSScriptRoot '..\scripts\claude-thread-context.ps1'
. $contractScript
. $threadScript

function New-TestResponsibilities {
    [pscustomobject]@{
        planning = 'codex'; inspection = 'codex'; implementation = 'codex'; testing = 'codex'
        review = 'codex'; commit = 'codex'; push = 'codex'; deploy = 'codex'
    }
}

function New-TestCoordination {
    param([string]$Scope = 'per-thread-session', [int]$Revision = 1)
    [pscustomobject]@{
        phase = 'execution'; scopeId = $Scope; approvalRevision = $Revision
        planSummary = 'Keep one compatible Claude session per Codex task.'; planApproved = $true
        responsibilities = New-TestResponsibilities
    }
}

function New-TestContract {
    param([string]$Scope = 'per-thread-session', [int]$Revision = 1)
    Resolve-ClaudeLiveContract -Job ([pscustomobject]@{ mode = 'read'; coordination = New-TestCoordination -Scope $Scope -Revision $Revision })
}

function Assert-Throws {
    param([scriptblock]$Action, [string]$Pattern, [string]$Because)
    $message = $null
    try { & $Action } catch { $message = $_.Exception.Message }
    if (-not $message -or $message -notmatch $Pattern) {
        throw "Expected rejection because ${Because}; received: $message"
    }
}

$threadA = Resolve-ClaudeLiveThreadContext -Job ([pscustomobject]@{}) -CodexThreadId '11111111-1111-1111-1111-111111111111'
$threadB = Resolve-ClaudeLiveThreadContext -Job ([pscustomobject]@{}) -CodexThreadId '22222222-2222-2222-2222-222222222222'
if ($threadA.ThreadKey -eq $threadB.ThreadKey) { throw 'Different Codex tasks must never share a state key.' }
if ($threadA.Source -ne 'codex-thread') { throw 'CODEX_THREAD_ID must be the preferred identity source.' }
$stateA = Get-ClaudeLiveStateDirectory -LocalAppData 'C:\local-state' -ThreadKey $threadA.ThreadKey
$stateB = Get-ClaudeLiveStateDirectory -LocalAppData 'C:\local-state' -ThreadKey $threadB.ThreadKey
if ($stateA -eq $stateB -or $stateA -ne 'C:\local-state\CodexClaudeLive\threads\11111111-1111-1111-1111-111111111111') {
    throw 'Each Codex task must resolve to its own deterministic local state directory.'
}

$sessionFallback = Resolve-ClaudeLiveThreadContext -Job ([pscustomobject]@{}) -CodexSessionId '33333333-3333-3333-3333-333333333333'
if ($sessionFallback.ThreadId -ne '33333333-3333-3333-3333-333333333333' -or $sessionFallback.Source -ne 'codex-session') {
    throw 'CODEX_SESSION_ID must isolate the task when CODEX_THREAD_ID is unavailable.'
}

$explicit = Resolve-ClaudeLiveThreadContext -Job ([pscustomobject]@{ codexThreadId = 'manual-task-7' })
if ($explicit.ThreadId -ne 'manual-task-7' -or $explicit.Source -ne 'job') {
    throw 'A standalone job must support an explicit stable task identity.'
}

Assert-Throws {
    Resolve-ClaudeLiveThreadContext -Job ([pscustomobject]@{ codexThreadId = 'manual-task-7' }) -CodexThreadId '11111111-1111-1111-1111-111111111111' | Out-Null
} 'does not match' 'a job cannot claim a different Codex task identity'

$generatedA = Resolve-ClaudeLiveThreadContext -Job ([pscustomobject]@{})
$generatedB = Resolve-ClaudeLiveThreadContext -Job ([pscustomobject]@{})
if ($generatedA.Source -ne 'generated' -or $generatedA.ThreadKey -eq $generatedB.ThreadKey) {
    throw 'Standalone jobs without identity must get isolated one-use keys instead of sharing global state.'
}

$runMutexA = Get-ClaudeLiveMutexName -Kind Run -ThreadKey $threadA.ThreadKey
$runMutexB = Get-ClaudeLiveMutexName -Kind Run -ThreadKey $threadB.ThreadKey
if ($runMutexA -eq $runMutexB) { throw 'Run mutexes must permit different Codex tasks to execute independently.' }
if ((Get-ClaudeLiveMutexName -Kind Quota) -ne (Get-ClaudeLiveMutexName -Kind Quota)) {
    throw 'Quota coordination must remain global across Codex tasks.'
}

$contract = New-TestContract
$prior = [pscustomobject]@{
    status = 'COMPLETED'; sessionId = 'claude-session-a'; workspace = 'C:\workspace-a'
    codexThreadId = $threadA.ThreadId
    mode = 'read'; profile = 'diagnostic'; effort = 'high'; requestedModel = 'fable'
    coordination = [pscustomobject]@{
        phase = 'execution'; scopeId = 'per-thread-session'; approvalRevision = 1
        planSummary = 'Keep one compatible Claude session per Codex task.'; planApproved = $true
        responsibilities = New-TestResponsibilities
    }
    modelPolicy = $null
    allowedCommands = @()
}

$compatible = Test-ClaudeLiveAutomaticResume -CurrentContract $contract -Workspace 'C:\workspace-a' -ThreadId $threadA.ThreadId -PriorResult $prior
if (-not $compatible) { throw 'An exactly compatible prior result in the same Codex task must resume automatically.' }
Assert-ClaudeLiveResumeThreadIdentity -CurrentThreadId $threadA.ThreadId -PriorResult $prior
Assert-Throws {
    Assert-ClaudeLiveResumeThreadIdentity -CurrentThreadId $threadB.ThreadId -PriorResult $prior
} 'different Codex task' 'explicit resume cannot import a session owned by another Codex task'
$legacyPrior = $prior.PSObject.Copy()
$legacyPrior.PSObject.Properties.Remove('codexThreadId')
Assert-ClaudeLiveResumeThreadIdentity -CurrentThreadId $threadB.ThreadId -PriorResult $legacyPrior

foreach ($incompatible in @(
    @{ Prior = $prior.PSObject.Copy(); Workspace = 'C:\workspace-b'; Thread = $threadA.ThreadId; Contract = $contract; Because = 'workspace changed' },
    @{ Prior = $prior.PSObject.Copy(); Workspace = 'C:\workspace-a'; Thread = $threadB.ThreadId; Contract = $contract; Because = 'Codex task changed' },
    @{ Prior = $prior.PSObject.Copy(); Workspace = 'C:\workspace-a'; Thread = $threadA.ThreadId; Contract = (New-TestContract -Scope 'different-scope'); Because = 'scope changed' },
    @{ Prior = $prior.PSObject.Copy(); Workspace = 'C:\workspace-a'; Thread = $threadA.ThreadId; Contract = (New-TestContract -Revision 2); Because = 'approval revision changed' }
)) {
    if (Test-ClaudeLiveAutomaticResume -CurrentContract $incompatible.Contract -Workspace $incompatible.Workspace -ThreadId $incompatible.Thread -PriorResult $incompatible.Prior) {
        throw ('Automatic resume must start a new Claude session when ' + $incompatible.Because + '.')
    }
}

$noSession = $prior.PSObject.Copy()
$noSession.sessionId = $null
if (Test-ClaudeLiveAutomaticResume -CurrentContract $contract -Workspace 'C:\workspace-a' -ThreadId $threadA.ThreadId -PriorResult $noSession) {
    throw 'A prior run without a Claude session id cannot resume automatically.'
}

$stateDirectory = Join-Path ([IO.Path]::GetTempPath()) ('claude-live-thread-test-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($stateDirectory) | Out-Null
try {
    $resumableResult = Join-Path $stateDirectory 'resumable-result.json'
    [IO.File]::WriteAllText($resumableResult, '{}')
    $sessionPointer = Join-Path $stateDirectory 'session.json'
    Write-ClaudeLiveSessionPointer -PointerFile $sessionPointer -ResultFile $resumableResult
    $resolvedResult = Get-ClaudeLivePreviousResultFile -StateDirectory $stateDirectory
    if ($resolvedResult -ne $resumableResult) {
        throw 'Session lookup must use the durable session pointer, independent from the panel current-run pointer.'
    }
} finally {
    Remove-Item -LiteralPath $stateDirectory -Recurse -Force
}

Write-Output 'claude thread context tests passed'
