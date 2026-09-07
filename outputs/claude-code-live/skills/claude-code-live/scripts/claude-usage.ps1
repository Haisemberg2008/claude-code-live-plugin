#requires -Version 7.0
function ConvertFrom-ClaudeUsageText {
    param([Parameter(Mandatory)][string]$Text)

    function Read-Limit([string]$Label) {
        $pattern = '(?im)^' + [regex]::Escape($Label) + ':\s*(\d{1,3})% used.*?resets\s+(.+)$'
        $match = [regex]::Match($Text, $pattern)
        if (-not $match.Success) { throw ('Usage field not found: ' + $Label) }
        $used = [int]$match.Groups[1].Value
        if ($used -lt 0 -or $used -gt 100) { throw ('Invalid usage percent: ' + $Label) }
        [pscustomobject]@{
            UsedPercent = $used
            RemainingPercent = 100 - $used
            Resets = $match.Groups[2].Value.Trim()
        }
    }

    $session = Read-Limit 'Current session'
    $allModels = Read-Limit 'Current week (all models)'
    $fable = Read-Limit 'Current week (Fable)'
    $minimum = @($session.RemainingPercent, $allModels.RemainingPercent, $fable.RemainingPercent) |
        Measure-Object -Minimum | Select-Object -ExpandProperty Minimum
    $alert = if ($minimum -le 5) { 'critical' } elseif ($minimum -le 20) { 'warning' } else { 'ok' }

    [pscustomobject]@{
        Session = $session
        AllModels = $allModels
        Fable = $fable
        AlertLevel = $alert
    }
}

function Format-ClaudeUsageSnapshot {
    param([Parameter(Mandatory)]$Usage)

    @(
        '[Uso] Restante - sessao: ' + $Usage.Session.RemainingPercent + '% | semana: ' + $Usage.AllModels.RemainingPercent + '% | Fable: ' + $Usage.Fable.RemainingPercent + '%'
        '[Uso] Renovacao - sessao: ' + $Usage.Session.Resets + ' | semana: ' + $Usage.AllModels.Resets + ' | Fable: ' + $Usage.Fable.Resets
    )
}

function Get-ClaudeUsageSnapshot {
    param([int]$TimeoutSeconds = 20)

    $launcher = (Get-Command claude -ErrorAction Stop).Source
    $binary = if ($launcher.EndsWith('.exe')) { $launcher } else {
        Join-Path (Split-Path $launcher) 'node_modules/@anthropic-ai/claude-code/bin/claude.exe'
    }
    if (-not (Test-Path -LiteralPath $binary)) { throw 'Claude executable not found.' }

    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $binary
    $start.UseShellExecute = $false
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.CreateNoWindow = $true
    foreach ($argument in @('--safe-mode','--tools','','--permission-mode','dontAsk','--permission-prompts','none','--output-format','json','-p','/usage')) {
        $start.ArgumentList.Add([string]$argument)
    }

    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $start
    try {
        if (-not $process.Start()) { throw 'Could not start Claude usage query.' }
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            $process.Kill($true)
            throw 'Claude usage query timed out.'
        }
        $process.WaitForExit()
        $null = $stderr.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0) { throw 'Claude usage query failed.' }
        $payload = $stdout.GetAwaiter().GetResult() | ConvertFrom-Json -ErrorAction Stop
        ConvertFrom-ClaudeUsageText -Text ([string]$payload.result)
    } finally {
        if (-not $process.HasExited) { $process.Kill($true) }
        $process.Dispose()
    }
}
