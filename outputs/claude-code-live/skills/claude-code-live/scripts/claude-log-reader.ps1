function New-ClaudeLogCursor {
    @{ Path = $null; Offset = 0L; Decoder = [Text.Encoding]::UTF8.GetDecoder() }
}

function Get-ClaudeElapsedSeconds {
    param($State)
    if ($State.startedAt -and $State.status -in @('STARTING','RUNNING')) {
        return [math]::Max(0, [math]::Floor(([DateTimeOffset]::UtcNow - [DateTimeOffset]$State.startedAt).TotalSeconds))
    }
    return $State.elapsedSeconds
}

function Read-ClaudeLogDelta {
    param([hashtable]$Cursor, [string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return '' }
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
    try {
        if ($Cursor.Path -ne $Path -or $stream.Length -lt $Cursor.Offset) {
            $Cursor.Path = $Path
            $Cursor.Offset = 0L
            $Cursor.Decoder.Reset()
        }
        $null = $stream.Seek($Cursor.Offset, [IO.SeekOrigin]::Begin)
        $bytes = [byte[]]::new(65536)
        $chars = [char[]]::new([Text.Encoding]::UTF8.GetMaxCharCount($bytes.Length))
        $count = $stream.Read($bytes, 0, $bytes.Length)
        $Cursor.Offset += $count
        $length = $Cursor.Decoder.GetChars($bytes, 0, $count, $chars, 0, $false)
        return [string]::new($chars, 0, $length)
    } finally { $stream.Dispose() }
}
