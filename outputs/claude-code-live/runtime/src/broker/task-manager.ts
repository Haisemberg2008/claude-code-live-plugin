// Authoritative task state.
//
// Invariants this module is responsible for:
//   * one durable event log per Codex task, appended and broadcast in a single
//     global order so a replay cursor can never skip or reorder;
//   * one worker process per active task, reserved atomically together with
//     the checkout writer lock before any awaited preparation;
//   * uncertainty survives a broker restart until an explicit review;
//   * process identity is proven before anything is terminated, and the writer
//     lock stays quarantined while a descendant of a finished run survives;
//   * per-job authentication policy is assessed on every launch.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs, realpathSync } from 'node:fs';
import path from 'node:path';
import { ContractError, resolveJobContract, AUTHORIZED_MODELS, type JobContract } from '../contract/job-contract.ts';
import { deriveCompatibilityFiles, type DerivedStatus } from '../events/derive.ts';
import { EventLog } from '../events/event-log.ts';
import { boundedPreview, previewPage } from '../events/preview.ts';
import { redactSensitiveText } from '../events/redaction.ts';
import { probeCli } from '../preflight/cli-probe.ts';
import { resolvePreflight, type PreflightResult, type ProbeResult, type ResolvedExecutable } from '../preflight/cli-resolver.ts';
import { StateWriter, readJsonShared, writeFileAtomic } from '../state/atomic-file.ts';
import { inventoryCustomizations, canonicalizeWorkspace, type Inventory } from '../trust/inventory.ts';
import { resolveLaunchCustomizations } from '../trust/launch-customizations.ts';
import { isSensitivePath, resolveWorkspacePath } from '../policy/action-classifier.ts';
import { git, gitStatus, listOrphans, resolveRepository, worktreePathFor, ensureWorktree, removeWorktree, withRepositoryMutex, assertUsablePathLength, canonicalize, canonicalizePlanned, type Repository } from './worktree.ts';
import { WorktreePolicyStore, type WorktreePolicyRecord } from './worktree-policy.ts';
import { TrustStore, type TrustCheck } from '../trust/trust-store.ts';
import { evaluateSupervision, SUPERVISION, type SupervisionThresholds } from '../worker/supervision.ts';
import type { BrokerToWorker, WorkerDescriptor, WorkerToBroker } from '../worker/protocol.ts';
import { isHarness, envName } from '../shared/env.ts';
import { TURN_POLICY_LEVELS, type RunContextView, type RunToolsView, type ActionSource, type AuthorizedModel, type CodexUsageView, type EventRecord, type PendingRequestView, type QueueEntryView, type RunBudgetView, type RunStatus, type TaskView, type ThrashingReport, type TransientFrame, type TurnPolicyLevel, type TurnPolicyView, type WorkerPhase } from '../shared/types.ts';
import { ClaudeUsageAccumulator, normalizeClaudeUsage } from '../usage/claude-usage.ts';
import { detectThrashing, TRAIL_LIMIT, type ToolTrailEntry } from './thrashing.ts';
import { contextWindowFor } from '../shared/models.ts';
import { CodexUsageService, type CodexUsageReader, unavailableCodexUsage } from '../usage/codex-usage.ts';
import { sha256, mintTaskHandle, verifyTaskHandle, taskIdForThread, THREAD_ID_PATTERN } from './identity.ts';
import { HttpError } from './http.ts';
import { findClaudeLauncher, nodeExecArgv, engineInfo, workerEntry } from './runtime-paths.ts';
import { QuotaService } from './quota-service.ts';
import { isAlive, reconcileRunProcesses, readWorkerIdentity, survivorCheck, terminateTree, verifyWorkerLiveness, waitForExit } from './process-tree.ts';

export interface TaskRecord {
  taskId: string;
  threadId: string;
  createdAt: string;
  handleHash: string | null;
  handleRotatedAt: string | null;
  workspace: string | null;
  /** Survives restarts; cleared only by an explicit scoped acknowledgement. */
  requiresReview: boolean;
  reviewReason: string | null;
}

interface QueueEntry extends QueueEntryView {
  text: string;
}

/** What a run needed to provision before it could start. */
interface WorktreePlan {
  repository: Repository;
  policy: WorktreePolicyRecord;
  path: string;
  branch: string;
  baseRef: string | null;
  fleetReservationId: string;
}

interface RunState {
  runId: string;
  runToken: string;
  status: RunStatus;
  startedAt: string;
  endedAt: string | null;
  contract: JobContract;
  /**
   * The workspace the job declared, kept for the audit trail when the run
   * actually executes somewhere else. `contract.workspace` is always the
   * directory the CLI really runs in.
   */
  declaredWorkspace: string | null;
  worktree: WorktreePlan | null;
  prompt: string;
  sessionConfirmed: boolean;
  requestedModel: string;
  modelReason: string;
  observedModel: string | null;
  effortObservedByCli: string | null;
  sessionId: string | null;
  /** Compatibility identity of the declared contract, before worktree rewriting. */
  resumeFingerprint: string;
  workerPid: number | null;
  workerStartedAt: string | null;
  failureStage: string | null;
  failureCode: string | null;
  telemetryFailures: number;
  turns: number;
  /**
   * Tokens this run's turns reported (input + cache + output), for the budget.
   * Distinct from the task's usage accumulator, which spans runs and replays.
   */
  tokensObserved: number;
  /** Recent tool calls, oldest first, bounded. Read only by the loop detector. */
  toolTrail: ToolTrailEntry[];
  /** Input tokens of the last finished turn: what the context held at that point. */
  lastTurnContextTokens: number | null;
  /** Running counts for the whole run, unlike the bounded trail above. */
  tools: RunToolState;
  /** Loops already reported, so each distinct one is named once per run. */
  thrashingSeen: Set<string>;
  thrashing: ThrashingReport | null;
  /** Only ever what the worker confirmed; a requested restriction is not a claim. */
  policy: TurnPolicyView | null;
  /** An end that waits for the running turn instead of interrupting it. */
  endAfterTurn: { source: ActionSource; requestedAt: string } | null;
  resumeMode: 'new' | 'automatic' | 'explicit';
  simulated: boolean;
  writerLockKey: string | null;
  finalized: boolean;
  finalizing: boolean;
  initialPromptDelivered: boolean;
  /** True once current-run.json records this run; no prompt is released before. */
  ownershipRecorded: boolean;
  claudeAuthored: Set<string>;
  /** Harness-only fault injection; never populated by a production broker. */
  harnessFinalizationFailure: string | null;
}

interface CurrentRunFile {
  runId: string;
  runToken: string;
  status: RunStatus;
  workerPid: number | null;
  workerStartedAt: string | null;
  startedAt: string;
  workspace: string;
  writerLockKey: string | null;
  runDir: string;
}

interface LockRecord {
  workspaceKey: string;
  workspace: string;
  holderTaskId: string;
  holderRunId: string;
  holderPid: number | null;
  acquiredAt: string;
  /** A finished run whose descendants could not be reconciled keeps the lock. */
  quarantined: boolean;
  /** In-memory only: keeps concurrent releases/starts behind the same owner. */
  releaseInProgress?: boolean;
  quarantineNote?: string;
}

export interface TaskState {
  record: TaskRecord;
  dir: string;
  log: EventLog;
  run: RunState | null;
  worker: ChildProcess | null;
  workerReady: boolean;
  /** Reserved model switch awaiting worker confirmation; blocks the next turn. */
  modelTransition: { model: string; settle: (outcome: { ok: boolean; activeModel: string | null; code: string | null }) => void } | null;
  phase: WorkerPhase;
  currentTool: string | null;
  lastActivityAt: number;
  coordinatorLastSeenAt: number | null;
  queue: QueueEntry[];
  pending: Map<string, PendingRequestView>;
  resolvedRequests: Set<string>;
  alertsRaised: Set<string>;
  /**
   * This run's events, kept as they are appended so the derived files can be
   * rebuilt without re-reading the whole log. Scoped to one runId and only
   * trusted for that one; anything else falls back to the log, which remains
   * the source of truth.
   */
  derivedCache: { runId: string; events: EventRecord[] } | null;
  /** Last time the still-blocking decision alert was raised; null when none is pending. */
  lastDecisionAlertAt: number | null;
  uncertain: boolean;
  disconnected: boolean;
  previousSessionId: string | null;
  previousSessionFingerprint: string | null;
  quota: ReturnType<QuotaService['view']> | null;
  claudeUsage: ClaudeUsageAccumulator;
  codexUsage: CodexUsageView;
  usageRefresh: Promise<CodexUsageView> | null;
  writer: StateWriter | null;
  derivedDirty: boolean;
  lastTelemetryEventAt: number;
  changedFilesCache: { at: number; observed: string[] } | null;
  endTimer: NodeJS.Timeout | null;
  updatedAt: string;
  chain: Promise<unknown>;
}

export interface TaskManagerOptions {
  stateRoot: string;
  log: (line: string) => void;
  onEvent: (event: EventRecord) => void;
  onTaskChanged: (view: TaskView) => void;
  onTransient: (frame: TransientFrame) => void;
  supervision?: SupervisionThresholds;
  harness: boolean;
  quotaWaitMs?: number;
  /** How many live subscribers can see a task; supplied by the SSE hub. */
  observers?: (taskId: string) => number;
  /** Harness-only scheduling seam used to prove recovery cancellation. */
  recoveryCheckpoint?: () => Promise<void>;
  /** Test seam; production uses one read-only App Server connection. */
  codexUsage?: CodexUsageReader;
}

const WORKER_END_GRACE_MS = 15000;
/** How long a model switch may stay reserved before it is reported unconfirmed. */
const MODEL_CHANGE_TIMEOUT_MS = isHarness() ? 1000 : 30000;
/** How long shutdown waits for in-flight preparations before reporting them. */
const PREPARATION_DRAIN_MS = 20000;

export class TaskManager {
  readonly stateRoot: string;
  readonly tasks = new Map<string, TaskState>();
  readonly trustStore: TrustStore;
  readonly worktreePolicy: WorktreePolicyStore;
  readonly quota: QuotaService;
  readonly codexUsage: CodexUsageReader;
  readonly locks = new Map<string, LockRecord>();
  private readonly options: TaskManagerOptions;
  private globalSeq = 0;
  private appendChain: Promise<unknown> = Promise.resolve();
  private supervisionTimer: NodeJS.Timeout | null = null;
  private derivedTimer: NodeJS.Timeout | null = null;
  private launcherPath: string | null = null;
  private probeCache: ProbeResult | null = null;
  private stopping = false;
  /** Preparations in flight; shutdown awaits them before sweeping workers. */
  private readonly preparations = new Set<Promise<void>>();
  /** Admission slots held while asynchronous worktree planning is still running. */
  private readonly fleetReservations = new Map<string, Map<string, string>>();

  /** True once shutdown began: no further run may be admitted. */
  get isStopping(): boolean {
    return this.stopping;
  }

  constructor(options: TaskManagerOptions) {
    this.options = options;
    this.stateRoot = options.stateRoot;
    this.trustStore = new TrustStore(options.stateRoot);
    this.worktreePolicy = new WorktreePolicyStore(options.stateRoot);
    this.quota = new QuotaService({ waitMs: options.quotaWaitMs ?? 30000 });
    this.codexUsage = options.codexUsage ?? (options.harness ? {
      refresh: async () => unavailableCodexUsage('CODEX_USAGE_DISABLED_IN_HARNESS', new Date().toISOString()),
      stop: async () => undefined,
    } : new CodexUsageService());
  }

  get thresholds(): SupervisionThresholds {
    return this.options.supervision ?? SUPERVISION;
  }

  private tasksDir(): string {
    return path.join(this.stateRoot, 'tasks');
  }

  private locksDir(): string {
    return path.join(this.stateRoot, 'locks');
  }

  async start(): Promise<void> {
    await fs.mkdir(this.tasksDir(), { recursive: true });
    this.assertOperational();
    await fs.mkdir(this.locksDir(), { recursive: true });
    this.assertOperational();
    this.launcherPath = await findClaudeLauncher();
    this.assertOperational();
    await this.recover();
    this.assertOperational();
    this.supervisionTimer = setInterval(() => this.superviseAll(), 1000);
    this.supervisionTimer.unref();
    this.derivedTimer = setInterval(() => void this.flushDerived(), 1000);
    this.derivedTimer.unref();
  }

  /**
   * Stops workers without pretending their runs finished: in-flight runs stay
   * RUNNING on disk so the next broker start reconciles them as uncertain and
   * requires review before anything is resumed or replayed.
   */
  /**
   * Stops accepting new work and settles everything already in flight.
   *
   * The order matters. `stopping` is set first so no further run is admitted,
   * then the preparations already running are awaited: each one is about to
   * spawn a worker, and sweeping workers before they finish would leave a
   * process created after the sweep, owning a checkout nobody is watching.
   * Only then are workers terminated and the logs closed.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.supervisionTimer) clearInterval(this.supervisionTimer);
    if (this.derivedTimer) clearInterval(this.derivedTimer);
    await this.codexUsage.stop();
    await Promise.allSettled([...this.tasks.values()].flatMap((task) => task.usageRefresh ? [task.usageRefresh] : []));
    await this.settlePreparations();
    for (const task of this.tasks.values()) {
      if (task.run && !task.run.finalized) {
        await this.append(task, task.run.runId, 'broker_stopping', { note: 'O broker está encerrando com trabalho em andamento; a execução será revisada como incerta no próximo início.' }).catch(() => undefined);
      }
      if (task.worker?.pid) await terminateTree(task.worker.pid);
      await task.log.close();
    }
  }

  /** Awaits every in-flight preparation, bounded so a hung stage cannot wedge shutdown. */
  private async settlePreparations(): Promise<void> {
    const deadline = Date.now() + PREPARATION_DRAIN_MS;
    while (this.preparations.size > 0 && Date.now() < deadline) {
      await Promise.race([
        Promise.allSettled([...this.preparations]),
        new Promise<void>((resolve) => { const timer = setTimeout(resolve, 250); timer.unref(); }),
      ]);
    }
    if (this.preparations.size > 0) {
      this.options.log(`broker encerrando com ${this.preparations.size} preparação(ões) ainda ativa(s); os workers criados serão reconciliados no próximo início.`);
    }
  }

  // ---------------------------------------------------------------- recovery

  private assertOperational(): void {
    if (this.stopping) throw new Error('BROKER_STOPPED_DURING_RECOVERY');
  }

  private async recover(): Promise<void> {
    this.assertOperational();
    let entries: string[] = [];
    try {
      entries = await fs.readdir(this.tasksDir());
      this.assertOperational();
    } catch {
      entries = [];
    }
    // First pass: open every task and establish the global high-water mark
    // BEFORE any recovery event is appended, so a new sequence can never
    // collide with one already present in another task's log.
    const opened: TaskState[] = [];
    for (const taskId of entries) {
      this.assertOperational();
      const dir = path.join(this.tasksDir(), taskId);
      const record = await readJsonShared<TaskRecord>(path.join(dir, 'task.json'));
      this.assertOperational();
      if (record.status !== 'ok') continue;
      opened.push(await this.openTask(normalizeRecord(record.value), dir));
      this.assertOperational();
    }
    for (const task of opened) {
      this.assertOperational();
      const tail = await task.log.readPage(Math.max(0, task.log.lastSeq - 1), 5);
      this.assertOperational();
      for (const event of tail.events) if ((event.gseq ?? 0) > this.globalSeq) this.globalSeq = event.gseq ?? 0;
    }
    if (this.options.harness && this.options.recoveryCheckpoint) {
      await this.options.recoveryCheckpoint();
      this.assertOperational();
    }
    // Second pass: reconcile in-flight work.
    for (const task of opened) {
      this.assertOperational();
      const current = await readJsonShared<CurrentRunFile>(path.join(task.dir, 'current-run.json'));
      this.assertOperational();
      if (current.status !== 'ok') continue;
      if (current.value.status !== 'RUNNING' && current.value.status !== 'STARTING') continue;
      const runDir = current.value.runDir || path.join(task.dir, 'runs', current.value.runId);
      const identity = readWorkerIdentity(runDir);
      const verdict = await verifyWorkerLiveness(runDir, identity);
      this.assertOperational();
      // The engine is ALWAYS reconciled, whatever happened to the worker: a
      // worker that vanished says nothing about the CLI it started, and an
      // absent worker must never be read as "the run is finished". The worker
      // PID is only offered for termination when it is provably still ours.
      const ownWorker = verdict === 'alive' && identity && identity.token === current.value.runToken;
      const reconciliation = await reconcileRunProcesses(runDir, ownWorker ? identity.pid : null, true);
      this.assertOperational();
      const terminated = reconciliation.clean;
      let quarantineNote: string | null = reconciliation.clean ? null : reconciliation.note;
      if (verdict === 'unknown') {
        quarantineNote = `A identidade do worker anterior não pôde ser comprovada; nenhum processo foi encerrado por suposição. ${reconciliation.note}`;
      }
      task.uncertain = true;
      task.record.requiresReview = true;
      task.record.reviewReason = 'A execução anterior ficou incerta após reinício do broker.';
      await this.persistRecord(task);
      this.assertOperational();
      for (const entry of task.queue) if (entry.state === 'queued') entry.state = 'requires_review';
      await this.persistQueue(task);
      this.assertOperational();
      await this.append(task, current.value.runId, 'broker_recovered', {
        uncertainRuns: 1,
        previousWorkerPid: identity?.pid ?? current.value.workerPid,
        workerLiveness: verdict,
        terminated,
        reconciledTargets: reconciliation.targets.map((target) => ({ name: target.name, outcome: target.outcome, identity: target.identity })),
        quarantineNote,
        note: 'O broker reiniciou com trabalho em andamento; revise antes de retomar. Mensagens na fila não são reenviadas automaticamente.',
      });
      this.assertOperational();
      if (current.value.writerLockKey && quarantineNote) {
        const lock: LockRecord = {
          workspaceKey: current.value.writerLockKey,
          workspace: current.value.workspace,
          holderTaskId: task.record.taskId,
          holderRunId: current.value.runId,
          holderPid: identity?.pid ?? null,
          acquiredAt: current.value.startedAt,
          quarantined: true,
          quarantineNote,
        };
        this.locks.set(lock.workspaceKey, lock);
        await writeFileAtomic(path.join(this.locksDir(), `${lock.workspaceKey}.json`), JSON.stringify(lock, null, 2));
        this.assertOperational();
      }
      await this.writeCurrentRunBestEffort(task, { ...current.value, status: 'UNCERTAIN', workerPid: null });
      this.assertOperational();
      await this.writeDerivedNow(task, current.value.runId, false);
      this.assertOperational();
    }
    // Locks whose holder is gone and not quarantined are released.
    let lockFiles: string[] = [];
    try {
      lockFiles = await fs.readdir(this.locksDir());
      this.assertOperational();
    } catch {
      lockFiles = [];
    }
    for (const file of lockFiles) {
      this.assertOperational();
      const key = file.replace(/\.json$/, '');
      if (this.locks.has(key)) continue;
      const read = await readJsonShared<LockRecord>(path.join(this.locksDir(), file));
      this.assertOperational();
      if (read.status !== 'ok') {
        await fs.rm(path.join(this.locksDir(), file), { force: true });
        this.assertOperational();
        continue;
      }
      if (read.value.quarantined) {
        this.locks.set(key, read.value);
        continue;
      }
      await fs.rm(path.join(this.locksDir(), file), { force: true });
      this.assertOperational();
    }
    await this.sweepOrphanWorktrees();
  }

  /**
   * Removes worktrees no live task owns, and reports the ones it will not touch.
   *
   * Deliberately the LAST pass: quarantined locks are re-seeded just above, and
   * a quarantined worktree must never be swept — a process of the previous run
   * may still be able to write there.
   *
   * This is not optional once provisioning exists. `git worktree add` can
   * outlast PREPARATION_DRAIN_MS on a large repository; shutdown logs and
   * proceeds, leaving a registered worktree with no task. Without this sweep
   * that leaks, one directory per interrupted start.
   *
   * Removal is narrow by design: only a tree with no uncommitted work, and only
   * through git, which refuses a dirty tree on its own. Anything dirty or
   * unattributable is listed and left alone.
   */
  private async sweepOrphanWorktrees(): Promise<void> {
    const owned = new Set<string>();
    for (const task of this.tasks.values()) owned.add(task.record.taskId.slice(0, 16));
    for (const lock of this.locks.values()) if (lock.quarantined) owned.add(lock.holderTaskId.slice(0, 16));
    let orphans: Awaited<ReturnType<typeof listOrphans>>;
    try {
      orphans = await listOrphans(this.stateRoot, (_repoKey, prefix) => owned.has(prefix));
    } catch {
      return;
    }
    for (const orphan of orphans) {
      this.assertOperational();
      if (orphan.dirtyFiles.length > 0) {
        this.options.log(`worktree órfão preservado (${orphan.dirtyFiles.length} arquivo(s) não commitado(s)): ${orphan.path}`);
        continue;
      }
      // The repository is reached through the worktree itself; if that fails,
      // the directory is not a usable worktree and is left for a human.
      let repository: Repository;
      try {
        repository = await resolveRepository(orphan.path);
      } catch {
        this.options.log(`worktree órfão não atribuível, preservado: ${orphan.path}`);
        continue;
      }
      const removal = await withRepositoryMutex(repository.repoKey, () => removeWorktree(repository, orphan.path));
      this.options.log(removal.removed
        ? `worktree órfão limpo removido: ${orphan.path}`
        : `worktree órfão preservado (git recusou a remoção): ${orphan.path} — ${removal.reason ?? 'sem motivo informado'}`);
    }
  }

  private async openTask(record: TaskRecord, dir: string): Promise<TaskState> {
    const existing = this.tasks.get(record.taskId);
    if (existing) return existing;
    const log = await EventLog.open(path.join(dir, 'events.jsonl'));
    // Token totals are restored from their own snapshot, so opening a task no
    // longer reads its entire log. That read existed only to re-sum three event
    // types, and its cost grew with everything the task had ever done — paid on
    // every broker start, for every task.
    const usageFile = path.join(dir, 'usage.json');
    const persistedUsage = await readJsonShared<unknown>(usageFile);
    let claudeUsage = persistedUsage.status === 'ok' ? ClaudeUsageAccumulator.fromJSON(persistedUsage.value) : null;
    if (!claudeUsage) claudeUsage = ClaudeUsageAccumulator.fromEvents(await log.readFrom(0));
    const queue = await this.loadQueue(dir);
    const pointer = await readJsonShared<{ sessionId?: string; resumeFingerprint?: string }>(path.join(dir, 'session.json'));
    const task: TaskState = {
      record,
      dir,
      log,
      run: null,
      worker: null,
      workerReady: false,
      modelTransition: null,
      phase: 'terminal',
      currentTool: null,
      lastActivityAt: Date.now(),
      coordinatorLastSeenAt: null,
      queue,
      pending: new Map(),
      resolvedRequests: new Set(),
      alertsRaised: new Set(),
      derivedCache: null,
      lastDecisionAlertAt: null,
      uncertain: record.requiresReview,
      disconnected: false,
      previousSessionId: pointer.status === 'ok' && typeof pointer.value.sessionId === 'string' ? pointer.value.sessionId : null,
      previousSessionFingerprint: pointer.status === 'ok' && typeof pointer.value.resumeFingerprint === 'string' ? pointer.value.resumeFingerprint : null,
      quota: null,
      claudeUsage,
      codexUsage: unavailableCodexUsage(),
      usageRefresh: null,
      writer: null,
      derivedDirty: false,
      lastTelemetryEventAt: 0,
      changedFilesCache: null,
      endTimer: null,
      updatedAt: new Date().toISOString(),
      chain: Promise.resolve(),
    };
    this.tasks.set(record.taskId, task);
    return task;
  }

  /** Best effort: a missing or stale snapshot only costs a log replay at startup. */
  private async persistUsage(task: TaskState): Promise<void> {
    try {
      await writeFileAtomic(path.join(task.dir, 'usage.json'), JSON.stringify(task.claudeUsage.toJSON(), null, 2));
    } catch {
      // Telemetry, not authority: the log remains the source of truth.
    }
  }

  private async persistRecord(task: TaskState): Promise<void> {
    await writeFileAtomic(path.join(task.dir, 'task.json'), JSON.stringify(task.record, null, 2));
  }

  // ------------------------------------------------------------- registration

  async register(threadId: string, source: string): Promise<{ taskId: string; taskHandle: string; created: boolean; requiresReview: boolean }> {
    if (typeof threadId !== 'string' || !THREAD_ID_PATTERN.test(threadId)) throw new HttpError(400, 'THREAD_ID_INVALID');
    const taskId = taskIdForThread(threadId);
    const dir = path.join(this.tasksDir(), taskId);
    await fs.mkdir(dir, { recursive: true });
    const existing = this.tasks.get(taskId) ?? null;
    const { handle, hash } = mintTaskHandle();
    const record: TaskRecord = existing
      ? { ...existing.record, handleHash: hash, handleRotatedAt: new Date().toISOString() }
      : { taskId, threadId, createdAt: new Date().toISOString(), handleHash: hash, handleRotatedAt: new Date().toISOString(), workspace: null, requiresReview: false, reviewReason: null };
    const task = await this.openTask(record, dir);
    task.record = record;
    await this.persistRecord(task);
    await this.append(task, task.run?.runId ?? 'none', 'task_registered', { source, rotated: Boolean(existing) });
    this.options.log(`task ${taskId} registered (${source})`);
    this.changed(task);
    if (!this.options.harness) void this.refreshUsage(task);
    return { taskId, taskHandle: handle, created: !existing, requiresReview: record.requiresReview };
  }

  /**
   * Mints a new handle for an existing task and invalidates the previous one.
   *
   * Rotation is a takeover, not a copy: whoever held the old handle stops being
   * able to act on the task. That is the property that keeps a paired
   * coordinator from silently sharing control with a stale one, and it is why
   * this is appended to the durable log rather than done quietly.
   */
  async rotateHandle(task: TaskState, reason: 'voice-pairing', source: ActionSource): Promise<{ taskId: string; taskHandle: string; requiresReview: boolean }> {
    const { handle, hash } = mintTaskHandle();
    const previousRotatedAt = task.record.handleRotatedAt;
    task.record = { ...task.record, handleHash: hash, handleRotatedAt: new Date().toISOString() };
    await this.persistRecord(task);
    await this.append(task, task.run?.runId ?? 'none', 'task_handle_rotated', {
      reason,
      source,
      previousRotatedAt,
      note: 'Um handle novo foi emitido; o anterior deixou de valer. Quem o detinha não age mais nesta tarefa.',
    });
    this.options.log(`task ${task.record.taskId}: handle rotacionado (${reason}, ${source})`);
    this.changed(task);
    return { taskId: task.record.taskId, taskHandle: handle, requiresReview: task.record.requiresReview };
  }

  resolveHandle(handle: unknown): TaskState {
    if (typeof handle !== 'string' || !handle) throw new HttpError(403, 'TASK_HANDLE_REQUIRED');
    for (const task of this.tasks.values()) if (verifyTaskHandle(handle, task.record.handleHash)) return task;
    throw new HttpError(403, 'TASK_HANDLE_INVALID');
  }

  getTask(taskId: string): TaskState {
    const task = this.tasks.get(taskId);
    if (!task) throw new HttpError(404, 'TASK_NOT_FOUND');
    return task;
  }

  touchCoordinator(task: TaskState): void {
    task.coordinatorLastSeenAt = Date.now();
    this.changed(task);
  }

  /**
   * Confirms that the ARTIFACTS of an uncertain run were reviewed.
   *
   * This never releases ownership of a checkout. A quarantined writer lock
   * means a process of that run may still be alive, and reviewing a diff says
   * nothing about that; releasing it is a separate, explicit decision that
   * re-checks for survivors first (see `releaseQuarantinedLock`).
   */
  async acknowledgeReview(task: TaskState, note: string | null, source: ActionSource): Promise<void> {
    if (!task.record.requiresReview && !task.uncertain) return;
    task.record.requiresReview = false;
    task.record.reviewReason = null;
    task.uncertain = false;
    task.disconnected = false;
    await this.persistRecord(task);
    const quarantined = [...this.locks.values()].filter((lock) => lock.quarantined && lock.holderTaskId === task.record.taskId);
    await this.append(task, task.run?.runId ?? 'none', 'review_acknowledged', {
      source,
      note: note ? redactSensitiveText(note).slice(0, 500) : null,
      quarantinedLocks: quarantined.map((lock) => lock.workspaceKey),
      ownershipReleased: false,
      ...(quarantined.length ? { ownershipNote: 'A revisão de artefatos não libera a posse do checkout; use a liberação explícita da trava em quarentena.' } : {}),
    });
    this.changed(task);
  }

  /**
   * Explicit, administrative release of a quarantined checkout lock.
   *
   * Refuses while any recorded process of the holding run is running or cannot
   * be proven gone: a writer is never restored while a survivor is possible.
   * The decision and its reason are recorded in the task log.
   */
  /**
   * What worktrees exist under this state root and which are unaccounted for.
   *
   * Ownership is decided here, not in the git module, because only the task
   * manager knows which tasks are live and which locks are quarantined. A
   * quarantined worktree is never reported as an orphan: a process of the
   * previous run may still be able to write there, and the audited release
   * path — not a sweep — is what ends that.
   */
  async worktreeInventory(): Promise<{ policies: WorktreePolicyRecord[]; orphans: Array<{ path: string; repoKey: string; taskId: string; dirtyFiles: string[] }>; fleet: ReturnType<TaskManager['fleetView']> }> {
    const ownedPrefixes = new Set<string>();
    for (const task of this.tasks.values()) ownedPrefixes.add(task.record.taskId.slice(0, 16));
    for (const lock of this.locks.values()) if (lock.quarantined) ownedPrefixes.add(lock.holderTaskId.slice(0, 16));
    const orphans = await listOrphans(this.stateRoot, (_repoKey, taskPrefix) => ownedPrefixes.has(taskPrefix));
    const policies = await this.worktreePolicy.list();
    const fleet = this.fleetView();
    for (const entry of fleet.byRepository) {
      entry.limit = policies.find((policy) => policy.repoKey === entry.repoKey)?.maxParallelRuns ?? null;
    }
    return { policies, orphans, fleet };
  }

  /**
   * What N parallel runs are costing, on one account.
   *
   * The fleet cap is a number in a policy record, which tells you when you are
   * refused but not what you are spending. Observation of /usage is serialized;
   * consumption is not — so approving parallelism without seeing the draw is
   * approving a cost nobody is shown. This puts the two next to each other:
   * how many runs are live per repository, what they have drawn so far, and
   * what the account has left.
   */
  fleetView(): {
    runs: Array<{ taskId: string; threadId: string; repoKey: string | null; branch: string | null; model: string; turns: number; tokens: number | null; startedAt: string }>;
    byRepository: Array<{ repoKey: string; active: number; limit: number | null }>;
    account: { session: number | null; week: number | null; observedAt: string | null };
  } {
    const runs: Array<{ taskId: string; threadId: string; repoKey: string | null; branch: string | null; model: string; turns: number; tokens: number | null; startedAt: string }> = [];
    const perRepo = new Map<string, number>();
    for (const task of this.tasks.values()) {
      const run = task.run;
      if (!run || run.finalized) continue;
      const repoKey = run.worktree?.repository.repoKey ?? null;
      if (repoKey) perRepo.set(repoKey, (perRepo.get(repoKey) ?? 0) + 1);
      const usage = task.claudeUsage.snapshot();
      runs.push({
        taskId: task.record.taskId,
        threadId: task.record.threadId,
        repoKey,
        branch: run.worktree?.branch ?? null,
        model: run.observedModel ?? run.requestedModel,
        turns: run.turns,
        tokens: usage.quality === 'unavailable' ? null : usage.totalObservedTokens,
        startedAt: run.startedAt,
      });
    }
    const quota = this.quota.view('claude-fable-5-1');
    return {
      runs,
      byRepository: [...perRepo.entries()].map(([repoKey, active]) => ({ repoKey, active, limit: null })),
      // Percentages only, exactly as the panel already reports them: never raw
      // account figures.
      account: {
        session: quota.snapshot?.session.remainingPercent ?? null,
        week: quota.snapshot?.allModels.remainingPercent ?? null,
        observedAt: quota.observedAt ?? null,
      },
    };
  }

  /**
   * Removes a retained worktree, on the operator's explicit instruction.
   *
   * Retention exists because uncommitted work is the normal end state of a run,
   * so discarding it has to be stated, not defaulted: a dirty tree is only
   * removed with confirmDiscardUncommitted, and the files being discarded are
   * named back in the answer. A tree whose lock is still quarantined is never
   * removed here — releasing ownership is the other, survivor-checking action.
   */
  async releaseWorktree(target: string, request: { note: string | null; confirmDiscardUncommitted: boolean }, source: ActionSource): Promise<{ removed: boolean; path: string; discarded: string[]; note: string }> {
    const note = (request.note ?? '').trim();
    if (!note) throw new HttpError(400, 'NOTE_REQUIRED', { message: 'Remover um worktree exige uma nota; a remoção fica registrada.' });
    const canonical = canonicalize(target);
    for (const lock of this.locks.values()) {
      if (canonicalize(lock.workspace) !== canonical) continue;
      if (lock.quarantined) {
        throw new HttpError(409, 'WORKSPACE_LOCK_QUARANTINED', {
          holderTaskId: lock.holderTaskId,
          note: lock.quarantineNote,
          remediation: 'Um processo da execução anterior pode continuar escrevendo aqui. Libere a posse pela rota de travas, que reverifica sobreviventes, antes de remover o diretório.',
        });
      }
      throw new HttpError(409, 'WORKSPACE_WRITER_LOCKED', { holderTaskId: lock.holderTaskId, holderRunId: lock.holderRunId, message: 'Este worktree ainda pertence a uma execução ativa.' });
    }
    let repository: Repository;
    try {
      repository = await resolveRepository(target);
    } catch (error) {
      throw new HttpError(400, (error as { code?: string }).code ?? 'NOT_A_GIT_REPOSITORY', { message: (error as Error).message });
    }
    const dirty = await gitStatus(target);
    if (dirty.length > 0 && !request.confirmDiscardUncommitted) {
      throw new HttpError(409, 'WORKTREE_HAS_UNCOMMITTED_WORK', {
        files: dirty.slice(0, 50),
        message: `Este worktree tem ${dirty.length} arquivo(s) com alterações não commitadas. Commite a partir dele, ou repita com confirmDiscardUncommitted para descartar.`,
      });
    }
    // Forced only here, only after the operator confirmed, and only for the
    // files just named back to them.
    const removal = await withRepositoryMutex(repository.repoKey, () => removeWorktree(repository, target, { force: dirty.length > 0 }));
    if (!removal.removed) throw new HttpError(409, 'WORKTREE_REMOVE_REFUSED', { message: removal.reason ?? 'git recusou a remoção.' });
    this.options.log(`worktree removido por ação administrativa (${source}): ${target} — ${note}`);
    return { removed: true, path: target, discarded: dirty.slice(0, 50), note };
  }

  async releaseQuarantinedLock(workspaceKey: string, request: { note: string | null; confirmHistoricalRisk: boolean; expectedTaskId: string | null; expectedRunId: string | null }, source: ActionSource): Promise<{ released: boolean; workspaceKey: string; livePids: number[]; note: string; historicalAncestryConclusive: boolean }> {
    const lock = this.locks.get(workspaceKey);
    if (!lock) throw new HttpError(404, 'LOCK_NOT_FOUND');
    if (!lock.quarantined) throw new HttpError(409, 'LOCK_NOT_QUARANTINED', { note: 'Uma trava ativa pertence a uma execução em andamento; encerre a execução.' });
    if (lock.releaseInProgress) throw new HttpError(409, 'LOCK_RELEASE_IN_PROGRESS');
    if (!request.note?.trim() || !request.confirmHistoricalRisk || request.expectedTaskId !== lock.holderTaskId || request.expectedRunId !== lock.holderRunId) {
      throw new HttpError(409, 'LOCK_RELEASE_CONFIRMATION_REQUIRED', {
        holderTaskId: lock.holderTaskId,
        holderRunId: lock.holderRunId,
        note: 'A liberação excepcional exige nota, reconhecimento explícito do risco histórico e a identidade exata da posse atual.',
      });
    }
    // Reserve synchronously before the first await. JavaScript can interleave a
    // second request at any await boundary; that request must see the reservation
    // before survivor inspection or durable audit begins.
    lock.releaseInProgress = true;
    const task = this.tasks.get(lock.holderTaskId) ?? null;
    let check: { releasable: boolean; livePids: number[]; note: string } = { releasable: false, livePids: [], note: 'Auditoria ainda não executada.' };
    const historicalAncestryConclusive = false;
    try {
      // Deterministic harness scheduling window: proves another HTTP request
      // observes releaseInProgress while the first audit is still in flight.
      if (this.options.harness) await new Promise<void>((resolve) => setTimeout(resolve, 50));
      const runDir = task ? path.join(task.dir, 'runs', lock.holderRunId) : null;
      check = runDir ? await survivorCheck(runDir, lock.holderPid) : { releasable: false, livePids: [], note: 'A execução que detém a trava não pôde ser localizada no estado; a posse não é liberada às cegas.' };
      if (!check.releasable) {
        if (task) await this.append(task, lock.holderRunId, 'lock_release_refused', { workspaceKey, source, livePids: check.livePids, note: check.note });
        throw new HttpError(409, 'LOCK_SURVIVOR_POSSIBLE', { livePids: check.livePids, note: check.note });
      }
      if (task) {
        // Durable authorization comes first. If it cannot be audited, the
        // checkout stays quarantined and the operation fails closed.
        await this.append(task, lock.holderRunId, 'lock_release_authorized', {
          workspaceKey,
          source,
          note: redactSensitiveText(request.note!).slice(0, 500),
          evidence: check.note,
          historicalAncestryConclusive,
          riskAcknowledged: true,
          visibleProcesses: check.livePids,
          ownership: { taskId: lock.holderTaskId, runId: lock.holderRunId },
        });
      }
      // Re-read immediately before deletion so a stale request can never
      // release a lock replaced while the audit was being persisted.
      const persisted = await readJsonShared<LockRecord>(path.join(this.locksDir(), `${workspaceKey}.json`));
      const current = this.locks.get(workspaceKey);
      if (current !== lock || persisted.status !== 'ok' || persisted.value.holderTaskId !== lock.holderTaskId || persisted.value.holderRunId !== lock.holderRunId || !persisted.value.quarantined) {
        throw new HttpError(409, 'LOCK_OWNERSHIP_CHANGED', { note: 'A posse mudou durante a auditoria; nada foi liberado.' });
      }
      await fs.rm(path.join(this.locksDir(), `${workspaceKey}.json`));
      this.locks.delete(workspaceKey);
      if (task) await this.append(task, lock.holderRunId, 'lock_released', {
        workspaceKey,
        source,
        ownership: { taskId: lock.holderTaskId, runId: lock.holderRunId },
      });
      if (task) this.changed(task);
    } catch (error) {
      if (this.locks.get(workspaceKey) === lock) lock.releaseInProgress = false;
      throw error;
    }
    return { released: true, workspaceKey, livePids: [], note: check.note, historicalAncestryConclusive };
  }

  // --------------------------------------------------------------- events

  /**
   * Appends to the task log and broadcasts, globally serialized: the sequence
   * number, the durable write and the broadcast happen in one order for every
   * task, so no subscriber can observe a later sequence before an earlier one.
   */
  append(task: TaskState, runId: string, type: string, data: Record<string, unknown>, toolUseId?: string): Promise<EventRecord> {
    const run = async (): Promise<EventRecord> => {
      this.globalSeq += 1;
      const gseq = this.globalSeq;
      const record = await task.log.append({ type, taskId: task.record.taskId, runId, threadId: task.record.threadId, ...(toolUseId ? { toolUseId } : {}), data, gseq });
      task.lastActivityAt = Date.now();
      task.derivedDirty = true;
      if (task.derivedCache?.runId === runId) task.derivedCache.events.push(record);
      task.updatedAt = record.ts;
      this.options.onEvent(record);
      return record;
    };
    const next = this.appendChain.then(run, run);
    this.appendChain = next.catch(() => undefined);
    return next;
  }

  private changed(task: TaskState): void {
    task.updatedAt = new Date().toISOString();
    this.options.onTaskChanged(this.view(task));
  }

  // ---------------------------------------------------------------- queue

  private async loadQueue(dir: string): Promise<QueueEntry[]> {
    const file = path.join(dir, 'queue.jsonl');
    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch {
      return [];
    }
    const entries = new Map<string, QueueEntry>();
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as QueueEntry;
        entries.set(parsed.messageId, { ...(entries.get(parsed.messageId) ?? parsed), ...parsed });
      } catch {
        // skip
      }
    }
    return [...entries.values()];
  }

  private async persistQueue(task: TaskState): Promise<void> {
    const lines = task.queue.map((entry) => JSON.stringify(entry)).join('\n');
    await writeFileAtomic(path.join(task.dir, 'queue.jsonl'), lines ? `${lines}\n` : '');
  }

  private queueView(entry: QueueEntry): QueueEntryView {
    return { messageId: entry.messageId, source: entry.source, textPreview: entry.textPreview, receivedAt: entry.receivedAt, deliveredAt: entry.deliveredAt, state: entry.state };
  }

  /**
   * Accepts guidance for the next turn. A 202 means the message is durably
   * queued: it survives a not-yet-ready worker and is flushed in order.
   */
  async enqueueMessage(task: TaskState, text: string, source: ActionSource): Promise<QueueEntryView> {
    if (!task.run || task.run.finalized || task.run.finalizing || !task.worker) throw new HttpError(409, 'NO_ACTIVE_RUN');
    if (task.uncertain) throw new HttpError(409, 'REQUIRES_REVIEW', { message: 'A execução está incerta; confirme a revisão antes de enviar novas orientações.' });
    const budget = budgetStatus(task.run, Date.now());
    if (budget?.exhausted) throw new HttpError(409, 'BUDGET_EXHAUSTED', { message: 'O orçamento desta execução esgotou; nenhum turno novo é entregue.', budget, note: BUDGET_EXHAUSTED_NOTE });
    if (task.run.endAfterTurn) throw new HttpError(409, 'ENDING', { message: 'Esta execução encerra quando o turno atual terminar; nenhuma orientação nova é aceita.' });
    const redacted = redactSensitiveText(text);
    const entry: QueueEntry = { messageId: `msg-${randomUUID()}`, source, text: redacted, textPreview: boundedPreview(redacted, 300).preview, receivedAt: new Date().toISOString(), deliveredAt: null, state: 'queued' };
    task.queue.push(entry);
    await this.persistQueue(task);
    await this.append(task, task.run.runId, 'message_queued', { messageId: entry.messageId, source, textPreview: entry.textPreview });
    if (source !== 'browser') this.touchCoordinator(task);
    await this.deliverNext(task);
    this.changed(task);
    return this.queueView(entry);
  }

  /**
   * A review note on a changed file becomes guidance for the next turn.
   *
   * Three steps, in order: validate the target, record the annotation in the
   * durable log, and hand the rendered text to the EXISTING enqueueMessage.
   * There is no new delivery path, no second queue and no new worker message,
   * so every guarantee comes along unchanged — refused with NO_ACTIVE_RUN,
   * refused while the run REQUIRES_REVIEW, delivered only between turns, never
   * mid-turn, persisted in queue.jsonl, redacted on the way in.
   *
   * The target must be a file the broker already observed as changed. An
   * annotation can therefore never name an arbitrary path, which is what keeps
   * this from becoming a way to make Claude read somewhere it was not sent.
   */
  async annotate(task: TaskState, input: { file: unknown; comment: unknown; hunk?: unknown }, source: ActionSource): Promise<QueueEntryView> {
    const file = typeof input.file === 'string' ? input.file.trim() : '';
    const comment = typeof input.comment === 'string' ? input.comment.trim() : '';
    if (!file) throw new HttpError(400, 'FILE_REQUIRED', { message: 'Informe o arquivo anotado em "file".' });
    if (!comment) throw new HttpError(400, 'COMMENT_REQUIRED', { message: 'Uma anotação sem texto não orienta nada.' });
    const workspace = task.record.workspace;
    if (!workspace) throw new HttpError(409, 'NO_ACTIVE_RUN');
    const observed = await this.observedFiles(task);
    if (!observed.includes(file)) {
      throw new HttpError(400, 'FILE_NOT_OBSERVED', {
        message: 'Só é possível anotar um arquivo que o broker observou como alterado nesta execução.',
        observed: observed.slice(0, 50),
      });
    }
    if (isSensitivePath(file)) throw new HttpError(403, 'SENSITIVE_FILE', { message: 'Arquivos sensíveis não são anotados nem exibidos.' });
    const resolved = resolveWorkspacePath(workspace, file);
    if (!resolved.inside) throw new HttpError(403, 'OUTSIDE_WORKSPACE', { message: 'O caminho anotado sai da árvore de trabalho.' });
    const hunk = typeof input.hunk === 'string' && input.hunk.trim() ? input.hunk.trim().slice(0, 120) : null;
    const rendered = `Anotação de revisão em ${file}${hunk ? ` (${hunk})` : ''}: ${comment}`;
    await this.append(task, task.run?.runId ?? 'none', 'diff_annotated', {
      file,
      hunk,
      commentPreview: boundedPreview(redactSensitiveText(comment), 300).preview,
      source,
      note: 'A anotação entra na fila como orientação e é entregue entre turnos, como qualquer outra.',
    });
    return this.enqueueMessage(task, rendered, source);
  }

  /** The changed-file list the annotation and diff routes validate against. */
  private async observedFiles(task: TaskState): Promise<string[]> {
    const fresh = await this.changedFiles(task);
    return fresh.observed;
  }

  /**
   * The diff of one observed file, for review.
   *
   * Diff output is file content the panel has never previewed, so it goes
   * through the same redaction as everything else public, and through the same
   * target validation as an annotation.
   */
  async fileDiff(task: TaskState, file: string): Promise<{ file: string; diff: string; truncated: boolean }> {
    const workspace = task.record.workspace;
    if (!workspace) throw new HttpError(409, 'NO_ACTIVE_RUN');
    const observed = await this.observedFiles(task);
    if (!observed.includes(file)) throw new HttpError(400, 'FILE_NOT_OBSERVED', { observed: observed.slice(0, 50) });
    if (isSensitivePath(file)) throw new HttpError(403, 'SENSITIVE_FILE');
    const resolved = resolveWorkspacePath(workspace, file);
    if (!resolved.inside) throw new HttpError(403, 'OUTSIDE_WORKSPACE');
    // `--` separates the pathspec from revisions, so a file named like a ref
    // cannot be read as one.
    const result = await git(['diff', '--unified=3', '--', file], workspace);
    const raw = result.code === 0 ? result.stdout : '';
    const redacted = redactSensitiveText(raw);
    const limit = 64_000;
    return { file, diff: redacted.slice(0, limit), truncated: redacted.length > limit };
  }

  private async deliverNext(task: TaskState): Promise<void> {
    const run = task.run;
    if (!run || !task.worker || !task.workerReady || task.uncertain || run.finalized || run.finalizing) return;
    if (task.phase !== 'idle') return;
    // A model switch is in flight: the next turn waits for a known model.
    if (task.modelTransition) return;
    // Exhausted budget: what is queued stays queued. The turn that spent the
    // last of it was allowed to finish; the next one is simply not started.
    if (budgetStatus(run, Date.now())?.exhausted) return;
    // Same for an end that is waiting on this turn: starting another one would
    // be the opposite of what was asked.
    if (run.endAfterTurn) return;
    const next = task.queue.find((entry) => entry.state === 'queued');
    if (!next) return;
    next.state = 'delivered';
    next.deliveredAt = new Date().toISOString();
    task.phase = 'busy_model';
    await this.persistQueue(task);
    this.sendToWorker(task, { t: 'deliver', messageId: next.messageId, text: next.text, source: next.source });
    await this.append(task, run.runId, 'message_delivered', { messageId: next.messageId, source: next.source });
  }

  // -------------------------------------------------------------- requests

  async answer(task: TaskState, body: { requestId: unknown; runId: unknown; decision: unknown; message?: unknown; answers?: unknown }, source: ActionSource): Promise<void> {
    const requestId = String(body.requestId ?? '');
    if (task.resolvedRequests.has(requestId)) throw new HttpError(409, 'REQUEST_ALREADY_RESOLVED');
    const pending = task.pending.get(requestId);
    if (!pending) throw new HttpError(404, 'REQUEST_NOT_FOUND');
    if (body.runId !== pending.runId) throw new HttpError(409, 'REQUEST_WRONG_RUN');
    const decision = body.decision === 'allow' || body.decision === 'deny' || body.decision === 'answer' ? body.decision : null;
    if (!decision) throw new HttpError(400, 'DECISION_INVALID');
    const answers = body.answers && typeof body.answers === 'object' ? (body.answers as Record<string, string | string[]>) : undefined;
    task.pending.delete(requestId);
    task.resolvedRequests.add(requestId);
    this.sendToWorker(task, { t: 'answer', requestId, decision, ...(typeof body.message === 'string' ? { message: body.message.slice(0, 2000) } : {}), ...(answers ? { answers } : {}), source });
    if (source !== 'browser') this.touchCoordinator(task);
    this.changed(task);
  }

  // ------------------------------------------------------------- lifecycle

  private sendToWorker(task: TaskState, message: BrokerToWorker): void {
    try {
      task.worker?.send(message);
    } catch (error) {
      this.options.log(`task ${task.record.taskId}: envio ao worker falhou (${(error as Error).name})`);
    }
  }

  async interrupt(task: TaskState, source: ActionSource): Promise<void> {
    if (!task.run || !task.worker || task.run.finalized) throw new HttpError(409, 'NO_ACTIVE_RUN');
    this.sendToWorker(task, { t: 'interrupt', source });
    if (source !== 'browser') this.touchCoordinator(task);
  }

  /**
   * Ends the session, now or once the running turn finishes.
   *
   * Ending now interrupts the turn, which is why it reports CANCELLED: that is
   * the honest outcome of stopping work in the middle. `afterTurn` is the
   * other thing a coordinator means by "we are done" — let it finish what it
   * is doing and then stop — and it closes COMPLETED, because nothing was cut
   * short. It is not an interrupt and never becomes one: if the turn runs for
   * an hour, the end waits an hour.
   */
  async end(task: TaskState, source: ActionSource, afterTurn = false): Promise<{ ending: true; afterTurn: boolean }> {
    if (!task.run || !task.worker || task.run.finalized) throw new HttpError(409, 'NO_ACTIVE_RUN');
    if (afterTurn && task.phase !== 'idle') {
      if (!task.run.endAfterTurn) {
        task.run.endAfterTurn = { source, requestedAt: new Date().toISOString() };
        await this.append(task, task.run.runId, 'end_after_turn_requested', { source, note: END_AFTER_TURN_NOTE });
        this.changed(task);
      }
      if (source !== 'browser') this.touchCoordinator(task);
      return { ending: true, afterTurn: true };
    }
    this.sendToWorker(task, { t: 'end', source });
    if (source !== 'browser') this.touchCoordinator(task);
    const run = task.run;
    task.endTimer = setTimeout(() => {
      if (task.run === run && !run.finalized) void this.finalize(task, run, 'CANCELLED', 'END_TIMEOUT', 'O worker não encerrou no prazo; a árvore de processos foi terminada.', 1, null);
    }, WORKER_END_GRACE_MS);
    task.endTimer.unref();
    return { ending: true, afterTurn: false };
  }

  /**
   * Switches the model between turns.
   *
   * The transition is reserved before the request leaves and released only
   * after the worker confirms, so a queued message cannot start a turn on an
   * indeterminate model. Until the CLI confirms, the recorded model is still
   * the old one; a refusal reports the model that stayed active.
   */
  async setModel(task: TaskState, model: unknown, reason: unknown, source: ActionSource): Promise<{ applied: 'next_turn'; strategy: 'in_session'; model: AuthorizedModel }> {
    if (typeof model !== 'string' || !AUTHORIZED_MODELS.includes(model as AuthorizedModel)) throw new HttpError(400, 'MODEL_NOT_AUTHORIZED');
    if (typeof reason !== 'string' || !reason.trim()) throw new HttpError(400, 'MODEL_REASON_REQUIRED');
    if (!task.run || !task.worker || task.run.finalized) throw new HttpError(409, 'NO_ACTIVE_RUN');
    // Every refusal states which model stayed in force, so a caller never has
    // to assume whether its request took effect.
    if (task.phase !== 'idle') throw new HttpError(409, 'TURN_IN_PROGRESS', { activeModel: task.run.requestedModel });
    if (task.modelTransition) throw new HttpError(409, 'MODEL_CHANGE_IN_PROGRESS', { activeModel: task.run.requestedModel, pendingModel: task.modelTransition.model });
    const run = task.run;
    let uncertain = false;
    let settle: (outcome: { ok: boolean; activeModel: string | null; code: string | null }) => void = () => undefined;
    const confirmed = new Promise<{ ok: boolean; activeModel: string | null; code: string | null }>((resolve) => { settle = resolve; });
    // A timeout is NOT a refusal: the CLI may have applied the switch and only
    // lost or delayed its confirmation. `activeModel` is deliberately null.
    const timer = setTimeout(() => settle({ ok: false, activeModel: null, code: 'MODEL_CHANGE_TIMEOUT' }), MODEL_CHANGE_TIMEOUT_MS);
    timer.unref();
    task.modelTransition = { model, settle };
    this.changed(task);
    try {
      this.sendToWorker(task, { t: 'set_model', model, reason: reason.trim(), source });
      const outcome = await confirmed;
      if (outcome.code === 'MODEL_CHANGE_TIMEOUT') {
        // Nobody knows which model is loaded now. Asserting the old one and
        // resuming would run the next turn on an unknown model, so the run
        // becomes uncertain and no further turn is released until an explicit
        // review restarts it.
        uncertain = true;
        task.uncertain = true;
        task.record.requiresReview = true;
        task.record.reviewReason = 'A troca de modelo não foi confirmada pelo CLI; o modelo em vigor é desconhecido.';
        await this.persistRecord(task);
        await this.append(task, run.runId, 'model_change_uncertain', {
          requestedModel: model,
          previousModel: run.requestedModel,
          source,
          note: 'O CLI não confirmou a troca no prazo. Ele pode tê-la aplicado. O modelo em vigor não é afirmado e nenhum turno novo é liberado até revisão explícita.',
        });
        throw new HttpError(409, 'MODEL_CHANGE_UNCERTAIN', {
          activeModel: null,
          requestedModel: model,
          note: 'A troca não foi confirmada; o modelo em vigor é desconhecido e a execução exige revisão antes de continuar.',
        });
      }
      if (!outcome.ok) {
        throw new HttpError(409, outcome.code ?? 'MODEL_CHANGE_REFUSED', { activeModel: outcome.activeModel, note: 'O modelo em vigor não mudou.' });
      }
      run.requestedModel = model;
      run.modelReason = reason.trim();
      if (source !== 'browser') this.touchCoordinator(task);
      return { applied: 'next_turn', strategy: 'in_session', model: model as AuthorizedModel };
    } finally {
      clearTimeout(timer);
      task.modelTransition = null;
      this.changed(task);
      // A queued message starts its turn now — unless the model in force is
      // unknown, in which case nothing may run.
      if (!uncertain) await this.deliverNext(task);
    }
  }

  async inventoryFor(workspace: string): Promise<{ inventory: Inventory; trust: TrustCheck }> {
    const inventory = await inventoryCustomizations(workspace, this.options.harness ? { userConfigDir: null, userClaudeJsonPath: null, managedSettingsPaths: null, ancestorBoundary: workspace } : {});
    const trust = await this.trustStore.check(inventory);
    return { inventory, trust };
  }

  async approveTrust(task: TaskState, workspace: string, approvalRevision: number, approvedItems: string[] | 'all', note: string | undefined, source: ActionSource): Promise<TrustCheck> {
    const { inventory } = await this.inventoryFor(workspace);
    await this.trustStore.approve({ inventory, identity: { threadId: task.record.threadId, source: source === 'mcp' ? 'mcp' : source === 'browser' ? 'browser' : 'local-secret' }, approvalRevision, approvedItems, ...(note ? { approvedRevisionNote: note } : {}) });
    const trust = await this.trustStore.check(inventory);
    await this.append(task, task.run?.runId ?? 'none', 'trust_approved', { workspace: inventory.canonicalWorkspace, approvalRevision, items: approvedItems === 'all' ? inventory.items.length : approvedItems.length, trusted: trust.trusted, source });
    return trust;
  }

  /**
   * Reserves the task slot and the checkout writer lock synchronously, before
   * any awaited preparation, so two concurrent starts can never both proceed.
   */
  async startRun(task: TaskState, job: unknown, harness: Record<string, unknown> | null, source: ActionSource, acknowledgeReview: boolean, observation?: unknown): Promise<{ runId: string; status: 'STARTING' }> {
    let contract: JobContract;
    try {
      contract = resolveJobContract(job);
    } catch (error) {
      if (error instanceof ContractError) throw new HttpError(400, 'CONTRACT_INVALID', { code: error.code, message: error.message });
      throw error;
    }
    this.assertObserved(task, observation);
    // Admission stops the moment shutdown begins, before any reservation.
    if (this.stopping) throw new HttpError(503, 'BROKER_SHUTTING_DOWN', { message: 'O broker está encerrando; nenhuma execução nova é aceita.' });
    if ((task.record.requiresReview || task.uncertain) && !acknowledgeReview) {
      throw new HttpError(409, 'REQUIRES_REVIEW', { message: 'A última execução ficou incerta ou desconectada; confirme a revisão (acknowledgeReview: true) antes de iniciar outra.', reason: task.record.reviewReason });
    }
    let workspace: string;
    let canonicalWorkspace: string;
    try {
      workspace = realpathSync.native(contract.workspace);
      canonicalWorkspace = workspace.replace(/\\/g, '/').replace(/\/+$/, '');
      if (process.platform === 'win32') canonicalWorkspace = canonicalWorkspace.toLowerCase();
    } catch {
      throw new HttpError(400, 'WORKSPACE_NOT_FOUND');
    }
    // Everything a worktree run needs is resolved HERE, before the critical
    // section, because the section itself must stay free of awaits: the writer
    // lock has to be reserved atomically. The path is a pure function of
    // (repository, task), so the key is computable without touching the disk.
    let worktreePlan: WorktreePlan | null = null;
    let workspaceKey = sha256(canonicalWorkspace).slice(0, 24);
    if (contract.execution.mode === 'worktree') {
      worktreePlan = await this.planWorktree(task, contract, workspace);
      workspaceKey = sha256(canonicalizePlanned(worktreePlan.path)).slice(0, 24);
    }

    // --- synchronous critical section: no await until the reservation exists.
    if (task.run && !task.run.finalized) {
      this.releaseFleetReservation(worktreePlan);
      throw new HttpError(409, 'RUN_IN_PROGRESS', { runId: task.run.runId });
    }
    const holder = this.locks.get(workspaceKey);
    if (contract.capabilities.edit && holder && holder.holderTaskId !== task.record.taskId) {
      this.releaseFleetReservation(worktreePlan);
      throw new HttpError(409, holder.quarantined ? 'WORKSPACE_LOCK_QUARANTINED' : 'WORKSPACE_WRITER_LOCKED', { holderTaskId: holder.holderTaskId, holderRunId: holder.holderRunId, acquiredAt: holder.acquiredAt, ...(holder.quarantined ? { note: holder.quarantineNote } : {}) });
    }
    // A quarantined lock means a process of the previous run may still be able
    // to write here. Acknowledging the artefact review does NOT clear that:
    // ownership is released only by the explicit action that first re-checks
    // for survivors.
    if (holder?.quarantined && holder.holderTaskId === task.record.taskId) {
      this.releaseFleetReservation(worktreePlan);
      throw new HttpError(409, 'WORKSPACE_LOCK_QUARANTINED', {
        holderRunId: holder.holderRunId,
        note: holder.quarantineNote,
        remediation: 'Libere explicitamente a trava em quarentena depois de confirmar que nenhum processo da execução anterior sobreviveu; a revisão de artefatos não libera a posse.',
      });
    }
    const runId = `run-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const runToken = randomUUID();
    const runDir = path.join(task.dir, 'runs', runId);
    const resumeFingerprint = contractResumeFingerprint(contract);
    const resumeSessionId = task.previousSessionFingerprint === resumeFingerprint ? task.previousSessionId : null;
    const run: RunState = {
      runId,
      runToken,
      status: 'STARTING',
      startedAt: new Date().toISOString(),
      endedAt: null,
      contract,
      prompt: '',
      sessionConfirmed: false,
      requestedModel: contract.model.resolved ?? contract.model.requested,
      modelReason: contract.model.reason,
      observedModel: null,
      effortObservedByCli: null,
      sessionId: resumeSessionId,
      resumeFingerprint,
      workerPid: null,
      workerStartedAt: null,
      failureStage: null,
      failureCode: null,
      telemetryFailures: 0,
      turns: 0,
      tokensObserved: 0,
      toolTrail: [],
      lastTurnContextTokens: null,
      tools: { calls: 0, errors: 0, blocked: 0, byTool: new Map(), open: new Map(), recent: [] },
      thrashingSeen: new Set(),
      thrashing: null,
      policy: null,
      endAfterTurn: null,
      resumeMode: resumeSessionId ? 'automatic' : 'new',
      simulated: false,
      declaredWorkspace: worktreePlan ? workspace : null,
      worktree: worktreePlan,
      writerLockKey: contract.capabilities.edit ? workspaceKey : null,
      finalized: false,
      finalizing: false,
      initialPromptDelivered: false,
      ownershipRecorded: false,
      claudeAuthored: new Set(),
      harnessFinalizationFailure: this.options.harness && typeof harness?.finalizationFailure === 'string' ? harness.finalizationFailure : null,
    };
    task.run = run;
    if (contract.capabilities.edit) {
      // The lock is over the WORKING TREE the run writes to, not over the
      // repository. Two tasks in separate worktrees hold different locks and
      // legitimately run at once; what still serializes is the shared .git,
      // under the repository mutex.
      this.locks.set(workspaceKey, { workspaceKey, workspace: worktreePlan ? canonicalizePlanned(worktreePlan.path) : canonicalWorkspace, holderTaskId: task.record.taskId, holderRunId: runId, holderPid: null, acquiredAt: run.startedAt, quarantined: false });
    }
    task.uncertain = false;
    task.disconnected = false;
    task.phase = 'starting';
    task.currentTool = null;
    task.alertsRaised.clear();
    task.lastDecisionAlertAt = null;
    task.derivedCache = { runId, events: [] };
    task.pending.clear();
    task.workerReady = false;
    task.record.workspace = workspace;
    this.releaseFleetReservation(worktreePlan);
    // --- end of critical section.

    try {
      await fs.mkdir(runDir, { recursive: true });
      run.prompt = contract.prompt ?? (contract.promptFile ? await fs.readFile(contract.promptFile, 'utf8') : '');
      if (this.stopping) throw new HttpError(503, 'BROKER_SHUTTING_DOWN', { message: 'O broker começou a encerrar durante a preparação; nenhum worker será criado.' });
      // Provisioning happens BEFORE the inventory, never after. Trust has to be
      // evaluated against the directory the CLI will actually run in; inverting
      // this would approve the parent checkout and then launch somewhere whose
      // customizations nobody inventoried.
      let effectiveWorkspace = workspace;
      if (worktreePlan) {
        effectiveWorkspace = await this.provisionWorktree(task, run, worktreePlan);
        if (this.stopping || task.run !== run) throw new HttpError(503, 'BROKER_SHUTTING_DOWN', { message: 'O broker começou a encerrar durante o provisionamento; nenhum worker será criado.' });
      }
      const { inventory, trust: initialTrust } = await this.inventoryFor(effectiveWorkspace);
      let trust = initialTrust;
      if (this.stopping) throw new HttpError(503, 'BROKER_SHUTTING_DOWN', { message: 'O broker começou a encerrar durante a preparação; nenhum worker será criado.' });
      if (!trust.trusted && worktreePlan) {
        // A worktree is a new canonical path, so it has no approval of its own
        // and the first parallel run would die with WORKSPACE_NOT_TRUSTED —
        // pushing the user to approve blind. Derivation reuses the parent's
        // approval and only when every item matches by hash; it never mints one.
        // The parent key must be spelled exactly as the trust record was
        // written, so it comes from the inventory's own canonicalization rather
        // than from the lock-key spelling used above.
        const derived = await this.trustStore.deriveFromParent({ child: inventory, parentCanonicalWorkspace: canonicalizeWorkspace(workspace) });
        if (derived) {
          trust = await this.trustStore.check(inventory);
          await this.append(task, runId, 'trust_derived', {
            workspace: inventory.canonicalWorkspace,
            from: canonicalWorkspace,
            approvalRevision: derived.approvalRevision,
            items: derived.approvedItems.length,
            note: 'Aprovação herdada do checkout de origem: todo item bate por hash. Nenhum recurso novo foi autorizado.',
          });
        }
      }
      if (!trust.trusted) {
        throw new HttpError(409, 'WORKSPACE_NOT_TRUSTED', { reason: trust.reason, pending: trust.pending, changed: trust.changed, fingerprint: inventory.fingerprint, incomplete: inventory.incomplete });
      }
      const record = await this.trustStore.load(inventory.canonicalWorkspace);
      const launch = resolveLaunchCustomizations({ inventory, trust, record });
      task.writer = new StateWriter({ directory: runDir, telemetryMaxWaitMs: 1500, finalMaxWaitMs: 15000, onTelemetryFailure: (failure) => { run.telemetryFailures += 1; void this.reportTelemetryFailure(task, run, failure.file, failure.code); } });
      await this.persistRecord(task);
      if (run.writerLockKey) {
        const lock = this.locks.get(run.writerLockKey)!;
        await writeFileAtomic(path.join(this.locksDir(), `${run.writerLockKey}.json`), JSON.stringify(lock, null, 2));
      }
      // Ownership must be recorded before anything else happens; a failure here
      // aborts the launch and releases the reservation.
      try {
        await this.writeCurrentRun(task, { runId, runToken, status: 'STARTING', workerPid: null, workerStartedAt: null, startedAt: run.startedAt, workspace: effectiveWorkspace, writerLockKey: run.writerLockKey, runDir });
      } catch (error) {
        throw new HttpError(503, 'OWNERSHIP_RECORD_FAILED', {
          code: (error as { code?: string }).code ?? 'WRITE_FAILED',
          message: 'O estado autoritativo da execução não pôde ser gravado; nenhum trabalho é iniciado sem esse registro.',
        });
      }
      await this.append(task, runId, 'run_started', {
        startedAt: run.startedAt,
        requestedModel: run.requestedModel,
        modelReason: run.modelReason,
        effort: contract.effort,
        workspace: effectiveWorkspace,
        // Recorded so an audit of status.json can see a run that started with
        // no panel attached, and which channel was declared instead.
        observation: { mode: isRecord(observation) && observation.mode === 'voz' ? 'voz' : 'painel', observers: this.options.observers?.(task.record.taskId) ?? 0 },
        ...(worktreePlan ? { declaredWorkspace: workspace, worktree: { path: worktreePlan.path, branch: worktreePlan.branch, baseRef: worktreePlan.baseRef, repoKey: worktreePlan.repository.repoKey, provisionedBy: 'broker', policyEnabledAt: worktreePlan.policy.enabledAt } } : {}),
        profile: contract.profile,
        contractVersion: contract.version,
        limits: contract.limits,
        coordination: contract.coordination,
        scope: contract.scope,
        capabilities: contract.capabilities,
        resumeMode: run.resumeMode,
        resumeSessionId: run.sessionId,
        source,
        trust: { reason: trust.reason, approvalRevision: trust.trusted ? trust.approvalRevision : null, items: inventory.items.length, managedSettingsPresent: inventory.managedSettings.present },
      });
      if (source !== 'browser') this.touchCoordinator(task);
      this.changed(task);
      const approvedAgents = inventory.items.filter((item) => item.kind === 'agent').map((item) => path.basename(item.relativePath, '.md'));
      const approvedSkills = inventory.items.filter((item) => item.kind === 'skill').map((item) => path.basename(path.dirname(item.relativePath)));
      // Tracked so shutdown can await it: a preparation that finishes after the
      // worker sweep would leave a process nobody is watching.
      const preparation = this.prepareAndSpawn(task, run, launch, approvedAgents, approvedSkills, harness).catch((error) => {
        this.options.log(`task ${task.record.taskId}: preparação falhou inesperadamente (${(error as Error).name})`);
        void this.finalize(task, run, 'FAIL', 'PREPARATION_CRASH', redactSensitiveText(String((error as Error).message ?? error)).slice(0, 300), 1, 'preparation');
      }).finally(() => this.preparations.delete(preparation));
      this.preparations.add(preparation);
      return { runId, status: 'STARTING' };
    } catch (error) {
      // Every failure path releases the reservation it took.
      await this.releaseReservation(task, run);
      throw error;
    }
  }

  /**
   * A run never starts without a declared channel for watching it.
   *
   * Commit 0988ebb added this requirement, but only to the v1 runner, where
   * `Wait-ClaudeLivePanelReady` really blocks. In v2 it existed solely as prose
   * in SKILL.md and two READMEs telling the coordinator to confirm the panel —
   * an instruction to a model, not an invariant, and therefore the only place
   * in this codebase where the documentation promised more than the code did.
   *
   * The property worth keeping is not "a tab is on screen", which no broker can
   * verify. It is that the mode of observation is DECIDED before work starts
   * and recorded durably. `painel` is now actually checked against live SSE
   * subscribers; `voz` is an explicit, attributable choice for a coordinator
   * with no screen. What can no longer happen is a run starting with neither.
   *
   * Deliberately understated: a subscriber count proves a channel is attached,
   * not that a human is watching.
   */
  private assertObserved(task: TaskState, observation: unknown): void {
    const mode = isRecord(observation) && observation.mode === 'voz' ? 'voz' : 'painel';
    if (mode === 'voz') return;
    const observers = this.options.observers?.(task.record.taskId) ?? 0;
    if (observers > 0) return;
    throw new HttpError(409, 'OBSERVATION_REQUIRED', {
      message: 'Nenhum painel está acompanhando esta tarefa. Abra o link do painel e aguarde ele carregar, ou declare observação por voz (observation.mode: "voz") para assumir o acompanhamento narrado.',
      note: 'A contagem prova que um canal está anexado, não que alguém está olhando.',
    });
  }

  /**
   * Decides where a worktree run will live, and whether it may start at all.
   *
   * Everything here is a lookup or a policy check: no directory is created, so
   * a refusal leaves nothing behind. Runs before the critical section, because
   * the section cannot await.
   */
  private async planWorktree(task: TaskState, contract: JobContract, declaredWorkspace: string): Promise<WorktreePlan> {
    let repository: Repository;
    let policy: WorktreePolicyRecord;
    try {
      repository = await resolveRepository(declaredWorkspace);
      policy = await this.worktreePolicy.require(repository.repoKey);
    } catch (error) {
      const code = (error as { code?: string }).code ?? 'WORKTREE_UNAVAILABLE';
      throw new HttpError(code === 'WORKTREE_POLICY_REQUIRED' ? 403 : 400, code, { message: (error as Error).message });
    }
    // N sessions share one account, and observation is serialized while
    // consumption is not. Without this cap, parallelism would quietly burn a
    // week of quota with no visible decision anywhere.
    const active = [...this.tasks.values()].filter((other) =>
      other.record.taskId !== task.record.taskId
      && other.run
      && !other.run.finalized
      && other.run.worktree?.repository.repoKey === repository.repoKey);
    const reservations = this.fleetReservations.get(repository.repoKey) ?? new Map<string, string>();
    this.fleetReservations.set(repository.repoKey, reservations);
    if (active.length + reservations.size >= policy.maxParallelRuns) {
      throw new HttpError(429, 'FLEET_CAPACITY_REACHED', {
        limit: policy.maxParallelRuns,
        holders: [
          ...active.map((other) => ({ taskId: other.record.taskId, threadId: other.record.threadId, runId: other.run?.runId ?? null })),
          ...[...reservations.values()].map((taskId) => ({ taskId, threadId: this.tasks.get(taskId)?.record.threadId ?? null, runId: null })),
        ],
        message: `Já existem ${active.length + reservations.size} execução(ões) admitidas ou em preparação neste repositório, o limite aprovado. Aguarde uma terminar ou ajuste maxParallelRuns na política.`,
      });
    }
    const fleetReservationId = randomUUID();
    reservations.set(fleetReservationId, task.record.taskId);
    const root = policy.worktreeRoot ?? this.stateRoot;
    const location = worktreePathFor(root, repository.repoKey, task.record.taskId);
    try {
      assertUsablePathLength(location.path);
    } catch (error) {
      reservations.delete(fleetReservationId);
      if (reservations.size === 0) this.fleetReservations.delete(repository.repoKey);
      throw new HttpError(400, (error as { code?: string }).code ?? 'WORKTREE_PATH_TOO_LONG', { message: (error as Error).message });
    }
    // Uncommitted work is never deleted, so retention is what fills a disk.
    // Refusing with a number beats discovering it when the volume is full.
    let retained;
    try {
      retained = await listOrphans(root, () => false);
    } catch (error) {
      reservations.delete(fleetReservationId);
      if (reservations.size === 0) this.fleetReservations.delete(repository.repoKey);
      throw error;
    }
    const mine = retained.filter((entry) => entry.repoKey === repository.repoKey && canonicalize(entry.path) !== canonicalizePlanned(location.path));
    if (mine.length >= policy.maxRetainedWorktrees) {
      reservations.delete(fleetReservationId);
      if (reservations.size === 0) this.fleetReservations.delete(repository.repoKey);
      throw new HttpError(409, 'WORKTREE_RETENTION_LIMIT', {
        limit: policy.maxRetainedWorktrees,
        retained: mine.map((entry) => ({ path: entry.path, dirtyFiles: entry.dirtyFiles.length })),
        message: `Há ${mine.length} worktree(s) retido(s) deste repositório, o limite aprovado. Revise e remova os concluídos com "codeorquestra worktree list".`,
      });
    }
    return {
      repository,
      policy,
      path: location.path,
      branch: contract.execution.worktree?.branch ?? `codeorquestra/${task.record.taskId.slice(0, 16)}`,
      baseRef: contract.execution.worktree?.baseRef ?? null,
      fleetReservationId,
    };
  }

  private releaseFleetReservation(plan: WorktreePlan | null): void {
    if (!plan) return;
    const reservations = this.fleetReservations.get(plan.repository.repoKey);
    reservations?.delete(plan.fleetReservationId);
    if (reservations?.size === 0) this.fleetReservations.delete(plan.repository.repoKey);
  }

  /**
   * Creates the run's worktree and makes it the effective workspace.
   *
   * The single substitution of `contract.workspace` is what carries the change
   * everywhere else: the spawn cwd, the worker descriptor, the action context's
   * containment checks, the inventory and the changed-file list all read it.
   */
  private async provisionWorktree(task: TaskState, run: RunState, plan: WorktreePlan): Promise<string> {
    let outcome;
    try {
      outcome = await withRepositoryMutex(plan.repository.repoKey, () => ensureWorktree({
        repository: plan.repository,
        target: plan.path,
        branch: plan.branch,
        baseRef: plan.baseRef,
      }));
    } catch (error) {
      const code = (error as { code?: string }).code ?? 'WORKTREE_ADD_FAILED';
      throw new HttpError(code === 'WORKTREE_DIRTY_FROM_PREVIOUS_RUN' ? 409 : 500, code, {
        message: (error as Error).message,
        ...((error as { detail?: string }).detail ? { detail: (error as { detail?: string }).detail } : {}),
      });
    }
    run.contract = { ...run.contract, workspace: outcome.path };
    // The record is what the panel and the ownership file report, so it names
    // the directory the CLI really runs in. The declared one is not lost: it
    // stays on the run and in run_started, for the audit trail.
    task.record.workspace = outcome.path;
    await this.append(task, run.runId, 'worktree_provisioned', {
      path: outcome.path,
      branch: outcome.branch,
      baseRef: outcome.baseRef,
      created: outcome.created,
      repoKey: plan.repository.repoKey,
      declaredWorkspace: run.declaredWorkspace,
      provisionedBy: 'broker',
      note: 'O Claude nunca cria worktrees; a política do repositório foi aprovada pelo usuário e o broker executou.',
    });
    return outcome.path;
  }

  private async releaseReservation(task: TaskState, run: RunState): Promise<void> {
    if (run.writerLockKey) {
      const lock = this.locks.get(run.writerLockKey);
      if (lock && lock.holderRunId === run.runId && !lock.quarantined) {
        this.locks.delete(run.writerLockKey);
        await fs.rm(path.join(this.locksDir(), `${run.writerLockKey}.json`), { force: true });
      }
      run.writerLockKey = null;
    }
    run.finalized = true;
    if (task.run === run) {
      task.run = null;
      task.phase = 'terminal';
    }
  }

  private async prepareAndSpawn(task: TaskState, run: RunState, launch: ReturnType<typeof resolveLaunchCustomizations>, approvedAgents: string[], approvedSkills: string[], harness: Record<string, unknown> | null): Promise<void> {
    const preparationDelayMs = typeof harness?.preparationDelayMs === 'number' ? Math.max(0, Math.min(5000, harness.preparationDelayMs)) : 0;
    if (preparationDelayMs) await new Promise<void>((resolve) => setTimeout(resolve, preparationDelayMs));
    if (this.stopping || task.run !== run || run.finalized) return;
    const failPreparation = typeof harness?.failPreparation === 'string' ? harness.failPreparation : null;
    const stage = async (name: string, fn: () => Promise<void>): Promise<boolean> => {
      if (failPreparation === name) {
        await this.append(task, run.runId, 'preparation_failed', { stage: name, code: 'HARNESS_SIMULATED_FAILURE', message: `Falha simulada pelo harness na etapa ${name}.` });
        await this.finalize(task, run, 'FAIL', 'HARNESS_SIMULATED_FAILURE', `Falha simulada na etapa ${name}.`, 1, name);
        return false;
      }
      try {
        await fn();
        return true;
      } catch (error) {
        const code = (error as { code?: string }).code ?? 'PREPARATION_FAILED';
        const failedStage = (error as { stage?: string }).stage ?? name;
        const message = redactSensitiveText(String((error as Error).message ?? error)).slice(0, 300);
        await this.append(task, run.runId, 'preparation_failed', { stage: failedStage, code, message });
        await this.finalize(task, run, 'FAIL', code, message, 1, failedStage);
        return false;
      }
    };
    let executable: Extract<ResolvedExecutable, { status: 'resolved' }> | null = null;
    let cliVersion: string | null = null;
    const preflightOk = await stage('cli-resolution', async () => {
      if (!this.launcherPath) throw Object.assign(new Error('Claude Code CLI não encontrado no PATH; nenhum CLI empacotado é usado como substituto.'), { code: 'CLI_NOT_FOUND' });
      if (failPreparation === 'cli-probe') throw Object.assign(new Error('Falha simulada pelo harness na sondagem do CLI.'), { code: 'CLI_PROBE_FAILED', stage: 'cli-probe' });
      // Only immutable CLI capability evidence is cached; the authentication
      // policy is reassessed for every job against the real spawn environment.
      const preflight: PreflightResult = await resolvePreflight({
        launcherPath: this.launcherPath,
        requestedModel: run.requestedModel as AuthorizedModel,
        runtimeVersion: engineInfo().runtimeVersion,
        allowApiBilling: run.contract.auth.allowApiBilling,
        env: process.env,
        probe: async (resolved) => {
          if (!this.probeCache) this.probeCache = await probeCli(resolved);
          return this.probeCache;
        },
      });
      if (preflight.status !== 'ready') throw Object.assign(new Error(preflight.message), { code: preflight.code, stage: preflight.failureStage });
      executable = preflight.executable;
      cliVersion = preflight.observed.cliVersion;
      await this.append(task, run.runId, 'preflight_ready', {
        cliVersion,
        executableKind: preflight.executable.kind,
        compatibility: preflight.diagnosis.status,
        modelSupport: preflight.diagnosis.modelSupport,
        notes: preflight.diagnosis.notes,
        auth: preflight.auth.code,
        authEvidence: preflight.auth.evidence,
        vendorCliUsed: false,
      });
    });
    if (!preflightOk) return;
    if (this.stopping || task.run !== run || run.finalized) return;
    const observation = await this.quota.observe(executable);
    if (this.stopping || task.run !== run || run.finalized) return;
    task.quota = this.quota.view(run.requestedModel as AuthorizedModel, observation);
    await this.append(task, run.runId, 'quota_observed', { attemptedAt: observation.attemptedAt, observedAt: observation.observedAt, snapshot: task.quota.snapshot, recommendation: task.quota.recommendation, alternate: task.quota.alternate, failure: observation.failure });
    const spawned = await stage('worker-spawn', async () => {
      const descriptor: WorkerDescriptor = {
        taskId: task.record.taskId,
        runId: run.runId,
        threadId: task.record.threadId,
        stateRoot: this.stateRoot,
        taskDir: task.dir,
        runDir: path.join(task.dir, 'runs', run.runId),
        contract: run.contract,
        prompt: run.prompt,
        resumeSessionId: run.sessionId,
        resumeMode: run.resumeMode,
        launch,
        approvedMcpTools: {},
        approvedAgents,
        approvedSkills,
        executable: { path: executable!.executablePath, runWith: executable!.runWith, cliVersion },
        harness: harness
          ? {
              ...(typeof harness.adapterPath === 'string' ? { adapterPath: harness.adapterPath } : {}),
              ...(failPreparation ? { failPreparation } : {}),
              ...(typeof harness.effortCap === 'string' ? { effortCap: harness.effortCap } : {}),
              ...(Array.isArray(harness.modelCatalog) ? { modelCatalog: harness.modelCatalog as string[] } : {}),
              ...(harness.hooksApplied === false ? { hooksApplied: false } : {}),
              ...(typeof harness.setModelDelayMs === 'number' ? { setModelDelayMs: harness.setModelDelayMs } : {}),
            }
          : null,
      };
      const descriptorFile = path.join(descriptor.runDir, 'worker-descriptor.json');
      await writeFileAtomic(descriptorFile, JSON.stringify(descriptor, null, 2));
      if (this.stopping || task.run !== run || run.finalized) return;
      const child = spawn(process.execPath, [...nodeExecArgv(), workerEntry(), '--descriptor', descriptorFile], {
        cwd: run.contract.workspace,
        env: { ...process.env, [envName('TASK_ID')]: task.record.taskId, [envName('RUN_ID')]: run.runId, [envName('RUN_TOKEN')]: run.runToken },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        serialization: 'json',
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
      task.worker = child;
      run.workerPid = child.pid ?? null;
      run.workerStartedAt = new Date().toISOString();
      const lock = run.writerLockKey ? this.locks.get(run.writerLockKey) : null;
      if (lock) {
        lock.holderPid = run.workerPid;
        await writeFileAtomic(path.join(this.locksDir(), `${run.writerLockKey}.json`), JSON.stringify(lock, null, 2));
      }
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => this.options.log(`worker ${run.workerPid} stderr: ${redactSensitiveText(chunk).trim().slice(0, 500)}`));
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', () => undefined);
      child.on('message', (message: WorkerToBroker) => this.enqueueTaskWork(task, () => this.onWorkerMessage(task, run, message)));
      child.on('exit', (code, signal) => this.enqueueTaskWork(task, () => this.onWorkerExit(task, run, code, signal)));
      // Ownership is recorded BEFORE any prompt is released. If this throws,
      // the stage fails the launch and the spawned tree is reconciled, so work
      // never starts against a state a restarted broker could not recover.
      await this.writeCurrentRun(task, { runId: run.runId, runToken: run.runToken, status: 'RUNNING', workerPid: run.workerPid, workerStartedAt: run.workerStartedAt, startedAt: run.startedAt, workspace: run.contract.workspace, writerLockKey: run.writerLockKey, runDir: descriptor.runDir });
      run.ownershipRecorded = true;
      await this.append(task, run.runId, 'worker_spawned', { workerPid: run.workerPid });
    });
    if (!spawned) return;
    if (this.stopping || task.run !== run || run.finalized) return;
    await this.releaseInitialPrompt(task, run);
    this.changed(task);
  }

  /**
   * Hands the job prompt to the worker exactly once, and only after BOTH the
   * worker announced itself and the authoritative ownership record was written.
   * Whichever happens last triggers it, so no work is ever released against a
   * state a restarted broker could not recognise.
   */
  private async releaseInitialPrompt(task: TaskState, run: RunState): Promise<void> {
    if (this.stopping || task.run !== run || run.finalized || run.initialPromptDelivered) return;
    if (!task.workerReady || !run.ownershipRecorded) return;
    run.initialPromptDelivered = true;
    task.phase = 'busy_model';
    this.sendToWorker(task, { t: 'deliver', messageId: `msg-initial-${run.runId}`, text: run.prompt, source: 'system' });
    await this.append(task, run.runId, 'message_delivered', { messageId: `msg-initial-${run.runId}`, source: 'system', initial: true });
  }

  /** Serializes per-task transitions so stale callbacks cannot race a new run. */
  private enqueueTaskWork(task: TaskState, work: () => Promise<void>): void {
    const next = task.chain.then(work, work);
    task.chain = next.catch(() => undefined);
  }

  private async onWorkerMessage(task: TaskState, run: RunState, message: WorkerToBroker): Promise<void> {
    if (task.run !== run || run.finalized) return;
    switch (message.t) {
      case 'ready': {
        task.workerReady = true;
        run.simulated = message.simulated;
        run.status = 'RUNNING';
        await this.releaseInitialPrompt(task, run);
        this.changed(task);
        break;
      }
      case 'event': {
        const event = await this.append(task, run.runId, message.type, message.data, message.toolUseId);
        if (task.claudeUsage.addEvent(event)) void this.persistUsage(task);
        if (TURN_TERMINAL_EVENTS.has(message.type)) {
          // No dedup needed here: each worker event passes this point once.
          // The accumulator above keeps its own, for replays. Exhaustion is
          // observed at turn_done, which always follows, so the recorded
          // numbers count this turn as finished rather than half-finished.
          const usage = normalizeClaudeUsage(message.data.usage);
          if (usage) {
            run.tokensObserved += usage.totalObservedTokens;
            // Input + cache read + cache creation is the prompt that was sent,
            // which is what the context held when this turn ran.
            run.lastTurnContextTokens = usage.totalInputTokens;
          }
        }
        this.applyEvent(task, run, message.type, message.data, message.toolUseId);
        // Only completed calls change the shape of the history, so the
        // detector runs exactly where a call closes.
        if (message.type === 'tool_result' || message.type === 'tool_blocked') await this.observeThrashing(task, run);
        if (message.type === 'permission_requested' || message.type === 'question_asked') this.changed(task);
        break;
      }
      case 'phase': {
        // The broker owns the terminal transition so locks and derived files
        // are settled before anyone observes "terminal".
        if (message.phase === 'terminal') break;
        task.phase = message.phase;
        task.currentTool = message.currentTool;
        task.lastActivityAt = Date.now();
        this.changed(task);
        break;
      }
      case 'transient':
        this.options.onTransient(message.frame);
        break;
      case 'request':
        task.pending.set(message.request.requestId, message.request);
        this.changed(task);
        break;
      case 'blob':
        await fs.mkdir(path.join(task.dir, 'blobs'), { recursive: true });
        await writeFileAtomic(path.join(task.dir, 'blobs', `${message.blobId}.json`), JSON.stringify({ blobId: message.blobId, truncated: message.truncated, totalChars: message.totalChars, text: message.text }));
        break;
      case 'model_result': {
        task.modelTransition?.settle({ ok: message.ok, activeModel: message.activeModel, code: message.code });
        break;
      }
      case 'model_uncertain': {
        // The worker could not establish which model the CLI is running.
        task.uncertain = true;
        task.record.requiresReview = true;
        task.record.reviewReason = 'O worker não confirmou qual modelo está em vigor no CLI.';
        await this.persistRecord(task);
        this.changed(task);
        break;
      }
      case 'turn_done': {
        run.turns += 1;
        task.phase = 'idle';
        task.currentTool = null;
        await this.observeBudget(task, run);
        await this.observeBetweenTurns(task, run);
        // An end that waited for this turn happens here, with the worker idle,
        // so the session closes COMPLETED instead of being cancelled mid-turn.
        if (run.endAfterTurn) {
          const requested = run.endAfterTurn;
          run.endAfterTurn = null;
          await this.end(task, requested.source);
          this.changed(task);
          break;
        }
        await this.deliverNext(task);
        this.changed(task);
        void this.refreshUsage(task);
        break;
      }
      case 'preparation_failed': {
        await this.append(task, run.runId, 'preparation_failed', { stage: message.stage, code: message.code, message: message.message });
        await this.finalize(task, run, 'FAIL', message.code, message.message, 1, message.stage);
        break;
      }
      case 'run_ended':
        await this.finalize(task, run, message.status, message.code, message.message, message.exitCode, null);
        break;
      default:
        break;
    }
  }

  private applyEvent(task: TaskState, run: RunState, type: string, data: Record<string, unknown>, toolUseId?: string): void {
    switch (type) {
      case 'session_init':
        if (typeof data.sessionId === 'string') {
          run.sessionId = data.sessionId;
          run.sessionConfirmed = true;
        }
        if (typeof data.observedModel === 'string') run.observedModel = data.observedModel;
        if (typeof data.effortObservedByCli === 'string') run.effortObservedByCli = data.effortObservedByCli;
        break;
      case 'assistant_text':
        if (typeof data.model === 'string') run.observedModel = data.model;
        break;
      case 'tool_start': {
        if (typeof data.name === 'string') {
          run.tools.calls += 1;
          toolUsage(run, data.name).calls += 1;
          if (toolUseId) run.tools.open.set(toolUseId, { name: data.name, at: Date.now() });
        }
        if (toolUseId && typeof data.name === 'string') {
          run.toolTrail.push({
            toolUseId,
            sig: `${data.name}:${typeof data.inputHash === 'string' ? data.inputHash : ''}`,
            name: data.name,
            inputPreview: typeof data.inputPreview === 'string' ? data.inputPreview : '',
            error: null,
          });
          if (run.toolTrail.length > TRAIL_LIMIT) run.toolTrail.splice(0, run.toolTrail.length - TRAIL_LIMIT);
        }
        if (toolUseId && typeof data.name === 'string' && ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(data.name) && typeof data.inputPreview === 'string') {
          const match = /"(?:file_path|notebook_path)":"((?:[^"\\]|\\.)*)"/.exec(data.inputPreview);
          if (match) run.claudeAuthored.add(match[1]!.replace(/\\\\/g, '\\'));
        }
        break;
      }
      case 'tool_result':
      case 'tool_blocked': {
        // A blocked call never ran, which for a loop is the same evidence as a
        // failure: the agent keeps asking for something it cannot have.
        const entry = toolUseId ? run.toolTrail.find((item) => item.toolUseId === toolUseId) : undefined;
        const failed = type === 'tool_blocked' || data.isError === true;
        if (entry) entry.error = failed;
        // Counted once per call, and only for a call we saw start: a blocked
        // call is echoed back by the CLI as a failed result too, and one call
        // is one call however many ways it is reported.
        const open = toolUseId ? run.tools.open.get(toolUseId) : undefined;
        if (open && toolUseId) {
          run.tools.open.delete(toolUseId);
          const usage = toolUsage(run, open.name);
          if (type === 'tool_blocked') {
            run.tools.blocked += 1;
            usage.blocked += 1;
          } else if (failed) {
            run.tools.errors += 1;
            usage.errors += 1;
          }
          const ms = Math.max(0, Date.now() - open.at);
          usage.totalMs += ms;
          run.tools.recent.push({ name: open.name, ok: !failed, ms, at: new Date().toISOString() });
          if (run.tools.recent.length > RECENT_TOOL_CALLS) run.tools.recent.splice(0, run.tools.recent.length - RECENT_TOOL_CALLS);
        }
        break;
      }
      case 'policy_changed':
        if (typeof data.escalate === 'string' && TURN_POLICY_LEVELS.includes(data.escalate as TurnPolicyLevel)) {
          run.policy = data.escalate === 'none'
            ? null
            : { escalate: data.escalate as TurnPolicyLevel, reason: typeof data.reason === 'string' ? data.reason : '', since: new Date().toISOString() };
        }
        break;
      case 'turn_completed':
      case 'turn_interrupted':
      case 'turn_failed':
        if (typeof data.model === 'string') run.observedModel = data.model;
        break;
      case 'model_changed':
        if (typeof data.to === 'string') run.requestedModel = data.to;
        if (typeof data.reason === 'string') run.modelReason = data.reason;
        break;
      case 'permission_resolved':
      case 'question_answered':
        if (typeof data.requestId === 'string') {
          task.pending.delete(data.requestId);
          task.resolvedRequests.add(data.requestId);
        }
        break;
      default:
        break;
    }
  }

  private async observeBetweenTurns(task: TaskState, run: RunState): Promise<void> {
    const last = this.quota.lastObservation;
    const stale = !last || Date.now() - Date.parse(last.attemptedAt) > 5 * 60_000;
    if (!stale) {
      task.quota = this.quota.view(run.requestedModel as AuthorizedModel);
      return;
    }
    const executable = await this.resolveExecutableForQuota();
    const observation = await this.quota.observe(executable);
    task.quota = this.quota.view(run.requestedModel as AuthorizedModel, observation);
    if (task.run === run && !run.finalized) {
      await this.append(task, run.runId, 'quota_observed', { attemptedAt: observation.attemptedAt, observedAt: observation.observedAt, snapshot: task.quota.snapshot, recommendation: task.quota.recommendation, alternate: task.quota.alternate, failure: observation.failure, betweenTurns: true });
    }
  }

  private async resolveExecutableForQuota(): Promise<Extract<ResolvedExecutable, { status: 'resolved' }> | null> {
    if (!this.launcherPath) return null;
    const { resolveClaudeExecutable } = await import('../preflight/cli-resolver.ts');
    const resolved = await resolveClaudeExecutable({ launcherPath: this.launcherPath });
    return resolved.status === 'resolved' ? resolved : null;
  }

  private async onWorkerExit(task: TaskState, run: RunState, code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    if (task.run !== run || run.finalized || run.finalizing || this.stopping) return;
    // The worker vanished without a terminal message. The whole public view
    // moves to uncertain in one synchronous step: reconciliation below can take
    // seconds, and during that window the task must never be readable as
    // "disconnected" while its run still claims to be RUNNING.
    task.disconnected = true;
    task.record.requiresReview = true;
    task.record.reviewReason = 'O worker desapareceu sem resultado; a execução ficou incerta.';
    task.worker = null;
    run.status = 'UNCERTAIN';
    run.endedAt = new Date().toISOString();
    task.phase = 'terminal';
    for (const [requestId] of task.pending) task.resolvedRequests.add(requestId);
    task.pending.clear();
    this.changed(task);
    const runDir = path.join(task.dir, 'runs', run.runId);
    const reconciliation = await reconcileRunProcesses(runDir, run.workerPid, true);
    await this.append(task, run.runId, 'worker_disconnected', {
      workerPid: run.workerPid,
      exitCode: code,
      signal,
      reconciledBy: 'process-identity',
      descendantsClean: reconciliation.clean,
      survivingPids: reconciliation.survivingPids,
      note: reconciliation.note,
    });
    await this.persistRecord(task);
    await this.settleLock(task, run, reconciliation.clean, reconciliation.note);
    await this.writeCurrentRunBestEffort(task, { runId: run.runId, runToken: run.runToken, status: 'UNCERTAIN', workerPid: null, workerStartedAt: run.workerStartedAt, startedAt: run.startedAt, workspace: run.contract.workspace, writerLockKey: null, runDir });
    await this.writeDerivedNow(task, run.runId, true);
    run.finalized = true;
    this.changed(task);
  }

  /**
   * Settles a run. The terminal state is published only after the worker tree
   * is reconciled, the writer lock released or quarantined, and the session
   * pointer and derived files written.
   */
  private async finalize(task: TaskState, run: RunState, status: 'COMPLETED' | 'FAIL' | 'CANCELLED', code: string | null, message: string | null, exitCode: number, failureStage: string | null): Promise<void> {
    if (task.run !== run || run.finalized || run.finalizing) return;
    run.finalizing = true;
    const endedAt = new Date().toISOString();
    run.failureCode = code;
    run.failureStage = failureStage;
    if (task.endTimer) clearTimeout(task.endTimer);
    task.endTimer = null;
    task.currentTool = null;
    for (const [requestId] of task.pending) task.resolvedRequests.add(requestId);
    task.pending.clear();
    const runDir = path.join(task.dir, 'runs', run.runId);
    try {
      if (task.worker?.pid) {
        const pid = task.worker.pid;
        try { task.worker.send({ t: 'exit' } satisfies BrokerToWorker); } catch { /* ignore */ }
        await waitForExit(pid, 500);
      }
      const reconciliation = await reconcileRunProcesses(runDir, run.workerPid, exitCode !== 0);
      task.worker = null;
      task.workerReady = false;
      await this.settleLock(task, run, reconciliation.clean, reconciliation.note);
      if (!reconciliation.clean) {
        task.record.requiresReview = true;
        task.record.reviewReason = reconciliation.note;
        await this.persistRecord(task);
        await this.append(task, run.runId, 'descendants_not_reconciled', { survivingPids: reconciliation.survivingPids, note: reconciliation.note });
      }
      if (run.sessionId && run.sessionConfirmed) {
        task.previousSessionId = run.sessionId;
        task.previousSessionFingerprint = run.resumeFingerprint;
        await writeFileAtomic(path.join(task.dir, 'session.json'), JSON.stringify({ sessionId: run.sessionId, resumeFingerprint: task.previousSessionFingerprint, runId: run.runId, updatedAt: endedAt, resultFile: path.join(runDir, 'resultado.json') }, null, 2));
      }
      await this.writeCurrentRunBestEffort(task, { runId: run.runId, runToken: run.runToken, status, workerPid: null, workerStartedAt: run.workerStartedAt, startedAt: run.startedAt, workspace: run.contract.workspace, writerLockKey: null, runDir });
      // Produce compatibility artefacts from a private terminal projection.
      // Only after all cleanup and durable state succeeded is run_ended appended
      // and broadcast to public readers.
      await this.writeDerivedNow(task, run.runId, true, { status, code, message, exitCode, endedAt, failureStage });
      if (run.harnessFinalizationFailure === 'before-public-event') throw Object.assign(new Error('Falha simulada antes do evento terminal público.'), { code: 'HARNESS_FINALIZATION_FAILURE' });
      await this.append(task, run.runId, 'run_ended', { status, code, message, exitCode, endedAt, failureStage });
      run.status = status;
      run.endedAt = endedAt;
      run.finalized = true;
      task.phase = 'terminal';
      this.changed(task);
      this.options.log(`task ${task.record.taskId} run ${run.runId} ended ${status}${code ? ` (${code})` : ''}`);
    } catch (error) {
      const detail = redactSensitiveText(String((error as Error).message ?? error)).slice(0, 300);
      task.record.requiresReview = true;
      task.record.reviewReason = `A finalização falhou e exige revisão: ${detail}`;
      await this.persistRecord(task).catch(() => undefined);
      try {
        if (task.worker?.pid) await terminateTree(task.worker.pid);
        const reconciliation = await reconcileRunProcesses(runDir, run.workerPid, true);
        await this.settleLock(task, run, false, `A finalização falhou; ${reconciliation.note}`);
      } catch { /* quarantine remains on disk/in memory */ }
      task.worker = null;
      task.workerReady = false;
      run.status = 'UNCERTAIN';
      run.endedAt = new Date().toISOString();
      run.finalized = true;
      task.uncertain = true;
      task.phase = 'terminal';
      await this.append(task, run.runId, 'finalization_failed', { code: (error as { code?: string }).code ?? 'FINALIZATION_FAILED', message: detail }).catch(() => undefined);
      await this.writeCurrentRunBestEffort(task, { runId: run.runId, runToken: run.runToken, status: 'UNCERTAIN', workerPid: null, workerStartedAt: run.workerStartedAt, startedAt: run.startedAt, workspace: run.contract.workspace, writerLockKey: run.writerLockKey, runDir });
      // Replace any private terminal projection that may already have been
      // written before the failing public append. Without run_ended in the log,
      // derivation records this run as uncertain.
      await this.writeDerivedNow(task, run.runId, true, {
        status: 'UNCERTAIN',
        code: (error as { code?: string }).code ?? 'FINALIZATION_FAILED',
        message: detail,
        exitCode: 1,
        endedAt: run.endedAt,
        failureStage: 'finalization',
      }).catch(() => undefined);
      this.changed(task);
      this.options.log(`task ${task.record.taskId} run ${run.runId}: finalização falhou (${detail})`);
    }
    run.finalizing = false;
  }

  private async settleLock(task: TaskState, run: RunState, clean: boolean, note: string): Promise<void> {
    if (!run.writerLockKey) return;
    const key = run.writerLockKey;
    const holder = this.locks.get(key);
    if (!holder || holder.holderRunId !== run.runId) {
      run.writerLockKey = null;
      return;
    }
    if (clean) {
      this.locks.delete(key);
      await fs.rm(path.join(this.locksDir(), `${key}.json`), { force: true });
      // Only a clean release may touch the worktree. A quarantined lock means a
      // process of this run may still be able to write there, so the directory
      // stays until the audited release path says otherwise.
      if (run.worktree) await this.settleWorktree(task, run, run.worktree);
    } else {
      holder.quarantined = true;
      holder.quarantineNote = note;
      await writeFileAtomic(path.join(this.locksDir(), `${key}.json`), JSON.stringify(holder, null, 2));
      if (run.worktree) {
        await this.append(task, run.runId, 'worktree_retained', {
          path: run.worktree.path,
          reason: 'quarantine',
          note: 'A trava do worktree ficou em quarentena; o diretório é preservado e não será reutilizado até a liberação explícita.',
        });
      }
    }
    run.writerLockKey = null;
  }

  /**
   * Decides what happens to a worktree once its run released the lock cleanly.
   *
   * Uncommitted work is NEVER deleted. `commit` can never belong to Claude, so
   * the normal end state of a successful run is exactly that: work sitting in
   * the tree, waiting for the coordinator. Deleting it would destroy the
   * deliverable, so a dirty tree is retained and reported, and only a tree git
   * itself agrees is clean is removed.
   */
  private async settleWorktree(task: TaskState, run: RunState, plan: WorktreePlan): Promise<void> {
    const dirty = await gitStatus(plan.path);
    if (dirty.length > 0) {
      await this.append(task, run.runId, 'worktree_retained', {
        path: plan.path,
        branch: plan.branch,
        reason: 'uncommitted_work',
        files: dirty.slice(0, 50),
        note: 'Trabalho não commitado preservado: commit nunca pertence ao Claude, então este é o estado normal de uma execução bem-sucedida. Commite a partir deste caminho ou remova o worktree explicitamente.',
      });
      return;
    }
    const removal = await withRepositoryMutex(plan.repository.repoKey, () => removeWorktree(plan.repository, plan.path));
    await this.append(task, run.runId, removal.removed ? 'worktree_removed' : 'worktree_retained', {
      path: plan.path,
      branch: plan.branch,
      ...(removal.removed ? {} : { reason: 'git_refused', detail: removal.reason ?? null }),
    });
  }

  /**
   * Writes the authoritative ownership record of the task.
   *
   * This file is not observability: it is what a restarted broker reads to
   * learn that a run was in flight, which PID owned it and which checkout it
   * held. If it cannot be written, a crash would leave the run invisible and
   * the checkout apparently free, so the caller must fail the launch rather
   * than release work against an unrecorded state.
   */
  private async writeCurrentRun(task: TaskState, value: CurrentRunFile): Promise<void> {
    await writeFileAtomic(path.join(task.dir, 'current-run.json'), JSON.stringify(value, null, 2), { maxWaitMs: 3000 });
  }

  /** Same record, on paths that are already finishing and cannot abort. */
  private async writeCurrentRunBestEffort(task: TaskState, value: CurrentRunFile): Promise<void> {
    try {
      await this.writeCurrentRun(task, value);
    } catch (error) {
      const code = (error as { code?: string }).code ?? 'ERRO';
      this.options.log(`task ${task.record.taskId}: current-run.json não gravado (${code})`);
      await this.append(task, value.runId, 'ownership_record_failed', {
        file: 'current-run.json',
        code,
        note: 'O estado autoritativo desta execução não pôde ser gravado; após um reinício do broker ela pode não ser reconhecida. Revise antes de retomar.',
      }).catch(() => undefined);
      task.record.requiresReview = true;
      task.record.reviewReason = 'O registro autoritativo da execução falhou; o estado no disco pode estar incompleto.';
      await this.persistRecord(task).catch(() => undefined);
    }
  }

  // --------------------------------------------------------- derived files

  private async reportTelemetryFailure(task: TaskState, run: RunState, file: string, code: string): Promise<void> {
    const now = Date.now();
    if (now - task.lastTelemetryEventAt < 10_000) return;
    task.lastTelemetryEventAt = now;
    await this.append(task, run.runId, 'telemetry_write_failed', { file, code, note: 'Falha de observabilidade; a execução continua.' });
  }

  private async flushDerived(): Promise<void> {
    for (const task of this.tasks.values()) {
      if (!task.derivedDirty || !task.run || !task.writer) continue;
      task.derivedDirty = false;
      await this.writeDerivedNow(task, task.run.runId, false);
    }
  }

  private async writeDerivedNow(task: TaskState, runId: string, final: boolean, terminal?: { status: 'COMPLETED' | 'FAIL' | 'CANCELLED' | 'UNCERTAIN'; code: string | null; message: string | null; exitCode: number; endedAt: string; failureStage: string | null }): Promise<void> {
    const runDir = path.join(task.dir, 'runs', runId);
    const writer = task.writer && task.writer.directory === runDir
      ? task.writer
      : new StateWriter({ directory: runDir, telemetryMaxWaitMs: 1500, finalMaxWaitMs: 15000, onTelemetryFailure: (failure) => { if (task.run) { task.run.telemetryFailures += 1; void this.reportTelemetryFailure(task, task.run, failure.file, failure.code); } } });
    // Reading the whole log here ran once per second per active run, so its
    // cost grew with the number of events the run had produced. The cache makes
    // the common path O(1); memory is bounded to one run's events, which this
    // function already materialized on every call anyway.
    const cached = task.derivedCache?.runId === runId ? task.derivedCache.events : null;
    const events = cached ? [...cached] : (await task.log.readFrom(0)).filter((event) => event.runId === runId);
    if (terminal) events.push({ seq: (events.at(-1)?.seq ?? 0) + 1, ts: terminal.endedAt, type: 'run_ended', taskId: task.record.taskId, runId, threadId: task.record.threadId, data: terminal });
    const derived = deriveCompatibilityFiles(events, { processAlive: Boolean(task.worker) });
    const llmUsage = this.usageView(task);
    const status = { ...derived.status, llmUsage, telemetryFailures: task.run?.telemetryFailures ?? derived.status.telemetryFailures, requiresReview: derived.status.requiresReview || task.record.requiresReview };
    await writer.writeStatus(status);
    try {
      await writeFileAtomic(path.join(runDir, 'acompanhamento.txt'), derived.acompanhamento, { maxWaitMs: 1500 });
    } catch {
      // acompanhamento is telemetry as well
    }
    if (final) {
      try {
        const outcome = await writer.writeFinalResult({ ...derived.result, llmUsage, telemetryFailures: status.telemetryFailures });
        if (outcome.fallback) await this.append(task, runId, 'final_result_fallback', { path: outcome.path });
      } catch (error) {
        await this.append(task, runId, 'final_result_not_persisted', { code: (error as { code?: string }).code ?? 'FINAL_RESULT_NOT_PERSISTED', message: redactSensitiveText((error as Error).message).slice(0, 300) }).catch(() => undefined);
        this.options.log(`task ${task.record.taskId}: resultado final NÃO persistido (${(error as { code?: string }).code ?? 'erro'})`);
        throw error;
      }
      if (task.derivedCache?.runId === runId) task.derivedCache = null;
    }
  }

  // ------------------------------------------------------------ supervision

  private superviseAll(): void {
    for (const task of this.tasks.values()) {
      // Per task, because supervision runs on a timer over every task at once:
      // without this, one task that throws stops the tick and silently blinds
      // supervision for every other task in the broker — the failure mode being
      // exactly the silence these alerts exist to break.
      try {
        this.superviseTask(task);
      } catch (error) {
        this.options.log(`supervisão falhou para ${task.record.taskId}: ${(error as Error).name}`);
      }
    }
  }

  private superviseTask(task: TaskState): void {
    {
      const run = task.run;
      if (!run || run.finalized) return;
      const budget = budgetStatus(run, Date.now());
      const evaluation = evaluateSupervision({
        now: Date.now(),
        runStartedAt: Date.parse(run.startedAt),
        lastActivityAt: task.lastActivityAt,
        oldestPendingRequestAt: oldestPendingAt(task),
        budgetRatio: budget?.ratio ?? null,
        thrashing: run.thrashing !== null,
        contextRatio: contextStatus(run)?.ratio ?? null,
        phase: task.phase,
        processAlive: Boolean(task.worker && task.worker.pid && isAlive(task.worker.pid)),
        coordinatorLastSeenAt: task.coordinatorLastSeenAt,
        pendingRequests: task.pending.size,
        brokerRestartedDuringRun: task.uncertain,
        terminal: run.finalized,
        thresholds: this.thresholds,
      });
      for (const alert of evaluation.alerts) {
        // `decision_pending` repeats while it is still true, because the whole
        // point is that nobody has answered yet: raising it once and going
        // quiet again would reproduce the silence it exists to break. Every
        // other alert stays one-shot.
        if (alert === 'decision_pending') {
          const now = Date.now();
          const period = (this.options.supervision ?? SUPERVISION).decisionPendingMs;
          if (task.lastDecisionAlertAt !== null && now - task.lastDecisionAlertAt < period) continue;
          task.lastDecisionAlertAt = now;
          task.alertsRaised.add(alert);
          const oldest = oldestPendingAt(task);
          void this.append(task, run.runId, 'alert', {
            alert,
            action: 'none',
            pendingRequests: task.pending.size,
            waitingForSeconds: oldest === null ? null : Math.round((now - oldest) / 1000),
            note: 'Uma decisão pendente bloqueia o turno. Esperar não é ociosidade, mas também não é progresso: nada avança até alguém responder.',
          }).then(() => this.changed(task));
          continue;
        }
        if (alert === 'budget_exhausted') {
          // Runtime runs out between turns, with no event to notice it on;
          // the same idempotent path the turn handlers use records it.
          void this.observeBudget(task, run);
          continue;
        }
        if (task.alertsRaised.has(alert)) continue;
        task.alertsRaised.add(alert);
        const data = alert === 'budget_warning' && budget
          ? { alert, action: 'none', ...budget, note: 'Orçamento da execução acima de 80%. Nada é encerrado; ao esgotar, o próximo turno é recusado.' }
          : { alert, action: 'none', note: 'Alerta de supervisão; nenhum encerramento automático.' };
        void this.append(task, run.runId, 'alert', data).then(() => this.changed(task));
      }
      // Answered: the alert stops being true, so it stops being reported and
      // may fire again cleanly for the next decision.
      if (task.pending.size === 0 && task.lastDecisionAlertAt !== null) {
        task.lastDecisionAlertAt = null;
        task.alertsRaised.delete('decision_pending');
      }
    }
  }

  /**
   * Names exhaustion once, the moment it becomes true, in the durable log.
   *
   * The refusal itself lives in deliverNext and enqueueMessage and needs no
   * event to work. This is what makes it visible — to the panel, the feed and
   * a coordinator reading the log later — instead of looking like a run that
   * quietly stopped taking messages. Idempotent per run through alertsRaised,
   * which startRun clears.
   */
  private async observeBudget(task: TaskState, run: RunState): Promise<void> {
    const budget = budgetStatus(run, Date.now());
    if (!budget?.exhausted || task.alertsRaised.has('budget_exhausted')) return;
    task.alertsRaised.add('budget_exhausted');
    await this.append(task, run.runId, 'budget_exhausted', { ...budget, note: BUDGET_EXHAUSTED_NOTE });
    this.changed(task);
  }

  /**
   * Names a loop once, with the evidence, and does nothing else.
   *
   * Nothing is throttled, denied or stopped here: an agent repeating itself
   * may be stuck or may be converging, and only the coordinator can tell. What
   * the runtime owes is that the shape is not invisible — the alert carries
   * the tool, the input and the count so the next decision is an informed one.
   */
  private async observeThrashing(task: TaskState, run: RunState): Promise<void> {
    const verdict = detectThrashing(run.toolTrail);
    if (!verdict) return;
    const { sig, ...report } = verdict;
    const key = `${verdict.pattern}:${sig}`;
    if (run.thrashingSeen.has(key)) return;
    run.thrashingSeen.add(key);
    run.thrashing = { ...report, at: new Date().toISOString() };
    // Added before the append so the supervision tick, which reports the same
    // alert, does not also write a second, vaguer event for it.
    task.alertsRaised.add('thrashing');
    await this.append(task, run.runId, 'alert', { alert: 'thrashing', action: 'none', ...report, note: THRASHING_NOTE });
    this.changed(task);
  }

  /**
   * Adds permission checks to a run that is already going.
   *
   * Between watching a loop and ending the session there has to be something
   * that keeps the work alive, and this is it. It only ever asks for more
   * decisions, so it applies immediately — mid-turn included, which is when a
   * loop is actually running. The view reports the restriction only once the
   * worker confirms it: a safety claim nobody applied is worse than none.
   */
  async setPolicy(task: TaskState, escalate: unknown, reason: unknown, source: ActionSource): Promise<{ requested: TurnPolicyLevel; applied: 'on_confirmation'; inForce: TurnPolicyLevel }> {
    if (typeof escalate !== 'string' || !TURN_POLICY_LEVELS.includes(escalate as TurnPolicyLevel)) {
      throw new HttpError(400, 'POLICY_INVALID', { message: `escalate deve ser ${TURN_POLICY_LEVELS.join(', ')}.` });
    }
    if (typeof reason !== 'string' || !reason.trim()) {
      throw new HttpError(400, 'POLICY_REASON_REQUIRED', { message: 'Informe por que a restrição está sendo aplicada; o motivo fica registrado.' });
    }
    if (!task.run || !task.worker || task.run.finalized || task.run.finalizing) throw new HttpError(409, 'NO_ACTIVE_RUN');
    this.sendToWorker(task, { t: 'set_policy', escalate: escalate as TurnPolicyLevel, reason: reason.trim(), source });
    if (source !== 'browser') this.touchCoordinator(task);
    return { requested: escalate as TurnPolicyLevel, applied: 'on_confirmation', inForce: task.run.policy?.escalate ?? 'none' };
  }

  // ------------------------------------------------------------------ views

  usageView(task: TaskState): TaskView['usage'] {
    return { claude: task.claudeUsage.snapshot(), codex: task.codexUsage };
  }

  async refreshUsage(task: TaskState, force = false): Promise<CodexUsageView> {
    if (task.usageRefresh) return task.usageRefresh;
    if (this.stopping) return task.codexUsage;
    const pending = (async () => {
      const snapshot = await this.codexUsage.refresh(task.record.threadId, { force });
      if (this.stopping) return snapshot;
      task.codexUsage = snapshot;
      await this.append(task, task.run?.runId ?? 'none', 'codex_usage_observed', { snapshot });
      this.changed(task);
      if (task.run) await this.writeDerivedNow(task, task.run.runId, task.run.finalized);
      return snapshot;
    })().finally(() => { task.usageRefresh = null; });
    task.usageRefresh = pending;
    return pending;
  }

  refreshAllUsage(): void {
    for (const task of this.tasks.values()) void this.refreshUsage(task);
  }

  async changedFiles(task: TaskState): Promise<{ observed: string[]; claudeAuthored: string[]; observedAt: string | null }> {
    const workspace = task.record.workspace;
    if (!workspace) return { observed: [], claudeAuthored: [], observedAt: null };
    const cached = task.changedFilesCache;
    let observed: string[] = cached?.observed ?? [];
    if (!cached || Date.now() - cached.at > 5000) {
      observed = await gitStatus(workspace);
      task.changedFilesCache = { at: Date.now(), observed };
    }
    const authored = task.run ? [...task.run.claudeAuthored].map((file) => path.relative(workspace, file).replace(/\\/g, '/')) : [];
    return { observed, claudeAuthored: authored, observedAt: new Date(task.changedFilesCache?.at ?? Date.now()).toISOString() };
  }

  /**
   * What a coordinator polling for changes actually needs.
   *
   * The long-poll loop is the orchestrator's main loop, and its context is
   * finite. The full view carries up to 500 changed paths, the whole quota
   * block, every queue entry and an input preview per pending request — resent
   * on every poll whether or not any of it moved. Re-spending the coordinator's
   * context on unchanged data shortens the session it is trying to run.
   *
   * Counts replace lists where a count is what a decision turns on; the full
   * view stays one query parameter away.
   */
  summaryView(task: TaskState): Record<string, unknown> {
    const full = this.view(task);
    return {
      taskId: full.taskId,
      threadId: full.threadId,
      state: full.state,
      requiresReview: full.requiresReview,
      coordinatorPresence: full.coordinatorPresence,
      alerts: full.alerts,
      workspace: full.workspace,
      ...(full.worktree ? { worktree: { branch: full.worktree.branch, path: full.worktree.path } } : {}),
      currentRun: full.currentRun
        ? {
            runId: full.currentRun.runId,
            status: full.currentRun.status,
            requestedModel: full.currentRun.requestedModel,
            observedModel: full.currentRun.observedModel,
            currentTool: full.currentRun.currentTool,
            turns: full.currentRun.turns,
            startedAt: full.currentRun.startedAt,
            // A budget, a loop and a restriction are all things the
            // coordinator decides on, so they survive the trim.
            budget: full.currentRun.budget,
            thrashing: full.currentRun.thrashing,
            policy: full.currentRun.policy,
            endingAfterTurn: full.currentRun.endingAfterTurn,
            context: full.currentRun.context,
            // Counts only: the per-tool breakdown is for someone looking at a
            // screen, not for a coordinator's poll loop.
            tools: { calls: full.currentRun.tools.calls, errors: full.currentRun.tools.errors, blocked: full.currentRun.tools.blocked },
          }
        : null,
      // Kept in full: a pending decision is the thing the coordinator has to
      // act on, and trimming it would hide what it is deciding about.
      pendingRequests: full.pendingRequests,
      queuedMessages: full.queue.filter((entry) => entry.state === 'queued').length,
      changedFiles: { claudeAuthored: full.changedFiles.claudeAuthored, observedCount: full.changedFiles.observed.length },
    };
  }

  view(task: TaskState): TaskView {
    const run = task.run;
    const now = Date.now();
    const evaluation = evaluateSupervision({
      now,
      runStartedAt: run ? Date.parse(run.startedAt) : now,
      lastActivityAt: task.lastActivityAt,
      oldestPendingRequestAt: oldestPendingAt(task),
      budgetRatio: run ? (budgetStatus(run, now)?.ratio ?? null) : null,
      thrashing: run?.thrashing != null,
      contextRatio: run ? (contextStatus(run)?.ratio ?? null) : null,
      phase: run && run.finalizing && !run.finalized ? 'busy_model' : task.phase,
      processAlive: Boolean(task.worker && task.worker.pid && isAlive(task.worker.pid)) || Boolean(run && run.finalizing && !run.finalized),
      coordinatorLastSeenAt: task.coordinatorLastSeenAt,
      pendingRequests: task.pending.size,
      brokerRestartedDuringRun: task.uncertain,
      terminal: !run || run.finalized,
      thresholds: this.thresholds,
    });
    const state = task.uncertain ? 'uncertain' : task.disconnected ? 'disconnected' : evaluation.state;
    // Supervision can observe that the worker process is gone before the exit
    // callback has been processed. The view must stay self-consistent: a run
    // behind a disconnected or uncertain task is not RUNNING any more, it is
    // exactly what "uncertain" means. onWorkerExit writes the durable status.
    const runStatus: RunStatus | null = run
      ? ((state === 'disconnected' || state === 'uncertain') && (run.status === 'RUNNING' || run.status === 'STARTING') ? 'UNCERTAIN' : run.status)
      : null;
    return {
      taskId: task.record.taskId,
      threadId: task.record.threadId,
      workspace: task.record.workspace,
      state,
      simulated: run?.simulated ?? this.options.harness,
      alerts: [...task.alertsRaised],
      coordinatorPresence: evaluation.coordinatorPresence,
      coordinatorLastSeenAt: task.coordinatorLastSeenAt ? new Date(task.coordinatorLastSeenAt).toISOString() : null,
      coordinatorLabel: evaluation.coordinatorLabel,
      // Supervision can see the worker is gone before the exit callback runs;
      // its verdict counts immediately so the panel never shows a disconnected
      // task that claims no review is needed. onWorkerExit persists it.
      requiresReview: task.record.requiresReview || task.uncertain || task.disconnected || evaluation.requiresReview,
      currentRun: run ? {
        runId: run.runId,
        status: runStatus ?? run.status,
        sessionId: run.sessionId,
        requestedModel: run.requestedModel,
        modelReason: run.modelReason,
        observedModel: run.observedModel,
        effortConfigured: run.contract.effort,
        effortObservedByCli: run.effortObservedByCli,
        effortConfirmed: null,
        currentTool: task.currentTool,
        workerPid: run.workerPid,
        failureStage: run.failureStage,
        failureCode: run.failureCode,
        telemetryFailures: run.telemetryFailures,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        lastActivityAt: new Date(task.lastActivityAt).toISOString(),
        elapsedSeconds: Math.max(0, Math.round(((run.endedAt ? Date.parse(run.endedAt) : now) - Date.parse(run.startedAt)) / 1000)),
        turns: run.turns,
        profile: run.contract.profile,
        contractVersion: run.contract.version,
        resumeMode: run.resumeMode,
        budget: budgetStatus(run, now),
        thrashing: run.thrashing,
        policy: run.policy,
        endingAfterTurn: run.endAfterTurn !== null,
        context: contextStatus(run),
        tools: toolsView(run),
      } : null,
      previousSessionId: task.previousSessionId,
      pendingRequests: [...task.pending.values()],
      queue: task.queue.map((entry) => this.queueView(entry)),
      quota: task.quota ?? this.quota.view((run?.requestedModel as AuthorizedModel | undefined) ?? 'claude-fable-5-1'),
      usage: this.usageView(task),
      // Relative, like changedFiles() already returns. They disagreed before —
      // view() emitted absolute paths and only the single-task GET overwrote
      // them — which a fleet of worktrees would have made unreadable: two
      // absolute paths from two checkouts look nearly identical.
      changedFiles: {
        observed: task.changedFilesCache?.observed ?? [],
        claudeAuthored: run && task.record.workspace
          ? [...run.claudeAuthored].map((file) => path.relative(task.record.workspace as string, file).replace(/\\/g, '/')).filter((file) => file && !file.startsWith('..'))
          : [],
        observedAt: task.changedFilesCache ? new Date(task.changedFilesCache.at).toISOString() : null,
      },
      worktree: run?.worktree
        ? { path: run.worktree.path, branch: run.worktree.branch, baseRef: run.worktree.baseRef, repoKey: run.worktree.repository.repoKey, declaredWorkspace: run.declaredWorkspace }
        : null,
      reviewPending: true,
      createdAt: task.record.createdAt,
      updatedAt: task.updatedAt,
      lastEventSeq: task.log.lastSeq,
    };
  }

  views(scope: string | null): TaskView[] {
    return [...this.tasks.values()].filter((task) => !scope || task.record.taskId === scope).map((task) => this.view(task));
  }

  /**
   * The run history, with what each run cost.
   *
   * Read from each run's own status.json rather than from memory, so a run
   * from a previous broker answers the same questions as the one that just
   * ended. A file that cannot be read reports UNKNOWN and nulls instead of
   * zeros: "we do not know" and "it cost nothing" are different answers.
   */
  async runsOf(task: TaskState): Promise<RunHistoryEntry[]> {
    const dir = path.join(task.dir, 'runs');
    let entries: string[] = [];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return [];
    }
    const runs: RunHistoryEntry[] = [];
    for (const runId of entries.sort()) {
      const status = await readJsonShared<DerivedStatus>(path.join(dir, runId, 'status.json'));
      if (status.status === 'ok') {
        const value = status.value;
        const usage = value.claudeUsage;
        runs.push({
          runId,
          status: value.status ?? 'UNKNOWN',
          failureCode: value.failureCode ?? null,
          startedAt: value.startedAt ?? null,
          endedAt: value.endedAt ?? null,
          elapsedSeconds: typeof value.elapsedSeconds === 'number' ? value.elapsedSeconds : null,
          turns: typeof value.turns === 'number' ? value.turns : null,
          tokens: usage && typeof usage.totalObservedTokens === 'number' ? usage.totalObservedTokens : null,
          usageQuality: usage?.quality ?? 'unavailable',
          toolCalls: Array.isArray(value.toolCalls) ? value.toolCalls.length : null,
          toolErrors: typeof value.toolErrors === 'number' ? value.toolErrors : null,
          limits: value.limits ?? null,
          budgetExhausted: value.budgetExhausted === true,
        });
        continue;
      }
      runs.push({ runId, status: 'UNKNOWN', failureCode: null, startedAt: null, endedAt: null, elapsedSeconds: null, turns: null, tokens: null, usageQuality: 'unavailable', toolCalls: null, toolErrors: null, limits: null, budgetExhausted: false });
    }
    return runs;
  }

  async blobPage(task: TaskState, blobId: string, page: number): Promise<{ page: number; pages: number; text: string; truncated: boolean; totalChars: number } | null> {
    if (!/^blob-[a-f0-9-]{36}$/.test(blobId)) return null;
    const read = await readJsonShared<{ text: string; truncated: boolean; totalChars: number }>(path.join(task.dir, 'blobs', `${blobId}.json`));
    if (read.status !== 'ok') return null;
    const paged = previewPage(read.value.text, page);
    return { ...paged, truncated: read.value.truncated, totalChars: read.value.totalChars };
  }

  /**
   * Global replay for a reconnecting subscriber. `gapped` is true when older
   * events could not fit the page, so the client resets rather than assuming
   * continuity.
   */
  async replay(cursor: number, taskId: string | null, scope: string | null, limit = 2000): Promise<{ events: EventRecord[]; gapped: boolean }> {
    const collected: EventRecord[] = [];
    let gapped = false;
    for (const task of this.tasks.values()) {
      if (taskId && task.record.taskId !== taskId) continue;
      if (scope && task.record.taskId !== scope) continue;
      const page = await task.log.readPage(0, limit);
      // A gap is only real when the events the CLIENT still needs were the ones
      // dropped. A caught-up subscriber must not be told its history is broken
      // just because this task has more history than one page holds.
      const oldestAvailable = page.events[0]?.gseq ?? null;
      if (page.gapped && (oldestAvailable === null || oldestAvailable > cursor + 1)) gapped = true;
      for (const event of page.events) if ((event.gseq ?? 0) > cursor) collected.push(event);
    }
    collected.sort((a, b) => (a.gseq ?? 0) - (b.gseq ?? 0));
    if (collected.length > limit) {
      gapped = true;
      return { events: collected.slice(collected.length - limit), gapped };
    }
    return { events: collected, gapped };
  }
}

/** A plain object, for validating loosely typed request bodies. */
/** When the oldest unanswered request arrived, for the decision alert. */
const TURN_TERMINAL_EVENTS = new Set(['turn_completed', 'turn_interrupted', 'turn_failed']);

const THRASHING_NOTE = 'A execução repete a mesma chamada ou acumula falhas. Nada foi encerrado nem restringido: avalie e, se for o caso, restrinja as ações desta execução (codeorquestra_set_policy) ou encerre ao fim do turno (codeorquestra_end com afterTurn).';

const END_AFTER_TURN_NOTE = 'Encerramento pedido para quando o turno atual terminar. O turno não é interrompido e nenhuma orientação nova é entregue; a execução fecha como COMPLETED.';

const BUDGET_EXHAUSTED_NOTE = 'Orçamento da execução esgotado: o turno em andamento termina normalmente, mas nenhum outro é entregue. Para continuar, encerre esta execução e inicie outra com limits maior e approvalRevision maior; a mudança de revisão abre uma sessão nova.';

function contractResumeFingerprint(contract: JobContract): string {
  return sha256(JSON.stringify({
    workspace: canonicalizePlanned(contract.workspace),
    profile: contract.profile,
    model: contract.model.requested,
    effort: contract.effort,
    phase: contract.coordination.phase,
    scopeId: contract.coordination.scopeId,
    approvalRevision: contract.coordination.approvalRevision,
    planSummary: contract.coordination.planSummary,
    responsibilities: contract.coordination.responsibilities,
    scope: contract.scope,
    execution: contract.execution,
    auth: contract.auth,
  }));
}

/**
 * Pure: what the run spent against what the job allowed. Null when the job set
 * no limits at all, so "unlimited" and "0% used" never look alike. Tokens are
 * input + cache + output, the number a paying user calls "tokens".
 */
function budgetStatus(run: RunState, now: number): RunBudgetView | null {
  const { maxTokens, maxTurns, maxRuntimeSeconds } = run.contract.limits;
  if (maxTokens === null && maxTurns === null && maxRuntimeSeconds === null) return null;
  const elapsed = Math.max(0, Math.round(((run.endedAt ? Date.parse(run.endedAt) : now) - Date.parse(run.startedAt)) / 1000));
  const tokens = maxTokens === null ? null : { used: run.tokensObserved, limit: maxTokens };
  const turns = maxTurns === null ? null : { used: run.turns, limit: maxTurns };
  const runtimeSeconds = maxRuntimeSeconds === null ? null : { used: elapsed, limit: maxRuntimeSeconds };
  let ratio = 0;
  for (const dimension of [tokens, turns, runtimeSeconds]) {
    if (dimension) ratio = Math.max(ratio, dimension.used / dimension.limit);
  }
  return { tokens, turns, runtimeSeconds, ratio, exhausted: ratio >= 1 };
}

/** One finished (or unreadable) run, as the history reports it. */
export interface RunHistoryEntry {
  runId: string;
  status: string;
  failureCode: string | null;
  startedAt: string | null;
  endedAt: string | null;
  elapsedSeconds: number | null;
  turns: number | null;
  tokens: number | null;
  usageQuality: 'reported' | 'partial' | 'unavailable';
  toolCalls: number | null;
  toolErrors: number | null;
  limits: DerivedStatus['limits'];
  budgetExhausted: boolean;
}

/** The most recent calls kept for the panel; older ones live in the log. */
const RECENT_TOOL_CALLS = 8;

interface RunToolState {
  calls: number;
  errors: number;
  blocked: number;
  byTool: Map<string, { calls: number; errors: number; blocked: number; totalMs: number }>;
  /** Calls that started and have not reported back, so a duration can be taken. */
  open: Map<string, { name: string; at: number }>;
  recent: Array<{ name: string; ok: boolean | null; ms: number | null; at: string }>;
}

function toolUsage(run: RunState, name: string): { calls: number; errors: number; blocked: number; totalMs: number } {
  const existing = run.tools.byTool.get(name);
  if (existing) return existing;
  const created = { calls: 0, errors: 0, blocked: 0, totalMs: 0 };
  run.tools.byTool.set(name, created);
  return created;
}

function toolsView(run: RunState): RunToolsView {
  return {
    calls: run.tools.calls,
    errors: run.tools.errors,
    blocked: run.tools.blocked,
    byTool: [...run.tools.byTool.entries()]
      .map(([name, usage]) => ({ name, ...usage }))
      .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name)),
    recent: [...run.tools.recent],
  };
}

/**
 * Pure: how full the context was on the last finished turn.
 *
 * Null before the first turn reports usage, and null for a model whose window
 * this build does not know — an absent gauge is better than a made-up one.
 */
function contextStatus(run: RunState): RunContextView | null {
  const windowTokens = contextWindowFor(run.observedModel ?? run.requestedModel);
  if (windowTokens === null || run.lastTurnContextTokens === null) return null;
  return { lastTurnTokens: run.lastTurnContextTokens, windowTokens, ratio: run.lastTurnContextTokens / windowTokens };
}

function oldestPendingAt(task: TaskState): number | null {
  let oldest: number | null = null;
  for (const request of task.pending.values()) {
    const at = Date.parse(request.createdAt);
    if (Number.isNaN(at)) continue;
    if (oldest === null || at < oldest) oldest = at;
  }
  return oldest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeRecord(record: TaskRecord): TaskRecord {
  return {
    ...record,
    requiresReview: record.requiresReview === true,
    reviewReason: typeof record.reviewReason === 'string' ? record.reviewReason : null,
  };
}


export { isHarness };
