// Worker process entrypoint: one process per active Codex task, started by
// the broker with an IPC channel. It loads the process boundary (a fake under
// the harness, never the installed CLI), runs the session and exits when the
// broker disconnects or after the run ends.
import { readFileSync } from 'node:fs';
import { loadEngineAdapter } from './engine-adapter.ts';
import { WorkerSession } from './session.ts';
import { redactSensitiveText } from '../events/redaction.ts';
import { claimWorkerIdentity } from '../broker/process-tree.ts';
import { readEnv, envName } from '../shared/env.ts';
import type { BrokerToWorker, WorkerDescriptor, WorkerToBroker } from './protocol.ts';

function usage(): never {
  process.stderr.write('codeorquestra worker requer --descriptor <arquivo.json> e um canal IPC do broker.\n');
  process.exit(2);
}

const args = process.argv.slice(2);
const descriptorIndex = args.indexOf('--descriptor');
if (descriptorIndex < 0 || !args[descriptorIndex + 1] || typeof process.send !== 'function') usage();

const descriptor = JSON.parse(readFileSync(args[descriptorIndex + 1]!, 'utf8')) as WorkerDescriptor;
// Hold an exclusive file for this process's lifetime. The broker uses it to
// prove, on recovery, that this exact worker is or is not still running,
// instead of trusting a PID that the operating system may have recycled.
const identityClaim = claimWorkerIdentity(descriptor.runDir, readEnv('RUN_TOKEN') ?? '');
process.on('exit', () => identityClaim.release());
const send = (message: WorkerToBroker): void => {
  try {
    process.send?.(message);
  } catch {
    // broker gone
  }
};

process.on('disconnect', () => {
  // The broker died; without it nothing can persist our events. Exit now so
  // the run is reconciled as uncertain on the next broker start.
  process.exit(3);
});

let session: WorkerSession | null = null;
const pendingMessages: BrokerToWorker[] = [];
process.on('message', (message: BrokerToWorker) => {
  if (session) session.handleBrokerMessage(message);
  else if (message.t === 'exit') process.exit(0);
  else pendingMessages.push(message);
});

// No CLI work is released until process ownership is durable. IPC handlers
// are already installed above, so a broker loss during this probe cannot be
// missed; the explicit check also covers a disconnect that happened before
// the listener was attached by the Node bootstrap itself.
await identityClaim.ready;
if (!process.connected) process.exit(3);

async function main(): Promise<void> {
  if (descriptor.harness?.effortCap && readEnv('TEST_HARNESS') === '1') process.env[envName('FAKE_EFFORT_CAP')] = descriptor.harness.effortCap;
  if (descriptor.harness?.modelCatalog && readEnv('TEST_HARNESS') === '1') process.env[envName('FAKE_MODEL_CATALOG')] = descriptor.harness.modelCatalog.join(',');
  if (descriptor.harness?.hooksApplied === false && readEnv('TEST_HARNESS') === '1') process.env[envName('FAKE_HOOKS_APPLIED')] = 'false';
  if (descriptor.harness?.setModelDelayMs && readEnv('TEST_HARNESS') === '1') process.env[envName('FAKE_SET_MODEL_DELAY_MS')] = String(descriptor.harness.setModelDelayMs);
  if (descriptor.harness?.failPreparation === 'adapter-load') {
    send({ t: 'preparation_failed', stage: 'adapter-load', code: 'ADAPTER_LOAD_FAILED', message: 'Falha simulada pelo harness ao carregar o adaptador.' });
    await settle();
    process.exit(1);
  }
  let adapter;
  try {
    adapter = await loadEngineAdapter(process.env, descriptor.harness?.adapterPath);
  } catch (error) {
    send({ t: 'preparation_failed', stage: 'adapter-load', code: (error as { code?: string }).code ?? 'ADAPTER_LOAD_FAILED', message: (error as Error).message });
    await settle();
    process.exit(1);
  }
  session = new WorkerSession(descriptor, adapter, send);
  send({ t: 'ready', simulated: adapter.simulated, adapter: adapter.simulated ? 'simulado' : 'cli-instalado' });
  for (const message of pendingMessages.splice(0)) session.handleBrokerMessage(message);
  await session.start();
  await settle();
  process.exit(0);
}

function settle(): Promise<void> {
  // Give the broker a moment to acknowledge (and to terminate our tree) so
  // descendants never outlive the run silently.
  return new Promise((resolve) => setTimeout(resolve, 3000).unref());
}

main().catch((error) => {
  // Exception text can carry paths or interpolated values; redact before IPC.
  send({ t: 'run_ended', status: 'FAIL', code: 'WORKER_CRASH', message: redactSensitiveText(String((error as Error).message ?? error)).slice(0, 300), exitCode: 1 });
  setTimeout(() => process.exit(1), 200);
});
