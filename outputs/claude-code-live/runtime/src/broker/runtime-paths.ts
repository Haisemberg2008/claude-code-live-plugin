// Resolves where the runtime's own entrypoints and assets live, both when
// running from TypeScript sources (tests) and from the bundled dist/.
import { promises as fs, existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEnv } from '../shared/env.ts';
import { BRAND, RUNTIME_VERSION } from '../shared/types.ts';

const here = fileURLToPath(import.meta.url);
export const SOURCE_MODE = here.endsWith('.ts');
/** runtime/ in source mode; dist/ in bundle mode. */
export const RUNTIME_BASE = SOURCE_MODE ? path.resolve(path.dirname(here), '..', '..') : path.dirname(here);

export function workerEntry(): string {
  return readEnv('WORKER_ENTRY') ?? (SOURCE_MODE ? path.join(RUNTIME_BASE, 'src', 'worker', 'main.ts') : path.join(RUNTIME_BASE, 'worker.mjs'));
}

export function cliEntry(): string {
  return SOURCE_MODE ? path.join(RUNTIME_BASE, 'src', 'cli', 'main.ts') : path.join(RUNTIME_BASE, 'codeorquestra.mjs');
}

export function nodeExecArgv(): string[] {
  return SOURCE_MODE ? ['--experimental-strip-types', '--disable-warning=ExperimentalWarning'] : [];
}

export function dashboardDir(): string | null {
  const candidates = [
    readEnv('DASHBOARD_DIR'),
    SOURCE_MODE ? path.join(RUNTIME_BASE, 'dist', 'dashboard') : path.join(RUNTIME_BASE, 'dashboard'),
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) if (existsSync(path.join(candidate, 'index.html'))) return candidate;
  return null;
}

export function defaultStateRoot(): string {
  const base = process.platform === 'win32' ? (process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')) : path.join(os.homedir(), '.local', 'state');
  // The directory name stays on the legacy identifier so existing installs,
  // panels and state keep working after the rename.
  return path.join(base, 'CodexClaudeLive', 'v2');
}

export interface EngineInfo {
  runtimeVersion: string;
  productName: string;
}

export function engineInfo(): EngineInfo {
  return { runtimeVersion: RUNTIME_VERSION, productName: BRAND.name };
}

/** Version of the Claude Code package the resolved executable belongs to. */
export function installedCliPackageVersion(packageDir: string | null): string | null {
  if (!packageDir) return null;
  try {
    const parsed = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8')) as { version?: string };
    return parsed.version ?? null;
  } catch {
    return null;
  }
}

/** Finds the installed `claude` launcher on PATH. Never a bundled copy. */
export async function findClaudeLauncher(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const override = readEnv('TEST_CLI', env) ?? readEnv('CLAUDE_LAUNCHER', env);
  if (override) return override;
  const names = process.platform === 'win32' ? ['claude.ps1', 'claude.cmd', 'claude.exe', 'claude'] : ['claude'];
  for (const dir of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        // continue
      }
    }
  }
  return null;
}
