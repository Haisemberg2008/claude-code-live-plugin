// MCP stdio adapter for Codex.
//
// Attaches to the shared local broker (one broker, one worker per task) and
// exposes the same actions as the HTTP API. Every task-scoped tool requires
// the task handle minted by the terminal bootstrap
// (`codeorquestra task register`); thread IDs passed as arguments are never
// accepted as authorization. This is an application-level routing boundary:
// processes running as the same OS user are not isolated from it.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import path from 'node:path';
import { ensureBroker } from '../broker/client.ts';
import { CLIENT_HEADER } from '../broker/http.ts';
import { defaultStateRoot } from '../broker/runtime-paths.ts';
import { BRAND, RUNTIME_VERSION } from '../shared/types.ts';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  process.stdout.write(`${BRAND.name} MCP stdio adapter ${RUNTIME_VERSION}\nUse: mcp-stdio [--state-root <dir>]\nAs ferramentas exigem o taskHandle emitido por "codeorquestra task register" no terminal da tarefa Codex.\n${BRAND.disclaimer}\n`);
  process.exit(0);
}
const rootIndex = args.indexOf('--state-root');
const stateRoot = rootIndex >= 0 && args[rootIndex + 1] ? path.resolve(args[rootIndex + 1]!) : defaultStateRoot();

interface Bound { baseUrl: string; secret: string }
let bound: Bound | null = null;

async function broker(refresh = false): Promise<Bound> {
  if (bound && !refresh) return bound;
  const info = await ensureBroker(stateRoot);
  bound = { baseUrl: info.baseUrl, secret: info.secret };
  return bound;
}

/**
 * Calls the broker, rediscovering its address and secret when the cached ones
 * stop working — a broker that restarted listens on a new port.
 *
 * A GET is safe to repeat, so it is retried transparently. A mutation is NOT:
 * a transport failure leaves delivery UNCERTAIN, because the request may have
 * been applied before the connection broke. Those surface the uncertainty and
 * ask for an explicit retry instead of silently acting twice.
 */
async function call(method: string, pathname: string, body?: unknown, options: { idempotent?: boolean } = {}): Promise<{ status: number; body: unknown }> {
  const send = async (target: Bound): Promise<{ status: number; body: unknown }> => {
    const response = await fetch(`${target.baseUrl}${pathname}`, {
      method,
      headers: { authorization: `Bearer ${target.secret}`, 'content-type': 'application/json', [CLIENT_HEADER]: 'mcp' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  // Idempotence is a property of the operation, not of the HTTP verb: handle
  // resolution is a POST that only looks something up, and every tool starts
  // with it. Treating it as a mutation would leave the adapter pinned to a
  // dead port and make every tool fail after a broker restart.
  const idempotent = options.idempotent ?? method === 'GET';
  try {
    return await send(await broker());
  } catch (error) {
    if (!idempotent) {
      throw new McpDeliveryUncertain(pathname, (error as Error).message);
    }
    // Safe to repeat: rediscover the broker and look it up again.
    try {
      return await send(await broker(true));
    } catch (retryError) {
      throw new Error(`BROKER_UNREACHABLE: ${(retryError as Error).message}`);
    }
  }
}

/** A mutation whose delivery could not be confirmed; never retried automatically. */
class McpDeliveryUncertain extends Error {
  constructor(pathname: string, detail: string) {
    super(JSON.stringify({
      error: 'DELIVERY_UNCERTAIN',
      operation: pathname,
      detail,
      note: 'A conexão com o broker falhou durante uma operação que altera estado. Ela pode ter sido aplicada. Consulte o estado atual (status/list/wait) e repita explicitamente apenas se necessário; nada é reenviado automaticamente.',
    }));
    this.name = 'McpDeliveryUncertain';
  }
}

async function taskIdFor(taskHandle: string): Promise<string> {
  // A pure lookup: repeating it changes nothing, so it may rediscover.
  const result = await call('POST', '/api/tasks/by-handle', { taskHandle }, { idempotent: true });
  if (result.status !== 200) throw new Error((result.body as { error?: string })?.error ?? 'TASK_HANDLE_INVALID');
  return (result.body as { taskId: string }).taskId;
}

function text(value: unknown, isError = false) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }], ...(isError ? { isError: true } : {}) };
}

async function guarded(fn: () => Promise<{ status: number; body: unknown }>) {
  try {
    const result = await fn();
    return text(result.body, result.status >= 400);
  } catch (error) {
    return text({ error: (error as Error).message }, true);
  }
}

const handle = z.string().min(43).describe('Handle da tarefa emitido por "codeorquestra task register" no terminal da tarefa Codex atual.');

const server = new McpServer({ name: 'codeorquestra', version: RUNTIME_VERSION });

server.registerTool('codeorquestra_status', { description: 'Saúde do broker local (sem dados de tarefas).', inputSchema: {} }, async () => guarded(async () => {
  const health = await call('GET', '/api/health');
  return { status: health.status, body: { broker: { ...(health.body as object), tagline: BRAND.tagline, version: RUNTIME_VERSION }, tasks: [] } };
}));

server.registerTool('codeorquestra_start', { description: 'Inicia uma execução v2 na tarefa identificada pelo handle. O job segue o contrato v2 (contractVersion: 2).', inputSchema: { taskHandle: handle.optional(), job: z.record(z.string(), z.unknown()), acknowledgeReview: z.boolean().optional(), codexThreadId: z.string().optional().describe('Ignorado: nunca autoriza; use taskHandle.') } }, async ({ taskHandle, job, acknowledgeReview }) => guarded(async () => {
  if (!taskHandle) return { status: 403, body: { error: 'TASK_HANDLE_REQUIRED', note: 'codexThreadId não é aceito como autorização; registre a tarefa no terminal com "codeorquestra task register".' } };
  const taskId = await taskIdFor(taskHandle);
  const result = await call('POST', `/api/tasks/${taskId}/runs`, { taskHandle, job, ...(acknowledgeReview ? { acknowledgeReview: true } : {}) });
  return { status: result.status, body: { taskId, ...(result.body as object) } };
}));

server.registerTool('codeorquestra_wait', { description: 'Aguarda novos eventos da tarefa a partir de um cursor (long-poll). Atualiza a presença do coordenador.', inputSchema: { taskHandle: handle, cursor: z.number().int().min(0).default(0), waitMs: z.number().int().min(0).max(30000).default(10000) } }, async ({ taskHandle, cursor, waitMs }) => guarded(async () => {
  const taskId = await taskIdFor(taskHandle);
  return call('GET', `/api/tasks/${taskId}/events?cursor=${cursor}&waitMs=${waitMs}&taskHandle=${encodeURIComponent(taskHandle)}`);
}));

server.registerTool('codeorquestra_list', { description: 'Lista as execuções da tarefa identificada pelo handle (ativa e histórico).', inputSchema: { taskHandle: handle } }, async ({ taskHandle }) => guarded(async () => {
  const taskId = await taskIdFor(taskHandle);
  const view = await call('GET', `/api/tasks/${taskId}?taskHandle=${encodeURIComponent(taskHandle)}`);
  const runs = await call('GET', `/api/tasks/${taskId}/runs?taskHandle=${encodeURIComponent(taskHandle)}`);
  const task = view.body as { currentRun?: { runId: string; status: string; workerPid: number | null } | null; state?: string; threadId?: string };
  const active = task.currentRun && !['COMPLETED', 'FAIL', 'CANCELLED', 'UNCERTAIN', 'BLOCKED', 'TIMEOUT'].includes(task.currentRun.status)
    ? [{ taskId, threadId: task.threadId, runId: task.currentRun.runId, state: task.state, workerPid: task.currentRun.workerPid }]
    : [];
  return { status: view.status, body: { active, history: runs.body, task: view.body } };
}));

server.registerTool('codeorquestra_message', { description: 'Enfileira uma orientação para o próximo turno (entregue quando o turno atual terminar; só a interrupção aborta um turno).', inputSchema: { taskHandle: handle, text: z.string().min(1) } }, async ({ taskHandle, text: body }) => guarded(async () => {
  const taskId = await taskIdFor(taskHandle);
  return call('POST', `/api/tasks/${taskId}/message`, { taskHandle, text: body });
}));

server.registerTool('codeorquestra_answer', { description: 'Responde a um pedido de permissão ou pergunta pendente (requestId + runId exatos).', inputSchema: { taskHandle: handle, requestId: z.string(), runId: z.string(), decision: z.enum(['allow', 'deny', 'answer']), message: z.string().optional(), answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional() } }, async ({ taskHandle, ...rest }) => guarded(async () => {
  const taskId = await taskIdFor(taskHandle);
  return call('POST', `/api/tasks/${taskId}/answer`, { taskHandle, ...rest });
}));

server.registerTool('codeorquestra_annotate', { description: 'Anota um arquivo alterado nesta execução; a anotação vira orientação na fila e é entregue no próximo turno. Só aceita arquivos que o broker observou como alterados.', inputSchema: { taskHandle: handle, file: z.string().min(1).describe('Caminho relativo ao workspace, exatamente como aparece em changedFiles.observed.'), comment: z.string().min(1), hunk: z.string().optional().describe('Cabeçalho do trecho, quando houver (ex.: "@@ -10,7 +10,9 @@").') } }, async ({ taskHandle, ...rest }) => guarded(async () => {
  const taskId = await taskIdFor(taskHandle);
  return call('POST', `/api/tasks/${taskId}/annotations`, { taskHandle, ...rest });
}));

server.registerTool('codeorquestra_interrupt', { description: 'Interrompe o turno atual (a sessão continua aberta).', inputSchema: { taskHandle: handle } }, async ({ taskHandle }) => guarded(async () => {
  const taskId = await taskIdFor(taskHandle);
  return call('POST', `/api/tasks/${taskId}/interrupt`, { taskHandle });
}));

server.registerTool('codeorquestra_end', { description: 'Solicita o encerramento da sessão e reconcilia o worker e a árvore ainda atribuível daquela tarefa.', inputSchema: { taskHandle: handle } }, async ({ taskHandle }) => guarded(async () => {
  const taskId = await taskIdFor(taskHandle);
  return call('POST', `/api/tasks/${taskId}/end`, { taskHandle });
}));

server.registerTool('codeorquestra_set_model', { description: 'Troca o modelo entre turnos (claude-fable-5-1 ou claude-opus-5) com motivo registrado.', inputSchema: { taskHandle: handle, model: z.enum(['claude-fable-5-1', 'claude-opus-5']), reason: z.string().min(1) } }, async ({ taskHandle, model, reason }) => guarded(async () => {
  const taskId = await taskIdFor(taskHandle);
  return call('POST', `/api/tasks/${taskId}/model`, { taskHandle, model, reason });
}));

server.registerTool('codeorquestra_inventory', { description: 'Inventaria personalizações do projeto (CLAUDE.md, regras, settings, hooks, agentes, skills, MCPs) e mostra o estado de confiança.', inputSchema: { taskHandle: handle, workspace: z.string() } }, async ({ taskHandle, workspace }) => guarded(async () => {
  const taskId = await taskIdFor(taskHandle);
  return call('GET', `/api/tasks/${taskId}/inventory?workspace=${encodeURIComponent(workspace)}&taskHandle=${encodeURIComponent(taskHandle)}`);
}));

server.registerTool('codeorquestra_trust', { description: 'Registra a aprovação (feita pelo usuário) das personalizações inventariadas para este projeto.', inputSchema: { taskHandle: handle, workspace: z.string(), approvalRevision: z.number().int().min(1), approvedItems: z.union([z.literal('all'), z.array(z.string())]), note: z.string().optional() } }, async ({ taskHandle, ...rest }) => guarded(async () => {
  const taskId = await taskIdFor(taskHandle);
  return call('POST', `/api/tasks/${taskId}/trust`, { taskHandle, ...rest });
}));

server.registerTool('codeorquestra_usage_refresh', { description: 'Atualiza, sem iniciar inferência nem consumir créditos, os limites e a atividade que o Codex App Server disponibiliza para esta tarefa.', inputSchema: { taskHandle: handle } }, async ({ taskHandle }) => guarded(async () => {
  const taskId = await taskIdFor(taskHandle);
  return call('POST', `/api/tasks/${taskId}/usage-refresh`, { taskHandle });
}));

server.registerTool('codeorquestra_dashboard_url', { description: 'Gera um link de uso único do painel limitado a esta tarefa (o painel com todas as tarefas é uma ação local do usuário: "codeorquestra dashboard").', inputSchema: { taskHandle: handle } }, async ({ taskHandle }) => guarded(async () => call('POST', '/api/dashboard-url', { taskHandle })));

const transport = new StdioServerTransport();
await server.connect(transport);
