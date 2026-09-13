import readline from 'node:readline';
import { appendFileSync } from 'node:fs';

const scenario = process.argv[2] ?? 'ok';
const trace = process.argv[3] ?? '';
if (scenario === 'exit') process.exit(7);

const reader = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
reader.on('line', (line) => {
  const request = JSON.parse(line);
  if (trace) appendFileSync(trace, `${request.method}\n`, 'utf8');
  if (scenario === 'malformed') {
    process.stdout.write('not-json\n');
    return;
  }
  let result = {};
  if (request.method === 'account/rateLimits/read') {
    result = {
      rateLimits: {
        limitId: 'codex', limitName: 'Codex', planType: 'plus',
        primary: { usedPercent: 31, windowDurationMins: 300, resetsAt: 1789315200 },
        secondary: { usedPercent: 47, windowDurationMins: 10080, resetsAt: 1789920000 },
        credits: { hasCredits: true, unlimited: false, balance: 'SECRET-NOT-TO-PERSIST' },
      },
      rateLimitsByLimitId: null,
    };
  } else if (request.method === 'account/usage/read' && scenario === 'usage-error') {
    process.stdout.write(`${JSON.stringify({ id: request.id, error: { code: -32000, message: 'authentication incompatible' } })}\n`);
    return;
  } else if (request.method === 'account/usage/read') {
    result = request.params?.threadId ? {
      summary: {}, dailyUsageBuckets: null,
      threadUsage: scenario === 'no-thread' ? null : {
        threadId: request.params.threadId,
        estimatedUsageCreditsMicros: 123456,
        estimatedUsageUsdMicros: 654321,
        groups: [{ model: 'gpt-6-astra', reasoningEffort: 'high', inputTokens: 100, cachedInputTokens: 60, netNewInputTokens: 40, outputTokens: 25, totalTokens: 125, estimatedUsageCreditsMicros: 123456 }],
      },
    } : {
      summary: { lifetimeTokens: 5000, peakDailyTokens: 800, longestRunningTurnSec: 90, currentStreakDays: 3, longestStreakDays: 8 },
      dailyUsageBuckets: [{ startDate: '2026-09-13', tokens: 320 }],
      threadUsage: null,
    };
  }
  process.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
});
