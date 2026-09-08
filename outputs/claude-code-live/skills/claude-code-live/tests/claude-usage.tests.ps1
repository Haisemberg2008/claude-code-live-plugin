#requires -Version 7.0
$ErrorActionPreference = 'Stop'

$usageScript = Join-Path $PSScriptRoot '..\scripts\claude-usage.ps1'
if (-not (Test-Path -LiteralPath $usageScript)) {
    throw 'The Claude usage helper is missing.'
}
. $usageScript

$sample = @'
Current session: 10% used · resets Sep 6, 9:19pm (America/Sao_Paulo)
Current week (all models): 23% used · resets Sep 10, 8:59pm (America/Sao_Paulo)
Current week (Fable): 44% used · resets Sep 10, 8:59pm (America/Sao_Paulo)
'@

$usage = ConvertFrom-ClaudeUsageText -Text $sample
if ($usage.Session.UsedPercent -ne 10 -or $usage.Session.RemainingPercent -ne 90) { throw 'Session usage parsing failed.' }
if ($usage.AllModels.UsedPercent -ne 23 -or $usage.AllModels.RemainingPercent -ne 77) { throw 'Weekly usage parsing failed.' }
if ($usage.Fable.UsedPercent -ne 44 -or $usage.Fable.RemainingPercent -ne 56) { throw 'Fable usage parsing failed.' }
if ($usage.AlertLevel -ne 'ok') { throw 'Unexpected alert for healthy usage.' }

function New-UsageSnapshot {
    param([int]$SessionRemaining, [int]$AllModelsRemaining, [int]$FableRemaining)
    [pscustomobject]@{
        Session = [pscustomobject]@{ RemainingPercent = $SessionRemaining }
        AllModels = [pscustomobject]@{ RemainingPercent = $AllModelsRemaining }
        Fable = [pscustomobject]@{ RemainingPercent = $FableRemaining }
    }
}

$policy = [pscustomobject]@{
    Mode = 'quota-aware'
    Primary = 'fable'
    Alternate = 'opus'
    SwitchAtRemainingPercent = 3
}

$primarySelection = Select-ClaudeModelForUsage -Usage (New-UsageSnapshot 60 49 4) -ModelPolicy $policy
if ($primarySelection.EffectiveModel -ne 'fable' -or $primarySelection.Reason -ne 'primary_has_capacity') {
    throw 'Fable must remain selected while its effective capacity is above the threshold.'
}
if ($primarySelection.SharedRemainingPercent -ne 49 -or $primarySelection.FableRemainingPercent -ne 4) {
    throw 'Selection evidence must report independently derived shared and Fable capacity.'
}

$boundarySelection = Select-ClaudeModelForUsage -Usage (New-UsageSnapshot 60 49 3) -ModelPolicy $policy
if ($boundarySelection.EffectiveModel -ne 'opus' -or $boundarySelection.Reason -ne 'primary_at_or_below_threshold') {
    throw 'The exact Fable threshold must switch to Opus.'
}

$renewedSelection = Select-ClaudeModelForUsage -Usage (New-UsageSnapshot 60 49 80) -ModelPolicy $policy
if ($renewedSelection.EffectiveModel -ne 'fable') {
    throw 'A later start must return to the primary model after Fable renews.'
}

foreach ($blockedCase in @(
    @{ Usage = New-UsageSnapshot 3 49 80; Because = 'session capacity reaches the threshold' },
    @{ Usage = New-UsageSnapshot 60 3 80; Because = 'shared weekly capacity reaches the threshold' }
)) {
    $blocked = Select-ClaudeModelForUsage -Usage $blockedCase.Usage -ModelPolicy $policy
    if (-not $blocked.Blocked -or $blocked.EffectiveModel -or $blocked.Reason -ne 'shared_capacity_at_or_below_threshold') {
        throw ('Model selection must block when ' + $blockedCase.Because + '.')
    }
}

$usageFailureDecision = Resolve-ClaudeModelDecision -RequestedModel 'fable' -ModelPolicy $policy -UsageProvider {
    throw 'raw provider detail that must not escape'
}
if (-not $usageFailureDecision.Blocked -or $usageFailureDecision.Reason -ne 'usage_unavailable') {
    throw 'A quota-aware job must block when usage cannot be confirmed.'
}
if ($usageFailureDecision.PublicMessage -match 'raw provider detail') {
    throw 'The quota decision must not expose raw usage-query errors.'
}

$fixedFailureDecision = Resolve-ClaudeModelDecision -RequestedModel 'sonnet' -UsageProvider { throw 'provider unavailable' }
if ($fixedFailureDecision.Blocked -or $fixedFailureDecision.EffectiveModel -ne 'sonnet') {
    throw 'A legacy fixed-model job must keep running when the optional usage display is unavailable.'
}

$sharedBlockDecision = Resolve-ClaudeModelDecision -RequestedModel 'fable' -ModelPolicy $policy -UsageProvider {
    New-UsageSnapshot 60 3 80
}
if (-not $sharedBlockDecision.PublicMessage -or $sharedBlockDecision.PublicMessage -notmatch 'compartilhada') {
    throw 'A confirmed shared-capacity block must provide a sanitized public explanation.'
}

$serializableSelection = ConvertTo-ClaudeModelSelectionRecord -Selection $boundarySelection
if ($serializableSelection.effectiveModel -ne 'opus' -or $serializableSelection.switchAtRemainingPercent -ne 3 -or $serializableSelection.fableRemainingPercent -ne 3) {
    throw 'Sanitized status records must expose the effective model, threshold, and relevant percentages.'
}
$selectionLine = Format-ClaudeModelSelection -Selection $boundarySelection
if ($selectionLine -notmatch 'fable.*opus' -or $selectionLine -notmatch '3%') {
    throw 'The live panel must show the requested and effective models with the threshold evidence.'
}
$unavailableLine = Format-ClaudeModelSelection -Selection $usageFailureDecision.Selection
if ($unavailableLine -notmatch 'indisponivel' -or $unavailableLine -match 'compartilhado\s+%') {
    throw 'Unavailable quota percentages must have an explicit panel label.'
}

$low = ConvertFrom-ClaudeUsageText -Text ($sample -replace '44% used', '85% used')
if ($low.AlertLevel -ne 'warning') { throw 'Low Fable balance must produce a warning.' }

$warningBoundary = ConvertFrom-ClaudeUsageText -Text ($sample -replace '44% used', '80% used')
if ($warningBoundary.AlertLevel -ne 'warning') { throw 'Twenty percent remaining must produce a warning.' }

$criticalBoundary = ConvertFrom-ClaudeUsageText -Text ($sample -replace '44% used', '95% used')
if ($criticalBoundary.AlertLevel -ne 'critical') { throw 'Five percent remaining must produce a critical alert.' }

$invalidRejected = $false
try {
    ConvertFrom-ClaudeUsageText -Text 'incomplete usage response' | Out-Null
} catch {
    $invalidRejected = $true
}
if (-not $invalidRejected) { throw 'Incomplete usage text must be rejected.' }

$distinctSample = @'
Current session: 10% used · resets Sep 6, 9:19pm (America/Sao_Paulo)
Current week (all models): 23% used · resets Sep 10, 8:59pm (America/Sao_Paulo)
Current week (Fable): 44% used · resets Sep 11, 7:00pm (America/Sao_Paulo)
'@
$distinctResets = ConvertFrom-ClaudeUsageText -Text $distinctSample
$lines = Format-ClaudeUsageSnapshot -Usage $distinctResets
if ($lines.Count -ne 2) { throw 'Usage display must contain limits and resets lines.' }
if ($lines[1] -notmatch 'sessao:' -or $lines[1] -notmatch 'semana:' -or $lines[1] -notmatch 'Fable:') { throw 'Each reset must have its own label.' }

Write-Output 'claude usage tests passed'
