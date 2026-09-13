// Trust approvals live outside the checkout, keyed by canonical project path.
// A record stores the approved items with their content hashes, the identity
// that approved and the approval revision; any material change invalidates.
// An incomplete inventory can never be reported as trusted.
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic, readJsonShared } from '../state/atomic-file.ts';
import type { InventoryItem, InventorySnapshot } from './inventory.ts';

export interface TrustIdentity {
  threadId: string;
  source: 'codex-thread' | 'codex-session' | 'job' | 'browser' | 'local-secret' | 'mcp';
}

export interface TrustRecord {
  canonicalWorkspace: string;
  fingerprint: string;
  identity: TrustIdentity;
  approvalRevision: number;
  approvedAt: string;
  note: string | null;
  approvedItems: Array<{ relativePath: string; sha256: string; kind: InventoryItem['kind']; scope: InventoryItem['scope'] }>;
  mcpServers: Record<string, { approved: boolean; externalMutations: 'escalate' }>;
  file: string;
  /** Present when this approval was inherited from another checkout's record. */
  derivedFrom?: { canonicalWorkspace: string; approvalRevision: number; fingerprint: string };
}

export type TrustCheck =
  | { trusted: true; approvalRevision: number | null; pending: string[]; changed: string[]; reason: 'TRUSTED' | 'NO_CUSTOMIZATIONS' }
  | { trusted: false; reason: 'NOT_APPROVED' | 'FINGERPRINT_CHANGED' | 'PENDING_RESOURCES' | 'INVENTORY_INCOMPLETE'; changed: string[]; pending: string[] };

export interface ApproveInput {
  inventory: InventorySnapshot;
  identity: TrustIdentity;
  approvalRevision: number;
  approvedItems: string[] | 'all';
  approvedRevisionNote?: string;
}

export class TrustStoreError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'TrustStoreError';
    this.code = code;
  }
}

export class TrustStore {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  private fileFor(canonicalWorkspace: string): string {
    return path.join(this.root, 'trust', `${createHash('sha256').update(canonicalWorkspace).digest('hex')}.json`);
  }

  async approve(input: ApproveInput): Promise<TrustRecord> {
    if (input.inventory.incomplete) throw new TrustStoreError('INVENTORY_INCOMPLETE', 'O inventário está incompleto; aprove somente após a descoberta completa.');
    const approvedSet = input.approvedItems === 'all' ? null : new Set(input.approvedItems);
    const approvedItems = input.inventory.items
      .filter((item) => approvedSet === null || approvedSet.has(item.relativePath))
      .map((item) => ({ relativePath: item.relativePath, sha256: item.sha256, kind: item.kind, scope: item.scope }));
    const mcpServers: TrustRecord['mcpServers'] = {};
    for (const item of approvedItems) {
      if (item.kind !== 'mcp') continue;
      const name = item.relativePath.split('#').pop() ?? '';
      if (name && name !== 'parse-error') mcpServers[name] = { approved: true, externalMutations: 'escalate' };
    }
    const file = this.fileFor(input.inventory.canonicalWorkspace);
    const record: TrustRecord = {
      canonicalWorkspace: input.inventory.canonicalWorkspace,
      fingerprint: input.inventory.fingerprint,
      identity: input.identity,
      approvalRevision: input.approvalRevision,
      approvedAt: new Date().toISOString(),
      note: input.approvedRevisionNote ?? null,
      approvedItems,
      mcpServers,
      file,
    };
    await fs.mkdir(path.dirname(file), { recursive: true });
    await writeFileAtomic(file, JSON.stringify(record, null, 2));
    return record;
  }

  async load(canonicalWorkspace: string): Promise<TrustRecord | null> {
    const read = await readJsonShared<TrustRecord>(this.fileFor(canonicalWorkspace));
    return read.status === 'ok' ? read.value : null;
  }

  /**
   * Reuses a parent checkout's approval for a worktree of the same repository.
   *
   * A worktree is a new canonical path, so it has no record of its own and the
   * first parallel run would be refused with WORKSPACE_NOT_TRUSTED — pushing
   * the user to approve without reading anything. Derivation avoids that
   * without weakening the invariant, stated precisely:
   *
   *   no resource executes whose exact content hash the user has not already
   *   approved for this project.
   *
   * So every item in the child must have an identical (relativePath, sha256)
   * among the parent's approved items. One new or changed file and this returns
   * null, falling through to the normal refusal with pending/changed populated.
   * It reuses an approval; it never manufactures one.
   *
   * The child may legitimately be a strict SUBSET — ancestor-scope items the
   * state-root worktree does not have — which is why absence is not a mismatch.
   *
   * Known and deliberate limit: comparison is over bytes, so a repository whose
   * checkout settings rewrite text on checkout (notably `core.autocrlf=true` on
   * Windows, where the worktree gets CRLF while the parent working tree holds
   * LF) produces different hashes for the same instruction file, and derivation
   * refuses. That refusal is correct — the bytes the CLI would load really are
   * different — and the cost is bounded: the worktree path is deterministic per
   * task, so the user approves it once, not once per run. Normalizing line
   * endings before hashing would make trust equality mean something weaker than
   * "these exact bytes", which is not a trade worth making here.
   */
  async deriveFromParent(input: { child: InventorySnapshot; parentCanonicalWorkspace: string }): Promise<TrustRecord | null> {
    if (input.child.incomplete) return null;
    const parent = await this.load(input.parentCanonicalWorkspace);
    if (!parent) return null;
    const approved = new Map(parent.approvedItems.map((item) => [item.relativePath, item.sha256]));
    for (const item of input.child.items) {
      if (approved.get(item.relativePath) !== item.sha256) return null;
    }
    const file = this.fileFor(input.child.canonicalWorkspace);
    const record: TrustRecord = {
      canonicalWorkspace: input.child.canonicalWorkspace,
      fingerprint: input.child.fingerprint,
      identity: parent.identity,
      approvalRevision: parent.approvalRevision,
      approvedAt: new Date().toISOString(),
      note: `Herdado de ${parent.canonicalWorkspace}: todo item bate por hash com uma aprovação existente.`,
      approvedItems: input.child.items.map((item) => ({ relativePath: item.relativePath, sha256: item.sha256, kind: item.kind, scope: item.scope })),
      mcpServers: parent.mcpServers,
      file,
      derivedFrom: { canonicalWorkspace: parent.canonicalWorkspace, approvalRevision: parent.approvalRevision, fingerprint: parent.fingerprint },
    };
    await fs.mkdir(path.dirname(file), { recursive: true });
    await writeFileAtomic(file, JSON.stringify(record, null, 2));
    return record;
  }

  async check(inventory: InventorySnapshot): Promise<TrustCheck> {
    const all = inventory.items.map((item) => item.relativePath).sort();
    if (inventory.incomplete) return { trusted: false, reason: 'INVENTORY_INCOMPLETE', changed: [], pending: all };
    const record = await this.load(inventory.canonicalWorkspace);
    if (!record) {
      if (all.length === 0) return { trusted: true, approvalRevision: null, pending: [], changed: [], reason: 'NO_CUSTOMIZATIONS' };
      return { trusted: false, reason: 'NOT_APPROVED', changed: [], pending: all };
    }
    // A derived record is only as valid as the one it came from. Without this,
    // revoking a project's trust would leave every worktree derived from it
    // still trusted — the approval would outlive its own withdrawal.
    if (record.derivedFrom) {
      const parent = await this.load(record.derivedFrom.canonicalWorkspace);
      if (!parent || parent.fingerprint !== record.derivedFrom.fingerprint) {
        return { trusted: false, reason: 'NOT_APPROVED', changed: [], pending: all };
      }
    }
    const approved = new Map(record.approvedItems.map((item) => [item.relativePath, item.sha256]));
    const current = new Map(inventory.items.map((item) => [item.relativePath, item.sha256]));
    const changed = [...current.entries()].filter(([key, hash]) => approved.has(key) && approved.get(key) !== hash).map(([key]) => key);
    for (const key of approved.keys()) if (!current.has(key)) changed.push(key);
    changed.sort();
    const pending = [...current.keys()].filter((key) => !approved.has(key)).sort();
    if (changed.length) return { trusted: false, reason: 'FINGERPRINT_CHANGED', changed, pending };
    if (pending.length) return { trusted: false, reason: 'PENDING_RESOURCES', changed: [], pending };
    return { trusted: true, approvalRevision: record.approvalRevision, pending: [], changed: [], reason: 'TRUSTED' };
  }

  async revoke(canonicalWorkspace: string): Promise<void> {
    await fs.rm(this.fileFor(canonicalWorkspace), { force: true });
  }
}
