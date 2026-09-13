// Broker HTTP security: loopback only, per-user secret, one-time time-limited
// bootstrap into an HttpOnly SameSite cookie, Host/Origin/CSRF validation for
// actions, no wildcard CORS, strict CSP, fixed static assets only,
// authenticated SSE and administrative routes closed to the browser session.
//
// Every test mints whatever token or cookie it needs, so a failure in one case
// cannot invalidate the ones after it.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { writeFile, mkdir } from 'node:fs/promises';
import { startTestBroker, redeemBootstrap, harnessEnvironment, DEFAULT_FAKE_CLI, SESSION_COOKIE_NAME, CSRF_HEADER_NAME, CSRF_HEADER_VALUE, CLIENT_HEADER_NAME, type TestBroker } from './helpers/broker-client.ts';
import { makeTempRoot, type TempRoot } from './helpers/temp.ts';
import { fetchJson, rawHttpRequest, spawnNode } from './helpers/process.ts';
import { srcEntry, runtimeRoot } from './helpers/paths.ts';
import { ENV } from './helpers/scenario.ts';
import { IdentityRegistry, BOOTSTRAP_TOKEN_TTL_MS } from '../src/broker/identity.ts';
import { acquireBrokerSingleton, SingletonBusyError } from '../src/broker/singleton.ts';

const EXPECTED_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

let temp: TempRoot;
let broker: TestBroker;

before(async () => {
  temp = await makeTempRoot('codeorquestra-broker-sec-');
  // bootstrap: true so the shared session cookie exists regardless of which
  // individual test passes or fails.
  broker = await startTestBroker({ stateRoot: path.join(temp.root, 'state') });
});
after(async () => {
  await broker?.stop();
  await temp.cleanup();
});

describe('binding and bootstrap', () => {
  test('listens on 127.0.0.1 only and refuses ::1', async () => {
    assert.equal(broker.announcement.address, '127.0.0.1');
    assert.match(broker.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
    await assert.rejects(new Promise<void>((resolve, reject) => {
      const socket = net.connect({ host: '::1', port: broker.announcement.port });
      socket.on('connect', () => { socket.destroy(); resolve(); });
      socket.on('error', reject);
    }));
  });

  test('secret file is per-user, random and never printed in the announcement', async () => {
    assert.match(broker.secret, /^[A-Za-z0-9_-]{43,}$/);
    assert.ok(!JSON.stringify(broker.announcement).includes(broker.secret));
  });

  test('a bootstrap token is single-use and yields an HttpOnly SameSite=Strict cookie', async () => {
    const url = await broker.mintBootstrapUrl();
    const first = await redeemBootstrap(url);
    assert.equal(first.status, 303);
    assert.equal(first.location, '/');
    assert.equal(first.referrerPolicy, 'no-referrer');
    assert.match(first.setCookie, new RegExp(`^${SESSION_COOKIE_NAME}=[A-Za-z0-9_-]{32,}; `));
    assert.match(first.setCookie, /HttpOnly/);
    assert.match(first.setCookie, /SameSite=Strict/);
    assert.match(first.setCookie, /Path=\//);
    const reuse = await fetchJson(url);
    assert.equal(reuse.status, 403);
    assert.deepEqual(reuse.body, { error: 'BOOTSTRAP_TOKEN_USED' });
    const bogus = await fetchJson(`${broker.baseUrl}/bootstrap?token=${'a'.repeat(43)}`);
    assert.equal(bogus.status, 403);
    assert.deepEqual(bogus.body, { error: 'BOOTSTRAP_TOKEN_INVALID' });
    // The cookie minted here really works, so the link is not merely well formed.
    const status = await broker.api('/api/status', { headers: { cookie: first.cookie } });
    assert.equal(status.status, 200, status.text);
  });

  test('an unused bootstrap link expires on its own', async () => {
    const registry = new IdentityRegistry(path.join(temp.root, 'identity-ttl'));
    await registry.load();
    const token = registry.mintBootstrapToken(null);
    const minted = Date.now();
    assert.equal(registry.redeemBootstrapToken(token, minted + BOOTSTRAP_TOKEN_TTL_MS - 1000).ok, true, 'still valid inside the window');
    const second = registry.mintBootstrapToken('task-abc');
    const expired = registry.redeemBootstrapToken(second, Date.now() + BOOTSTRAP_TOKEN_TTL_MS + 1000);
    assert.equal(expired.ok, false);
    assert.equal((expired as { code: string }).code, 'BOOTSTRAP_TOKEN_EXPIRED');
    // Expiry is terminal: retrying inside the window no longer works.
    const retry = registry.redeemBootstrapToken(second, Date.now());
    assert.equal((retry as { code: string }).code, 'BOOTSTRAP_TOKEN_INVALID');
  });
});

describe('broker singleton', () => {
  test('a free state root is acquired, a held one is refused, and a released one is reusable', async () => {
    const root = path.join(temp.root, 'singleton-unit');
    // A state root with no lock at all is free: a missing file is not a lock.
    const first = await acquireBrokerSingleton(root);
    try {
      await acquireBrokerSingleton(root);
      assert.fail('a state root already held must be refused');
    } catch (error) {
      if (!(error instanceof SingletonBusyError)) throw error;
      assert.equal(error.code, 'BROKER_ALREADY_RUNNING');
      assert.equal(error.owner?.pid, process.pid, 'the refusal names the live owner');
    } finally {
      await first.release();
    }
    const second = await acquireBrokerSingleton(root);
    await second.release();
  });

  test('a lock left behind by a dead process is reclaimed instead of wedging the state root', async () => {
    const root = path.join(temp.root, 'singleton-stale');
    await mkdir(path.join(root, 'broker'), { recursive: true });
    const lockFile = path.join(root, 'broker', 'broker.lock');
    // A pid that cannot be alive: the owner is gone and the file is removable.
    await writeFile(lockFile, JSON.stringify({ pid: 2147483646, startedAt: new Date().toISOString() }));
    if (process.platform === 'win32') {
      const reclaimed = await acquireBrokerSingleton(root);
      await reclaimed.release();
    } else {
      await assert.rejects(acquireBrokerSingleton(root), (error: unknown) => error instanceof SingletonBusyError, 'POSIX fails closed because rename cannot prove ownership of an open lock');
      await rm(lockFile, { force: true });
    }

    // On Windows the file is metadata only: the kernel mutex remains the sole
    // ownership authority, so corrupt/stale metadata cannot wedge startup.
    // The POSIX fallback still fails closed on an unreadable file.
    await writeFile(lockFile, '');
    if (process.platform === 'win32') {
      const despiteCorruptMetadata = await acquireBrokerSingleton(root);
      await despiteCorruptMetadata.release();
    } else {
      await assert.rejects(acquireBrokerSingleton(root), (error: unknown) => error instanceof SingletonBusyError);
      await rm(lockFile, { force: true });
    }
  });

  test('two contenders reclaiming the same abandoned lock cannot both end up owning it', { skip: process.platform !== 'win32' && 'safe automatic reclamation relies on Windows file sharing' }, async () => {
    const root = path.join(temp.root, 'singleton-reclaim-race');
    await mkdir(path.join(root, 'broker'), { recursive: true });
    const lockFile = path.join(root, 'broker', 'broker.lock');
    // Both contenders will observe this same dead owner. Reading it, judging it
    // stale and then deleting it is a race: the second deleter would remove the
    // FIRST one's fresh lock and both would believe they own the state root.
    const stale = { pid: 2147483646, startedAt: new Date(Date.now() - 3_600_000).toISOString() };
    for (let attempt = 0; attempt < 25; attempt += 1) {
      await writeFile(lockFile, JSON.stringify(stale));
      const results = await Promise.all([0, 1].map(async () => {
        try {
          return { lock: await acquireBrokerSingleton(root), error: null as unknown };
        } catch (error) {
          return { lock: null, error };
        }
      }));
      const winners = results.filter((result) => result.lock !== null);
      try {
        assert.equal(winners.length, 1, `tentativa ${attempt}: exatamente um contendor pode assumir o state root`);
        for (const loser of results.filter((result) => result.lock === null)) {
          assert.ok(loser.error instanceof SingletonBusyError, String(loser.error));
        }
      } finally {
        for (const winner of winners) await winner.lock!.release();
      }
    }
  });

  test('two brokers starting at the same instant on one state root: exactly one wins', async () => {
    const root = path.join(temp.root, 'singleton-race');
    const env = harnessEnvironment({ [ENV.cli]: DEFAULT_FAKE_CLI });
    const start = () => spawnNode(srcEntry('cli', 'main.ts'), ['broker', 'start', '--state-root', root, '--port', '0', '--announce-json'], { env, cwd: runtimeRoot, inheritEnv: false });
    const a = start();
    const b = start();
    try {
      const outcomes = await Promise.all([a, b].map(async (proc) => {
        const announced = await proc.waitForLine((line) => line.startsWith('{') && line.includes('"broker_listening"'), 30000, 'broker announcement').then(() => 'listening' as const, () => 'refused' as const);
        return announced;
      }));
      assert.equal(outcomes.filter((outcome) => outcome === 'listening').length, 1, `exactly one broker may own the state root: ${outcomes.join(',')} | ${a.stderrText} ${b.stderrText}`);
      const loser = outcomes[0] === 'listening' ? b : a;
      assert.equal(await loser.exited, 4, 'the loser exits with the singleton code instead of racing');
      assert.match(loser.stderrText, /Outro broker já está ativo/);
    } finally {
      await a.stop();
      await b.stop();
    }
  });

  test('losing the Windows mutex helper is observable and releases kernel ownership', { skip: process.platform !== 'win32' && 'Windows kernel mutex' }, async () => {
    const root = path.join(temp.root, 'singleton-helper-loss');
    const lock = await acquireBrokerSingleton(root);
    assert.ok(lock.monitorPid);
    process.kill(lock.monitorPid!, 'SIGKILL');
    await Promise.race([
      lock.lost,
      new Promise((_, reject) => setTimeout(() => reject(new Error('mutex loss was not observed')), 5000)),
    ]);
    const replacement = await acquireBrokerSingleton(root);
    await replacement.release();
    await lock.release();
  });
});

describe('authentication', () => {
  test('read APIs require auth and never send wildcard CORS', async () => {
    const anonymous = await broker.api('/api/status');
    assert.equal(anonymous.status, 401);
    assert.deepEqual(anonymous.body, { error: 'UNAUTHORIZED' });
    assert.equal(anonymous.headers.get('access-control-allow-origin'), null);
    assert.equal(anonymous.headers.get('content-security-policy'), EXPECTED_CSP);
    assert.equal(anonymous.headers.get('x-content-type-options'), 'nosniff');
    const preflight = await fetchJson(`${broker.baseUrl}/api/status`, { method: 'OPTIONS', headers: { origin: 'http://evil.invalid', 'access-control-request-method': 'POST' } });
    assert.equal(preflight.headers.get('access-control-allow-origin'), null);
    assert.ok([403, 404, 405].includes(preflight.status));
  });

  test('cookie and bearer identities both read status, with distinct source labels', async () => {
    const viaCookie = await broker.api('/api/status', { headers: broker.browserHeaders() });
    assert.equal(viaCookie.status, 200, viaCookie.text);
    const cookieBody = viaCookie.body as { tasks: unknown[]; identity: { source: string }; broker: { version: string; tagline: string }; cursorEpoch: string };
    assert.deepEqual(cookieBody.tasks, []);
    assert.equal(cookieBody.identity.source, 'browser');
    assert.equal(cookieBody.broker.tagline, 'Codex com Opus e Fable');
    assert.equal(cookieBody.cursorEpoch, broker.announcement.cursorEpoch, 'the announced cursor epoch is the one clients see');
    const viaBearer = await broker.api('/api/status', { headers: broker.bearerHeaders() });
    assert.equal(viaBearer.status, 200);
    assert.equal((viaBearer.body as { identity: { source: string } }).identity.source, 'local-secret');
    const viaMcp = await broker.api('/api/status', { headers: broker.bearerHeaders({ [CLIENT_HEADER_NAME]: 'mcp' }) });
    assert.equal((viaMcp.body as { identity: { source: string } }).identity.source, 'mcp');
    const wrong = await broker.api('/api/status', { headers: { authorization: 'Bearer nope' } });
    assert.equal(wrong.status, 401);
  });

  test('health reports the product name and the current cursor epoch', async () => {
    const health = await broker.api('/api/health', { headers: broker.browserHeaders() });
    assert.equal(health.status, 200, health.text);
    const body = health.body as { product: string; cursorEpoch: string; pid: number };
    assert.equal(body.product, 'CodeOrquestra');
    assert.equal(body.cursorEpoch, broker.announcement.cursorEpoch);
    assert.equal(body.pid, broker.announcement.pid);
  });

  test('bearer via query string or cookie forgery is rejected', async () => {
    const query = await broker.api(`/api/status?token=${broker.secret}`);
    assert.equal(query.status, 401);
    const forged = await broker.api('/api/status', { headers: { cookie: `${SESSION_COOKIE_NAME}=${'b'.repeat(43)}` } });
    assert.equal(forged.status, 401);
  });
});

describe('action protection', () => {
  test('browser actions need the CSRF header, a matching Origin and a loopback Host', async () => {
    const body = JSON.stringify({ text: 'olá' });
    const noHeader = await broker.api('/api/tasks/nao-existe/message', { method: 'POST', headers: { ...broker.browserHeaders(), 'content-type': 'application/json' }, body });
    assert.equal(noHeader.status, 403);
    assert.deepEqual(noHeader.body, { error: 'CSRF_HEADER_REQUIRED' });
    const badOrigin = await broker.api('/api/tasks/nao-existe/message', { method: 'POST', headers: broker.browserActionHeaders({ origin: 'http://evil.invalid' }), body });
    assert.equal(badOrigin.status, 403);
    assert.deepEqual(badOrigin.body, { error: 'ORIGIN_NOT_ALLOWED' });
    const raw = await rawHttpRequest(broker.announcement.port, [
      'POST /api/tasks/nao-existe/message HTTP/1.1',
      'Host: evil.invalid',
      `Cookie: ${broker.cookie}`,
      `${CSRF_HEADER_NAME}: ${CSRF_HEADER_VALUE}`,
      `Origin: ${broker.baseUrl}`,
      'Content-Type: application/json',
      `Content-Length: ${Buffer.byteLength(body)}`,
      'Connection: close',
      '',
      body,
    ].join('\r\n'));
    assert.equal(raw.status, 403);
    assert.deepEqual(JSON.parse(raw.body), { error: 'HOST_NOT_ALLOWED' });
    const ok = await broker.api('/api/tasks/nao-existe/message', { method: 'POST', headers: broker.browserActionHeaders(), body });
    assert.equal(ok.status, 404);
    assert.deepEqual(ok.body, { error: 'TASK_NOT_FOUND' });
  });

  test('administrative routes refuse the browser session even with a valid CSRF header', async () => {
    const administrative: Array<[string, string]> = [
      ['/api/broker/shutdown', '{}'],
      ['/api/tasks/register', JSON.stringify({ codexThreadId: 'thread-x', source: 'browser' })],
      ['/api/dashboard-url', '{}'],
    ];
    for (const [route, payload] of administrative) {
      const response = await broker.api(route, { method: 'POST', headers: broker.browserActionHeaders(), body: payload });
      assert.equal(response.status, 403, `${route}: ${response.text}`);
      assert.deepEqual(response.body, { error: 'LOCAL_ADMIN_REQUIRED' }, route);
    }
    const locks = await broker.api('/api/locks', { headers: broker.browserHeaders() });
    assert.equal(locks.status, 403);
    assert.deepEqual(locks.body, { error: 'LOCAL_ADMIN_REQUIRED' });
    // The same routes answer for the local secret, so the refusal is about
    // identity and not about the route being broken.
    const adminLocks = await broker.api('/api/locks', { headers: broker.bearerHeaders() });
    assert.equal(adminLocks.status, 200, adminLocks.text);
    assert.deepEqual(adminLocks.body, []);
  });

  test('the MCP label is refused for administrative routes as defence in depth', async () => {
    const headers = broker.bearerHeaders({ [CLIENT_HEADER_NAME]: 'mcp' });
    const locks = await broker.api('/api/locks', { headers });
    assert.equal(locks.status, 403);
    assert.deepEqual(locks.body, { error: 'LOCAL_ADMIN_REQUIRED' });
    // The MCP surface is always task-scoped, so an unscoped dashboard link is
    // refused with the actionable reason instead of a generic one.
    const unscoped = await broker.api('/api/dashboard-url', { method: 'POST', headers, body: '{}' });
    assert.equal(unscoped.status, 403);
    assert.deepEqual(unscoped.body, { error: 'TASK_HANDLE_REQUIRED' });
    const register = await broker.api('/api/tasks/register', { method: 'POST', headers, body: JSON.stringify({ codexThreadId: 'thread-mcp-admin', source: 'mcp' }) });
    assert.equal(register.status, 403);
    assert.deepEqual(register.body, { error: 'LOCAL_ADMIN_REQUIRED' }, 'registration stays a coordinator-terminal action');
  });

  test('shutdown is an authenticated action', async () => {
    const anonymous = await broker.api('/api/broker/shutdown', { method: 'POST', body: '{}' });
    assert.equal(anonymous.status, 401);
  });
});

describe('static assets and file access', () => {
  test('serves only fixed static assets and never traverses', async () => {
    const index = await fetch(`${broker.baseUrl}/`);
    const html = await index.text();
    assert.ok([200, 503].includes(index.status));
    assert.equal(index.headers.get('content-security-policy'), EXPECTED_CSP);
    if (index.status === 503) assert.match(html, /Painel não compilado/);
    for (const target of ['/assets/../package.json', '/%2e%2e/package.json', '/..%5cpackage.json', '/dist/build-info.json', '/api/files?path=C:%5cWindows%5cwin.ini', '/events.jsonl', '/package.json', '/index.html/../../package.json']) {
      const response = await fetchJson(`${broker.baseUrl}${target}`, { headers: broker.browserHeaders() });
      assert.equal(response.status, 404, target);
    }
  });

  test('SSE requires auth and replies with an event stream', async () => {
    const anonymous = await fetch(`${broker.baseUrl}/api/events?cursor=0`);
    assert.equal(anonymous.status, 401);
    await anonymous.text();
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 5000);
    try {
      const stream = await fetch(`${broker.baseUrl}/api/events?cursor=0`, { headers: broker.browserHeaders(), signal: controller.signal });
      assert.equal(stream.status, 200);
      assert.match(stream.headers.get('content-type') ?? '', /^text\/event-stream/);
      assert.equal(stream.headers.get('cache-control'), 'no-store');
      const reader = stream.body!.getReader();
      const { value } = await reader.read();
      const text = new TextDecoder().decode(value);
      assert.match(text, /^(:|event: ready|id: 0)/, `first SSE chunk should be a comment or ready event, got ${text}`);
    } finally {
      clearTimeout(abortTimer);
      controller.abort();
    }
  });

  test('an SSE client carrying an old epoch is told to restart from zero', async () => {
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 5000);
    try {
      const stream = await fetch(`${broker.baseUrl}/api/events?cursor=9999&epoch=epoca-antiga`, { headers: broker.browserHeaders(), signal: controller.signal });
      assert.equal(stream.status, 200);
      const reader = stream.body!.getReader();
      let text = '';
      while (!text.includes('event: ready')) {
        const { value, done } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
      }
      assert.match(text, /event: ready/);
      const ready = /event: ready\ndata: (.*)/.exec(text);
      assert.ok(ready, `ready event expected, got ${text}`);
      const payload = JSON.parse(ready[1]!) as { epoch: string; cursor: number };
      assert.equal(payload.epoch, broker.announcement.cursorEpoch);
      assert.equal(payload.cursor, 0, 'a stale epoch resets the cursor instead of silently skipping history');
    } finally {
      clearTimeout(abortTimer);
      controller.abort();
    }
  });
});

describe('secrets in logs', () => {
  test('the broker log never contains the secret or the bootstrap token', async () => {
    const logDir = path.join(broker.stateRoot, 'broker');
    const files = (await readdir(logDir)).filter((name) => name.endsWith('.log'));
    assert.ok(files.length >= 1, 'broker writes a log file');
    for (const file of files) {
      const content = await readFile(path.join(logDir, file), 'utf8');
      assert.ok(!content.includes(broker.secret), `${file} leaks the secret`);
      assert.ok(!content.includes(broker.bootstrapToken), `${file} leaks the bootstrap token`);
    }
  });
});
