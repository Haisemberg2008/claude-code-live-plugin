// The brake is a ladder, and every rung is the coordinator's to climb: the
// runtime names a loop, tightens what the run may do without asking, and ends
// the session once the turn finishes. None of it is automatic, none of it
// aborts a turn, and a restriction can only ever ask for more decisions.
//
// Its own broker, because these cases need scripted multi-turn runs and exact
// control over when an action lands relative to a running turn.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { startTestBroker, DEFAULT_FAKE_ADAPTER, type TestBroker } from './helpers/broker-client.ts';
import { makeTempRoot, waitFor, sleep, type TempRoot } from './helpers/temp.ts';
import { jobV2 } from './helpers/fixtures.ts';
import { script, toolDirective } from './helpers/scenario.ts';
import type { EventRecord, TaskView } from '../src/shared/types.ts';

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

async function startRun(taskId: string, taskHandle: string, workspace: string, prompt: string): Promise<string> {
  const response = await broker.api(`/api/tasks/${taskId}/runs`, {
    method: 'POST', headers: broker.bearerHeaders(),
    body: JSON.stringify({ taskHandle, job: jobV2(workspace, { prompt, scope: { summary: 'src', paths: ['src/'] } }), observation: { mode: 'voz' } }),
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

async function post(taskId: string, action: string, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown>; text: string }> {
  const response = await broker.api(`/api/tasks/${taskId}/${action}`, { method: 'POST', headers: broker.bearerHeaders(), body: JSON.stringify(body) });
  return { status: response.status, body: (response.body ?? {}) as Record<string, unknown>, text: response.text };
}

async function waitForState(taskId: string, states: string[], timeoutMs = 30000): Promise<TaskView> {
  return waitFor(async () => {
    const current = await view(taskId);
    return states.includes(current.state) ? current : undefined;
  }, { timeoutMs, description: `state ${states.join('|')}` });
}

before(async () => {
  temp = await makeTempRoot('codeorquestra-freio-');
  broker = await startTestBroker({ stateRoot: path.join(temp.root, 'state'), fakeAdapterPath: DEFAULT_FAKE_ADAPTER });
});
after(async () => {
  await broker?.stop();
  await temp.cleanup();
});

describe('a run that repeats itself', () => {
  test('is named once, with the evidence, and is not stopped, throttled or restricted by the runtime', async () => {
    const workspace = await freshWorkspace();
    const { taskId, taskHandle } = await register('thread-freio-laco');
    const failing = toolDirective('Bash', { command: 'npm test', $error: true });
    const runId = await startRun(taskId, taskHandle, workspace, script([failing, failing, failing, failing, failing, 'say: desisti']));

    const alerts = async (): Promise<EventRecord[]> => (await events(taskId)).filter((event) => event.type === 'alert' && (event.data as { alert?: string }).alert === 'thrashing');
    await waitFor(async () => ((await alerts()).length >= 1 ? true : undefined), { timeoutMs: 30000, intervalMs: 200, description: 'o laço deixa de ser invisível' });

    const first = (await alerts())[0]!;
    assert.equal(first.runId, runId);
    const data = first.data as { pattern?: string; tool?: string; count?: number; inputPreview?: string; action?: string; note?: string };
    assert.equal(data.pattern, 'repeat');
    assert.equal(data.tool, 'Bash');
    assert.equal(data.count, 3, 'three identical failing calls are enough to say something');
    assert.match(String(data.inputPreview), /npm test/, 'the evidence names the call, not just the tool');
    assert.equal(data.action, 'none');
    assert.match(String(data.note), /set_policy/, 'the alert says what can be done about it');

    const idle = await waitForState(taskId, ['idle']);
    // The whole point: naming a loop changes nothing by itself.
    assert.equal(idle.currentRun?.status, 'RUNNING', 'nothing was ended');
    assert.equal(idle.currentRun?.policy, null, 'nothing was restricted');
    assert.equal(idle.currentRun?.endingAfterTurn, false);
    assert.ok(idle.alerts.includes('thrashing'), idle.alerts.join(','));
    assert.deepEqual({ pattern: idle.currentRun?.thrashing?.pattern, tool: idle.currentRun?.thrashing?.tool, count: idle.currentRun?.thrashing?.count }, { pattern: 'repeat', tool: 'Bash', count: 3 });
    assert.ok((await events(taskId)).some((event) => event.type === 'assistant_text' && event.data.text === 'desisti'), 'the run was allowed to finish what it was doing');

    // Said once. Two more identical failures followed the third and neither
    // repeated the alert, because the shape had already been reported.
    assert.equal((await alerts()).length, 1);
    await post(taskId, 'end', {});
    await waitForState(taskId, ['terminal']);
  });

  test('a healthy run is never accused of looping', async () => {
    const workspace = await freshWorkspace();
    const { taskId, taskHandle } = await register('thread-freio-saudavel');
    const read = toolDirective('Read', { file_path: path.join(workspace, 'src', 'a.ts') });
    await startRun(taskId, taskHandle, workspace, script([read, read, read, 'say: tudo certo']));
    const idle = await waitForState(taskId, ['idle']);
    assert.equal(idle.currentRun?.thrashing, null, 'reading the same file three times is routine');
    assert.ok(!idle.alerts.includes('thrashing'), idle.alerts.join(','));
    assert.equal((await events(taskId)).filter((event) => event.type === 'alert').length, 0);
    await post(taskId, 'end', {});
    await waitForState(taskId, ['terminal']);
  });
});

describe('restricting a run that is already going', () => {
  test('takes effect on the next tool call, mid-turn, and only ever asks for a decision', async () => {
    const workspace = await freshWorkspace();
    const { taskId, taskHandle } = await register('thread-freio-restricao');
    await startRun(taskId, taskHandle, workspace, script(['sleep: 1500', toolDirective('Bash', { command: 'npm test' }), 'say: pronto']));
    await waitForState(taskId, ['busy_tool']);

    // A restriction needs a recorded reason, like every other authorization.
    const noReason = await post(taskId, 'policy', { taskHandle, escalate: 'commands' });
    assert.equal(noReason.status, 400, noReason.text);
    assert.equal(noReason.body.error, 'POLICY_REASON_REQUIRED');
    const bogus = await post(taskId, 'policy', { taskHandle, escalate: 'tudo', reason: 'x' });
    assert.equal(bogus.status, 400, bogus.text);
    assert.equal(bogus.body.error, 'POLICY_INVALID');

    const applied = await post(taskId, 'policy', { taskHandle, escalate: 'commands', reason: 'Está repetindo o mesmo comando.' });
    assert.equal(applied.status, 200, applied.text);
    assert.equal(applied.body.requested, 'commands');

    // The view reports it only once the worker confirms; until then it would
    // be a safety claim nobody applied.
    const restricted = await waitFor(async () => {
      const current = await view(taskId);
      return current.currentRun?.policy ? current : undefined;
    }, { timeoutMs: 20000, description: 'a restrição é confirmada pelo worker' });
    assert.equal(restricted.currentRun?.policy?.escalate, 'commands');
    assert.equal(restricted.currentRun?.policy?.reason, 'Está repetindo o mesmo comando.');
    const changed = (await events(taskId)).find((event) => event.type === 'policy_changed')!;
    assert.equal(changed.data.duringTurn, true, 'applied without waiting for the turn to end');

    // The command that follows would have been allowed; now it asks.
    const waiting = await waitForState(taskId, ['waiting_permission'], 20000);
    const request = waiting.pendingRequests[0]!;
    assert.equal(request.tool, 'Bash');
    assert.match(String(request.reason), /POLICY_ESCALATE/);
    const answered = await post(taskId, 'answer', { taskHandle, requestId: request.requestId, runId: waiting.currentRun!.runId, decision: 'allow' });
    assert.equal(answered.status, 200, answered.text);

    const idle = await waitForState(taskId, ['idle']);
    assert.equal(idle.currentRun?.status, 'RUNNING', 'restricting keeps the work alive; that is what it is for');
    assert.ok((await events(taskId)).some((event) => event.type === 'assistant_text' && event.data.text === 'pronto'));

    // Lifting it is the same path, recorded the same way.
    const lifted = await post(taskId, 'policy', { taskHandle, escalate: 'none', reason: 'Resolvido; volta ao contrato.' });
    assert.equal(lifted.status, 200, lifted.text);
    await waitFor(async () => ((await view(taskId)).currentRun?.policy === null ? true : undefined), { timeoutMs: 20000, description: 'a restrição é removida' });
    await post(taskId, 'end', {});
    await waitForState(taskId, ['terminal']);
  });
});

describe('ending after the turn instead of interrupting it', () => {
  test('waits for the turn, refuses new guidance, and closes COMPLETED', async () => {
    const workspace = await freshWorkspace();
    const { taskId, taskHandle } = await register('thread-freio-fim');
    await startRun(taskId, taskHandle, workspace, script(['sleep: 2000', 'say: terminei sozinho']));
    await waitForState(taskId, ['busy_tool']);

    const requested = await post(taskId, 'end', { taskHandle, afterTurn: true });
    assert.equal(requested.status, 202, requested.text);
    assert.deepEqual(requested.body, { ending: true, afterTurn: true });

    const pending = await view(taskId);
    assert.equal(pending.currentRun?.endingAfterTurn, true);
    assert.equal(pending.state, 'busy_tool', 'the turn was not interrupted');

    // Nothing new is accepted for a session that is closing.
    const refused = await post(taskId, 'message', { taskHandle, text: 'say: tarde demais' });
    assert.equal(refused.status, 409, refused.text);
    assert.equal(refused.body.error, 'ENDING');

    const terminal = await waitForState(taskId, ['terminal'], 30000);
    assert.equal(terminal.currentRun?.status, 'COMPLETED', 'nothing was cut short, so nothing reports as cancelled');
    assert.equal(terminal.currentRun?.turns, 1);
    const log = await events(taskId);
    assert.ok(log.some((event) => event.type === 'end_after_turn_requested'));
    assert.ok(log.some((event) => event.type === 'turn_completed'), 'the turn completed on its own');
    assert.ok(!log.some((event) => event.type === 'turn_interrupted'), 'no interrupt was ever sent');
    assert.ok(log.some((event) => event.type === 'assistant_text' && event.data.text === 'terminei sozinho'), 'the turn produced its whole answer');
  });

  test('ending now still interrupts and still reports CANCELLED', async () => {
    const workspace = await freshWorkspace();
    const { taskId, taskHandle } = await register('thread-freio-fim-agora');
    await startRun(taskId, taskHandle, workspace, script(['sleep: 60000', 'say: nunca']));
    await waitForState(taskId, ['busy_tool']);
    const ended = await post(taskId, 'end', { taskHandle });
    assert.equal(ended.status, 202, ended.text);
    assert.deepEqual(ended.body, { ending: true, afterTurn: false });
    const terminal = await waitForState(taskId, ['terminal'], 30000);
    assert.equal(terminal.currentRun?.status, 'CANCELLED', 'stopping work in the middle is reported as what it is');
  });

  test('asked while already idle, it ends there and then', async () => {
    const workspace = await freshWorkspace();
    const { taskId, taskHandle } = await register('thread-freio-fim-ocioso');
    await startRun(taskId, taskHandle, workspace, script(['say: pronto']));
    await waitForState(taskId, ['idle']);
    const ended = await post(taskId, 'end', { taskHandle, afterTurn: true });
    assert.equal(ended.status, 202, ended.text);
    assert.equal(ended.body.afterTurn, false, 'there is no turn to wait for');
    const terminal = await waitForState(taskId, ['terminal'], 30000);
    assert.equal(terminal.currentRun?.status, 'COMPLETED');
    await sleep(50);
  });
});
