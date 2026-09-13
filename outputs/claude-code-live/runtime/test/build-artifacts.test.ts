// Built artifacts must run in an isolated installation: bundle once, copy only
// dist/ to a temporary directory without node_modules and execute it there.
// Doctor is verified through the fake launcher trace, not through its own
// claims.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cp, readFile, readdir, stat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { makeTempRoot, type TempRoot } from './helpers/temp.ts';
import { runtimeRoot, distDir } from './helpers/paths.ts';
import { DEFAULT_FAKE_CLI, harnessEnvironment } from './helpers/broker-client.ts';
import { ENV } from './helpers/scenario.ts';

let temp: TempRoot;
let isolated: string;

function runNode(args: string[], cwd: string, env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env: harnessEnvironment(env), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => { stdout += c; });
    child.stderr.on('data', (c: string) => { stderr += c; });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`timed out: node ${args.join(' ')}`)); }, 300000);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

before(async () => {
  temp = await makeTempRoot('codeorquestra-dist-');
  const backend = await runNode(['esbuild.config.mjs'], runtimeRoot);
  assert.equal(backend.code, 0, `backend build failed: ${backend.stderr}`);
  const dashboard = await runNode([path.join('node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', 'vite.config.mts', '--logLevel', 'warn'], runtimeRoot);
  assert.equal(dashboard.code, 0, `dashboard build failed: ${dashboard.stderr}`);
  isolated = path.join(temp.root, 'installed-plugin', 'runtime', 'dist');
  await cp(distDir, isolated, { recursive: true });
});
after(async () => { await temp.cleanup(); });

describe('backend bundle', () => {
  test('the plugin declares the bundled MCP adapter for Codex', async () => {
    const config = JSON.parse(await readFile(path.resolve(runtimeRoot, '..', '.mcp.json'), 'utf8')) as {
      mcpServers?: Record<string, { cwd?: string; command?: string; args?: string[] }>;
    };
    assert.deepEqual(config.mcpServers?.codeorquestra, {
      cwd: '.',
      command: 'node',
      args: ['./runtime/dist/mcp-stdio.mjs'],
      startup_timeout_sec: 15,
      tool_timeout_sec: 3600,
    });
  });

  test('ships the three entrypoints, a reproducible build manifest and third-party notices, with no vendor SDK', async () => {
    const names = (await readdir(isolated)).sort();
    for (const expected of ['THIRD_PARTY_NOTICES.txt', 'build-info.json', 'codeorquestra.mjs', 'dashboard', 'mcp-stdio.mjs', 'package.json', 'worker.mjs']) {
      assert.ok(names.includes(expected), `missing ${expected} in ${names.join(', ')}`);
    }
    const info = JSON.parse(await readFile(path.join(isolated, 'build-info.json'), 'utf8'));
    assert.equal(info.dependencyVersions['@modelcontextprotocol/sdk'], '1.30.0');
    assert.equal(info.vendorSdkBundled, false);
    assert.deepEqual(info.external, []);
    assert.ok(!('@anthropic-ai/claude-agent-sdk' in info.dependencyVersions), 'the Agent SDK is not a dependency of this runtime');
    assert.ok(!info.bundledPackages.some((name: string) => name.startsWith('@anthropic-ai/')), `no vendor package is bundled: ${info.bundledPackages.join(', ')}`);
    assert.ok(!names.includes('cli.js'), 'no Claude Code CLI is shipped as part of this runtime');
    const notices = await readFile(path.join(isolated, 'THIRD_PARTY_NOTICES.txt'), 'utf8');
    assert.ok(notices.includes('@modelcontextprotocol/sdk@1.30.0'));
    for (const dependency of ['react@19.3.0', 'react-dom@19.3.0', 'scheduler@0.28.0']) {
      assert.ok(notices.includes(dependency), `notices must cover the bundled dashboard dependency ${dependency}`);
      assert.ok(info.bundledPackages.includes(dependency.slice(0, dependency.lastIndexOf('@'))), `build info must list ${dependency}`);
    }
    assert.ok(!notices.includes('@anthropic-ai/claude-agent-sdk'));
    assert.match(notices, /No Claude Code binary or vendor SDK is bundled/);
    // The bundles themselves must not carry a vendored CLI.
    for (const file of ['worker.mjs', 'codeorquestra.mjs', 'mcp-stdio.mjs']) {
      const bundle = await readFile(path.join(isolated, file), 'utf8');
      assert.ok(!bundle.includes('node_modules/@anthropic-ai/claude-agent-sdk'), `${file} still embeds the vendor SDK`);
    }
  });

  test('runs from the isolated copy without node_modules', async () => {
    const parent = path.dirname(isolated);
    let hasModules = true;
    try { await stat(path.join(parent, 'node_modules')); } catch { hasModules = false; }
    assert.equal(hasModules, false);
    const version = await runNode([path.join(isolated, 'codeorquestra.mjs'), '--version'], temp.root);
    assert.equal(version.code, 0, version.stderr);
    assert.equal(version.stdout.trim(), 'codeorquestra 0.1.0 (claude-code-live)');
    const worker = await runNode([path.join(isolated, 'worker.mjs')], temp.root);
    assert.equal(worker.code, 2, 'worker without a task descriptor exits with usage error');
    assert.match(worker.stderr, /worker requer/i);
    const mcp = await runNode([path.join(isolated, 'mcp-stdio.mjs'), '--help'], temp.root);
    assert.equal(mcp.code, 0, mcp.stderr);
    assert.match(mcp.stdout, /codeorquestra/i);
  });

  test('doctor probes only read-only launcher commands, proven by the fake launcher trace', async () => {
    const traceDir = path.join(temp.root, 'doctor-trace');
    await mkdir(traceDir, { recursive: true });
    const doctor = await runNode([path.join(isolated, 'codeorquestra.mjs'), 'doctor', '--json'], temp.root, { [ENV.cli]: DEFAULT_FAKE_CLI, [ENV.traceDir]: traceDir });
    assert.equal(doctor.code, 0, doctor.stderr);
    const report = JSON.parse(doctor.stdout);
    assert.equal(report.product, 'CodeOrquestra');
    assert.equal(report.technicalId, 'codeorquestra');
    assert.equal(report.legacyTechnicalId, 'claude-code-live');
    assert.equal(report.node, process.version);
    assert.equal(report.runtimeMode, 'bundle');
    assert.equal(report.engine, 'cli-instalado-do-usuario');
    assert.equal(report.vendorSdkBundled, false);
    assert.equal(report.cli.status, 'resolved');
    assert.equal(report.cli.version, '2.1.263');
    assert.equal(report.cli.vendorCliUsed, false);
    assert.equal(report.cli.advertisedFlags > 0, true);
    assert.deepEqual(report.cli.missingFlags, [], 'the fake launcher advertises every required flag');
    assert.equal(report.authenticated, null, 'doctor never claims an authentication state it did not verify');
    const trace = (await readFile(path.join(traceDir, 'launcher.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { args: string[]; outcome: string });
    assert.deepEqual(trace.map((entry) => entry.args.join(' ')), ['--version', '--help', 'auth status --json']);
    assert.ok(trace.every((entry) => entry.outcome === 'served'));
  });

  test('the bundled broker starts from the isolated copy and serves the bundled dashboard', async () => {
    const stateRoot = path.join(temp.root, 'bundle-state');
    const child = spawn(process.execPath, [path.join(isolated, 'codeorquestra.mjs'), 'broker', 'start', '--state-root', stateRoot, '--port', '0', '--announce-json'], { cwd: temp.root, env: harnessEnvironment({ [ENV.cli]: DEFAULT_FAKE_CLI }), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c: string) => { stderr += c; });
    const exited = new Promise<number | null>((resolve) => {
      child.once('exit', resolve);
      child.once('error', () => resolve(null));
    });
    try {
      const announcement = await new Promise<{ baseUrl: string; secretFile: string }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`bundled broker did not announce: ${stderr}`)), 30000);
        child.stdout.on('data', (c: string) => {
          stdout += c;
          const line = stdout.split('\n').find((l) => l.includes('broker_listening'));
          if (line) { clearTimeout(timer); resolve(JSON.parse(line)); }
        });
        void exited.then((code) => { clearTimeout(timer); reject(new Error(`bundled broker exited ${code}: ${stderr}`)); });
      });
      const secret = (await readFile(announcement.secretFile, 'utf8')).trim();
      const index = await fetch(`${announcement.baseUrl}/`);
      assert.equal(index.status, 200, 'the bundled dashboard is served next to the bundled broker');
      assert.match(await index.text(), /Codex com Opus e Fable/);
      const health = await fetch(`${announcement.baseUrl}/api/health`, { headers: { authorization: `Bearer ${secret}` } });
      assert.equal(health.status, 200);
      const shutdown = await fetch(`${announcement.baseUrl}/api/broker/shutdown`, { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: '{}' });
      assert.equal(shutdown.status, 202);
    } finally {
      const timer = setTimeout(() => child.kill(), 8000);
      await exited;
      clearTimeout(timer);
    }
  });
});

describe('dashboard bundle', () => {
  test('index.html references only local assets, no inline scripts and no network resources', async () => {
    const html = await readFile(path.join(isolated, 'dashboard', 'index.html'), 'utf8');
    assert.ok(!/https?:\/\//.test(html), 'no absolute network URLs in the document');
    assert.ok(!/<script(?![^>]*\ssrc=)[^>]*>[^<]*\S[^<]*<\/script>/.test(html), 'no inline scripts');
    assert.match(html, /<html lang="pt-BR">/);
    assert.match(html, /Codex com Opus e Fable/);
    const refs = [...html.matchAll(/(?:src|href)="\.\/([^"]+)"/g)].map((m) => m[1]!);
    assert.ok(refs.length >= 2, 'expects at least a script and a stylesheet');
    for (const ref of refs) await stat(path.join(isolated, 'dashboard', ref));
    const assets = await readdir(path.join(isolated, 'dashboard', 'assets'));
    for (const asset of assets.filter((name) => name.endsWith('.css'))) {
      const css = await readFile(path.join(isolated, 'dashboard', 'assets', asset), 'utf8');
      assert.ok(!/url\(\s*["']?https?:/.test(css), `${asset} must not load remote fonts or images`);
      assert.ok(!/@import\s+url\(\s*["']?https?:/.test(css), `${asset} must not import remote stylesheets`);
    }
  });
});
