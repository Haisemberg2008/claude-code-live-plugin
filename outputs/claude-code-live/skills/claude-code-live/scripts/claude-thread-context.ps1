#requires -Version 7.0
function Resolve-ClaudeLiveThreadContext {
    param(
        [Parameter(Mandatory)]$Job,
        [string]$CodexThreadId,
        [string]$CodexSessionId
    )

    $jobThreadId = [string](Get-ClaudeLiveProperty -InputObject $Job -Name 'codexThreadId')
    $runtimeId = if ($CodexThreadId) { $CodexThreadId } elseif ($CodexSessionId) { $CodexSessionId } else { $null }
    if ($jobThreadId -and $runtimeId -and $jobThreadId -ne $runtimeId) {
        throw 'job.codexThreadId does not match the current Codex task identity.'
    }

    if ($CodexThreadId) {
        $threadId = $CodexThreadId
        $source = 'codex-thread'
    } elseif ($jobThreadId) {
        $threadId = $jobThreadId
        $source = 'job'
    } elseif ($CodexSessionId) {
        $threadId = $CodexSessionId
        $source = 'codex-session'
    } else {
        $threadId = 'standalone-' + [guid]::NewGuid().ToString('N')
        $source = 'generated'
    }

    if ($threadId -notmatch '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$') {
        throw 'The Codex task identity is not safe for local state or mutex names.'
    }
    [pscustomobject][ordered]@{
        ThreadId = $threadId
        ThreadKey = $threadId.ToLowerInvariant()
        Source = $source
    }
}

function Get-ClaudeLiveMutexName {
    param(
        [Parameter(Mandatory)][ValidateSet('Run','Panel','Quota')][string]$Kind,
        [string]$ThreadKey
    )
    if ($Kind -eq 'Quota') { return 'Local\ClaudeLiveQuota' }
    if ([string]::IsNullOrWhiteSpace($ThreadKey)) { throw "ThreadKey is required for the $Kind mutex." }
    return 'Local\ClaudeLive' + $Kind + '-' + $ThreadKey
}

function Get-ClaudeLiveStateDirectory {
    param(
        [Parameter(Mandatory)][string]$LocalAppData,
        [Parameter(Mandatory)][string]$ThreadKey
    )
    if ($ThreadKey -notmatch '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$') {
        throw 'ThreadKey is not safe for a local state directory.'
    }
    Join-Path $LocalAppData ('CodexClaudeLive\threads\' + $ThreadKey)
}

function Get-ClaudeLivePreviousResultFile {
    param([Parameter(Mandatory)][string]$StateDirectory)
    $pointerFile = Join-Path $StateDirectory 'session.json'
    if (-not (Test-Path -LiteralPath $pointerFile)) { return $null }
    try {
        $pointer = Get-Content -LiteralPath $pointerFile -Raw -Encoding utf8 | ConvertFrom-Json
        $resultFile = [string]$pointer.resultFile
        if ($resultFile -and (Test-Path -LiteralPath $resultFile)) {
            return [IO.Path]::GetFullPath($resultFile)
        }
    } catch { }
    return $null
}

function Write-ClaudeLiveSessionPointer {
    param(
        [Parameter(Mandatory)][string]$PointerFile,
        [Parameter(Mandatory)][string]$ResultFile
    )
    $resolvedResult = (Resolve-Path -LiteralPath $ResultFile).Path
    $temp = $PointerFile + '.tmp'
    [pscustomobject]@{ resultFile = $resolvedResult } | ConvertTo-Json -Compress |
        Set-Content -LiteralPath $temp -Encoding utf8
    [IO.File]::Move($temp, $PointerFile, $true)
}

function ConvertTo-ClaudeLiveCommandRecord {
    param($Commands)
    @($Commands | ForEach-Object {
        [pscustomobject][ordered]@{ rule = [string]$_.Rule; responsibility = ([string]$_.Responsibility).ToLowerInvariant() }
    } | Sort-Object -Property rule,responsibility -CaseSensitive -Unique)
}

function Assert-ClaudeLiveResumeCommands {
    param($CurrentContract, $PriorResult)
    $known = $null -ne $PriorResult.PSObject.Properties['allowedCommands']
    $current = ConvertTo-Json -InputObject @(ConvertTo-ClaudeLiveCommandRecord $CurrentContract.AllowedCommands) -Compress
    $previous = ConvertTo-Json -InputObject @(ConvertTo-ClaudeLiveCommandRecord $PriorResult.allowedCommands) -Compress
    if ((-not $known -or $current -cne $previous) -and
        $CurrentContract.Coordination.ApprovalRevision -le $PriorResult.coordination.approvalRevision) {
        throw 'Changed or legacy command permissions require a newer approval revision.'
    }
}

function Get-ClaudeLiveSessionFingerprint {
    param(
        [Parameter(Mandatory)]$Contract,
        [Parameter(Mandatory)]$Coordination,
        $ModelPolicy
    )
    $normalizedCoordination = ConvertTo-ClaudeLiveCoordination -Value $Coordination
    [pscustomobject][ordered]@{
        mode = [string]$Contract.Mode
        profile = [string]$Contract.Profile
        effort = [string]$Contract.Effort
        requestedModel = [string]$Contract.Model
        allowedCommands = @(ConvertTo-ClaudeLiveCommandRecord $Contract.AllowedCommands)
        modelPolicy = Get-ClaudeLiveModelPolicyFingerprint -ModelPolicy $ModelPolicy
        coordination = [pscustomobject][ordered]@{
            phase = $normalizedCoordination.Phase
            scopeId = $normalizedCoordination.ScopeId
            approvalRevision = $normalizedCoordination.ApprovalRevision
            planSummary = $normalizedCoordination.PlanSummary
            planApproved = $normalizedCoordination.PlanApproved
            responsibilities = $normalizedCoordination.Responsibilities
        }
    } | ConvertTo-Json -Depth 7 -Compress
}

function Test-ClaudeLiveAutomaticResume {
    param(
        [Parameter(Mandatory)]$CurrentContract,
        [Parameter(Mandatory)][string]$Workspace,
        [Parameter(Mandatory)][string]$ThreadId,
        [Parameter(Mandatory)]$PriorResult
    )
    if (-not $PriorResult.sessionId -or -not $PriorResult.coordination -or -not $PriorResult.codexThreadId) { return $false }
    if ($null -eq $PriorResult.PSObject.Properties['allowedCommands']) { return $false }
    if (-not [string]::Equals([string]$PriorResult.workspace, $Workspace, [StringComparison]::OrdinalIgnoreCase)) { return $false }
    if (-not [string]::Equals([string]$PriorResult.codexThreadId, $ThreadId, [StringComparison]::OrdinalIgnoreCase)) { return $false }

    try {
        $priorContract = [pscustomobject]@{
            Mode = [string]$PriorResult.mode
            Profile = [string]$PriorResult.profile
            Effort = [string]$PriorResult.effort
            Model = [string]$PriorResult.requestedModel
            AllowedCommands = $PriorResult.allowedCommands
        }
        $currentFingerprint = Get-ClaudeLiveSessionFingerprint -Contract $CurrentContract -Coordination $CurrentContract.Coordination -ModelPolicy $CurrentContract.ModelPolicy
        $priorFingerprint = Get-ClaudeLiveSessionFingerprint -Contract $priorContract -Coordination $PriorResult.coordination -ModelPolicy $PriorResult.modelPolicy
        return $currentFingerprint -ceq $priorFingerprint
    } catch {
        return $false
    }
}

function Assert-ClaudeLiveResumeThreadIdentity {
    param(
        [Parameter(Mandatory)][string]$CurrentThreadId,
        [Parameter(Mandatory)]$PriorResult
    )
    $priorThreadId = [string](Get-ClaudeLiveProperty -InputObject $PriorResult -Name 'codexThreadId')
    if ($priorThreadId -and -not [string]::Equals($priorThreadId, $CurrentThreadId, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The requested Claude session belongs to a different Codex task.'
    }
}
