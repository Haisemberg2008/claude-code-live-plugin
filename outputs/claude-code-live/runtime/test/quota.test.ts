// Quota: the sanitized /usage parser is reused with the same literal results
// as v1, the GLOBAL v1 mutex serializes v1/v2 queries, 3% is only a
// recommendation, and telemetry failure never blocks fixed authorized work.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseUsageText, evaluateQuotaRecommendation } from '../src/quota/usage-parser.ts';
import { withGlobalQuotaMutex, QUOTA_MUTEX_NAME } from '../src/quota/global-mutex.ts';
import { USAGE_SAMPLE } from './helpers/fixtures.ts';
import { holdNamedMutex, isPwshAvailable } from './helpers/pwsh.ts';
import { assertRejectsCode } from './helpers/assert-code.ts';

const pwsh = process.platform === 'win32' && (await isPwshAvailable());
const mutexSkip = !pwsh && (process.platform === 'win32' ? 'pwsh is required for the named mutex' : 'Windows named mutex');

describe('parseUsageText', () => {
  test('matches the legacy parser literally', () => {
    const usage = parseUsageText(USAGE_SAMPLE, '2026-09-12T10:00:00.000Z');
    assert.deepEqual(usage, {
      session: { usedPercent: 10, remainingPercent: 90, resets: 'Sep 6, 9:19pm (America/Sao_Paulo)' },
      allModels: { usedPercent: 23, remainingPercent: 77, resets: 'Sep 10, 8:59pm (America/Sao_Paulo)' },
      fable: { usedPercent: 44, remainingPercent: 56, resets: 'Sep 10, 8:59pm (America/Sao_Paulo)' },
      alertLevel: 'ok',
      observedAt: '2026-09-12T10:00:00.000Z',
    });
    assert.equal(parseUsageText(USAGE_SAMPLE.replace('44% used', '80% used'), 'x').alertLevel, 'warning');
    assert.equal(parseUsageText(USAGE_SAMPLE.replace('44% used', '95% used'), 'x').alertLevel, 'critical');
    assert.throws(() => parseUsageText('incomplete usage response', 'x'), (error: { code?: string }) => error.code === 'USAGE_FORMAT_UNEXPECTED');
    assert.ok(!JSON.stringify(parseUsageText(USAGE_SAMPLE, 'x')).includes('Current session'), 'raw text is not retained');
  });
});

describe('evaluateQuotaRecommendation', () => {
  test('3% remaining is a recommendation to consider the other model, not a block', () => {
    const low = parseUsageText(USAGE_SAMPLE.replace('44% used', '97% used'), '2026-09-12T10:00:00.000Z');
    assert.deepEqual(evaluateQuotaRecommendation({ usage: low, requestedModel: 'claude-fable-5-1' }), {
      recommendation: 'consider_alternate',
      alternate: 'claude-opus-5',
      blocking: false,
      thresholdPercent: 3,
      effectiveRemainingPercent: 3,
      observedAt: '2026-09-12T10:00:00.000Z',
    });
  });

  test('shared limits are shared: no alternate model helps and still no block', () => {
    const shared = parseUsageText(USAGE_SAMPLE.replace('23% used', '98% used'), 'x');
    const result = evaluateQuotaRecommendation({ usage: shared, requestedModel: 'claude-fable-5-1' });
    assert.equal(result.recommendation, 'shared_limit');
    assert.equal(result.alternate, null);
    assert.equal(result.blocking, false);
  });

  test('unknown remains unknown and never blocks fixed authorized work', () => {
    const result = evaluateQuotaRecommendation({ usage: null, requestedModel: 'claude-opus-5', failure: { code: 'USAGE_QUERY_FAILED', attemptedAt: '2026-09-12T10:00:00.000Z' } });
    assert.deepEqual(result, {
      recommendation: 'unknown',
      alternate: null,
      blocking: false,
      thresholdPercent: 3,
      effectiveRemainingPercent: null,
      observedAt: null,
      failure: { code: 'USAGE_QUERY_FAILED', attemptedAt: '2026-09-12T10:00:00.000Z' },
    });
    assert.ok(!('estimatedCost' in result) && !('credits' in result), 'no monetary fields are invented');
  });

  test('opus requests report ok while shared capacity remains', () => {
    const healthy = parseUsageText(USAGE_SAMPLE, 'x');
    assert.equal(evaluateQuotaRecommendation({ usage: healthy, requestedModel: 'claude-opus-5' }).recommendation, 'ok');
  });
});

describe('global quota mutex shared with v1', () => {
  test('uses the exact v1 mutex name', () => {
    assert.equal(QUOTA_MUTEX_NAME, 'Local\\ClaudeLiveQuota');
  });

  test('waits for a v1 holder, times out within the bound and succeeds after release', { skip: mutexSkip }, async () => {
    const holder = await holdNamedMutex(QUOTA_MUTEX_NAME);
    try {
      const error = await assertRejectsCode(withGlobalQuotaMutex(async () => 'never', { waitMs: 300 }), 'QUOTA_LOCK_TIMEOUT') as { attemptedAt?: string };
      assert.match(error.attemptedAt ?? '', /^\d{4}-/);
    } finally {
      await holder.release();
    }
    const outcome = await withGlobalQuotaMutex(async () => 'ok', { waitMs: 5000 });
    assert.equal(outcome.value, 'ok');
    assert.ok(outcome.waitedMs >= 0);
    assert.match(outcome.attemptedAt, /^\d{4}-/);
  });

  test('two v2 holders serialize with each other', { skip: mutexSkip }, async () => {
    const order: string[] = [];
    let signalStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const first = withGlobalQuotaMutex(async () => { order.push('a-start'); signalStarted(); await new Promise((r) => setTimeout(r, 400)); order.push('a-end'); return 1; }, { waitMs: 5000 });
    await started;
    const second = withGlobalQuotaMutex(async () => { order.push('b-start'); return 2; }, { waitMs: 5000 });
    await Promise.all([first, second]);
    assert.deepEqual(order, ['a-start', 'a-end', 'b-start']);
  });
});
