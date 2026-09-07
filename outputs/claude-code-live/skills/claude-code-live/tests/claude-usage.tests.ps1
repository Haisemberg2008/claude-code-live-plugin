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
