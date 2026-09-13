// Scoped process ownership and termination.
//
// Nothing here ever matches processes by name, and nothing is ever terminated
// because a PID happens to be alive: a PID is not an identity. Every recorded
// process carries the creation instant the OS reported for it, and a process is
// only terminated when that instant still matches. When ownership cannot be
// established the caller quarantines instead of killing, and a run whose
// processes disappeared without a recorded clean exit is NOT reported clean —
// its descendants may have been orphaned where no API can enumerate them.
import { spawn } from 'node:child_process';
import { closeSync, openSync, statSync, unlinkSync, utimesSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { collectDescendants, listProcessTable, readProcessCreationIdentity, verifyProcessIdentity, type IdentityVerdict } from './process-identity.ts';

export interface ProcessIdentity {
  pid: number;
  startedAt: string;
  /** Random value shared between broker and worker for this run only. */
  token: string;
  /** OS creation instant; null until the asynchronous probe has recorded it. */
  createdAt?: string | null;
}

export function holdFileFor(runDir: string): string {
  return path.join(runDir, 'worker.hold');
}

export function identityFileFor(runDir: string): string {
  return path.join(runDir, 'worker-identity.json');
}

/** How often the worker refreshes its hold file. */
export const HOLD_HEARTBEAT_MS = 5_000;

/**
 * Called by the worker: records who it is and keeps a hold file for its whole
 * lifetime. The hold file is removed on a clean exit, so its ABSENCE is the
 * proof that the worker tore itself down; its presence alone proves nothing.
 *
 * The OS creation identity is durable before this claim resolves. The probe
 * costs a subprocess on some platforms, but releasing work before it finishes
 * creates a race where a fast shutdown cannot prove ownership and must
 * quarantine the checkout.
 */
export interface WorkerIdentityClaim {
  /** Resolves only after the OS creation identity has been durably recorded. */
  ready: Promise<void>;
  release(): void;
}

export function claimWorkerIdentity(runDir: string, token: string): WorkerIdentityClaim {
  mkdirSync(runDir, { recursive: true });
  const identity: ProcessIdentity = { pid: process.pid, startedAt: new Date().toISOString(), token, createdAt: null };
  writeFileSync(identityFileFor(runDir), JSON.stringify(identity, null, 2), 'utf8');
  const hold = holdFileFor(runDir);
  const descriptor = openSync(hold, 'w');
  const beat = (): void => {
    try {
      const now = new Date();
      utimesSync(hold, now, now);
    } catch {
      // The file may have been removed by an operator; identity still decides.
    }
  };
  beat();
  const timer = setInterval(beat, HOLD_HEARTBEAT_MS);
  timer.unref();
  const ready = readProcessCreationIdentity(process.pid).then((createdAt) => {
    if (createdAt) {
      writeFileSync(identityFileFor(runDir), JSON.stringify({ ...identity, createdAt }, null, 2), 'utf8');
    }
  });
  const release = (): void => {
    clearInterval(timer);
    try {
      closeSync(descriptor);
    } catch {
      // already closed
    }
    try {
      unlinkSync(hold);
    } catch {
      // nothing to release
    }
  };
  return { ready, release };
}

export function readWorkerIdentity(runDir: string): ProcessIdentity | null {
  try {
    const parsed = JSON.parse(readFileSync(identityFileFor(runDir), 'utf8')) as ProcessIdentity;
    return typeof parsed.pid === 'number' && typeof parsed.token === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

export type LivenessVerdict = 'alive' | 'gone' | 'unknown';

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === 'EPERM';
  }
}

/**
 * Decides whether the worker recorded for `runDir` is still the live owner.
 *
 *   gone     the worker released its hold, or its PID no longer runs, or the
 *            PID was recycled and now belongs to somebody else;
 *   alive    the PID runs and its creation identity still matches ours;
 *   unknown  ownership could not be established. The caller quarantines: it
 *            must neither terminate that PID nor hand the checkout over.
 */
export async function verifyWorkerLiveness(runDir: string, expected: ProcessIdentity | null): Promise<LivenessVerdict> {
  let holdExists = true;
  try {
    statSync(holdFileFor(runDir));
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') return expected ? 'unknown' : 'gone';
    holdExists = false;
  }
  // A released hold is a clean teardown by the worker itself.
  if (!holdExists) return 'gone';
  if (!expected) return 'unknown';
  const verdict = await verifyProcessIdentity(expected.pid, expected.createdAt);
  if (verdict === 'same') return 'alive';
  if (verdict === 'unknown') return 'unknown';
  return 'gone';
}

export function terminateTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      const timer = setTimeout(() => { killer.kill(); resolve(); }, 10000);
      killer.on('exit', () => { clearTimeout(timer); resolve(); });
      killer.on('error', () => { clearTimeout(timer); resolve(); });
      return;
    }
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    resolve();
  });
}

export function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      if (!isAlive(pid)) return resolve(true);
      if (Date.now() - started > timeoutMs) return resolve(false);
      setTimeout(tick, 50);
    };
    tick();
  });
}

export interface EngineRecord {
  pid: number;
  recordedAt: string;
  createdAt?: string | null;
  /** Set by the worker when the CLI process really exited. */
  exitedAt?: string | null;
  exitCode?: number | null;
  exitSignal?: string | null;
}

export function engineFileFor(runDir: string): string {
  return path.join(runDir, 'engine.json');
}

/** Called by the worker when it starts the CLI, so orphans stay accountable. */
export function recordEngineProcess(runDir: string, pid: number | undefined): void {
  if (!pid) return;
  const record: EngineRecord = { pid, recordedAt: new Date().toISOString(), createdAt: null, exitedAt: null };
  try {
    writeFileSync(engineFileFor(runDir), JSON.stringify(record, null, 2), 'utf8');
  } catch {
    // best effort: the broker falls back to quarantining the lock
    return;
  }
  void readProcessCreationIdentity(pid).then((createdAt) => {
    if (!createdAt) return;
    const current = readEngineProcess(runDir);
    if (!current || current.pid !== pid || current.exitedAt) return;
    try {
      writeFileSync(engineFileFor(runDir), JSON.stringify({ ...current, createdAt }, null, 2), 'utf8');
    } catch {
      // verification stays unknown, which quarantines
    }
  });
}

/** Called by the worker when the CLI process exited: the proof it is gone. */
export function recordEngineExit(runDir: string, code: number | null, signal: string | null): void {
  const current = readEngineProcess(runDir);
  if (!current) return;
  try {
    writeFileSync(engineFileFor(runDir), JSON.stringify({ ...current, exitedAt: new Date().toISOString(), exitCode: code, exitSignal: signal } satisfies EngineRecord, null, 2), 'utf8');
  } catch {
    // best effort; without it the lock is quarantined instead of released
  }
}

export function readEngineProcess(runDir: string): EngineRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(engineFileFor(runDir), 'utf8')) as EngineRecord;
    return typeof parsed.pid === 'number' ? parsed : null;
  } catch {
    return null;
  }
}

export type TargetOutcome =
  /** Never started, or it recorded its own clean exit. */
  | 'absent-clean'
  /** We proved it was ours and terminated its tree. */
  | 'terminated'
  /** Its PID is free, but it never recorded a clean exit: orphans are possible. */
  | 'absent-unproven'
  /** It runs, but we could not prove it is ours; not touched. */
  | 'unverified'
  /** It was ours and survived termination. */
  | 'surviving';

export interface ReconciliationTarget {
  name: 'worker' | 'engine';
  pid: number;
  outcome: TargetOutcome;
  identity: IdentityVerdict | 'not-checked';
  /** Descendants still alive after termination, when any were found. */
  descendants?: number[];
}

export interface ReconciliationResult {
  /** True only when every recorded process is proven finished. */
  clean: boolean;
  survivingPids: number[];
  /** PIDs still running that we could not prove are ours; never terminated. */
  unverifiedPids: number[];
  targets: ReconciliationTarget[];
  note: string;
}

const PROVEN = new Set<TargetOutcome>(['absent-clean', 'terminated']);

/**
 * Live descendants still attributable to `pid`.
 *
 * Returns null when the platform cannot answer, which callers must treat as
 * "not proven". A parent exiting is NEVER proof its children exited: the CLI
 * spawns tool processes, and a crashed or signalled parent orphans them.
 */
async function liveDescendants(pid: number, createdAt: string | null | undefined): Promise<number[] | null> {
  const table = await listProcessTable();
  if (table === null) return null;
  return collectDescendants(table, pid, createdAt).map((entry) => entry.pid);
}

/** Terminates every surviving descendant tree and reports what is still alive. */
async function clearDescendants(pid: number, createdAt: string | null | undefined): Promise<{ remaining: number[]; proven: boolean; observed: number }> {
  const first = await liveDescendants(pid, createdAt);
  if (first === null) return { remaining: [], proven: false, observed: 0 };
  if (first.length === 0) return { remaining: [], proven: true, observed: 0 };
  for (const descendant of first) {
    await terminateTree(descendant);
    await waitForExit(descendant, 5000);
  }
  const second = await liveDescendants(pid, createdAt);
  if (second === null) return { remaining: [], proven: false, observed: first.length };
  return { remaining: second, proven: true, observed: first.length };
}

async function settleTarget(name: 'worker' | 'engine', pid: number, recordedCreatedAt: string | null | undefined): Promise<ReconciliationTarget> {
  const identity = await verifyProcessIdentity(pid, recordedCreatedAt);
  if (identity === 'gone' || identity === 'recycled') {
    // The PID is free (or belongs to someone else). We never touch it, and we
    // cannot prove what it left behind.
    return { name, pid, outcome: 'absent-unproven', identity };
  }
  if (identity === 'unknown') return { name, pid, outcome: 'unverified', identity };
  await terminateTree(pid);
  const exited = await waitForExit(pid, 5000);
  if (!exited) return { name, pid, outcome: 'surviving', identity };
  // The parent is gone; that says nothing about what it left running.
  const tree = await clearDescendants(pid, recordedCreatedAt);
  if (!tree.proven) return { name, pid, outcome: 'unverified', identity, descendants: [] };
  if (tree.remaining.length) return { name, pid, outcome: 'surviving', identity, descendants: tree.remaining };
  return { name, pid, outcome: 'terminated', identity };
}

/**
 * Settles a process that recorded its OWN exit. The record proves the parent
 * finished, never that its tree did, so the descendants are checked and cleared
 * before the run may be called clean.
 */
async function settleExitedTarget(name: 'worker' | 'engine', pid: number, createdAt: string | null | undefined, abnormal = false): Promise<ReconciliationTarget> {
  const identity = await verifyProcessIdentity(pid, createdAt);
  if (identity === 'unknown' || identity === 'same') {
    // Missing identity is not ownership proof, and an "exited" record whose
    // exact process is still alive is contradictory. Never kill from either.
    return { name, pid, outcome: 'unverified', identity };
  }
  if (identity === 'recycled') {
    // The current PID and all of its children belong to another process tree.
    return { name, pid, outcome: 'absent-unproven', identity };
  }
  if (process.platform !== 'win32') {
    // POSIX reparents orphans, so a PPID snapshot after the root exited cannot
    // prove either ownership or absence. Preserve quarantine rather than guess.
    return { name, pid, outcome: 'absent-unproven', identity };
  }
  const tree = await clearDescendants(pid, createdAt);
  if (!tree.proven) {
    return { name, pid, outcome: 'unverified', identity, descendants: [] };
  }
  if (tree.remaining.length) return { name, pid, outcome: 'surviving', identity, descendants: tree.remaining };
  if (abnormal && tree.observed === 0) {
    // A crashed root plus an empty PPID snapshot is not proof: an intermediate
    // may already have exited and broken the ancestry chain to a live tool.
    return { name, pid, outcome: 'absent-unproven', identity };
  }
  return { name, pid, outcome: 'absent-clean', identity };
}

/**
 * Ensures nothing from a finished run can still mutate the checkout.
 *
 * The worker and the CLI process are reconciled INDEPENDENTLY: a worker that
 * vanished says nothing about the engine it started, and an absent worker must
 * never be read as "the run is finished". `clean` is true only when every
 * recorded process either never existed, recorded its own exit, or was proven
 * ours and terminated with its tree.
 */
export async function reconcileRunProcesses(runDir: string, workerPid: number | null, strictRecovery = false): Promise<ReconciliationResult> {
  const targets: ReconciliationTarget[] = [];

  const holdReleased = await fs.access(holdFileFor(runDir)).then(() => false, () => true);
  const workerCreatedAt = readWorkerIdentity(runDir)?.createdAt;
  if (workerPid !== null) {
    // Releasing the hold proves the worker tore ITSELF down; its children are
    // still checked, because a clean parent exit is not a clean tree.
    if (holdReleased) targets.push(await settleExitedTarget('worker', workerPid, workerCreatedAt));
    else targets.push(await settleTarget('worker', workerPid, workerCreatedAt));
  }

  const engine = readEngineProcess(runDir);
  if (engine) {
    if (engine.exitedAt) targets.push(await settleExitedTarget('engine', engine.pid, engine.createdAt, engine.exitSignal !== null || engine.exitCode === null || engine.exitCode !== 0));
    else targets.push(await settleTarget('engine', engine.pid, engine.createdAt));
  }

  if (strictRecovery && process.platform === 'win32') {
    // A PPID snapshot taken after a broker crash is not a proof of the whole
    // historical tree. An intermediate process may already have exited and
    // left a tool alive outside the ancestry that Windows still exposes. Keep
    // the checkout quarantined even when every currently reachable target was
    // stopped; only a future Job Object based supervisor can prove this case.
    for (const target of targets) {
      if (PROVEN.has(target.outcome)) target.outcome = 'absent-unproven';
    }
  }

  const survivingPids = targets.filter((target) => target.outcome === 'surviving').map((target) => target.pid);
  const unverifiedPids = targets.filter((target) => target.outcome === 'unverified').map((target) => target.pid);
  const unproven = targets.filter((target) => target.outcome === 'absent-unproven');
  const clean = targets.every((target) => PROVEN.has(target.outcome));
  if (clean) return { clean, survivingPids, unverifiedPids, targets, note: 'A sessão terminou cooperativamente e nenhum sobrevivente continua visível na árvore ainda atribuível.' };

  const reasons: string[] = [];
  const remainingDescendants = targets.flatMap((target) => target.descendants ?? []);
  if (survivingPids.length) reasons.push(`processos ainda ativos (${survivingPids.join(', ')})`);
  if (remainingDescendants.length) reasons.push(`descendentes que sobreviveram ao encerramento (${remainingDescendants.join(', ')})`);
  if (unverifiedPids.length) reasons.push(`processos ativos sem identidade comprovada, não encerrados (${unverifiedPids.join(', ')})`);
  if (unproven.length) reasons.push(`${unproven.map((target) => `${target.name}/${target.pid}`).join(', ')} desapareceu sem registrar término, então descendentes órfãos não podem ser descartados`);
  return {
    clean,
    survivingPids,
    unverifiedPids,
    targets,
    note: `A trava do checkout permanece em quarentena: ${reasons.join('; ')}.`,
  };
}

/**
 * Re-checks a quarantined run before an explicit, administrative release.
 * Ownership is only releasable when nothing recorded is running any more; an
 * unverifiable live PID keeps the quarantine, because a survivor is possible.
 */
export async function survivorCheck(runDir: string, workerPid: number | null): Promise<{ releasable: boolean; livePids: number[]; note: string }> {
  const live = new Set<number>();
  const engine = readEngineProcess(runDir);
  const candidates: Array<{ pid: number; createdAt: string | null | undefined }> = [];
  if (workerPid !== null) candidates.push({ pid: workerPid, createdAt: readWorkerIdentity(runDir)?.createdAt });
  // The engine is examined even when it recorded its own exit: that record
  // proves the parent finished, not that the tool processes it started did.
  if (engine) candidates.push({ pid: engine.pid, createdAt: engine.createdAt });
  // This is the explicit administrative re-check, not an automatic proof made
  // by recovery. On Windows it can enumerate the currently attributable tree,
  // but cannot reconstruct a historical branch after its intermediary exited;
  // callers must present that limitation in the audited release result.
  let unproven = false;
  for (const candidate of candidates) {
    const identity = await verifyProcessIdentity(candidate.pid, candidate.createdAt);
    if (identity === 'unknown') {
      live.add(candidate.pid);
      continue;
    }
    if (identity === 'recycled') {
      // Never attribute the replacement process or its children to this run;
      // the original tree's absence is no longer provable.
      unproven = true;
      continue;
    }
    if (identity === 'gone' && process.platform !== 'win32') {
      unproven = true;
      continue;
    }
    if (identity === 'same') live.add(candidate.pid);
    const descendants = await liveDescendants(candidate.pid, candidate.createdAt);
    if (descendants === null) unproven = true;
    else for (const pid of descendants) live.add(pid);
  }
  const livePids = [...live];
  if (livePids.length === 0 && !unproven) {
    return { releasable: true, livePids: [], note: 'Nenhum sobrevivente está visível entre os processos registrados e a árvore ainda atribuível; a ancestralidade histórica pode ser inconclusiva.' };
  }
  if (livePids.length === 0) {
    return { releasable: false, livePids: [], note: 'Não foi possível enumerar os processos desta máquina para descartar descendentes órfãos; a posse do checkout não é liberada sem essa prova.' };
  }
  return { releasable: false, livePids, note: `Ainda há processos desta execução em atividade (${livePids.join(', ')}); a posse do checkout não é liberada enquanto um sobrevivente for possível.` };
}
