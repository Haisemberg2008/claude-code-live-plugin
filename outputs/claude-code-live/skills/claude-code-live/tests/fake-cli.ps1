$null = [Console]::In.ReadToEnd()
$session = [guid]::NewGuid().ToString()
$resumeIndex = [array]::IndexOf($args, '--resume')
if ($resumeIndex -ge 0) { $session = $args[$resumeIndex + 1] }
@{type='system';subtype='init';session_id=$session;model='fake'} | ConvertTo-Json -Compress
[Console]::Out.Flush()
Start-Sleep -Milliseconds ([int]$env:CLAUDE_LIVE_TEST_DELAY)
@{type='result';session_id=$session;result='Simulated completion';is_error=$false;permission_denials=@()} | ConvertTo-Json -Compress
