// Action classification for the development profile: no static exact command
// list; actions known to be in scope are allowed, reserved operations are
// denied with intelligible reasons, and unknown or risky actions escalate to
// a visible permission request instead of a silent denial. Text
// classification is a guardrail, not a sandbox. Every command string here is
// classified only; nothing is executed.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { classifyToolAction, type ActionContext } from '../src/policy/action-classifier.ts';
import { responsibilities } from './helpers/fixtures.ts';
import { makeTempRoot, type TempRoot } from './helpers/temp.ts';

const workspace = 'C:\\ws\\projeto';

function context(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    profile: 'development',
    workspace,
    scopePaths: ['src/', 'test/'],
    responsibilities: responsibilities(),
    approvedMcpServers: ['docs'],
    approvedMcpTools: { mcp__docs__search: { readOnly: true }, mcp__docs__create_page: { readOnly: false } },
    approvedAgents: ['revisor'],
    approvedSkills: ['deploy-helper'],
    authorizedModels: ['claude-fable-5-1', 'claude-opus-5'],
    requiredEffort: 'xhigh',
    ...overrides,
  };
}

function classify(tool: string, input: Record<string, unknown>, overrides: Partial<ActionContext> = {}) {
  return classifyToolAction({ tool, input }, context(overrides));
}

function pick(result: { decision: string; reason: string }): { decision: string; reason: string } {
  return { decision: result.decision, reason: result.reason };
}

/** Inspection only: implementation and testing belong to Codex. */
const inspectionOnly: Partial<ActionContext> = { responsibilities: responsibilities({ implementation: 'codex', testing: 'codex' }) };

describe('development profile classification', () => {
  test('in-scope edits and tests are allowed when assigned to Claude', () => {
    assert.deepEqual(pick(classify('Edit', { file_path: 'C:\\ws\\projeto\\src\\a.ts' })), { decision: 'allow', reason: 'IN_SCOPE_IMPLEMENTATION' });
    assert.deepEqual(pick(classify('Write', { file_path: 'C:\\ws\\projeto\\test\\a.test.ts' })), { decision: 'allow', reason: 'IN_SCOPE_IMPLEMENTATION' });
    assert.deepEqual(pick(classify('Bash', { command: 'npm test' })), { decision: 'allow', reason: 'TESTING_COMMAND' });
    assert.deepEqual(pick(classify('Bash', { command: 'node --test test/a.test.ts' })), { decision: 'allow', reason: 'TESTING_COMMAND' });
    assert.deepEqual(pick(classify('Bash', { command: 'git status --short' })), { decision: 'allow', reason: 'INSPECTION_COMMAND' });
    assert.deepEqual(pick(classify('Bash', { command: 'git -C src status' })), { decision: 'allow', reason: 'INSPECTION_COMMAND' });
    assert.deepEqual(pick(classify('Bash', { command: 'git diff -- src' })), { decision: 'allow', reason: 'INSPECTION_COMMAND' });
    // Regression: `worktree` used to sit in GIT_STATE_RULES, which is tested
    // before INSPECTION_RULES, so this inspection alternative was unreachable.
    assert.deepEqual(pick(classify('Bash', { command: 'git worktree list' })), { decision: 'allow', reason: 'INSPECTION_COMMAND' });
    assert.deepEqual(pick(classify('Read', { file_path: 'C:\\ws\\projeto\\README.md' })), { decision: 'allow', reason: 'IN_WORKSPACE_READ' });
    assert.deepEqual(pick(classify('Grep', { pattern: 'x', path: 'C:\\ws\\projeto' })), { decision: 'allow', reason: 'IN_WORKSPACE_READ' });
    assert.deepEqual(pick(classify('Glob', { pattern: '**/*.ts' })), { decision: 'allow', reason: 'IN_WORKSPACE_READ' });
    assert.deepEqual(pick(classify('Write', { file_path: 'C:\\ws\\projeto\\docs\\x.md' }, { scopePaths: [], wholeWorkspace: true })), { decision: 'allow', reason: 'IN_SCOPE_IMPLEMENTATION' }, 'explicit whole-workspace scope');
  });

  test('reserved operations are denied with a Portuguese reason', () => {
    const cases: Array<[string, string]> = [
      ['git push origin HEAD', 'RESERVED_OPERATION_PUSH'],
      ['git commit -m "x"', 'RESERVED_OPERATION_COMMIT'],
      ['git merge feature', 'RESERVED_OPERATION_COMMIT'],
      ['gh pr create --fill', 'RESERVED_OPERATION_PUSH'],
      ['gh pr merge 12', 'RESERVED_OPERATION_PUSH'],
      ['npm publish', 'RESERVED_OPERATION_DEPLOY'],
      ['codex plugin add claude-code-live@haise-local', 'RESERVED_OPERATION_INSTALL'],
      ['claude config set model opus', 'RESERVED_OPERATION_CONFIG'],
      ['npm install -g something', 'RESERVED_OPERATION_INSTALL'],
      ['npm --prefix runtime install -g something', 'RESERVED_OPERATION_INSTALL'],
      ['git worktree add ../wt-a feature', 'RESERVED_OPERATION_WORKTREE'],
      ['git worktree remove ../wt-a', 'RESERVED_OPERATION_WORKTREE'],
      ['git worktree prune', 'RESERVED_OPERATION_WORKTREE'],
    ];
    for (const [command, reason] of cases) {
      const result = classify('Bash', { command });
      assert.equal(result.decision, 'deny', command);
      assert.equal(result.reason, reason, command);
      assert.match(result.message, /reservad/i, command);
    }
  });

  test('sensitive files are blocked for reading and writing', () => {
    for (const file of ['C:\\ws\\projeto\\.env', 'C:\\ws\\projeto\\config\\.env.local', 'C:\\ws\\projeto\\keys\\id_rsa', 'C:\\ws\\projeto\\secrets\\service-account.json', 'C:\\ws\\projeto\\.git\\config']) {
      assert.deepEqual(pick(classify('Read', { file_path: file })), { decision: 'deny', reason: 'SENSITIVE_FILE' }, file);
      assert.deepEqual(pick(classify('Write', { file_path: file, content: 'x' })), { decision: 'deny', reason: 'SENSITIVE_FILE' }, file);
    }
    assert.deepEqual(pick(classify('Bash', { command: 'type .env' })), { decision: 'deny', reason: 'SENSITIVE_FILE' });
    assert.deepEqual(pick(classify('Bash', { command: 'cat C:/ws/projeto/.env' })), { decision: 'deny', reason: 'SENSITIVE_FILE' });
    assert.deepEqual(pick(classify('Bash', { command: 'sort < .env' })), { decision: 'deny', reason: 'SENSITIVE_FILE' });
    assert.deepEqual(pick(classify('Bash', { command: 'npm test -- --env=production' })), { decision: 'allow', reason: 'TESTING_COMMAND' }, 'an --env flag is not a .env file');
  });

  test('the git administrative area is not writable, but .git-prefixed project files are', () => {
    // A hook written here runs on the next commit, and commit never belongs to
    // Claude. Only .git/config and .git/credentials were sensitive by pattern.
    for (const file of ['C:\\ws\\projeto\\.git\\hooks\\pre-commit', 'C:\\ws\\projeto\\.git', 'C:\\ws\\projeto\\.git\\info\\exclude', 'C:\\ws\\projeto\\src\\.git\\hooks\\post-merge']) {
      assert.deepEqual(pick(classify('Write', { file_path: file, content: 'x' })), { decision: 'deny', reason: 'GIT_ADMIN_AREA' }, file);
      assert.deepEqual(pick(classify('Edit', { file_path: file })), { decision: 'deny', reason: 'GIT_ADMIN_AREA' }, file);
    }
    assert.deepEqual(pick(classify('Bash', { command: 'echo x > .git/hooks/pre-commit' })), { decision: 'deny', reason: 'GIT_ADMIN_AREA' }, 'also through a shell redirect');
    // `.gitignore`, `.gitattributes` and `.github/` are ordinary project files:
    // they share a prefix with `.git` but are not that path segment.
    assert.deepEqual(pick(classify('Write', { file_path: 'C:\\ws\\projeto\\src\\.gitignore', content: 'x' }, { scopePaths: [], wholeWorkspace: true })), { decision: 'allow', reason: 'IN_SCOPE_IMPLEMENTATION' });
    assert.deepEqual(pick(classify('Write', { file_path: 'C:\\ws\\projeto\\src\\.gitattributes', content: 'x' }, { scopePaths: [], wholeWorkspace: true })), { decision: 'allow', reason: 'IN_SCOPE_IMPLEMENTATION' });
    assert.deepEqual(pick(classify('Write', { file_path: 'C:\\ws\\projeto\\src\\.github\\workflows\\ci.yml', content: 'x' }, { scopePaths: [], wholeWorkspace: true })), { decision: 'allow', reason: 'IN_SCOPE_IMPLEMENTATION' });
  });

  test('workspace and scope boundaries, including prefix collisions', () => {
    assert.deepEqual(pick(classify('Write', { file_path: 'C:\\outro\\x.ts' })), { decision: 'deny', reason: 'OUTSIDE_WORKSPACE' });
    assert.deepEqual(pick(classify('Edit', { file_path: 'C:\\ws\\projeto\\..\\..\\x.ts' })), { decision: 'deny', reason: 'OUTSIDE_WORKSPACE' });
    assert.deepEqual(pick(classify('Read', { file_path: 'C:\\outro\\x.ts' })), { decision: 'escalate', reason: 'OUTSIDE_WORKSPACE_READ' });
    assert.deepEqual(pick(classify('Write', { file_path: 'C:\\ws\\projeto\\docs\\x.md' })), { decision: 'escalate', reason: 'OUTSIDE_SCOPE_PATH' });
    assert.deepEqual(pick(classify('Write', { file_path: 'C:\\ws\\projeto\\src-secret\\a.ts' })), { decision: 'escalate', reason: 'OUTSIDE_SCOPE_PATH' }, 'src/ must not match src-secret/');
    assert.deepEqual(pick(classify('Write', { file_path: 'C:\\ws\\projeto-2\\src\\a.ts' })), { decision: 'deny', reason: 'OUTSIDE_WORKSPACE' }, 'workspace prefix collision');
  });

  test('risky external or destructive actions escalate instead of running silently', () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['Bash', { command: 'curl https://example.com' }, 'EXTERNAL_NETWORK'],
      ['Bash', { command: 'Invoke-WebRequest https://example.com' }, 'EXTERNAL_NETWORK'],
      ['WebFetch', { url: 'https://example.com' }, 'EXTERNAL_NETWORK'],
      ['Bash', { command: 'rm -rf dist' }, 'DESTRUCTIVE'],
      ['Bash', { command: 'Remove-Item -Recurse -Force dist' }, 'DESTRUCTIVE'],
      ['Bash', { command: 'git checkout -- .' }, 'DESTRUCTIVE'],
      ['Bash', { command: 'git reset --hard HEAD~1' }, 'DESTRUCTIVE'],
      ['Bash', { command: 'git stash' }, 'DESTRUCTIVE'],
      ['Bash', { command: 'find . -delete' }, 'DESTRUCTIVE'],
      ['Bash', { command: 'npm --prefix runtime install --ignore-scripts' }, 'DEPENDENCY_CHANGE'],
      ['Bash', { command: 'npm install --no-audit --prefix=runtime' }, 'DEPENDENCY_CHANGE'],
      ['Bash', { command: 'pip install requests' }, 'DEPENDENCY_CHANGE'],
      ['Bash', { command: 'taskkill /IM node.exe /F' }, 'PROCESS_KILL_BROAD'],
      ['Bash', { command: 'some-unknown-tool --flag' }, 'UNCLASSIFIED_COMMAND'],
      ['Bash', { command: 'env' }, 'ENV_DISCLOSURE'],
      ['Bash', { command: 'git add -A' }, 'GIT_STATE_CHANGE'],
      ['UnknownTool', { anything: 1 }, 'UNCLASSIFIED_TOOL'],
    ];
    for (const [tool, input, reason] of cases) {
      const result = classify(tool, input);
      assert.equal(result.decision, 'escalate', JSON.stringify(input));
      assert.equal(result.reason, reason, JSON.stringify(input));
      assert.ok(result.message.length > 20, 'escalations carry an explanation for the coordinator');
    }
  });

  test('interpreter evaluation and mutating variants of read-only commands are never inspection', () => {
    for (const command of ['node -e 1', 'node -p "process.env"', 'python -c "print(1)"', 'pwsh -Command Get-Date', 'bash -c "ls"', 'cmd /c dir', 'find . -exec rm {} \\;', 'xargs rm', 'Invoke-Expression "ls"']) {
      assert.deepEqual(pick(classify('Bash', { command }, inspectionOnly)), { decision: 'escalate', reason: 'INTERPRETER_EVAL' }, command);
    }
    assert.deepEqual(pick(classify('Bash', { command: 'find . -delete' }, inspectionOnly)), { decision: 'escalate', reason: 'DESTRUCTIVE' });
  });

  test('shell writes require implementation ownership and an in-scope destination, including no-space redirection', () => {
    for (const command of ['echo hello > src/probe.txt', 'echo hello>src/probe.txt', 'echo hello >> src/probe.txt', 'sort -o other.txt src/test.txt', 'sort src/test.txt --output=src/out.txt', 'uniq src/a.txt src/b.txt', 'tee src/log.txt', 'cp src/a.ts src/b.ts', 'mv src/a.ts src/b.ts', 'find . -fprint src/list.txt', 'ls 2> src/errors.txt']) {
      assert.deepEqual(pick(classify('Bash', { command }, inspectionOnly)), { decision: 'deny', reason: 'NOT_ASSIGNED_IMPLEMENTATION' }, command);
    }
    assert.deepEqual(pick(classify('Bash', { command: 'echo hello > src/probe.txt' })), { decision: 'allow', reason: 'IMPLEMENTATION_COMMAND' });
    assert.deepEqual(pick(classify('Bash', { command: 'echo hello>src/probe.txt' })), { decision: 'allow', reason: 'IMPLEMENTATION_COMMAND' });
    assert.deepEqual(pick(classify('Bash', { command: 'sort -o other.txt src/test.txt' })), { decision: 'escalate', reason: 'OUTSIDE_SCOPE_PATH' }, 'destination outside scope even with implementation assigned');
    assert.deepEqual(pick(classify('Bash', { command: 'mv src/a.ts docs/a.ts' })), { decision: 'escalate', reason: 'OUTSIDE_SCOPE_PATH' }, 'move destination validated against scope');
    assert.deepEqual(pick(classify('Bash', { command: 'mv docs/a.ts src/a.ts' })), { decision: 'escalate', reason: 'OUTSIDE_SCOPE_PATH' }, 'move source is also modified');
    assert.deepEqual(pick(classify('Bash', { command: 'cp docs/a.ts src/a.ts' })), { decision: 'allow', reason: 'IMPLEMENTATION_COMMAND' }, 'copy only writes the destination');
    assert.deepEqual(pick(classify('Bash', { command: 'echo x > C:\\outro\\log.txt' })), { decision: 'deny', reason: 'OUTSIDE_WORKSPACE' });
    assert.deepEqual(pick(classify('Bash', { command: 'echo x > .env' })), { decision: 'deny', reason: 'SENSITIVE_FILE' });
    assert.deepEqual(pick(classify('Bash', { command: 'npm test > test\\saida.txt' })), { decision: 'allow', reason: 'TESTING_COMMAND' });
    assert.deepEqual(pick(classify('Bash', { command: 'npm test > docs\\saida.txt' })), { decision: 'escalate', reason: 'OUTSIDE_SCOPE_PATH' });
    assert.deepEqual(pick(classify('Bash', { command: 'npm test 2>&1' })), { decision: 'allow', reason: 'TESTING_COMMAND' }, 'descriptor duplication is not a file write');
  });

  test('chained commands and substitution are classified by their worst segment', () => {
    assert.deepEqual(pick(classify('Bash', { command: 'npm test && git push origin main' })), { decision: 'deny', reason: 'RESERVED_OPERATION_PUSH' });
    assert.deepEqual(pick(classify('Bash', { command: 'npm test; curl https://example.com' })), { decision: 'escalate', reason: 'EXTERNAL_NETWORK' });
    assert.deepEqual(pick(classify('Bash', { command: 'git status | findstr modified' })), { decision: 'allow', reason: 'INSPECTION_COMMAND' });
    assert.deepEqual(pick(classify('Bash', { command: 'echo $(git push origin main)' })), { decision: 'deny', reason: 'RESERVED_OPERATION_PUSH' });
    assert.deepEqual(pick(classify('Bash', { command: 'echo `whoami`' })), { decision: 'escalate', reason: 'SHELL_SUBSTITUTION' });
    assert.deepEqual(pick(classify('Bash', { command: 'git -C C:\\outro status' })), { decision: 'deny', reason: 'OUTSIDE_WORKSPACE' });
    assert.deepEqual(pick(classify('Bash', { command: 'npm --prefix C:\\outro test' })), { decision: 'deny', reason: 'OUTSIDE_WORKSPACE' });
    assert.deepEqual(pick(classify('Bash', { command: 'node ..\\..\\script.js' })), { decision: 'deny', reason: 'OUTSIDE_WORKSPACE' });
  });

  test('responsibility ownership gates edits and tests', () => {
    assert.deepEqual(pick(classify('Edit', { file_path: 'C:\\ws\\projeto\\src\\a.ts' }, { responsibilities: responsibilities({ implementation: 'codex' }) })), { decision: 'deny', reason: 'NOT_ASSIGNED_IMPLEMENTATION' });
    assert.deepEqual(pick(classify('Bash', { command: 'npm test' }, { responsibilities: responsibilities({ testing: 'codex' }) })), { decision: 'deny', reason: 'NOT_ASSIGNED_TESTING' });
    assert.deepEqual(pick(classify('Read', { file_path: 'C:\\ws\\projeto\\src\\a.ts' }, { responsibilities: responsibilities({ inspection: 'codex', implementation: 'codex', testing: 'codex' }) })), { decision: 'deny', reason: 'NOT_ASSIGNED_INSPECTION' });
  });

  test('approving an MCP server never authorizes its external mutations, and tool semantics must be declared', () => {
    assert.deepEqual(pick(classify('mcp__docs__search', { query: 'x' })), { decision: 'allow', reason: 'MCP_APPROVED_READ' });
    assert.deepEqual(pick(classify('mcp__docs__create_page', { title: 'x' })), { decision: 'escalate', reason: 'MCP_EXTERNAL_MUTATION' });
    assert.deepEqual(pick(classify('mcp__docs__search_and_delete', { query: 'x' })), { decision: 'escalate', reason: 'MCP_TOOL_SEMANTICS_UNKNOWN' }, 'a read-sounding name is not evidence');
    assert.deepEqual(pick(classify('mcp__unknown__search', { query: 'x' })), { decision: 'deny', reason: 'MCP_SERVER_NOT_APPROVED' });
    assert.deepEqual(pick(classify('mcp__docs__search', { query: 'x' }, { approvedMcpTools: {} })), { decision: 'escalate', reason: 'MCP_TOOL_SEMANTICS_UNKNOWN' });
  });

  test('read profile only reads', () => {
    assert.deepEqual(pick(classify('Read', { file_path: 'C:\\ws\\projeto\\a.ts' }, { profile: 'read' })), { decision: 'allow', reason: 'IN_WORKSPACE_READ' });
    assert.deepEqual(pick(classify('Edit', { file_path: 'C:\\ws\\projeto\\src\\a.ts' }, { profile: 'read' })), { decision: 'deny', reason: 'READ_ONLY_PROFILE' });
    assert.deepEqual(pick(classify('Bash', { command: 'git status' }, { profile: 'read' })), { decision: 'deny', reason: 'READ_ONLY_PROFILE' });
  });

  test('a planning contract cannot regain write or shell through any path, even with Claude as implementation owner', () => {
    // A planning phase yields capabilities edit/test false and commands none,
    // while the responsibility matrix still names Claude.
    const planning: Partial<ActionContext> = { capabilities: { edit: false, test: false, commands: 'none' } };
    assert.deepEqual(pick(classify('Write', { file_path: 'C:\\ws\\projeto\\src\\a.ts' }, planning)), { decision: 'deny', reason: 'CAPABILITY_EDIT_NOT_GRANTED' });
    assert.deepEqual(pick(classify('Edit', { file_path: 'C:\\ws\\projeto\\src\\a.ts' }, planning)), { decision: 'deny', reason: 'CAPABILITY_EDIT_NOT_GRANTED' });
    assert.deepEqual(pick(classify('Bash', { command: 'npm test' }, planning)), { decision: 'deny', reason: 'CAPABILITY_COMMANDS_NOT_GRANTED' });
    assert.deepEqual(pick(classify('Bash', { command: 'echo x > src/a.ts' }, planning)), { decision: 'deny', reason: 'CAPABILITY_COMMANDS_NOT_GRANTED' });
    assert.deepEqual(pick(classify('Read', { file_path: 'C:\\ws\\projeto\\src\\a.ts' }, planning)), { decision: 'allow', reason: 'IN_WORKSPACE_READ' });
    const noEdit: Partial<ActionContext> = { capabilities: { edit: false, test: true, commands: 'classified' } };
    assert.deepEqual(pick(classify('Bash', { command: 'echo x > src/a.ts' }, noEdit)), { decision: 'deny', reason: 'CAPABILITY_EDIT_NOT_GRANTED' });
    assert.deepEqual(pick(classify('Bash', { command: 'npm test' }, noEdit)), { decision: 'allow', reason: 'TESTING_COMMAND' });
  });

  test('delegation and skills inherit the contract instead of trusting the native tool name', () => {
    assert.deepEqual(pick(classify('Task', { subagent_type: 'revisor', prompt: 'revise' })), { decision: 'allow', reason: 'BUILTIN_SAFE' });
    assert.deepEqual(pick(classify('Task', { subagent_type: 'desconhecido', prompt: 'x' })), { decision: 'escalate', reason: 'AGENT_NOT_APPROVED' });
    assert.deepEqual(pick(classify('Task', {})), { decision: 'escalate', reason: 'AGENT_NOT_APPROVED' });
    assert.deepEqual(pick(classify('Task', { subagent_type: 'revisor', model: 'claude-sonnet-5' })), { decision: 'deny', reason: 'DELEGATION_MODEL_OVERRIDE' });
    assert.deepEqual(pick(classify('Task', { subagent_type: 'revisor', model: 'claude-opus-5' })), { decision: 'allow', reason: 'BUILTIN_SAFE' });
    assert.deepEqual(pick(classify('Skill', { skill: 'deploy-helper' })), { decision: 'allow', reason: 'BUILTIN_SAFE' });
    assert.deepEqual(pick(classify('Skill', { skill: 'outra' })), { decision: 'escalate', reason: 'SKILL_NOT_APPROVED' });
    assert.deepEqual(
      pick(classify('Task', { subagent_type: 'revisor' }, { capabilities: { edit: false, test: false, commands: 'none' } })),
      { decision: 'escalate', reason: 'DELEGATION_WITHOUT_CAPABILITY' },
    );
  });

  test('a delegation may not weaken the effort, nor pick a model when no set was declared', () => {
    // The contract effort is carried into the context; anything else is refused.
    assert.deepEqual(pick(classify('Task', { subagent_type: 'revisor', effort: 'xhigh' })), { decision: 'allow', reason: 'BUILTIN_SAFE' });
    for (const effort of ['low', 'medium', 'high', 'max']) {
      assert.deepEqual(pick(classify('Task', { subagent_type: 'revisor', effort })), { decision: 'deny', reason: 'DELEGATION_EFFORT_OVERRIDE' }, effort);
    }
    assert.deepEqual(
      pick(classify('Task', { subagent_type: 'revisor', effort: 'high' }, { requiredEffort: 'high' })),
      { decision: 'allow', reason: 'BUILTIN_SAFE' },
      'a contract that authorized another effort keeps its own',
    );
    // Without a declared model set there is nothing to validate against: an
    // unchecked delegated model could launch anything, so it is refused.
    const withoutModels = context();
    delete withoutModels.authorizedModels;
    assert.deepEqual(
      pick(classifyToolAction({ tool: 'Task', input: { subagent_type: 'revisor', model: 'claude-opus-5' } }, withoutModels)),
      { decision: 'deny', reason: 'DELEGATION_MODEL_OVERRIDE' },
    );
  });
});

describe('filesystem containment with real reparse points', () => {
  let temp: TempRoot;
  let realWorkspace: string;
  let outside: string;
  let junctionOk = false;
  let sensitiveLinkOk = false;
  let scopeLinkOk = false;
  before(async () => {
    temp = await makeTempRoot('codeorquestra-actions-');
    realWorkspace = path.join(temp.root, 'ws');
    outside = path.join(temp.root, 'outside');
    await mkdir(path.join(realWorkspace, 'src'), { recursive: true });
    await mkdir(path.join(realWorkspace, 'segredos'), { recursive: true });
    await mkdir(path.join(realWorkspace, 'fora-do-escopo'), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, 'x.ts'), 'x');
    // Synthetic fixture content only; never a real credential.
    await writeFile(path.join(realWorkspace, 'segredos', '.env'), 'FIXTURE=valor-sintetico\n');
    await writeFile(path.join(realWorkspace, 'fora-do-escopo', 'alvo.ts'), 'export const a = 1;\n');
    try {
      await symlink(outside, path.join(realWorkspace, 'src', 'link'), 'junction');
      junctionOk = true;
    } catch {
      junctionOk = false;
    }
    try {
      await symlink(path.join(realWorkspace, 'segredos', '.env'), path.join(realWorkspace, 'src', 'config.ts'), 'file');
      sensitiveLinkOk = true;
    } catch {
      sensitiveLinkOk = false;
    }
    try {
      await symlink(path.join(realWorkspace, 'fora-do-escopo'), path.join(realWorkspace, 'src', 'externo'), 'junction');
      scopeLinkOk = true;
    } catch {
      scopeLinkOk = false;
    }
  });
  after(async () => { await temp.cleanup(); });

  test('a junction inside the scope that points outside the workspace is denied for writes', (t) => {
    if (!junctionOk) { t.skip('could not create a junction on this filesystem'); return; }
    const ctx: Partial<ActionContext> = { workspace: realWorkspace, scopePaths: ['src/'] };
    assert.deepEqual(pick(classify('Write', { file_path: path.join(realWorkspace, 'src', 'link', 'x.ts') }, ctx)), { decision: 'deny', reason: 'OUTSIDE_WORKSPACE' });
    assert.deepEqual(pick(classify('Read', { file_path: path.join(realWorkspace, 'src', 'link', 'x.ts') }, ctx)), { decision: 'escalate', reason: 'OUTSIDE_WORKSPACE_READ' });
    assert.deepEqual(pick(classify('Bash', { command: 'echo x > src/link/x.ts' }, ctx)), { decision: 'deny', reason: 'OUTSIDE_WORKSPACE' });
    assert.deepEqual(pick(classify('Write', { file_path: path.join(realWorkspace, 'src', 'novo.ts') }, ctx)), { decision: 'allow', reason: 'IN_SCOPE_IMPLEMENTATION' });
  });

  test('an in-scope link whose real target is a sensitive file is blocked by the resolved target', (t) => {
    if (!sensitiveLinkOk) { t.skip('symlinks unavailable on this filesystem'); return; }
    const ctx: Partial<ActionContext> = { workspace: realWorkspace, scopePaths: ['src/'] };
    const alias = path.join(realWorkspace, 'src', 'config.ts');
    assert.deepEqual(pick(classify('Read', { file_path: alias }, ctx)), { decision: 'deny', reason: 'SENSITIVE_TARGET' });
    assert.deepEqual(pick(classify('Write', { file_path: alias }, ctx)), { decision: 'deny', reason: 'SENSITIVE_TARGET' });
    assert.deepEqual(pick(classify('Bash', { command: 'cat src/config.ts' }, ctx)), { decision: 'deny', reason: 'SENSITIVE_TARGET' });
  });

  test('an in-scope link whose real target sits outside the approved scope escalates', (t) => {
    if (!scopeLinkOk) { t.skip('junctions unavailable on this filesystem'); return; }
    const ctx: Partial<ActionContext> = { workspace: realWorkspace, scopePaths: ['src/'] };
    assert.deepEqual(pick(classify('Write', { file_path: path.join(realWorkspace, 'src', 'externo', 'alvo.ts') }, ctx)), { decision: 'escalate', reason: 'OUTSIDE_SCOPE_PATH' });
  });
});

describe('legacy profile classification', () => {
  test('legacy restricted jobs keep the exact allowlist semantics', () => {
    const legacy: Partial<ActionContext> = { profile: 'restricted', legacyMode: 'verify', legacyAllowedCommands: ['Bash(npm test)'] };
    assert.deepEqual(pick(classify('Bash', { command: 'npm test' }, legacy)), { decision: 'allow', reason: 'EXACT_ALLOWLIST' });
    assert.deepEqual(pick(classify('Bash', { command: 'npm test -- --watch' }, legacy)), { decision: 'deny', reason: 'NOT_IN_ALLOWLIST' });
    assert.deepEqual(pick(classify('Edit', { file_path: 'C:\\ws\\projeto\\src\\a.ts' }, legacy)), { decision: 'deny', reason: 'TOOL_NOT_IN_MODE' });
  });
});
