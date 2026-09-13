#requires -Version 7.0
# Shared state I/O for the legacy runner and panel.
# Evidence on Windows: replacing a file that ANY process holds open fails with
# access denied until the handle closes, regardless of the reader's share mode.
# Therefore owned readers are short-lived and share Delete, writers retry within
# a bound, status telemetry failures are nonfatal, and the final result has an
# explicit durable fallback that is never silently swallowed.

function Open-ClaudeLiveStateStream {
    param([Parameter(Mandatory)][string]$Path)
    [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
}

function Read-ClaudeLiveStateText {
    param([Parameter(Mandatory)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $stream = Open-ClaudeLiveStateStream -Path $Path
    try {
        $reader = [IO.StreamReader]::new($stream, [Text.UTF8Encoding]::new($false))
        try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
    } finally { $stream.Dispose() }
}

function Read-ClaudeLiveStateJson {
    param([Parameter(Mandatory)][string]$Path)
    $text = Read-ClaudeLiveStateText -Path $Path
    if ($null -eq $text -or [string]::IsNullOrWhiteSpace($text)) { return $null }
    try { return ($text | ConvertFrom-Json -ErrorAction Stop) } catch { return $null }
}

function Get-ClaudeLiveHResult {
    param($Exception)
    if ($null -eq $Exception) { return 'n/a' }
    return ('0x{0:X8}' -f $Exception.HResult)
}

function Write-ClaudeLiveState {
    param(
        [Parameter(Mandatory)]$Value,
        [Parameter(Mandatory)][string]$Path,
        [int]$MaxWaitMilliseconds = 3000,
        [int]$RetryDelayMilliseconds = 25,
        [scriptblock]$OnRetry
    )
    $json = $Value | ConvertTo-Json -Depth 8
    $directory = Split-Path -Parent $Path
    if ($directory -and -not (Test-Path -LiteralPath $directory)) { [IO.Directory]::CreateDirectory($directory) | Out-Null }
    $temp = $Path + '.' + $PID + '.' + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.tmp'
    [IO.File]::WriteAllText($temp, $json, [Text.UTF8Encoding]::new($false))
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $attempts = 0
    $lastError = $null
    while ($true) {
        $attempts++
        try {
            [IO.File]::Move($temp, $Path, $true)
            return [pscustomobject]@{ Attempts = $attempts; WaitedMilliseconds = [int]$clock.ElapsedMilliseconds; Path = $Path }
        } catch [IO.IOException], [UnauthorizedAccessException] {
            $lastError = $_.Exception
            if ($clock.ElapsedMilliseconds -ge $MaxWaitMilliseconds) { break }
            if ($OnRetry) { try { & $OnRetry $attempts } catch { } }
            Start-Sleep -Milliseconds $RetryDelayMilliseconds
        }
    }
    try { [IO.File]::Delete($temp) } catch { }
    $kind = if ($null -ne $lastError) { $lastError.GetType().Name } else { 'desconhecido' }
    throw ('STATE_FILE_BUSY: nao foi possivel substituir ' + (Split-Path -Leaf $Path) + ' apos ' + $attempts + ' tentativas em ' + [int]$clock.ElapsedMilliseconds + 'ms (' + $kind + ', HRESULT=' + (Get-ClaudeLiveHResult $lastError) + ').')
}

function Write-ClaudeLiveTelemetry {
    param(
        [Parameter(Mandatory)]$Value,
        [Parameter(Mandatory)][string]$Path,
        [int]$MaxWaitMilliseconds = 1500
    )
    try {
        $result = Write-ClaudeLiveState -Value $Value -Path $Path -MaxWaitMilliseconds $MaxWaitMilliseconds
        return [pscustomobject]@{ Ok = $true; Code = $null; Attempts = $result.Attempts; Message = $null }
    } catch {
        $code = if ($_.Exception.Message -like 'STATE_FILE_BUSY*') { 'STATE_FILE_BUSY' } else { 'STATE_FILE_WRITE_FAILED' }
        return [pscustomobject]@{ Ok = $false; Code = $code; Attempts = $null; Message = $_.Exception.Message }
    }
}

function ConvertTo-ClaudeLiveOrderedCopy {
    param($Value)
    $copy = [ordered]@{}
    if ($Value -is [Collections.IDictionary]) {
        foreach ($key in $Value.Keys) { $copy[[string]$key] = $Value[$key] }
    } else {
        foreach ($property in $Value.PSObject.Properties) { $copy[$property.Name] = $property.Value }
    }
    return $copy
}

function Write-ClaudeLiveFinalResult {
    param(
        [Parameter(Mandatory)]$Value,
        [Parameter(Mandatory)][string]$Path,
        [int]$MaxWaitMilliseconds = 15000,
        [string]$FallbackPath
    )
    if (-not $FallbackPath) { $FallbackPath = Join-Path (Split-Path -Parent $Path) 'resultado.fallback.json' }
    try {
        $result = Write-ClaudeLiveState -Value $Value -Path $Path -MaxWaitMilliseconds $MaxWaitMilliseconds
        return [pscustomobject]@{ Path = $Path; Fallback = $false; Attempts = $result.Attempts }
    } catch {
        $primaryMessage = $_.Exception.Message
        $code = if ($primaryMessage -like 'STATE_FILE_BUSY*') { 'STATE_FILE_BUSY' } else { 'STATE_FILE_WRITE_FAILED' }
        $fallbackValue = ConvertTo-ClaudeLiveOrderedCopy -Value $Value
        $fallbackValue['persistence'] = [ordered]@{
            primaryFile = (Split-Path -Leaf $Path)
            code = $code
            message = $primaryMessage
            fallbackWrittenAt = [DateTimeOffset]::UtcNow.ToString('o')
            note = 'O arquivo primario permaneceu ocupado por outro processo; este fallback e o resultado final duravel.'
        }
        try {
            $result = Write-ClaudeLiveState -Value $fallbackValue -Path $FallbackPath -MaxWaitMilliseconds $MaxWaitMilliseconds
            return [pscustomobject]@{ Path = $FallbackPath; Fallback = $true; Attempts = $result.Attempts }
        } catch {
            throw ('FINAL_RESULT_NOT_PERSISTED: nem ' + (Split-Path -Leaf $Path) + ' nem ' + (Split-Path -Leaf $FallbackPath) + ' puderam ser gravados (' + $code + '; fallback: ' + $_.Exception.Message + ').')
        }
    }
}
