// Legacy contract preservation: the derived compatibility files keep the v1
// keys, and the legacy PowerShell writer/readers gain the same sharing-mode
// robustness (readers share Delete, writers retry within a bound, status
// telemetry failures are nonfatal, final results have a durable fallback).
// Capability discovery happens before registration so nothing passes as an
// assertion-free test when pwsh is unavailable.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { deriveCompatibilityFiles, LEGACY_STATUS_KEYS } from '../src/events/derive.ts';
import { writeFileAtomic } from '../src/state/atomic-file.ts';
import { makeTempRoot, sleep, waitFor, type TempRoot } from './helpers/temp.ts';
import { holdFileWithoutDeleteShare, isPwshAvailable, runPwsh } from './helpers/pwsh.ts';
import { legacyScriptsDir, legacyTestsDir } from './helpers/paths.ts';

const pwsh = await isPwshAvailable();
const windowsPwsh = process.platform === 'win32' && pwsh;
const needsPwsh = !pwsh && 'requires pwsh (PowerShell 7)';
const needsWindows = !windowsPwsh && 'requires Windows and pwsh';
const stateHelper = path.join(legacyScriptsDir, 'claude-live-state.ps1');

let temp: TempRoot;
before(async () => { temp = await makeTempRoot('codeorquestra-legacy-'); });
after(async () => { await temp.cleanup(); });

describe('derived legacy keys', () => {
  test('status.json keeps every v1 key so old readers keep working', () => {
    assert.deepEqual(LEGACY_STATUS_KEYS, [
      'status', 'codexThreadId', 'startedAt', 'sessionId', 'result', 'exitCode', 'elapsedSeconds', 'toolCalls',
      'workspace', 'requestedModel', 'selectedModel', 'model', 'effort', 'mode', 'profile', 'coordination',
      'usage', 'usageCheckedAt', 'toolErrors', 'permissionDenials', 'lastActivityAt', 'runtimeSeconds',
      'resumeMode', 'allowedCommands', 'timeoutPolicy', 'timeoutReason', 'failureStage',
    ]);
    const derived = deriveCompatibilityFiles([
      { seq: 1, ts: '2026-09-12T10:00:00.000Z', type: 'run_started', taskId: 't', runId: 'r', threadId: 'thread', data: { startedAt: '2026-09-12T10:00:00.000Z', requestedModel: 'claude-fable-5-1', effort: 'xhigh', workspace: 'C:\\ws', profile: 'development', contractVersion: 2 } },
    ]);
    for (const key of LEGACY_STATUS_KEYS) assert.ok(key in derived.status, `missing legacy key ${key}`);
    assert.equal(derived.status.mode, null, 'v2 jobs have no legacy mode but keep the key');
    assert.deepEqual(derived.status.timeoutPolicy, { mode: 'supervised', inactivityAlertSeconds: 1200, elapsedAlertSeconds: 7200, killTimers: false });
  });
});

describe('legacy PowerShell state helper', () => {
  test('the shared helper exists and is dot-sourced by run-live.ps1 and watch-live.ps1', async () => {
    await access(stateHelper);
    const runLive = await readFile(path.join(legacyScriptsDir, 'run-live.ps1'), 'utf8');
    const watchLive = await readFile(path.join(legacyScriptsDir, 'watch-live.ps1'), 'utf8');
    const logReader = await readFile(path.join(legacyScriptsDir, 'claude-log-reader.ps1'), 'utf8');
    assert.ok(runLive.includes("'claude-live-state.ps1'"), 'run-live.ps1 must use the shared writer');
    assert.ok(watchLive.includes("'claude-live-state.ps1'"), 'watch-live.ps1 must use the shared reader');
    assert.ok(!runLive.includes('[IO.File]::Move($temp, $Path, $true)'), 'the unguarded Move is gone from run-live.ps1');
    assert.ok(logReader.includes('[IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete'), 'the incremental log reader shares Delete');
  });

  test('Write-ClaudeLiveState retries while a reader holds the file without delete sharing', { skip: needsWindows }, async () => {
    const file = path.join(temp.root, 'ps-write.json');
    const marker = path.join(temp.root, 'first-retry.marker');
    await writeFile(file, '{"status":"STARTING"}');
    const holder = await holdFileWithoutDeleteShare(file);
    try {
      const writer = runPwsh(`. '${stateHelper}'; $r = Write-ClaudeLiveState -Value ([ordered]@{status='RUNNING'}) -Path '${file}' -MaxWaitMilliseconds 20000 -OnRetry { if (-not (Test-Path '${marker}')) { New-Item -ItemType File -Path '${marker}' | Out-Null } }; Write-Output ('ATTEMPTS=' + $r.Attempts)`);
      let writerSettled = false;
      const settled = writer.then((r) => { writerSettled = true; return r; }, (error) => { writerSettled = true; throw error; });
      await waitFor(async () => {
        if (writerSettled) throw new Error('the writer finished before any retry was observed; the barrier did not engage');
        try { await access(marker); return true; } catch { return undefined; }
      }, { timeoutMs: 20000, description: 'first retry marker' });
      await holder.release();
      const result = await settled;
      assert.equal(result.code, 0, result.stderr);
      const attempts = Number(/ATTEMPTS=(\d+)/.exec(result.stdout)?.[1]);
      assert.ok(attempts >= 2, `expected retries, stdout: ${result.stdout}`);
      assert.equal(JSON.parse(await readFile(file, 'utf8')).status, 'RUNNING');
    } finally {
      await holder.release();
    }
  });

  test('Write-ClaudeLiveState fails visibly with STATE_FILE_BUSY and the inner HRESULT after the bound', { skip: needsWindows }, async () => {
    const file = path.join(temp.root, 'ps-busy.json');
    await writeFile(file, '{"status":"STARTING"}');
    const holder = await holdFileWithoutDeleteShare(file);
    try {
      const result = await runPwsh(`. '${stateHelper}'; try { Write-ClaudeLiveState -Value @{status='RUNNING'} -Path '${file}' -MaxWaitMilliseconds 300 | Out-Null; Write-Output 'NO-THROW' } catch { Write-Output ('CAUGHT=' + $_.Exception.Message) }`);
      assert.match(result.stdout, /CAUGHT=.*STATE_FILE_BUSY/);
      assert.match(result.stdout, /HRESULT=0x[0-9A-F]{8}/i, 'sanitized inner HRESULT is part of the diagnostic');
      assert.equal(JSON.parse(await readFile(file, 'utf8')).status, 'STARTING');
    } finally {
      await holder.release();
    }
  });

  test('a legacy reader that holds the file briefly is absorbed by the bounded writer and then sees the new content', { skip: needsWindows }, async () => {
    // Evidence on this host: any open handle on the destination (even with
    // FileShare.Delete) makes the replace rename fail until it closes, so
    // owned readers stay short-lived and writers retry within a bound.
    const file = path.join(temp.root, 'ps-read.json');
    await writeFile(file, '{"status":"STARTING"}');
    const marker = path.join(temp.root, 'reader-open.marker');
    // The reader releases, then re-reads only after the writer had time to
    // complete its retry (the writer polls every 25ms); re-reading at the
    // same instant as the release would race the replacement itself.
    const reader = runPwsh(`. '${stateHelper}'; $s = Open-ClaudeLiveStateStream -Path '${file}'; New-Item -ItemType File -Path '${marker}' | Out-Null; Start-Sleep -Milliseconds 700; $s.Dispose(); Start-Sleep -Milliseconds 1500; $v = Read-ClaudeLiveStateJson -Path '${file}'; Write-Output ('STATUS=' + $v.status)`);
    let readerSettled = false;
    const settled = reader.then((r) => { readerSettled = true; return r; }, (error) => { readerSettled = true; throw error; });
    await waitFor(async () => {
      if (readerSettled) throw new Error('the reader exited before opening the stream');
      try { await access(marker); return true; } catch { return undefined; }
    }, { timeoutMs: 20000, description: 'reader open marker' });
    const outcome = await writeFileAtomic(file, '{"status":"RUNNING"}', { maxWaitMs: 8000, retryDelayMs: 25 });
    assert.ok(outcome.attempts >= 1);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).status, 'RUNNING', 'the replacement landed');
    const result = await settled;
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /STATUS=RUNNING/, 'the reader releases before re-reading and observes the replaced content');
    const short = await writeFileAtomic(file, '{"status":"COMPLETED"}', { maxWaitMs: 1000 });
    assert.equal(short.attempts, 1, 'with no reader open the replacement succeeds immediately');
  });

  test('Write-ClaudeLiveFinalResult falls back to resultado.fallback.json and reports it', { skip: needsWindows }, async () => {
    const dir = path.join(temp.root, 'ps-final');
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, 'resultado.json');
    await writeFile(file, '{"status":"RUNNING"}');
    const holder = await holdFileWithoutDeleteShare(file);
    try {
      const result = await runPwsh(`. '${stateHelper}'; $r = Write-ClaudeLiveFinalResult -Value ([ordered]@{status='COMPLETED'}) -Path '${file}' -MaxWaitMilliseconds 400; Write-Output ('PATH=' + $r.Path + ';FALLBACK=' + $r.Fallback)`);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /FALLBACK=True/);
      const fallback = JSON.parse(await readFile(path.join(dir, 'resultado.fallback.json'), 'utf8'));
      assert.equal(fallback.status, 'COMPLETED');
      assert.equal(fallback.persistence.code, 'STATE_FILE_BUSY');
    } finally {
      await holder.release();
    }
  });

  test('Write-ClaudeLiveTelemetry is nonfatal and reports the failure', { skip: needsWindows }, async () => {
    const file = path.join(temp.root, 'ps-telemetry.json');
    await writeFile(file, '{"status":"STARTING"}');
    const holder = await holdFileWithoutDeleteShare(file);
    try {
      const result = await runPwsh(`. '${stateHelper}'; $r = Write-ClaudeLiveTelemetry -Value @{status='RUNNING'} -Path '${file}' -MaxWaitMilliseconds 300; Write-Output ('OK=' + $r.Ok + ';CODE=' + $r.Code)`);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /OK=False;CODE=STATE_FILE_BUSY/);
    } finally {
      await holder.release();
    }
    await sleep(50);
  });
});

describe('legacy PowerShell suites', () => {
  for (const suite of ['claude-live-contract.tests.ps1', 'claude-thread-context.tests.ps1', 'claude-usage.tests.ps1']) {
    test(`${suite} still passes`, { skip: needsPwsh }, async () => {
      const result = await runPwsh(`& '${path.join(legacyTestsDir, suite)}'`, {}, 120000);
      assert.equal(result.code, 0, `${suite} failed: ${result.stderr}\n${result.stdout}`);
    });
  }

  test('claude-runtime.tests.ps1 passes with the preparation fixture made robust', { skip: needsPwsh }, async () => {
    const source = await readFile(path.join(legacyTestsDir, 'claude-runtime.tests.ps1'), 'utf8');
    assert.ok(source.includes('preparationSeconds'), 'the fixture must assert the recorded preparation diagnostic');
    assert.ok(!/preparation-outside-timeout'.*\n.*timeoutSeconds -NotePropertyValue 1\b/.test(source), 'the one-second cap that raced cold PowerShell startup is gone');
    const result = await runPwsh(`& '${path.join(legacyTestsDir, 'claude-runtime.tests.ps1')}'`, {}, 300000);
    assert.equal(result.code, 0, `runtime suite failed: ${result.stderr}\n${result.stdout.slice(-3000)}`);
  });
});
