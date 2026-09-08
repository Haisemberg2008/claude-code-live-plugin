#requires -Version 7.0
param(
    [Parameter(Mandatory)][string]$JobFile,
    [Parameter(Mandatory)][string]$RunDirectory
)
$ErrorActionPreference = 'Stop'
$jobPath = (Resolve-Path -LiteralPath $JobFile).Path
$job = Get-Content -LiteralPath $jobPath -Raw -Encoding utf8 | ConvertFrom-Json
. (Join-Path $PSScriptRoot 'claude-live-contract.ps1')
$null = Resolve-ClaudeLiveContract -Job $job
$workspace = (Resolve-Path -LiteralPath $job.workspace).Path
$runPath = [IO.Path]::GetFullPath($RunDirectory)
if (Test-Path -LiteralPath $runPath) { throw 'Use a new run directory.' }
$panelKey = 'primary'
$stateDirectory = Join-Path $env:LOCALAPPDATA ('CodexClaudeLive\' + $panelKey)
[IO.Directory]::CreateDirectory($stateDirectory) | Out-Null
$runMutex = [Threading.Mutex]::new($false, ('Local\ClaudeLiveRun-' + $panelKey))
try { $runLockHeld = $runMutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $runLockHeld = $true }
if (-not $runLockHeld) { $runMutex.Dispose(); throw 'A task is already running in this integration.' }
try {
    $pointer = Join-Path $stateDirectory 'current.json'
    [pscustomobject]@{runDirectory=$runPath} | ConvertTo-Json -Compress |
        Set-Content -LiteralPath ($pointer + '.tmp') -Encoding utf8
    [IO.File]::Move(($pointer + '.tmp'),$pointer,$true)
    $registration = Join-Path $stateDirectory 'panel.json'
    $panelAlive = $false
    if (Test-Path -LiteralPath $registration) {
        try {
            $panelInfo = Get-Content -LiteralPath $registration -Raw -Encoding utf8 | ConvertFrom-Json
            $panelProcess = Get-Process -Id $panelInfo.pid -ErrorAction Stop
            $panelAlive = $panelProcess.ProcessName -eq 'pwsh' -and $panelProcess.StartTime.ToUniversalTime().Ticks -eq $panelInfo.started
        } catch { }
    }
    if (-not $panelAlive) {
        $closeRequest = Join-Path $stateDirectory 'close-panel.request'
        if (Test-Path -LiteralPath $closeRequest) { Remove-Item -LiteralPath $closeRequest }
        $watcher = Join-Path $PSScriptRoot 'watch-live.ps1'
        foreach ($pathValue in @($watcher,$stateDirectory)) { if ($pathValue.Contains('"')) { throw 'Invalid path.' } }
        $launchArgs = @('-NoProfile','-File',('"' + $watcher + '"'),'-StateDirectory',('"' + $stateDirectory + '"'),'-PanelKey',$panelKey)
        $panelProcess = Start-Process -FilePath (Get-Command pwsh).Source -ArgumentList $launchArgs -WindowStyle Normal -PassThru
    }
    Write-Host ('[Painel] ' + $(if ($panelAlive) {'Reutilizado'} else {'Aberto'}) + ' | PID: ' + $panelProcess.Id)
    & (Join-Path $PSScriptRoot 'run-live.ps1') -JobFile $jobPath -RunDirectory $runPath
    exit ([int]$LASTEXITCODE)
} finally {
    $runMutex.ReleaseMutex()
    $runMutex.Dispose()
}
