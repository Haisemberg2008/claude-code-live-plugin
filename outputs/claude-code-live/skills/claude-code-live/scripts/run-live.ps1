#requires -Version 7.0
param(
    [Parameter(Mandatory)][string]$JobFile,
    [Parameter(Mandatory)][string]$RunDirectory,
    [Parameter(Mandatory)][string]$ThreadId,
    [string]$PreviousResultFile,
    [Parameter(Mandatory)][string]$SessionPointerFile,
    [string]$TestAdapter
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'claude-live-contract.ps1')
. (Join-Path $PSScriptRoot 'claude-usage.ps1')
. (Join-Path $PSScriptRoot 'claude-thread-context.ps1')
$Host.UI.RawUI.WindowTitle = 'Claude Code | Acompanhamento ao vivo'
$runPath = [IO.Path]::GetFullPath($RunDirectory)
if (Test-Path -LiteralPath $runPath) { throw 'Use a new run directory.' }
[IO.Directory]::CreateDirectory($runPath) | Out-Null
$logPath = Join-Path $runPath 'acompanhamento.txt'
$statusPath = Join-Path $runPath 'status.json'
$resultPath = Join-Path $runPath 'resultado.json'
$stopPath = Join-Path $runPath 'stop.request'
$started = $false
$sessionConfirmed = $false
$process = $null
$clock = [Diagnostics.Stopwatch]::StartNew()
$runtimeClock = $null
$seenTools = [Collections.Generic.List[string]]::new()
$startedAt = [DateTimeOffset]::UtcNow.ToString('o')
$record = [ordered]@{ status='STARTING'; codexThreadId=$ThreadId; startedAt=$startedAt; sessionId=$null; result=$null; exitCode=$null; elapsedSeconds=0; toolCalls=@() }
$binaryArguments = @()
$usageProvider = { Get-ClaudeUsageSnapshot }
$quotaWaitMilliseconds = 30000
function Show-Line([string]$Text) {
    Write-Host $Text
    Add-Content -LiteralPath $logPath -Value $Text -Encoding utf8
}
function Write-State($Value, [string]$Path) {
    $temp = $Path + '.tmp'
    $Value | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $temp -Encoding utf8
    [IO.File]::Move($temp, $Path, $true)
}
Write-State $record $statusPath
try {
    $preparationStage = 'contract'
    $job = Get-Content -LiteralPath $JobFile -Raw -Encoding utf8 | ConvertFrom-Json
    $contract = Resolve-ClaudeLiveContract -Job $job
    $workspace = (Resolve-Path -LiteralPath $job.workspace).Path
    $promptText = Get-Content -LiteralPath $job.promptFile -Raw -Encoding utf8
    $mode = $contract.Mode
    $profile = $contract.Profile
    $resumeId = $null
    $resumeMode = 'new'
    $preparationStage = 'resume'
    if ($job.resumeFrom) {
        $prior = Get-Content -LiteralPath $job.resumeFrom -Raw -Encoding utf8 | ConvertFrom-Json
        if (-not $prior.sessionId -or $prior.workspace -ne $workspace) { throw 'Resume requires a session in the same workspace.' }
        if (-not $prior.coordination) { throw 'A legacy result without coordination cannot be resumed.' }
        Assert-ClaudeLiveResumeThreadIdentity -CurrentThreadId $ThreadId -PriorResult $prior
        Assert-ClaudeLiveResumeCommands -CurrentContract $contract -PriorResult $prior
        Assert-ClaudeLiveResumeCoordination -Current $contract.Coordination -Prior $prior.coordination `
            -CurrentModelPolicy $contract.ModelPolicy -PriorModelPolicy $prior.modelPolicy
        $resumeId = $prior.sessionId
        $resumeMode = 'explicit'
    } elseif ($PreviousResultFile -and (Test-Path -LiteralPath $PreviousResultFile)) {
        try {
            $prior = Get-Content -LiteralPath $PreviousResultFile -Raw -Encoding utf8 | ConvertFrom-Json
            if (Test-ClaudeLiveAutomaticResume -CurrentContract $contract -Workspace $workspace -ThreadId $ThreadId -PriorResult $prior) {
                $resumeId = $prior.sessionId
                $resumeMode = 'automatic'
            }
        } catch { }
    }
    $timeoutPolicy = $contract.TimeoutPolicy
    $preparationStage = 'cli-resolution'
    if ($TestAdapter) { . (Resolve-Path -LiteralPath $TestAdapter).Path }
    if (-not $TestAdapter) {
        $launcher = (Get-Command claude -ErrorAction Stop).Source
        $binary = if ($launcher.EndsWith('.exe')) { $launcher } else {
            Join-Path (Split-Path $launcher) 'node_modules/@anthropic-ai/claude-code/bin/claude.exe'
        }
    }
    if (-not (Test-Path -LiteralPath $binary)) { throw 'Claude executable not found; inspect installation.' }

    $quotaMutex = [Threading.Mutex]::new($false, (Get-ClaudeLiveMutexName -Kind Quota))
    $quotaLockHeld = $false
    try {
        $preparationStage = 'usage-lock'
        try { $quotaLockHeld = $quotaMutex.WaitOne($quotaWaitMilliseconds) } catch [Threading.AbandonedMutexException] { $quotaLockHeld = $true }
        if (-not $quotaLockHeld) { throw 'Timed out waiting for the global Claude usage check.' }
        $preparationStage = 'usage-query'
        $modelDecision = Resolve-ClaudeModelDecision -RequestedModel $contract.Model -ModelPolicy $contract.ModelPolicy -UsageProvider $usageProvider
    } finally {
        if ($quotaLockHeld) { $quotaMutex.ReleaseMutex() }
        $quotaMutex.Dispose()
    }
    $usageCheckedAt = [DateTimeOffset]::UtcNow.ToString('o')
    $usageSnapshot = $modelDecision.Usage
    Show-Line ('[Uso] Consulta na preparacao: ' + $usageCheckedAt + ' | nao e monitoramento continuo.')
    if ($null -ne $usageSnapshot) {
        foreach ($usageLine in (Format-ClaudeUsageSnapshot -Usage $usageSnapshot)) { Show-Line $usageLine }
        if ($usageSnapshot.AlertLevel -ne 'ok') {
            Show-Line ('[Uso] ALERTA ' + $usageSnapshot.AlertLevel.ToUpperInvariant() + ': confirme a capacidade antes de iniciar trabalho longo.')
        }
    } else {
        Show-Line ('[Uso] INDISPONIVEL: ' + $modelDecision.PublicMessage)
    }
    if ($null -ne $modelDecision.Selection) {
        Show-Line (Format-ClaudeModelSelection -Selection $modelDecision.Selection)
    }
    $effectiveModel = $modelDecision.EffectiveModel
    $toolConfiguration = Get-ClaudeLiveToolConfiguration -Contract $contract
    $tools = $toolConfiguration.Tools
    $allowed = $toolConfiguration.Allowed
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $binary
    foreach ($prefixArgument in $binaryArguments) { $start.ArgumentList.Add([string]$prefixArgument) }
    $start.WorkingDirectory = $workspace
    $start.UseShellExecute = $false
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.RedirectStandardInput = $true
    $start.StandardOutputEncoding = [Text.Encoding]::UTF8
    $start.StandardErrorEncoding = [Text.Encoding]::UTF8
    $start.StandardInputEncoding = [Text.UTF8Encoding]::new($false)
    $start.CreateNoWindow = $true
    foreach ($argValue in @('--safe-mode','--tools',($tools -join ','),'--permission-mode','dontAsk','--permission-prompts','none','--output-format','stream-json','--verbose','--include-partial-messages','-p')) {
        $start.ArgumentList.Add([string]$argValue)
    }
    if ($profile -eq 'restricted') {
        foreach ($argValue in @('--restricted','--strict-mcp-config')) { $start.ArgumentList.Add([string]$argValue) }
    }
    if ($allowed.Count) {
        $start.ArgumentList.Add('--allowedTools')
        foreach ($rule in $allowed) { $start.ArgumentList.Add($rule) }
    }
    if ($resumeId) { $start.ArgumentList.Add('--resume'); $start.ArgumentList.Add($resumeId) }
    $start.ArgumentList.Add('--model')
    if ($effectiveModel) { $start.ArgumentList.Add([string]$effectiveModel) }
    $start.ArgumentList.Add('--effort')
    $start.ArgumentList.Add($contract.Effort)
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $start
    $started = $false
    $finalReceived = $false
    $record = [ordered]@{
        startedAt = $startedAt; usageCheckedAt = $usageCheckedAt
        allowedCommands = @(ConvertTo-ClaudeLiveCommandRecord $contract.AllowedCommands)
        status = 'STARTING'; workspace = $workspace; sessionId = $resumeId; codexThreadId = $ThreadId; resumeMode = $resumeMode
        requestedModel = $contract.Model; selectedModel = $effectiveModel; model = $null; effort = $contract.Effort; mode = $mode; profile = $profile; monitorPid = $PID; processId = $null; processStartedTicks = $null
        modelPolicy = if ($null -ne $contract.ModelPolicy) {
            [ordered]@{
                mode = $contract.ModelPolicy.Mode
                primary = $contract.ModelPolicy.Primary
                alternate = $contract.ModelPolicy.Alternate
                switchAtRemainingPercent = $contract.ModelPolicy.SwitchAtRemainingPercent
            }
        } else { $null }
        modelSelection = if ($null -ne $modelDecision.Selection) { ConvertTo-ClaudeModelSelectionRecord -Selection $modelDecision.Selection } else { $null }
        coordination = [ordered]@{
            phase = $contract.Coordination.Phase
            scopeId = $contract.Coordination.ScopeId
            approvalRevision = $contract.Coordination.ApprovalRevision
            planSummary = $contract.Coordination.PlanSummary
            planApproved = $contract.Coordination.PlanApproved
            responsibilities = $contract.Coordination.Responsibilities
        }
        timeoutPolicy = if ($timeoutPolicy.Mode -eq 'fixed') {
            [ordered]@{ mode = 'fixed'; timeoutSeconds = $timeoutPolicy.TimeoutSeconds }
        } else {
            [ordered]@{
                mode = 'adaptive'
                renewEverySeconds = $timeoutPolicy.RenewEverySeconds
                idleAfterSeconds = $timeoutPolicy.IdleAfterSeconds
                hardStopAfterSeconds = $timeoutPolicy.HardStopAfterSeconds
            }
        }
        processStartedAt = $null; lastActivityAt = $null; nextRenewalAt = $null
        extensionCount = 0; timeoutReason = $null; runtimeSeconds = 0
        result = $null; usage = $usageSnapshot; toolCalls = @(); toolErrors = 0; permissionDenials = 0
        exitCode = $null; elapsedSeconds = 0
    }
    Show-Line 'CLAUDE CODE - ACOMPANHAMENTO AO VIVO'
    Show-Line 'Q no painel solicita parada; Ctrl+C no terminal executor interrompe. Resultados ficam preservados.'
    Show-Line ('Modo: ' + $mode + ' | Perfil: ' + $profile + ' | Ferramentas e comandos limitados ao job aprovado.')
    Show-Line ('Coordenacao: ' + $contract.Coordination.Phase + ' | Escopo: ' + $contract.Coordination.ScopeId + ' | Revisao aprovada: ' + $contract.Coordination.ApprovalRevision)
    Show-Line ('Tarefa Codex: ' + $ThreadId + ' | Sessao Claude: ' + $resumeMode)
    if ($contract.Coordination.PlanSummary) { Show-Line ('Plano: ' + $contract.Coordination.PlanSummary) }
    $ownerPairs = @('planning','inspection','implementation','testing','review','commit','push','deploy') | ForEach-Object {
        $_ + '=' + $contract.Coordination.Responsibilities.$_
    }
    Show-Line ('Responsaveis: ' + ($ownerPairs -join '; '))
    Show-Line 'Use apenas arquivos autorizados e sem segredos. Isto nao e um sandbox de sistema operacional.'
    Show-Line ''
    if ($modelDecision.Blocked) {
        $record.status = 'BLOCKED'
        $record.result = $modelDecision.PublicMessage
        Write-State $record $resultPath
        Write-State $record $statusPath
        Show-Line ('[BLOCKED] ' + $modelDecision.PublicMessage)
        Show-Line '[Encerrado] BLOCKED'
        throw 'Model capacity blocked.'
    }
    $preparationStage = 'process-start'
    if (-not $process.Start()) { throw 'Could not start Claude.' }
    $started = $true
    $preparationStage = 'stream'
    $record.processId = $process.Id
    $record.processStartedTicks = $process.StartTime.ToUniversalTime().Ticks
    $processStarted = [DateTimeOffset]::UtcNow
    $runtimeClock = [Diagnostics.Stopwatch]::StartNew()
    $lastActivityElapsed = 0.0
    $lastActivityStateWriteElapsed = 0.0
    $record.processStartedAt = $processStarted.ToString('o')
    $record.lastActivityAt = $record.processStartedAt
    if ($timeoutPolicy.Mode -eq 'adaptive') {
        $nextRenewalElapsed = [double]$timeoutPolicy.RenewEverySeconds
        $record.nextRenewalAt = $processStarted.AddSeconds($nextRenewalElapsed).ToString('o')
        Show-Line ('[Tempo] Adaptativo: renovar a cada ' + $timeoutPolicy.RenewEverySeconds + 's com atividade; inatividade ' + $timeoutPolicy.IdleAfterSeconds + 's; teto ' + $timeoutPolicy.HardStopAfterSeconds + 's.')
    } else {
        Show-Line ('[Tempo] Fixo: limite de ' + $timeoutPolicy.TimeoutSeconds + 's de execucao do Claude.')
    }
    $record.status = 'RUNNING'
    Write-State $record $statusPath
    $errorRead = $process.StandardError.ReadToEndAsync()
    $process.StandardInput.Write($promptText)
    $process.StandardInput.Close()
    $lineTask = $process.StandardOutput.ReadLineAsync()
    while ($true) {
        $stopRequested = Test-Path -LiteralPath $stopPath
        try {
            if (-not [Console]::IsInputRedirected -and [Console]::KeyAvailable) {
                $key = [Console]::ReadKey($true)
                if ($key.Key -eq 'Q') { $stopRequested = $true }
            }
        } catch { }
        if ($stopRequested) { $record.status = 'CANCELLED'; break }
        $runtimeSeconds = $runtimeClock.Elapsed.TotalSeconds
        if ($timeoutPolicy.Mode -eq 'fixed') {
            if ($runtimeSeconds -ge $timeoutPolicy.TimeoutSeconds) {
                $record.status = 'TIMEOUT'
                $record.timeoutReason = 'fixed_limit'
                $record.result = 'A sessao atingiu o limite fixo de execucao antes da conclusao.'
                Show-Line ('[Tempo] Limite fixo de ' + $timeoutPolicy.TimeoutSeconds + 's atingido; sessao preservada para revisao.')
                break
            }
        } else {
            if ($runtimeSeconds -ge $timeoutPolicy.HardStopAfterSeconds) {
                $record.status = 'TIMEOUT'
                $record.timeoutReason = 'hard_limit'
                $record.result = 'A sessao atingiu o teto absoluto antes da conclusao; revise antes de retomar.'
                Show-Line ('[Tempo] Teto absoluto de ' + $timeoutPolicy.HardStopAfterSeconds + 's atingido; revise antes de retomar.')
                break
            }
            if (($runtimeSeconds - $lastActivityElapsed) -ge $timeoutPolicy.IdleAfterSeconds) {
                $record.status = 'TIMEOUT'
                $record.timeoutReason = 'inactivity'
                $record.result = 'A sessao ficou sem eventos validos ate o limite de inatividade; revise antes de retomar.'
                Show-Line ('[Tempo] Sem atividade por ' + $timeoutPolicy.IdleAfterSeconds + 's; sessao preservada para revisao.')
                break
            }
            if ($runtimeSeconds -ge $nextRenewalElapsed) {
                do {
                    $record.extensionCount++
                    $nextRenewalElapsed += $timeoutPolicy.RenewEverySeconds
                } while ($runtimeSeconds -ge $nextRenewalElapsed -and $nextRenewalElapsed -lt $timeoutPolicy.HardStopAfterSeconds)
                $nextRenewalElapsed = [math]::Min($nextRenewalElapsed, $timeoutPolicy.HardStopAfterSeconds)
                $record.nextRenewalAt = $processStarted.AddSeconds($nextRenewalElapsed).ToString('o')
                Show-Line ('[Tempo] Sessao ativa; prazo renovado. Renovacoes: ' + $record.extensionCount + '.')
                Write-State $record $statusPath
            }
        }
        if (-not $lineTask.Wait(200)) { continue }
        $line = $lineTask.GetAwaiter().GetResult()
        if ($null -eq $line) { break }
        $lineTask = $process.StandardOutput.ReadLineAsync()
        try { $event = $line | ConvertFrom-Json -ErrorAction Stop } catch { continue }
        $lastActivityElapsed = $runtimeClock.Elapsed.TotalSeconds
        $record.lastActivityAt = [DateTimeOffset]::UtcNow.ToString('o')
        if (($lastActivityElapsed - $lastActivityStateWriteElapsed) -ge 1) {
            Write-State $record $statusPath
            $lastActivityStateWriteElapsed = $lastActivityElapsed
        }
        switch ($event.type) {
            'system' {
                if ($event.subtype -eq 'init') {
                    $record.sessionId = $event.session_id
                    $sessionConfirmed = -not [string]::IsNullOrWhiteSpace([string]$event.session_id)
                    $record.model = $event.model
                    Show-Line ('[Conectado] Modelo: ' + $event.model)
                    Write-State $record $statusPath
                }
            }
            'stream_event' {
                if ($event.event.type -eq 'content_block_delta' -and $event.event.delta.type -eq 'text_delta') {
                    $chunk = [string]$event.event.delta.text
                    Write-Host -NoNewline $chunk
                    [IO.File]::AppendAllText($logPath, $chunk, [Text.Encoding]::UTF8)
                }
                if ($event.event.type -eq 'content_block_stop') { Show-Line '' }
            }
            'assistant' {
                foreach ($part in $event.message.content) {
                    if ($part.type -eq 'tool_use') {
                        $seenTools.Add([string]$part.name)
                        Show-Line ('[Ferramenta] ' + $part.name)
                    }
                }
                $record.toolCalls = @($seenTools.ToArray())
                Write-State $record $statusPath
            }
            'user' {
                foreach ($part in $event.message.content) {
                    if ($part.type -eq 'tool_result' -and $part.is_error) {
                        $record.toolErrors++
                        Show-Line '[Ferramenta] Falha reportada; conferir resultado antes de aprovar.'
                    }
                }
            }
            'result' {
                $finalReceived = $true
                $record.result = $event.result
                if ($event.session_id) { $record.sessionId = $event.session_id; $sessionConfirmed = $true }
                $record.permissionDenials = @($event.permission_denials | Where-Object { $_ }).Count
                $record.status = if ($record.permissionDenials) { 'BLOCKED' } elseif ($event.is_error) { 'FAIL' } else { 'COMPLETED' }
            }
        }
    }
    if ($record.status -in @('CANCELLED','TIMEOUT')) {
        if (-not $process.HasExited) { $process.Kill($true) }
    }
    if (-not $process.WaitForExit(5000)) {
        $process.Kill($true)
        $record.status = 'FAIL'
    }
    $process.WaitForExit()
    $record.exitCode = $process.ExitCode
    # Consume but never persist raw stderr.
    $null = $errorRead.GetAwaiter().GetResult()
    if ($record.status -notin @('CANCELLED','TIMEOUT','BLOCKED') -and ($process.ExitCode -ne 0 -or -not $finalReceived)) {
        $record.status = 'FAIL'
    }
} catch {
    $record.failureStage = $preparationStage
    if ($record.status -ne 'BLOCKED') { $record.status = 'FAIL'; $record.result = 'Falha na preparacao ou execucao; consulte o estado sanitizado.' }
    if ($record.status -eq 'FAIL') { Show-Line ('[FAIL] Etapa: ' + $preparationStage + '. Detalhes brutos suprimidos.') }
} finally {
    if ($started -and -not $process.HasExited) {
        $process.Kill($true)
        $process.WaitForExit(5000) | Out-Null
    }
    if ($record.status -in @('STARTING','RUNNING')) { $record.status = 'CANCELLED' }
    $record.elapsedSeconds = [math]::Round($clock.Elapsed.TotalSeconds, 1)
    if ($null -ne $runtimeClock) { $record.runtimeSeconds = [math]::Round($runtimeClock.Elapsed.TotalSeconds, 1) }
    $record.toolCalls = @($seenTools.ToArray())
    Write-State $record $resultPath
    Write-State $record $statusPath
    if ($sessionConfirmed) { Write-ClaudeLiveSessionPointer -PointerFile $SessionPointerFile -ResultFile $resultPath }
    if ($null -ne $process) { $process.Dispose() }
}
Show-Line ('[Encerrado] ' + $record.status)
Show-Line 'COMPLETED confirma o fim da execucao; a aprovacao depende da revisao dos artefatos.'
if ($record.status -ne 'COMPLETED') { exit 1 }
