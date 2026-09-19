// A budget for one run. Exhaustion refuses the NEXT turn and nothing else:
// the turn that spent the last of it finishes, what was queued stays queued,
// the session survives, and raising the budget is a new run with a higher
// approvalRevision — the re-approval mechanism that already exists.
//
// Its own broker, because every case here needs several scripted turns in a
// row and a fixed per-turn token count to reason about.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { startTestBroker, DEFAULT_FAKE_ADAPTER, type TestBroker } from './helpers/broker-client.ts';
import { makeTempRoot, waitFor, sleep, type TempRoot } from './helpers/temp.ts';
import { jobV2, coordination } from './helpers/fixtures.ts';
import { script } from './helpers/scenario.ts';
import type { EventRecord, RunBudgetView, TaskView } from '../src/shared/types.ts';

// The fake CLI reports the same usage on every turn (test/helpers/fake-claude-process.ts):
// input 10 + output 10 + cache read 5 + cache write 2.
const TOKENS_PER_TURN = 27;

let temp: TempRoot;
let broker: TestBroker;
let nextWorkspace = 0;

/** Each case gets its own checkout so the writer lock never couples them. */
async function freshWorkspace(): Promise<string> {
  const workspace = path.join(temp.root, `ws-${nextWorkspace++}`);
  await mkdir(path.join(workspace, 'src'), { recursive: true });
  return workspace;
}

async function register(threadId: string): Promise<{ taskId: string; taskHandle: string }> {
  const response = await broker.api('/api/tasks/register', { method: 'POST', headers: broker.bearerHeaders(), body: JSON.stringify({ codexThreadId: threadId, source: 'codex-thread' }) });
  assert.equal(response.status, 201, response.text);
  return response.body as { taskId: string; taskHandle: string };
}

async function startRun(taskId: string, taskHandle: string, workspace: string, prompt: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const response = await broker.api(`/api/tasks/${taskId}/runs`, {
    method: 'POST', headers: broker.bearerHeaders(),
    body: JSON.stringify({ taskHandle, job: jobV2(workspace, { prompt, scope: { summary: 'src', paths: ['src/'] }, ...overrides }), observation: { mode: 'voz' } }),
  });
  assert.equal(response.status, 202, response.text);
  return (response.body as { runId: string }).runId;
}

async function view(taskId: string): Promise<TaskView> {
  const response = await broker.api(`/api/tasks/${taskId}`, { headers: broker.bearerHeaders() });
  assert.equal(response.status, 200, response.text);
  return response.body as TaskView;
}

async function events(taskId: string): Promise<EventRecord[]> {
  const response = await broker.api(`/api/tasks/${taskId}/events?cursor=0&waitMs=0&limit=2000`, { headers: broker.bearerHeaders() });
  assert.equal(response.status, 200, response.text);
  return (response.body as { events: EventRecord[] }).events;
}

async function idleAfterTurns(taskId: string, turns: number): Promise<TaskView> {
  return waitFor(async () => {
    const current = await view(taskId);
    return current.state === 'idle' && current.currentRun?.turns === turns ? current : undefined;
  }, { timeoutMs: 30000, description: `idle after ${turns} turn(s)` });
}

async function message(taskId: string, taskHandle: string, text: string): Promise<{ status: number; body: Record<string, unknown>; text: string }> {
  const response = await broker.api(`/api/tasks/${taskId}/message`, { method: 'POST', headers: broker.bearerHeaders(), body: JSON.stringify({ taskHandle, text }) });
  return { status: response.status, body: (response.body ?? {}) as Record<string, unknown>, text: response.text };
}

async function endTask(taskId: string): Promise<TaskView> {
  const ended = await broker.api(`/api/tasks/${taskId}/end`, { method: 'POST', headers: broker.bearerHeaders(), body: '{}' });
  assert.equal(ended.status, 202, ended.text);
  return waitFor(async () => {
    const current = await view(taskId);
    return current.state === 'terminal' ? current : undefined;
  }, { timeoutMs: 20000, description: 'terminal' });
}

before(async () => {
  temp = await makeTempRoot('codeorquestra-orcamento-');
  broker = await startTestBroker({ stateRoot: path.join(temp.root, 'state'), fakeAdapterPath: DEFAULT_FAKE_ADAPTER });
});
after(async () => {
  await broker?.stop();
  await temp.cleanup();
});

describe('a token budget', () => {
  test('is spent turn by turn, refuses the next turn once exhausted, and never aborts the one that exhausted it', async () => {
    const workspace = await freshWorkspace();
    const { taskId, taskHandle } = await register('thread-orcamento-tokens');
    // Two turns exceed it, one does not.
    const maxTokens = TOKENS_PER_TURN + 13;
    const runId = await startRun(taskId, taskHandle, workspace, script(['say: um']), { limits: { maxTokens } });

    const afterOne = await idleAfterTurns(taskId, 1);
    assert.deepEqual(afterOne.currentRun?.budget, { tokens: { used: TOKENS_PER_TURN, limit: maxTokens }, turns: null, runtimeSeconds: null, ratio: TOKENS_PER_TURN / maxTokens, exhausted: false } satisfies RunBudgetView);
    assert.ok(!afterOne.alerts.some((alert) => alert.startsWith('budget_')), `nenhum alerta ainda: ${afterOne.alerts.join(',')}`);

    // Turn two is accepted: 27 < 40. It is scripted slow so a third message can
    // arrive while it is still running.
    const second = await message(taskId, taskHandle, script(['say: dois', 'sleep: 1500']));
    assert.equal(second.status, 202, second.text);
    await waitFor(async () => ((await view(taskId)).state !== 'idle' ? true : undefined), { timeoutMs: 20000, description: 'turn two started' });
    const third = await message(taskId, taskHandle, script(['say: três']));
    assert.equal(third.status, 202, `enfileirar durante o turno dois ainda é aceito: ${third.text}`);

    // Turn two finishes normally. It was allowed to: only an explicit interrupt
    // aborts a turn, and a budget is not an interrupt.
    const afterTwo = await idleAfterTurns(taskId, 2);
    assert.equal(afterTwo.currentRun?.status, 'RUNNING');
    assert.equal(afterTwo.currentRun?.budget?.tokens?.used, 2 * TOKENS_PER_TURN);
    assert.equal(afterTwo.currentRun?.budget?.exhausted, true);
    assert.ok(afterTwo.alerts.includes('budget_exhausted'), afterTwo.alerts.join(','));
    assert.ok((await events(taskId)).some((event) => event.type === 'assistant_text' && event.data.text === 'dois'), 'o turno dois produziu sua resposta');

    // Named once, durably, with the numbers.
    const exhausted = (await events(taskId)).filter((event) => event.type === 'budget_exhausted');
    assert.equal(exhausted.length, 1);
    assert.equal(exhausted[0]!.runId, runId);
    assert.deepEqual(exhausted[0]!.data.tokens, { used: 2 * TOKENS_PER_TURN, limit: maxTokens });
    // Recorded after the turn was counted, so the snapshot is one a person can
    // read back: two turns done, not "one and a half".
    assert.equal(exhausted[0]!.data.turns, null);
    assert.equal(exhausted[0]!.data.exhausted, true);
    assert.match(String(exhausted[0]!.data.note), /approvalRevision/);
    // The warning came first, from supervision, and is also one-shot.
    await waitFor(async () => ((await events(taskId)).some((event) => event.type === 'alert' && event.data.alert === 'budget_warning') ? true : undefined), { timeoutMs: 10000, description: 'budget_warning no log' });
    assert.equal((await events(taskId)).filter((event) => event.type === 'alert' && event.data.alert === 'budget_warning').length, 1);

    // What was queued stays queued: the third message is never delivered.
    await sleep(1500);
    const stuck = await view(taskId);
    assert.equal(stuck.state, 'idle');
    assert.equal(stuck.currentRun?.turns, 2);
    assert.deepEqual(stuck.queue.map((entry) => entry.state), ['delivered', 'queued']);
    assert.ok(!(await events(taskId)).some((event) => event.type === 'assistant_text' && event.data.text === 'três'), 'a terceira orientação não virou turno');

    // New guidance is refused with the way forward, not silently queued.
    const fourth = await message(taskId, taskHandle, 'say: quatro');
    assert.equal(fourth.status, 409, fourth.text);
    assert.equal(fourth.body.error, 'BUDGET_EXHAUSTED');
    assert.deepEqual((fourth.body.budget as RunBudgetView).tokens, { used: 2 * TOKENS_PER_TURN, limit: maxTokens });
    assert.match(String(fourth.body.note), /limits maior/);

    // The summary a polling coordinator reads carries the budget.
    const page = (await broker.api(`/api/tasks/${taskId}/events?cursor=0&waitMs=0`, { headers: broker.bearerHeaders() })).body as { task: { currentRun: { budget: RunBudgetView | null } } };
    assert.equal(page.task.currentRun.budget?.exhausted, true);

    // Ending still works, and the session it leaves behind is resumable.
    const ended = await endTask(taskId);
    assert.equal(ended.currentRun?.status, 'COMPLETED');
    const sessionId = ended.previousSessionId;
    assert.ok(sessionId, 'a sessão sobrevive ao orçamento');

    // Raising the budget is a new run under a new approval, in the same task.
    // A changed approval revision deliberately starts a fresh Claude session;
    // the guidance that stayed
    // queued was accepted, not lost: it is delivered as soon as there is
    // budget again, right after the new prompt.
    const reopenedRunId = await startRun(taskId, taskHandle, workspace, script(['say: cinco']), {
      limits: { maxTokens: 200 },
      coordination: coordination({ approvalRevision: 2 }),
    });
    const reopened = await idleAfterTurns(taskId, 2);
    assert.notEqual(reopened.currentRun?.sessionId, sessionId);
    assert.equal(reopened.currentRun?.resumeMode, 'new');
    assert.ok((await events(taskId)).some((event) => event.runId === reopenedRunId && event.type === 'assistant_text' && event.data.text === 'três'), 'a orientação que ficou na fila foi entregue na nova execução');
    assert.deepEqual(reopened.queue.map((entry) => entry.state), ['delivered', 'delivered']);
    assert.deepEqual(reopened.currentRun?.budget?.tokens, { used: 2 * TOKENS_PER_TURN, limit: 200 });
    assert.equal(reopened.currentRun?.budget?.exhausted, false);
    assert.ok(!reopened.alerts.includes('budget_exhausted'), 'o alerta pertencia à execução anterior');
    const again = await message(taskId, taskHandle, 'say: seis');
    assert.equal(again.status, 202, again.text);
    await idleAfterTurns(taskId, 3);
    await endTask(taskId);
  });
});

describe('the other two dimensions', () => {
  test('a turn budget counts completed turns', async () => {
    const workspace = await freshWorkspace();
    const { taskId, taskHandle } = await register('thread-orcamento-turnos');
    await startRun(taskId, taskHandle, workspace, script(['say: único']), { limits: { maxTokens: 1000, maxTurns: 1 } });
    const afterOne = await idleAfterTurns(taskId, 1);
    assert.deepEqual(afterOne.currentRun?.budget, { tokens: { used: TOKENS_PER_TURN, limit: 1000 }, turns: { used: 1, limit: 1 }, runtimeSeconds: null, ratio: 1, exhausted: true });
    const refused = await message(taskId, taskHandle, 'say: dois');
    assert.equal(refused.status, 409, refused.text);
    assert.equal(refused.body.error, 'BUDGET_EXHAUSTED');
    const recorded = (await events(taskId)).filter((event) => event.type === 'budget_exhausted');
    assert.equal(recorded.length, 1);
    // Both dimensions in the record agree with the view: the turn that
    // exhausted the budget is counted as done.
    assert.deepEqual(recorded[0]!.data.turns, { used: 1, limit: 1 });
    assert.deepEqual(recorded[0]!.data.tokens, { used: TOKENS_PER_TURN, limit: 1000 });
    await endTask(taskId);
  });

  test('a runtime budget counts elapsed seconds and is noticed by supervision between turns', async () => {
    const workspace = await freshWorkspace();
    const { taskId, taskHandle } = await register('thread-orcamento-tempo');
    // The first turn always runs: exhaustion refuses the next one, never the
    // current one, and this turn alone outlives the whole budget.
    await startRun(taskId, taskHandle, workspace, script(['say: lento', 'sleep: 2500']), { limits: { maxRuntimeSeconds: 2 } });
    await idleAfterTurns(taskId, 1);
    await waitFor(async () => ((await view(taskId)).alerts.includes('budget_exhausted') ? true : undefined), { timeoutMs: 10000, description: 'supervisão nota o tempo esgotado' });
    const current = await view(taskId);
    assert.equal(current.currentRun?.budget?.runtimeSeconds?.limit, 2);
    assert.ok((current.currentRun?.budget?.runtimeSeconds?.used ?? 0) >= 2);
    assert.equal(current.currentRun?.status, 'RUNNING', 'nada foi encerrado');
    const refused = await message(taskId, taskHandle, 'say: tarde');
    assert.equal(refused.status, 409, refused.text);
    assert.equal(refused.body.error, 'BUDGET_EXHAUSTED');
    await endTask(taskId);
  });
});

describe('a job without limits', () => {
  test('has no budget, and runs as many turns as it is given without a single budget alert', async () => {
    const workspace = await freshWorkspace();
    const { taskId, taskHandle } = await register('thread-sem-orcamento');
    await startRun(taskId, taskHandle, workspace, script(['say: um']));
    await idleAfterTurns(taskId, 1);
    for (const [index, text] of ['say: dois', 'say: três'].entries()) {
      const sent = await message(taskId, taskHandle, text);
      assert.equal(sent.status, 202, sent.text);
      await idleAfterTurns(taskId, index + 2);
    }
    const done = await view(taskId);
    assert.equal(done.currentRun?.turns, 3);
    assert.equal(done.currentRun?.budget, null);
    assert.ok(!done.alerts.some((alert) => alert.startsWith('budget_')), done.alerts.join(','));
    const log = await events(taskId);
    assert.ok(!log.some((event) => event.type === 'budget_exhausted' || (event.type === 'alert' && String(event.data.alert).startsWith('budget_'))));
    const page = (await broker.api(`/api/tasks/${taskId}/events?cursor=0&waitMs=0`, { headers: broker.bearerHeaders() })).body as { task: { currentRun: { budget: RunBudgetView | null } } };
    assert.equal(page.task.currentRun.budget, null);
    await endTask(taskId);
  });
});
