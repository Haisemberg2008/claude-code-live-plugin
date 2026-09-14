import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { EventRecord } from '../src/shared/types.ts';
import { ClaudeUsageAccumulator, normalizeClaudeUsage, sanitizeClaudeUsageReport } from '../src/usage/claude-usage.ts';

describe('Claude usage meter', () => {
  test('normalizes the complete CLI token report without hiding cache activity', () => {
    assert.deepEqual(normalizeClaudeUsage({
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 3,
    }), {
      inputTokens: 10,
      outputTokens: 5,
      cachedInputTokens: 20,
      cacheWriteInputTokens: 3,
      totalInputTokens: 33,
      totalObservedTokens: 38,
      quality: 'reported',
    });
  });

  test('marks missing CLI fields as partial instead of assuming zero', () => {
    assert.deepEqual(normalizeClaudeUsage({ input_tokens: 10, output_tokens: 5 }), {
      inputTokens: 10,
      outputTokens: 5,
      cachedInputTokens: null,
      cacheWriteInputTokens: null,
      totalInputTokens: 10,
      totalObservedTokens: 15,
      quality: 'partial',
    });
    assert.equal(normalizeClaudeUsage(undefined), null);
  });

  test('sanitizes the persisted CLI report to non-negative integer counters only', () => {
    assert.deepEqual(sanitizeClaudeUsageReport({
      input_tokens: 4,
      output_tokens: -1,
      cache_read_input_tokens: '8',
      cache_creation_input_tokens: 2,
      secret: 'must-not-survive',
    }), {
      input_tokens: 4,
      output_tokens: null,
      cache_read_input_tokens: null,
      cache_creation_input_tokens: 2,
    });
  });

  test('deduplicates terminal turn events and keeps subtotals by observed model', () => {
    const accumulator = new ClaudeUsageAccumulator();
    const first = terminalEvent(1, 'run-a', 1, 'claude-fable-5-1', {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 3,
    });
    assert.equal(accumulator.addEvent(first), true);
    assert.equal(accumulator.addEvent({ ...first, seq: 2, type: 'turn_interrupted' }), false);
    assert.equal(accumulator.addEvent(terminalEvent(3, 'run-b', 1, 'claude-opus-5', {
      input_tokens: 4,
      output_tokens: 2,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 1,
    })), true);

    assert.deepEqual(accumulator.snapshot('2026-09-13T12:00:00.000Z'), {
      quality: 'reported',
      observedAt: '2026-09-13T12:00:00.000Z',
      turns: 2,
      inputTokens: 14,
      outputTokens: 7,
      cachedInputTokens: 20,
      cacheWriteInputTokens: 4,
      totalInputTokens: 38,
      totalObservedTokens: 45,
      byModel: [
        { model: 'claude-fable-5-1', turns: 1, inputTokens: 10, outputTokens: 5, cachedInputTokens: 20, cacheWriteInputTokens: 3, totalInputTokens: 33, totalObservedTokens: 38, quality: 'reported' },
        { model: 'claude-opus-5', turns: 1, inputTokens: 4, outputTokens: 2, cachedInputTokens: 0, cacheWriteInputTokens: 1, totalInputTokens: 5, totalObservedTokens: 7, quality: 'reported' },
      ],
    });
  });

  test('reconstructs historical usage with partial quality and no duplicate resume count', () => {
    const events = [
      terminalEvent(1, 'run-a', 1, 'claude-fable-5-1', { input_tokens: 8, output_tokens: 3 }),
      terminalEvent(2, 'run-a', 1, 'claude-fable-5-1', { input_tokens: 8, output_tokens: 3 }, 'turn_failed'),
      terminalEvent(3, 'run-a', 2, 'claude-fable-5-1', { input_tokens: 2, output_tokens: 1, cache_read_input_tokens: 4, cache_creation_input_tokens: 0 }),
    ];
    const snapshot = ClaudeUsageAccumulator.fromEvents(events).snapshot('2026-09-13T12:00:00.000Z');
    assert.equal(snapshot.quality, 'partial');
    assert.equal(snapshot.turns, 2);
    assert.equal(snapshot.totalObservedTokens, 18);
    assert.equal(snapshot.cachedInputTokens, 4);
    assert.equal(snapshot.cacheWriteInputTokens, 0);
  });
});

function terminalEvent(
  seq: number,
  runId: string,
  turn: number,
  model: string,
  usage: Record<string, number>,
  type = 'turn_completed',
): EventRecord {
  return {
    seq,
    ts: `2026-09-13T12:00:0${seq}.000Z`,
    type,
    taskId: 'task-a',
    runId,
    data: { turn, model, usage },
  };
}

describe('usage snapshot', () => {
  test('restoring from the snapshot equals replaying the log, and stays idempotent', () => {
    const events = [
      terminalEvent(1, 'run-a', 1, 'claude-fable-5-1', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 20, cache_creation_input_tokens: 3 }),
      terminalEvent(2, 'run-a', 2, 'claude-fable-5-1', { input_tokens: 7, output_tokens: 11 }),
      terminalEvent(3, 'run-b', 1, 'claude-opus-5', { input_tokens: 100, output_tokens: 50 }),
    ];
    const replayed = ClaudeUsageAccumulator.fromEvents(events);

    // The snapshot exists so a broker restart does not have to re-read a log
    // that grows with everything the task ever did. It is only worth anything
    // if it agrees with that replay exactly.
    const restored = ClaudeUsageAccumulator.fromJSON(JSON.parse(JSON.stringify(replayed.toJSON())));
    assert.ok(restored, 'o snapshot precisa ser reconhecido');
    assert.deepEqual(restored.snapshot(), replayed.snapshot());

    // `seen` is part of the state, not an optimisation: a restored accumulator
    // that meets a turn it already counted must still refuse it.
    assert.equal(restored.addEvent(events[0]!), false, 'turno repetido nao pode contar duas vezes');
    assert.deepEqual(restored.snapshot(), replayed.snapshot());

    // A new turn still counts after restoring.
    assert.equal(restored.addEvent(terminalEvent(4, 'run-b', 2, 'claude-opus-5', { input_tokens: 1, output_tokens: 1 })), true);
    assert.equal(restored.snapshot().turns, replayed.snapshot().turns + 1);
  });

  test('an unrecognised or corrupt snapshot is refused so the caller replays the log', () => {
    for (const bad of [null, undefined, 42, 'x', {}, { version: 2 }, { version: 1, seen: 'no', models: [], total: {} }, { version: 1, seen: [], models: [['m']], total: {} }]) {
      assert.equal(ClaudeUsageAccumulator.fromJSON(bad), null, JSON.stringify(bad));
    }
  });
});
