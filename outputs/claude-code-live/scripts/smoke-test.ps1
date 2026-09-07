#requires -Version 7.0
param([string]$BundlePath = (Split-Path $PSScriptRoot -Parent))
$ErrorActionPreference = 'Stop'
$bundle = (Resolve-Path -LiteralPath $BundlePath).Path
& (Join-Path $PSScriptRoot 'validate.ps1') -BundlePath $bundle
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$testsPath = Join-Path $bundle 'skills\claude-code-live\tests'
Get-ChildItem -LiteralPath $testsPath -Filter '*.tests.ps1' -File | Sort-Object Name | ForEach-Object {
    & $_.FullName
}
& claude --version
if ($LASTEXITCODE -ne 0) { throw 'Claude Code CLI is unavailable.' }
$help = (& claude --help 2>&1) -join "`n"
foreach ($option in @('--allowedTools','--permission-mode','--permission-prompts','--cloud','--background')) {
    if ($help -notmatch [regex]::Escape($option)) { throw "Claude Code does not advertise required option: $option" }
}
& claude --cloud 'compatibility check' --bg 2>&1 | Select-String -Quiet 'different backends' | Out-Null
if ($LASTEXITCODE -eq 0) { Write-Output 'Cloud and local-background flows are intentionally distinct.' }
& claude agents --help | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Claude Code background-agent help check failed.' }
Write-Output 'Non-authenticated smoke test passed; no Claude session or cloud task was started.'
