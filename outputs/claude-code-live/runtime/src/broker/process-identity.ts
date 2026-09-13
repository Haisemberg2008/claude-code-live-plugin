// OS-verifiable process creation identity.
//
// A PID alone is never an identity: the operating system recycles it, so a
// liveness probe can point at an unrelated process. Every platform exposes the
// creation instant of a running process, and that instant plus the PID is
// stable, unforgeable by a later process and readable by another process.
//
// When the platform cannot answer, the result is null and callers must treat
// the identity as UNKNOWN — quarantine, never terminate.
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';

const PROBE_TIMEOUT_MS = 10_000;

interface CaptureResult {
  /** Exit status of the probe; null when it could not be started at all. */
  code: number | null;
  stdout: string;
}

function runCapture(command: string, args: string[], timeoutMs = PROBE_TIMEOUT_MS): Promise<CaptureResult | null> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch {
      resolve(null);
      return;
    }
    let stdout = '';
    let settled = false;
    const done = (value: CaptureResult | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } done(null); }, PROBE_TIMEOUT_MS);
    timer.unref();
    child.stdout.setEncoding('utf8');
    // A process table is far larger than a single timestamp; the cap only
    // guards against unbounded growth, not against a normal snapshot.
    child.stdout.on('data', (chunk: string) => { if (stdout.length < 4 * 1024 * 1024) stdout += chunk; });
    child.on('error', () => done(null));
    child.on('exit', (code) => done({ code, stdout: stdout.trim() }));
  });
}

const NOT_FOUND = 'CODEORQUESTRA_NOT_FOUND';
const DENIED = 'CODEORQUESTRA_DENIED';

/**
 * Windows: the creation time of a live process, via the installed PowerShell.
 * The script answers with explicit markers so "no such process" is never
 * confused with "the probe failed" — the first means gone, the second unknown.
 */
async function windowsCreationTime(pid: number): Promise<string | null> {
  // try/catch must stay one statement: a semicolon between the blocks is a
  // parse error, which would make every probe look like an unknown identity.
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$p = Get-Process -Id ${pid}`,
    `if (-not $p) { Write-Output '${NOT_FOUND}'; exit 0 }`,
    `try { Write-Output $p.StartTime.ToUniversalTime().ToString('o') } catch { Write-Output '${DENIED}' }`,
    'exit 0',
  ].join('; ');
  for (const shell of ['pwsh', 'powershell']) {
    const outcome = await runCapture(shell, ['-NoProfile', '-NonInteractive', '-Command', script]);
    if (outcome === null || outcome.code !== 0) continue;
    if (outcome.stdout === NOT_FOUND) return '';
    if (outcome.stdout === DENIED || outcome.stdout.length === 0) return null;
    return outcome.stdout;
  }
  return null;
}

/** Linux: field 22 of /proc/<pid>/stat is the start time in clock ticks. */
async function linuxCreationTime(pid: number): Promise<string | null> {
  let raw: string;
  try {
    raw = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
  } catch (error) {
    return (error as { code?: string }).code === 'ENOENT' ? '' : null;
  }
  // The second field is the command name in parentheses and may contain spaces.
  const close = raw.lastIndexOf(')');
  if (close < 0) return null;
  const fields = raw.slice(close + 2).split(' ');
  // After the command name, field 22 of the whole line is index 19 here.
  const starttime = fields[19];
  return starttime && /^\d+$/.test(starttime) ? starttime : null;
}

async function bsdCreationTime(pid: number): Promise<string | null> {
  const outcome = await runCapture('ps', ['-o', 'lstart=', '-p', String(pid)]);
  // `ps` could not be run at all: unknown. It ran and found nothing: gone.
  if (outcome === null) return null;
  if (outcome.code !== 0) return '';
  return outcome.stdout.length > 0 ? outcome.stdout : '';
}

/**
 * Creation identity of a running process.
 *
 * Returns the opaque platform value, `''` when the process is provably not
 * running, and `null` when this platform could not answer at all.
 */
export async function readProcessCreationIdentity(pid: number): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return '';
  if (process.platform === 'win32') return windowsCreationTime(pid);
  if (process.platform === 'linux') return linuxCreationTime(pid);
  return bsdCreationTime(pid);
}

export interface ProcessTableEntry {
  pid: number;
  ppid: number;
  /** Opaque creation instant, when the platform reports one. */
  createdAt: string | null;
}

const WINDOWS_TABLE_SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  "Get-CimInstance Win32_Process | ForEach-Object { '{0}|{1}|{2}' -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate.ToUniversalTime().ToString('o') }",
  'exit 0',
].join('; ');

function parsePipeTable(text: string): ProcessTableEntry[] {
  const rows: ProcessTableEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const [pid, ppid, createdAt] = line.trim().split('|');
    const parsedPid = Number(pid);
    const parsedPpid = Number(ppid);
    if (!Number.isInteger(parsedPid) || !Number.isInteger(parsedPpid)) continue;
    rows.push({ pid: parsedPid, ppid: parsedPpid, createdAt: createdAt && createdAt.length > 0 ? createdAt : null });
  }
  return rows;
}

async function linuxProcessTable(): Promise<ProcessTableEntry[] | null> {
  let names: string[];
  try {
    names = await fs.readdir('/proc');
  } catch {
    return null;
  }
  const rows: ProcessTableEntry[] = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const raw = await fs.readFile(`/proc/${name}/stat`, 'utf8');
      const close = raw.lastIndexOf(')');
      if (close < 0) continue;
      const fields = raw.slice(close + 2).split(' ');
      const ppid = Number(fields[1]);
      const starttime = fields[19];
      if (!Number.isInteger(ppid)) continue;
      rows.push({ pid: Number(name), ppid, createdAt: starttime && /^\d+$/.test(starttime) ? starttime : null });
    } catch {
      // the process ended while we were reading it
    }
  }
  return rows;
}

/**
 * Snapshot of the process table, or null when this platform cannot supply one.
 *
 * Windows keeps the recorded parent id after the parent dies, so an orphaned
 * descendant is still attributable to it. On POSIX an orphan is re-parented,
 * so a descendant whose parent already exited cannot be attributed this way —
 * callers must treat an empty result as "not proven", never as "nothing left".
 */
export async function listProcessTable(): Promise<ProcessTableEntry[] | null> {
  if (process.platform === 'win32') {
    for (const shell of ['pwsh', 'powershell']) {
      const outcome = await runCapture(shell, ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_TABLE_SCRIPT], 30_000);
      if (outcome === null || outcome.code !== 0 || outcome.stdout.length === 0) continue;
      return parsePipeTable(outcome.stdout);
    }
    return null;
  }
  if (process.platform === 'linux') return linuxProcessTable();
  const outcome = await runCapture('ps', ['-eo', 'pid=,ppid=,lstart=']);
  if (outcome === null || outcome.code !== 0) return null;
  const rows: ProcessTableEntry[] = [];
  for (const line of outcome.stdout.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), createdAt: match[3]!.trim() || null });
  }
  return rows;
}

/**
 * Transitive descendants of `rootPid` in a table snapshot.
 *
 * A child recorded as created BEFORE its supposed parent cannot really be its
 * child; that is a recycled parent id, and following it would attribute — and
 * possibly terminate — an unrelated process tree.
 */
export function collectDescendants(table: ProcessTableEntry[], rootPid: number, rootCreatedAt?: string | null): ProcessTableEntry[] {
  const byParent = new Map<number, ProcessTableEntry[]>();
  for (const entry of table) {
    if (entry.pid === entry.ppid) continue;
    const list = byParent.get(entry.ppid);
    if (list) list.push(entry);
    else byParent.set(entry.ppid, [entry]);
  }
  const found: ProcessTableEntry[] = [];
  const seen = new Set<number>([rootPid]);
  const queue: Array<{ pid: number; createdAt: string | null | undefined }> = [{ pid: rootPid, createdAt: rootCreatedAt }];
  while (queue.length) {
    const current = queue.shift()!;
    for (const child of byParent.get(current.pid) ?? []) {
      if (seen.has(child.pid)) continue;
      if (current.createdAt && child.createdAt && child.createdAt < current.createdAt) continue;
      seen.add(child.pid);
      found.push(child);
      queue.push({ pid: child.pid, createdAt: child.createdAt });
    }
  }
  return found;
}

export type IdentityVerdict =
  /** The running process is the one that was recorded. */
  | 'same'
  /** The PID runs, but it is a different process: ours is gone, this is not ours to touch. */
  | 'recycled'
  /** Nothing is running under this PID. */
  | 'gone'
  /** Identity could not be established; the caller must quarantine, not terminate. */
  | 'unknown';

/**
 * Compares a running PID against the creation identity recorded for it.
 * Without a recorded identity the answer is `unknown`, never `same`: acting
 * destructively on a PID we cannot prove is ours is exactly the hazard.
 */
export async function verifyProcessIdentity(pid: number, recorded: string | null | undefined): Promise<IdentityVerdict> {
  const observed = await readProcessCreationIdentity(pid);
  if (observed === '') return 'gone';
  if (observed === null) return 'unknown';
  if (!recorded) return 'unknown';
  return observed === recorded ? 'same' : 'recycled';
}
