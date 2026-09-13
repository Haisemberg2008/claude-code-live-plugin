// Probes the installed CLI without authenticated generation: `--version`,
// `--help` (advertised flags) and `auth status --json` (read-only). Raw
// output is never persisted; only sanitized fields survive.
import { spawn } from 'node:child_process';
import type { AuthStatusSummary, ProbeResult, ResolvedExecutable } from './cli-resolver.ts';

export interface ProbeInvocation {
  args: string[];
  timeoutMs?: number;
}

function run(executable: Extract<ResolvedExecutable, { status: 'resolved' }>, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const command = executable.runWith === 'node' ? process.execPath : executable.executablePath;
    const argv = executable.runWith === 'node' ? [executable.executablePath, ...args] : args;
    const child = spawn(command, argv, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' } });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { if (stdout.length < 1_000_000) stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { if (stderr.length < 100_000) stderr += chunk; });
    const timer = setTimeout(() => { child.kill(); reject(Object.assign(new Error('timeout'), { code: 'PROBE_TIMEOUT' })); }, timeoutMs);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

export function parseVersion(text: string): string | null {
  const match = /(\d+\.\d+\.\d+)/.exec(text);
  return match ? match[1]! : null;
}

export function parseAdvertisedFlags(helpText: string): string[] {
  const flags = new Set<string>();
  for (const match of helpText.matchAll(/(--[a-z][a-z0-9-]*)/g)) flags.add(match[1]!);
  return [...flags].sort();
}

export function sanitizeAuthStatus(raw: unknown): AuthStatusSummary | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  return {
    loggedIn: typeof value.loggedIn === 'boolean' ? value.loggedIn : null,
    authMethod: typeof value.authMethod === 'string' ? value.authMethod : null,
    apiProvider: typeof value.apiProvider === 'string' ? value.apiProvider : null,
    subscriptionType: typeof value.subscriptionType === 'string' ? value.subscriptionType : null,
  };
}

export async function probeCli(executable: Extract<ResolvedExecutable, { status: 'resolved' }>, options: { timeoutMs?: number } = {}): Promise<ProbeResult> {
  const timeoutMs = options.timeoutMs ?? 30000;
  const version = await run(executable, ['--version'], timeoutMs);
  if (version.code !== 0) throw Object.assign(new Error('claude --version falhou'), { code: 'VERSION_EXIT_NONZERO' });
  const help = await run(executable, ['--help'], timeoutMs);
  const advertisedFlags = help.code === 0 ? parseAdvertisedFlags(`${help.stdout}\n${help.stderr}`) : null;
  let authStatus: AuthStatusSummary | null = null;
  try {
    const auth = await run(executable, ['auth', 'status', '--json'], timeoutMs);
    if (auth.code === 0) {
      const start = auth.stdout.indexOf('{');
      authStatus = start >= 0 ? sanitizeAuthStatus(JSON.parse(auth.stdout.slice(start))) : null;
    }
  } catch {
    authStatus = null;
  }
  return { cliVersion: parseVersion(version.stdout), advertisedFlags, authStatus };
}

export async function queryUsageText(executable: Extract<ResolvedExecutable, { status: 'resolved' }>, timeoutMs = 45000): Promise<string> {
  const outcome = await run(executable, ['--safe-mode', '--tools', '', '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--output-format', 'json', '-p', '/usage'], timeoutMs);
  if (outcome.code !== 0) throw Object.assign(new Error('consulta /usage falhou'), { code: 'USAGE_QUERY_FAILED' });
  const start = outcome.stdout.indexOf('{');
  const payload = JSON.parse(outcome.stdout.slice(start)) as { result?: unknown };
  if (typeof payload.result !== 'string') throw Object.assign(new Error('resposta /usage sem result'), { code: 'USAGE_FORMAT_UNEXPECTED' });
  return payload.result;
}
