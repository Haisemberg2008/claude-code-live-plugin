// Regression for the Windows reader/writer race observed in the legacy
// runner: a reader holding status.json without FileShare.Delete makes
// File.Move(tmp, target, overwrite) fail with "Access denied". The v2 state
// writer must retry within a bound, treat telemetry failures as nonfatal, and
// persist the final result through an explicit fallback instead of silently
// losing it. Capability discovery happens before test registration so the
// Windows regressions execute on this host instead of being skipped.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { open, readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic, readJsonShared, StateWriter } from '../src/state/atomic-file.ts';
import { makeTempRoot, sleep, type TempRoot } from './helpers/temp.ts';
import { holdFileWithoutDeleteShare, isPwshAvailable } from './helpers/pwsh.ts';
import { assertRejectsCode } from './helpers/assert-code.ts';

const isWindows = process.platform === 'win32';
const pwsh = isWindows && (await isPwshAvailable());
const windowsOnly = !pwsh && (isWindows ? 'pwsh is required on Windows for sharing-mode regressions' : 'Windows sharing semantics');

let temp: TempRoot;
before(async () => { temp = await makeTempRoot('codeorquestra-state-'); });
after(async () => { await temp.cleanup(); });

describe('writeFileAtomic', () => {
  test('an open Node read handle blocks replacement on Windows until it closes; the bounded retry absorbs it', async () => {
    // Evidence on this host: fs.rename over an open destination fails with
    // EPERM regardless of the reader's share mode, so owned readers must be
    // short-lived and writers must retry within a bound.
    const file = path.join(temp.root, 'node-reader.json');
    await writeFile(file, '{"a":1}');
    const handle = await open(file, 'r');
    let closed = false;
    const closeLater = sleep(400).then(async () => { await handle.close(); closed = true; });
    try {
      const outcome = await writeFileAtomic(file, '{"a":2}', { maxWaitMs: 8000, retryDelayMs: 25 });
      if (isWindows) assert.ok(outcome.attempts >= 2, `expected retries while the handle was open, got ${outcome.attempts}`);
      else assert.ok(outcome.attempts >= 1);
      assert.equal(await readFile(file, 'utf8'), '{"a":2}');
    } finally {
      await closeLater;
      if (!closed) await handle.close();
    }
  });

  test('a short-lived read never blocks and a handle held past the bound is reported as busy', { skip: !isWindows && 'Windows rename semantics' }, async () => {
    const file = path.join(temp.root, 'node-held.json');
    await writeFile(file, '{"a":1}');
    assert.equal(await readFile(file, 'utf8'), '{"a":1}');
    const quick = await writeFileAtomic(file, '{"a":2}', { maxWaitMs: 2000 });
    assert.equal(quick.attempts, 1, 'no reader is open, so the first attempt succeeds');
    const handle = await open(file, 'r');
    try {
      const error = await assertRejectsCode(writeFileAtomic(file, '{"a":3}', { maxWaitMs: 300, retryDelayMs: 25 }), 'STATE_FILE_BUSY') as { innerCode?: string | null };
      assert.match(error.innerCode ?? '', /^E[A-Z]+$/);
    } finally {
      await handle.close();
    }
    assert.equal(await readFile(file, 'utf8'), '{"a":2}');
  });

  test('retries within the bound while a PowerShell reader holds the file without delete sharing', { skip: windowsOnly }, async () => {
    const file = path.join(temp.root, 'ps-reader.json');
    await writeFile(file, '{"a":1}');
    const holder = await holdFileWithoutDeleteShare(file);
    let released = false;
    const releaseLater = sleep(700).then(async () => { await holder.release(); released = true; });
    try {
      const outcome = await writeFileAtomic(file, '{"a":2}', { maxWaitMs: 8000, retryDelayMs: 50 });
      assert.ok(outcome.attempts >= 2, `expected retries, got ${outcome.attempts}`);
      assert.ok(outcome.waitedMs >= 300, `expected to wait for the reader, waited ${outcome.waitedMs}ms`);
      assert.equal(await readFile(file, 'utf8'), '{"a":2}');
    } finally {
      await releaseLater;
      if (!released) await holder.release();
    }
    const leftovers = (await readdir(temp.root)).filter((name) => name.startsWith('ps-reader.json.'));
    assert.deepEqual(leftovers, [], 'temporary files must be cleaned after success');
  });

  test('fails with STATE_FILE_BUSY after the bound, records the inner code and leaves no temporary file', { skip: windowsOnly }, async () => {
    const file = path.join(temp.root, 'ps-busy.json');
    await writeFile(file, '{"a":1}');
    const holder = await holdFileWithoutDeleteShare(file);
    try {
      const error = await assertRejectsCode(writeFileAtomic(file, '{"a":2}', { maxWaitMs: 300, retryDelayMs: 50 }), 'STATE_FILE_BUSY') as { path?: string; attempts?: number; innerCode?: string | null; message: string };
      assert.equal(error.path, file);
      assert.ok((error.attempts ?? 0) >= 2);
      assert.match(error.innerCode ?? '', /^E[A-Z]+$/, 'sanitized inner errno code is retained for diagnostics');
      assert.match(error.message, /STATE_FILE_BUSY/);
      assert.equal(await readFile(file, 'utf8'), '{"a":1}', 'the previous content stays intact');
    } finally {
      await holder.release();
    }
    const leftovers = (await readdir(temp.root)).filter((name) => name.startsWith('ps-busy.json.'));
    assert.deepEqual(leftovers, [], 'temporary files must be cleaned after failure');
  });

  test('writes UTF-8 without BOM and creates parent directories', async () => {
    const file = path.join(temp.root, 'nested', 'deep', 'utf8.json');
    await writeFileAtomic(file, JSON.stringify({ texto: 'á🙂fim' }), { maxWaitMs: 1000 });
    const bytes = await readFile(file);
    assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'no BOM');
    assert.deepEqual(JSON.parse(bytes.toString('utf8')), { texto: 'á🙂fim' });
  });
});

describe('readJsonShared', () => {
  test('every read during concurrent atomic replacement is a complete snapshot', async () => {
    const file = path.join(temp.root, 'concurrent.json');
    const pad = 'x'.repeat(20000);
    await writeFileAtomic(file, JSON.stringify({ n: 0, pad }));
    let writerDone = false;
    const writer = (async () => {
      try {
        for (let n = 1; n <= 40; n += 1) {
          await writeFileAtomic(file, JSON.stringify({ n, pad }), { maxWaitMs: 2000 });
        }
      } finally {
        writerDone = true;
      }
    })();
    let reads = 0;
    const deadline = Date.now() + 30000;
    while (!writerDone) {
      assert.ok(Date.now() < deadline, 'reader loop must terminate');
      const read = await readJsonShared<{ n: number; pad: string }>(file);
      assert.equal(read.status, 'ok', `every read must see a complete document, got ${JSON.stringify(read)}`);
      if (read.status === 'ok') {
        assert.ok(Number.isInteger(read.value.n), 'integer counter');
        assert.equal(read.value.pad.length, 20000, 'payload intact');
      }
      reads += 1;
    }
    await writer;
    assert.ok(reads > 5, 'the reader loop must have run concurrently');
    const final = await readJsonShared<{ n: number }>(file);
    assert.equal(final.status, 'ok');
    if (final.status === 'ok') assert.equal(final.value.n, 40);
  });

  test('distinguishes a missing file from an invalid document without throwing', async () => {
    assert.deepEqual(await readJsonShared(path.join(temp.root, 'missing.json')), { status: 'missing' });
    const partial = path.join(temp.root, 'partial.json');
    await writeFile(partial, '{"a":');
    const read = await readJsonShared(partial, { retryMs: 50 });
    assert.equal(read.status, 'invalid');
  });
});

describe('StateWriter telemetry versus final result', () => {
  test('status telemetry failure is reported, recorded and nonfatal', { skip: windowsOnly }, async () => {
    const dir = path.join(temp.root, 'run-telemetry');
    await mkdir(dir, { recursive: true });
    const statusPath = path.join(dir, 'status.json');
    await writeFile(statusPath, '{"status":"STARTING"}');
    const failures: Array<{ file: string; code: string }> = [];
    const writer = new StateWriter({ directory: dir, telemetryMaxWaitMs: 200, finalMaxWaitMs: 400, onTelemetryFailure: (f) => failures.push({ file: f.file, code: f.code }) });
    const holder = await holdFileWithoutDeleteShare(statusPath);
    try {
      const outcome = await writer.writeStatus({ status: 'RUNNING' });
      assert.deepEqual(outcome, { ok: false, file: 'status.json', code: 'STATE_FILE_BUSY' });
      assert.deepEqual(failures, [{ file: 'status.json', code: 'STATE_FILE_BUSY' }]);
      assert.deepEqual(writer.failures.map((f) => f.code), ['STATE_FILE_BUSY']);
      assert.match(writer.failures[0]!.innerCode ?? '', /^E[A-Z]+$/);
    } finally {
      await holder.release();
    }
    const recovered = await writer.writeStatus({ status: 'RUNNING' });
    assert.deepEqual(recovered, { ok: true, file: 'status.json' });
    assert.equal(JSON.parse(await readFile(statusPath, 'utf8')).status, 'RUNNING');
  });

  test('final result falls back to an explicit durable file when resultado.json stays busy', { skip: windowsOnly }, async () => {
    const dir = path.join(temp.root, 'run-final');
    await mkdir(dir, { recursive: true });
    const resultPath = path.join(dir, 'resultado.json');
    await writeFile(resultPath, '{"status":"RUNNING"}');
    const writer = new StateWriter({ directory: dir, telemetryMaxWaitMs: 200, finalMaxWaitMs: 400 });
    const holder = await holdFileWithoutDeleteShare(resultPath);
    try {
      const outcome = await writer.writeFinalResult({ status: 'COMPLETED', result: 'ok' });
      assert.equal(outcome.ok, true);
      assert.equal(outcome.fallback, true);
      assert.equal(outcome.path, path.join(dir, 'resultado.fallback.json'));
      const fallback = JSON.parse(await readFile(outcome.path, 'utf8'));
      assert.equal(fallback.status, 'COMPLETED');
      assert.equal(fallback.persistence.primaryFile, 'resultado.json');
      assert.equal(fallback.persistence.code, 'STATE_FILE_BUSY');
      assert.equal(JSON.parse(await readFile(resultPath, 'utf8')).status, 'RUNNING', 'busy primary file left intact');
    } finally {
      await holder.release();
    }
  });

  test('a final result that cannot be persisted anywhere is a visible failure, never swallowed', async () => {
    const dir = path.join(temp.root, 'run-final-missing', 'does-not-exist');
    const writer = new StateWriter({ directory: dir, telemetryMaxWaitMs: 100, finalMaxWaitMs: 100, createDirectory: false });
    await assertRejectsCode(writer.writeFinalResult({ status: 'COMPLETED' }), 'FINAL_RESULT_NOT_PERSISTED');
  });
});
