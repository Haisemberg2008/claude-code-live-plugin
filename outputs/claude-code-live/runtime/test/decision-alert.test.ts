// A decision nobody answered blocks the turn. Waiting is deliberately exempt
// from the inactivity alert — waiting is not idling — and the consequence was
// that a run could sit for hours emitting nothing, which from outside is
// indistinguishable from work in progress.
//
// Its own broker, because this is the one test that depends on real clock
// thresholds: sharing one with forty other tasks makes the timing a lottery.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { startTestBroker, DEFAULT_FAKE_ADAPTER } from './helpers/broker-client.ts';
import { makeTempRoot, waitFor } from './helpers/temp.ts';
import { jobV2 } from './helpers/fixtures.ts';
import { script, TEST_SUPERVISION_ENV } from './helpers/scenario.ts';
import type { EventRecord, TaskView } from '../src/shared/types.ts';

test('a pending decision stops being silent, keeps saying so, and goes quiet once answered', async () => {
  const temp = await makeTempRoot('codeorquestra-decisao-');
  const workspace = path.join(temp.root, 'workspace');
  await mkdir(path.join(workspace, 'src'), { recursive: true });
  const broker = await startTestBroker({
    stateRoot: path.join(temp.root, 'state'),
    fakeAdapterPath: DEFAULT_FAKE_ADAPTER,
    env: { [TEST_SUPERVISION_ENV]: JSON.stringify({ inactivityAlertMs: 600000, elapsedAlertMs: 600000, coordinatorAbsentMs: 600000, decisionPendingMs: 2000 }) },
  });
  try {
    const registered = await broker.api('/api/tasks/register', { method: 'POST', headers: broker.bearerHeaders(), body: JSON.stringify({ codexThreadId: 'thread-decisao', source: 'codex-thread' }) });
    assert.equal(registered.status, 201, registered.text);
    const { taskId, taskHandle } = registered.body as { taskId: string; taskHandle: string };

    const started = await broker.api(`/api/tasks/${taskId}/runs`, {
      method: 'POST', headers: broker.bearerHeaders(),
      body: JSON.stringify({
        taskHandle,
        job: jobV2(workspace, { prompt: script(['ask: Qual banco usar?', 'say: obrigado']), scope: { summary: 'src', paths: ['src/'] } }),
        observation: { mode: 'voz' },
      }),
    });
    assert.equal(started.status, 202, started.text);
    const { runId } = started.body as { runId: string };

    const view = async (): Promise<TaskView> => (await broker.api(`/api/tasks/${taskId}`, { headers: broker.bearerHeaders() })).body as TaskView;
    const alertsInLog = async (): Promise<EventRecord[]> => {
      const page = (await broker.api(`/api/tasks/${taskId}/events?cursor=0`, { headers: broker.bearerHeaders() })).body as { events: EventRecord[] };
      return page.events.filter((event) => event.type === 'alert' && (event.data as { alert?: string }).alert === 'decision_pending');
    };

    const waiting = await waitFor(async () => { const v = await view(); return v.state === 'waiting_question' ? v : undefined; }, { timeoutMs: 20000, description: 'a pergunta chega' });
    const request = waiting.pendingRequests[0]!;

    // Waits on the durable event, not the view: the alert is appended
    // asynchronously, so the view can show it a beat before the log has it.
    await waitFor(async () => ((await alertsInLog()).length >= 1 ? true : undefined), { timeoutMs: 20000, intervalMs: 250, description: 'a decisão parada deixa de ser silenciosa' });
    const first = await alertsInLog();
    const data = first[0]!.data as { pendingRequests?: number; waitingForSeconds?: number };
    assert.equal(data.pendingRequests, 1);
    assert.equal(typeof data.waitingForSeconds, 'number', JSON.stringify(data));

    // Inactivity stays silent throughout: waiting is not idling, and that rule
    // is unchanged — this is a second, different claim.
    assert.ok(!(await view()).alerts.includes('inactivity_20m'));

    // It repeats while still true: raising it once and going quiet again would
    // reproduce the silence it exists to break.
    await waitFor(async () => ((await alertsInLog()).length > first.length ? true : undefined), { timeoutMs: 20000, intervalMs: 250, description: 'o alerta repete enquanto ninguém responde' });

    // Answered: it stops being true, so it stops being reported.
    const answer = await broker.api(`/api/tasks/${taskId}/answer`, {
      method: 'POST', headers: broker.bearerHeaders(),
      body: JSON.stringify({ taskHandle, requestId: request.requestId, runId, decision: 'answer', answers: { 'Qual banco usar?': 'PostgreSQL' } }),
    });
    assert.equal(answer.status, 200, answer.text);
    await waitFor(async () => (!(await view()).alerts.includes('decision_pending') ? true : undefined), { timeoutMs: 20000, intervalMs: 250, description: 'respondida, deixa de ser reportada' });
  } finally {
    await broker.stop();
    await temp.cleanup();
  }
});
