// Customization inventory before execution and trust approval stored outside
// the checkout, keyed by canonical project path and content fingerprint.
// Every inventory call injects isolated user roots and managed-settings
// candidates so the test never reads or approves real personal configuration.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import { inventoryCustomizations, MANAGED_SETTINGS_NOTE, type InventoryOptions } from '../src/trust/inventory.ts';
import { TrustStore } from '../src/trust/trust-store.ts';
import { resolveLaunchCustomizations } from '../src/trust/launch-customizations.ts';
import { makeTempRoot, type TempRoot } from './helpers/temp.ts';
import { assertRejectsCode } from './helpers/assert-code.ts';

let temp: TempRoot;
let workspace: string;
let storeRoot: string;
let userDir: string;
let userClaudeJson: string;
let managedCandidate: string;
let junctionOk = false;
let options: InventoryOptions;

async function seedWorkspace(root: string): Promise<string> {
  const parent = path.join(root, 'monorepo');
  const ws = path.join(parent, 'projeto');
  await mkdir(path.join(ws, '.claude', 'rules'), { recursive: true });
  await mkdir(path.join(ws, '.claude', 'agents'), { recursive: true });
  await mkdir(path.join(ws, '.claude', 'hooks'), { recursive: true });
  await mkdir(path.join(ws, '.claude', 'skills', 'deploy-helper'), { recursive: true });
  await mkdir(path.join(ws, 'sub', '.claude', 'rules'), { recursive: true });
  await mkdir(path.join(ws, 'node_modules', 'pkg'), { recursive: true });
  await writeFile(path.join(parent, 'CLAUDE.md'), '# regras do monorepo\n');
  await writeFile(path.join(ws, 'CLAUDE.md'), '# regras do projeto\n');
  await writeFile(path.join(ws, 'CLAUDE.local.md'), '# regras locais\n');
  await writeFile(path.join(ws, 'AGENTS.md'), '# instruções codex\n');
  await writeFile(path.join(ws, 'sub', 'CLAUDE.md'), '# regras do submódulo\n');
  await writeFile(path.join(ws, 'sub', '.claude', 'rules', 'sub-rule.md'), 'regra do submódulo\n');
  await writeFile(path.join(ws, 'node_modules', 'pkg', 'CLAUDE.md'), '# ignorado\n');
  await writeFile(path.join(ws, '.claude', 'rules', 'estilo.md'), 'use ponto e vírgula\n');
  await writeFile(path.join(ws, '.claude', 'hooks', 'check.ps1'), 'Write-Output ok\n');
  await writeFile(path.join(ws, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'pwsh -NoProfile -File .claude/hooks/check.ps1 --token=abc123' }] }] }, permissions: { allow: ['Bash(npm test)'] } }));
  await writeFile(path.join(ws, '.claude', 'agents', 'revisor.md'), '---\nname: revisor\n---\nrevise\n');
  await writeFile(path.join(ws, '.claude', 'skills', 'deploy-helper', 'SKILL.md'), '---\nname: deploy-helper\n---\n');
  await writeFile(path.join(ws, '.mcp.json'), JSON.stringify({ mcpServers: { docs: { command: 'node', args: ['docs.js'], env: { DOCS_TOKEN: 'segredo' } }, github: { type: 'http', url: 'https://example.invalid/mcp?token=segredo' } } }));
  return ws;
}

async function seedUser(root: string, ws: string): Promise<{ dir: string; claudeJson: string }> {
  const dir = path.join(root, 'user-claude');
  await mkdir(path.join(dir, 'agents'), { recursive: true });
  await mkdir(path.join(dir, 'skills', 'global'), { recursive: true });
  await writeFile(path.join(dir, 'CLAUDE.md'), '# instruções globais do usuário\n');
  await writeFile(path.join(dir, 'settings.json'), JSON.stringify({ hooks: { Notification: [{ hooks: [{ type: 'command', command: 'curl https://user:pw@example.invalid/notify' }] }] } }));
  await writeFile(path.join(dir, 'agents', 'revisor-global.md'), '---\nname: revisor-global\n---\n');
  await writeFile(path.join(dir, 'skills', 'global', 'SKILL.md'), '---\nname: global\n---\n');
  const claudeJson = path.join(root, 'user-claude.json');
  await writeFile(claudeJson, JSON.stringify({
    oauthAccount: { emailAddress: 'nunca@leia.invalid' },
    mcpServers: { calendar: { type: 'http', url: 'https://cal.invalid/mcp' } },
    projects: { [ws]: { mcpServers: { 'calendar-projeto': { command: 'node', args: ['cal.js'] } } }, 'C:\\outro\\projeto': { mcpServers: { alheio: { command: 'node' } } } },
  }));
  return { dir, claudeJson };
}

before(async () => {
  temp = await makeTempRoot('codeorquestra-trust-');
  workspace = await seedWorkspace(temp.root);
  const user = await seedUser(temp.root, workspace);
  userDir = user.dir;
  userClaudeJson = user.claudeJson;
  storeRoot = path.join(temp.root, 'state');
  managedCandidate = path.join(temp.root, 'managed', 'managed-settings.json');
  // The ancestor walk stops at the fixture root: discovery never reads a real
  // personal directory above it.
  options = { userConfigDir: userDir, userClaudeJsonPath: userClaudeJson, managedSettingsPaths: [managedCandidate], ancestorBoundary: temp.root };
  const outside = path.join(temp.root, 'outside-with-claude');
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, 'CLAUDE.md'), '# fora do workspace\n');
  try {
    await symlink(outside, path.join(workspace, 'linked'), 'junction');
    junctionOk = true;
  } catch {
    junctionOk = false;
  }
});
after(async () => { await temp.cleanup(); });

describe('inventoryCustomizations', () => {
  test('lists project, ancestor, child and user resources with scope, including hook scripts, without leaking secrets', async () => {
    const inventory = await inventoryCustomizations(workspace, options);
    const summary = inventory.items.map((item) => `${item.kind}:${item.scope}:${item.relativePath}`).sort();
    const expected = [
      'agent:project:.claude/agents/revisor.md',
      'agent:user:user:agents/revisor-global.md',
      'hook:project:.claude/hooks/check.ps1',
      'hook:project:.claude/settings.json#hooks.PreToolUse[0]',
      'hook:user:user:settings.json#hooks.Notification[0]',
      'instructions:ancestor:../CLAUDE.md',
      'instructions:child:sub/CLAUDE.md',
      'instructions:project:AGENTS.md',
      'instructions:project:CLAUDE.local.md',
      'instructions:project:CLAUDE.md',
      'instructions:user:user:CLAUDE.md',
      'mcp:project:.mcp.json#docs',
      'mcp:project:.mcp.json#github',
      'mcp:user:user:.claude.json#calendar',
      'mcp:user:user:.claude.json#projects#calendar-projeto',
      'rules:child:sub/.claude/rules/sub-rule.md',
      'rules:project:.claude/rules/estilo.md',
      'settings:project:.claude/settings.json',
      'settings:user:user:settings.json',
      'skill:project:.claude/skills/deploy-helper/SKILL.md',
      'skill:user:user:skills/global/SKILL.md',
    ].sort();
    assert.deepEqual(summary, expected);
    for (const item of inventory.items) assert.match(item.sha256, /^[a-f0-9]{64}$/);
    assert.match(inventory.fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(inventory.incomplete, false);
    assert.equal(inventory.canonicalWorkspace, inventory.canonicalWorkspace.toLowerCase(), 'canonical key is case-normalized on Windows');
    const github = inventory.items.find((item) => item.relativePath === '.mcp.json#github');
    assert.deepEqual(github?.details, { transport: 'http', host: 'example.invalid' }, 'no raw URLs, tokens or headers in the inventory');
    const hook = inventory.items.find((item) => item.relativePath === '.claude/settings.json#hooks.PreToolUse[0]');
    assert.deepEqual(hook?.details, { event: 'PreToolUse', matcher: 'Bash', hooks: [{ type: 'command', command: 'pwsh', argumentCount: 4, scripts: ['.claude/hooks/check.ps1'] }] }, 'structural hook summary only');
    const script = inventory.items.find((item) => item.relativePath === '.claude/hooks/check.ps1');
    assert.deepEqual(script?.details, { referencedBy: '.claude/settings.json#hooks.PreToolUse[0]' });
    const serialized = JSON.stringify(inventory);
    assert.ok(!serialized.includes('segredo'), 'MCP env and query strings never appear in the serialized inventory');
    assert.ok(!serialized.includes('abc123'), 'hook arguments never appear');
    assert.ok(!serialized.includes('user:pw@'), 'URL userinfo never appears');
    assert.ok(!serialized.includes('nunca@leia.invalid'), 'user .claude.json is inventoried only for MCP server names');
    assert.ok(!serialized.includes('alheio'), 'other projects in .claude.json are not attributed to this workspace');
    assert.ok(!summary.some((line) => line.includes('node_modules')));
    assert.deepEqual(inventory.managedSettings, { candidates: [managedCandidate], present: false, note: MANAGED_SETTINGS_NOTE });
  });

  test('a junction pointing outside the workspace is skipped, not inventoried as a child', async (t) => {
    if (!junctionOk) { t.skip('junction unsupported on this filesystem'); return; }
    const inventory = await inventoryCustomizations(workspace, options);
    assert.deepEqual(inventory.skipped, [{ path: 'linked', reason: 'REPARSE_OUTSIDE_WORKSPACE' }]);
    assert.ok(!inventory.items.some((item) => item.relativePath.startsWith('linked/')));
    assert.equal(inventory.incomplete, false, 'an outside junction is excluded, which does not make the inventory incomplete');
  });

  test('fingerprint changes with material content changes only, including user resources and hook scripts', async () => {
    const before = await inventoryCustomizations(workspace, options);
    await writeFile(path.join(workspace, 'src.txt'), 'não é personalização\n');
    const unrelated = await inventoryCustomizations(workspace, options);
    assert.equal(unrelated.fingerprint, before.fingerprint);
    await writeFile(path.join(workspace, 'CLAUDE.md'), '# regras do projeto alteradas\n');
    const changed = await inventoryCustomizations(workspace, options);
    assert.notEqual(changed.fingerprint, before.fingerprint);
    assert.deepEqual(changed.diff(before).changed, ['CLAUDE.md']);
    await writeFile(path.join(userDir, 'CLAUDE.md'), '# instruções globais alteradas\n');
    const userChanged = await inventoryCustomizations(workspace, options);
    assert.deepEqual(userChanged.diff(changed).changed, ['user:CLAUDE.md']);
    await writeFile(path.join(workspace, '.claude', 'hooks', 'check.ps1'), 'Write-Output alterado\n');
    const scriptChanged = await inventoryCustomizations(workspace, options);
    assert.deepEqual(scriptChanged.diff(userChanged).changed, ['.claude/hooks/check.ps1'], 'editing a hook script invalidates its approval');
  });

  test('the ancestor boundary is honoured and a boundary that is not an ancestor is reported', async () => {
    const inventory = await inventoryCustomizations(workspace, options);
    const ancestors = inventory.items.filter((item) => item.scope === 'ancestor').map((item) => item.relativePath);
    assert.deepEqual(ancestors, ['../CLAUDE.md'], 'only fixture ancestors are inventoried');
    assert.ok(!inventory.skipped.some((entry) => entry.reason === 'ANCESTOR_BOUNDARY_NOT_AN_ANCESTOR'));
    const wrong = await inventoryCustomizations(workspace, { ...options, ancestorBoundary: path.join(temp.root, 'nao-e-ancestral') });
    assert.ok(wrong.skipped.some((entry) => entry.reason === 'ANCESTOR_BOUNDARY_NOT_AN_ANCESTOR'), 'a boundary outside the chain is reported, not silently ignored');
  });

  test('hook entrypoints resolve CLAUDE_PROJECT_DIR without a shell, and an unresolved variable marks the inventory incomplete', async () => {
    const ws = path.join(temp.root, 'hook-vars');
    await mkdir(path.join(ws, '.claude', 'hooks'), { recursive: true });
    await mkdir(path.join(ws, 'scripts'), { recursive: true });
    await writeFile(path.join(ws, 'scripts', 'check.ps1'), 'Write-Output original\n');
    await writeFile(path.join(ws, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'pwsh -NoProfile -File "$CLAUDE_PROJECT_DIR/scripts/check.ps1"' }] }] } }));
    const local = { ...options, ancestorBoundary: ws };
    const resolved = await inventoryCustomizations(ws, local);
    assert.ok(resolved.items.some((item) => item.relativePath === 'scripts/check.ps1' && item.kind === 'hook'), 'the referenced script is fingerprinted');
    assert.equal(resolved.incomplete, false);
    await writeFile(path.join(ws, 'scripts', 'check.ps1'), 'Write-Output alterado\n');
    const changed = await inventoryCustomizations(ws, local);
    assert.deepEqual(changed.diff(resolved).changed, ['scripts/check.ps1'], 'editing the script invalidates the recorded trust');

    await writeFile(path.join(ws, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'pwsh -NoProfile -File "$MEU_DIRETORIO/check.ps1"' }] }] } }));
    const unresolved = await inventoryCustomizations(ws, local);
    assert.equal(unresolved.incomplete, true, 'an unresolved entrypoint cannot be called trusted');
    assert.ok(unresolved.skipped.some((entry) => entry.reason.startsWith('UNRESOLVED_HOOK_ENTRYPOINT:MEU_DIRETORIO')));
    const store = new TrustStore(path.join(temp.root, 'hook-var-state'));
    const check = await store.check(unresolved);
    assert.equal(check.trusted, false);
    assert.equal(check.reason, 'INVENTORY_INCOMPLETE');
  });

  test('discovery limits are reported as incomplete, and managed settings presence is reported separately', async () => {
    const deep = path.join(temp.root, 'deep-ws');
    let current = deep;
    for (let level = 1; level <= 14; level += 1) current = path.join(current, `n${level}`);
    await mkdir(current, { recursive: true });
    await writeFile(path.join(current, 'CLAUDE.md'), '# profundo\n');
    const inventory = await inventoryCustomizations(deep, { ...options, maxChildDepth: 12 });
    assert.equal(inventory.incomplete, true);
    assert.ok(inventory.skipped.some((entry) => entry.reason === 'DEPTH_LIMIT'));
    const store = new TrustStore(storeRoot);
    const check = await store.check(inventory);
    assert.equal(check.trusted, false);
    assert.equal(check.reason, 'INVENTORY_INCOMPLETE');
    await assertRejectsCode(store.approve({ inventory, identity: { threadId: 't', source: 'codex-thread' }, approvalRevision: 1, approvedItems: 'all' }), 'INVENTORY_INCOMPLETE');
    await mkdir(path.dirname(managedCandidate), { recursive: true });
    await writeFile(managedCandidate, '{}');
    const withManaged = await inventoryCustomizations(workspace, options);
    assert.equal(withManaged.managedSettings.present, true);
    assert.ok(!withManaged.items.some((item) => item.relativePath.includes('managed')), 'managed settings are not approvable items');
  });
});

describe('TrustStore', () => {
  test('stores approval outside the checkout with identity and revision, and detects invalidation', async () => {
    const store = new TrustStore(storeRoot);
    const inventory = await inventoryCustomizations(workspace, options);
    const approval = await store.approve({
      inventory,
      identity: { threadId: 'thread-a', source: 'codex-thread' },
      approvalRevision: 1,
      approvedItems: inventory.items.map((item) => item.relativePath),
    });
    assert.equal(approval.canonicalWorkspace, inventory.canonicalWorkspace);
    assert.equal(approval.fingerprint, inventory.fingerprint);
    const files = await readdir(path.join(storeRoot, 'trust'));
    assert.equal(files.length, 1);
    assert.ok(!approval.file.startsWith(workspace), 'trust record must live outside the checkout');
    assert.deepEqual(await store.check(inventory), { trusted: true, approvalRevision: 1, pending: [], changed: [], reason: 'TRUSTED' });

    await writeFile(path.join(workspace, '.claude', 'rules', 'estilo.md'), 'regra alterada\n');
    const changedInventory = await inventoryCustomizations(workspace, options);
    assert.deepEqual(await store.check(changedInventory), { trusted: false, reason: 'FINGERPRINT_CHANGED', changed: ['.claude/rules/estilo.md'], pending: [] });
  });

  test('unknown resources stay pending and disabled until approved', async () => {
    const store = new TrustStore(storeRoot);
    const inventory = await inventoryCustomizations(workspace, options);
    await store.approve({ inventory, identity: { threadId: 'thread-a', source: 'codex-thread' }, approvalRevision: 2, approvedItems: 'all' });
    await writeFile(path.join(workspace, '.claude', 'agents', 'novo.md'), '---\nname: novo\n---\n');
    const withNew = await inventoryCustomizations(workspace, options);
    const check = await store.check(withNew);
    assert.equal(check.trusted, false);
    assert.equal(check.reason, 'PENDING_RESOURCES');
    assert.deepEqual(check.pending, ['.claude/agents/novo.md']);
    const launch = resolveLaunchCustomizations({ inventory: withNew, trust: check });
    assert.deepEqual(launch, {
      settingSources: [],
      strictMcpConfig: true,
      mcpConfigIsExhaustive: true,
      autoMemoryEnabled: false,
      env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
      mcpServers: {},
      loadProjectInstructions: false,
      pendingApproval: ['.claude/agents/novo.md'],
      reason: 'PENDING_RESOURCES',
    });
  });

  test('approving an MCP server never authorizes its external mutations', async () => {
    const store = new TrustStore(storeRoot);
    const inventory = await inventoryCustomizations(workspace, options);
    const approval = await store.approve({ inventory, identity: { threadId: 'thread-a', source: 'codex-thread' }, approvedRevisionNote: 'aprovado pelo usuário', approvalRevision: 3, approvedItems: 'all' });
    assert.deepEqual(approval.mcpServers, {
      calendar: { approved: true, externalMutations: 'escalate' },
      'calendar-projeto': { approved: true, externalMutations: 'escalate' },
      docs: { approved: true, externalMutations: 'escalate' },
      github: { approved: true, externalMutations: 'escalate' },
    });
    const check = await store.check(inventory);
    const launch = resolveLaunchCustomizations({ inventory, trust: check, record: approval });
    assert.deepEqual(Object.keys(launch.mcpServers).sort(), ['calendar', 'calendar-projeto', 'docs', 'github']);
    assert.equal(launch.loadProjectInstructions, true);
    assert.deepEqual(launch.settingSources, ['user', 'project']);
    assert.equal(launch.autoMemoryEnabled, false, 'auto-memory stays off until it is inventoried explicitly');
    assert.equal(launch.mcpConfigIsExhaustive, true, 'strict MCP config makes the approved set the complete one');
    assert.ok(!JSON.stringify(inventory).includes('segredo'), 'launch configs are not part of the serialized inventory');
  });

  test('a trust record from another store or canonical workspace does not apply, and no customizations means nothing to approve', async () => {
    const store = new TrustStore(storeRoot);
    const inventory = await inventoryCustomizations(workspace, options);
    const other = await inventoryCustomizations(workspace.toUpperCase(), options);
    assert.equal(other.canonicalWorkspace, inventory.canonicalWorkspace, 'case differences map to the same canonical project');
    const elsewhere = new TrustStore(path.join(temp.root, 'other-state'));
    assert.deepEqual(await elsewhere.check(inventory), { trusted: false, reason: 'NOT_APPROVED', changed: [], pending: inventory.items.map((item) => item.relativePath).sort() });
    const empty = path.join(temp.root, 'empty-ws');
    await mkdir(empty, { recursive: true });
    const emptyInventory = await inventoryCustomizations(empty, { userConfigDir: null, userClaudeJsonPath: null, managedSettingsPaths: null, ancestorBoundary: empty });
    assert.deepEqual(await store.check(emptyInventory), { trusted: true, approvalRevision: null, pending: [], changed: [], reason: 'NO_CUSTOMIZATIONS' });
    assert.deepEqual(emptyInventory.managedSettings, { candidates: [], present: null, note: MANAGED_SETTINGS_NOTE });
  });
});
