import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexUsageService } from '../src/usage/codex-usage.ts';

const fake = path.resolve('test/helpers/fake-codex-app-server.mjs');
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()?.(); });

describe('read-only Codex App Server usage adapter', () => {
  test('reports official limits/activity and estimated thread usage without financial fields', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codeorquestra-codex-usage-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const trace = path.join(root, 'methods.txt');
    const service = new CodexUsageService({ command: process.execPath, args: [fake, 'ok', trace], minRefreshMs: 60_000, requestTimeoutMs: 2_000 });
    cleanup.push(() => service.stop());

    const result = await service.refresh('codex-thread-1');
    assert.equal(result.quality, 'reported');
    assert.equal(result.limits.quality, 'reported');
    assert.deepEqual(result.limits.buckets[0]?.primary, { usedPercent: 31, remainingPercent: 69, windowDurationMins: 300, resetsAt: 1789315200 });
    assert.equal(result.activity.lifetimeTokens, 5000);
    assert.deepEqual(result.activity.daily, [{ startDate: '2026-09-13', tokens: 320 }]);
    assert.equal(result.task.quality, 'estimated');
    assert.deepEqual(result.task.groups, [{ model: 'gpt-6-astra', reasoningEffort: 'high', inputTokens: 100, cachedInputTokens: 60, netNewInputTokens: 40, outputTokens: 25, totalTokens: 125 }]);
    assert.ok(!JSON.stringify(result).includes('SECRET-NOT-TO-PERSIST'));
    assert.ok(!JSON.stringify(result).toLowerCase().includes('credits'));
    assert.ok(!JSON.stringify(result).toLowerCase().includes('usd'));

    const methods = (await readFile(trace, 'utf8')).trim().split(/\r?\n/);
    assert.deepEqual(methods, ['initialize', 'account/rateLimits/read', 'account/usage/read', 'account/usage/read']);
    assert.ok(methods.every((method) => !/(turn|login|consume|reset)/i.test(method)));

    const cached = await service.refresh('codex-thread-1');
    assert.deepEqual(cached, result);
    assert.deepEqual((await readFile(trace, 'utf8')).trim().split(/\r?\n/), methods, 'minimum interval avoids excessive reads');
  });

  test('labels unsupported per-thread usage as unavailable without hiding account metrics', async () => {
    const service = new CodexUsageService({ command: process.execPath, args: [fake, 'no-thread'], minRefreshMs: 0, requestTimeoutMs: 2_000 });
    cleanup.push(() => service.stop());
    const result = await service.refresh('missing-thread');
    assert.equal(result.quality, 'partial');
    assert.equal(result.task.quality, 'unavailable');
    assert.equal(result.limits.quality, 'reported');
    assert.equal(result.activity.quality, 'reported');
  });

  test('keeps available limits when account usage authentication is incompatible', async () => {
    const service = new CodexUsageService({ command: process.execPath, args: [fake, 'usage-error'], minRefreshMs: 0, requestTimeoutMs: 2_000 });
    cleanup.push(() => service.stop());
    const result = await service.refresh('thread');
    assert.equal(result.quality, 'partial');
    assert.equal(result.limits.quality, 'reported');
    assert.equal(result.activity.quality, 'unavailable');
    assert.equal(result.task.quality, 'unavailable');
    assert.equal(result.failure?.code, 'CODEX_USAGE_PARTIAL');
  });

  for (const scenario of ['exit', 'malformed']) {
    test(`a ${scenario} App Server leaves telemetry unavailable and does not throw`, async () => {
      const service = new CodexUsageService({ command: process.execPath, args: [fake, scenario], minRefreshMs: 0, requestTimeoutMs: 400 });
      cleanup.push(() => service.stop());
      const result = await service.refresh('thread');
      assert.equal(result.quality, 'unavailable');
      assert.equal(result.limits.quality, 'unavailable');
      assert.equal(result.activity.quality, 'unavailable');
      assert.equal(result.task.quality, 'unavailable');
      assert.match(result.failure?.code ?? '', /^CODEX_USAGE_/);
    });
  }
});
