// Cross-process startup guard for the broker.
//
// Two adapters (CLI, MCP, dashboard launcher) can race to start a broker for
// the same state root. The winner holds an exclusive lock file open for its
// whole lifetime; on Windows an open handle without delete sharing makes the
// lock impossible to remove, which is the liveness proof. A lock whose owner
// is gone is reclaimed, so a crash never wedges the state root.
import { closeSync, openSync, readFileSync, renameSync, statSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';

export interface SingletonLock {
  file: string;
  /** PID of the kernel-mutex monitor on Windows; exposed for diagnostics/tests. */
  monitorPid?: number;
  /** Resolves only when ownership disappears unexpectedly. */
  lost: Promise<void>;
  release(): Promise<void>;
}

export interface LockOwner {
  pid: number;
  startedAt: string;
  port?: number;
}

function readOwner(file: string): LockOwner | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as LockOwner;
    return typeof parsed.pid === 'number' ? parsed : null;
  } catch {
    return null;
  }
}

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string } | undefined)?.code;
}

/**
 * Reclaims an abandoned lock ATOMICALLY.
 *
 * Reading a lock, judging it stale and then deleting it is a race: two
 * contenders can read the same dead owner, the first replaces the lock, and the
 * second then deletes the FIRST one's fresh lock using its stale evidence —
 * leaving two brokers believing they own the state root.
 *
 * Renaming is atomic and exclusive, so only one contender can take the file
 * away. Whoever takes it then verifies it is still the abandoned lock it judged:
 * if it turns out to be somebody's fresh lock, it is put straight back and the
 * state root counts as held.
 */
function reclaimed(file: string, expected: LockOwner | null): boolean {
  // The safety argument below depends on Windows sharing semantics: a live
  // owner keeps this file open without delete sharing, so rename cannot steal
  // its lock. POSIX permits renaming an open file; without a native flock/CAS
  // primitive, automatic stale recovery there could displace a fresh owner.
  // Fail closed on those platforms and require explicit operator cleanup.
  if (process.platform !== 'win32') return false;
  const claim = `${file}.reclaim-${process.pid}-${Date.now().toString(36)}`;
  try {
    renameSync(file, claim);
  } catch (error) {
    // Someone else already took it away, or it was never there.
    return errorCode(error) === 'ENOENT';
  }
  const taken = readOwner(claim);
  const sameOwner = expected === null
    ? taken === null
    : taken !== null && taken.pid === expected.pid && taken.startedAt === expected.startedAt;
  if (!sameOwner) {
    // We moved a lock we had not judged: restore it and treat the root as held.
    try {
      renameSync(claim, file);
    } catch {
      try { unlinkSync(claim); } catch { /* nothing more we can do */ }
    }
    return false;
  }
  try {
    unlinkSync(claim);
  } catch {
    // The abandoned copy lingers under a unique name; the lock path is free.
  }
  return true;
}

/**
 * A lock file exists between `openSync(…, 'wx')` and the owner bytes being
 * written. During that window it is empty, and an empty file is NOT evidence of
 * an abandoned lock — treating it as reclaimable is exactly how two brokers end
 * up owning one state root. A lock with no readable owner is therefore held
 * until it is older than this grace period.
 */
const OWNER_WRITE_GRACE_MS = 10_000;

/** True when another live broker owns the lock for this state root. */
function heldByLiveProcess(file: string, now = Date.now()): boolean {
  let createdAt: number;
  try {
    createdAt = statSync(file).mtimeMs;
  } catch (error) {
    // No lock at all means a free state root. Any other failure (sharing
    // violation, permissions) is treated as held rather than stolen.
    return errorCode(error) !== 'ENOENT';
  }
  const owner = readOwner(file);
  if (!owner) {
    // Unreadable: either a broker is publishing itself right now, or the file
    // is genuinely corrupt. Only the second, proven by age, may be reclaimed.
    if (now - createdAt < OWNER_WRITE_GRACE_MS) return true;
    return !reclaimed(file, null);
  }
  let alive: boolean;
  try {
    process.kill(owner.pid, 0);
    alive = true;
  } catch (error) {
    alive = errorCode(error) === 'EPERM';
  }
  // The pid check alone is not proof: pids are recycled and a dead owner may
  // still have the file open on this platform.
  if (!alive) return !reclaimed(file, owner);
  return true;
}

export class SingletonBusyError extends Error {
  code = 'BROKER_ALREADY_RUNNING';
  owner: LockOwner | null;
  constructor(owner: LockOwner | null) {
    super(owner ? `Outro broker já está ativo para este state root (pid ${owner.pid}).` : 'Outro broker já está ativo para este state root.');
    this.name = 'SingletonBusyError';
    this.owner = owner;
  }
}

/**
 * Acquires the broker singleton for `stateRoot`. Throws SingletonBusyError
 * when another live broker owns it.
 */
function acquireFileSingleton(stateRoot: string): SingletonLock {
  const dir = path.join(stateRoot, 'broker');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'broker.lock');
  if (heldByLiveProcess(file)) throw new SingletonBusyError(readOwner(file));
  let descriptor: number;
  try {
    descriptor = openSync(file, 'wx');
  } catch (error) {
    if ((error as { code?: string }).code === 'EEXIST') throw new SingletonBusyError(readOwner(file));
    throw error;
  }
  writeFileSync(descriptor, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() } satisfies LockOwner));
  let released = false;
  return {
    file,
    lost: new Promise<void>(() => undefined),
    async release() {
      if (released) return;
      released = true;
      try {
        closeSync(descriptor);
      } catch {
        // already closed
      }
      try {
        unlinkSync(file);
      } catch {
        // another owner may have reclaimed it
      }
    },
  };
}

/**
 * Windows ownership uses a kernel mutex, not filesystem rename semantics.
 * The helper process holds the mutex for the broker lifetime; Windows releases
 * it automatically if either process crashes. The lock file is metadata only.
 */
async function acquireWindowsMutex(stateRoot: string): Promise<SingletonLock> {
  const dir = path.join(stateRoot, 'broker');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'broker.lock');
  const key = createHash('sha256').update(path.resolve(stateRoot).toLowerCase()).digest('hex').slice(0, 32);
  const mutexName = `Local\\CodeOrquestra-${key}`;
  const script = [
    `$m=[Threading.Mutex]::new($false,'${mutexName}')`,
    "if(-not $m.WaitOne(0)){[Console]::Out.WriteLine('BUSY');exit 4}",
    "[Console]::Out.WriteLine('ACQUIRED')",
    '$null=[Console]::In.ReadLine()',
    'try{$m.ReleaseMutex()}catch{}',
    '$m.Dispose()',
  ].join(';');
  const child: ChildProcess = spawn('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
  });
  let released = false;
  let lostResolve!: () => void;
  const lost = new Promise<void>((resolve) => { lostResolve = resolve; });
  const closed = new Promise<void>((resolve) => child.once('close', () => { resolve(); if (!released) lostResolve(); }));
  let outcome: 'ACQUIRED' | 'BUSY';
  try {
    outcome = await new Promise<'ACQUIRED' | 'BUSY'>((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(new Error('BROKER_MUTEX_TIMEOUT')), 10_000);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      text += chunk;
      const line = text.split(/\r?\n/, 1)[0]?.trim();
      if (line === 'ACQUIRED' || line === 'BUSY') {
        clearTimeout(timer);
        resolve(line);
      }
    });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => {
      if (!text.includes('ACQUIRED') && !text.includes('BUSY')) {
        clearTimeout(timer);
        reject(new Error(`BROKER_MUTEX_HELPER_EXIT_${String(code)}`));
      }
    });
    });
  } catch (error) {
    try { child.kill(); } catch { /* gone */ }
    await closed;
    throw error;
  }
  if (outcome === 'BUSY') {
    child.stdin?.end();
    throw new SingletonBusyError(readOwner(file));
  }
  const owner = { pid: process.pid, startedAt: new Date().toISOString() } satisfies LockOwner;
  try {
    writeFileSync(file, JSON.stringify(owner), 'utf8');
  } catch (error) {
    released = true;
    try { child.kill(); } catch { /* gone */ }
    await closed;
    throw error;
  }
  return {
    file,
    ...(child.pid !== undefined ? { monitorPid: child.pid } : {}),
    lost,
    async release() {
      if (released) return;
      released = true;
      try { child.stdin?.end('\n'); } catch { /* helper already gone */ }
      const graceful = await Promise.race([closed.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000))]);
      if (!graceful) {
        try { child.kill(); } catch { /* gone */ }
        await closed;
      }
      const current = readOwner(file);
      if (current?.pid === owner.pid && current.startedAt === owner.startedAt) {
        try { unlinkSync(file); } catch { /* metadata cleanup is best effort */ }
      }
    },
  };
}

export async function acquireBrokerSingleton(stateRoot: string): Promise<SingletonLock> {
  if (process.platform !== 'win32') return acquireFileSingleton(stateRoot);
  try {
    return await acquireWindowsMutex(stateRoot);
  } catch (error) {
    // PowerShell 7 is not part of a stock Windows install, and without it the
    // kernel-mutex singleton cannot be taken at all — the runtime would simply
    // not start. The file singleton is the same mechanism POSIX already relies
    // on: an exclusive lock file held open for the process lifetime, which
    // still admits exactly one broker per state root. Only a missing
    // interpreter falls back; a BUSY mutex or a timeout still fails.
    if (!isMissingInterpreter(error)) throw error;
    process.stderr.write(
      'CodeOrquestra: PowerShell 7 (pwsh) não está instalado; o singleton do broker passa a usar arquivo de trava exclusivo, '
      + 'o mesmo mecanismo já usado fora do Windows. Continua valendo um broker por state root.\n',
    );
    return acquireFileSingleton(stateRoot);
  }
}

/** True only for "the interpreter is not installed", never for a taken mutex. */
function isMissingInterpreter(error: unknown): boolean {
  return /ENOENT/.test(error instanceof Error ? error.message : String(error));
}
