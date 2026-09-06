#requires -Version 7.0
param([string]$BundlePath = (Split-Path $PSScriptRoot -Parent))
$ErrorActionPreference = 'Stop'
$bundle = (Resolve-Path -LiteralPath $BundlePath).Path
$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
$python = @(
    (Get-Command python -ErrorAction SilentlyContinue).Source,
    (Get-Command py -ErrorAction SilentlyContinue).Source,
    (Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe')
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if (-not $python) { throw 'Python 3 was not found. Install Python 3 or use the Codex runtime.' }
$pluginValidator = Join-Path $codexHome 'skills\.system\plugin-creator\scripts\validate_plugin.py'
$skillValidator = Join-Path $codexHome 'skills\.system\skill-creator\scripts\quick_validate.py'
foreach ($required in @($pluginValidator, $skillValidator)) { if (-not (Test-Path -LiteralPath $required)) { throw "Codex validator not found: $required" } }
$previousPythonPath = $env:PYTHONPATH
$env:PYTHONPATH = Join-Path $PSScriptRoot 'validator_shim'
try {
    & $python $pluginValidator $bundle
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & $python $skillValidator (Join-Path $bundle 'skills\claude-code-live')
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    $parseErrors = @()
    Get-ChildItem -LiteralPath (Join-Path $bundle 'skills\claude-code-live\scripts') -Filter '*.ps1' -File | ForEach-Object {
        $tokens = $null; $errors = $null
        [void][System.Management.Automation.Language.Parser]::ParseFile($_.FullName, [ref]$tokens, [ref]$errors)
        $parseErrors += $errors
    }
    if ($parseErrors) { throw 'PowerShell syntax validation failed.' }
    Write-Output 'Bundle, skill, and PowerShell validation passed.'
} finally { $env:PYTHONPATH = $previousPythonPath }
