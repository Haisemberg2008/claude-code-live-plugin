$null = [Console]::In.ReadToEnd()
$session = [guid]::NewGuid().ToString()
$resumeIndex = [array]::IndexOf($args, '--resume')
if ($resumeIndex -ge 0) { $session = $args[$resumeIndex + 1] }
@{type='system';subtype='init';session_id=$session;model='fake'} | ConvertTo-Json -Compress
[Console]::Out.Flush()
$delay = [int]$env:CLAUDE_LIVE_TEST_DELAY
$pattern = [string]$env:CLAUDE_LIVE_TEST_PATTERN
if ($pattern -eq 'activity') {
    $interval = [math]::Max(10, [int]$env:CLAUDE_LIVE_TEST_EVENT_INTERVAL)
    $elapsed = 0
    while ($elapsed -lt $delay) {
        Start-Sleep -Milliseconds ([math]::Min($interval, $delay - $elapsed))
        $elapsed += $interval
        @{type='stream_event';event=@{type='test_activity'}} | ConvertTo-Json -Compress -Depth 3
        [Console]::Out.Flush()
    }
} else {
    Start-Sleep -Milliseconds $delay
}
@{type='result';session_id=$session;result='Simulated completion';is_error=$false;permission_denials=@()} | ConvertTo-Json -Compress
