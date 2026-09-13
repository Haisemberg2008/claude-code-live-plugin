// Supervision never kills: 20 minutes without activity and 2 hours elapsed
// are alerts. States are distinguished honestly and coordinator presence is
// derived from real heartbeats or event waits, never faked.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSupervision, SUPERVISION, COORDINATOR_ABSENT_LABEL } from '../src/worker/supervision.ts';

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
    brokerRestartedDuringRun: false,
    terminal: false,
    ...overrides,
  });
}

describe('supervision thresholds', () => {
  test('literal thresholds', () => {
    assert.deepEqual(SUPERVISION, { inactivityAlertMs: 1_200_000, elapsedAlertMs: 7_200_000, coordinatorAbsentMs: 90_000 });
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
