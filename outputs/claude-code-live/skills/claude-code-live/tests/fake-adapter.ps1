$binary = (Get-Command pwsh).Source
$binaryArguments = @('-NoProfile','-File',(Join-Path $PSScriptRoot 'fake-cli.ps1'))
if ($env:CLAUDE_LIVE_TEST_FAILURE -eq 'start') {
    $binary = (Get-Command pwsh).Source
    # Existing directory passes the path check but cannot launch as an executable.
    $binary = Split-Path $binary
}
if ($env:CLAUDE_LIVE_TEST_FAILURE -eq 'mutex') { $quotaWaitMilliseconds = 50 }
$usageProvider = {
    if ($env:CLAUDE_LIVE_TEST_FAILURE -eq 'usage') { throw 'Simulated usage failure' }
    $lockPath = Join-Path $env:CLAUDE_LIVE_TEST_ROOT 'usage.lock'
    $lease = [IO.File]::Open($lockPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $usageDelay = if ($env:CLAUDE_LIVE_TEST_USAGE_DELAY) { [int]$env:CLAUDE_LIVE_TEST_USAGE_DELAY } else { 150 }
        Start-Sleep -Milliseconds $usageDelay
        ConvertFrom-ClaudeUsageText -Text "Current session: 10% used resets tomorrow`nCurrent week (all models): 20% used resets tomorrow`nCurrent week (Fable): 25% used resets tomorrow"
    } finally { $lease.Dispose(); [IO.File]::Delete($lockPath) }
}
