import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveJobContract } from '../src/contract/job-contract.ts';
import type { WorkerDescriptor } from '../src/worker/protocol.ts';
import { startTestBroker, DEFAULT_FAKE_ADAPTER, DEFAULT_FAKE_CLI, harnessEnvironment } from './helpers/broker-client.ts';
import { makeTempRoot, waitFor } from './helpers/temp.ts';
import { jobV2 } from './helpers/fixtures.ts';
import { srcEntry } from './helpers/paths.ts';
import { ENV } from './helpers/scenario.ts';

test('shutdown cancels an admitted preparation before spawning or releasing work', async () => {
  const temp = await makeTempRoot('codeorquestra-shutdown-');
  const workspace = path.join(temp.root, 'workspace');
  await mkdir(path.join(workspace, 'src'), { recursive: true });
  const broker = await startTestBroker({ stateRoot: path.join(temp.root, 'state') });
  try {
    const registered = await broker.api('/api/tasks/register', {
      method: 'POST',
      headers: broker.bearerHeaders(),
      body: JSON.stringify({ codexThreadId: 'thread-shutdown-preparation', source: 'codex-thread' }),
    });
    assert.equal(registered.status, 201, registered.text);
    const { taskId, taskHandle } = registered.body as { taskId: string; taskHandle: string };
    const started = await broker.api(`/api/tasks/${taskId}/runs`, {
      method: 'POST',
      headers: broker.bearerHeaders(),
      body: JSON.stringify({
        taskHandle,
        job: jobV2(workspace, { prompt: 'say: este turno nunca deve iniciar', scope: { summary: 'src', paths: ['src/'] } }),
        harness: { preparationDelayMs: 750 },
      }),
    });
    assert.equal(started.status, 202, started.text);

    await broker.stop();
    const current = JSON.parse(await readFile(path.join(broker.stateRoot, 'tasks', taskId, 'current-run.json'), 'utf8')) as { workerPid: number | null; status: string };
    assert.equal(current.workerPid, null, 'shutdown must win before any worker is spawned');
    assert.equal(current.status, 'STARTING', 'the next broker reconciles the interrupted admission explicitly');
  } finally {
    await broker.stop();
    await temp.cleanup();
  }
});

test('a worker disconnected during identity bootstrap exits before starting Claude', async () => {
  const temp = await makeTempRoot('codeorquestra-worker-bootstrap-');
  const workspace = path.join(temp.root, 'workspace');
  const runDir = path.join(temp.root, 'task', 'runs', 'run-bootstrap');
  const traceDir = path.join(temp.root, 'trace');
  await mkdir(path.join(workspace, 'src'), { recursive: true });
  await mkdir(runDir, { recursive: true });
  await mkdir(traceDir, { recursive: true });
  const descriptor: WorkerDescriptor = {
    taskId: 'task-bootstrap',
    runId: 'run-bootstrap',
    threadId: 'thread-bootstrap',
    stateRoot: path.join(temp.root, 'state'),
    taskDir: path.join(temp.root, 'task'),
    runDir,
    contract: resolveJobContract(jobV2(workspace, { scope: { summary: 'src', paths: ['src/'] } })),
    prompt: 'say: nunca iniciar',
    resumeSessionId: null,
    resumeMode: 'new',
    launch: {
      settingSources: [],
      strictMcpConfig: true,
      mcpConfigIsExhaustive: true,
      autoMemoryEnabled: false,
      env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
      mcpServers: {},
      loadProjectInstructions: false,
      pendingApproval: [],
      reason: 'teste',
    },
    approvedMcpTools: {},
    approvedAgents: [],
    approvedSkills: [],
    executable: { path: DEFAULT_FAKE_CLI, runWith: 'node', cliVersion: '2.1.263-fake' },
    harness: { adapterPath: DEFAULT_FAKE_ADAPTER },
  };
  const descriptorFile = path.join(runDir, 'worker-descriptor.json');
  await writeFile(descriptorFile, JSON.stringify(descriptor));
  const child = spawn(process.execPath, [
    '--experimental-strip-types',
    '--disable-warning=ExperimentalWarning',
    srcEntry('worker', 'main.ts'),
    '--descriptor',
    descriptorFile,
  ], {
    cwd: workspace,
    env: harnessEnvironment({
      [ENV.traceDir]: traceDir,
      CODEORQUESTRA_TASK_ID: descriptor.taskId,
      CODEORQUESTRA_RUN_ID: descriptor.runId,
      CODEORQUESTRA_RUN_TOKEN: 'bootstrap-token',
    }),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
  try {
    await waitFor(async () => {
      try {
        const identity = JSON.parse(await readFile(path.join(runDir, 'worker-identity.json'), 'utf8')) as { createdAt?: string | null };
        return identity.createdAt === null ? true : undefined;
      } catch {
        return undefined;
      }
    }, { timeoutMs: 5000, description: 'worker identity probe window' });
    child.disconnect();
    const outcome = await Promise.race([
      exited,
      new Promise<'still-running'>((resolve) => setTimeout(() => resolve('still-running'), 5000)),
    ]);
    assert.equal(outcome, 3, 'losing the broker during bootstrap must stop the worker before the CLI can start');
    const launcherTrace = await readFile(path.join(traceDir, 'launcher.jsonl'), 'utf8').catch(() => '');
    const processTrace = await readFile(path.join(traceDir, `${descriptor.runId}.jsonl`), 'utf8').catch(() => '');
    assert.equal(launcherTrace, '', 'the installed CLI launcher was never reached');
    assert.equal(processTrace, '', 'the Claude process adapter was never reached');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    await temp.cleanup();
  }
});
