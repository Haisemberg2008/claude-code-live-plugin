import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { TaskManager } from '../src/broker/task-manager.ts';
import { makeTempRoot } from './helpers/temp.ts';

test('shutdown during recovery cancels before stale lock mutation', async () => {
  const temp = await makeTempRoot('codeorquestra-recovery-cancel-');
  const stateRoot = path.join(temp.root, 'state');
  const locksDir = path.join(stateRoot, 'locks');
  const tasksDir = path.join(stateRoot, 'tasks');
  const lockFile = path.join(locksDir, 'preserve.json');
  await mkdir(locksDir, { recursive: true });
  await mkdir(tasksDir, { recursive: true });
  await writeFile(lockFile, JSON.stringify({ holder: 'previous-broker' }));

  let entered!: () => void;
  let resume!: () => void;
  const atCheckpoint = new Promise<void>((resolve) => { entered = resolve; });
  const continueRecovery = new Promise<void>((resolve) => { resume = resolve; });
  const manager = new TaskManager({
    stateRoot,
    log: () => undefined,
    onEvent: () => undefined,
    onTaskChanged: () => undefined,
    onTransient: () => undefined,
    harness: true,
    recoveryCheckpoint: async () => { entered(); await continueRecovery; },
  });

  try {
    const starting = manager.start();
    await atCheckpoint;
    await manager.stop();
    resume();
    await assert.rejects(starting, /BROKER_STOPPED_DURING_RECOVERY/);
    assert.equal(await readFile(lockFile, 'utf8'), JSON.stringify({ holder: 'previous-broker' }), 'the former owner state is untouched after shutdown starts');
  } finally {
    resume();
    await manager.stop();
    await temp.cleanup();
  }
});
