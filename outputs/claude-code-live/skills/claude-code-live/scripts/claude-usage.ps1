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

function Select-ClaudeModelForUsage {
    param(
        [Parameter(Mandatory)]$Usage,
        [Parameter(Mandatory)]$ModelPolicy
    )

    $threshold = [int]$ModelPolicy.SwitchAtRemainingPercent
    $sharedRemaining = [math]::Min(
        [int]$Usage.Session.RemainingPercent,
        [int]$Usage.AllModels.RemainingPercent
    )
    $fableRemaining = [math]::Min($sharedRemaining, [int]$Usage.Fable.RemainingPercent)
    $blocked = $sharedRemaining -le $threshold
    $effectiveModel = if ($blocked) {
        $null
    } elseif ($fableRemaining -le $threshold) {
        [string]$ModelPolicy.Alternate
    } else {
        [string]$ModelPolicy.Primary
    }
    $reason = if ($blocked) {
        'shared_capacity_at_or_below_threshold'
    } elseif ($fableRemaining -le $threshold) {
        'primary_at_or_below_threshold'
    } else {
        'primary_has_capacity'
    }

    [pscustomobject][ordered]@{
        Mode = [string]$ModelPolicy.Mode
        RequestedModel = [string]$ModelPolicy.Primary
        EffectiveModel = $effectiveModel
        AlternateModel = [string]$ModelPolicy.Alternate
        SwitchAtRemainingPercent = $threshold
        SharedRemainingPercent = $sharedRemaining
        FableRemainingPercent = $fableRemaining
        Blocked = $blocked
        Reason = $reason
    }
}

function Resolve-ClaudeModelDecision {
    param(
        [Parameter(Mandatory)][string]$RequestedModel,
        $ModelPolicy = $null,
        [scriptblock]$UsageProvider = { Get-ClaudeUsageSnapshot }
    )

    try {
        $usage = & $UsageProvider
    } catch {
        if ($null -ne $ModelPolicy) {
            $selection = [pscustomobject][ordered]@{
                Mode = [string]$ModelPolicy.Mode
                RequestedModel = [string]$ModelPolicy.Primary
                EffectiveModel = $null
                AlternateModel = [string]$ModelPolicy.Alternate
                SwitchAtRemainingPercent = [int]$ModelPolicy.SwitchAtRemainingPercent
                SharedRemainingPercent = $null
                FableRemainingPercent = $null
                Blocked = $true
                Reason = 'usage_unavailable'
            }
            return [pscustomobject][ordered]@{
                Usage = $null
                Selection = $selection
                EffectiveModel = $null
                Blocked = $true
                Reason = 'usage_unavailable'
                PublicMessage = 'Limites de uso nao puderam ser confirmados; o job quota-aware foi bloqueado antes de iniciar o Claude.'
            }
        }
        return [pscustomobject][ordered]@{
            Usage = $null
            Selection = $null
            EffectiveModel = $RequestedModel
            Blocked = $false
            Reason = 'fixed_model_usage_unavailable'
            PublicMessage = 'Limites de uso nao confirmados; o modelo fixo foi preservado e nenhuma troca foi feita.'
        }
    }

    $selection = if ($null -ne $ModelPolicy) {
        Select-ClaudeModelForUsage -Usage $usage -ModelPolicy $ModelPolicy
    } else {
        $null
    }
    [pscustomobject][ordered]@{
        Usage = $usage
        Selection = $selection
        EffectiveModel = if ($null -ne $selection) { $selection.EffectiveModel } else { $RequestedModel }
        Blocked = if ($null -ne $selection) { $selection.Blocked } else { $false }
        Reason = if ($null -ne $selection) { $selection.Reason } else { 'fixed_model' }
        PublicMessage = if ($null -ne $selection -and $selection.Blocked) {
            'A capacidade compartilhada da sessao ou da semana geral atingiu o limite configurado; nenhum modelo foi iniciado.'
        } else { $null }
    }
}

function ConvertTo-ClaudeModelSelectionRecord {
    param([Parameter(Mandatory)]$Selection)
    [ordered]@{
        mode = $Selection.Mode
        requestedModel = $Selection.RequestedModel
        effectiveModel = $Selection.EffectiveModel
        alternateModel = $Selection.AlternateModel
        switchAtRemainingPercent = $Selection.SwitchAtRemainingPercent
        sharedRemainingPercent = $Selection.SharedRemainingPercent
        fableRemainingPercent = $Selection.FableRemainingPercent
        blocked = $Selection.Blocked
        reason = $Selection.Reason
    }
}

function Format-ClaudeModelSelection {
    param([Parameter(Mandatory)]$Selection)
    $effective = if ($Selection.EffectiveModel) { $Selection.EffectiveModel } else { 'BLOCKED' }
    $shared = if ($null -eq $Selection.SharedRemainingPercent) { 'indisponivel' } else { $Selection.SharedRemainingPercent.ToString() + '%' }
    $fable = if ($null -eq $Selection.FableRemainingPercent) { 'indisponivel' } else { $Selection.FableRemainingPercent.ToString() + '%' }
    '[Modelo] quota-aware: solicitado ' + $Selection.RequestedModel + ' | efetivo ' + $effective +
        ' | compartilhado ' + $shared + ' | Fable efetivo ' + $fable +
        ' | limite ' + $Selection.SwitchAtRemainingPercent + '% | motivo ' + $Selection.Reason
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
