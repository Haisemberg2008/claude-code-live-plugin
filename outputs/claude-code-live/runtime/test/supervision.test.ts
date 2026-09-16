// Supervision never kills: 20 minutes without activity and 2 hours elapsed
// are alerts. States are distinguished honestly and coordinator presence is
// derived from real heartbeats or event waits, never faked.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSupervision, SUPERVISION, COORDINATOR_ABSENT_LABEL, CONTEXT_HIGH_RATIO } from '../src/worker/supervision.ts';

const t0 = Date.parse('2026-09-12T10:00:00.000Z');
const minutes = (n: number) => n * 60_000;

function evaluate(overrides: Partial<Parameters<typeof evaluateSupervision>[0]> = {}) {
  return evaluateSupervision({
    now: t0 + minutes(1),
    runStartedAt: t0,
    lastActivityAt: t0 + minutes(1),
    phase: 'busy_tool',
    processAlive: true,
    coordinatorLastSeenAt: t0 + minutes(1),
    pendingRequests: 0,
    oldestPendingRequestAt: null,
    budgetRatio: null,
    thrashing: false,
    contextRatio: null,
    brokerRestartedDuringRun: false,
    terminal: false,
    ...overrides,
  });
}

describe('supervision thresholds', () => {
  test('literal thresholds', () => {
    assert.deepEqual(SUPERVISION, { inactivityAlertMs: 1_200_000, elapsedAlertMs: 7_200_000, coordinatorAbsentMs: 90_000, decisionPendingMs: 120_000 });
    assert.equal(COORDINATOR_ABSENT_LABEL, 'aguardando coordenador');
  });

  test('20 minutes idle raises an alert and never a termination', () => {
    const result = evaluate({ now: t0 + minutes(25), lastActivityAt: t0 + minutes(4), phase: 'idle' });
    assert.deepEqual(result.alerts, ['inactivity_20m']);
    assert.equal(result.action, 'none');
    assert.equal(result.state, 'idle');
  });

  test('waiting for permission is never inactivity', () => {
    const result = evaluate({ now: t0 + minutes(50), lastActivityAt: t0 + minutes(2), phase: 'waiting_permission', pendingRequests: 1 });
    assert.deepEqual(result.alerts, []);
    assert.equal(result.state, 'waiting_permission');
    assert.equal(result.action, 'none');
  });

  test('two hours elapsed raises an alert while a tool stays busy', () => {
    const result = evaluate({ now: t0 + minutes(181), lastActivityAt: t0 + minutes(180), phase: 'busy_tool' });
    assert.deepEqual(result.alerts, ['elapsed_2h']);
    assert.equal(result.state, 'busy_tool');
    assert.equal(result.action, 'none');
  });

  test('both alerts can coexist and still never terminate', () => {
    const result = evaluate({ now: t0 + minutes(200), lastActivityAt: t0 + minutes(100), phase: 'idle' });
    assert.deepEqual(result.alerts, ['inactivity_20m', 'elapsed_2h']);
    assert.equal(result.action, 'none');
  });
});

describe('state distinction', () => {
  test('coordinator presence derives from real heartbeats', () => {
    assert.equal(evaluate({ now: t0 + minutes(1), coordinatorLastSeenAt: t0 + 30_000 }).coordinatorPresence, 'present');
    const absent = evaluate({ now: t0 + minutes(3), coordinatorLastSeenAt: t0 });
    assert.equal(absent.coordinatorPresence, 'absent');
    assert.equal(absent.coordinatorLabel, 'aguardando coordenador');
    assert.equal(evaluate({ coordinatorLastSeenAt: null }).coordinatorPresence, 'absent');
  });

  test('disconnected, uncertain and terminal states', () => {
    assert.equal(evaluate({ processAlive: false }).state, 'disconnected');
    const uncertain = evaluate({ brokerRestartedDuringRun: true });
    assert.equal(uncertain.state, 'uncertain');
    assert.equal(uncertain.requiresReview, true);
    const terminal = evaluate({ terminal: true, now: t0 + minutes(500), lastActivityAt: t0 });
    assert.equal(terminal.state, 'terminal');
    assert.deepEqual(terminal.alerts, []);
  });

  test('waiting for a question answer is distinct from permission and idle', () => {
    assert.equal(evaluate({ phase: 'waiting_question', pendingRequests: 1 }).state, 'waiting_question');
  });
});

describe('a decision nobody answered', () => {
  test('is not inactivity, but is reported once it stops being progress', () => {
    const waiting = { phase: 'waiting_permission' as const, pendingRequests: 1 };

    // The pre-existing rule is unchanged and still correct: waiting is not
    // idling, so the inactivity alert stays silent no matter how long it takes.
    const long = evaluate({ ...waiting, oldestPendingRequestAt: t0, now: t0 + minutes(90), lastActivityAt: t0 });
    assert.ok(!long.alerts.includes('inactivity_20m'), 'esperar nunca é ociosidade');

    // Below the threshold it is simply a decision that just arrived.
    assert.deepEqual(evaluate({ ...waiting, oldestPendingRequestAt: t0, now: t0 + minutes(1) }).alerts, []);

    // Above it, the other true thing gets said.
    assert.ok(evaluate({ ...waiting, oldestPendingRequestAt: t0, now: t0 + minutes(3) }).alerts.includes('decision_pending'));
    assert.ok(long.alerts.includes('decision_pending'), 'noventa minutos parado precisa aparecer');

    // Nothing is ever terminated by supervision.
    assert.equal(long.action, 'none');
    assert.equal(long.requiresReview, false);
  });

  test('never fires without a pending request, whatever the phase says', () => {
    assert.deepEqual(evaluate({ phase: 'waiting_permission', pendingRequests: 1, oldestPendingRequestAt: null, now: t0 + minutes(90) }).alerts, []);
    assert.deepEqual(evaluate({ phase: 'busy_tool', pendingRequests: 0, oldestPendingRequestAt: t0, now: t0 + minutes(90), lastActivityAt: t0 + minutes(89) }).alerts, []);
  });
});

describe('a budget the run is about to spend', () => {
  test('is named at 80% and again when it runs out, and never terminates anything', () => {
    // Below the warning line the budget is not mentioned at all.
    assert.deepEqual(evaluate({ budgetRatio: 0.79 }).alerts, []);
    // At it, the run goes on; the alert exists so exhaustion is never the
    // first thing anyone hears about the budget.
    assert.deepEqual(evaluate({ budgetRatio: 0.8 }).alerts, ['budget_warning']);
    // Exhausted: both are true, and the action is still 'none' — the broker
    // enforces it by refusing the next turn, not by killing this one.
    const exhausted = evaluate({ budgetRatio: 1 });
    assert.deepEqual(exhausted.alerts, ['budget_warning', 'budget_exhausted']);
    assert.equal(exhausted.action, 'none');
    assert.equal(exhausted.state, 'busy_tool');
    assert.equal(exhausted.requiresReview, false);
    assert.deepEqual(evaluate({ budgetRatio: 1.5 }).alerts, ['budget_warning', 'budget_exhausted']);
  });

  test('a job without limits has no budget to alert on', () => {
    assert.deepEqual(evaluate({ budgetRatio: null }).alerts, []);
  });

  test('does not depend on waiting: a run blocked on a decision has spent what it spent', () => {
    const result = evaluate({ budgetRatio: 1, phase: 'waiting_permission', pendingRequests: 1, oldestPendingRequestAt: t0, now: t0 + minutes(1) });
    assert.ok(result.alerts.includes('budget_exhausted'));
    assert.equal(result.state, 'waiting_permission');
  });
});

describe('a run that looks stuck', () => {
  test('is reported as an alert and, like every alert, terminates nothing', () => {
    assert.deepEqual(evaluate({ thrashing: false }).alerts, []);
    const looping = evaluate({ thrashing: true });
    assert.deepEqual(looping.alerts, ['thrashing']);
    assert.equal(looping.action, 'none');
    assert.equal(looping.requiresReview, false);
    assert.equal(looping.state, 'busy_tool', 'a looping run is still a running run');
  });

  test('coexists with the other alerts without replacing them', () => {
    const result = evaluate({ thrashing: true, budgetRatio: 1, now: t0 + minutes(200), lastActivityAt: t0 + minutes(100), phase: 'idle' });
    assert.deepEqual(result.alerts, ['inactivity_20m', 'elapsed_2h', 'thrashing', 'budget_warning', 'budget_exhausted']);
    assert.equal(result.action, 'none');
  });

  test('a terminal run reports nothing at all', () => {
    assert.deepEqual(evaluate({ thrashing: true, terminal: true }).alerts, []);
  });
});

describe('a context window filling up', () => {
  test('is announced before it forces a compaction, and never acted on', () => {
    assert.equal(CONTEXT_HIGH_RATIO, 0.8);
    assert.deepEqual(evaluate({ contextRatio: null }).alerts, [], 'no measured turn, nothing to say');
    assert.deepEqual(evaluate({ contextRatio: 0.79 }).alerts, []);
    const high = evaluate({ contextRatio: 0.8 });
    assert.deepEqual(high.alerts, ['context_high']);
    assert.equal(high.action, 'none');
    assert.equal(high.requiresReview, false);
    assert.deepEqual(evaluate({ contextRatio: 1.4 }).alerts, ['context_high'], 'over the presumed window it is still only an alert');
  });
});
