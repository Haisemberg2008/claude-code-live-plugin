// CodeOrquestra CLI: starts or attaches to the local broker, registers the
// current Codex task (bootstrap handle), mints dashboard links, starts runs
// from a job file and runs a read-only doctor. It never authenticates and
// never generates on its own.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Broker } from '../broker/broker.ts';
import { brokerApi, readBrokerInfo } from '../broker/client.ts';
import { defaultStateRoot, findClaudeLauncher, engineInfo, RUNTIME_BASE, SOURCE_MODE } from '../broker/runtime-paths.ts';
import { resolveClaudeExecutable, REQUIRED_CLI_FLAGS } from '../preflight/cli-resolver.ts';
import { probeCli } from '../preflight/cli-probe.ts';
import { BRAND, RUNTIME_VERSION } from '../shared/types.ts';
import { isHarness, readEnv } from '../shared/env.ts';
import { SingletonBusyError } from '../broker/singleton.ts';
import type { SupervisionThresholds } from '../worker/supervision.ts';

interface Parsed {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq > 0) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else if (index + 1 < argv.length && !argv[index + 1]!.startsWith('--')) {
        flags[arg.slice(2)] = argv[index + 1]!;
        index += 1;
      } else {
        flags[arg.slice(2)] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function usage(): string {
  return [
    `${BRAND.name} ${RUNTIME_VERSION} — ${BRAND.tagline}`,
    BRAND.disclaimer,
    `Identificador técnico: ${BRAND.technicalId} (alias legado: ${BRAND.legacyTechnicalId}).`,
    '',
    'Comandos:',
    '  broker start [--state-root <dir>] [--port <n>] [--announce-json]   inicia o broker local (127.0.0.1)',
    '  broker status [--state-root <dir>]                                  mostra se o broker está ativo',
    '  broker stop [--state-root <dir>]                                    encerra o broker e seus workers',
    '  task register [--state-root <dir>] [--thread-id <id>]               registra a tarefa Codex atual e imprime o handle',
    '  task review [--task-handle <h>] [--note <texto>]                    confirma a revisão de uma execução incerta',
    '  dashboard [--state-root <dir>] [--task-handle <h>]                  imprime um link de uso único para o painel',
    '  worktree enable --repo <dir> --note <motivo>                        habilita worktrees paralelos neste repositório',
    '  worktree list                                                       lista repositórios habilitados e worktrees órfãos',
    '  start --job <job.json> --task-handle <h> [--state-root <dir>]       inicia uma execução v2 na tarefa',
    '  doctor [--json]                                                     verifica o Claude Code instalado sem autenticar',
    '  --version',
  ].join('\n');
}

const api = brokerApi;

function parseSupervision(): SupervisionThresholds | undefined {
  const raw = readEnv('TEST_SUPERVISION_MS');
  if (!raw || !isHarness()) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<SupervisionThresholds>;
    return { inactivityAlertMs: parsed.inactivityAlertMs ?? 1_200_000, elapsedAlertMs: parsed.elapsedAlertMs ?? 7_200_000, coordinatorAbsentMs: parsed.coordinatorAbsentMs ?? 90_000 };
  } catch {
    return undefined;
  }
}

async function doctor(json: boolean): Promise<number> {
  const launcher = await findClaudeLauncher();
  const report: Record<string, unknown> = {
    product: engineInfo().productName,
    technicalId: BRAND.technicalId,
    legacyTechnicalId: BRAND.legacyTechnicalId,
    version: RUNTIME_VERSION,
    node: process.version,
    runtimeMode: SOURCE_MODE ? 'source' : 'bundle',
    runtimeBase: RUNTIME_BASE,
    engine: 'cli-instalado-do-usuario',
    vendorSdkBundled: false,
    requiredCliFlags: REQUIRED_CLI_FLAGS.length,
    cli: { status: 'not_found', launcher, executablePath: null as string | null, kind: null as string | null, version: null as string | null, advertisedFlags: null as number | null, missingFlags: null as string[] | null, vendorCliUsed: false },
    authenticated: null,
    note: 'doctor executa somente --version, --help e auth status --json do Claude Code instalado; nunca autentica nem gera.',
  };
  if (launcher) {
    const resolved = await resolveClaudeExecutable({ launcherPath: launcher });
    if (resolved.status === 'resolved') {
      report.cli = { status: 'resolved', launcher, executablePath: resolved.executablePath, kind: resolved.kind, version: resolved.packageVersion, advertisedFlags: null, missingFlags: null, vendorCliUsed: false };
      try {
        const probe = await probeCli(resolved, { timeoutMs: 20000 });
        const cli = report.cli as Record<string, unknown>;
        cli.version = probe.cliVersion;
        cli.advertisedFlags = probe.advertisedFlags?.length ?? null;
        cli.missingFlags = probe.advertisedFlags ? REQUIRED_CLI_FLAGS.filter((flag) => !probe.advertisedFlags!.includes(flag)) : null;
      } catch (error) {
        (report.cli as Record<string, unknown>).probeError = (error as { code?: string }).code ?? 'PROBE_FAILED';
      }
    }
  }
  process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : `${usage()}\n\n${JSON.stringify(report, null, 2)}\n`);
  return 0;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  if (flags.version || positional[0] === '--version') {
    process.stdout.write(`codeorquestra ${RUNTIME_VERSION} (${BRAND.legacyTechnicalId})\n`);
    return 0;
  }
  const stateRoot = typeof flags['state-root'] === 'string' ? path.resolve(flags['state-root']) : defaultStateRoot();
  const [command, sub] = positional;
  if (command === 'broker' && sub === 'start') {
    const supervision = parseSupervision();
    const broker = new Broker({
      stateRoot,
      port: typeof flags.port === 'string' ? Number(flags.port) : 0,
      announceJson: flags['announce-json'] === true,
      harness: isHarness(),
      ...(supervision ? { supervision } : {}),
    });
    let announcement;
    try {
      announcement = await broker.start();
    } catch (error) {
      if (error instanceof SingletonBusyError) {
        process.stderr.write(`${error.message}\n`);
        return 4;
      }
      throw error;
    }
    process.stdout.write(flags['announce-json'] === true ? `${JSON.stringify(announcement)}\n` : `Broker ativo em ${announcement.baseUrl}\nPainel (link de uso único): ${announcement.bootstrapUrl}\n`);
    const shutdown = () => void broker.stop().then(() => process.exit(0));
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    await new Promise(() => undefined);
    return 0;
  }
  if (command === 'broker' && sub === 'status') {
    const info = await readBrokerInfo(stateRoot);
    process.stdout.write(`${JSON.stringify(info ? { active: true, pid: info.pid, port: info.port, baseUrl: info.baseUrl } : { active: false }, null, 2)}\n`);
    return 0;
  }
  if (command === 'broker' && sub === 'stop') {
    const info = await readBrokerInfo(stateRoot);
    if (!info) {
      process.stdout.write('Nenhum broker ativo.\n');
      return 0;
    }
    const result = await api(stateRoot, 'POST', '/api/broker/shutdown', {});
    process.stdout.write(`${JSON.stringify(result.body)}\n`);
    return 0;
  }
  if (command === 'task' && sub === 'register') {
    const threadId = process.env.CODEX_THREAD_ID ?? (typeof flags['thread-id'] === 'string' ? flags['thread-id'] : null);
    const source = process.env.CODEX_THREAD_ID ? 'codex-thread' : typeof flags['thread-id'] === 'string' ? 'job' : null;
    if (!threadId || !source) {
      process.stderr.write('CODEX_THREAD_ID ausente. Execute este comando no terminal da tarefa Codex atual (ou informe --thread-id explicitamente fora do Codex).\n');
      return 2;
    }
    const result = await api(stateRoot, 'POST', '/api/tasks/register', { codexThreadId: threadId, source });
    process.stdout.write(`${JSON.stringify({ ...(result.body as object), source, note: 'Guarde o taskHandle nesta tarefa; ele é a capacidade que autoriza as ferramentas MCP e não deve ser compartilhado.' }, null, 2)}\n`);
    return result.status === 201 ? 0 : 1;
  }
  if (command === 'task' && sub === 'review') {
    if (typeof flags['task-handle'] !== 'string') {
      process.stderr.write('Use: task review --task-handle <handle> [--note <texto>]\n');
      return 2;
    }
    const bound = await api(stateRoot, 'POST', '/api/tasks/by-handle', { taskHandle: flags['task-handle'] });
    if (bound.status !== 200) {
      process.stdout.write(`${JSON.stringify(bound.body)}\n`);
      return 1;
    }
    const { taskId } = bound.body as { taskId: string };
    const result = await api(stateRoot, 'POST', `/api/tasks/${taskId}/acknowledge-review`, { taskHandle: flags['task-handle'], note: typeof flags.note === 'string' ? flags.note : null });
    process.stdout.write(`${JSON.stringify(result.body, null, 2)}\n`);
    return result.status === 200 ? 0 : 1;
  }
  if (command === 'worktree' && sub === 'enable') {
    // Enrolling a repository is a local, explained decision by the user, not
    // something a task can grant itself: creating a worktree writes into the
    // repository's shared admin directory and leaves a lasting branch ref.
    const repo = typeof flags.repo === 'string' ? flags.repo : process.cwd();
    if (typeof flags.note !== 'string' || !flags.note.trim()) {
      process.stderr.write('Use: worktree enable --repo <caminho> --note <motivo>\nA nota fica registrada junto com a permissão; permissão sem motivo vale menos que nenhum registro.\n');
      return 2;
    }
    const payload: Record<string, unknown> = { repo, note: flags.note };
    if (typeof flags['max-parallel'] === 'string') payload.maxParallelRuns = Number(flags['max-parallel']);
    if (typeof flags['max-retained'] === 'string') payload.maxRetainedWorktrees = Number(flags['max-retained']);
    if (typeof flags['worktree-root'] === 'string') payload.worktreeRoot = flags['worktree-root'];
    const result = await api(stateRoot, 'POST', '/api/repos/worktree-policy', payload);
    process.stdout.write(`${JSON.stringify(result.body, null, 2)}\n`);
    return result.status === 200 ? 0 : 1;
  }
  if (command === 'worktree' && sub === 'list') {
    const result = await api(stateRoot, 'GET', '/api/worktrees');
    process.stdout.write(`${JSON.stringify(result.body, null, 2)}\n`);
    return result.status === 200 ? 0 : 1;
  }
  if (command === 'dashboard') {
    const result = await api(stateRoot, 'POST', '/api/dashboard-url', typeof flags['task-handle'] === 'string' ? { taskHandle: flags['task-handle'] } : {});
    process.stdout.write(`${JSON.stringify(result.body, null, 2)}\n`);
    return result.status === 200 ? 0 : 1;
  }
  if (command === 'start') {
    if (typeof flags.job !== 'string' || typeof flags['task-handle'] !== 'string') {
      process.stderr.write('Use: start --job <job.json> --task-handle <handle>\n');
      return 2;
    }
    const job = JSON.parse(await fs.readFile(flags.job, 'utf8')) as unknown;
    const bound = await api(stateRoot, 'POST', '/api/tasks/by-handle', { taskHandle: flags['task-handle'] });
    if (bound.status !== 200) {
      process.stdout.write(`${JSON.stringify(bound.body)}\n`);
      return 1;
    }
    const { taskId } = bound.body as { taskId: string };
    const result = await api(stateRoot, 'POST', `/api/tasks/${taskId}/runs`, { taskHandle: flags['task-handle'], job, ...(flags['acknowledge-review'] === true ? { acknowledgeReview: true } : {}) });
    process.stdout.write(`${JSON.stringify(result.body, null, 2)}\n`);
    return result.status === 202 ? 0 : 1;
  }
  if (command === 'doctor') return doctor(flags.json === true);
  process.stdout.write(`${usage()}\n`);
  return command ? 2 : 0;
}

const isEntry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url : false;
if (isEntry) {
  main().then((code) => { if (code !== 0) process.exitCode = code; }).catch((error) => {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
  });
}
