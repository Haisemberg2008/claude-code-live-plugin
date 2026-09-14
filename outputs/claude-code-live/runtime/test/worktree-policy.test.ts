// Enrolling a repository for worktrees is a persistent mutation of the user's
// repository, so it is stored and guarded like trust: outside the checkout,
// with who approved it and why, and failing closed when nobody has.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { makeTempRoot, type TempRoot } from './helpers/temp.ts';
import { assertRejectsCode } from './helpers/assert-code.ts';
import { WorktreePolicyStore, DEFAULT_MAX_PARALLEL, DEFAULT_MAX_RETAINED } from '../src/broker/worktree-policy.ts';

let temp: TempRoot;
let store: WorktreePolicyStore;

const repoKey = 'a1b2c3d4e5f60718293a4b5c';

before(async () => {
  temp = await makeTempRoot('codeorquestra-policy-');
  store = new WorktreePolicyStore(temp.root);
});
after(async () => { await temp.cleanup(); });

describe('repository enrolment', () => {
  test('fails closed: a repository nobody enrolled cannot be provisioned into', async () => {
    assert.equal(await store.load('nunca-habilitado'), null);
    const error = await assertRejectsCode(store.require('nunca-habilitado'), 'WORKTREE_POLICY_REQUIRED') as Error;
    // The refusal has to say what the user must do, not just that it refused.
    assert.match(error.message, /worktree enable/);
  });

  test('a note is mandatory, because an unexplained standing permission is worth less than no record', async () => {
    for (const note of ['', '   ', undefined as unknown as string]) {
      await assertRejectsCode(
        store.enrol({ repoKey, canonicalWorkspace: 'c:/repo', enabledBy: 'local-secret', note }),
        'WORKTREE_POLICY_NOTE_REQUIRED',
      );
    }
    assert.equal(await store.load(repoKey), null, 'nenhuma recusa pode deixar registro parcial');
  });

  test('records who enabled it, when and why, with bounded limits', async () => {
    const record = await store.enrol({ repoKey, canonicalWorkspace: 'c:/repo', enabledBy: 'local-secret', note: 'Duas tarefas em paralelo neste repo.' });
    assert.equal(record.enabled, true);
    assert.equal(record.repoKey, repoKey);
    assert.equal(record.enabledBy, 'local-secret');
    assert.equal(record.note, 'Duas tarefas em paralelo neste repo.');
    assert.equal(record.maxParallelRuns, DEFAULT_MAX_PARALLEL);
    assert.equal(record.maxRetainedWorktrees, DEFAULT_MAX_RETAINED);
    assert.equal(record.worktreeRoot, null);
    assert.ok(Date.parse(record.enabledAt) > 0);
    // It survives a reload: the record, not memory, is the authority.
    assert.deepEqual(await store.load(repoKey), record);
    assert.deepEqual(await store.require(repoKey), record);
  });

  test('limits are validated instead of silently clamped', async () => {
    for (const bad of [0, -1, 11, 2.5, '3']) {
      await assertRejectsCode(
        store.enrol({ repoKey, canonicalWorkspace: 'c:/repo', enabledBy: 'local-secret', note: 'x', maxParallelRuns: bad }),
        'WORKTREE_POLICY_INVALID',
      );
    }
    for (const bad of [0, 51, 'muitos']) {
      await assertRejectsCode(
        store.enrol({ repoKey, canonicalWorkspace: 'c:/repo', enabledBy: 'local-secret', note: 'x', maxRetainedWorktrees: bad }),
        'WORKTREE_POLICY_INVALID',
      );
    }
    // A relative worktreeRoot would resolve against whatever cwd the broker
    // happens to have, so it is refused rather than resolved.
    await assertRejectsCode(
      store.enrol({ repoKey, canonicalWorkspace: 'c:/repo', enabledBy: 'local-secret', note: 'x', worktreeRoot: 'relativo/demais' }),
      'WORKTREE_POLICY_INVALID',
    );
  });

  test('accepts explicit limits and an absolute override root', async () => {
    const root = path.join(temp.root, 'curto');
    const record = await store.enrol({
      repoKey, canonicalWorkspace: 'c:/repo', enabledBy: 'local-secret', note: 'limites explícitos',
      maxParallelRuns: 2, maxRetainedWorktrees: 4, worktreeRoot: root,
    });
    assert.equal(record.maxParallelRuns, 2);
    assert.equal(record.maxRetainedWorktrees, 4);
    assert.equal(record.worktreeRoot, root);
  });

  test('revoking makes the repository fail closed again, immediately', async () => {
    const other = 'ffffffffffffffffffffffff';
    await store.enrol({ repoKey: other, canonicalWorkspace: 'c:/outro', enabledBy: 'local-secret', note: 'temporário' });
    assert.ok(await store.load(other));
    await store.revoke(other);
    assert.equal(await store.load(other), null);
    await assertRejectsCode(store.require(other), 'WORKTREE_POLICY_REQUIRED');
  });

  test('listing reports every enrolled repository and tolerates an empty store', async () => {
    const listed = await store.list();
    assert.ok(listed.some((record) => record.repoKey === repoKey), JSON.stringify(listed.map((r) => r.repoKey)));
    const empty = new WorktreePolicyStore(path.join(temp.root, 'vazio'));
    assert.deepEqual(await empty.list(), []);
  });
});
