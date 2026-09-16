// End-to-end task lifecycle through a real broker and real worker processes.
// The only substituted boundary is the Claude Code *process*: a fake that
// speaks the same stream-json control protocol (plus a fake read-only `claude`
// launcher for preflight and /usage). No authenticated CLI is ever started.
// A run is one durable Claude session: it stays open (idle) between turns and
// ends only on explicit `end` (COMPLETED/CANCELLED), preparation failure
// (FAIL) or loss of the worker (UNCERTAIN). Covers identity bootstrap, trust
// gating, exact model and Extra effort, message queue, interrupt,
// permission/question lifecycle, alerts that never kill, locks, scoped
// termination including real descendants, telemetry failure tolerance,
// fail-closed adapters, restart recovery, the SSE history-to-live boundary
// and model changes between turns.
import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile, symlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { git } from '../src/broker/worktree.ts';
import { startTestBroker, DEFAULT_FAKE_ADAPTER, CLIENT_HEADER_NAME, CSRF_HEADER_NAME, CSRF_HEADER_VALUE, type TestBroker } from './helpers/broker-client.ts';
import { makeTempRoot, waitFor, sleep, type TempRoot } from './helpers/temp.ts';
import { isProcessAlive } from './helpers/process.ts';
import { jobV2, coordination, FABLE, OPUS } from './helpers/fixtures.ts';
import { script, toolDirective, FAKE_TRACE_DIR_ENV, TEST_SUPERVISION_ENV, type TraceEntry, type LauncherTraceEntry } from './helpers/scenario.ts';
import { holdFileWithoutDeleteShare, isPwshAvailable } from './helpers/pwsh.ts';
import { readProcessCreationIdentity } from '../src/broker/process-identity.ts';

const isWindows = process.platform === 'win32';
const pwsh = isWindows && (await isPwshAvailable());
const windowsOnly = !pwsh && (isWindows ? 'pwsh is required on Windows for the sharing-mode regression' : 'Windows sharing semantics');

interface TaskView {
  taskId: string;
  threadId: string;
  workspace: string;
  state: string;
  simulated: boolean;
  alerts: string[];
  coordinatorPresence: 'present' | 'absent';
  coordinatorLastSeenAt: string | null;
  requiresReview: boolean;
  currentRun: null | {
    runId: string;
    status: string;
    sessionId: string | null;
    requestedModel: string;
    modelReason: string;
    observedModel: string | null;
    effortConfigured: string;
    effortObservedByCli: string | null;
    effortConfirmed: string | null;
    currentTool: string | null;
    workerPid: number | null;
    failureStage: string | null;
    failureCode: string | null;
    telemetryFailures: number;
    turns: number;
  };
  previousSessionId: string | null;
  pendingRequests: Array<{ requestId: string; runId: string; kind: 'permission' | 'question'; tool: string; state: string }>;
  queue: Array<{ messageId: string; source: string; state: 'queued' | 'delivered' | 'requires_review'; receivedAt: string; deliveredAt: string | null }>;
  quota: { observedAt: string | null; attemptedAt: string | null; recommendation: string };
  usage: {
    claude: { quality: string; turns: number; inputTokens: number; outputTokens: number; cachedInputTokens: number; cacheWriteInputTokens: number; totalObservedTokens: number };
    codex: { quality: string; failure: { code: string } | null };
  };
  changedFiles: { observed: string[]; claudeAuthored: string[] };
  reviewPending: boolean;
}

interface EventRecord { seq: number; gseq?: number; type: string; runId?: string; toolUseId?: string; data: Record<string, unknown> }

let temp: TempRoot;
let broker: TestBroker;
let workspaceA: string;
let workspaceB: string;
let traceDir: string;
let repoWorkspace = '';
const fakeAdapter = DEFAULT_FAKE_ADAPTER;

async function register(threadId: string): Promise<{ taskId: string; taskHandle: string }> {
  let response;
  try {
    response = await broker.api('/api/tasks/register', { method: 'POST', headers: broker.bearerHeaders(), body: JSON.stringify({ codexThreadId: threadId, source: 'codex-thread' }) });
  } catch (error) {
    // A transport failure here means the broker itself died; say why instead of
    // reporting an opaque "fetch failed" for every later case.
    throw new Error(`registro falhou (${(error as Error).message}). broker exitCode=${broker.process.child.exitCode} stderr:\n${broker.process.stderrText.slice(-3000)}`);
  }
  assert.equal(response.status, 201, response.text);
  return response.body as { taskId: string; taskHandle: string };
}

async function approveTrust(taskId: string, workspace: string): Promise<void> {
  const inventory = await broker.api(`/api/tasks/${taskId}/inventory?workspace=${encodeURIComponent(workspace)}`, { headers: broker.bearerHeaders() });
  assert.equal(inventory.status, 200, inventory.text);
  const trust = await broker.api(`/api/tasks/${taskId}/trust`, { method: 'POST', headers: broker.bearerHeaders(), body: JSON.stringify({ workspace, approvalRevision: 1, approvedItems: 'all', note: 'aprovado no harness' }) });
  assert.equal(trust.status, 200, trust.text);
}

async function startRun(taskId: string, taskHandle: string, job: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<{ runId: string }> {
  const response = await broker.api(`/api/tasks/${taskId}/runs`, { method: 'POST', headers: broker.bearerHeaders(), body: JSON.stringify({ taskHandle, job, ...extra, observation: { mode: 'voz' } }) });
  assert.equal(response.status, 202, response.text);
  return response.body as { runId: string };
}

async function task(taskId: string): Promise<TaskView> {
  const response = await broker.api(`/api/tasks/${taskId}`, { headers: broker.bearerHeaders() });
  assert.equal(response.status, 200, response.text);
  return response.body as TaskView;
}

async function events(taskId: string, cursor = 0): Promise<EventRecord[]> {
  const response = await broker.api(`/api/tasks/${taskId}/events?cursor=${cursor}&waitMs=0&limit=2000`, { headers: broker.bearerHeaders() });
  assert.equal(response.status, 200, response.text);
  return (response.body as { events: EventRecord[] }).events;
}

async function waitForRunStatus(taskId: string, statuses: string[], timeoutMs = 30000): Promise<TaskView> {
  return waitFor(async () => {
    const view = await task(taskId);
    return view.currentRun && statuses.includes(view.currentRun.status) ? view : undefined;
  }, { timeoutMs, description: `run status ${statuses.join('|')}` });
}

async function diagnostics(taskId: string): Promise<string> {
  const parts: string[] = [];
  try {
    const view = await task(taskId);
    parts.push(`view: ${JSON.stringify({ state: view.state, run: view.currentRun, pending: view.pendingRequests.length, queue: view.queue.length })}`);
    const log = await events(taskId);
    parts.push(`events: ${log.slice(-15).map((event) => `${event.type}${event.data.code ? `(${String(event.data.code)})` : ''}`).join(' > ')}`);
  } catch (error) {
    parts.push(`view unavailable: ${(error as Error).message}`);
  }
  try {
    const log = await readFile(path.join(broker.stateRoot, 'broker', 'broker.log'), 'utf8');
    parts.push(`broker.log tail:\n${log.slice(-3000)}`);
  } catch {
    parts.push('broker.log unavailable');
  }
  return parts.join('\n');
}

async function waitForState(taskId: string, states: string | string[], timeoutMs = 30000): Promise<TaskView> {
  const wanted = Array.isArray(states) ? states : [states];
  try {
    return await waitFor(async () => {
      const view = await task(taskId);
      return wanted.includes(view.state) ? view : undefined;
    }, { timeoutMs, description: `task state ${wanted.join('|')}` });
  } catch (error) {
    throw new Error(`${(error as Error).message}\n${await diagnostics(taskId)}`);
  }
}

/** Ends any run a failed test left active so one failure cannot cascade through the writer lock. */
async function endLeftovers(): Promise<void> {
  if (!broker) return;
  let views: TaskView[] = [];
  try {
    views = (await broker.api('/api/tasks', { headers: broker.bearerHeaders() })).body as TaskView[];
  } catch {
    return;
  }
  for (const view of views) {
    if (!view.currentRun || ['COMPLETED', 'FAIL', 'CANCELLED', 'UNCERTAIN'].includes(view.currentRun.status)) continue;
    await broker.api(`/api/tasks/${view.taskId}/end`, { method: 'POST', headers: broker.bearerHeaders(), body: '{}' }).catch(() => undefined);
    await waitFor(async () => ((await task(view.taskId)).state === 'terminal' ? true : undefined), { timeoutMs: 20000, description: 'leftover end' }).catch(() => undefined);
  }
  // A failed test may leave a checkout quarantined. Cleaning up uses the same
  // explicit, survivor-checked release the product exposes — never a shortcut
  // that would also hide a real quarantine from the next test.
  const locks = await broker.api('/api/locks', { headers: broker.bearerHeaders() }).catch(() => null);
  for (const lock of ((locks?.body ?? []) as Array<{ workspaceKey: string; quarantined: boolean; holderTaskId: string; holderRunId: string }>)) {
    if (!lock.quarantined) continue;
    await broker.api(`/api/locks/${lock.workspaceKey}/release`, { method: 'POST', headers: broker.bearerHeaders(), body: JSON.stringify({ note: 'limpeza entre testes', confirmHistoricalRisk: true, expectedTaskId: lock.holderTaskId, expectedRunId: lock.holderRunId }) }).catch(() => undefined);
  }
}

async function waitForEvent(taskId: string, predicate: (event: EventRecord) => boolean, timeoutMs = 20000): Promise<EventRecord> {
  return waitFor(async () => (await events(taskId)).find(predicate), { timeoutMs, description: 'event' });
}

async function endTask(taskId: string): Promise<TaskView> {
  const ended = await broker.api(`/api/tasks/${taskId}/end`, { method: 'POST', headers: broker.bearerHeaders(), body: '{}' });
  assert.equal(ended.status, 202, ended.text);
  return waitForState(taskId, 'terminal', 20000);
}

async function readTrace(pid: number): Promise<TraceEntry[]> {
  const content = await readFile(path.join(traceDir, `${pid}.jsonl`), 'utf8');
  return content.split('\n').filter(Boolean).map((line) => JSON.parse(line) as TraceEntry);
}

async function launcherTrace(): Promise<LauncherTraceEntry[]> {
  try {
    return (await readFile(path.join(traceDir, 'launcher.jsonl'), 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line) as LauncherTraceEntry);
  } catch {
    return [];
  }
}

function devJob(workspace: string, prompt: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return jobV2(workspace, { prompt, scope: { summary: 'src', paths: ['src/'] }, ...overrides });
}

before(async () => {
  temp = await makeTempRoot('codeorquestra-tasks-');
  workspaceA = path.join(temp.root, 'ws-a');
  workspaceB = path.join(temp.root, 'ws-b');
  traceDir = path.join(temp.root, 'trace');
  await mkdir(path.join(workspaceA, 'src'), { recursive: true });
  await mkdir(path.join(workspaceB, 'src'), { recursive: true });
  await mkdir(traceDir, { recursive: true });
  await writeFile(path.join(workspaceA, 'CLAUDE.md'), '# projeto A\n');
  // A real repository, for the worktree tests: worktrees need a ref to branch
  // from, and the plain workspaces above deliberately have no .git.
  repoWorkspace = path.join(temp.root, 'ws-repo');
  await mkdir(path.join(repoWorkspace, 'src'), { recursive: true });
  await writeFile(path.join(repoWorkspace, 'CLAUDE.md'), '# projeto com git\n');
  await writeFile(path.join(repoWorkspace, 'src', 'index.ts'), 'export const ok = true;\n');
  for (const args of [['init', '--initial-branch=main'], ['config', 'user.email', 'h@example.invalid'], ['config', 'user.name', 'H'], ['config', 'commit.gpgsign', 'false'], ['config', 'core.autocrlf', 'false'], ['add', '.'], ['commit', '-m', 'base']]) {
    const result = await git(args, repoWorkspace);
    assert.equal(result.code, 0, `git ${args.join(' ')}: ${result.stderr}`);
  }
  broker = await startTestBroker({
    stateRoot: path.join(temp.root, 'state'),
    fakeAdapterPath: fakeAdapter,
    env: {
      [FAKE_TRACE_DIR_ENV]: traceDir,
      [TEST_SUPERVISION_ENV]: JSON.stringify({ inactivityAlertMs: 1500, elapsedAlertMs: 600000, coordinatorAbsentMs: 1000, decisionPendingMs: 5000 }),
    },
  });
});
after(async () => {
  await broker?.stop();
  await temp.cleanup();
});
afterEach(async (context) => {
  // Only failed tests leave runs behind; ending them keeps later tests honest.
  const passed = (context as unknown as { passed?: boolean }).passed;
  if (passed !== false) await endLeftovers();
  else await endLeftovers();
});

describe('task identity bootstrap', () => {
  test('registration mints an unguessable handle and rejects handle-less or foreign starts', async () => {
    const { taskId, taskHandle } = await register('thread-bootstrap');
    assert.match(taskId, /^task-[a-f0-9]{16}$/);
    assert.match(taskHandle, /^[A-Za-z0-9_-]{43,}$/);
    const noHandle = await broker.api(`/api/tasks/${taskId}/runs`, { method: 'POST', headers: broker.bearerHeaders(), body: JSON.stringify({ job: devJob(workspaceB, 'say: oi'), observation: { mode: 'voz' } }) });
    assert.equal(noHandle.status, 403);
    assert.deepEqual(noHandle.body, { error: 'TASK_HANDLE_REQUIRED' });
    const wrongHandle = await broker.api(`/api/tasks/${taskId}/runs`, { method: 'POST', headers: broker.bearerHeaders(), body: JSON.stringify({ taskHandle: 'x'.repeat(43), job: devJob(workspaceB, 'say: oi'), observation: { mode: 'voz' } }) });
    assert.equal(wrongHandle.status, 403);
    assert.deepEqual(wrongHandle.body, { error: 'TASK_HANDLE_INVALID' });
    const other = await register('thread-other');
    const crossTask = await broker.api(`/api/tasks/${taskId}/runs`, { method: 'POST', headers: broker.bearerHeaders(), body: JSON.stringify({ taskHandle: other.taskHandle, job: devJob(workspaceB, 'say: oi'), observation: { mode: 'voz' } }) });
    assert.equal(crossTask.status, 403);
    assert.deepEqual(crossTask.body, { error: 'TASK_HANDLE_MISMATCH' });
    const badThread = await broker.api('/api/tasks/register', { method: 'POST', headers: broker.bearerHeaders(), body: JSON.stringify({ codexThreadId: '../escape', source: 'codex-thread' }) });
    assert.equal(badThread.status, 400);
    assert.deepEqual(badThread.body, { error: 'THREAD_ID_INVALID' });
    const again = await register('thread-bootstrap');
    assert.equal(again.taskId, taskId, 'the same Codex thread maps to one durable task');
    assert.notEqual(again.taskHandle, taskHandle, 'a fresh registration rotates the handle');
    const stale = await broker.api(`/api/tasks/${taskId}/runs`, { method: 'POST', headers: broker.bearerHeaders(), body: JSON.stringify({ taskHandle, job: devJob(workspaceB, 'say: oi'), observation: { mode: 'voz' } }) });
    assert.equal(stale.status, 403, 'the rotated-out handle no longer authorizes');
    const browserStart = await broker.api(`/api/tasks/${taskId}/runs`, { method: 'POST', headers: broker.browserActionHeaders(), body: JSON.stringify({ taskHandle: again.taskHandle, job: devJob(workspaceB, 'say: oi'), observation: { mode: 'voz' } }) });
    assert.equal(browserStart.status, 403, 'runs start from the coordinator surfaces, never from the browser');
  });

  test('a task-scoped dashboard bootstrap cannot see or act on another task', async () => {
    const a = await register('thread-scope-a');
    const b = await register('thread-scope-b');
    const noHandle = await broker.api('/api/dashboard-url', { method: 'POST', headers: broker.bearerHeaders({ [CLIENT_HEADER_NAME]: 'mcp' }), body: '{}' });
    assert.equal(noHandle.status, 403);
    assert.deepEqual(noHandle.body, { error: 'TASK_HANDLE_REQUIRED' });
    const link = await broker.api('/api/dashboard-url', { method: 'POST', headers: broker.bearerHeaders({ [CLIENT_HEADER_NAME]: 'mcp' }), body: JSON.stringify({ taskHandle: a.taskHandle }) });
    assert.equal(link.status, 200, link.text);
    const url = (link.body as { url: string }).url;
    const redirect = await fetch(url, { redirect: 'manual' });
    await redirect.text();
    assert.equal(redirect.status, 303);
    const cookie = (redirect.headers.get('set-cookie') ?? '').split(';')[0]!;
    const status = await broker.api('/api/status', { headers: { cookie } });
    assert.equal(status.status, 200);
    const body = status.body as { identity: { taskScope: string }; tasks: Array<{ taskId: string }> };
    assert.equal(body.identity.taskScope, a.taskId);
    assert.deepEqual(body.tasks.map((t) => t.taskId), [a.taskId]);
    const foreign = await broker.api(`/api/tasks/${b.taskId}`, { headers: { cookie } });
    assert.equal(foreign.status, 404);
    assert.deepEqual(foreign.body, { error: 'TASK_NOT_FOUND' });
    const foreignAction = await broker.api(`/api/tasks/${b.taskId}/message`, { method: 'POST', headers: { cookie, [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE, origin: broker.baseUrl, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'x' }) });
    assert.equal(foreignAction.status, 404);
    const reuse = await fetch(url, { redirect: 'manual' });
    await reuse.text();
    assert.equal(reuse.status, 403, 'the link is single-use');
  });
});

describe('trust gating and run with exact model, Extra effort and a durable session', () => {
  test('an unapproved workspace with customizations cannot start; approval unlocks it; a material change invalidates it', async () => {
    const { taskId, taskHandle } = await register('thread-trust');
    const blocked = await broker.api(`/api/tasks/${taskId}/runs`, { method: 'POST', headers: broker.bearerHeaders(), body: JSON.stringify({ taskHandle, job: devJob(workspaceA, 'say: oi'), observation: { mode: 'voz' } }) });
    assert.equal(blocked.status, 409, blocked.text);
    const body = blocked.body as { error: string; reason: string; pending: string[] };
    assert.equal(body.error, 'WORKSPACE_NOT_TRUSTED');
    assert.equal(body.reason, 'NOT_APPROVED');
    assert.deepEqual(body.pending, ['CLAUDE.md']);
    await approveTrust(taskId, workspaceA);
    await startRun(taskId, taskHandle, devJob(workspaceA, 'say: agora sim'));
    await waitForState(taskId, 'idle');
    const ended = await endTask(taskId);
    assert.equal(ended.currentRun?.status, 'COMPLETED');
    await writeFile(path.join(workspaceA, 'CLAUDE.md'), '# projeto A alterado\n');
    const invalidated = await broker.api(`/api/tasks/${taskId}/runs`, { method: 'POST', headers: broker.bearerHeaders(), body: JSON.stringify({ taskHandle, job: devJob(workspaceA, 'say: oi'), observation: { mode: 'voz' } }) });
    assert.equal(invalidated.status, 409);
    assert.equal((invalidated.body as { reason: string }).reason, 'FINGERPRINT_CHANGED');
    await approveTrust(taskId, workspaceA);
  });

  test('the worker launches the CLI process with literal flags, records requested versus observed model and derives the legacy files on end', async () => {
    const { taskId, taskHandle } = await register('thread-run');
    await approveTrust(taskId, workspaceA);
    const { runId } = await startRun(taskId, taskHandle, devJob(workspaceA, script(['say: Olá mundo', 'thinking: oculto', toolDirective('Read', { file_path: path.join(workspaceA, 'CLAUDE.md') })])));
    await waitForEvent(taskId, (event) => event.type === 'turn_completed');
    const idle = await waitForState(taskId, 'idle');
    assert.equal(idle.currentRun?.status, 'RUNNING', 'the session stays open between turns');
    assert.equal(idle.currentRun?.runId, runId);
    assert.equal(idle.simulated, true);
    assert.equal(idle.currentRun?.requestedModel, FABLE);
    assert.equal(idle.currentRun?.observedModel, FABLE);
    assert.equal(idle.currentRun?.effortConfigured, 'xhigh');
    assert.equal(idle.currentRun?.effortObservedByCli, 'xhigh', 'the fake CLI echoes the configured effort in init');
    assert.equal(idle.currentRun?.effortConfirmed, null, 'no server confirmation exists; only the sent configuration');
    assert.match(idle.currentRun?.sessionId ?? '', /^[0-9a-f-]{36}$/);
    assert.equal(idle.currentRun?.turns, 1);
    assert.equal(idle.reviewPending, true);
    assert.equal(idle.quota.recommendation, 'ok', 'the fake launcher served /usage');
    assert.match(idle.quota.observedAt ?? '', /^\d{4}-/);
    assert.equal(idle.usage.claude.quality, 'reported');
    assert.equal(idle.usage.claude.turns, 1);
    assert.equal(idle.usage.claude.inputTokens, 10);
    assert.equal(idle.usage.claude.outputTokens, 10);
    assert.equal(idle.usage.claude.cachedInputTokens, 5);
    assert.equal(idle.usage.claude.cacheWriteInputTokens, 2);
    assert.equal(idle.usage.claude.totalObservedTokens, 27);

    const trace = await readTrace(idle.currentRun!.workerPid!);
    const query = trace.find((entry) => entry.kind === 'query')!;
    assert.equal(query.data.model, FABLE);
    assert.equal(query.data.effort, 'xhigh');
    assert.equal(query.data.permissionMode, 'default');
    assert.equal(query.data.permissionPrompts, 'host', 'prompts are routed to this runtime, never auto-answered');
    assert.equal(query.data.permissionPromptTool, 'stdio');
    assert.equal(query.data.cwd, workspaceA);
    assert.equal(query.data.outputFormat, 'stream-json');
    assert.equal(query.data.inputFormat, 'stream-json');
    assert.equal(query.data.includePartialMessages, true);
    assert.equal(query.data.tools, 'default', 'the CLI keeps its own full coding tool preset');
    assert.equal(query.data.settingSourcesMode, 'project', 'approved project customizations are loaded, nothing else');
    assert.equal(query.data.strictMcpConfig, true);
    assert.deepEqual(query.data.mcpServers, [], 'no MCP server is approved in this workspace');
    assert.equal(query.data.safeMode, false, 'the development profile is not forced into safe mode');
    assert.equal(query.data.restricted, false);
    assert.equal(query.data.autoMemoryDisabled, true);
    assert.equal(query.data.envHasApiKey, false, 'inherited API credentials are stripped from the child environment');
    assert.equal(query.data.envHasProviderSwitch, false);
    assert.equal(query.data.entrypoint, 'codeorquestra');
    assert.match(String(query.data.entryArg), /fake-claude\.mjs$/, 'the resolved installed executable is passed explicitly');
    assert.equal(query.data.vendorSdkImported, false, 'no vendor SDK participates in the launch');

    // The control protocol handshake happens on the same process, not through a library.
    const initialize = trace.find((entry) => entry.kind === 'initialize')!;
    assert.deepEqual(initialize.data.hookEvents, ['PreToolUse']);
    assert.equal(initialize.data.hasAppendSystemPrompt, true, 'coordination context is appended, never replacing the builtin coding prompt');

    const done = await endTask(taskId);
    assert.equal(done.currentRun?.status, 'COMPLETED');
    const log = await events(taskId);
    const types = log.map((event) => event.type);
    for (const expected of ['run_started', 'preflight_ready', 'quota_observed', 'worker_spawned', 'cli_initialized', 'session_init', 'turn_started', 'assistant_text', 'tool_start', 'tool_result', 'turn_completed', 'session_end_requested', 'run_ended']) {
      assert.ok(types.includes(expected), `missing ${expected} in ${types.join(',')}`);
    }
    const serialized = JSON.stringify(log);
    assert.ok(!serialized.includes('oculto'), 'thinking text is never persisted');
    assert.ok(!types.includes('text_delta'), 'streamed deltas are live-only; the durable log keeps completed messages');
    assert.equal(log.filter((event) => event.type === 'assistant_text').length, 1);
    const toolStart = log.find((event) => event.type === 'tool_start')!;
    const toolResult = log.find((event) => event.type === 'tool_result')!;
    assert.equal(toolStart.toolUseId, toolResult.toolUseId, 'tool correlation preserved');
    const runDir = path.join(broker.stateRoot, 'tasks', taskId, 'runs', runId);
    const status = await waitFor(async () => {
      const parsed = JSON.parse(await readFile(path.join(runDir, 'status.json'), 'utf8'));
      return parsed.status === 'COMPLETED' ? parsed : undefined;
    }, { timeoutMs: 10000, description: 'derived status.json' });
    assert.equal(status.model, FABLE);
    assert.equal(status.requestedModel, FABLE);
    assert.equal(status.llmUsage.claude.quality, 'reported');
    assert.equal(status.llmUsage.claude.totalObservedTokens, 27);
    assert.equal(status.llmUsage.codex.quality, 'unavailable');
    const acompanhamento = await readFile(path.join(runDir, 'acompanhamento.txt'), 'utf8');
    assert.equal(acompanhamento.split('Olá mundo').length - 1, 1, 'deltas are not double counted');
    const resultado = JSON.parse(await readFile(path.join(runDir, 'resultado.json'), 'utf8'));
    assert.equal(resultado.status, 'COMPLETED');
    assert.equal(resultado.llmUsage.claude.totalObservedTokens, 27);
    const pointer = JSON.parse(await readFile(path.join(broker.stateRoot, 'tasks', taskId, 'session.json'), 'utf8'));
    assert.equal(pointer.sessionId, done.currentRun?.sessionId);
    const launcher = await launcherTrace();
    assert.ok(launcher.length >= 1);
    assert.ok(launcher.every((entry) => entry.outcome === 'served'), 'the fake launcher only served read-only probes and /usage');
    assert.ok(!launcher.some((entry) => entry.args.includes('-p') && entry.args[entry.args.indexOf('-p') + 1] !== '/usage'), 'no prompt was ever sent to a real launcher');
  });

  test('a second run in the same task resumes the same session identity and a different task gets its own', async () => {
    const { taskId, taskHandle } = await register('thread-run');
    const first = (await task(taskId)).currentRun!.sessionId;
    assert.ok(first);
    await startRun(taskId, taskHandle, devJob(workspaceA, 'say: segunda'));
    const second = await waitForState(taskId, 'idle');
    assert.equal(second.currentRun?.sessionId, first);
    const trace = await readTrace(second.currentRun!.workerPid!);
    assert.equal(trace.find((entry) => entry.kind === 'query')!.data.resume, first);
    await endTask(taskId);
    const other = await register('thread-run-2');
    await startRun(other.taskId, other.taskHandle, devJob(workspaceB, 'say: outra'));
    const otherIdle = await waitForState(other.taskId, 'idle');
    assert.notEqual(otherIdle.currentRun?.sessionId, first);
    await endTask(other.taskId);
  });

  test('an effort downgrade reported by the CLI stops the run visibly instead of working silently', async () => {
    const { taskId, taskHandle } = await register('thread-effort');
    await startRun(taskId, taskHandle, devJob(workspaceB, 'say: nunca'), { harness: { effortCap: 'high' } });
    const failed = await waitForRunStatus(taskId, ['FAIL']);
    assert.equal(failed.currentRun?.failureCode, 'EFFORT_DOWNGRADED_BY_CLI');
    assert.equal(failed.currentRun?.effortObservedByCli, 'high');
    const log = await events(taskId);
    assert.ok(!log.some((event) => event.type === 'assistant_text'), 'no work happened at reduced effort');
  });
});

describe('message queue, multiturn and interrupt', () => {
  test('guidance sent while busy is queued with id/source/state and delivered on the next turn', async () => {
    const { taskId, taskHandle } = await register('thread-queue');
    await startRun(taskId, taskHandle, devJob(workspaceB, script(['say: começando', 'sleep: 2500'])));
    await waitForState(taskId, 'busy_tool');
    const queued = await broker.api(`/api/tasks/${taskId}/message`, { method: 'POST', headers: broker.bearerHeaders(), body: JSON.stringify({ text: 'say: orientação entregue' }) });
    assert.equal(queued.status, 202, queued.text);
    const message = queued.body as { messageId: string; state: string; source: string };
    assert.match(message.messageId, /^msg-/);
    assert.equal(message.state, 'queued');
    assert.equal(message.source, 'local-secret');
    const viewBusy = await task(taskId);
    assert.deepEqual(viewBusy.queue.map((m) => [m.messageId, m.state, m.deliveredAt]), [[message.messageId, 'queued', null]]);
    const delivered = await waitFor(async () => {
      const view = await task(taskId);
      const entry = view.queue.find((m) => m.messageId === message.messageId);
      return entry?.state === 'delivered' ? entry : undefined;
    }, { timeoutMs: 20000, description: 'queued message delivery' });
    assert.ok(delivered.deliveredAt);
    await waitForEvent(taskId, (event) => event.type === 'assistant_text' && event.data.text === 'orientação entregue');
    const log = await events(taskId);
    const turns = log.filter((event) => event.type === 'turn_started');
    assert.equal(turns.length, 2, 'the queued guidance starts a second turn, it does not abort the first');
    assert.ok(log.some((event) => event.type === 'message_queued' && event.data.messageId === message.messageId));
    assert.ok(log.some((event) => event.type === 'message_delivered' && event.data.messageId === message.messageId));
    const persisted = await readFile(path.join(broker.stateRoot, 'tasks', taskId, 'queue.jsonl'), 'utf8');
    assert.ok(persisted.includes(message.messageId));
    await waitForState(taskId, 'idle');
    await endTask(taskId);
  });

  test('guidance sent before the session is ready is held and delivered once, after the initial prompt', async () => {
    const { taskId, taskHandle } = await register('thread-early-queue');
    await startRun(taskId, taskHandle, devJob(workspaceB, script(['say: prompt inicial', 'sleep: 800'])));
    // Enqueue at the earliest moment the broker accepts it: the worker exists
    // but has not necessarily announced itself yet. Until a run has a worker,
    // the refusal must be the explicit NO_ACTIVE_RUN, never a silent drop.
    const queued = await waitFor(async () => {
      const response = await broker.api(`/api/tasks/${taskId}/message`, { method: 'POST', headers: broker.bearerHeaders(), body: JSON.stringify({ text: 'say: orientação antecipada' }) });
      if (response.status === 202) return response;
      assert.equal((response.body as { error: string }).error, 'NO_ACTIVE_RUN', response.text);
      return undefined;
    }, { timeoutMs: 25000, intervalMs: 10, description: 'early guidance accepted' });
    const messageId = (queued.body as { messageId: string }).messageId;
    await waitForEvent(taskId, (event) => event.type === 'assistant_text' && event.data.text === 'orientação antecipada', 30000);
    const idle = await waitForState(taskId, 'idle');
    const log = await events(taskId);
    const texts = log.filter((event) => event.type === 'assistant_text').map((event) => event.data.text);
    assert.deepEqual(texts, ['prompt inicial', 'orientação antecipada'], 'the initial prompt is not replaced or repeated by the early message');
    assert.equal(log.filter((event) => event.type === 'message_delivered' && event.data.messageId === messageId).length, 1, 'delivered exactly once');
    assert.equal(idle.queue.find((entry) => entry.messageId === messageId)?.state, 'delivered');
    assert.equal(idle.currentRun?.turns, 2);
    await endTask(taskId);
  });

  test('only an explicit interrupt aborts a turn and the session survives it', async () => {
    const { taskId, taskHandle } = await register('thread-interrupt');
    await startRun(taskId, taskHandle, devJob(workspaceB, script(['say: longa', 'sleep: 60000'])));
    await waitForState(taskId, 'busy_tool');
    const interrupted = await broker.api(`/api/tasks/${taskId}/interrupt`, { method: 'POST', headers: broker.bearerHeaders(), body: '{}' });
    assert.equal(interrupted.status, 202, interrupted.text);
    const idle = await waitForState(taskId, 'idle', 15000);
    assert.equal(idle.currentRun?.status, 'RUNNING', 'the session stays open after an interrupted turn');
    const log = await events(taskId);
    assert.ok(log.some((event) => event.type === 'turn_interrupted' && event.data.source === 'local-secret'));
    const trace = await readTrace(idle.currentRun!.workerPid!);
    assert.equal(trace.filter((entry) => entry.kind === 'interrupt').length, 1);
    await broker.api(`/api/tasks/${taskId}/message`, { method: 'POST', headers: broker.bearerHeaders(), body: JSON.stringify({ text: 'say: depois da interrupção' }) });
    await waitForEvent(taskId, (event) => event.type === 'assistant_text' && event.data.text === 'depois da interrupção');
    await waitForState(taskId, 'idle');
    await endTask(taskId);
  });
});

describe('permission and question requests', () => {
  test('escalated actions create unique requests; stale, duplicate and wrong-run answers are rejected', async () => {
    const { taskId, taskHandle } = await register('thread-permission');
    const { runId } = await startRun(taskId, taskHandle, devJob(workspaceB, script([toolDirective('Bash', { command: 'curl https://example.com' }), 'say: fim'])));
    const waiting = await waitForState(taskId, 'waiting_permission');
    assert.equal(waiting.pendingRequests.length, 1);
    const request = waiting.pendingRequests[0]!;
    assert.match(request.requestId, /^req-/);
    assert.equal(request.runId, runId);
    assert.equal(request.kind, 'permission');
    assert.equal(request.tool, 'Bash');
    const log = await events(taskId);
    const requested = log.find((event) => event.type === 'permission_requested')!;
    assert.equal(requested.data.reason, 'EXTERNAL_NETWORK');
    assert.equal(requested.data.decision, 'escalate');

    const wrongRun = await broker.api(`/api/tasks/${taskId}/answer`, { method: 'POST', headers: broker.bearerHeaders(), body: JSON.stringify({ requestId: request.requestId, runId: 'run-errado', decision: 'allow' }) });
    assert.equal(wrongRun.status, 409);
    assert.deepEqual(wrongRun.body, { error: 'REQUEST_WRONG_RUN' });
    const unknown = await broker.api(`/api/tasks/${taskId}/answer`, { method: 'POST', headers: broker.bearerHeaders(), body: JSON.stringify({ requestId: 'req-inexistente', runId, decision: 'allow' }) });
    assert.equal(unknown.status, 404);
    assert.deepEqual(unknown.body, { error: 'REQUEST_NOT_FOUND' });
    const denied = await broker.api(`/api/tasks/${taskId}/answer`, { method: 'POST', headers: broker.bearerHeaders(), body: JSON.stringify({ requestId: request.requestId, runId, decision: 'deny', message: 'Sem rede nesta tarefa.' }) });
    assert.equal(denied.status, 200, denied.text);
    const duplicate = await broker.api(`/api/tasks/${taskId}/answer`, { method: 'POST', headers: broker.bearerHeaders(), body: JSON.stringify({ requestId: request.requestId, runId, decision: 'allow' }) });
    assert.equal(duplicate.status, 409);
    assert.deepEqual(duplicate.body, { error: 'REQUEST_ALREADY_RESOLVED' });
    await waitForEvent(taskId, (event) => event.type === 'assistant_text' && event.data.text === 'fim');
    const idle = await waitForState(taskId, 'idle');
    assert.deepEqual(idle.pendingRequests, []);
    const after = await events(taskId);
    const resolved = after.find((event) => event.type === 'permission_resolved')!;
    assert.equal(resolved.data.requestId, request.requestId);
    assert.equal(resolved.data.decision, 'deny');
    assert.equal(resolved.data.source, 'local-secret');
    const trace = await readTrace(idle.currentRun!.workerPid!);
    const canUse = trace.find((entry) => entry.kind === 'canUseTool')!;
    assert.equal(canUse.data.resolution, 'deny');
    assert.equal(canUse.data.message, 'Sem rede nesta tarefa.');
    const toolResult = after.find((event) => event.type === 'tool_result')!;
    assert.equal(toolResult.data.isError, true);
    await endTask(taskId);
  });

  test('reserved operations are blocked by PreToolUse even when the tool is auto-approved, with a visible reason', async () => {
    const { taskId, taskHandle } = await register('thread-reserved');
    await startRun(taskId, taskHandle, devJob(workspaceB, script([toolDirective('Bash', { command: 'git push origin HEAD' }), 'say: continuei'])));
    await waitForEvent(taskId, (event) => event.type === 'assistant_text' && event.data.text === 'continuei');
    const idle = await waitForState(taskId, 'idle');
    const log = await events(taskId);
    const blocked = log.find((event) => event.type === 'tool_blocked')!;
    assert.equal(blocked.data.reason, 'RESERVED_OPERATION_PUSH');
    assert.equal(blocked.data.enforcedBy, 'PreToolUse');
    assert.match(String(blocked.data.message), /reservad/i);
    assert.equal(idle.pendingRequests.length, 0, 'reserved operations never wait for approval');
    const trace = await readTrace(idle.currentRun!.workerPid!);
    const hook = trace.find((entry) => entry.kind === 'hook' && entry.data.event === 'PreToolUse')!;
    assert.equal(hook.data.decision, 'deny');
    assert.ok(!trace.some((entry) => entry.kind === 'canUseTool'), 'auto-approved tools never reach canUseTool; the hook is the guard');
    await endTask(taskId);
  });

  test('a question from Claude waits indefinitely, raises no inactivity alert and is never killed', async () => {
    const { taskId, taskHandle } = await register('thread-question');
    const { runId } = await startRun(taskId, taskHandle, devJob(workspaceB, script(['ask: Qual banco usar?', 'say: obrigado'])));
    const waiting = await waitForState(taskId, 'waiting_question');
    const request = waiting.pendingRequests[0]!;
    assert.equal(request.kind, 'question');
    await sleep(2200);
    const still = await task(taskId);
    assert.equal(still.state, 'waiting_question');
    assert.deepEqual(still.alerts, [], 'waiting for an answer is not inactivity');
    assert.ok(isProcessAlive(still.currentRun!.workerPid!));
    const answered = await broker.api(`/api/tasks/${taskId}/answer`, { method: 'POST', headers: broker.browserActionHeaders(), body: JSON.stringify({ requestId: request.requestId, runId, decision: 'answer', answers: { 'Qual banco usar?': 'PostgreSQL' } }) });
    assert.equal(answered.status, 200, answered.text);
    await waitForEvent(taskId, (event) => event.type === 'assistant_text' && event.data.text === 'obrigado');
    const idle = await waitForState(taskId, 'idle');
    const log = await events(taskId);
    const resolved = log.find((event) => event.type === 'question_answered')!;
    assert.equal(resolved.data.source, 'browser');
    assert.deepEqual(resolved.data.answers, { 'Qual banco usar?': 'PostgreSQL' });
    const trace = await readTrace(idle.currentRun!.workerPid!);
    const canUse = trace.find((entry) => entry.kind === 'canUseTool' && entry.data.tool === 'AskUserQuestion')!;
    assert.equal(canUse.data.resolution, 'allow');
    await endTask(taskId);
  });
});

describe('capabilities and delegation', () => {
  test('a planning run grants no writes and no shell, and delegation to an unapproved agent escalates', async () => {
    const { taskId, taskHandle } = await register('thread-planning');
    await startRun(taskId, taskHandle, devJob(workspaceB, script([
      toolDirective('Edit', { file_path: path.join(workspaceB, 'src', 'a.ts'), old_string: 'a', new_string: 'b' }),
      toolDirective('Bash', { command: 'npm test' }),
      toolDirective('Task', { subagent_type: 'revisor-desconhecido', prompt: 'revise' }),
      'say: plano pronto',
    ]), { coordination: coordination({ phase: 'planning' }) }));
    const waiting = await waitForState(taskId, 'waiting_permission');
    const request = waiting.pendingRequests[0]!;
    assert.equal(request.tool, 'Task');
    const blockedSoFar = (await events(taskId)).filter((event) => event.type === 'tool_blocked');
    assert.deepEqual(blockedSoFar.map((event) => event.data.reason), ['CAPABILITY_EDIT_NOT_GRANTED', 'CAPABILITY_COMMANDS_NOT_GRANTED']);
    for (const event of blockedSoFar) assert.equal(event.data.enforcedBy, 'PreToolUse');
    const escalated = (await events(taskId)).find((event) => event.type === 'permission_requested')!;
    assert.equal(escalated.data.reason, 'AGENT_NOT_APPROVED');
    const denied = await broker.api(`/api/tasks/${taskId}/answer`, { method: 'POST', headers: broker.bearerHeaders(), body: JSON.stringify({ requestId: request.requestId, runId: waiting.currentRun!.runId, decision: 'deny', message: 'Subagente não inventariado.' }) });
    assert.equal(denied.status, 200, denied.text);
    await waitForEvent(taskId, (event) => event.type === 'assistant_text' && event.data.text === 'plano pronto');
    const idle = await waitForState(taskId, 'idle');
    // The restricted tool preset is also passed to the process, so the gate is
    // defence in depth rather than the only barrier.
    const query = (await readTrace(idle.currentRun!.workerPid!)).find((entry) => entry.kind === 'query')!;
    const tools = String(query.data.tools).split(',');
    assert.ok(!tools.includes('Edit') && !tools.includes('Write') && !tools.includes('Bash'), `planning tools should be read-only, got ${query.data.tools}`);
    assert.ok(tools.includes('Read'));
    await endTask(taskId);
  });
});

describe('supervision alerts and coordinator presence', () => {
  test('inactivity produces an alert event while the worker keeps running', async () => {
    const { taskId, taskHandle } = await register('thread-alert');
    await startRun(taskId, taskHandle, devJob(workspaceB, script(['say: pausa', 'sleep: 4000'])));
    await waitForState(taskId, 'busy_tool');
    const alerted = await waitFor(async () => {
      const view = await task(taskId);
      return view.alerts.includes('inactivity_20m') ? view : undefined;
    }, { timeoutMs: 6000, description: 'inactivity alert' });
    assert.equal(alerted.state, 'busy_tool');
    assert.ok(isProcessAlive(alerted.currentRun!.workerPid!));
    const idle = await waitForState(taskId, 'idle');
    assert.equal(idle.currentRun?.status, 'RUNNING');
    const log = await events(taskId);
    assert.ok(log.some((event) => event.type === 'alert' && event.data.alert === 'inactivity_20m' && event.data.action === 'none'));
    await endTask(taskId);
  });

  test('coordinator presence comes from real heartbeats or event waits, never from browser reads', async () => {
    const { taskId } = await register('thread-presence');
    await sleep(1200);
    const absent = await task(taskId);
    assert.equal(absent.coordinatorPresence, 'absent');
    await broker.api(`/api/tasks/${taskId}/events?cursor=0&waitMs=10`, { headers: broker.bearerHeaders() });
    const present = await task(taskId);
    assert.equal(present.coordinatorPresence, 'present');
    const seenAt = present.coordinatorLastSeenAt;
    await sleep(300);
    await broker.api(`/api/tasks/${taskId}/events?cursor=0&waitMs=10`, { headers: broker.browserHeaders() });
    const afterBrowser = await task(taskId);
    assert.equal(afterBrowser.coordinatorPresence, 'present', 'probed inside the presence window');
    assert.equal(afterBrowser.coordinatorLastSeenAt, seenAt, 'a browser read does not refresh coordinator presence');
    await sleep(1200);
    assert.equal((await task(taskId)).coordinatorPresence, 'absent');
    await broker.api(`/api/tasks/${taskId}/heartbeat`, { method: 'POST', headers: broker.bearerHeaders(), body: '{}' });
    assert.equal((await task(taskId)).coordinatorPresence, 'present');
  });
});

describe('locks and scoped termination', () => {
  test('same-task runs serialize, and the workspace writer lock spans tasks while reads coexist', async () => {
    const first = await register('thread-lock-1');
    await startRun(first.taskId, first.taskHandle, devJob(workspaceB, script(['say: editando', 'sleep: 3000'])));
    await waitForState(first.taskId, 'busy_tool');
    const sameTask = await broker.api(`/api/tasks/${first.taskId}/runs`, { method: 'POST', headers: broker.bearerHeaders(), body: JSON.stringify({ taskHandle: first.taskHandle, job: devJob(workspaceB, 'say: segunda'), observation: { mode: 'voz' } }) });
    assert.equal(sameTask.status, 409);
    assert.equal((sameTask.body as { error: string }).error, 'RUN_IN_PROGRESS');
    const second = await register('thread-lock-2');
    const writerBlocked = await broker.api(`/api/tasks/${second.taskId}/runs`, { method: 'POST', headers: broker.bearerHeaders(), body: JSON.stringify({ taskHandle: second.taskHandle, job: devJob(workspaceB, 'say: conflito'), observation: { mode: 'voz' } }) });
    assert.equal(writerBlocked.status, 409);
    assert.equal((writerBlocked.body as { error: string }).error, 'WORKSPACE_WRITER_LOCKED');
    assert.equal((writerBlocked.body as { holderTaskId: string }).holderTaskId, first.taskId);
    const reader = await broker.api(`/api/tasks/${second.taskId}/runs`, { method: 'POST', headers: broker.bearerHeaders(), body: JSON.stringify({ taskHandle: second.taskHandle, job: devJob(workspaceB, 'say: só leitura', { profile: 'read' }), observation: { mode: 'voz' } }) });
    assert.equal(reader.status, 202, 'a read profile coexists with a writer');
    const locks = await broker.api('/api/locks', { headers: broker.bearerHeaders() });
    const list = locks.body as Array<{ holderTaskId: string; holderPid: number | null }>;
    assert.equal(list.filter((lock) => lock.holderTaskId === first.taskId).length, 1);
    await waitForState(first.taskId, 'idle');
    const stillHeld = await broker.api('/api/locks', { headers: broker.bearerHeaders() });
    assert.equal((stillHeld.body as unknown[]).length, 1, 'an idle session keeps its writer lock until it ends');
    await waitForState(second.taskId, 'idle');
    await endTask(first.taskId);
    await endTask(second.taskId);
    const after = await broker.api('/api/locks', { headers: broker.bearerHeaders() });
    assert.deepEqual(after.body, []);
  });

  test('two starts racing for the same checkout produce exactly one holder', async () => {
    const a = await register('thread-race-a');
    const b = await register('thread-race-b');
    const workspace = path.join(temp.root, 'ws-race');
    await mkdir(path.join(workspace, 'src'), { recursive: true });
    const start = (handle: { taskId: string; taskHandle: string }) => broker.api(`/api/tasks/${handle.taskId}/runs`, {
      method: 'POST',
      headers: broker.bearerHeaders(),
      body: JSON.stringify({ taskHandle: handle.taskHandle, job: devJob(workspace, script(['say: corrida', 'sleep: 1500'])), observation: { mode: 'voz' } }),
    });
    const [first, second] = await Promise.all([start(a), start(b)]);
    const accepted = [first, second].filter((response) => response.status === 202);
    const rejected = [first, second].filter((response) => response.status !== 202);
    assert.equal(accepted.length, 1, `exactly one start may win: ${first.status}/${second.status} ${first.text} ${second.text}`);
    assert.equal(rejected[0]!.status, 409);
    assert.equal((rejected[0]!.body as { error: string }).error, 'WORKSPACE_WRITER_LOCKED');
    const winner = first.status === 202 ? a : b;
    await waitForState(winner.taskId, 'idle');
    await endTask(winner.taskId);
  });

  test('the same checkout reached through another path spelling is the same writer lock', async () => {
    const real = path.join(temp.root, 'ws-canonical');
    await mkdir(path.join(real, 'src'), { recursive: true });
    const alias = path.join(temp.root, 'ws-alias');
    try {
      await symlink(real, alias, 'junction');
    } catch {
      return; // creating reparse points is not permitted here; nothing to assert
    }
    const a = await register('thread-canonical-a');
    const b = await register('thread-canonical-b');
    await startRun(a.taskId, a.taskHandle, devJob(real, script(['say: canônico', 'sleep: 2500'])));
    await waitForState(a.taskId, 'busy_tool');
    const viaAlias = await broker.api(`/api/tasks/${b.taskId}/runs`, { method: 'POST', headers: broker.bearerHeaders(), body: JSON.stringify({ taskHandle: b.taskHandle, job: devJob(alias, 'say: mesmo checkout'), observation: { mode: 'voz' } }) });
    assert.equal(viaAlias.status, 409, viaAlias.text);
    assert.equal((viaAlias.body as { error: string }).error, 'WORKSPACE_WRITER_LOCKED');
    assert.equal((viaAlias.body as { holderTaskId: string }).holderTaskId, a.taskId);
    await waitForState(a.taskId, 'idle');
    await endTask(a.taskId);
    const afterRelease = await broker.api(`/api/tasks/${b.taskId}/runs`, { method: 'POST', headers: broker.bearerHeaders(), body: JSON.stringify({ taskHandle: b.taskHandle, job: devJob(alias, 'say: agora livre'), observation: { mode: 'voz' } }) });
    assert.equal(afterRelease.status, 202, afterRelease.text);
    await waitForState(b.taskId, 'idle');
    await endTask(b.taskId);
  });

  test('ending a task terminates only its worker and its real descendants', async () => {
    const a = await register('thread-end-a');
    const b = await register('thread-end-b');
    await startRun(a.taskId, a.taskHandle, devJob(workspaceB, script(['spawn: 60000', 'say: a', 'sleep: 60000'])));
    const viewA = await waitForState(a.taskId, 'busy_tool');
    await startRun(b.taskId, b.taskHandle, devJob(workspaceA, script(['spawn: 60000', 'say: b', 'sleep: 60000'])));
    const viewB = await waitForState(b.taskId, 'busy_tool');
    const pidsA = await waitFor(async () => {
      const trace = await readTrace(viewA.currentRun!.workerPid!);
      const entry = trace.find((item) => item.kind === 'spawn');
      return entry ? (entry.data.pids as number[]) : undefined;
    }, { timeoutMs: 15000, description: 'descendants of A' });
    const pidsB = await waitFor(async () => {
      const trace = await readTrace(viewB.currentRun!.workerPid!);
      const entry = trace.find((item) => item.kind === 'spawn');
      return entry ? (entry.data.pids as number[]) : undefined;
    }, { timeoutMs: 15000, description: 'descendants of B' });
    assert.equal(pidsA.length, 2, 'child and grandchild');
    for (const pid of [...pidsA, ...pidsB]) assert.ok(isProcessAlive(pid), `descendant ${pid} must be alive before cancellation`);
    const terminal = await endTask(a.taskId);
    assert.equal(terminal.currentRun?.status, 'CANCELLED');
    await waitFor(async () => ([viewA.currentRun!.workerPid!, ...pidsA].every((pid) => !isProcessAlive(pid)) ? true : undefined), { timeoutMs: 15000, description: 'worker A and its descendants exit' });
    assert.ok(isProcessAlive(viewB.currentRun!.workerPid!), 'task B keeps running');
    for (const pid of pidsB) assert.ok(isProcessAlive(pid), `descendant ${pid} of task B survives`);
    assert.ok(isProcessAlive(broker.announcement.pid), 'the broker keeps running');
    await endTask(b.taskId);
    await waitFor(async () => (pidsB.every((pid) => !isProcessAlive(pid)) ? true : undefined), { timeoutMs: 15000, description: 'descendants of B exit after their own end' });
  });
});

describe('failures and recovery', () => {
  test('status telemetry failure does not kill the worker and is visible', { skip: windowsOnly }, async () => {
    const { taskId, taskHandle } = await register('thread-telemetry');
    const { runId } = await startRun(taskId, taskHandle, devJob(workspaceB, script(['say: início', 'sleep: 3500', 'say: fim'])));
    await waitForState(taskId, 'busy_tool');
    const statusPath = path.join(broker.stateRoot, 'tasks', taskId, 'runs', runId, 'status.json');
    await waitFor(async () => { try { await readFile(statusPath); return true; } catch { return undefined; } }, { timeoutMs: 5000, description: 'status.json exists' });
    const holder = await holdFileWithoutDeleteShare(statusPath);
    try {
      await waitForEvent(taskId, (event) => event.type === 'telemetry_write_failed', 15000);
    } finally {
      await holder.release();
    }
    await waitForEvent(taskId, (event) => event.type === 'assistant_text' && event.data.text === 'fim');
    const idle = await waitForState(taskId, 'idle');
    assert.ok(idle.currentRun!.telemetryFailures >= 1, 'the failure is counted');
    const log = await events(taskId);
    const failure = log.find((event) => event.type === 'telemetry_write_failed')!;
    assert.equal(failure.data.file, 'status.json');
    assert.equal(failure.data.code, 'STATE_FILE_BUSY');
    const done = await endTask(taskId);
    assert.equal(done.currentRun?.status, 'COMPLETED');
    const status = await waitFor(async () => {
      const parsed = JSON.parse(await readFile(statusPath, 'utf8'));
      return parsed.status === 'COMPLETED' ? parsed : undefined;
    }, { timeoutMs: 10000, description: 'final status persisted after release' });
    assert.equal(status.status, 'COMPLETED', 'the final state is persisted once the reader releases');
  });

  test('a preparation failure ends visibly and preserves the last usable session pointer', async () => {
    const { taskId, taskHandle } = await register('thread-prep');
    await startRun(taskId, taskHandle, devJob(workspaceB, 'say: primeira'));
    await waitForState(taskId, 'idle');
    const first = await endTask(taskId);
    const pointerPath = path.join(broker.stateRoot, 'tasks', taskId, 'session.json');
    const pointerBefore = await readFile(pointerPath, 'utf8');
    await startRun(taskId, taskHandle, devJob(workspaceB, 'say: x'), { harness: { failPreparation: 'cli-probe' } });
    const failed = await waitForRunStatus(taskId, ['FAIL']);
    assert.equal(failed.currentRun?.failureStage, 'cli-probe');
    assert.equal(failed.state, 'terminal');
    assert.equal(await readFile(pointerPath, 'utf8'), pointerBefore);
    assert.equal(failed.previousSessionId, first.currentRun?.sessionId);
    const log = await events(taskId);
    const ended = log.filter((event) => event.type === 'preparation_failed');
    assert.equal(ended.length, 1);
    assert.equal(ended[0]!.data.stage, 'cli-probe');
  });

  test('a missing fake process adapter fails closed: the installed CLI is never started', async () => {
    const { taskId, taskHandle } = await register('thread-adapter');
    const launcherBefore = (await launcherTrace()).length;
    await startRun(taskId, taskHandle, devJob(workspaceB, 'say: nunca'), { harness: { adapterPath: path.join(temp.root, 'adaptador-inexistente.ts') } });
    const failed = await waitForRunStatus(taskId, ['FAIL']);
    assert.equal(failed.currentRun?.failureStage, 'adapter-load');
    assert.equal(failed.currentRun?.failureCode, 'ADAPTER_LOAD_FAILED');
    const log = await events(taskId);
    assert.ok(!log.some((event) => event.type === 'session_init'), 'no session started');
    const launcher = await launcherTrace();
    assert.ok(launcher.slice(launcherBefore).every((entry) => entry.outcome === 'served'), 'nothing tried to generate with the launcher');
    assert.ok(!launcher.some((entry) => entry.outcome === 'FORBIDDEN_GENERATION'));
  });

  test('a killed worker quarantines the checkout, and reviewing artefacts does not hand ownership back', async () => {
    const { taskId, taskHandle } = await register('thread-crash');
    await startRun(taskId, taskHandle, devJob(workspaceB, script(['say: vivo', 'sleep: 60000'])));
    const busy = await waitForState(taskId, 'busy_tool');
    process.kill(busy.currentRun!.workerPid!);
    const disconnected = await waitForState(taskId, 'disconnected', 15000);
    assert.equal(disconnected.currentRun?.status, 'UNCERTAIN');
    assert.equal(disconnected.requiresReview, true);
    const reconciled = await waitForEvent(taskId, (event) => event.type === 'worker_disconnected');
    assert.equal(reconciled.data.reconciledBy, 'process-identity');
    // A hard kill runs no exit handler, so neither the worker nor the CLI
    // recorded a clean exit. Their PIDs being free proves nothing about the
    // children they may have orphaned, so the checkout stays quarantined.
    assert.equal(reconciled.data.descendantsClean, false, String(reconciled.data.note));
    assert.match(String(reconciled.data.note), /desapareceu sem registrar término/);
    const locks = (await broker.api('/api/locks', { headers: broker.bearerHeaders() })).body as Array<{ workspaceKey: string; quarantined: boolean; holderTaskId: string; holderRunId: string }>;
    const held = locks.find((lock) => lock.holderTaskId === taskId);
    assert.ok(held, `the checkout stays held: ${JSON.stringify(locks)}`);
    assert.equal(held.quarantined, true);

    const blocked = await broker.api(`/api/tasks/${taskId}/runs`, { method: 'POST', headers: broker.bearerHeaders(), body: JSON.stringify({ taskHandle, job: devJob(workspaceB, 'say: de novo'), observation: { mode: 'voz' } }) });
    assert.equal(blocked.status, 409);
    assert.equal((blocked.body as { error: string }).error, 'REQUIRES_REVIEW');

    // Reviewing the artefacts clears the review flag and NOTHING else: the
    // writer is still not restored, because that is a separate decision.
    const reviewed = await broker.api(`/api/tasks/${taskId}/acknowledge-review`, { method: 'POST', headers: broker.bearerHeaders(), body: JSON.stringify({ note: 'diff revisado' }) });
    assert.equal(reviewed.status, 200, reviewed.text);
    const reviewEvent = await waitForEvent(taskId, (event) => event.type === 'review_acknowledged');
    assert.equal(reviewEvent.data.ownershipReleased, false);
    assert.deepEqual(reviewEvent.data.quarantinedLocks, [held.workspaceKey]);
    const stillLocked = await broker.api(`/api/tasks/${taskId}/runs`, { method: 'POST', headers: broker.bearerHeaders(), body: JSON.stringify({ taskHandle, job: devJob(workspaceB, 'say: de novo'), observation: { mode: 'voz' } }) });
    assert.equal(stillLocked.status, 409);
    assert.equal((stillLocked.body as { error: string }).error, 'WORKSPACE_LOCK_QUARANTINED');

    // Releasing ownership is explicit, administrative, and re-checks survivors.
    const fromBrowser = await broker.api(`/api/locks/${held.workspaceKey}/release`, { method: 'POST', headers: broker.browserActionHeaders(), body: '{}' });
    assert.equal(fromBrowser.status, 403);
    assert.deepEqual(fromBrowser.body, { error: 'LOCAL_ADMIN_REQUIRED' });
    const unconfirmed = await broker.api(`/api/locks/${held.workspaceKey}/release`, { method: 'POST', headers: broker.bearerHeaders(), body: JSON.stringify({ note: 'sem confirmação', expectedTaskId: held.holderTaskId, expectedRunId: held.holderRunId }) });
    assert.equal(unconfirmed.status, 409);
    assert.equal((unconfirmed.body as { error: string }).error, 'LOCK_RELEASE_CONFIRMATION_REQUIRED');
    const releaseRequest = () => broker.api(`/api/locks/${held.workspaceKey}/release`, { method: 'POST', headers: broker.bearerHeaders(), body: JSON.stringify({ note: 'nenhum processo visível sobreviveu; reconheço a limitação histórica', confirmHistoricalRisk: true, expectedTaskId: held.holderTaskId, expectedRunId: held.holderRunId }) });
    const concurrentReleases = await Promise.all([releaseRequest(), releaseRequest()]);
    const released = concurrentReleases.find((response) => response.status === 200);
    const refusedConcurrent = concurrentReleases.find((response) => response.status !== 200);
    assert.ok(released, concurrentReleases.map((response) => response.text).join(' | '));
    assert.equal(refusedConcurrent?.status, 409);
    assert.equal((refusedConcurrent?.body as { error: string }).error, 'LOCK_RELEASE_IN_PROGRESS');
    assert.equal((released.body as { released: boolean }).released, true);
    const releasedEvent = await waitForEvent(taskId, (event) => event.type === 'lock_released');
    const authorizedEvent = (await events(taskId)).find((event) => event.type === 'lock_release_authorized');
    assert.ok(authorizedEvent, 'risk acknowledgement is durable before ownership disappears');
    assert.ok(authorizedEvent.seq < releasedEvent.seq);
    assert.equal(authorizedEvent.data.riskAcknowledged, true);
    assert.equal(authorizedEvent.data.historicalAncestryConclusive, false);
    assert.deepEqual((await broker.api('/api/locks', { headers: broker.bearerHeaders() })).body, []);

    await startRun(taskId, taskHandle, devJob(workspaceB, 'say: revisado'), { acknowledgeReview: true });
    await waitForState(taskId, 'idle');
    await endTask(taskId);
  });

  test('a quarantined checkout is not released while a recorded process still runs', async () => {
    const { taskId, taskHandle } = await register('thread-quarantine');
    const workspace = path.join(temp.root, 'ws-quarantine');
    await mkdir(path.join(workspace, 'src'), { recursive: true });
    const { runId } = await startRun(taskId, taskHandle, devJob(workspace, script(['say: vivo', 'sleep: 60000'])));
    const busy = await waitForState(taskId, 'busy_tool');
    process.kill(busy.currentRun!.workerPid!);
    await waitForState(taskId, 'disconnected', 15000);
    await waitForEvent(taskId, (event) => event.type === 'worker_disconnected');
    const locks = (await broker.api('/api/locks', { headers: broker.bearerHeaders() })).body as Array<{ workspaceKey: string; holderTaskId: string; holderRunId: string }>;
    const held = locks.find((lock) => lock.holderTaskId === taskId)!;

    // A survivor the test fully controls: the run's engine record is pointed at
    // a process that is demonstrably alive and whose identity is recorded, so
    // the release must refuse rather than hand the checkout over.
    const survivor = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore', windowsHide: true });
    try {
      await waitFor(async () => (survivor.pid && isProcessAlive(survivor.pid) ? true : undefined), { timeoutMs: 10000, description: 'survivor running' });
      const createdAt = await readProcessCreationIdentity(survivor.pid!);
      assert.ok(createdAt, 'the survivor must have a verifiable creation identity');
      const runDir = path.join(broker.stateRoot, 'tasks', taskId, 'runs', runId);
      await writeFile(path.join(runDir, 'engine.json'), JSON.stringify({ pid: survivor.pid, recordedAt: new Date().toISOString(), createdAt, exitedAt: null }));
      const refused = await broker.api(`/api/locks/${held.workspaceKey}/release`, { method: 'POST', headers: broker.bearerHeaders(), body: JSON.stringify({ note: 'auditoria de sobreviventes', confirmHistoricalRisk: true, expectedTaskId: held.holderTaskId, expectedRunId: held.holderRunId }) });
      assert.equal(refused.status, 409, refused.text);
      assert.equal((refused.body as { error: string }).error, 'LOCK_SURVIVOR_POSSIBLE');
      // The sentinel must be named. Other processes of the same run may also
      // still be finishing; they are real survivors too, so the set is checked
      // for membership rather than pinned.
      assert.ok((refused.body as { livePids: number[] }).livePids.includes(survivor.pid!), refused.text);
      await waitForEvent(taskId, (event) => event.type === 'lock_release_refused');
      assert.ok(isProcessAlive(survivor.pid!), 'refusing to release never terminates anything');
    } finally {
      survivor.kill('SIGKILL');
    }
    await waitFor(async () => (!isProcessAlive(survivor.pid!) ? true : undefined), { timeoutMs: 15000, description: 'survivor exits' });
    // Once nothing of the run is running any more, the explicit release works.
    await waitFor(async () => {
      const attempt = await broker.api(`/api/locks/${held.workspaceKey}/release`, { method: 'POST', headers: broker.bearerHeaders(), body: JSON.stringify({ note: 'processos visíveis encerrados; reconheço risco histórico', confirmHistoricalRisk: true, expectedTaskId: held.holderTaskId, expectedRunId: held.holderRunId }) });
      return attempt.status === 200 ? attempt : undefined;
    }, { timeoutMs: 30000, description: 'quarantined lock becomes releasable' });
  });

  test('the SSE history-to-live boundary loses nothing and duplicates nothing under concurrent appends', async () => {
    const { taskId, taskHandle } = await register('thread-sse');
    await startRun(taskId, taskHandle, devJob(workspaceB, script(Array.from({ length: 40 }, (_, i) => `say: evento ${i + 1}`))));
    const ender = (async () => { await waitForState(taskId, 'idle'); await endTask(taskId); })();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    const seen: number[] = [];
    try {
      const stream = await fetch(`${broker.baseUrl}/api/events?cursor=0&taskId=${taskId}`, { headers: broker.bearerHeaders(), signal: controller.signal });
      assert.equal(stream.status, 200);
      const reader = stream.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let done = false;
      while (!done) {
        const { value, done: finished } = await reader.read();
        if (finished) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const idLine = frame.split('\n').find((line) => line.startsWith('id: '));
          const dataLine = frame.split('\n').find((line) => line.startsWith('data: '));
          if (idLine && dataLine && frame.includes('event: event')) {
            seen.push(Number(idLine.slice(4)));
            const event = JSON.parse(dataLine.slice(6)) as EventRecord;
            if (event.type === 'run_ended') done = true;
          }
          boundary = buffer.indexOf('\n\n');
        }
      }
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
    await ender;
    const durable = await events(taskId);
    const expected = durable.map((event) => event.gseq!);
    assert.deepEqual(seen, expected, 'every durable event arrived exactly once and in order across the replay/live boundary');
    assert.equal(new Set(seen).size, seen.length);
  });

  test('after a broker restart, in-flight work is uncertain and queued messages are not replayed', async () => {
    const { taskId, taskHandle } = await register('thread-restart');
    await startRun(taskId, taskHandle, devJob(workspaceB, script(['say: antes', 'sleep: 60000'])));
    const busy = await waitForState(taskId, 'busy_tool');
    const queued = await broker.api(`/api/tasks/${taskId}/message`, { method: 'POST', headers: broker.bearerHeaders(), body: JSON.stringify({ text: 'say: não replay' }) });
    const messageId = (queued.body as { messageId: string }).messageId;
    const stateRoot = broker.stateRoot;
    await broker.stop();
    await waitFor(async () => (isProcessAlive(busy.currentRun!.workerPid!) ? undefined : true), { timeoutMs: 15000, description: 'workers stop with the broker' });
    broker = await startTestBroker({ stateRoot, fakeAdapterPath: fakeAdapter, env: { [FAKE_TRACE_DIR_ENV]: traceDir } });
    const recovered = await task(taskId);
    assert.equal(recovered.state, 'uncertain');
    assert.equal(recovered.requiresReview, true);
    const entry = recovered.queue.find((m) => m.messageId === messageId)!;
    assert.equal(entry.state, 'requires_review');
    assert.equal(entry.deliveredAt, null);
    const log = await events(taskId);
    assert.ok(log.some((event) => event.type === 'broker_recovered' && event.data.uncertainRuns === 1));
    assert.ok(!log.some((event) => event.type === 'message_delivered' && event.data.messageId === messageId));
    const files = await readdir(path.join(stateRoot, 'tasks', taskId));
    assert.ok(files.includes('events.jsonl'));
    const status = JSON.parse(await readFile(path.join(stateRoot, 'tasks', taskId, 'runs', busy.currentRun!.runId, 'status.json'), 'utf8'));
    assert.equal(status.status, 'UNCERTAIN');
    assert.equal(status.requiresReview, true);
  });
});

describe('fail-closed launch and honest shutdown', () => {
  test('a CLI that does not apply the PreToolUse hook never receives the prompt', async () => {
    const { taskId, taskHandle } = await register('thread-hooks');
    await startRun(taskId, taskHandle, devJob(workspaceB, 'say: nunca'), { harness: { hooksApplied: false } });
    const failed = await waitForRunStatus(taskId, ['FAIL']);
    assert.equal(failed.currentRun?.failureCode, 'PRETOOLUSE_HOOK_NOT_APPLIED');
    const log = await events(taskId);
    const handshake = log.find((event) => event.type === 'cli_initialized')!;
    assert.equal(handshake.data.hooksApplied, false);
    // The gate that blocks reserved operations was not in place, so no work
    // may have been released: no turn, no assistant output, no tool.
    assert.ok(!log.some((event) => event.type === 'turn_started'), 'no turn started without the hook gate');
    assert.ok(!log.some((event) => event.type === 'assistant_text'));
    assert.ok(!log.some((event) => event.type === 'tool_start'));
    const failure = log.find((event) => event.type === 'preparation_failed' && event.data.code === 'PRETOOLUSE_HOOK_NOT_APPLIED')!;
    assert.equal(failure.data.stage, 'session-init');
  });

  test('a CLI that dies on its own is a failure, never a completed session', async () => {
    const { taskId, taskHandle } = await register('thread-cli-crash');
    await startRun(taskId, taskHandle, devJob(workspaceB, script(['say: antes da queda', 'crash: 9'])));
    const failed = await waitForRunStatus(taskId, ['FAIL'], 30000);
    assert.equal(failed.currentRun?.failureCode, 'CLI_EXITED_UNEXPECTEDLY');
    assert.equal(failed.state, 'terminal');
    const log = await events(taskId);
    // Output written before the process died is still delivered: stdout is
    // drained before the conversation is closed.
    assert.ok(log.some((event) => event.type === 'assistant_text' && event.data.text === 'antes da queda'), 'text written before the crash is not discarded');
    assert.ok(!log.some((event) => event.type === 'turn_completed'), 'a crash is not a completed turn');
    const ended = log.find((event) => event.type === 'run_ended')!;
    assert.equal(ended.data.status, 'FAIL');
    assert.match(String(ended.data.message), /encerrou sozinho/);
  });

  test('a run whose ownership record cannot be written is refused before any work starts', { skip: windowsOnly }, async () => {
    const { taskId, taskHandle } = await register('thread-ownership');
    const currentRunFile = path.join(broker.stateRoot, 'tasks', taskId, 'current-run.json');
    await writeFile(currentRunFile, '{}');
    const holder = await holdFileWithoutDeleteShare(currentRunFile);
    let response;
    try {
      response = await broker.api(`/api/tasks/${taskId}/runs`, { method: 'POST', headers: broker.bearerHeaders(), body: JSON.stringify({ taskHandle, job: devJob(workspaceB, 'say: nunca'), observation: { mode: 'voz' } }) });
    } finally {
      await holder.release();
    }
    assert.equal(response.status, 503, response.text);
    assert.equal((response.body as { error: string }).error, 'OWNERSHIP_RECORD_FAILED');
    // The reservation is released, so the checkout is free and no run lingers.
    assert.deepEqual((await broker.api('/api/locks', { headers: broker.bearerHeaders() })).body, []);
    const view = await task(taskId);
    assert.ok(!view.currentRun || ['FAIL', 'CANCELLED', 'COMPLETED', 'UNCERTAIN'].includes(view.currentRun.status), JSON.stringify(view.currentRun));
    const log = await events(taskId);
    assert.ok(!log.some((event) => event.type === 'worker_spawned'), 'no worker was started');
  });

  test('a failure between private projection and the public terminal event becomes uncertain everywhere', async () => {
    const { taskId, taskHandle } = await register('thread-finalization-failure');
    const { runId } = await startRun(taskId, taskHandle, devJob(workspaceB, 'say: pronto'), { harness: { finalizationFailure: 'before-public-event' } });
    await waitForState(taskId, 'idle');
    await broker.api(`/api/tasks/${taskId}/end`, { method: 'POST', headers: broker.bearerHeaders(), body: '{}' });
    const uncertain = await waitForRunStatus(taskId, ['UNCERTAIN']);
    assert.equal(uncertain.state, 'uncertain');
    assert.equal(uncertain.requiresReview, true);
    const log = await events(taskId);
    assert.ok(log.some((event) => event.type === 'finalization_failed'));
    assert.ok(!log.some((event) => event.type === 'run_ended'), 'terminal success was never published');
    const result = JSON.parse(await readFile(path.join(broker.stateRoot, 'tasks', taskId, 'runs', runId, 'resultado.json'), 'utf8')) as { status: string };
    assert.equal(result.status, 'UNCERTAIN', 'the private terminal projection was replaced');
  });
});

describe('per-job authentication policy', () => {
  let authBroker: TestBroker;
  let authWorkspace: string;

  before(async () => {
    authWorkspace = path.join(temp.root, 'ws-auth');
    await mkdir(path.join(authWorkspace, 'src'), { recursive: true });
    // A synthetic value, never a real credential: the harness only ever starts
    // the fake process adapter, so no authenticated CLI can be reached with it.
    authBroker = await startTestBroker({
      stateRoot: path.join(temp.root, 'state-auth'),
      fakeAdapterPath: fakeAdapter,
      env: { [FAKE_TRACE_DIR_ENV]: traceDir, ANTHROPIC_API_KEY: 'sk-ant-fixture-sintetica-sem-valor' },
    });
  });
  after(async () => { await authBroker?.stop(); });

  test('billing authorization is reassessed for every job; a cached probe never carries it over', async () => {
    const registration = await authBroker.api('/api/tasks/register', { method: 'POST', headers: authBroker.bearerHeaders(), body: JSON.stringify({ codexThreadId: 'thread-auth', source: 'codex-thread' }) });
    assert.equal(registration.status, 201, registration.text);
    const { taskId, taskHandle } = registration.body as { taskId: string; taskHandle: string };
    const view = async () => (await authBroker.api(`/api/tasks/${taskId}`, { headers: authBroker.bearerHeaders() })).body as TaskView;

    // 1. The job authorizes the billable path explicitly: it runs, and the
    //    credential is deliberately passed through to the CLI process.
    const authorized = await authBroker.api(`/api/tasks/${taskId}/runs`, { method: 'POST', headers: authBroker.bearerHeaders(), body: JSON.stringify({ taskHandle, job: devJob(authWorkspace, 'say: autorizado', { auth: { allowApiBilling: true } }), observation: { mode: 'voz' } }) });
    assert.equal(authorized.status, 202, authorized.text);
    const running = await waitFor(async () => {
      const current = await view();
      return current.state === 'idle' ? current : undefined;
    }, { timeoutMs: 30000, description: 'authorized run idle' });
    const log = async () => ((await authBroker.api(`/api/tasks/${taskId}/events?cursor=0&waitMs=0&limit=2000`, { headers: authBroker.bearerHeaders() })).body as { events: EventRecord[] }).events;
    const ready = (await log()).find((event) => event.type === 'preflight_ready')!;
    assert.equal(ready.data.auth, 'AUTH_API_BILLING_AUTHORIZED');
    assert.deepEqual(ready.data.authEvidence, ['ANTHROPIC_API_KEY presente no ambiente']);
    const trace = await readTrace(running.currentRun!.workerPid!);
    assert.equal(trace.find((entry) => entry.kind === 'query')!.data.envHasApiKey, true, 'an explicitly authorized job keeps its credential');
    await authBroker.api(`/api/tasks/${taskId}/end`, { method: 'POST', headers: authBroker.bearerHeaders(), body: '{}' });
    await waitFor(async () => ((await view()).state === 'terminal' ? true : undefined), { timeoutMs: 20000, description: 'authorized run ended' });

    // 2. The very next job does not authorize it. The CLI probe is already
    //    cached, but the billing policy is job-scoped and must be refused.
    const refused = await authBroker.api(`/api/tasks/${taskId}/runs`, { method: 'POST', headers: authBroker.bearerHeaders(), body: JSON.stringify({ taskHandle, job: devJob(authWorkspace, 'say: nunca'), observation: { mode: 'voz' } }) });
    assert.equal(refused.status, 202, refused.text);
    const failed = await waitFor(async () => {
      const current = await view();
      return current.currentRun?.status === 'FAIL' ? current : undefined;
    }, { timeoutMs: 30000, description: 'unauthorized run refused' });
    assert.equal(failed.currentRun?.failureStage, 'auth-path');
    assert.equal(failed.currentRun?.failureCode, 'AUTH_API_BILLING_NOT_AUTHORIZED');
    const after = await log();
    assert.ok(!after.some((event) => event.type === 'session_init' && event.runId === failed.currentRun?.runId), 'no session was started on the unauthorized path');
    const failure = after.find((event) => event.type === 'preparation_failed' && event.data.code === 'AUTH_API_BILLING_NOT_AUTHORIZED')!;
    assert.ok(!JSON.stringify(failure).includes('sk-ant-fixture'), 'the evidence names the variable, never its value');
  });
});

describe('model selection between turns', () => {
  test('changing the model is refused mid-turn and applied on the next turn with a recorded reason', async () => {
    const { taskId, taskHandle } = await register('thread-model');
    await startRun(taskId, taskHandle, devJob(workspaceB, script(['say: fable', 'sleep: 2000'])));
    await waitForState(taskId, 'busy_tool');
    const refused = await broker.api(`/api/tasks/${taskId}/model`, { method: 'POST', headers: broker.bearerHeaders(), body: JSON.stringify({ model: OPUS, reason: 'Fable com 3% restante.' }) });
    assert.equal(refused.status, 409);
    // The refusal states which model remained in force, so the caller never has
    // to assume whether its request took effect.
    assert.deepEqual(refused.body, { error: 'TURN_IN_PROGRESS', activeModel: FABLE });
    await waitForState(taskId, 'idle');
    const unauthorized = await broker.api(`/api/tasks/${taskId}/model`, { method: 'POST', headers: broker.bearerHeaders(), body: JSON.stringify({ model: 'claude-sonnet-5', reason: 'x' }) });
    assert.equal(unauthorized.status, 400);
    assert.deepEqual(unauthorized.body, { error: 'MODEL_NOT_AUTHORIZED' });
    const applied = await broker.api(`/api/tasks/${taskId}/model`, { method: 'POST', headers: broker.bearerHeaders(), body: JSON.stringify({ model: OPUS, reason: 'Fable com 3% restante.' }) });
    assert.equal(applied.status, 200, applied.text);
    assert.deepEqual(applied.body, { applied: 'next_turn', strategy: 'in_session', model: OPUS });
    await waitForEvent(taskId, (event) => event.type === 'model_changed');
    await broker.api(`/api/tasks/${taskId}/message`, { method: 'POST', headers: broker.bearerHeaders(), body: JSON.stringify({ text: 'say: agora opus' }) });
    const done = await waitFor(async () => {
      const view = await task(taskId);
      return view.currentRun?.observedModel === OPUS && view.state === 'idle' ? view : undefined;
    }, { timeoutMs: 15000, description: 'observed model switch' });
    assert.equal(done.currentRun?.requestedModel, OPUS);
    assert.equal(done.currentRun?.modelReason, 'Fable com 3% restante.');
    const log = await events(taskId);
    const change = log.find((event) => event.type === 'model_changed')!;
    assert.equal(change.data.from, FABLE);
    assert.equal(change.data.to, OPUS);
    assert.equal(change.data.reason, 'Fable com 3% restante.');
    const trace = await readTrace(done.currentRun!.workerPid!);
    assert.deepEqual(trace.filter((entry) => entry.kind === 'setModel').map((entry) => entry.data.model), [OPUS]);
    await endTask(taskId);
  });

  test('the switch is reserved until the worker confirms, and a queued message waits for a known model', async () => {
    const { taskId, taskHandle } = await register('thread-model-race');
    // The CLI takes a known time to confirm, so the in-flight window is real
    // instead of a race the test would sometimes lose.
    await startRun(taskId, taskHandle, devJob(workspaceB, 'say: primeiro turno'), { harness: { setModelDelayMs: 700 } });
    await waitForState(taskId, 'idle');
    const change = (model: string) => broker.api(`/api/tasks/${taskId}/model`, { method: 'POST', headers: broker.bearerHeaders(), body: JSON.stringify({ model, reason: `Troca para ${model}.` }) });

    const pending = change(OPUS);
    await sleep(200);
    // While the first switch is still unconfirmed the transition is reserved:
    // a second switch is refused and told the model did not change under it.
    const refused = await change(FABLE);
    assert.equal(refused.status, 409, refused.text);
    const refusal = refused.body as { error: string; activeModel: string; pendingModel: string };
    assert.equal(refusal.error, 'MODEL_CHANGE_IN_PROGRESS');
    assert.equal(refusal.activeModel, FABLE, 'the refusal names the model that stayed active');
    assert.equal(refusal.pendingModel, OPUS);
    // A message that arrives during the switch must not start a turn yet.
    const queued = await broker.api(`/api/tasks/${taskId}/message`, { method: 'POST', headers: broker.bearerHeaders(), body: JSON.stringify({ text: 'say: depois da troca' }) });
    assert.equal(queued.status, 202, queued.text);
    const during = await task(taskId);
    assert.equal(during.currentRun?.turns, 1, 'no turn started while the model was still switching');
    assert.equal(during.queue.find((entry) => entry.messageId === (queued.body as { messageId: string }).messageId)?.state, 'queued');

    const applied = await pending;
    assert.equal(applied.status, 200, applied.text);
    assert.deepEqual(applied.body, { applied: 'next_turn', strategy: 'in_session', model: OPUS });
    const done = await waitFor(async () => {
      const view = await task(taskId);
      return view.state === 'idle' && view.currentRun?.turns === 2 ? view : undefined;
    }, { timeoutMs: 20000, description: 'turn after the switch' });
    assert.equal(done.currentRun?.requestedModel, OPUS);
    assert.equal(done.currentRun?.observedModel, OPUS, 'the held turn ran on the model the switch confirmed');
    const log = await events(taskId);
    assert.equal(log.filter((event) => event.type === 'model_changed').length, 1, 'only the accepted switch is recorded');
    await endTask(taskId);
  });

  test('an unconfirmed model switch becomes uncertain and never releases a queued turn', async () => {
    const { taskId, taskHandle } = await register('thread-model-timeout');
    await startRun(taskId, taskHandle, devJob(workspaceB, 'say: primeiro turno'), { harness: { setModelDelayMs: 1500 } });
    await waitForState(taskId, 'idle');
    const pending = broker.api(`/api/tasks/${taskId}/model`, { method: 'POST', headers: broker.bearerHeaders(), body: JSON.stringify({ model: OPUS, reason: 'Teste de confirmação perdida.' }) });
    await sleep(200);
    const queued = await broker.api(`/api/tasks/${taskId}/message`, { method: 'POST', headers: broker.bearerHeaders(), body: JSON.stringify({ text: 'say: não liberar' }) });
    assert.equal(queued.status, 202, queued.text);
    const result = await pending;
    assert.equal(result.status, 409, result.text);
    assert.equal((result.body as { error: string; activeModel: string | null }).error, 'MODEL_CHANGE_UNCERTAIN');
    assert.equal((result.body as { activeModel: string | null }).activeModel, null);
    const uncertain = await waitForState(taskId, 'uncertain');
    assert.equal(uncertain.requiresReview, true);
    assert.equal(uncertain.currentRun?.turns, 1, 'the queued turn did not start on an unknown model');
    assert.equal(uncertain.queue.find((entry) => entry.messageId === (queued.body as { messageId: string }).messageId)?.state, 'queued');
  });
});

describe('parallel worktrees', () => {
  async function enrol(): Promise<void> {
    const response = await broker.api('/api/repos/worktree-policy', {
      method: 'POST', headers: broker.bearerHeaders(),
      body: JSON.stringify({ repo: repoWorkspace, note: 'paralelismo no harness' }),
    });
    assert.equal(response.status, 200, response.text);
  }

  test('a worktree target in an unenrolled repository is refused before any reservation', async () => {
    const { taskId, taskHandle } = await register('thread-worktree-unenrolled');
    await approveTrust(taskId, workspaceA);
    const job = devJob(workspaceA, 'say: nao deve iniciar', { execution: { mode: 'worktree' } });
    const response = await broker.api(`/api/tasks/${taskId}/runs`, { method: 'POST', headers: broker.bearerHeaders(), body: JSON.stringify({ taskHandle, job, observation: { mode: 'voz' } }) });
    // workspaceA is a plain directory, not a repository: the first thing that
    // fails says so, and it fails before anything is reserved.
    assert.ok(response.status === 400 || response.status === 403, response.text);
    assert.ok(['NOT_A_GIT_REPOSITORY', 'WORKTREE_POLICY_REQUIRED'].includes((response.body as { error?: string }).error ?? ''), response.text);
    // The refusal must happen before the synchronous critical section. If it
    // ever moves below the reservation, this task would hold the checkout and
    // the next start would fail with WORKSPACE_WRITER_LOCKED instead.
    const locks = await broker.api('/api/locks', { headers: broker.bearerHeaders() });
    assert.equal(locks.status, 200, locks.text);
    const mine = (locks.body as Array<{ holderTaskId: string }>).filter((lock) => lock.holderTaskId === taskId);
    assert.deepEqual(mine, [], 'nenhuma trava pode sobrar de um job recusado');
    const view = await task(taskId);
    assert.equal(view.currentRun, null, 'nenhuma execução pode ter sido registrada');
    // No lock and no run is the whole claim. Starting a second run here would
    // only couple this test to whatever else happens to hold that checkout.
  });

  test('two tasks run at once in separate worktrees, each holding its own lock', async () => {
    await enrol();
    const first = await register('thread-wt-paralelo-a');
    const second = await register('thread-wt-paralelo-b');
    await approveTrust(first.taskId, repoWorkspace);

    const job = (prompt: string) => devJob(repoWorkspace, prompt, { execution: { mode: 'worktree' } });
    await startRun(first.taskId, first.taskHandle, job('sleep: 1500'));
    // The inverse of WORKSPACE_WRITER_LOCKED: the same repository, at the same
    // time, from a different task — and it is accepted, because the lock is
    // over the working tree and each task has its own.
    await startRun(second.taskId, second.taskHandle, job('sleep: 1500'));

    const locks = await broker.api('/api/locks', { headers: broker.bearerHeaders() });
    assert.equal(locks.status, 200, locks.text);
    const all = locks.body as Array<{ workspaceKey: string; holderTaskId: string; workspace: string }>;
    // Scoped to these two tasks: the shared broker may still hold locks from
    // earlier tests, and a global count would make this assert about them.
    const mine = all.filter((lock) => lock.holderTaskId === first.taskId || lock.holderTaskId === second.taskId);
    assert.equal(mine.length, 2, JSON.stringify(all));
    assert.notEqual(mine[0]?.workspaceKey, mine[1]?.workspaceKey, 'árvores de trabalho diferentes, chaves diferentes');
    // Neither lock is over the declared checkout: both are over provisioned
    // worktrees, which is what lets them coexist.
    for (const lock of mine) {
      assert.ok(lock.workspace.includes('/worktrees/'), lock.workspace);
      assert.ok(!lock.workspace.endsWith('ws-repo'), lock.workspace);
    }

    const firstView = await task(first.taskId);
    assert.ok(firstView.workspace && firstView.workspace !== repoWorkspace, 'a execução roda no worktree, não no checkout declarado');
  });

  test('the fleet cap refuses the next run and names who holds the slots', async () => {
    // Its own repository: the cap counts live runs, so sharing one with the
    // test above would make this assert about that test's leftovers.
    const capRepo = path.join(temp.root, 'ws-repo-teto');
    await mkdir(path.join(capRepo, 'src'), { recursive: true });
    await writeFile(path.join(capRepo, 'CLAUDE.md'), '# projeto do teto\n');
    for (const args of [['init', '--initial-branch=main'], ['config', 'user.email', 'h@example.invalid'], ['config', 'user.name', 'H'], ['config', 'commit.gpgsign', 'false'], ['config', 'core.autocrlf', 'false'], ['add', '.'], ['commit', '-m', 'base']]) {
      const result = await git(args, capRepo);
      assert.equal(result.code, 0, `git ${args.join(' ')}: ${result.stderr}`);
    }
    const response = await broker.api('/api/repos/worktree-policy', {
      method: 'POST', headers: broker.bearerHeaders(),
      body: JSON.stringify({ repo: capRepo, note: 'teto de um', maxParallelRuns: 1 }),
    });
    assert.equal(response.status, 200, response.text);
    const first = await register('thread-wt-teto-a');
    const second = await register('thread-wt-teto-b');
    await approveTrust(first.taskId, capRepo);
    const job = (prompt: string) => devJob(capRepo, prompt, { execution: { mode: 'worktree' } });
    await startRun(first.taskId, first.taskHandle, job('sleep: 1500'));

    const refused = await broker.api(`/api/tasks/${second.taskId}/runs`, {
      method: 'POST', headers: broker.bearerHeaders(),
      body: JSON.stringify({ taskHandle: second.taskHandle, job: job('say: nao deve iniciar'), observation: { mode: 'voz' } }),
    });
    assert.equal(refused.status, 429, refused.text);
    const body = refused.body as { error?: string; limit?: number; holders?: Array<{ taskId: string }> };
    assert.equal(body.error, 'FLEET_CAPACITY_REACHED');
    assert.equal(body.limit, 1);
    // Naming the holders is the point: N sessions share one account, so the
    // user has to know what to wait for.
    assert.deepEqual(body.holders?.map((holder) => holder.taskId), [first.taskId]);
  });
});

describe('diff annotations', () => {
  test('an annotation on an observed file becomes queued guidance, and anything else is refused', async () => {
    const { taskId, taskHandle } = await register('thread-anotacao');
    // A real repository: annotations and diffs are about tracked change, so a
    // directory without .git has nothing to observe and nothing to diff.
    await approveTrust(taskId, repoWorkspace);
    // The simulated CLI emits tool events but never touches the filesystem, so
    // the harness makes the real change git is expected to observe — before the
    // run starts, so the first status read already sees it.
    await writeFile(path.join(repoWorkspace, 'src', 'anotado.ts'), 'export const a = 1;\n');
    await startRun(taskId, taskHandle, devJob(repoWorkspace, script(['say: trabalhando', 'sleep: 20000'])));
    await waitForState(taskId, 'busy_tool');
    await waitFor(async () => ((await task(taskId)).changedFiles.observed.includes('src/anotado.ts') ? true : undefined), { description: 'o arquivo escrito deve aparecer como observado' });

    // A path the broker never observed is refused: an annotation must not be a
    // way to point Claude at somewhere it was not sent.
    const foreign = await broker.api(`/api/tasks/${taskId}/annotations`, {
      method: 'POST', headers: broker.bearerHeaders(),
      body: JSON.stringify({ taskHandle, file: 'src/nunca-tocado.ts', comment: 'olhe aqui' }),
    });
    assert.equal(foreign.status, 400, foreign.text);
    assert.equal((foreign.body as { error?: string }).error, 'FILE_NOT_OBSERVED');

    const empty = await broker.api(`/api/tasks/${taskId}/annotations`, {
      method: 'POST', headers: broker.bearerHeaders(),
      body: JSON.stringify({ taskHandle, file: 'src/anotado.ts', comment: '   ' }),
    });
    assert.equal(empty.status, 400, empty.text);

    const ok = await broker.api(`/api/tasks/${taskId}/annotations`, {
      method: 'POST', headers: broker.bearerHeaders(),
      body: JSON.stringify({ taskHandle, file: 'src/anotado.ts', hunk: '@@ -1 +1 @@', comment: 'renomeie para algo descritivo' }),
    });
    assert.equal(ok.status, 202, ok.text);
    // It travels the ordinary guidance path: same queue, same states, no new
    // delivery mechanism and no change to turn semantics.
    const view = await task(taskId);
    assert.ok(view.queue.some((entry) => entry.state === 'queued' || entry.state === 'delivered'), JSON.stringify(view.queue));

    const diff = await broker.api(`/api/tasks/${taskId}/diff?file=${encodeURIComponent('src/anotado.ts')}&taskHandle=${encodeURIComponent(taskHandle)}`, { headers: broker.bearerHeaders() });
    assert.equal(diff.status, 200, diff.text);
    assert.equal((diff.body as { file: string }).file, 'src/anotado.ts');

    const sensitive = await broker.api(`/api/tasks/${taskId}/diff?file=${encodeURIComponent('.env')}&taskHandle=${encodeURIComponent(taskHandle)}`, { headers: broker.bearerHeaders() });
    assert.ok(sensitive.status === 400 || sensitive.status === 403, sensitive.text);

    await broker.api(`/api/tasks/${taskId}/end`, { method: 'POST', headers: broker.bearerHeaders(), body: '{}' });
  });
});

describe('observation before work', () => {
  test('a run with no panel attached and no declared channel is refused before any reservation', async () => {
    const { taskId, taskHandle } = await register('thread-observacao');
    await approveTrust(taskId, workspaceA);
    // No `observation` at all: the default is `painel`, and no SSE client is
    // subscribed to this task in the harness.
    const refused = await broker.api(`/api/tasks/${taskId}/runs`, {
      method: 'POST', headers: broker.bearerHeaders(),
      body: JSON.stringify({ taskHandle, job: devJob(workspaceA, 'say: nao deve iniciar') }),
    });
    assert.equal(refused.status, 409, refused.text);
    assert.equal((refused.body as { error?: string }).error, 'OBSERVATION_REQUIRED');

    // The refusal happens above the synchronous critical section, so nothing
    // was reserved: no lock, and no run on the task.
    const locks = await broker.api('/api/locks', { headers: broker.bearerHeaders() });
    const mine = (locks.body as Array<{ holderTaskId: string }>).filter((lock) => lock.holderTaskId === taskId);
    assert.deepEqual(mine, [], 'nenhuma trava pode sobrar de um job recusado');
    assert.equal((await task(taskId)).currentRun, null);

    // Declaring voice is an explicit, attributable choice, and it is recorded.
    const accepted = await broker.api(`/api/tasks/${taskId}/runs`, {
      method: 'POST', headers: broker.bearerHeaders(),
      body: JSON.stringify({ taskHandle, job: devJob(workspaceA, 'say: agora sim'), observation: { mode: 'voz' } }),
    });
    assert.equal(accepted.status, 202, accepted.text);
    const events = await broker.api(`/api/tasks/${taskId}/events?cursor=0&taskHandle=${encodeURIComponent(taskHandle)}`, { headers: broker.bearerHeaders() });
    const started = ((events.body as { events: Array<{ type: string; data?: Record<string, unknown> }> }).events).find((event) => event.type === 'run_started');
    assert.deepEqual((started?.data?.observation as { mode?: string } | undefined)?.mode, 'voz', JSON.stringify(started?.data?.observation));

    await broker.api(`/api/tasks/${taskId}/end`, { method: 'POST', headers: broker.bearerHeaders(), body: '{}' });
  });
});

describe('derived files', () => {
  test('are rebuilt from the run cache and stay identical to what the log would produce', async () => {
    const { taskId, taskHandle } = await register('thread-derivados');
    // Its own checkout: sharing one makes this contend with whatever else still
    // holds the writer lock, which has nothing to do with what it asserts.
    const derivedWorkspace = path.join(temp.root, 'ws-derivados');
    await mkdir(path.join(derivedWorkspace, 'src'), { recursive: true });
    const { runId } = await startRun(taskId, taskHandle, devJob(derivedWorkspace, script(['say: primeira', 'say: segunda', 'say: terceira'])));
    await waitFor(async () => ((await task(taskId)).state === 'idle' ? true : undefined), { timeoutMs: 20000, intervalMs: 250, description: 'turno termina' });

    // The cache is an optimisation, never a second source of truth. Deriving
    // from it must produce exactly what deriving from the durable log does.
    const runDir = path.join(broker.stateRoot, 'tasks', taskId, 'runs', runId);
    const { deriveCompatibilityFiles } = await import('../src/events/derive.ts');
    const head = (text: string) => text.split('\n').slice(0, 6).join('\n');

    // The file on disk is written on a debounce, so at any single instant it
    // may be a beat behind or ahead of the page of events read back here. What
    // must hold is that the two derivations converge on the same text — never
    // that a snapshot taken mid-write already matches.
    let fromCache = '';
    let fromLog = '';
    await waitFor(async () => {
      fromCache = await readFile(path.join(runDir, 'acompanhamento.txt'), 'utf8');
      const forRun = (await events(taskId)).filter((event) => event.runId === runId);
      fromLog = deriveCompatibilityFiles(forRun as never, { processAlive: true }).acompanhamento;
      return head(fromCache) === head(fromLog) ? true : undefined;
    }, { timeoutMs: 10000, intervalMs: 200, description: 'derivar do cache e derivar do log coincidem' }).catch(() => undefined);
    assert.equal(head(fromCache), head(fromLog), 'derivar do cache e derivar do log precisam coincidir');
    await endTask(taskId);
  });
});
