// Every git invocation the broker makes lives here, so timeout, spawn policy
// and output handling have exactly one definition — and so the mutations that
// touch a repository's shared admin directory are all in one place, where the
// per-repository mutex can be applied without being forgotten.
//
// Claude never runs these: `git worktree add|remove|move|prune|lock|unlock|repair`
// is denied by the action classifier (RESERVED_OPERATION_WORKTREE). The broker
// provisions, the user enables, Codex asks.
import { spawn } from 'node:child_process';
import { promises as fs, realpathSync } from 'node:fs';
import path from 'node:path';
import { sha256 } from './identity.ts';
import { withNamedMutex } from '../quota/global-mutex.ts';

/** Beyond this, a git call is treated as hung rather than slow. */
const GIT_TIMEOUT_MS = 20000;
/** `git worktree add` on a large repository is legitimately slower. */
const GIT_PROVISION_TIMEOUT_MS = 120000;
/** The panel never needs more than this many changed paths. */
const MAX_CHANGED_FILES = 500;

export class WorktreeError extends Error {
  code: string;
  detail: string | undefined;
  constructor(code: string, message: string, detail?: string) {
    super(message);
    this.name = 'WorktreeError';
    this.code = code;
    this.detail = detail;
  }
}

export interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Runs git and always resolves. Callers decide what a nonzero exit means;
 * nothing here throws on a failed command, only on an unusable environment.
 */
export function git(args: string[], cwd: string, timeoutMs = GIT_TIMEOUT_MS): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.on('error', (error) => { clearTimeout(timer); resolve({ code: null, stdout, stderr: String(error), timedOut }); });
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
  });
}

/**
 * Changed paths as git sees them.
 *
 * Moved here from task-manager so it shares the one git policy. Behaviour is
 * unchanged, including that a directory without `.git` yields an empty list
 * rather than an error: an unversioned workspace is allowed.
 *
 * Note what this does NOT report: `--porcelain` never lists ignored files, so a
 * worktree holding a multi-gigabyte `node_modules` reports clean. That is
 * correct for "did anyone change tracked work", and it is why removal asks git
 * rather than trusting this list.
 */
export async function gitStatus(workspace: string): Promise<string[]> {
  try {
    await fs.access(path.join(workspace, '.git'));
  } catch {
    return [];
  }
  const result = await git(['status', '--porcelain', '--untracked-files=all'], workspace, 5000);
  if (result.code !== 0) return [];
  return result.stdout.split('\n').map((line) => normalizeStatusPath(line.slice(3).trim())).filter(Boolean).slice(0, MAX_CHANGED_FILES);
}

/**
 * Turns one porcelain path field into a plain workspace-relative path.
 *
 * Two shapes need handling or the entry is unusable downstream, where the list
 * is what an annotation or a diff request must match exactly:
 *   - a rename is reported as `old -> new`, and only the new path exists;
 *   - a path with non-ASCII or unusual bytes is C-quoted, e.g. "src/a\303\247.ts".
 * Anything still ambiguous after this is left as-is and simply fails to match,
 * which refuses the request rather than acting on a half-parsed path.
 */
function normalizeStatusPath(field: string): string {
  let value = field;
  const arrow = value.lastIndexOf(' -> ');
  if (arrow >= 0) value = value.slice(arrow + 4).trim();
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    const body = value.slice(1, -1);
    try {
      // C-style octal escapes are UTF-8 bytes; decode them as such.
      const bytes: number[] = [];
      for (let index = 0; index < body.length; index += 1) {
        if (body[index] !== '\\') { bytes.push(body.charCodeAt(index)); continue; }
        const next = body[index + 1] ?? '';
        if (/[0-7]/.test(next)) {
          bytes.push(parseInt(body.slice(index + 1, index + 4), 8));
          index += 3;
        } else {
          bytes.push(({ n: 10, t: 9, r: 13, '"': 34, '\\': 92 } as Record<string, number>)[next] ?? body.charCodeAt(index + 1));
          index += 1;
        }
      }
      value = Buffer.from(bytes).toString('utf8');
    } catch {
      return field;
    }
  }
  return value;
}

export interface Repository {
  /** The shared admin directory; the same for a checkout and all its worktrees. */
  commonDir: string;
  /** The top level of the working tree this path belongs to. */
  topLevel: string;
  /** Stable per-repository key, derived from the common dir. */
  repoKey: string;
}

/** Separator and case normalization only; no filesystem access. */
function lexical(target: string): string {
  const normalized = target.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/**
 * Canonical spelling used for identity: one path, one key, on every platform.
 *
 * Resolves through the filesystem, because the values compared here arrive from
 * different sources with different spellings of the same directory. git always
 * reports the long name; `os.tmpdir()` and an inherited environment can report
 * a Windows 8.3 short name. Comparing `c:/users/runner~1/…` with
 * `c:/users/runneradmin/…` lexically says "different directory", which for a
 * writer-lock key means two runs would both think they own a tree.
 *
 * Falls back to lexical normalization when the path does not exist — a planned
 * worktree is canonicalized before it is created, and `canonicalizePlanned`
 * handles that case by resolving the deepest existing ancestor.
 */
export function canonicalize(target: string): string {
  try {
    return lexical(realpathSync.native(target));
  } catch {
    return lexical(target);
  }
}

/**
 * Canonicalizes a path that may not exist yet.
 *
 * `realpathSync.native` throws ENOENT on a worktree we are about to create, so
 * the deepest existing ancestor is resolved and the remainder appended. Without
 * this, provisioning would report WORKSPACE_NOT_FOUND for a path whose only
 * problem is that it does not exist yet — which is the point.
 */
export function canonicalizePlanned(target: string): string {
  const absolute = path.resolve(target);
  const trailing: string[] = [];
  let probe = absolute;
  for (;;) {
    try {
      const real = realpathSync.native(probe);
      return canonicalize(trailing.length ? path.join(real, ...trailing.reverse()) : real);
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return canonicalize(absolute);
      trailing.push(path.basename(probe));
      probe = parent;
    }
  }
}

/** Identifies the repository a path belongs to, or reports why it does not. */
export async function resolveRepository(workspace: string): Promise<Repository> {
  const result = await git(['rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel'], workspace);
  if (result.code !== 0) {
    throw new WorktreeError('NOT_A_GIT_REPOSITORY', 'O workspace declarado não pertence a um repositório git; worktrees exigem um.', result.stderr.trim().slice(0, 400));
  }
  const lines = result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  const commonDir = lines[0];
  const topLevel = lines[1];
  if (!commonDir || !topLevel) {
    throw new WorktreeError('NOT_A_GIT_REPOSITORY', 'Não foi possível identificar o repositório do workspace declarado.');
  }
  return { commonDir: canonicalize(commonDir), topLevel: canonicalize(topLevel), repoKey: sha256(canonicalize(commonDir)).slice(0, 24) };
}

/**
 * Serializes every mutation of one repository's shared admin directory.
 *
 * Uses the lock-file transport on every platform. The Windows kernel mutex
 * exists so v1 and v2 can share the /usage name across processes; a repository
 * lock has no v1 counterpart, and the kernel path costs a hard dependency on
 * PowerShell 7, which a stock Windows install does not have. Provisioning a
 * worktree must not require installing pwsh.
 */
export async function withRepositoryMutex<T>(repoKey: string, fn: () => Promise<T>): Promise<T> {
  const outcome = await withNamedMutex(`CodeOrquestraRepo-${repoKey}`, fn, { waitMs: 60000, transport: 'file' });
  return outcome.value;
}

export interface WorktreeLocation {
  root: string;
  path: string;
}

/**
 * Where a task's worktree lives — a pure function of (repository, task).
 *
 * Deterministic on purpose, and outside the repository on purpose.
 *
 * Outside, because `trust/inventory.ts` descends into every subdirectory not in
 * SKIP_DIRS and inventories each one's CLAUDE.md. A worktree inside the repo is
 * a full checkout, so it carries a copy of the repo's own CLAUDE.md: the main
 * checkout's fingerprint would change and every run there would be refused with
 * WORKSPACE_NOT_TRUSTED, shifting again with each new worktree. Adding
 * `.worktrees` to SKIP_DIRS looks like the fix and is worse — the CLI would
 * still load those instructions, now un-inventoried.
 *
 * Deterministic, because the writer-lock key must be computable inside
 * startRun's synchronous critical section, before the first await, and because
 * it makes quarantine survive with no extra bookkeeping: the same task's next
 * run derives the same key and hits the existing quarantine check.
 */
export function worktreePathFor(stateRoot: string, repoKey: string, taskId: string): WorktreeLocation {
  const root = path.join(stateRoot, 'worktrees', repoKey);
  return { root, path: path.join(root, taskId.slice(0, 16)) };
}

/**
 * Windows tooling that has not opted into long paths still breaks past
 * MAX_PATH. git itself is fine; much of what runs inside a checkout is not.
 */
export function assertUsablePathLength(target: string): void {
  if (process.platform === 'win32' && target.length > 150) {
    throw new WorktreeError(
      'WORKTREE_PATH_TOO_LONG',
      `O caminho do worktree tem ${target.length} caracteres; ferramentas que não habilitaram caminhos longos falhariam dentro dele. Configure um worktreeRoot mais curto na política do repositório.`,
    );
  }
}

export interface EnsureOutcome {
  path: string;
  branch: string;
  baseRef: string | null;
  created: boolean;
}

/** A worktree that already exists and is usable, or null when there is none. */
async function inspectExisting(target: string, repository: Repository): Promise<{ reusable: boolean; dirty: string[] } | null> {
  try {
    await fs.access(target);
  } catch {
    return null;
  }
  const common = await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], target);
  // A directory that is not this repository's worktree must never be adopted:
  // it could be a leftover from another repo that happens to share the path.
  if (common.code !== 0 || canonicalize(common.stdout.trim()) !== repository.commonDir) {
    throw new WorktreeError('WORKTREE_PATH_OCCUPIED', 'Já existe um diretório nesse caminho que não é um worktree deste repositório. Nada foi removido; resolva manualmente.');
  }
  return { reusable: true, dirty: await gitStatus(target) };
}

/**
 * Creates the task's worktree, or reuses it when it is clean.
 *
 * Must be called under `withRepositoryMutex`: git's own locking does not cover
 * the combination of admin-dir creation, ref creation and prune, and a failed
 * add can leave a registered-but-missing worktree behind.
 */
export async function ensureWorktree(options: {
  repository: Repository;
  target: string;
  branch: string;
  baseRef: string | null;
}): Promise<EnsureOutcome> {
  const { repository, target, branch, baseRef } = options;
  assertUsablePathLength(target);
  const existing = await inspectExisting(target, repository);
  if (existing) {
    // Uncommitted work is the normal end state of a successful run, because
    // commit can never belong to Claude. Refusing is the contract's only
    // option today; cleaning it would destroy the deliverable.
    if (existing.dirty.length > 0) {
      throw new WorktreeError(
        'WORKTREE_DIRTY_FROM_PREVIOUS_RUN',
        `O worktree desta tarefa ainda tem ${existing.dirty.length} arquivo(s) com alterações não commitadas de uma execução anterior. Revise e commite ou descarte antes de iniciar outra.`,
        existing.dirty.slice(0, 20).join(', '),
      );
    }
    return { path: target, branch, baseRef, created: false };
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  // --no-track keeps the branch local. Never -B (it resets an existing branch,
  // discarding commits) and never --force (it adopts a dirty path).
  const args = ['worktree', 'add', '--no-track', '-b', branch, target];
  if (baseRef) args.push(baseRef);
  const result = await git(args, repository.topLevel, GIT_PROVISION_TIMEOUT_MS);
  if (result.code !== 0) {
    // Leave no half-created registration behind for the next run to trip on.
    await git(['worktree', 'prune'], repository.topLevel).catch(() => undefined);
    throw new WorktreeError(
      result.timedOut ? 'WORKTREE_ADD_TIMEOUT' : 'WORKTREE_ADD_FAILED',
      result.timedOut ? 'git worktree add excedeu o tempo limite; nada foi iniciado.' : 'git worktree add falhou; nada foi iniciado.',
      result.stderr.trim().slice(0, 400),
    );
  }
  return { path: target, branch, baseRef, created: true };
}

/**
 * Removes a worktree.
 *
 * Unforced by default, and that is the safety property, not an obstacle: `git
 * worktree remove` refuses a tree holding modifications or untracked files, so
 * the normal end of a run can never delete the deliverable.
 *
 * `force` exists only for the administrative discard, where the operator named
 * the files being thrown away and said so explicitly. It is git's own primitive
 * for this; trying to clean the tree first would not work anyway, since
 * `git checkout -- .` restores tracked files and leaves untracked ones behind.
 */
export async function removeWorktree(repository: Repository, target: string, options: { force?: boolean } = {}): Promise<{ removed: boolean; reason?: string }> {
  const result = await git(['worktree', 'remove', ...(options.force ? ['--force'] : []), target], repository.topLevel);
  if (result.code === 0) {
    await git(['worktree', 'prune'], repository.topLevel).catch(() => undefined);
    return { removed: true };
  }
  return { removed: false, reason: result.stderr.trim().slice(0, 400) || 'git worktree remove recusou a remoção.' };
}

export interface RegisteredWorktree {
  path: string;
  branch: string | null;
  /** False when git still lists it but the directory is gone. */
  present: boolean;
}

/** Everything git currently believes is a worktree of this repository. */
export async function listWorktrees(repository: Repository): Promise<RegisteredWorktree[]> {
  const result = await git(['worktree', 'list', '--porcelain'], repository.topLevel);
  if (result.code !== 0) return [];
  const entries: RegisteredWorktree[] = [];
  let current: { path?: string; branch?: string | null } = {};
  const flush = (): void => {
    if (current.path) entries.push({ path: current.path, branch: current.branch ?? null, present: true });
    current = {};
  };
  for (const line of result.stdout.split('\n')) {
    const text = line.trim();
    if (text === '') { flush(); continue; }
    if (text.startsWith('worktree ')) { flush(); current.path = text.slice('worktree '.length); continue; }
    if (text.startsWith('branch ')) current.branch = text.slice('branch '.length).replace(/^refs\/heads\//, '');
  }
  flush();
  for (const entry of entries) {
    try {
      await fs.access(entry.path);
    } catch {
      entry.present = false;
    }
  }
  // The repository's own top level is listed first and is not a provisioned one.
  return entries.filter((entry) => canonicalize(entry.path) !== repository.topLevel);
}

export interface OrphanWorktree {
  path: string;
  repoKey: string;
  taskId: string;
  dirtyFiles: string[];
}

/**
 * Worktrees under the state root that no live task owns.
 *
 * Reports; never deletes. Deciding what is safe to remove needs the lock table,
 * which lives in the task manager — and a dirty or unattributable tree is never
 * removed at all.
 */
export async function listOrphans(stateRoot: string, isOwned: (repoKey: string, taskPrefix: string) => boolean): Promise<OrphanWorktree[]> {
  const root = path.join(stateRoot, 'worktrees');
  let repoDirs: string[];
  try {
    repoDirs = (await fs.readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
  const orphans: OrphanWorktree[] = [];
  for (const repoKey of repoDirs) {
    let taskDirs: string[];
    try {
      taskDirs = (await fs.readdir(path.join(root, repoKey), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      continue;
    }
    for (const taskPrefix of taskDirs) {
      if (isOwned(repoKey, taskPrefix)) continue;
      const target = path.join(root, repoKey, taskPrefix);
      orphans.push({ path: target, repoKey, taskId: taskPrefix, dirtyFiles: await gitStatus(target) });
    }
  }
  return orphans;
}
