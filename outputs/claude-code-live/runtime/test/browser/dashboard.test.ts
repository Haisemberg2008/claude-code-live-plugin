// Browser functional tests for the dashboard, driven through playwright-core
// with the locally installed Edge or Chrome channel (no browser download).
// The dashboard is served by a real broker; tasks come from real workers with
// the fake Claude Code process adapter, so everything shown is derived from
// real events. The one-time bootstrap link is consumed by the browser itself;
// every network request must stay on the broker origin.
import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { startTestBroker, DEFAULT_FAKE_ADAPTER, type TestBroker } from '../helpers/broker-client.ts';
import { makeTempRoot, waitFor, sleep, type TempRoot } from '../helpers/temp.ts';
import { runtimeRoot, distDir } from '../helpers/paths.ts';
import { jobV2 } from '../helpers/fixtures.ts';
import { script, toolDirective, FAKE_TRACE_DIR_ENV, FAKE_USAGE_ENV, TEST_SUPERVISION_ENV } from '../helpers/scenario.ts';

// These callbacks execute inside the browser even though this test file is
// type-checked with Node libraries only.
declare function getComputedStyle(element: unknown): { borderLeftColor: string };

let temp: TempRoot;
let broker: TestBroker;
let browser: Browser | null = null;
let context: BrowserContext;
let page: Page;
let workspace: string;
let unavailable: string | null = null;
const externalRequests: string[] = [];

async function launchBrowser(): Promise<Browser | null> {
  for (const channel of ['msedge', 'chrome'] as const) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch {
      // try the next installed channel
    }
  }
  return null;
}

async function ensureDashboardBuilt(): Promise<void> {
  try {
    await stat(path.join(distDir, 'dashboard', 'index.html'));
    return;
  } catch {
    // build it once
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [path.join('node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', 'vite.config.mts', '--logLevel', 'warn'], { cwd: runtimeRoot, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`vite build exited with ${code}`))));
    child.on('error', reject);
  });
}

async function register(threadId: string): Promise<{ taskId: string; taskHandle: string }> {
  const response = await broker.api('/api/tasks/register', { method: 'POST', headers: broker.bearerHeaders(), body: JSON.stringify({ codexThreadId: threadId, source: 'codex-thread' }) });
  return response.body as { taskId: string; taskHandle: string };
}

async function startRun(taskId: string, taskHandle: string, prompt: string): Promise<string> {
  const response = await broker.api(`/api/tasks/${taskId}/runs`, { method: 'POST', headers: broker.bearerHeaders(), body: JSON.stringify({ taskHandle, job: jobV2(workspace, { prompt, scope: { summary: 's', paths: ['src/'] } }) }) });
  assert.equal(response.status, 202, response.text);
  return (response.body as { runId: string }).runId;
}

async function taskState(taskId: string): Promise<string> {
  const view = (await broker.api(`/api/tasks/${taskId}`, { headers: broker.bearerHeaders() })).body as { state: string };
  return view.state;
}

async function hasAssistantText(taskId: string, text: string): Promise<boolean> {
  const body = (await broker.api(`/api/tasks/${taskId}/events?cursor=0&waitMs=0&limit=2000`, { headers: broker.bearerHeaders() })).body as { events: Array<{ type: string; data: { text?: string } }> };
  return body.events.some((event) => event.type === 'assistant_text' && event.data.text === text);
}

async function endTask(taskId: string): Promise<void> {
  await broker.api(`/api/tasks/${taskId}/end`, { method: 'POST', headers: broker.bearerHeaders(), body: '{}' });
  await waitFor(async () => ((await taskState(taskId)) === 'terminal' ? true : undefined), { timeoutMs: 20000, description: 'task end' });
}

/**
 * Ends whatever a failed test left running. Without this, one failure keeps the
 * checkout writer lock and every later case fails with WORKSPACE_WRITER_LOCKED,
 * which would hide their real result.
 */
async function endLeftovers(): Promise<void> {
  if (!broker) return;
  let views: Array<{ taskId: string; currentRun: { status: string } | null }> = [];
  try {
    views = (await broker.api('/api/tasks', { headers: broker.bearerHeaders() })).body as typeof views;
  } catch {
    return;
  }
  for (const view of views) {
    if (!view.currentRun || ['COMPLETED', 'FAIL', 'CANCELLED', 'UNCERTAIN'].includes(view.currentRun.status)) continue;
    await endTask(view.taskId).catch(() => undefined);
  }
}

before(async () => {
  temp = await makeTempRoot('codeorquestra-browser-');
  workspace = path.join(temp.root, 'ws');
  await mkdir(path.join(workspace, 'src'), { recursive: true });
  await writeFile(path.join(workspace, 'src', 'a.ts'), 'export const a = 1;\n');
  await mkdir(path.join(temp.root, 'trace'), { recursive: true });
  await ensureDashboardBuilt();
  browser = await launchBrowser();
  if (!browser) {
    unavailable = 'no Edge or Chrome channel available for playwright-core on this machine';
    return;
  }
  broker = await startTestBroker({
    stateRoot: path.join(temp.root, 'state'),
    fakeAdapterPath: DEFAULT_FAKE_ADAPTER,
    bootstrap: false,
    env: {
      [FAKE_TRACE_DIR_ENV]: path.join(temp.root, 'trace'),
      [FAKE_USAGE_ENV]: 'unavailable',
      // A short absence window so the honest "aguardando coordenador" label is
      // observable in a test; the alert thresholds keep their real values.
      [TEST_SUPERVISION_ENV]: JSON.stringify({ inactivityAlertMs: 1_200_000, elapsedAlertMs: 7_200_000, coordinatorAbsentMs: 1500 }),
    },
  });
  context = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: 'pt-BR' });
  page = await context.newPage();
  page.on('dialog', (dialog) => { void dialog.dismiss(); externalRequests.push(`dialog:${dialog.message()}`); });
  page.on('request', (request) => {
    if (!request.url().startsWith(broker.baseUrl)) externalRequests.push(request.url());
  });
});
after(async () => {
  await context?.close().catch(() => undefined);
  await browser?.close();
  await broker?.stop();
  await temp.cleanup();
});
afterEach(async () => {
  if (!unavailable) await endLeftovers();
});

describe('dashboard', () => {
  test('the browser consumes the one-time bootstrap link and lands on an honest empty dashboard in Portuguese', async (t) => {
    if (unavailable) { t.skip(unavailable); return; }
    const response = await page.goto(broker.announcement.bootstrapUrl);
    assert.equal(response?.status(), 200);
    assert.equal(new URL(page.url()).pathname, '/');
    assert.equal(new URL(page.url()).search, '', 'the one-time token is stripped from the address bar');
    await page.getByRole('banner').getByText('CodeOrquestra').waitFor();
    await page.getByText('Codex com Opus e Fable').waitFor();
    await page.getByText(/Integração local independente/).waitFor();
    await page.getByText('Nenhuma tarefa ativa').first().waitFor();
    assert.equal(await page.locator('[data-testid="task-item"]').count(), 0, 'no fictitious sample history');
    const background = await page.evaluate('getComputedStyle(document.body).backgroundColor');
    assert.equal(background, 'rgb(16, 19, 27)');
    await page.getByRole('navigation', { name: 'Tarefas' }).waitFor();
    await page.getByRole('complementary', { name: 'Inspetor' }).waitFor();
    const reuse = await fetch(broker.announcement.bootstrapUrl, { redirect: 'manual' });
    await reuse.text();
    assert.equal(reuse.status, 403, 'the link cannot be reused after the browser consumed it');
  });

  test('a running task appears with public messages, safe text, UTF-8, live progress and an expandable tool row', async (t) => {
    if (unavailable) { t.skip(unavailable); return; }
    const { taskId, taskHandle } = await register('thread-ui');
    await startRun(taskId, taskHandle, script([
      'say: Olá <script>alert(1)</script> á🙂fim',
      toolDirective('Read', { file_path: path.join(workspace, 'src', 'a.ts') }),
      'sleep: 1500',
    ]));
    const item = page.locator('[data-testid="task-item"]').filter({ hasText: 'thread-ui' });
    await item.waitFor({ timeout: 15000 });
    await item.getByText('Simulado').waitFor();
    await item.click();
    const feed = page.getByRole('main');
    await feed.getByText('Olá <script>alert(1)</script> á🙂fim', { exact: true }).waitFor({ timeout: 15000 });
    assert.equal(await page.locator('script:not([src])').count(), 0, 'no inline script was injected');
    const toolRow = feed.locator('[data-testid="tool-row"]').filter({ hasText: 'Read' });
    await toolRow.waitFor({ timeout: 15000 });
    const claudeReply = feed.locator('[data-testid="message-row"]').filter({ hasText: 'Olá <script>alert(1)</script> á🙂fim' });
    assert.equal(await claudeReply.getAttribute('data-actor'), 'claude');
    assert.equal(await claudeReply.getAttribute('data-event-role'), 'response');
    await claudeReply.getByText('Resposta do Claude', { exact: true }).waitFor();
    assert.equal(await toolRow.getAttribute('data-actor'), 'claude');
    assert.equal(await toolRow.getAttribute('data-event-role'), 'command');
    await toolRow.getByText('Comando do Claude', { exact: true }).waitFor();
    const [replyAccent, toolAccent] = await Promise.all([
      claudeReply.evaluate((element) => getComputedStyle(element).borderLeftColor),
      toolRow.evaluate((element) => getComputedStyle(element).borderLeftColor),
    ]);
    assert.notEqual(replyAccent, toolAccent, 'Claude replies and Claude commands use distinct accents');
    await toolRow.getByRole('button', { name: /Detalhes/ }).click();
    await toolRow.getByText('file_path').waitFor();
    await toolRow.getByText(/Resultado/).waitFor({ timeout: 15000 });
    const inspector = page.getByRole('complementary', { name: 'Inspetor' });
    await inspector.getByText('Modelo solicitado').waitFor();
    await inspector.getByText('claude-fable-5-1').first().waitFor();
    await inspector.getByText('Modelo confirmado').waitFor();
    await inspector.getByText('Extra (xhigh) configurado').waitFor();
    await inspector.getByRole('heading', { name: 'Capacidade' }).waitFor();
    // Anchored and case-sensitive: the effort line also ends in "indisponível".
    await inspector.getByText(/^Indisponível/).waitFor();
    await inspector.getByRole('heading', { name: 'Consumo por fonte' }).waitFor();
    const claudeUsage = inspector.locator('[data-testid="usage-claude"]');
    await claudeUsage.getByText('Claude nesta tarefa').waitFor();
    await claudeUsage.getByText('reportado').waitFor();
    await claudeUsage.getByText('Entrada').waitFor();
    await claudeUsage.getByText('Saída').waitFor();
    await claudeUsage.getByText('Cache lido').waitFor();
    const codexUsage = inspector.locator('[data-testid="usage-codex-task"]');
    await codexUsage.getByText('Codex nesta tarefa').waitFor();
    await codexUsage.getByText('indisponível').waitFor();
    const refreshUsage = inspector.getByRole('button', { name: 'Atualizar consumo' });
    await refreshUsage.waitFor();
    const [refreshResponse] = await Promise.all([
      page.waitForResponse((response) => response.url().endsWith(`/api/tasks/${taskId}/usage-refresh`) && response.request().method() === 'POST'),
      refreshUsage.click(),
    ]);
    assert.equal(refreshResponse.status(), 200);
    await inspector.getByText('Revisão independente pendente').waitFor();
    await inspector.getByRole('heading', { name: 'Arquivos alterados observados' }).waitFor();
    assert.equal(await page.locator('[data-testid="progress-percent"]').count(), 0, 'no fake progress percentage');
    assert.equal(await page.getByText(/raciocínio oculto|thinking/i).count(), 0, 'no hidden reasoning is displayed or claimed');
    await page.getByRole('main').getByText('aguardando coordenador').waitFor();
    await waitFor(async () => ((await taskState(taskId)) === 'idle' ? true : undefined), { timeoutMs: 20000, description: 'first UI task idle' });
    await endTask(taskId);
    await item.locator('.state-terminal').waitFor({ timeout: 15000 });
    // The row states the outcome, it does not repeat "Encerrada" twice.
    await item.getByTestId('run-outcome').getByText('Concluída').waitFor({ timeout: 15000 });
  });

  test('controls queue guidance, answer a permission, interrupt the turn and end the session with recorded browser origin', async (t) => {
    if (unavailable) { t.skip(unavailable); return; }
    const { taskId, taskHandle } = await register('thread-ui-controls');
    await startRun(taskId, taskHandle, script([toolDirective('Bash', { command: 'curl https://example.com' }), 'say: depois', 'sleep: 60000']));
    const item = page.locator('[data-testid="task-item"]').filter({ hasText: 'thread-ui-controls' });
    await item.waitFor({ timeout: 15000 });
    await item.click();
    const main = page.getByRole('main');
    const request = main.locator('[data-testid="permission-request"]');
    await request.waitFor({ timeout: 15000 });
    await request.getByText('EXTERNAL_NETWORK').waitFor();
    await request.getByRole('button', { name: 'Negar' }).click();
    await request.getByText(/Decisão: negada por Navegador/).waitFor({ timeout: 15000 });
    await main.getByText('depois', { exact: true }).waitFor({ timeout: 15000 });

    const composer = page.getByRole('textbox', { name: 'Orientação para o próximo turno' });
    await composer.fill('say: orientação do navegador');
    await page.getByRole('button', { name: 'Enfileirar orientação' }).click();
    await main.getByText('Na fila').waitFor({ timeout: 10000 });
    const codexInstruction = main.locator('[data-testid="message-row"]').filter({ hasText: 'orientação do navegador' });
    assert.equal(await codexInstruction.getAttribute('data-actor'), 'codex');
    assert.equal(await codexInstruction.getAttribute('data-event-role'), 'instruction');
    await codexInstruction.getByText('Orientação do Codex', { exact: true }).waitFor();
    const codexAccent = await codexInstruction.evaluate((element) => getComputedStyle(element).borderLeftColor);
    const claudeAccent = await main.locator('[data-testid="message-row"]').filter({ hasText: 'depois' }).evaluate((element) => getComputedStyle(element).borderLeftColor);
    const toolAccent = await main.locator('[data-testid="tool-row"]').first().evaluate((element) => getComputedStyle(element).borderLeftColor);
    assert.equal(new Set([codexAccent, claudeAccent, toolAccent]).size, 3, 'Codex instructions, Claude replies and Claude commands use three distinct accents');

    await page.getByRole('button', { name: 'Interromper turno' }).click();
    await main.getByText('Turno interrompido').waitFor({ timeout: 15000 });
    await main.getByText('orientação do navegador', { exact: true }).waitFor({ timeout: 20000 });

    await page.getByRole('button', { name: 'Encerrar sessão' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Confirmar encerramento' }).click();
    await item.locator('.state-terminal').waitFor({ timeout: 15000 });
    await item.getByTestId('run-outcome').waitFor({ timeout: 15000 });

    const events = (await broker.api(`/api/tasks/${taskId}/events?cursor=0&waitMs=0&limit=2000`, { headers: broker.bearerHeaders() })).body as { events: Array<{ type: string; data: Record<string, unknown> }> };
    const sources = events.events.filter((event) => ['permission_resolved', 'message_queued', 'turn_interrupted', 'session_end_requested'].includes(event.type)).map((event) => event.data.source);
    assert.deepEqual([...new Set(sources)], ['browser'], 'browser actions carry their own audited source identity');
  });

  test('reload replays from the cursor without duplicate or lost rows and pages a large log', async (t) => {
    if (unavailable) { t.skip(unavailable); return; }
    const { taskId, taskHandle } = await register('thread-ui-large');
    const lines = Array.from({ length: 120 }, (_, i) => `say: linha ${i + 1}`);
    await startRun(taskId, taskHandle, script([...lines, 'big: 20000']));
    const item = page.locator('[data-testid="task-item"]').filter({ hasText: 'thread-ui-large' });
    await item.waitFor({ timeout: 15000 });
    await item.click();
    await waitFor(async () => ((await taskState(taskId)) === 'idle' && (await hasAssistantText(taskId, 'linha 120')) ? true : undefined), { timeoutMs: 60000, description: 'large turn completion' });
    const main = page.getByRole('main');
    await main.getByText('linha 120', { exact: true }).waitFor({ timeout: 30000 });
    const olderButton = main.getByRole('button', { name: 'Carregar anteriores' });
    await olderButton.waitFor();
    const visibleBefore = await main.locator('[data-testid="message-row"]').count();
    assert.ok(visibleBefore < 121, 'the feed pages instead of rendering everything at once');
    await olderButton.click();
    await main.getByText('linha 1', { exact: true }).waitFor({ timeout: 10000 });
    const visibleAfter = await main.locator('[data-testid="message-row"]').count();
    assert.ok(visibleAfter > visibleBefore);
    await main.getByText('Saída truncada para visualização').waitFor();
    await page.reload();
    await item.click();
    await main.getByText('linha 120', { exact: true }).waitFor({ timeout: 30000 });
    const texts = await main.locator('[data-testid="message-row"]').allInnerTexts();
    const line120 = texts.filter((text) => text.includes('linha 120')).length;
    assert.equal(line120, 1, 'no duplicate rows after reconnect');
    await endTask(taskId);
  });

  test('a question from Claude is labelled as a question, answered from the browser, and never shown as a permission prompt', async (t) => {
    if (unavailable) { t.skip(unavailable); return; }
    const { taskId, taskHandle } = await register('thread-ui-question');
    await startRun(taskId, taskHandle, script(['ask: Qual banco usar?', 'say: anotado']));
    const item = page.locator('[data-testid="task-item"]').filter({ hasText: 'thread-ui-question' });
    await item.waitFor({ timeout: 15000 });
    await item.click();
    const main = page.getByRole('main');
    const question = main.locator('[data-testid="question-request"]');
    await question.waitFor({ timeout: 15000 });
    await question.getByText('Pergunta do Claude').waitFor();
    assert.equal(await main.locator('[data-testid="permission-request"]').count(), 0, 'a question is never rendered as a permission prompt');
    await item.getByText('Aguardando resposta à pergunta').waitFor({ timeout: 15000 });
    await question.getByRole('radio', { name: 'Sim' }).check();
    await question.getByRole('button', { name: 'Enviar resposta' }).click();
    await main.getByText('anotado', { exact: true }).waitFor({ timeout: 20000 });
    await question.getByText(/Decisão: respondida por Navegador/).waitFor({ timeout: 15000 });
    await waitFor(async () => ((await taskState(taskId)) === 'idle' ? true : undefined), { timeoutMs: 20000, description: 'question task idle' });
    await endTask(taskId);
  });

  test('the end confirmation is bound to the task it was opened for, and elapsed time keeps moving during silence', async (t) => {
    if (unavailable) { t.skip(unavailable); return; }
    const { taskId, taskHandle } = await register('thread-ui-confirm');
    await startRun(taskId, taskHandle, script(['say: aguardando', 'sleep: 60000']));
    const item = page.locator('[data-testid="task-item"]').filter({ hasText: 'thread-ui-confirm' });
    await item.waitFor({ timeout: 15000 });
    await item.click();
    const inspector = page.getByRole('complementary', { name: 'Inspetor' });
    await inspector.getByText('Tempo decorrido').waitFor({ timeout: 15000 });
    const readElapsed = () => page.evaluate(`(() => { const terms = [...document.querySelectorAll('.inspector dt')]; const dt = terms.find((node) => node.textContent === 'Tempo decorrido'); return dt && dt.nextElementSibling ? dt.nextElementSibling.textContent : null; })()`);
    const firstElapsed = await readElapsed();
    assert.ok(firstElapsed, 'the inspector shows an elapsed time');
    await sleep(2500);
    const secondElapsed = await readElapsed();
    assert.notEqual(secondElapsed, firstElapsed, 'elapsed time ticks without any new event');
    // A timestamp is rendered for real rows, not a relative placeholder.
    const times = await page.getByRole('main').locator('.time').allInnerTexts();
    assert.ok(times.some((text) => /\d{2}:\d{2}/.test(text)), `rows carry a clock timestamp: ${times.slice(0, 5).join(' | ')}`);

    await page.getByRole('button', { name: 'Encerrar sessão' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    assert.equal(await dialog.getAttribute('aria-modal'), 'true', 'the confirmation is modal, so no other task can be selected behind it');
    await dialog.getByText('thread-ui-confirm').waitFor();
    // Abandoning the confirmation must leave the session untouched, and the
    // transient state must not survive a task switch.
    await dialog.getByRole('button', { name: 'Cancelar' }).click();
    assert.equal(await page.getByRole('dialog').count(), 0);
    const other = page.locator('[data-testid="task-item"]').filter({ hasText: 'thread-ui-question' });
    await other.click();
    assert.equal(await page.getByRole('dialog').count(), 0, 'switching tasks never restores a confirmation opened for another task');
    assert.notEqual(await taskState(taskId), 'terminal', 'nothing was ended by the abandoned confirmation');

    await item.click();
    await page.getByRole('button', { name: 'Encerrar sessão' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Confirmar encerramento' }).click();
    await item.locator('.state-terminal').waitFor({ timeout: 20000 });
    // Ending while the turn is still running is a cancellation, not a completion.
    await item.getByTestId('run-outcome').getByText('Cancelada').waitFor({ timeout: 20000 });
  });

  test('a task registered while the panel is connected appears without a reload', async (t) => {
    if (unavailable) { t.skip(unavailable); return; }
    const item = page.locator('[data-testid="task-item"]').filter({ hasText: 'thread-ui-idle' });
    assert.equal(await item.count(), 0, 'the task does not exist yet');
    const { taskId } = await register('thread-ui-idle');
    // No run is started: registration alone must reach the connected panel.
    await item.waitFor({ timeout: 15000 });
    await item.getByText('Encerrada').waitFor({ timeout: 15000 });
    assert.equal(await taskState(taskId), 'terminal', 'an idle registered task has no run yet');
  });

  test('every browser request stayed on the broker origin and no dialog fired', async (t) => {
    if (unavailable) { t.skip(unavailable); return; }
    assert.deepEqual(externalRequests, []);
  });

  test('a closed tab does not stop the worker', async (t) => {
    if (unavailable) { t.skip(unavailable); return; }
    const { taskId, taskHandle } = await register('thread-ui-close');
    await startRun(taskId, taskHandle, script(['say: sigo', 'sleep: 3000', 'say: terminei']));
    const item = page.locator('[data-testid="task-item"]').filter({ hasText: 'thread-ui-close' });
    await item.waitFor({ timeout: 15000 });
    await page.close();
    const done = await waitFor(async () => ((await hasAssistantText(taskId, 'terminei')) ? true : undefined), { timeoutMs: 30000, description: 'the worker keeps producing after the tab closed' });
    assert.equal(done, true);
    assert.equal(await taskState(taskId), 'idle', 'the session is still open; closing the tab never ends it');
    await endTask(taskId);
  });
});
