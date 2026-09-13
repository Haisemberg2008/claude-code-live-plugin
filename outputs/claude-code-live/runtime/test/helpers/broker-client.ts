// Starts a real broker process for tests. The broker announces itself with
// one JSON line on stdout; browser-style auth uses the one-time bootstrap
// URL, CLI/MCP-style auth uses the per-user secret file. Failed starts stop
// the exact process that was spawned; stop() bounds the shutdown request.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnNode, fetchJson, type SpawnedRuntime, type JsonResponse } from './process.ts';
import { srcEntry, runtimeRoot, testHelpersDir } from './paths.ts';
import { ENV } from './scenario.ts';

export interface BrokerAnnouncement {
  event: 'broker_listening';
  address: string;
  port: number;
  baseUrl: string;
  bootstrapUrl: string;
  secretFile: string;
  stateRoot: string;
  pid: number;
  cursorEpoch: string;
}

export interface TestBroker {
  process: SpawnedRuntime;
  announcement: BrokerAnnouncement;
  baseUrl: string;
  stateRoot: string;
  secret: string;
  /** Session cookie obtained through the bootstrap redirect (browser identity). */
  cookie: string;
  bootstrapToken: string;
  setSessionCookie(cookie: string): void;
  browserHeaders(extra?: Record<string, string>): Record<string, string>;
  browserActionHeaders(extra?: Record<string, string>): Record<string, string>;
  bearerHeaders(extra?: Record<string, string>): Record<string, string>;
  api(pathname: string, init?: RequestInit): Promise<JsonResponse>;
  /** Mints a fresh one-time dashboard link so each test owns its own token. */
  mintBootstrapUrl(taskHandle?: string): Promise<string>;
  stop(): Promise<void>;
}

export const CSRF_HEADER_NAME = 'x-requested-with';
export const CSRF_HEADER_VALUE = 'codeorquestra';
export const SESSION_COOKIE_NAME = 'codeorquestra_session';
export const CLIENT_HEADER_NAME = 'x-codeorquestra-client';

/** Redeems a one-time bootstrap URL and returns the `name=value` cookie pair. */
export async function redeemBootstrap(bootstrapUrl: string): Promise<{ status: number; cookie: string; location: string | null; setCookie: string; referrerPolicy: string | null }> {
  const response = await fetch(bootstrapUrl, { redirect: 'manual' });
  await response.text();
  const setCookie = response.headers.get('set-cookie') ?? '';
  const match = new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`).exec(setCookie);
  return {
    status: response.status,
    cookie: match ? `${SESSION_COOKIE_NAME}=${match[1]}` : '',
    location: response.headers.get('location'),
    setCookie,
    referrerPolicy: response.headers.get('referrer-policy'),
  };
}

/** Environment inherited by harness children, with any provider credentials removed. */
export const CREDENTIAL_ENV_KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK', 'ANTHROPIC_FOUNDRY_API_KEY', 'ANTHROPIC_FOUNDRY_AUTH_TOKEN', 'ANTHROPIC_AWS_API_KEY', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_MANTLE', 'ANTHROPIC_BASE_URL'];

export function harnessEnvironment(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !CREDENTIAL_ENV_KEYS.includes(key)) env[key] = value;
  }
  return { ...env, [ENV.harness]: '1', ...extra };
}

export interface StartTestBrokerOptions {
  stateRoot: string;
  /** Trusted harness-only fake SDK adapter module path (never a job field). */
  fakeAdapterPath?: string;
  /** Path for a fake `claude` launcher script used by preflight and quota in tests. */
  fakeCliPath?: string | null;
  extraArgs?: string[];
  env?: Record<string, string>;
  /** When false, the bootstrap redirect is not performed automatically. */
  bootstrap?: boolean;
}

export const DEFAULT_FAKE_CLI = path.join(testHelpersDir, 'fake-claude.mjs');
/** Fake Claude Code process: the only substituted boundary in the suite. */
export const DEFAULT_FAKE_ADAPTER = path.join(testHelpersDir, 'fake-claude-process.ts');

export async function startTestBroker(options: StartTestBrokerOptions): Promise<TestBroker> {
  const fakeCli = options.fakeCliPath === undefined ? DEFAULT_FAKE_CLI : options.fakeCliPath;
  const env = harnessEnvironment({
    ...(options.fakeAdapterPath ? { [ENV.adapter]: options.fakeAdapterPath } : {}),
    ...(fakeCli ? { [ENV.cli]: fakeCli } : {}),
    ...(options.env ?? {}),
  });
  const proc = spawnNode(srcEntry('cli', 'main.ts'), [
    'broker', 'start',
    '--state-root', options.stateRoot,
    '--port', '0',
    '--announce-json',
    ...(options.extraArgs ?? []),
  ], { env, cwd: runtimeRoot, inheritEnv: false });
  let announcement: BrokerAnnouncement;
  let secret: string;
  try {
    const line = await proc.waitForLine((l) => l.startsWith('{') && l.includes('"broker_listening"'), 30000, 'broker announcement');
    announcement = JSON.parse(line) as BrokerAnnouncement;
    secret = (await readFile(announcement.secretFile, 'utf8')).trim();
  } catch (error) {
    await proc.stop();
    throw error;
  }
  const bootstrapToken = new URL(announcement.bootstrapUrl).searchParams.get('token') ?? '';
  let cookie = '';
  const state = { cookie };
  if (options.bootstrap !== false) {
    try {
      cookie = (await redeemBootstrap(announcement.bootstrapUrl)).cookie;
      state.cookie = cookie;
    } catch (error) {
      await proc.stop();
      throw error;
    }
  }
  let stopped = false;
  const broker: TestBroker = {
    process: proc,
    announcement,
    baseUrl: announcement.baseUrl,
    stateRoot: options.stateRoot,
    secret,
    get cookie() { return state.cookie; },
    set cookie(value: string) { state.cookie = value; },
    bootstrapToken,
    setSessionCookie(value: string) { state.cookie = value; },
    browserHeaders(extra = {}) {
      return { cookie: state.cookie, ...extra };
    },
    browserActionHeaders(extra = {}) {
      return {
        cookie: state.cookie,
        [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE,
        origin: announcement.baseUrl,
        'content-type': 'application/json',
        ...extra,
      };
    },
    bearerHeaders(extra = {}) {
      return { authorization: `Bearer ${secret}`, 'content-type': 'application/json', ...extra };
    },
    api(pathname, init = {}) {
      return fetchJson(`${announcement.baseUrl}${pathname}`, init);
    },
    async mintBootstrapUrl(taskHandle) {
      const response = await fetchJson(`${announcement.baseUrl}/api/dashboard-url`, {
        method: 'POST',
        headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
        body: JSON.stringify(taskHandle ? { taskHandle } : {}),
      });
      if (response.status !== 200) throw new Error(`dashboard-url ${response.status}: ${response.text}`);
      return (response.body as { url: string }).url;
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      const deadline = setTimeout(() => void proc.stop(), 8000);
      const controller = new AbortController();
      const abort = setTimeout(() => controller.abort(), 3000);
      try {
        await fetchJson(`${announcement.baseUrl}/api/broker/shutdown`, {
          method: 'POST',
          headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
          body: '{}',
          signal: controller.signal,
        });
      } catch {
        // The broker may already be gone or hung; the deadline handles it.
      } finally {
        clearTimeout(abort);
      }
      await proc.exited;
      clearTimeout(deadline);
    },
  };
  return broker;
}
