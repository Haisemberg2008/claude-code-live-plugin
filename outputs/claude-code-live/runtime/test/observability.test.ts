// What a run costs and what it did, answered while it runs and after it ends.
// Three claims: the context gauge measures the prompt and presumes only the
// window, the tool counters count each call exactly once, and a finished run's
// own files answer "what did that cost" without the broker that produced them.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { startTestBroker, DEFAULT_FAKE_ADAPTER, type TestBroker } from './helpers/broker-client.ts';
import { makeTempRoot, waitFor, type TempRoot } from './helpers/temp.ts';
import { jobV2 } from './helpers/fixtures.ts';
import { script, toolDirective } from './helpers/scenario.ts';
import { CONTEXT_WINDOW_TOKENS } from '../src/shared/models.ts';
import type { TaskView } from '../src/shared/types.ts';

// The fake reports the same counters on every turn: input 10, output 10,
// cache read 5, cache creation 2.
const CONTEXT_TOKENS_PER_TURN = 10 + 5 + 2;
const OBSERVED_TOKENS_PER_TURN = CONTEXT_TOKENS_PER_TURN + 10;

let temp: TempRoot;
let broker: TestBroker;
let nextWorkspace = 0;

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

interface HistoryEntry {
  runId: string;
  status: string;
  failureCode: string | null;
  startedAt: string | null;
  endedAt: string | null;
  elapsedSeconds: number | null;
  turns: number | null;
  tokens: number | null;
  usageQuality: string;
  toolCalls: number | null;
  toolErrors: number | null;
  budgetExhausted: boolean;
}

async function history(taskId: string): Promise<HistoryEntry[]> {
  const response = await broker.api(`/api/tasks/${taskId}/runs`, { headers: broker.bearerHeaders() });
  assert.equal(response.status, 200, response.text);
  return response.body as HistoryEntry[];
}

async function idleAfterTurns(taskId: string, turns: number): Promise<TaskView> {
  return waitFor(async () => {
    const current = await view(taskId);
    return current.state === 'idle' && current.currentRun?.turns === turns ? current : undefined;
  }, { timeoutMs: 30000, description: `idle after ${turns} turn(s)` });
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
  temp = await makeTempRoot('codeorquestra-observabilidade-');
  broker = await startTestBroker({ stateRoot: path.join(temp.root, 'state'), fakeAdapterPath: DEFAULT_FAKE_ADAPTER });
});
after(async () => {
  await broker?.stop();
  await temp.cleanup();
});

describe('the context gauge', () => {
  test('measures the prompt that was sent and presumes only the window', async () => {
    const workspace = await freshWorkspace();
    const { taskId, taskHandle } = await register('thread-obs-contexto');
    const before = await view(taskId);
    assert.equal(before.currentRun, null);

    await startRun(taskId, taskHandle, workspace, script(['say: um']));
    const afterOne = await idleAfterTurns(taskId, 1);
    const context = afterOne.currentRun?.context;
    // Input plus cache read plus cache creation is exactly what went in; the
    // output tokens of that turn are not part of the next prompt.
    assert.equal(context?.lastTurnTokens, CONTEXT_TOKENS_PER_TURN);
    assert.equal(context?.windowTokens, CONTEXT_WINDOW_TOKENS['claude-fable-5-1']);
    assert.equal(context?.ratio, CONTEXT_TOKENS_PER_TURN / CONTEXT_WINDOW_TOKENS['claude-fable-5-1']);
    assert.ok(!afterOne.alerts.includes('context_high'), 'seventeen tokens is not a full window');

    // It is the LAST turn's prompt, not a running total: a context gauge that
    // only ever climbs would be a spend counter wearing the wrong label.
    const second = await broker.api(`/api/tasks/${taskId}/message`, { method: 'POST', headers: broker.bearerHeaders(), body: JSON.stringify({ taskHandle, text: 'say: dois' }) });
    assert.equal(second.status, 202, second.text);
    const afterTwo = await idleAfterTurns(taskId, 2);
    assert.equal(afterTwo.currentRun?.context?.lastTurnTokens, CONTEXT_TOKENS_PER_TURN);
    assert.equal(afterTwo.usage.claude.totalObservedTokens, 2 * OBSERVED_TOKENS_PER_TURN, 'the running total is a different number and still climbs');
    await endTask(taskId);
  });
});

describe('the tool counters', () => {
  test('count each call once, whichever way the CLI reports its outcome', async () => {
    const workspace = await freshWorkspace();
    const { taskId, taskHandle } = await register('thread-obs-ferramentas');
    await startRun(taskId, taskHandle, workspace, script([
      toolDirective('Read', { file_path: path.join(workspace, 'src', 'a.ts') }),
      toolDirective('Read', { file_path: path.join(workspace, 'src', 'b.ts') }),
      toolDirective('Bash', { command: 'npm test', $error: true }),
      // Denied by the PreToolUse hook, which the CLI then echoes back as a
      // failed result. One call, not two.
      toolDirective('Bash', { command: 'git push origin main' }),
      'say: fim',
    ]));
    const idle = await idleAfterTurns(taskId, 1);
    const tools = idle.currentRun!.tools;
    assert.equal(tools.calls, 4);
    assert.equal(tools.errors, 1, 'the blocked call is blocked, not also an error');
    assert.equal(tools.blocked, 1);
    assert.deepEqual(tools.byTool.map((tool) => [tool.name, tool.calls, tool.errors, tool.blocked]), [['Bash', 2, 1, 1], ['Read', 2, 0, 0]]);
    assert.ok(tools.byTool.every((tool) => tool.totalMs >= 0));
    assert.equal(tools.recent.length, 4);
    assert.deepEqual(tools.recent.map((call) => call.ok), [true, true, false, false]);
    assert.ok(tools.recent.every((call) => typeof call.ms === 'number'));

    // The coordinator's summary carries the counts and not the breakdown.
    const page = (await broker.api(`/api/tasks/${taskId}/events?cursor=0&waitMs=0`, { headers: broker.bearerHeaders() })).body as { task: { currentRun: { tools: Record<string, unknown> } } };
    assert.deepEqual(page.task.currentRun.tools, { calls: 4, errors: 1, blocked: 1 });
    await endTask(taskId);
  });
});

describe('the history of a task', () => {
  test('answers what each finished run cost, read from that run own files', async () => {
    const workspace = await freshWorkspace();
    const { taskId, taskHandle } = await register('thread-obs-historico');
    assert.deepEqual(await history(taskId), [], 'a task with no runs has no history to invent');

    const first = await startRun(taskId, taskHandle, workspace, script([toolDirective('Read', { file_path: path.join(workspace, 'src', 'a.ts') }), 'say: um']));
    await idleAfterTurns(taskId, 1);
    await endTask(taskId);

    const afterFirst = await history(taskId);
    assert.equal(afterFirst.length, 1);
    const entry = afterFirst[0]!;
    assert.equal(entry.runId, first);
    assert.equal(entry.status, 'COMPLETED');
    assert.equal(entry.failureCode, null);
    assert.equal(entry.turns, 1);
    assert.equal(entry.tokens, OBSERVED_TOKENS_PER_TURN);
    assert.equal(entry.usageQuality, 'reported');
    assert.equal(entry.toolCalls, 1);
    assert.equal(entry.toolErrors, 0);
    assert.equal(entry.budgetExhausted, false);
    assert.ok(typeof entry.elapsedSeconds === 'number' && entry.elapsedSeconds >= 0);
    assert.ok(entry.startedAt && entry.endedAt);

    // A second run joins the history with its own numbers, and a budget that
    // ran out is recorded as such.
    await startRun(taskId, taskHandle, workspace, script(['say: dois']), { limits: { maxTokens: 10 } });
    await idleAfterTurns(taskId, 1);
    await waitFor(async () => ((await view(taskId)).currentRun?.budget?.exhausted ? true : undefined), { timeoutMs: 20000, description: 'orçamento esgota' });
    await endTask(taskId);

    const afterSecond = await history(taskId);
    assert.equal(afterSecond.length, 2);
    assert.deepEqual(afterSecond.map((run) => run.turns), [1, 1]);
    assert.deepEqual(afterSecond.map((run) => run.budgetExhausted), [false, true]);
    assert.equal(afterSecond[1]!.tokens, OBSERVED_TOKENS_PER_TURN);
  });
});
