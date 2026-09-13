// Attaches to a running broker (or starts one detached) for the CLI and the
// MCP adapter, so several adapters share one broker and one worker per task.
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { readJsonShared } from '../state/atomic-file.ts';
import { cliEntry, nodeExecArgv } from './runtime-paths.ts';
import { CLIENT_HEADER } from './http.ts';

export interface BrokerInfoFile {
  pid: number;
  port: number;
  baseUrl: string;
  secretFile: string;
  startedAt?: string;
  version?: string;
}

export async function readBrokerInfo(stateRoot: string): Promise<BrokerInfoFile | null> {
  const read = await readJsonShared<BrokerInfoFile>(path.join(stateRoot, 'broker', 'broker.json'));
  if (read.status !== 'ok') return null;
  try {
    const secret = (await fs.readFile(read.value.secretFile, 'utf8')).trim();
    const response = await fetch(`${read.value.baseUrl}/api/health`, { headers: { authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(3000) });
    if (!response.ok) return null;
    const health = (await response.json()) as { pid: number };
    if (health.pid !== read.value.pid) return null;
    return read.value;
  } catch {
    return null;
  }
}

export async function ensureBroker(stateRoot: string): Promise<{ baseUrl: string; secret: string; pid: number; started: boolean }> {
  const existing = await readBrokerInfo(stateRoot);
  if (existing) return { baseUrl: existing.baseUrl, secret: (await fs.readFile(existing.secretFile, 'utf8')).trim(), pid: existing.pid, started: false };
  const child = spawn(process.execPath, [...nodeExecArgv(), cliEntry(), 'broker', 'start', '--state-root', stateRoot, '--port', '0'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: process.env,
  });
  child.unref();
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const info = await readBrokerInfo(stateRoot);
    if (info) return { baseUrl: info.baseUrl, secret: (await fs.readFile(info.secretFile, 'utf8')).trim(), pid: info.pid, started: true };
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('O broker não iniciou a tempo.');
}

export async function brokerApi(stateRoot: string, method: string, pathname: string, body?: unknown, client: 'cli' | 'mcp' = 'cli'): Promise<{ status: number; body: unknown }> {
  const broker = await ensureBroker(stateRoot);
  const response = await fetch(`${broker.baseUrl}${pathname}`, {
    method,
    headers: { authorization: `Bearer ${broker.secret}`, 'content-type': 'application/json', ...(client === 'mcp' ? { [CLIENT_HEADER]: 'mcp' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}
