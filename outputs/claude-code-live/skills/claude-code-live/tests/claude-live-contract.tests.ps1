#requires -Version 7.0
$ErrorActionPreference = 'Stop'

$contractScript = Join-Path $PSScriptRoot '..\scripts\claude-live-contract.ps1'
if (-not (Test-Path -LiteralPath $contractScript)) {
    throw 'The Claude Live contract helper is missing.'
}
. $contractScript

function New-Responsibilities {
    param(
        [string]$Planning = 'codex',
        [string]$Inspection = 'claude',
        [string]$Implementation = 'claude',
        [string]$Testing = 'claude',
        [string]$Review = 'codex',
        [string]$Commit = 'not_applicable',
        [string]$Push = 'not_applicable',
        [string]$Deploy = 'not_applicable'
    )
    [pscustomobject]@{
        planning = $Planning
        inspection = $Inspection
        implementation = $Implementation
        testing = $Testing
        review = $Review
        commit = $Commit
        push = $Push
        deploy = $Deploy
    }
}

function New-Coordination {
    param(
        [string]$Phase = 'execution',
        [bool]$Approved = $true,
        [int]$Revision = 1,
        [string]$Summary = 'Implement the approved coordination gate.',
        $Responsibilities = (New-Responsibilities)
    )
    [pscustomobject]@{
        phase = $Phase
        scopeId = 'coordination-gate'
        approvalRevision = $Revision
        planSummary = $Summary
        planApproved = $Approved
        responsibilities = $Responsibilities
    }
}

function Assert-Throws {
    param([scriptblock]$Action, [string]$Pattern, [string]$Because)
    $message = $null
    try { & $Action } catch { $message = $_.Exception.Message }
    if (-not $message -or $message -notmatch $Pattern) {
        throw "Expected rejection because ${Because}; received: $message"
    }
}

Assert-Throws {
    Resolve-ClaudeLiveContract -Job ([pscustomobject]@{ mode = 'read' }) | Out-Null
} 'coordination' 'coordination is mandatory'

$planning = Resolve-ClaudeLiveContract -Job ([pscustomobject]@{
    mode = 'read'
    coordination = New-Coordination -Phase 'planning' -Approved $false -Summary '' -Responsibilities (New-Responsibilities -Planning 'claude' -Implementation 'codex')
})
if ($planning.Coordination.Phase -ne 'planning' -or $planning.Coordination.PlanApproved) {
    throw 'A read-only planning job must be accepted before final plan approval.'
}

Assert-Throws {
    Resolve-ClaudeLiveContract -Job ([pscustomobject]@{
        mode = 'local'
        coordination = New-Coordination -Phase 'planning' -Approved $false -Summary ''
    }) | Out-Null
} 'planning.*chat.*read' 'planning cannot grant mutation tools'

Assert-Throws {
    Resolve-ClaudeLiveContract -Job ([pscustomobject]@{
        mode = 'read'
        coordination = New-Coordination -Approved $false
    }) | Out-Null
} 'approved' 'execution requires explicit plan approval'

Assert-Throws {
    $owners = New-Responsibilities
    $owners.PSObject.Properties.Remove('review')
    Resolve-ClaudeLiveContract -Job ([pscustomobject]@{
        mode = 'read'
        coordination = New-Coordination -Responsibilities $owners
    }) | Out-Null
} 'review' 'all eight responsibility rows are mandatory'

Assert-Throws {
    $owners = New-Responsibilities
    $owners | Add-Member -NotePropertyName publish -NotePropertyValue codex
    Resolve-ClaudeLiveContract -Job ([pscustomobject]@{
        mode = 'read'
        coordination = New-Coordination -Responsibilities $owners
    }) | Out-Null
} 'unexpected.*publish|publish.*unexpected' 'unreviewed responsibility rows cannot be smuggled into the matrix'

Assert-Throws {
    Resolve-ClaudeLiveContract -Job ([pscustomobject]@{
        mode = 'read'
        coordination = New-Coordination -Responsibilities (New-Responsibilities -Inspection 'team')
    }) | Out-Null
} 'inspection.*actor' 'responsibility actors use the closed enum'

foreach ($criticalStage in @('commit','push','deploy')) {
    $owners = New-Responsibilities
    $owners.$criticalStage = 'claude'
    Assert-Throws {
        Resolve-ClaudeLiveContract -Job ([pscustomobject]@{
            mode = 'read'
            coordination = New-Coordination -Responsibilities $owners
        }) | Out-Null
    } $criticalStage "Claude cannot own $criticalStage"
}

Assert-Throws {
    Resolve-ClaudeLiveContract -Job ([pscustomobject]@{
        mode = 'local'
        coordination = New-Coordination -Responsibilities (New-Responsibilities -Implementation 'codex')
    }) | Out-Null
} 'implementation.*Claude|Claude.*implementation' 'local mode grants editing only to the implementation owner'

$verification = Resolve-ClaudeLiveContract -Job ([pscustomobject]@{
    mode = 'verify'
    coordination = New-Coordination -Responsibilities (New-Responsibilities -Implementation 'codex')
    allowedCommands = @(
        [pscustomobject]@{ rule = 'Bash(pwsh -NoProfile -File tests.ps1)'; responsibility = 'testing' }
    )
})
if ($verification.Mode -ne 'verify' -or $verification.AllowedCommands[0].Responsibility -ne 'testing') {
    throw 'Verify mode must preserve an approved test command without granting editing.'
}
$verificationTools = Get-ClaudeLiveToolConfiguration -Contract $verification
if ($verificationTools.Tools -contains 'Write' -or $verificationTools.Tools -contains 'Edit') {
    throw 'Verify mode must never expose writing tools.'
}
foreach ($expectedTool in @('Read','Glob','Grep','Bash')) {
    if ($verificationTools.Tools -notcontains $expectedTool) { throw "Verify mode is missing $expectedTool." }
}
if ($verificationTools.Allowed -notcontains 'Bash(pwsh -NoProfile -File tests.ps1)') {
    throw 'Verify mode must pass the exact approved command rule to Claude.'
}

$localContract = Resolve-ClaudeLiveContract -Job ([pscustomobject]@{
    mode = 'local'
    coordination = New-Coordination
})
$localTools = Get-ClaudeLiveToolConfiguration -Contract $localContract
foreach ($expectedTool in @('Read','Glob','Grep','Write','Edit')) {
    if ($localTools.Tools -notcontains $expectedTool) { throw "Local mode is missing $expectedTool." }
}

Assert-Throws {
    Resolve-ClaudeLiveContract -Job ([pscustomobject]@{
        mode = 'verify'
        coordination = New-Coordination
        allowedCommands = @(
            [pscustomobject]@{ rule = 'Bash(git push origin HEAD)'; responsibility = 'push' }
        )
    }) | Out-Null
} 'critical.*command|command.*critical' 'critical commands cannot be delegated to Claude'

Assert-Throws {
    Resolve-ClaudeLiveContract -Job ([pscustomobject]@{
        mode = 'verify'
        coordination = New-Coordination
        allowedCommands = @(
            [pscustomobject]@{ rule = 'Bash(git push origin HEAD)'; responsibility = 'testing' }
        )
    }) | Out-Null
} 'critical.*command|command.*critical' 'a critical command cannot bypass ownership by using a false responsibility label'

$defaults = Resolve-ClaudeLiveContract -Job ([pscustomobject]@{
    mode = 'read'
    coordination = New-Coordination
})
if ($defaults.Model -ne 'fable') { throw 'The default Claude model must be fable.' }
if ($defaults.Effort -ne 'high') { throw 'The default effort must be high.' }
if ($defaults.TimeoutPolicy.Mode -ne 'adaptive' -or
    $defaults.TimeoutPolicy.RenewEverySeconds -ne 1800 -or
    $defaults.TimeoutPolicy.IdleAfterSeconds -ne 1200 -or
    $defaults.TimeoutPolicy.HardStopAfterSeconds -ne 7200) {
    throw 'Jobs without a timeout setting must use the safe adaptive defaults.'
}

$adaptiveTimeout = Resolve-ClaudeLiveContract -Job ([pscustomobject]@{
    mode = 'read'
    coordination = New-Coordination
    timeoutPolicy = [pscustomobject]@{
        mode = 'adaptive'
        renewEverySeconds = 60
        idleAfterSeconds = 30
        hardStopAfterSeconds = 180
    }
})
if ($adaptiveTimeout.TimeoutPolicy.Mode -ne 'adaptive' -or
    $adaptiveTimeout.TimeoutPolicy.RenewEverySeconds -ne 60 -or
    $adaptiveTimeout.TimeoutPolicy.IdleAfterSeconds -ne 30 -or
    $adaptiveTimeout.TimeoutPolicy.HardStopAfterSeconds -ne 180) {
    throw 'An explicit adaptive timeout policy must be normalized and preserved.'
}

$fixedTimeout = Resolve-ClaudeLiveContract -Job ([pscustomobject]@{
    mode = 'read'
    coordination = New-Coordination
    timeoutSeconds = 90
})
if ($fixedTimeout.TimeoutPolicy.Mode -ne 'fixed' -or $fixedTimeout.TimeoutPolicy.TimeoutSeconds -ne 90) {
    throw 'Legacy timeoutSeconds must retain fixed-deadline behavior.'
}

Assert-Throws {
    Resolve-ClaudeLiveContract -Job ([pscustomobject]@{
        mode = 'read'
        coordination = New-Coordination
        timeoutSeconds = 90
        timeoutPolicy = [pscustomobject]@{ mode = 'adaptive' }
    }) | Out-Null
} 'timeoutSeconds.*timeoutPolicy|timeoutPolicy.*timeoutSeconds' 'fixed and adaptive timeout settings cannot be combined'

foreach ($invalidPolicy in @(
    [pscustomobject]@{ mode = 'fixed' },
    [pscustomobject]@{ mode = 'adaptive'; renewEverySeconds = 0 },
    [pscustomobject]@{ mode = 'adaptive'; idleAfterSeconds = '30' },
    [pscustomobject]@{ mode = 'adaptive'; hardStopAfterSeconds = 10; renewEverySeconds = 20 },
    [pscustomobject]@{ mode = 'adaptive'; hardStopAfterSeconds = 10; idleAfterSeconds = 20 },
    [pscustomobject]@{ mode = 'adaptive'; extra = 1 }
)) {
    Assert-Throws {
        Resolve-ClaudeLiveContract -Job ([pscustomobject]@{
            mode = 'read'
            coordination = New-Coordination
            timeoutPolicy = $invalidPolicy
        }) | Out-Null
    } 'timeoutPolicy' 'malformed adaptive timeout policies must be rejected'
}

Assert-Throws {
    Resolve-ClaudeLiveContract -Job ([pscustomobject]@{
        mode = 'read'
        coordination = New-Coordination
        timeoutSeconds = 0
    }) | Out-Null
} 'timeoutSeconds' 'fixed timeoutSeconds must remain a positive integer'

$override = Resolve-ClaudeLiveContract -Job ([pscustomobject]@{
    mode = 'read'
    coordination = New-Coordination
    model = 'sonnet'
    effort = 'medium'
})
if ($override.Model -ne 'sonnet') { throw 'An explicit model override must be preserved.' }
if ($override.Effort -ne 'medium') { throw 'An explicit effort override must be preserved.' }

$threadBound = Resolve-ClaudeLiveContract -Job ([pscustomobject]@{
    mode = 'read'
    coordination = New-Coordination
    codexThreadId = 'manual-task-7'
})
if ($threadBound.CodexThreadId -ne 'manual-task-7') { throw 'An explicit standalone Codex task identity must be preserved.' }

Assert-Throws {
    Resolve-ClaudeLiveContract -Job ([pscustomobject]@{
        mode = 'read'
        coordination = New-Coordination
        codexThreadId = '..\shared'
    }) | Out-Null
} 'codexThreadId' 'task identity cannot escape its state directory or mutex namespace'

$quotaAware = Resolve-ClaudeLiveContract -Job ([pscustomobject]@{
    mode = 'read'
    coordination = New-Coordination
    modelPolicy = [pscustomobject]@{
        mode = 'quota-aware'
        primary = 'fable'
        alternate = 'opus'
    }
})
if ($quotaAware.Model -ne 'fable' -or $quotaAware.ModelPolicy.SwitchAtRemainingPercent -ne 3) {
    throw 'Quota-aware jobs must default the threshold to three percent and expose the primary model.'
}

Assert-Throws {
    Resolve-ClaudeLiveContract -Job ([pscustomobject]@{
        mode = 'read'
        coordination = New-Coordination
        model = 'fable'
        modelPolicy = [pscustomobject]@{ mode = 'quota-aware'; primary = 'fable'; alternate = 'opus' }
    }) | Out-Null
} 'model.*modelPolicy|modelPolicy.*model' 'fixed and quota-aware model selection cannot be combined'

foreach ($invalidThreshold in @(0, 21, 2.5, '3')) {
    Assert-Throws {
        Resolve-ClaudeLiveContract -Job ([pscustomobject]@{
            mode = 'read'
            coordination = New-Coordination
            modelPolicy = [pscustomobject]@{
                mode = 'quota-aware'; primary = 'fable'; alternate = 'opus'
                switchAtRemainingPercent = $invalidThreshold
            }
        }) | Out-Null
    } 'switchAtRemainingPercent' 'the quota threshold must be an integer from one through twenty'
}

Assert-Throws {
    Resolve-ClaudeLiveContract -Job ([pscustomobject]@{
        mode = 'read'
        coordination = New-Coordination
        modelPolicy = [pscustomobject]@{ mode = 'quota-aware'; primary = 'opus'; alternate = 'fable' }
    }) | Out-Null
} 'primary.*fable|alternate.*opus' 'version one has an intentionally asymmetric Fable-to-Opus policy'

Assert-Throws {
    Resolve-ClaudeLiveContract -Job ([pscustomobject]@{
        mode = 'read'
        coordination = New-Coordination
        effort = 'invalid'
    }) | Out-Null
} 'effort' 'invalid effort is rejected'

$currentCoordination = (Resolve-ClaudeLiveContract -Job ([pscustomobject]@{
    mode = 'read'
    coordination = New-Coordination
})).Coordination
$priorCoordination = [pscustomobject]@{
    phase = 'execution'
    scopeId = 'coordination-gate'
    approvalRevision = 1
    planSummary = 'Implement the approved coordination gate.'
    planApproved = $true
    responsibilities = New-Responsibilities
}
Assert-ClaudeLiveResumeCoordination -Current $currentCoordination -Prior $priorCoordination

$priorPolicy = [pscustomobject]@{ mode = 'quota-aware'; primary = 'fable'; alternate = 'opus'; switchAtRemainingPercent = 3 }
$changedPolicy = [pscustomobject]@{ mode = 'quota-aware'; primary = 'fable'; alternate = 'opus'; switchAtRemainingPercent = 5 }
Assert-Throws {
    Assert-ClaudeLiveResumeCoordination -Current $currentCoordination -Prior $priorCoordination -CurrentModelPolicy $changedPolicy -PriorModelPolicy $priorPolicy
} 'revision' 'a changed quota policy requires a newer approval revision'

$revisedCoordination = New-Coordination -Revision 2
Assert-ClaudeLiveResumeCoordination -Current $revisedCoordination -Prior $priorCoordination -CurrentModelPolicy $changedPolicy -PriorModelPolicy $priorPolicy

Assert-Throws {
    $malformedPrior = [pscustomobject]@{
        phase = 'execution'
        scopeId = 'coordination-gate'
        planSummary = 'Implement the approved coordination gate.'
        planApproved = $true
        responsibilities = New-Responsibilities
    }
    Assert-ClaudeLiveResumeCoordination -Current $currentCoordination -Prior $malformedPrior
} 'approvalRevision' 'a partial legacy coordination record is not valid resume evidence'

Assert-Throws {
    $changed = New-Coordination -Summary 'Expanded scope without a new approval.'
    $changedContract = Resolve-ClaudeLiveContract -Job ([pscustomobject]@{ mode = 'read'; coordination = $changed })
    Assert-ClaudeLiveResumeCoordination -Current $changedContract.Coordination -Prior $priorCoordination
} 'revision' 'a changed resumed plan requires a newer approval revision'

$reapproved = New-Coordination -Revision 2 -Summary 'Expanded and explicitly reapproved scope.'
$reapprovedContract = Resolve-ClaudeLiveContract -Job ([pscustomobject]@{ mode = 'read'; coordination = $reapproved })
Assert-ClaudeLiveResumeCoordination -Current $reapprovedContract.Coordination -Prior $priorCoordination

Write-Output 'claude-live contract tests passed'
