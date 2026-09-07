#requires -Version 7.0
$ErrorActionPreference = 'Stop'

$contractScript = Join-Path $PSScriptRoot '..\scripts\claude-live-contract.ps1'
if (-not (Test-Path -LiteralPath $contractScript)) {
    throw 'The Claude Live contract helper is missing.'
}
. $contractScript

$defaults = Resolve-ClaudeLiveContract -Job ([pscustomobject]@{})
if ($defaults.Model -ne 'fable') { throw 'The default Claude model must be fable.' }
if ($defaults.Effort -ne 'high') { throw 'The default effort must be high.' }

$override = Resolve-ClaudeLiveContract -Job ([pscustomobject]@{
    model = 'sonnet'
    effort = 'medium'
})
if ($override.Model -ne 'sonnet') { throw 'An explicit model override must be preserved.' }
if ($override.Effort -ne 'medium') { throw 'An explicit effort override must be preserved.' }

$invalidEffortRejected = $false
try {
    Resolve-ClaudeLiveContract -Job ([pscustomobject]@{ effort = 'invalid' }) | Out-Null
} catch {
    $invalidEffortRejected = $true
}
if (-not $invalidEffortRejected) { throw 'Invalid effort must be rejected.' }

Write-Output 'claude-live contract tests passed'
