// Loopback HTTP broker: authenticated APIs for the dashboard, the CLI and the
// MCP adapter over one authoritative task manager. Binds 127.0.0.1 only, and
// only one broker may own a state root at a time.
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BRAND, RUNTIME_VERSION, type ActionSource, type EventRecord, type TaskView } from '../shared/types.ts';
import { appendTextSafe, writeFileAtomic } from '../state/atomic-file.ts';
import { redactSensitiveText } from '../events/redaction.ts';
import { IdentityRegistry, type Identity } from './identity.ts';
import { HttpError, SESSION_COOKIE, StaticAssets, applySecurityHeaders, assertActionAllowed, assertHost, readJsonBody, resolveIdentity, sendError, sendJson } from './http.ts';
import { SseHub } from './sse-hub.ts';
import { TaskManager, type TaskState } from './task-manager.ts';
import { dashboardDir } from './runtime-paths.ts';
import { acquireBrokerSingleton, type SingletonLock } from './singleton.ts';
import { resolveRepository } from './worktree.ts';
import type { SupervisionThresholds } from '../worker/supervision.ts';

export interface BrokerOptions {
  stateRoot: string;
  port: number;
  announceJson: boolean;
  harness: boolean;
  supervision?: SupervisionThresholds;
}

export interface BrokerAnnouncement {
  event: 'broker_listening';
  address: string;
  port: number;
  baseUrl: string;
  bootstrapUrl: string;
  secretFile: string;
  stateRoot: string;
  pid: number;
  cursorEpoch: string;
}

export class Broker {
  readonly options: BrokerOptions;
  readonly identity: IdentityRegistry;
  readonly hub = new SseHub();
  readonly tasks: TaskManager;
  /** Changes on every broker start; clients reset their cursor when it moves. */
  readonly cursorEpoch = randomUUID();
  private server: http.Server | null = null;
  private port = 0;
  private baseUrl = '';
  private readonly startedAt = new Date().toISOString();
  private readonly brokerDir: string;
  private readonly logFile: string;
  private assets: StaticAssets;
  private shuttingDown = false;
  private singleton: SingletonLock | null = null;

  constructor(options: BrokerOptions) {
    this.options = options;
    this.brokerDir = path.join(options.stateRoot, 'broker');
    this.logFile = path.join(this.brokerDir, 'broker.log');
    this.identity = new IdentityRegistry(this.brokerDir);
    this.assets = new StaticAssets(dashboardDir());
    this.tasks = new TaskManager({
      stateRoot: options.stateRoot,
      log: (line) => this.log(line),
      onEvent: (event) => this.hub.broadcastEvent(event),
      onTaskChanged: (view) => this.hub.broadcastTask(view),
      onTransient: (frame) => this.hub.broadcastTransient(frame),
      harness: options.harness,
      ...(options.supervision ? { supervision: options.supervision } : {}),
      ...(options.harness ? { quotaWaitMs: 5000 } : {}),
    });
  }

  log(line: string): void {
    const text = `${new Date().toISOString()} ${redactSensitiveText(line)}\n`;
    void appendTextSafe(this.logFile, text).catch(() => undefined);
  }

  async start(): Promise<BrokerAnnouncement> {
    await fs.mkdir(this.brokerDir, { recursive: true });
    // Cross-process singleton: two adapters racing to start a broker for the
    // same state root must not both recover the same workers.
    this.singleton = await acquireBrokerSingleton(this.options.stateRoot);
    void this.singleton.lost.then(async () => {
      this.log('broker singleton ownership was lost; shutting down to prevent a second owner');
      await this.stop();
    }).catch((error) => this.log(`singleton loss shutdown failed: ${(error as Error).message}`));
    try {
      await this.identity.load();
      if (this.shuttingDown) throw new Error('BROKER_SINGLETON_LOST_DURING_STARTUP');
      await this.assets.load();
      if (this.shuttingDown) throw new Error('BROKER_SINGLETON_LOST_DURING_STARTUP');
      await this.tasks.start();
      if (this.shuttingDown) throw new Error('BROKER_SINGLETON_LOST_DURING_STARTUP');
      this.server = http.createServer((req, res) => void this.handle(req, res));
      this.server.keepAliveTimeout = 65000;
      await new Promise<void>((resolve, reject) => {
        this.server!.once('error', reject);
        this.server!.listen(this.options.port, '127.0.0.1', () => resolve());
      });
    } catch (error) {
      await this.singleton?.release();
      this.singleton = null;
      throw error;
    }
    const address = this.server!.address();
    this.port = typeof address === 'object' && address ? address.port : this.options.port;
    this.baseUrl = `http://127.0.0.1:${this.port}`;
    const bootstrapUrl = `${this.baseUrl}/bootstrap?token=${this.identity.mintBootstrapToken(null)}`;
    const announcement: BrokerAnnouncement = { event: 'broker_listening', address: '127.0.0.1', port: this.port, baseUrl: this.baseUrl, bootstrapUrl, secretFile: this.identity.secretPath, stateRoot: this.options.stateRoot, pid: process.pid, cursorEpoch: this.cursorEpoch };
    await writeFileAtomic(path.join(this.brokerDir, 'broker.json'), JSON.stringify({ pid: process.pid, port: this.port, baseUrl: this.baseUrl, startedAt: this.startedAt, secretFile: this.identity.secretPath, version: RUNTIME_VERSION, product: BRAND.name }, null, 2));
    this.log(`broker listening on ${this.baseUrl} (pid ${process.pid}, painel ${this.assets.dir ? 'compilado' : 'não compilado'})`);
    return announcement;
  }

  async stop(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.log('broker shutting down');
    this.hub.closeAll();
    await this.tasks.stop();
    if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    try {
      await fs.rm(path.join(this.brokerDir, 'broker.json'), { force: true });
    } catch {
      // ignore
    }
    await this.singleton?.release();
    this.singleton = null;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    applySecurityHeaders(res);
    try {
      assertHost(req, this.port);
      const url = new URL(req.url ?? '/', this.baseUrl);
      if (req.method === 'OPTIONS') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
      if (url.pathname === '/bootstrap') return this.bootstrap(url, res);
      if (url.pathname.startsWith('/api/')) return await this.api(req, res, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
      if (!this.assets.dir) {
        if (url.pathname === '/') {
          res.statusCode = 503;
          res.setHeader('content-type', 'text/html; charset=utf-8');
          res.end(`<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>${BRAND.name}</title><body><h1>Painel não compilado</h1><p>Execute o build do runtime para gerar dist/dashboard.</p></body></html>`);
          return;
        }
        throw new HttpError(404, 'NOT_FOUND');
      }
      const served = await this.assets.serve(url.pathname, res);
      if (!served) throw new HttpError(404, 'NOT_FOUND');
    } catch (error) {
      if (error instanceof HttpError) {
        sendError(res, error);
        return;
      }
      this.log(`erro interno: ${(error as Error).name}`);
      sendError(res, new HttpError(500, 'INTERNAL_ERROR'));
    }
  }

  private bootstrap(url: URL, res: ServerResponse): void {
    const token = url.searchParams.get('token') ?? '';
    const outcome = this.identity.redeemBootstrapToken(token);
    if (!outcome.ok) throw new HttpError(403, outcome.code);
    res.statusCode = 303;
    res.setHeader('set-cookie', `${SESSION_COOKIE}=${outcome.session.cookie}; HttpOnly; SameSite=Strict; Path=/`);
    res.setHeader('location', '/');
    res.end();
  }

  private requireIdentity(req: IncomingMessage): Identity {
    const identity = resolveIdentity(req, this.identity);
    if (!identity) throw new HttpError(401, 'UNAUTHORIZED');
    return identity;
  }

  /**
   * Privileged lifecycle and bootstrap routes require the local administrative
   * secret. Any local process that can read the secret file is administratively
   * equivalent to the coordinator; the MCP label is refused as defence in
   * depth, not as isolation from a same-user process.
   */
  private requireAdministrative(identity: Identity): void {
    if (identity.source !== 'local-secret') throw new HttpError(403, 'LOCAL_ADMIN_REQUIRED');
  }

  private scopedTask(identity: Identity, taskId: string): TaskState {
    if (identity.taskScope && identity.taskScope !== taskId) throw new HttpError(404, 'TASK_NOT_FOUND');
    return this.tasks.getTask(taskId);
  }

  /** MCP callers must present the task handle for every task-scoped action. */
  private bindHandle(identity: Identity, task: TaskState, body: Record<string, unknown>, url: URL): void {
    const handle = typeof body.taskHandle === 'string' ? body.taskHandle : url.searchParams.get('taskHandle');
    if (identity.source === 'mcp' || handle) {
      const resolved = this.tasks.resolveHandle(handle);
      if (resolved !== task) throw new HttpError(403, 'TASK_HANDLE_MISMATCH');
    }
  }

  private async api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const method = req.method ?? 'GET';
    const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
    const identity = this.requireIdentity(req);
    if (method === 'POST') assertActionAllowed(req, identity, this.baseUrl);
    // Once shutdown begins, mutations stop being accepted immediately: the
    // broker is about to settle in-flight work and release the state root, and
    // a late action would act on state nobody will be watching. Reads still
    // answer so a coordinator can observe the shutdown.
    if (method === 'POST' && this.shuttingDown && !(parts[1] === 'broker' && parts[2] === 'shutdown')) {
      throw new HttpError(503, 'BROKER_SHUTTING_DOWN', { message: 'O broker está encerrando; ações de alteração não são mais aceitas.' });
    }
    const body = method === 'POST' ? await readJsonBody(req) : {};

    if (parts[1] === 'health' && method === 'GET') return sendJson(res, 200, { pid: process.pid, product: BRAND.name, version: RUNTIME_VERSION, startedAt: this.startedAt, tasks: this.tasks.tasks.size, cursorEpoch: this.cursorEpoch });
    if (parts[1] === 'status' && method === 'GET') {
      if (identity.source === 'browser') this.tasks.refreshAllUsage();
      return sendJson(res, 200, {
        broker: { version: RUNTIME_VERSION, tagline: BRAND.tagline, startedAt: this.startedAt, pid: process.pid, simulatedAdapter: this.options.harness },
        identity: { source: identity.source, taskScope: identity.taskScope },
        tasks: identity.source === 'mcp' ? [] : this.tasks.views(identity.taskScope),
        cursorEpoch: this.cursorEpoch,
      });
    }
    if (parts[1] === 'broker' && parts[2] === 'shutdown' && method === 'POST') {
      this.requireAdministrative(identity);
      sendJson(res, 202, { shuttingDown: true });
      setTimeout(() => void this.stop().then(() => process.exit(0)), 50);
      return;
    }
    if (parts[1] === 'dashboard-url' && method === 'POST') {
      if (identity.source === 'browser') throw new HttpError(403, 'LOCAL_ADMIN_REQUIRED');
      let scope: string | null = null;
      if (typeof body.taskHandle === 'string') scope = this.tasks.resolveHandle(body.taskHandle).record.taskId;
      // An MCP client is always scoped to one task, so the actionable refusal
      // is "bring a handle", not "you are not an administrator".
      else if (identity.source === 'mcp') throw new HttpError(403, 'TASK_HANDLE_REQUIRED');
      else this.requireAdministrative(identity);
      const token = this.identity.mintBootstrapToken(scope);
      return sendJson(res, 200, { url: `${this.baseUrl}/bootstrap?token=${token}`, scope, note: 'Link de uso único; abra no navegador desta máquina.' });
    }
    if (parts[1] === 'locks' && parts[2] && parts[3] === 'release' && method === 'POST') {
      // Releasing ownership of a checkout is administrative and explicit; it is
      // never a side effect of acknowledging an artefact review.
      this.requireAdministrative(identity);
      return sendJson(res, 200, await this.tasks.releaseQuarantinedLock(parts[2], {
        note: typeof body.note === 'string' ? body.note : null,
        confirmHistoricalRisk: body.confirmHistoricalRisk === true,
        expectedTaskId: typeof body.expectedTaskId === 'string' ? body.expectedTaskId : null,
        expectedRunId: typeof body.expectedRunId === 'string' ? body.expectedRunId : null,
      }, identity.source));
    }
    if (parts[1] === 'locks' && method === 'GET') {
      this.requireAdministrative(identity);
      return sendJson(res, 200, [...this.tasks.locks.values()].map((lock) => ({ workspaceKey: lock.workspaceKey, workspace: lock.workspace, holderTaskId: lock.holderTaskId, holderRunId: lock.holderRunId, holderPid: lock.holderPid, acquiredAt: lock.acquiredAt, quarantined: lock.quarantined, ...(lock.quarantineNote ? { note: lock.quarantineNote } : {}) })));
    }
    if (parts[1] === 'repos' && parts[2] === 'worktree-policy' && method === 'POST') {
      // Enrolling a repository writes .git/worktrees/<n>, creates a lasting
      // branch ref and materializes a second checkout. That is a persistent
      // mutation of the user's repository, so it is a local administrative act
      // — never something a task can grant itself, and never the browser.
      this.requireAdministrative(identity);
      const workspace = typeof body.repo === 'string' ? body.repo : typeof body.workspace === 'string' ? body.workspace : '';
      if (!workspace) throw new HttpError(400, 'WORKSPACE_REQUIRED', { message: 'Informe o caminho do repositório em "repo".' });
      const repository = await resolveRepository(workspace);
      const record = await this.tasks.worktreePolicy.enrol({
        repoKey: repository.repoKey,
        canonicalWorkspace: repository.topLevel,
        enabledBy: 'local-secret',
        note: typeof body.note === 'string' ? body.note : '',
        maxParallelRuns: body.maxParallelRuns,
        maxRetainedWorktrees: body.maxRetainedWorktrees,
        worktreeRoot: body.worktreeRoot,
      });
      this.log(`worktrees habilitados para ${repository.topLevel} (repoKey ${repository.repoKey})`);
      return sendJson(res, 200, record);
    }
    if (parts[1] === 'worktrees' && method === 'GET') {
      this.requireAdministrative(identity);
      return sendJson(res, 200, await this.tasks.worktreeInventory());
    }
    if (parts[1] === 'worktrees' && parts[2] === 'release' && method === 'POST') {
      // Discarding uncommitted work is never a default, and never a side effect
      // of anything else: it is its own administrative action, with a note.
      this.requireAdministrative(identity);
      const target = typeof body.path === 'string' ? body.path : '';
      if (!target) throw new HttpError(400, 'PATH_REQUIRED', { message: 'Informe o caminho do worktree em "path".' });
      return sendJson(res, 200, await this.tasks.releaseWorktree(target, {
        note: typeof body.note === 'string' ? body.note : null,
        confirmDiscardUncommitted: body.confirmDiscardUncommitted === true,
      }, identity.source));
    }
    if (parts[1] === 'quota' && method === 'GET') {
      return sendJson(res, 200, this.tasks.quota.view('claude-fable-5-1'));
    }
    if (parts[1] === 'events' && method === 'GET') return await this.sse(req, res, url, identity);
    if (parts[1] === 'tasks') {
      if (parts.length === 2 && method === 'GET') {
        if (identity.source === 'mcp') throw new HttpError(403, 'TASK_HANDLE_REQUIRED');
        return sendJson(res, 200, this.tasks.views(identity.taskScope));
      }
      if (parts[2] === 'register' && method === 'POST') {
        this.requireAdministrative(identity);
        const source = typeof body.source === 'string' ? body.source : 'unknown';
        const result = await this.tasks.register(body.codexThreadId as string, source);
        return sendJson(res, 201, result);
      }
      if (parts[2] === 'by-handle' && method === 'POST') {
        const task = this.tasks.resolveHandle(body.taskHandle);
        return sendJson(res, 200, { taskId: task.record.taskId, threadId: task.record.threadId, requiresReview: task.record.requiresReview });
      }
      const taskId = parts[2] ?? '';
      const action = parts[3] ?? null;
      const task = this.scopedTask(identity, taskId);
      if (!action && method === 'GET') {
        if (identity.source === 'mcp') this.bindHandle(identity, task, body, url);
        if (identity.source === 'browser') void this.tasks.refreshUsage(task);
        const view = this.tasks.view(task);
        view.changedFiles = await this.tasks.changedFiles(task);
        return sendJson(res, 200, view);
      }
      if (action === 'runs' && method === 'GET') {
        this.bindHandle(identity, task, body, url);
        return sendJson(res, 200, await this.tasks.runsOf(task));
      }
      if (action === 'runs' && method === 'POST') {
        if (identity.source === 'browser') throw new HttpError(403, 'LOCAL_ADMIN_REQUIRED');
        const resolved = this.tasks.resolveHandle(body.taskHandle);
        if (resolved !== task) throw new HttpError(403, 'TASK_HANDLE_MISMATCH');
        const harness = this.options.harness && body.harness && typeof body.harness === 'object' ? (body.harness as Record<string, unknown>) : null;
        const result = await this.tasks.startRun(task, body.job, harness, identity.source, body.acknowledgeReview === true);
        return sendJson(res, 202, result);
      }
      if (action === 'events' && method === 'GET') {
        this.bindHandle(identity, task, body, url);
        const cursor = Number(url.searchParams.get('cursor') ?? '0') || 0;
        const waitMs = Math.min(30000, Math.max(0, Number(url.searchParams.get('waitMs') ?? '0') || 0));
        const limit = Math.min(2000, Math.max(1, Number(url.searchParams.get('limit') ?? '500') || 500));
        if (identity.source !== 'browser') this.tasks.touchCoordinator(task);
        // Backward pagination: history older than the client's first row is
        // fetched instead of being declared lost.
        const before = Number(url.searchParams.get('before') ?? '0') || 0;
        if (before > 0) {
          const older = await task.log.readBefore(before, limit);
          return sendJson(res, 200, { events: older.events, cursor, gapped: false, more: older.more, cursorEpoch: this.cursorEpoch, task: this.tasks.view(task) });
        }
        let page = await task.log.readPage(cursor, limit);
        if (page.events.length === 0 && waitMs > 0) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(() => { unsubscribe(); resolve(); }, waitMs);
            const unsubscribe = task.log.subscribe(() => { clearTimeout(timer); unsubscribe(); resolve(); });
            req.on('close', () => { clearTimeout(timer); unsubscribe(); resolve(); });
          });
          page = await task.log.readPage(cursor, limit);
        }
        const last = page.events.at(-1);
        return sendJson(res, 200, { events: page.events, cursor: last ? last.seq : cursor, gapped: page.gapped, cursorEpoch: this.cursorEpoch, task: this.tasks.view(task) });
      }
      if (action === 'blobs' && parts[4] && method === 'GET') {
        this.bindHandle(identity, task, body, url);
        const page = Number(url.searchParams.get('page') ?? '1') || 1;
        const blob = await this.tasks.blobPage(task, parts[4], page);
        if (!blob) throw new HttpError(404, 'BLOB_NOT_FOUND');
        return sendJson(res, 200, blob);
      }
      if (action === 'inventory' && method === 'GET') {
        this.bindHandle(identity, task, body, url);
        const workspace = url.searchParams.get('workspace') ?? task.record.workspace;
        if (!workspace) throw new HttpError(400, 'WORKSPACE_REQUIRED');
        const { inventory, trust } = await this.tasks.inventoryFor(workspace);
        return sendJson(res, 200, { inventory: inventory.toJSON(), trust });
      }
      if (method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
      this.bindHandle(identity, task, body, url);
      const source: ActionSource = identity.source;
      switch (action) {
        case 'message': {
          if (typeof body.text !== 'string' || !body.text.trim()) throw new HttpError(400, 'TEXT_REQUIRED');
          const entry = await this.tasks.enqueueMessage(task, body.text, source);
          return sendJson(res, 202, entry);
        }
        case 'answer':
          await this.tasks.answer(task, body as { requestId: unknown; runId: unknown; decision: unknown; message?: unknown; answers?: unknown }, source);
          return sendJson(res, 200, { resolved: true });
        case 'interrupt':
          await this.tasks.interrupt(task, source);
          return sendJson(res, 202, { interrupted: true });
        case 'end':
          await this.tasks.end(task, source);
          return sendJson(res, 202, { ending: true });
        case 'model':
          return sendJson(res, 200, await this.tasks.setModel(task, body.model, body.reason, source));
        case 'heartbeat':
          if (identity.source === 'browser') throw new HttpError(403, 'LOCAL_ADMIN_REQUIRED');
          this.tasks.touchCoordinator(task);
          return sendJson(res, 200, { present: true });
        case 'usage-refresh':
          return sendJson(res, 200, { usage: await this.tasks.refreshUsage(task, true) });
        case 'acknowledge-review':
          if (identity.source === 'browser') throw new HttpError(403, 'LOCAL_ADMIN_REQUIRED');
          await this.tasks.acknowledgeReview(task, typeof body.note === 'string' ? body.note : null, source);
          return sendJson(res, 200, { requiresReview: task.record.requiresReview });
        case 'trust': {
          if (identity.source === 'browser') throw new HttpError(403, 'LOCAL_ADMIN_REQUIRED');
          const workspace = typeof body.workspace === 'string' ? body.workspace : task.record.workspace;
          if (!workspace) throw new HttpError(400, 'WORKSPACE_REQUIRED');
          const revision = Number(body.approvalRevision);
          if (!Number.isInteger(revision) || revision < 1) throw new HttpError(400, 'APPROVAL_REVISION_INVALID');
          const approved = body.approvedItems === 'all' ? 'all' : Array.isArray(body.approvedItems) ? body.approvedItems.filter((item): item is string => typeof item === 'string') : null;
          if (!approved) throw new HttpError(400, 'APPROVED_ITEMS_REQUIRED');
          const trust = await this.tasks.approveTrust(task, workspace, revision, approved, typeof body.note === 'string' ? body.note : undefined, source);
          return sendJson(res, 200, { trust });
        }
        default:
          throw new HttpError(404, 'NOT_FOUND');
      }
    }
    throw new HttpError(404, 'NOT_FOUND');
  }

  private async sse(req: IncomingMessage, res: ServerResponse, url: URL, identity: Identity): Promise<void> {
    const taskId = url.searchParams.get('taskId');
    if (identity.source === 'mcp') throw new HttpError(403, 'TASK_HANDLE_REQUIRED');
    if (taskId) this.scopedTask(identity, taskId);
    const requestedEpoch = url.searchParams.get('epoch');
    const cursor = requestedEpoch && requestedEpoch !== this.cursorEpoch ? 0 : Number(url.searchParams.get('cursor') ?? '0') || 0;
    await this.hub.attach(res, {
      taskId,
      taskScope: identity.taskScope,
      cursor,
      epoch: this.cursorEpoch,
      replay: (from, id, scope) => this.tasks.replay(from, id, scope),
      snapshots: () => this.tasks.views(identity.taskScope) as TaskView[],
    });
    req.on('close', () => undefined);
  }
}

export type { EventRecord };
