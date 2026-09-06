#requires -Version 7.0
param([Parameter(Mandatory)][string]$StateDirectory, [Parameter(Mandatory)][string]$PanelKey)
$ErrorActionPreference = 'Stop'
$panelMutex = [Threading.Mutex]::new($false, ('Local\ClaudeLivePanel-' + $PanelKey))
try { $panelLockHeld = $panelMutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $panelLockHeld = $true }
if (-not $panelLockHeld) { $panelMutex.Dispose(); exit }
$Host.UI.RawUI.WindowTitle = 'Claude Code | Painel ao vivo'
$pointer = Join-Path $StateDirectory 'current.json'
$registration = Join-Path $StateDirectory 'panel.json'
$self = Get-Process -Id $PID
[pscustomobject]@{pid=$PID;started=$self.StartTime.ToUniversalTime().Ticks} |
    ConvertTo-Json -Compress | Set-Content -LiteralPath $registration -Encoding utf8
$currentRun = $null
$displayed = 0
try {
    Write-Host 'CLAUDE CODE | PAINEL UNICO'
    Write-Host 'Aguardando tarefa. Q interrompe a tarefa atual; X fecha somente o painel.'
    while ($true) {
        if (Test-Path -LiteralPath (Join-Path $StateDirectory 'close-panel.request')) { break }
        try {
            if (-not [Console]::IsInputRedirected -and [Console]::KeyAvailable) {
                $key = [Console]::ReadKey($true)
                if ($key.Key -eq 'X') { break }
                if ($key.Key -eq 'Q' -and $currentRun) {
                    $stateFile = Join-Path $currentRun 'status.json'
                    $state = Get-Content -LiteralPath $stateFile -Raw -Encoding utf8 -ErrorAction SilentlyContinue | ConvertFrom-Json
                    if ($state.status -eq 'RUNNING') {
                        [IO.File]::WriteAllText((Join-Path $currentRun 'stop.request'), 'Requested from visible panel.')
                        Write-Host "`n[Parada solicitada]" -ForegroundColor Yellow
                    }
                }
            }
            if (Test-Path -LiteralPath $pointer) {
                $active = Get-Content -LiteralPath $pointer -Raw -Encoding utf8 | ConvertFrom-Json
                if ($active.runDirectory -ne $currentRun) {
                    $currentRun = $active.runDirectory
                    $displayed = 0
                    Clear-Host
                    Write-Host 'CLAUDE CODE | PAINEL UNICO'
                    Write-Host 'Q: interromper tarefa. X: fechar painel. Fechar o painel nao interrompe o executor.'
                    Write-Host ''
                }
                $log = Join-Path $currentRun 'acompanhamento.txt'
                if (Test-Path -LiteralPath $log) {
                    $content = [string](Get-Content -LiteralPath $log -Raw -Encoding utf8)
                    if ($content.Length -gt $displayed) {
                        Write-Host -NoNewline $content.Substring($displayed)
                        $displayed = $content.Length
                    }
                }
            }
        } catch { }
        Start-Sleep -Milliseconds 250
    }
} finally {
    $panelMutex.ReleaseMutex()
    $panelMutex.Dispose()
}
