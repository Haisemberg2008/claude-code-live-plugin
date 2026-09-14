// Enrolling a repository for worktrees is a persistent mutation of the user's
// repository: `git worktree add` writes .git/worktrees/<n>, creates a lasting
// branch ref and materializes a second checkout. That is the same category the
// product already guards with trust, so it gets the same shape — a record
// stored outside the checkout, written only by a local administrative action,
// carrying who approved it and why.
//
// Codex asks for worktree mode in the job; the user enables the repository;
// the broker executes. Claude is never any of the three.
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic, readJsonShared } from '../state/atomic-file.ts';

/** Beyond this many retained worktrees, provisioning refuses instead of filling the disk. */
export const DEFAULT_MAX_RETAINED = 8;
/** N sessions share one account: consumption is not serialized the way observation is. */
export const DEFAULT_MAX_PARALLEL = 3;

export interface WorktreePolicyRecord {
  repoKey: string;
  /** Canonical top level at enrolment; recorded for audit, never used as the key. */
  canonicalWorkspace: string;
  enabled: boolean;
  enabledAt: string;
  enabledBy: 'local-secret' | 'mcp';
  note: string;
  maxParallelRuns: number;
  maxRetainedWorktrees: number;
  /** Overrides the default placement when the default would be too long a path. */
  worktreeRoot: string | null;
  file: string;
}

export class WorktreePolicyError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'WorktreePolicyError';
    this.code = code;
  }
}

function boundedInteger(value: unknown, field: string, min: number, max: number, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new WorktreePolicyError('WORKTREE_POLICY_INVALID', `${field} deve ser inteiro entre ${min} e ${max}.`);
  }
  return value;
}

export interface EnrolInput {
  repoKey: string;
  canonicalWorkspace: string;
  enabledBy: 'local-secret' | 'mcp';
  note: string;
  maxParallelRuns?: unknown;
  maxRetainedWorktrees?: unknown;
  worktreeRoot?: unknown;
}

export class WorktreePolicyStore {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  private fileFor(repoKey: string): string {
    return path.join(this.root, 'worktree-policy', `${createHash('sha256').update(repoKey).digest('hex')}.json`);
  }

  /**
   * Records the user's decision to allow worktrees in this repository.
   *
   * A note is mandatory, exactly as releasing a quarantine requires one: an
   * unexplained standing permission to mutate a repository is worth less than
   * no record at all.
   */
  async enrol(input: EnrolInput): Promise<WorktreePolicyRecord> {
    const note = typeof input.note === 'string' ? input.note.trim() : '';
    if (!note) throw new WorktreePolicyError('WORKTREE_POLICY_NOTE_REQUIRED', 'Habilitar worktrees exige uma nota dizendo por quê; a permissão fica registrada.');
    let worktreeRoot: string | null = null;
    if (input.worktreeRoot !== undefined && input.worktreeRoot !== null) {
      if (typeof input.worktreeRoot !== 'string' || !path.isAbsolute(input.worktreeRoot)) {
        throw new WorktreePolicyError('WORKTREE_POLICY_INVALID', 'worktreeRoot deve ser um caminho absoluto.');
      }
      worktreeRoot = input.worktreeRoot;
    }
    const file = this.fileFor(input.repoKey);
    const record: WorktreePolicyRecord = {
      repoKey: input.repoKey,
      canonicalWorkspace: input.canonicalWorkspace,
      enabled: true,
      enabledAt: new Date().toISOString(),
      enabledBy: input.enabledBy,
      note,
      maxParallelRuns: boundedInteger(input.maxParallelRuns, 'maxParallelRuns', 1, 10, DEFAULT_MAX_PARALLEL),
      maxRetainedWorktrees: boundedInteger(input.maxRetainedWorktrees, 'maxRetainedWorktrees', 1, 50, DEFAULT_MAX_RETAINED),
      worktreeRoot,
      file,
    };
    await fs.mkdir(path.dirname(file), { recursive: true });
    await writeFileAtomic(file, JSON.stringify(record, null, 2));
    return record;
  }

  async load(repoKey: string): Promise<WorktreePolicyRecord | null> {
    const read = await readJsonShared<WorktreePolicyRecord>(this.fileFor(repoKey));
    return read.status === 'ok' && read.value.enabled ? read.value : null;
  }

  /** Fails closed: a repository nobody enrolled cannot be provisioned into. */
  async require(repoKey: string): Promise<WorktreePolicyRecord> {
    const record = await this.load(repoKey);
    if (!record) {
      throw new WorktreePolicyError(
        'WORKTREE_POLICY_REQUIRED',
        'Este repositório ainda não foi habilitado para worktrees. Criar um worktree altera o repositório de forma persistente, então exige uma ação local do usuário: "codeorquestra worktree enable --repo <caminho> --note <motivo>".',
      );
    }
    return record;
  }

  async revoke(repoKey: string): Promise<void> {
    await fs.rm(this.fileFor(repoKey), { force: true });
  }

  async list(): Promise<WorktreePolicyRecord[]> {
    const dir = path.join(this.root, 'worktree-policy');
    let names: string[];
    try {
      names = (await fs.readdir(dir)).filter((name) => name.endsWith('.json'));
    } catch {
      return [];
    }
    const records: WorktreePolicyRecord[] = [];
    for (const name of names) {
      const read = await readJsonShared<WorktreePolicyRecord>(path.join(dir, name));
      if (read.status === 'ok') records.push(read.value);
    }
    return records.sort((a, b) => a.canonicalWorkspace.localeCompare(b.canonicalWorkspace));
  }
}
