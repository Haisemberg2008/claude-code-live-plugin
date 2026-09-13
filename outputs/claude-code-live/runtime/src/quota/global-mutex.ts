// The legacy runner serializes /usage queries with a Windows named mutex. v2
// reuses the same name through a PowerShell holder process so v1 and v2
// never overlap; other platforms fall back to an exclusive lock file.
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const QUOTA_MUTEX_NAME = 'Local\\ClaudeLiveQuota';

export class QuotaLockError extends Error {
  code: string;
  attemptedAt: string;
  constructor(code: string, message: string, attemptedAt: string) {
    super(message);
    this.name = 'QuotaLockError';
    this.code = code;
    this.attemptedAt = attemptedAt;
  }
}

export interface MutexOutcome<T> {
  value: T;
  waitedMs: number;
  attemptedAt: string;
}

const HOLDER_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$mutex = [Threading.Mutex]::new($false, $env:CODEORQUESTRA_MUTEX_NAME)',
  'try { $held = $mutex.WaitOne([int]$env:CODEORQUESTRA_MUTEX_WAIT_MS) } catch [Threading.AbandonedMutexException] { $held = $true }',
  "if (-not $held) { [Console]::Out.WriteLine('TIMEOUT'); [Console]::Out.Flush(); exit 2 }",
  "[Console]::Out.WriteLine('HELD'); [Console]::Out.Flush()",
  '$null = [Console]::In.ReadLine()',
  '$mutex.ReleaseMutex(); $mutex.Dispose()',
  "[Console]::Out.WriteLine('RELEASED'); [Console]::Out.Flush()",
].join('; ');

interface Holder {
  release(): Promise<void>;
}

// Node-side serialization so two callers in the same process never race the
// same named mutex holder.
//
// One chain PER NAME. A single shared chain would make every named mutex
// serialize against every other one: a git lock on repository A would wait
// behind a /usage observation, and two repositories would wait on each other,
// which is the opposite of what parallel worktrees need.
const localChains = new Map<string, Promise<unknown>>();

function acquireWindows(name: string, waitMs: number, attemptedAt: string): Promise<Holder> {
  return new Promise((resolve, reject) => {
    const child = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-Command', HOLDER_SCRIPT], {
      env: { ...process.env, CODEORQUESTRA_MUTEX_NAME: name, CODEORQUESTRA_MUTEX_WAIT_MS: String(waitMs) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    const exited = new Promise<void>((done) => child.on('exit', () => done()));
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      if (child.exitCode === null) child.kill();
      reject(error);
    };
    const timer = setTimeout(() => fail(new QuotaLockError('QUOTA_LOCK_TIMEOUT', 'Tempo esgotado aguardando o mutex global de quota.', attemptedAt)), waitMs + 20000);
    child.on('error', (error) => { clearTimeout(timer); fail(new QuotaLockError('QUOTA_LOCK_UNAVAILABLE', `pwsh indisponível para o mutex global: ${error.message}`, attemptedAt)); });
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (settled) return;
      if (stdout.includes('HELD')) {
        settled = true;
        clearTimeout(timer);
        resolve({
          async release() {
            if (child.exitCode === null) {
              child.stdin.write('release\n');
              child.stdin.end();
              const killer = setTimeout(() => child.kill(), 5000);
              await exited;
              clearTimeout(killer);
            }
          },
        });
      } else if (stdout.includes('TIMEOUT')) {
        clearTimeout(timer);
        fail(new QuotaLockError('QUOTA_LOCK_TIMEOUT', 'Tempo esgotado aguardando o mutex global de quota (v1 ou outra consulta v2 em andamento).', attemptedAt));
      }
    });
    void exited.then(() => {
      if (!settled) {
        clearTimeout(timer);
        fail(new QuotaLockError('QUOTA_LOCK_UNAVAILABLE', `O processo do mutex encerrou antes de adquirir (${stderr.trim().slice(0, 200)}).`, attemptedAt));
      }
    });
  });
}

async function acquireLockFile(name: string, waitMs: number, attemptedAt: string): Promise<Holder> {
  const file = path.join(os.tmpdir(), `${name.replace(/[^A-Za-z0-9]/g, '_')}.lock`);
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const handle = await fs.open(file, 'wx');
      await handle.writeFile(String(process.pid));
      await handle.close();
      return { async release() { await fs.rm(file, { force: true }); } };
    } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') throw error;
      try {
        const pid = Number(await fs.readFile(file, 'utf8'));
        if (pid && !isAlive(pid)) { await fs.rm(file, { force: true }); continue; }
      } catch {
        // ignore
      }
      if (Date.now() >= deadline) throw new QuotaLockError('QUOTA_LOCK_TIMEOUT', 'Tempo esgotado aguardando o lock global de quota.', attemptedAt);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs `fn` while holding a cross-process named mutex.
 *
 * Windows uses a kernel mutex through a PowerShell holder, so the name is
 * shared with the legacy runner; other platforms fall back to an exclusive lock
 * file. Callers under different names never wait on each other.
 */
export async function withNamedMutex<T>(name: string, fn: () => Promise<T>, options: { waitMs?: number; transport?: 'auto' | 'file' } = {}): Promise<MutexOutcome<T>> {
  const waitMs = options.waitMs ?? 30000;
  const attemptedAt = new Date().toISOString();
  const started = Date.now();
  // 'auto' uses the Windows kernel mutex, which exists so v1 and v2 can share
  // the /usage name across processes — and which costs a hard dependency on
  // PowerShell 7, absent from a stock Windows install. A lock with no v1
  // counterpart should ask for 'file' and work everywhere.
  const useKernelMutex = process.platform === 'win32' && (options.transport ?? 'auto') === 'auto';
  const run = async (): Promise<MutexOutcome<T>> => {
    const holder = useKernelMutex ? await acquireWindows(name, waitMs, attemptedAt) : await acquireLockFile(name, waitMs, attemptedAt);
    const waitedMs = Date.now() - started;
    try {
      const value = await fn();
      return { value, waitedMs, attemptedAt };
    } finally {
      await holder.release();
    }
  };
  const previous = localChains.get(name) ?? Promise.resolve();
  const next = previous.then(run, run);
  // Keep the map from growing without bound across many repositories: the
  // entry is dropped once it is the last one queued under this name.
  const settled = next.catch(() => undefined).then(() => {
    if (localChains.get(name) === settled) localChains.delete(name);
  });
  localChains.set(name, settled);
  return next;
}

/** The /usage mutex, shared by name with the legacy runner. */
export async function withGlobalQuotaMutex<T>(fn: () => Promise<T>, options: { waitMs?: number; name?: string } = {}): Promise<MutexOutcome<T>> {
  return withNamedMutex(options.name ?? QUOTA_MUTEX_NAME, fn, options.waitMs === undefined ? {} : { waitMs: options.waitMs });
}
