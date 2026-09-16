// MCP stdio adapter: attaches to the shared broker (no duplicate workers),
// exposes the same actions as HTTP, and never accepts arbitrary thread IDs as
// authorization; task handles come from the explicit registration bootstrap
// and every task-scoped tool (including the dashboard link) is bound to them.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startTestBroker, harnessEnvironment, DEFAULT_FAKE_ADAPTER, DEFAULT_FAKE_CLI, type TestBroker } from './helpers/broker-client.ts';
import { makeTempRoot, waitFor, type TempRoot } from './helpers/temp.ts';
import { srcEntry, runtimeRoot } from './helpers/paths.ts';
import { jobV2 } from './helpers/fixtures.ts';
import { script, ENV } from './helpers/scenario.ts';

let temp: TempRoot;
let broker: TestBroker;
let workspace: string;

const EXPECTED_TOOLS = [
  'codeorquestra_annotate',
  'codeorquestra_answer',
  'codeorquestra_dashboard_url',
  'codeorquestra_end',
  'codeorquestra_interrupt',
  'codeorquestra_inventory',
  'codeorquestra_list',
  'codeorquestra_message',
  'codeorquestra_pair',
  'codeorquestra_set_model',
  'codeorquestra_set_policy',
  'codeorquestra_start',
  'codeorquestra_status',
  'codeorquestra_trust',
  'codeorquestra_usage_refresh',
  'codeorquestra_wait',
];

type ToolResult = { content?: Array<{ type: string; text?: string }>; isError?: boolean };

async function withClient<T>(env: Record<string, string>, fn: (client: Client) => Promise<T>): Promise<T> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', srcEntry('mcp', 'main.ts'), '--state-root', broker.stateRoot],
    env: harnessEnvironment({ [ENV.adapter]: DEFAULT_FAKE_ADAPTER, [ENV.cli]: DEFAULT_FAKE_CLI, ...env }),
    cwd: runtimeRoot,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'codeorquestra-test', version: '0.0.0' });
  try {
    await client.connect(transport);
    return await fn(client);
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
}

function textOf(result: ToolResult): string {
  return (result.content ?? []).filter((part) => part.type === 'text').map((part) => part.text ?? '').join('\n');
}

function parse(result: unknown): Record<string, unknown> {
  return JSON.parse(textOf(result as ToolResult)) as Record<string, unknown>;
}

before(async () => {
  temp = await makeTempRoot('codeorquestra-mcp-');
  workspace = path.join(temp.root, 'ws');
  await mkdir(path.join(workspace, 'src'), { recursive: true });
  broker = await startTestBroker({ stateRoot: path.join(temp.root, 'state'), fakeAdapterPath: DEFAULT_FAKE_ADAPTER });
});
after(async () => {
  await broker?.stop();
  await temp.cleanup();
});

describe('stdio adapter', () => {
  test('lists the coordination tools and reports only broker health without a handle', async () => {
    await withClient({}, async (client) => {
      const tools = await client.listTools();
      assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), EXPECTED_TOOLS);
      const status = parse(await client.callTool({ name: 'codeorquestra_status', arguments: {} }));
      const health = status.broker as { pid: number; tagline: string };
      assert.equal(health.pid, broker.announcement.pid, 'the adapter attaches to the running broker instead of starting its own');
      assert.equal(health.tagline, 'Codex com Opus e Fable');
      assert.deepEqual(status.tasks, [], 'no task data without a task handle');
    });
  });

  test('start and dashboard links require a handle minted by the registration bootstrap, never a thread id argument', async () => {
    await withClient({ CODEX_THREAD_ID: 'thread-shared-server' }, async (client) => {
      const noHandle = await client.callTool({ name: 'codeorquestra_start', arguments: { observation: { mode: 'voz' }, codexThreadId: 'thread-shared-server', job: jobV2(workspace, { prompt: 'say: oi', scope: { summary: 's', paths: ['src/'] } }) } }) as ToolResult;
      assert.equal(noHandle.isError, true);
      assert.match(textOf(noHandle), /TASK_HANDLE_REQUIRED/);
      const forged = await client.callTool({ name: 'codeorquestra_start', arguments: { observation: { mode: 'voz' }, taskHandle: 'x'.repeat(43), job: jobV2(workspace, { prompt: 'say: oi', scope: { summary: 's', paths: ['src/'] } }) } }) as ToolResult;
      assert.equal(forged.isError, true);
      assert.match(textOf(forged), /TASK_HANDLE_INVALID/);
      const link = await client.callTool({ name: 'codeorquestra_dashboard_url', arguments: { taskHandle: 'x'.repeat(43) } }) as ToolResult;
      assert.equal(link.isError, true);
      assert.match(textOf(link), /TASK_HANDLE_INVALID/);
    });
  });

  test('with a registered handle the adapter drives the same task the HTTP API sees, without duplicating workers, and cannot reach another task', async () => {
    const registration = await broker.api('/api/tasks/register', { method: 'POST', headers: broker.bearerHeaders(), body: JSON.stringify({ codexThreadId: 'thread-mcp', source: 'codex-thread' }) });
    const { taskId, taskHandle } = registration.body as { taskId: string; taskHandle: string };
    const other = await broker.api('/api/tasks/register', { method: 'POST', headers: broker.bearerHeaders(), body: JSON.stringify({ codexThreadId: 'thread-mcp-other', source: 'codex-thread' }) });
    const otherTask = other.body as { taskId: string; taskHandle: string };
    await withClient({}, async (client) => {
      const started = await client.callTool({ name: 'codeorquestra_start', arguments: { observation: { mode: 'voz' }, taskHandle, job: jobV2(workspace, { prompt: script(['say: via mcp', 'sleep: 1500']), scope: { summary: 's', paths: ['src/'] } }) } }) as ToolResult;
      assert.equal(started.isError ?? false, false, textOf(started));
      const startBody = parse(started) as { taskId: string; runId: string };
      assert.equal(startBody.taskId, taskId);
      assert.match(startBody.runId, /^run-/);
      const viaHttp = await waitFor(async () => {
        const view = (await broker.api(`/api/tasks/${taskId}`, { headers: broker.bearerHeaders() })).body as { currentRun: { runId: string; workerPid: number } | null };
        return view.currentRun?.runId === startBody.runId && view.currentRun.workerPid ? view : undefined;
      }, { timeoutMs: 15000, description: 'run visible over HTTP' });
      const waited = parse(await client.callTool({ name: 'codeorquestra_wait', arguments: { taskHandle, cursor: 0, waitMs: 500 } })) as { events: Array<{ type: string }>; cursor: number; task: Record<string, unknown> };
      assert.ok(waited.events.some((event) => event.type === 'run_started'));
      // The polling loop gets a summary, not the full view: re-spending the
      // coordinator's context on unchanged data shortens the session it runs.
      assert.ok(!('quota' in waited.task), 'o payload de poll nao carrega o bloco de quota');
      assert.ok(!('usage' in waited.task), 'nem o bloco de uso');
      assert.equal(typeof (waited.task.changedFiles as { observedCount?: unknown }).observedCount, 'number', 'arquivos observados viram contagem');
      assert.ok(Array.isArray(waited.task.pendingRequests), 'decisoes pendentes continuam completas: e o que exige acao');
      assert.ok(waited.cursor >= 1);
      const message = parse(await client.callTool({ name: 'codeorquestra_message', arguments: { taskHandle, text: 'say: orientação mcp' } })) as { source: string; messageId: string };
      assert.equal(message.source, 'mcp');
      assert.match(message.messageId, /^msg-/);
      const list = parse(await client.callTool({ name: 'codeorquestra_list', arguments: { taskHandle } })) as { active: Array<{ taskId: string; workerPid: number }>; history: unknown[] };
      assert.equal(list.active.length, 1);
      assert.equal(list.active[0]!.taskId, taskId);
      assert.equal(list.active[0]!.workerPid, viaHttp.currentRun!.workerPid, 'exactly one worker for the task');
      const dashboard = parse(await client.callTool({ name: 'codeorquestra_dashboard_url', arguments: { taskHandle } })) as { url: string; scope: string; note: string };
      assert.match(dashboard.url, /^http:\/\/127\.0\.0\.1:\d+\/bootstrap\?token=/);
      assert.equal(dashboard.scope, taskId, 'the MCP dashboard link is scoped to the task');
      assert.equal(dashboard.note, 'Link de uso único; abra no navegador desta máquina.');
      const usage = parse(await client.callTool({ name: 'codeorquestra_usage_refresh', arguments: { taskHandle } })) as { usage: { quality: string; failure: { code: string } } };
      assert.equal(usage.usage.quality, 'unavailable');
      assert.equal(usage.usage.failure.code, 'CODEX_USAGE_DISABLED_IN_HARNESS');
      const foreign = await client.callTool({ name: 'codeorquestra_wait', arguments: { taskHandle: otherTask.taskHandle, cursor: 0, waitMs: 10 } }) as ToolResult;
      const foreignBody = parse(foreign) as { events: Array<{ taskId: string; type: string }> };
      assert.ok(foreignBody.events.length >= 1 && foreignBody.events.every((event) => event.taskId === otherTask.taskId), 'the other task handle only sees its own task');
      assert.ok(!foreignBody.events.some((event) => event.type === 'run_started'), 'no run from the first task leaks through the other handle');
      const ended = await client.callTool({ name: 'codeorquestra_end', arguments: { taskHandle } }) as ToolResult;
      assert.equal(ended.isError ?? false, false, textOf(ended));
      await waitFor(async () => {
        const view = (await broker.api(`/api/tasks/${taskId}`, { headers: broker.bearerHeaders() })).body as { state: string };
        return view.state === 'terminal' ? true : undefined;
      }, { timeoutMs: 15000, description: 'terminal state' });
    });
  });

  test('a second adapter process shares the broker instead of spawning another one', async () => {
    await withClient({}, async (first) => {
      await withClient({}, async (second) => {
        const a = parse(await first.callTool({ name: 'codeorquestra_status', arguments: {} })) as { broker: { pid: number } };
        const b = parse(await second.callTool({ name: 'codeorquestra_status', arguments: {} })) as { broker: { pid: number } };
        assert.equal(a.broker.pid, b.broker.pid);
        assert.equal(a.broker.pid, broker.announcement.pid);
      });
    });
  });
});
