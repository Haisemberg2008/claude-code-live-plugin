#requires -Version 7.0
param(
    [Parameter(Mandatory)][string]$JobFile,
    [Parameter(Mandatory)][string]$RunDirectory
)
$ErrorActionPreference = 'Stop'
$Host.UI.RawUI.WindowTitle = 'Claude Code | Acompanhamento ao vivo'
$job = Get-Content -LiteralPath $JobFile -Raw -Encoding utf8 | ConvertFrom-Json
$workspace = (Resolve-Path -LiteralPath $job.workspace).Path
$promptText = Get-Content -LiteralPath $job.promptFile -Raw -Encoding utf8
$mode = [string]$job.mode
if ($mode -notin @('chat','read','local')) { throw 'Mode must be chat, read or local.' }
$profile = if ($job.profile) { [string]$job.profile } else { 'diagnostic' }
if ($profile -notin @('diagnostic','restricted')) { throw 'Profile must be diagnostic or restricted.' }
$runPath = [IO.Path]::GetFullPath($RunDirectory)
if (Test-Path -LiteralPath $runPath) { throw 'Use a new run directory.' }
$resumeId = $null
if ($job.resumeFrom) {
    $prior = Get-Content -LiteralPath $job.resumeFrom -Raw -Encoding utf8 | ConvertFrom-Json
    if (-not $prior.sessionId -or $prior.workspace -ne $workspace) { throw 'Resume requires a session in the same workspace.' }
    $resumeId = $prior.sessionId
}
$commands = @($job.allowedCommands | Where-Object { $_ })
foreach ($rule in $commands) {
    if ($mode -ne 'local' -or $rule -notmatch '^Bash\([^*\r\n]+\)$' -or $rule -match '[:*]') {
        throw 'Only explicit Bash command rules without wildcards are allowed in local mode.'
    }
}
$timeoutSeconds = if ($job.timeoutSeconds) { [int]$job.timeoutSeconds } else { 1800 }
if ($timeoutSeconds -lt 1) { throw 'Invalid timeout.' }
$launcher = (Get-Command claude -ErrorAction Stop).Source
$binary = if ($launcher.EndsWith('.exe')) { $launcher } else {
    Join-Path (Split-Path $launcher) 'node_modules/@anthropic-ai/claude-code/bin/claude.exe'
}
if (-not (Test-Path -LiteralPath $binary)) { throw 'Claude executable not found; inspect installation.' }
function Test-ClaudeCompatibility {
    $help = (& $binary --help 2>&1) -join "`n"
    foreach ($option in @('--allowedTools','--permission-mode','--permission-prompts','--output-format')) {
        if ($help -notmatch [regex]::Escape($option)) { throw "Installed Claude Code does not support required option: $option" }
    }
    foreach ($arguments in @(@('--tools','Read','--version'), @('--safe-mode','--version'), @('--restricted','--version'), @('--strict-mcp-config','--version'))) {
        & $binary @arguments | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Installed Claude Code does not support required option: $($arguments[0])" }
    }
}
Test-ClaudeCompatibility
[IO.Directory]::CreateDirectory($runPath) | Out-Null
$logPath = Join-Path $runPath 'acompanhamento.txt'
$statusPath = Join-Path $runPath 'status.json'
$resultPath = Join-Path $runPath 'resultado.json'
$stopPath = Join-Path $runPath 'stop.request'
function Show-Line([string]$Text) {
    Write-Host $Text
    Add-Content -LiteralPath $logPath -Value $Text -Encoding utf8
}
function Write-State($Value, [string]$Path) {
    $temp = $Path + '.tmp'
    $Value | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $temp -Encoding utf8
    [IO.File]::Move($temp, $Path, $true)
}
$tools = switch ($mode) {
    'chat' { @() }
    'read' { @('Read','Glob','Grep') }
    'local' { @('Read','Glob','Grep','Write','Edit'); if ($commands.Count) { 'Bash' } }
}
$allowed = @($tools | Where-Object { $_ -ne 'Bash' }) + $commands
$start = [Diagnostics.ProcessStartInfo]::new()
$start.FileName = $binary
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
if ($job.model) { $start.ArgumentList.Add('--model'); $start.ArgumentList.Add($job.model) }
if ($job.effort) {
    if ($job.effort -notin @('low','medium','high','xhigh','max')) { throw 'Invalid effort.' }
    $start.ArgumentList.Add('--effort'); $start.ArgumentList.Add($job.effort)
}
$process = [Diagnostics.Process]::new()
$process.StartInfo = $start
$started = $false
$finalReceived = $false
$clock = [Diagnostics.Stopwatch]::StartNew()
$seenTools = [Collections.Generic.List[string]]::new()
$record = [ordered]@{
    status = 'STARTING'; workspace = $workspace; sessionId = $resumeId
    model = $null; effort = $job.effort; mode = $mode; profile = $profile; monitorPid = $PID; processId = $null; processStartedTicks = $null
    result = $null; toolCalls = @(); toolErrors = 0; permissionDenials = 0
    exitCode = $null; elapsedSeconds = 0
}
Show-Line 'CLAUDE CODE - ACOMPANHAMENTO AO VIVO'
Show-Line 'Q no painel solicita parada; Ctrl+C no terminal executor interrompe. Resultados ficam preservados.'
Show-Line ('Modo: ' + $mode + ' | Perfil: ' + $profile + ' | Ferramentas e comandos limitados ao job aprovado.')
Show-Line 'Use apenas arquivos autorizados e sem segredos. Isto nao e um sandbox de sistema operacional.'
Show-Line ''
try {
    if (-not $process.Start()) { throw 'Could not start Claude.' }
    $started = $true
    $record.processId = $process.Id
    $record.processStartedTicks = $process.StartTime.ToUniversalTime().Ticks
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
        if ($clock.Elapsed.TotalSeconds -gt $timeoutSeconds) { $record.status = 'TIMEOUT'; break }
        if (-not $lineTask.Wait(200)) { continue }
        $line = $lineTask.GetAwaiter().GetResult()
        if ($null -eq $line) { break }
        $lineTask = $process.StandardOutput.ReadLineAsync()
        try { $event = $line | ConvertFrom-Json -ErrorAction Stop } catch { continue }
        switch ($event.type) {
            'system' {
                if ($event.subtype -eq 'init') {
                    $record.sessionId = $event.session_id
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
                if ($event.session_id) { $record.sessionId = $event.session_id }
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
    $record.status = 'FAIL'
    Show-Line '[FAIL] Falha no executor. Detalhes brutos suprimidos; diagnosticar de forma sanitizada.'
} finally {
    if ($started -and -not $process.HasExited) {
        $process.Kill($true)
        $process.WaitForExit(5000) | Out-Null
    }
    if ($record.status -in @('STARTING','RUNNING')) { $record.status = 'CANCELLED' }
    $record.elapsedSeconds = [math]::Round($clock.Elapsed.TotalSeconds, 1)
    $record.toolCalls = @($seenTools.ToArray())
    Write-State $record $resultPath
    Write-State $record $statusPath
    $process.Dispose()
}
Show-Line ('[Encerrado] ' + $record.status)
Show-Line 'COMPLETED confirma o fim da execucao; a aprovacao depende da revisao dos artefatos.'
if ($record.status -ne 'COMPLETED') { exit 1 }
