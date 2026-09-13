// Process ownership: identity is proven with an exclusive hold file before
// anything is terminated, termination is scoped to one recorded process tree,
// and a run whose descendants survive is reported as not clean so the caller
// quarantines the writer lock instead of releasing it. Nothing here ever
// matches processes by name.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  claimWorkerIdentity,
  engineFileFor,
  holdFileFor,
  identityFileFor,
  isAlive,
  recordEngineExit,
  survivorCheck,
  readEngineProcess,
  readWorkerIdentity,
  recordEngineProcess,
  reconcileRunProcesses,
  verifyWorkerLiveness,
  waitForExit,
} from '../src/broker/process-tree.ts';
import { readProcessCreationIdentity, verifyProcessIdentity } from '../src/broker/process-identity.ts';
import { makeTempRoot, waitFor, type TempRoot } from './helpers/temp.ts';

let temp: TempRoot;

interface RealTree {
  child: number;
  grandchild: number;
  process: ChildProcess;
  /** Kills parent AND grandchild and waits for both to really be gone. */
  dispose(): Promise<void>;
}

/** Every tree ever spawned here, so no descendant can outlive the suite. */
const spawnedTrees: RealTree[] = [];

async function awaitGone(pid: number, createdAt?: string | null, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const alive = createdAt ? (await verifyProcessIdentity(pid, createdAt)) === 'same' : isAlive(pid);
    if (!alive) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`processo de teste ${pid} sobreviveu ao prazo de limpeza`);
}

/**
 * Starts a real child that starts a real grandchild and reports both pids.
 *
 * The grandchild holds an interval and is NOT a child of this process, so it
 * only disappears if it is killed explicitly: every caller must dispose in a
 * `finally`, even when an assertion throws.
 */
function spawnRealTree(): Promise<RealTree> {
  const script = "const cp=require('node:child_process');const g=cp.spawn(process.execPath,['-e','setInterval(()=>{},1e9)'],{stdio:'ignore'});process.stdout.write(JSON.stringify({child:process.pid,grandchild:g.pid})+'\\n');setInterval(()=>{},1e9);";
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  return new Promise((resolve, reject) => {
    child.stdout!.setEncoding('utf8');
    child.stdout!.once('data', async (chunk: string) => {
      try {
        const pids = JSON.parse(chunk.trim()) as { child: number; grandchild: number };
        const identities = {
          child: await readProcessCreationIdentity(pids.child),
          grandchild: await readProcessCreationIdentity(pids.grandchild),
        };
        let disposed = false;
        const tree: RealTree = {
          ...pids,
          process: child,
          async dispose() {
            if (disposed) return;
            disposed = true;
            for (const [pid, identity] of [[pids.grandchild, identities.grandchild], [pids.child, identities.child]] as const) {
              if (identity && await verifyProcessIdentity(pid, identity) === 'same') {
                try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
              }
            }
            await awaitGone(pids.child, identities.child);
            await awaitGone(pids.grandchild, identities.grandchild);
          },
        };
        spawnedTrees.push(tree);
        resolve(tree);
      } catch (error) {
        reject(error as Error);
      }
    });
    child.once('error', reject);
  });
}

before(async () => {
  temp = await makeTempRoot('codeorquestra-proctree-');
});
after(async () => {
  // Last resort: nothing this suite started may outlive it, even on failure.
  for (const tree of spawnedTrees) await tree.dispose();
  await temp.cleanup();
});

describe('process creation identity', () => {
  test('the OS creation instant distinguishes a live process from a recycled PID', async () => {
    const own = await readProcessCreationIdentity(process.pid);
    if (own === null) {
      assert.fail('this platform must expose a process creation identity for the runtime to terminate anything');
    }
    assert.notEqual(own, '', 'the running process reports a creation instant');
    // A PID that cannot exist reports "not running", never an identity.
    assert.equal(await readProcessCreationIdentity(2147483646), '');
    assert.equal(await verifyProcessIdentity(process.pid, own), 'same');
    // Same PID, different creation instant: the recorded process is gone and
    // whatever runs now belongs to somebody else. Never ours to terminate.
    assert.equal(await verifyProcessIdentity(process.pid, '1999-01-01T00:00:00.0000000Z'), 'recycled');
    assert.equal(await verifyProcessIdentity(2147483646, own), 'gone');
    // Without a recorded identity, the answer is never "same".
    assert.equal(await verifyProcessIdentity(process.pid, null), 'unknown');
    assert.equal(await verifyProcessIdentity(process.pid, undefined), 'unknown');
  });
});

describe('worker identity', () => {
  test('ownership follows the creation identity, not the PID, and an unprovable owner is never claimed', async () => {
    const runDir = path.join(temp.root, 'run-identity');
    const claim = claimWorkerIdentity(runDir, 'token-abc');
    try {
      await claim.ready;
      const recorded = readWorkerIdentity(runDir);
      assert.ok(recorded?.createdAt, 'claiming ownership does not return before the OS creation identity is durable');
      assert.equal(recorded.pid, process.pid);
      assert.equal(recorded.token, 'token-abc');
      assert.match(recorded.startedAt, /^\d{4}-/);
      assert.equal(await verifyWorkerLiveness(runDir, recorded), 'alive', 'a running owner whose identity matches is alive');
      assert.ok(await readFile(holdFileFor(runDir)).then(() => true, () => false), 'the hold file still exists');
      // A live PID we cannot prove is ours must quarantine, never terminate.
      assert.equal(await verifyWorkerLiveness(runDir, { ...recorded, createdAt: null }), 'unknown');
      // A live PID whose creation instant differs is a recycled PID: our worker
      // is gone and that process is not ours to touch.
      assert.equal(await verifyWorkerLiveness(runDir, { ...recorded, createdAt: '1999-01-01T00:00:00.0000000Z' }), 'gone');
      assert.equal(await verifyWorkerLiveness(runDir, { ...recorded, pid: 2147483646 }), 'gone');
    } finally {
      claim.release();
    }
    assert.equal(await verifyWorkerLiveness(runDir, readWorkerIdentity(runDir)), 'gone', 'releasing the hold makes the owner provably gone');
  });

  test('a corrupt or foreign identity file is not accepted as proof', async () => {
    const runDir = path.join(temp.root, 'run-corrupt');
    await mkdir(runDir, { recursive: true });
    await writeFile(identityFileFor(runDir), 'not json');
    assert.equal(readWorkerIdentity(runDir), null);
    await writeFile(identityFileFor(runDir), JSON.stringify({ pid: 'nao-numero', token: 1 }));
    assert.equal(readWorkerIdentity(runDir), null);
    assert.equal(readEngineProcess(runDir), null, 'a missing engine record is null, never a guessed pid');
    // With no proof at all and no hold file, the run is treated as gone rather
    // than as a live process to terminate.
    assert.equal(await verifyWorkerLiveness(runDir, null), 'gone');
  });
});

describe('scoped termination', () => {
  test('reconciliation terminates the recorded tree including grandchildren and reports it clean', async () => {
    const runDir = path.join(temp.root, 'run-tree');
    await mkdir(runDir, { recursive: true });
    const tree = await spawnRealTree();
    const bystander = await spawnRealTree();
    try {
      recordEngineProcess(runDir, tree.child);
      assert.equal(readEngineProcess(runDir)?.pid, tree.child);
      assert.ok(isAlive(tree.child) && isAlive(tree.grandchild));

      await waitFor(async () => (readEngineProcess(runDir)?.createdAt ? true : undefined), { timeoutMs: 15000, description: 'engine creation identity recorded' });
      const reconciliation = await reconcileRunProcesses(runDir, null);
      assert.deepEqual(reconciliation.survivingPids, [], reconciliation.note);
      assert.deepEqual(reconciliation.unverifiedPids, []);
      assert.equal(reconciliation.clean, true, reconciliation.note);
      assert.deepEqual(reconciliation.targets.map((target) => [target.name, target.outcome, target.identity]), [['engine', 'terminated', 'same']]);
      await waitFor(async () => (!isAlive(tree.child) && !isAlive(tree.grandchild) ? true : undefined), { timeoutMs: 10000, description: 'recorded tree exits' });

      assert.ok(isAlive(bystander.child), 'an unrelated process with a similar command line is untouched');
      assert.ok(isAlive(bystander.grandchild), 'and so are its descendants');
    } finally {
      await tree.dispose();
      await bystander.dispose();
    }
  });

  test('a parent that exited is not proof its tree did: a surviving descendant keeps the run dirty', async () => {
    const runDir = path.join(temp.root, 'run-orphan');
    await mkdir(runDir, { recursive: true });
    const tree = await spawnRealTree();
    try {
      recordEngineProcess(runDir, tree.child);
      await waitFor(async () => (readEngineProcess(runDir)?.createdAt ? true : undefined), { timeoutMs: 15000, description: 'engine creation identity recorded' });
      // Kill ONLY the parent, exactly as a crashing CLI would: its grandchild
      // keeps running, orphaned. Then record the exit the worker would record.
      tree.process.kill('SIGKILL');
      await waitFor(async () => (!isAlive(tree.child) ? true : undefined), { timeoutMs: 15000, description: 'engine parent exits' });
      recordEngineExit(runDir, null, 'SIGKILL');
      assert.ok(isAlive(tree.grandchild), 'the orphaned descendant is still running');

      // The recorded exit proves the parent finished, never the tree. The
      // descendant must be found and cleared before the run may be called clean.
      const reconciliation = await reconcileRunProcesses(runDir, null);
      if (process.platform === 'win32') {
        assert.equal(reconciliation.clean, false, 'a vanished ancestry link prevents proof even on Windows');
        // The orphan may have ended on its own or with its console host. Either
        // observation is still insufficient to prove that every historical
        // branch ended, so the safety assertion is the quarantine above.
      } else {
        assert.equal(reconciliation.clean, false, 'reparenting prevents proof after the parent exits');
        assert.ok(isAlive(tree.grandchild), 'an unattributable POSIX orphan is quarantined, not killed');
      }
    } finally {
      await tree.dispose();
    }
  });

  test('a PID that is alive but unprovable is quarantined, never terminated', async () => {
    const runDir = path.join(temp.root, 'run-unverified');
    await mkdir(runDir, { recursive: true });
    const tree = await spawnRealTree();
    try {
      // Recorded without a creation identity: exactly the state where a PID could
      // already have been recycled into an unrelated process.
      await writeFile(engineFileFor(runDir), JSON.stringify({ pid: tree.child, recordedAt: new Date().toISOString(), createdAt: null }));
      const reconciliation = await reconcileRunProcesses(runDir, null);
      assert.equal(reconciliation.clean, false, 'an unprovable process cannot be called clean');
      assert.deepEqual(reconciliation.unverifiedPids, [tree.child]);
      assert.deepEqual(reconciliation.survivingPids, []);
      assert.match(reconciliation.note, /sem identidade comprovada/);
      assert.ok(isAlive(tree.child), 'the process was NOT terminated on liveness alone');
      assert.ok(isAlive(tree.grandchild));
      // Ownership stays quarantined while that process still runs.
      const blocked = await survivorCheck(runDir, null);
      assert.equal(blocked.releasable, false);
      assert.ok(blocked.livePids.includes(tree.child), JSON.stringify(blocked));
    } finally {
      await tree.dispose();
    }
  });

  test('a recycled PID is left alone and the run is not reported clean', async () => {
    const runDir = path.join(temp.root, 'run-recycled');
    await mkdir(runDir, { recursive: true });
    const bystander = await spawnRealTree();
    try {
      // The recorded process is gone; this PID now belongs to something else.
      await writeFile(engineFileFor(runDir), JSON.stringify({ pid: bystander.child, recordedAt: new Date().toISOString(), createdAt: '1999-01-01T00:00:00.0000000Z' }));
      const reconciliation = await reconcileRunProcesses(runDir, null);
      assert.equal(reconciliation.clean, false, 'an engine that vanished without recording its exit may have left orphans');
      assert.deepEqual(reconciliation.targets.map((target) => [target.outcome, target.identity]), [['absent-unproven', 'recycled']]);
      assert.ok(isAlive(bystander.child), 'the unrelated process that inherited the PID is untouched');
    } finally {
      await bystander.dispose();
    }
  });

  test('an exited record never claims descendants of a recycled PID', async () => {
    const runDir = path.join(temp.root, 'run-exited-recycled');
    await mkdir(runDir, { recursive: true });
    const bystander = await spawnRealTree();
    try {
      await writeFile(engineFileFor(runDir), JSON.stringify({
        pid: bystander.child,
        recordedAt: new Date().toISOString(),
        createdAt: '1999-01-01T00:00:00.0000000Z',
        exitedAt: new Date().toISOString(),
      }));
      const reconciliation = await reconcileRunProcesses(runDir, null);
      assert.equal(reconciliation.clean, false);
      assert.deepEqual(reconciliation.targets.map((target) => [target.outcome, target.identity]), [['absent-unproven', 'recycled']]);
      assert.ok(isAlive(bystander.child) && isAlive(bystander.grandchild), 'the recycled owner and its descendants are untouched');
    } finally {
      await bystander.dispose();
    }
  });

  test('an engine that recorded its own exit with no descendants left is proven finished', async () => {
    const runDir = path.join(temp.root, 'run-exited');
    await mkdir(runDir, { recursive: true });
    const tree = await spawnRealTree();
    recordEngineProcess(runDir, tree.child);
    await waitFor(async () => (readEngineProcess(runDir)?.createdAt ? true : undefined), { timeoutMs: 15000, description: 'engine creation identity recorded' });
    await tree.dispose();
    recordEngineExit(runDir, 0, null);
    const reconciliation = await reconcileRunProcesses(runDir, null);
    if (process.platform === 'win32') {
      assert.equal(reconciliation.clean, true, reconciliation.note);
      assert.deepEqual(reconciliation.targets.map((target) => target.outcome), ['absent-clean']);
      assert.equal((await survivorCheck(runDir, null)).releasable, true);
    } else {
      assert.equal(reconciliation.clean, false, 'POSIX cannot prove absence after orphan reparenting');
      assert.deepEqual(reconciliation.targets.map((target) => target.outcome), ['absent-unproven']);
    }
  });

  test('strict crash recovery never treats a partial Windows PPID snapshot as complete proof', async () => {
    const runDir = path.join(temp.root, 'run-strict-recovery');
    await mkdir(runDir, { recursive: true });
    const tree = await spawnRealTree();
    try {
      recordEngineProcess(runDir, tree.child);
      await waitFor(async () => (readEngineProcess(runDir)?.createdAt ? true : undefined), { timeoutMs: 15000, description: 'engine creation identity recorded' });
      const reconciliation = await reconcileRunProcesses(runDir, null, true);
      if (process.platform === 'win32') {
        assert.equal(reconciliation.clean, false, 'post-crash PPID ancestry is only a partial view on Windows');
        assert.deepEqual(reconciliation.targets.map((target) => target.outcome), ['absent-unproven']);
      } else {
        assert.equal(reconciliation.clean, true, reconciliation.note);
      }
    } finally {
      await tree.dispose();
    }
  });

  test('reconciling a run that recorded nothing is clean and starts no process', async () => {
    const runDir = path.join(temp.root, 'run-empty');
    await mkdir(runDir, { recursive: true });
    const reconciliation = await reconcileRunProcesses(runDir, null);
    assert.equal(reconciliation.clean, true);
    assert.deepEqual(reconciliation.targets, []);
    assert.equal(await readFile(engineFileFor(runDir), 'utf8').then(() => 'exists', () => 'absent'), 'absent');
  });

  test('waitForExit reports honestly instead of assuming an exit', async () => {
    const tree = await spawnRealTree();
    try {
      assert.equal(await waitForExit(tree.child, 300), false, 'a live process is not reported as exited');
      tree.process.kill('SIGKILL');
      assert.equal(await waitForExit(tree.child, 10000), true);
    } finally {
      await tree.dispose();
    }
  });

  test('this suite leaves no process of its own behind', async () => {
    // Guards the guard: every tree spawned so far must already be disposed, so
    // a descendant can never outlive the run and hold a checkout open.
    for (const tree of spawnedTrees) await tree.dispose();
    const alive = spawnedTrees.filter((tree) => isAlive(tree.child) || isAlive(tree.grandchild));
    assert.deepEqual(alive.map((tree) => [tree.child, tree.grandchild]), [], 'nenhum processo de teste sobreviveu');
  });
});
