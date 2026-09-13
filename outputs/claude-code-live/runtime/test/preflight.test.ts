// Preflight: resolve the installed Claude Code CLI through the Windows npm
// shim, decide compatibility from the capabilities that build actually
// advertises (never from version numbers), and fail closed on any
// authentication path that is not a verified subscription or explicitly
// authorized API billing.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveClaudeExecutable, diagnoseCliCompatibility, resolvePreflight, assessAuthPath, REQUIRED_CLI_FLAGS } from '../src/preflight/cli-resolver.ts';
import { parseAdvertisedFlags, parseVersion, sanitizeAuthStatus, probeCli } from '../src/preflight/cli-probe.ts';
import { makeTempRoot, type TempRoot } from './helpers/temp.ts';
import { DEFAULT_FAKE_CLI } from './helpers/broker-client.ts';
import { ENV } from './helpers/scenario.ts';

let temp: TempRoot;
let shimDir: string;
let packageDir: string;

const CMD_SHIM = '@ECHO off\r\n"%~dp0\\node.exe"  "%~dp0\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n';
const PS1_SHIM = '#!/usr/bin/env pwsh\n$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent\n& "$basedir/node.exe"  "$basedir/node_modules/@anthropic-ai/claude-code/cli.js" $args\n';
const SH_SHIM = '#!/bin/sh\nbasedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")\nexec node  "$basedir/node_modules/@anthropic-ai/claude-code/cli.js" "$@"\n';
const ALL_FLAGS = [...REQUIRED_CLI_FLAGS];
const SUBSCRIPTION = { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max' };

before(async () => {
  temp = await makeTempRoot('codeorquestra-preflight-');
  shimDir = path.join(temp.root, 'nodejs');
  packageDir = path.join(shimDir, 'node_modules', '@anthropic-ai', 'claude-code');
  await mkdir(path.join(packageDir, 'bin'), { recursive: true });
  await writeFile(path.join(shimDir, 'claude.cmd'), CMD_SHIM);
  await writeFile(path.join(shimDir, 'claude.ps1'), PS1_SHIM);
  await writeFile(path.join(shimDir, 'claude'), SH_SHIM);
  await writeFile(path.join(packageDir, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code', version: '2.1.263', bin: { claude: 'cli.js' } }));
  await writeFile(path.join(packageDir, 'cli.js'), '// placeholder\n');
  await writeFile(path.join(packageDir, 'bin', 'claude.exe'), 'MZ');
});
after(async () => { await temp.cleanup(); });

describe('resolveClaudeExecutable', () => {
  test('follows the npm shim to the package and prefers the native launcher when present', async () => {
    for (const launcher of ['claude.ps1', 'claude.cmd', 'claude']) {
      const resolved = await resolveClaudeExecutable({ launcherPath: path.join(shimDir, launcher), platform: 'win32' });
      assert.deepEqual(resolved, {
        status: 'resolved',
        source: 'npm-shim',
        launcherPath: path.join(shimDir, launcher),
        packageDir,
        packageVersion: '2.1.263',
        executablePath: path.join(packageDir, 'bin', 'claude.exe'),
        kind: 'native',
        runWith: null,
      }, launcher);
    }
  });

  test('falls back to the package bin script under node when no native launcher exists', async () => {
    const altShim = path.join(temp.root, 'nodejs-js-only');
    const altPackage = path.join(altShim, 'node_modules', '@anthropic-ai', 'claude-code');
    await mkdir(altPackage, { recursive: true });
    await writeFile(path.join(altShim, 'claude.cmd'), CMD_SHIM);
    await writeFile(path.join(altPackage, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code', version: '2.1.100', bin: { claude: 'cli.js' } }));
    await writeFile(path.join(altPackage, 'cli.js'), '// placeholder\n');
    const resolved = await resolveClaudeExecutable({ launcherPath: path.join(altShim, 'claude.cmd'), platform: 'win32' });
    assert.equal(resolved.status, 'resolved');
    if (resolved.status === 'resolved') {
      assert.equal(resolved.executablePath, path.join(altPackage, 'cli.js'));
      assert.equal(resolved.kind, 'script');
      assert.equal(resolved.runWith, 'node');
      assert.equal(resolved.packageVersion, '2.1.100');
    }
  });

  test('a direct native executable path is accepted as-is and a missing launcher is reported, not replaced', async () => {
    const direct = await resolveClaudeExecutable({ launcherPath: path.join(packageDir, 'bin', 'claude.exe'), platform: 'win32' });
    assert.equal(direct.status, 'resolved');
    if (direct.status === 'resolved') {
      assert.equal(direct.source, 'direct');
      assert.equal(direct.kind, 'native');
    }
    const missing = await resolveClaudeExecutable({ launcherPath: path.join(temp.root, 'nope', 'claude.cmd'), platform: 'win32' });
    assert.deepEqual(missing, { status: 'not_found', launcherPath: path.join(temp.root, 'nope', 'claude.cmd'), code: 'CLI_NOT_FOUND', vendorCliUsed: false });
  });
});

describe('diagnoseCliCompatibility', () => {
  test('compatibility comes from advertised capabilities, not from version comparison', () => {
    const older = diagnoseCliCompatibility({ cliVersion: '2.0.1', runtimeVersion: '0.1.0', advertisedFlags: ALL_FLAGS, supportedModels: null, requestedModel: 'claude-fable-5-1' });
    assert.equal(older.status, 'compatible');
    assert.equal(older.action, 'proceed');
    assert.equal(older.vendorCliUsed, false);
    assert.equal(older.modelSupport, 'unknown');
    assert.deepEqual(older.missingCapabilities, []);
  });

  test('a missing required flag is a genuine incompatibility, reported and never worked around', () => {
    const diagnosis = diagnoseCliCompatibility({ cliVersion: '2.0.9', runtimeVersion: '0.1.0', advertisedFlags: ALL_FLAGS.filter((flag) => flag !== '--input-format' && flag !== '--permission-prompt-tool'), supportedModels: null, requestedModel: 'claude-fable-5-1' });
    assert.equal(diagnosis.status, 'incompatible');
    assert.equal(diagnosis.code, 'CLI_MISSING_CAPABILITY');
    assert.equal(diagnosis.action, 'report_to_coordinator');
    assert.deepEqual(diagnosis.missingCapabilities, ['--input-format', '--permission-prompt-tool']);
    assert.match(diagnosis.message, /2\.0\.9/);
    assert.ok(!('fallbackModel' in diagnosis));
  });

  test('model descriptors with aliases confirm through resolvedModel; a miss stays unconfirmed, not unsupported', () => {
    const confirmed = diagnoseCliCompatibility({ cliVersion: '2.1.263', runtimeVersion: '0.1.0', advertisedFlags: ALL_FLAGS, supportedModels: [{ value: 'fable', resolvedModel: 'claude-fable-5-1' }, { value: 'opus', resolvedModel: 'claude-opus-5' }], requestedModel: 'claude-fable-5-1' });
    assert.equal(confirmed.modelSupport, 'confirmed');
    const unconfirmed = diagnoseCliCompatibility({ cliVersion: '2.1.263', runtimeVersion: '0.1.0', advertisedFlags: ALL_FLAGS, supportedModels: [{ value: 'sonnet' }], requestedModel: 'claude-opus-5' });
    assert.equal(unconfirmed.status, 'compatible');
    assert.equal(unconfirmed.modelSupport, 'unconfirmed');
    assert.equal(unconfirmed.action, 'proceed');
  });

  test('unknown capabilities are reported as unknown and block the start', () => {
    const unknown = diagnoseCliCompatibility({ cliVersion: '2.1.263', runtimeVersion: '0.1.0', advertisedFlags: null, supportedModels: null, requestedModel: 'claude-fable-5-1' });
    assert.equal(unknown.status, 'unknown');
    assert.equal(unknown.code, 'CAPABILITIES_UNKNOWN');
    assert.equal(unknown.action, 'report_to_coordinator');
  });
});

describe('assessAuthPath', () => {
  test('a verified first-party subscription is accepted without retaining account identity', () => {
    const assessment = assessAuthPath({ env: {}, authStatus: SUBSCRIPTION, allowApiBilling: false });
    assert.deepEqual(assessment, { ok: true, code: 'AUTH_SUBSCRIPTION', evidence: [], message: 'Autenticação por assinatura confirmada pelo CLI instalado (sem detalhes de conta retidos).' });
  });

  test('an unknown or failed auth probe fails closed instead of authorizing an unverified path', () => {
    for (const status of [null, { loggedIn: null, authMethod: null, apiProvider: null, subscriptionType: null }, { loggedIn: true, authMethod: null, apiProvider: null, subscriptionType: null }]) {
      const assessment = assessAuthPath({ env: {}, authStatus: status, allowApiBilling: false });
      assert.equal(assessment.ok, false, JSON.stringify(status));
      assert.equal(assessment.code, 'AUTH_STATUS_UNKNOWN');
      assert.match(assessment.message, /não inicia/);
    }
  });

  test('inherited API keys or cloud providers are refused unless the job authorizes API billing', () => {
    const refused = assessAuthPath({ env: { ANTHROPIC_API_KEY: 'sk-ant-xyz' }, authStatus: SUBSCRIPTION, allowApiBilling: false });
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'AUTH_API_BILLING_NOT_AUTHORIZED');
    assert.deepEqual(refused.evidence, ['ANTHROPIC_API_KEY presente no ambiente']);
    assert.ok(!JSON.stringify(refused).includes('sk-ant-xyz'), 'the key value never appears');
    const provider = assessAuthPath({ env: {}, authStatus: { loggedIn: true, authMethod: 'apiKey', apiProvider: 'bedrock', subscriptionType: null }, allowApiBilling: false });
    assert.equal(provider.ok, false);
    assert.deepEqual(provider.evidence, ['apiProvider=bedrock', 'authMethod=apiKey']);
    const authorized = assessAuthPath({ env: { CLAUDE_CODE_USE_VERTEX: '1' }, authStatus: null, allowApiBilling: true });
    assert.equal(authorized.ok, true);
    assert.equal(authorized.code, 'AUTH_API_BILLING_AUTHORIZED');
    const loggedOut = assessAuthPath({ env: {}, authStatus: { loggedIn: false, authMethod: null, apiProvider: null, subscriptionType: null }, allowApiBilling: false });
    assert.equal(loggedOut.code, 'AUTH_NOT_LOGGED_IN');
    assert.equal(loggedOut.ok, false);
  });
});

describe('probe parsing and the fake launcher', () => {
  test('parses versions, advertised flags and sanitized auth status', () => {
    assert.equal(parseVersion('2.1.263 (Claude Code)'), '2.1.263');
    assert.deepEqual(parseAdvertisedFlags('  --model <m>  --effort <e>\n --model again'), ['--effort', '--model']);
    assert.deepEqual(sanitizeAuthStatus({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max', email: 'x@y', organization: 'org', accessToken: 'abc' }), SUBSCRIPTION);
  });

  test('probing the fake launcher records only read-only invocations', async () => {
    const traceDir = path.join(temp.root, 'probe-trace');
    const previous = process.env[ENV.traceDir];
    process.env[ENV.traceDir] = traceDir;
    try {
      const executable = await resolveClaudeExecutable({ launcherPath: DEFAULT_FAKE_CLI, platform: process.platform });
      assert.equal(executable.status, 'resolved');
      if (executable.status !== 'resolved') return;
      assert.equal(executable.runWith, 'node');
      const probe = await probeCli(executable, { timeoutMs: 20000 });
      assert.equal(probe.cliVersion, '2.1.263');
      for (const flag of REQUIRED_CLI_FLAGS) assert.ok(probe.advertisedFlags?.includes(flag), flag);
      assert.deepEqual(probe.authStatus, SUBSCRIPTION);
    } finally {
      if (previous === undefined) delete process.env[ENV.traceDir]; else process.env[ENV.traceDir] = previous;
    }
    const trace = (await readFile(path.join(traceDir, 'launcher.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { args: string[]; outcome: string });
    assert.deepEqual(trace.map((entry) => entry.args.join(' ')), ['--version', '--help', 'auth status --json']);
    assert.ok(trace.every((entry) => entry.outcome === 'served'));
  });
});

describe('resolvePreflight', () => {
  test('produces launch options bound to the installed executable with exact model and Extra effort', async () => {
    const preflight = await resolvePreflight({
      launcherPath: path.join(shimDir, 'claude.ps1'),
      platform: 'win32',
      requestedModel: 'claude-fable-5-1',
      runtimeVersion: '0.1.0',
      env: {},
      probe: async () => ({ cliVersion: '2.1.263', advertisedFlags: ALL_FLAGS, authStatus: SUBSCRIPTION }),
    });
    assert.equal(preflight.status, 'ready');
    if (preflight.status !== 'ready') return;
    assert.equal(preflight.executable.executablePath, path.join(packageDir, 'bin', 'claude.exe'));
    assert.deepEqual(preflight.launch, { executablePath: path.join(packageDir, 'bin', 'claude.exe'), runWith: null, model: 'claude-fable-5-1', effort: 'xhigh', fallbackModel: null });
    assert.equal(preflight.observed.cliVersion, '2.1.263');
    assert.equal(preflight.vendorCliUsed, false);
    assert.equal(preflight.auth.code, 'AUTH_SUBSCRIPTION');
  });

  test('a probe failure ends preflight visibly with a stage and no substitute executable', async () => {
    const preflight = await resolvePreflight({
      launcherPath: path.join(shimDir, 'claude.ps1'),
      platform: 'win32',
      requestedModel: 'claude-fable-5-1',
      runtimeVersion: '0.1.0',
      probe: async () => { throw Object.assign(new Error('spawn EACCES raw detail'), { code: 'EACCES' }); },
    });
    assert.equal(preflight.status, 'failed');
    if (preflight.status !== 'failed') return;
    assert.equal(preflight.failureStage, 'cli-probe');
    assert.equal(preflight.code, 'CLI_PROBE_FAILED');
    assert.ok(!preflight.message.includes('raw detail'), 'raw errors are summarized, not leaked');
    assert.equal(preflight.launch, null);
  });

  test('an unauthorized or unverifiable authentication path stops before any session', async () => {
    const billing = await resolvePreflight({
      launcherPath: path.join(shimDir, 'claude.ps1'),
      platform: 'win32',
      requestedModel: 'claude-opus-5',
      runtimeVersion: '0.1.0',
      env: { ANTHROPIC_API_KEY: 'sk-ant-xyz' },
      probe: async () => ({ cliVersion: '2.1.263', advertisedFlags: ALL_FLAGS, authStatus: SUBSCRIPTION }),
    });
    assert.equal(billing.status, 'failed');
    if (billing.status === 'failed') {
      assert.equal(billing.failureStage, 'auth-path');
      assert.equal(billing.code, 'AUTH_API_BILLING_NOT_AUTHORIZED');
      assert.ok(!billing.message.includes('sk-ant-xyz'));
    }
    const unknown = await resolvePreflight({
      launcherPath: path.join(shimDir, 'claude.ps1'),
      platform: 'win32',
      requestedModel: 'claude-opus-5',
      runtimeVersion: '0.1.0',
      env: {},
      probe: async () => ({ cliVersion: '2.1.263', advertisedFlags: ALL_FLAGS, authStatus: null }),
    });
    assert.equal(unknown.status, 'failed');
    if (unknown.status === 'failed') assert.equal(unknown.code, 'AUTH_STATUS_UNKNOWN');
  });
});
