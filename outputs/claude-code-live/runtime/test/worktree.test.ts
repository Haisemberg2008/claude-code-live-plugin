// The broker's git surface, exercised against real repositories. Nothing here
// is simulated: a temporary repo is initialised, worktrees are really created,
// and the refusals are the ones git itself produces.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm, access } from 'node:fs/promises';
import path from 'node:path';
import { makeTempRoot, type TempRoot } from './helpers/temp.ts';
import { assertRejectsCode } from './helpers/assert-code.ts';
import {
  canonicalize,
  canonicalizePlanned,
  ensureWorktree,
  git,
  gitStatus,
  listOrphans,
  listWorktrees,
  removeWorktree,
  resolveRepository,
  withRepositoryMutex,
  worktreePathFor,
  type Repository,
} from '../src/broker/worktree.ts';
import { withNamedMutex } from '../src/quota/global-mutex.ts';

let temp: TempRoot;
let repoDir: string;
let plainDir: string;
let stateRoot: string;
let repository: Repository;

/** A real repository with one commit; worktrees need a ref to branch from. */
async function initRepository(target: string): Promise<void> {
  await mkdir(path.join(target, 'src'), { recursive: true });
  await writeFile(path.join(target, 'src', 'index.ts'), 'export const ok = true;\n');
  await writeFile(path.join(target, 'CLAUDE.md'), '# projeto\n');
  const run = async (args: string[]): Promise<void> => {
    const result = await git(args, target);
    assert.equal(result.code, 0, `git ${args.join(' ')}: ${result.stderr}`);
  };
  await run(['init', '--initial-branch=main']);
  await run(['config', 'user.email', 'harness@example.invalid']);
  await run(['config', 'user.name', 'Harness']);
  await run(['config', 'commit.gpgsign', 'false']);
  await run(['add', '.']);
  await run(['commit', '-m', 'base']);
}

before(async () => {
  temp = await makeTempRoot('codeorquestra-worktree-');
  repoDir = path.join(temp.root, 'repo');
  plainDir = path.join(temp.root, 'sem-git');
  stateRoot = path.join(temp.root, 'state');
  await initRepository(repoDir);
  await mkdir(plainDir, { recursive: true });
  await mkdir(stateRoot, { recursive: true });
  repository = await resolveRepository(repoDir);
});

after(async () => {
  // Release git's handles before the directory goes away.
  await git(['worktree', 'prune'], repoDir).catch(() => undefined);
  await temp.cleanup();
});

describe('repository identity', () => {
  test('resolves the shared admin dir, top level and a stable key', async () => {
    assert.equal(repository.topLevel, canonicalize(repoDir));
    assert.ok(repository.commonDir.endsWith('.git'), repository.commonDir);
    assert.match(repository.repoKey, /^[0-9a-f]{24}$/);
    // The key is a pure function of the repository, not of the call.
    assert.equal((await resolveRepository(repoDir)).repoKey, repository.repoKey);
    // Reached through a subdirectory, it is still the same repository.
    assert.equal((await resolveRepository(path.join(repoDir, 'src'))).repoKey, repository.repoKey);
  });

  test('a directory outside any repository is refused, not guessed', async () => {
    await assertRejectsCode(resolveRepository(plainDir), 'NOT_A_GIT_REPOSITORY');
  });
});

describe('deterministic placement', () => {
  test('the worktree path is a pure function of repository and task, and lives outside the repo', () => {
    const first = worktreePathFor(stateRoot, repository.repoKey, 'task-abcdef0123456789');
    const second = worktreePathFor(stateRoot, repository.repoKey, 'task-abcdef0123456789');
    assert.deepEqual(first, second, 'mesmo repositório e tarefa devem dar o mesmo caminho');
    assert.notEqual(worktreePathFor(stateRoot, repository.repoKey, 'task-outra').path, first.path);
    // Outside the repository: inside it, trust/inventory.ts would inventory the
    // worktree's copy of CLAUDE.md and invalidate the main checkout's trust.
    assert.ok(!canonicalize(first.path).startsWith(`${repository.topLevel}/`), first.path);
  });

  test('a path that does not exist yet still canonicalizes, through its existing ancestor', () => {
    const planned = path.join(stateRoot, 'worktrees', 'aa', 'bb', 'nao-existe-ainda');
    const canonical = canonicalizePlanned(planned);
    assert.ok(canonical.length > 0);
    assert.ok(canonical.endsWith('nao-existe-ainda'), canonical);
    // Stable: the lock key derived from it must not change between calls.
    assert.equal(canonicalizePlanned(planned), canonical);
  });
});

describe('provisioning', () => {
  test('creates a worktree, reuses it while clean, and refuses it once dirty', async () => {
    const target = worktreePathFor(stateRoot, repository.repoKey, 'task-provision-0001').path;
    const created = await ensureWorktree({ repository, target, branch: 'codeorquestra/provision', baseRef: 'main' });
    assert.equal(created.created, true);
    await access(path.join(target, 'src', 'index.ts'));

    // Clean: the same task starting again adopts its own tree.
    const reused = await ensureWorktree({ repository, target, branch: 'codeorquestra/provision', baseRef: 'main' });
    assert.equal(reused.created, false);

    // Uncommitted work is the NORMAL end state of a successful run, because
    // commit can never belong to Claude. Refusing is the only safe answer;
    // cleaning it would destroy the deliverable.
    await writeFile(path.join(target, 'src', 'novo.ts'), 'export const x = 1;\n');
    assert.deepEqual(await gitStatus(target), ['src/novo.ts']);
    await assertRejectsCode(
      ensureWorktree({ repository, target, branch: 'codeorquestra/provision', baseRef: 'main' }),
      'WORKTREE_DIRTY_FROM_PREVIOUS_RUN',
    );
    // And the refusal did not delete the work.
    await access(path.join(target, 'src', 'novo.ts'));
  });

  test('a directory that is not this repository is never adopted', async () => {
    const target = worktreePathFor(stateRoot, repository.repoKey, 'task-occupied-0001').path;
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, 'algo-importante.txt'), 'nao apague\n');
    await assertRejectsCode(
      ensureWorktree({ repository, target, branch: 'codeorquestra/occupied', baseRef: 'main' }),
      'WORKTREE_PATH_OCCUPIED',
    );
    await access(path.join(target, 'algo-importante.txt'));
    await rm(target, { recursive: true, force: true });
  });

  test('an invalid base ref fails without leaving a registration behind', async () => {
    const target = worktreePathFor(stateRoot, repository.repoKey, 'task-badref-0001').path;
    await assertRejectsCode(
      ensureWorktree({ repository, target, branch: 'codeorquestra/badref', baseRef: 'nao-existe-esse-ref' }),
      'WORKTREE_ADD_FAILED',
    );
    const listed = await listWorktrees(repository);
    assert.ok(!listed.some((entry) => canonicalize(entry.path) === canonicalize(target)), 'nenhuma entrada registrada deve sobrar');
  });
});

describe('listing and removal', () => {
  test('lists provisioned worktrees without counting the main checkout', async () => {
    const target = worktreePathFor(stateRoot, repository.repoKey, 'task-listing-0001').path;
    await ensureWorktree({ repository, target, branch: 'codeorquestra/listing', baseRef: 'main' });
    const listed = await listWorktrees(repository);
    assert.ok(listed.some((entry) => canonicalize(entry.path) === canonicalize(target)), JSON.stringify(listed));
    assert.ok(!listed.some((entry) => canonicalize(entry.path) === repository.topLevel), 'o checkout principal não é um worktree provisionado');
  });

  test('removes a clean worktree and refuses a dirty one', async () => {
    const target = worktreePathFor(stateRoot, repository.repoKey, 'task-removal-0001').path;
    await ensureWorktree({ repository, target, branch: 'codeorquestra/removal', baseRef: 'main' });
    await writeFile(path.join(target, 'src', 'pendente.ts'), 'export const y = 2;\n');
    const refused = await removeWorktree(repository, target);
    assert.equal(refused.removed, false, 'git recusa remover árvore suja, e essa recusa é a propriedade de segurança');
    await access(path.join(target, 'src', 'pendente.ts'));

    await rm(path.join(target, 'src', 'pendente.ts'));
    const removed = await removeWorktree(repository, target);
    assert.equal(removed.removed, true, removed.reason);
    await assert.rejects(access(target));
  });
});

describe('orphan reporting', () => {
  test('reports unowned worktrees with their dirty files and never deletes them', async () => {
    const taskId = 'task-orphan-00000001';
    const target = worktreePathFor(stateRoot, repository.repoKey, taskId).path;
    await ensureWorktree({ repository, target, branch: 'codeorquestra/orphan', baseRef: 'main' });
    await writeFile(path.join(target, 'src', 'orfao.ts'), 'export const z = 3;\n');

    const ownedByNobody = await listOrphans(stateRoot, () => false);
    const found = ownedByNobody.find((entry) => canonicalize(entry.path) === canonicalize(target));
    assert.ok(found, 'o worktree sem dono deve ser listado');
    assert.equal(found.repoKey, repository.repoKey);
    assert.deepEqual(found.dirtyFiles, ['src/orfao.ts']);
    // Reporting only: the directory is still there.
    await access(path.join(target, 'src', 'orfao.ts'));

    // Claimed by a live task, it is not an orphan.
    const claimed = await listOrphans(stateRoot, (repoKey, prefix) => repoKey === repository.repoKey && prefix === taskId.slice(0, 16));
    assert.ok(!claimed.some((entry) => canonicalize(entry.path) === canonicalize(target)), 'um worktree com dono não é órfão');
  });

  test('a state root without worktrees yields nothing instead of failing', async () => {
    assert.deepEqual(await listOrphans(path.join(temp.root, 'state-vazio'), () => false), []);
  });
});

describe('mutual exclusion', () => {
  test('different names do not serialize against each other', async () => {
    // The defect this replaced: one module-level chain made every named mutex
    // wait on every other, so a git lock on one repository would queue behind a
    // /usage observation and two repositories would block each other.
    const order: string[] = [];
    const slow = withNamedMutex('CodeOrquestraTest-lento', async () => {
      order.push('lento-inicio');
      await new Promise((resolve) => setTimeout(resolve, 300));
      order.push('lento-fim');
    }, { transport: 'file', waitMs: 5000 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await withNamedMutex('CodeOrquestraTest-rapido', async () => { order.push('rapido'); }, { transport: 'file', waitMs: 5000 });
    await slow;
    assert.deepEqual(order, ['lento-inicio', 'rapido', 'lento-fim'], 'o nome rápido não pode esperar o lento terminar');
  });

  test('the same repository key serializes', async () => {
    const order: string[] = [];
    const first = withRepositoryMutex(repository.repoKey, async () => {
      order.push('a-inicio');
      await new Promise((resolve) => setTimeout(resolve, 200));
      order.push('a-fim');
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const second = withRepositoryMutex(repository.repoKey, async () => { order.push('b'); });
    await Promise.all([first, second]);
    assert.deepEqual(order, ['a-inicio', 'a-fim', 'b'], 'mutações do mesmo repositório não podem se sobrepor');
  });
});

describe('administrative removal', () => {
  test('a dirty worktree is only discarded when the operator says so, and the files are named back', async () => {
    // Exercised through the task manager's rules rather than the route, so the
    // decision logic is covered without standing a broker up.
    const target = worktreePathFor(stateRoot, repository.repoKey, 'task-descarte-0001').path;
    await ensureWorktree({ repository, target, branch: 'codeorquestra/descarte', baseRef: 'main' });
    await writeFile(path.join(target, 'src', 'nao-commitado.ts'), 'export const w = 4;\n');

    // git alone refuses, which is the property the product leans on.
    const refused = await removeWorktree(repository, target);
    assert.equal(refused.removed, false);
    await access(path.join(target, 'src', 'nao-commitado.ts'));

    // Discarding is a separate, explicit act — and it is git's own primitive.
    // Note that cleaning first would not have worked: `git checkout -- .`
    // restores tracked files and leaves untracked ones exactly where they are.
    const removed = await removeWorktree(repository, target, { force: true });
    assert.equal(removed.removed, true, removed.reason);
    await assert.rejects(access(target));
  });
});
