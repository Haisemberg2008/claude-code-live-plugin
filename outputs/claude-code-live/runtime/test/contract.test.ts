// v2 job contract: versioned, keeps coordination fields and all eight owners,
// authorizes only the two working models at effort xhigh, and represents the
// legacy (v1) job shape faithfully without broadening or silently migrating it.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveJobContract, CONTRACT_VERSION, AUTHORIZED_MODELS, REQUIRED_EFFORT } from '../src/contract/job-contract.ts';
import { jobV2, legacyJob, responsibilities, coordination, FABLE, OPUS } from './helpers/fixtures.ts';
import { assertThrowsCode } from './helpers/assert-code.ts';

const workspace = 'C:\\projeto-aprovado';

describe('v2 contract constants', () => {
  test('exposes the versioned contract and the closed model/effort set', () => {
    assert.equal(CONTRACT_VERSION, 2);
    assert.deepEqual(AUTHORIZED_MODELS, ['claude-fable-5-1', 'claude-opus-5']);
    assert.equal(REQUIRED_EFFORT, 'xhigh');
  });
});

describe('v2 development job', () => {
  test('resolves an approved development job with literal fields', () => {
    const contract = resolveJobContract(jobV2(workspace));
    assert.equal(contract.version, 2);
    assert.equal(contract.profile, 'development');
    assert.equal(contract.model.requested, FABLE);
    assert.equal(contract.model.resolved, FABLE);
    assert.equal(contract.model.reason, 'Tarefa longa de implementação com capacidade Fable disponível.');
    assert.equal(contract.effort, 'xhigh');
    assert.equal(contract.coordination.phase, 'execution');
    assert.equal(contract.coordination.scopeId, 'codeorquestra-v2');
    assert.equal(contract.coordination.approvalRevision, 1);
    assert.equal(contract.coordination.planApproved, true);
    assert.deepEqual(contract.coordination.responsibilities, responsibilities());
    assert.deepEqual(contract.scope, { summary: 'Runtime v2 em outputs/claude-code-live/runtime', paths: ['outputs/claude-code-live/runtime/'], wholeWorkspace: false });
    // A job that never mentions `execution` keeps running in its declared
    // checkout. This is the whole backward-compatibility story for the field.
    assert.deepEqual(contract.execution, { mode: 'checkout', worktree: null });
    assert.equal(contract.legacy, null);
  });

  test('opus is accepted with a reason and effort defaults to xhigh when omitted', () => {
    const job = jobV2(workspace, { model: { requested: OPUS, reason: 'Fable com 3% restante; Opus recomendado.' } });
    delete job.effort;
    const contract = resolveJobContract(job);
    assert.equal(contract.model.requested, OPUS);
    assert.equal(contract.effort, 'xhigh');
  });

  test('rejects any model outside the authorized pair, including aliases and inherited property names', () => {
    for (const requested of ['claude-sonnet-5', 'fable', 'opus', 'claude-opus-4-1', '', 'constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      assertThrowsCode(() => resolveJobContract(jobV2(workspace, { model: { requested, reason: 'x' } })), 'MODEL_NOT_AUTHORIZED', `model ${requested}`);
    }
  });

  test('rejects effort downgrades and requires a model reason', () => {
    for (const effort of ['low', 'medium', 'high', 'max', 42]) {
      assertThrowsCode(() => resolveJobContract(jobV2(workspace, { effort })), 'EFFORT_NOT_XHIGH', `effort ${String(effort)}`);
    }
    assertThrowsCode(() => resolveJobContract(jobV2(workspace, { model: { requested: FABLE } })), 'MODEL_REASON_REQUIRED');
    assertThrowsCode(() => resolveJobContract(jobV2(workspace, { model: { requested: FABLE, reason: '   ' } })), 'MODEL_REASON_REQUIRED');
  });

  test('execution requires an approved nonempty plan, positive revision and nonempty scope', () => {
    assertThrowsCode(() => resolveJobContract(jobV2(workspace, { coordination: coordination({ planApproved: false }) })), 'PLAN_NOT_APPROVED');
    assertThrowsCode(() => resolveJobContract(jobV2(workspace, { coordination: coordination({ planSummary: '' }) })), 'PLAN_SUMMARY_REQUIRED');
    assertThrowsCode(() => resolveJobContract(jobV2(workspace, { coordination: coordination({ approvalRevision: 0 }) })), 'APPROVAL_REVISION_INVALID');
    assertThrowsCode(() => resolveJobContract(jobV2(workspace, { coordination: coordination({ approvalRevision: '1' }) })), 'APPROVAL_REVISION_INVALID');
    assertThrowsCode(() => resolveJobContract(jobV2(workspace, { coordination: coordination({ scopeId: ' ' }) })), 'SCOPE_ID_REQUIRED');
    const noScope = jobV2(workspace);
    delete noScope.scope;
    assertThrowsCode(() => resolveJobContract(noScope), 'SCOPE_REQUIRED');
    assertThrowsCode(() => resolveJobContract(jobV2(workspace, { scope: { summary: 'x', paths: [] } })), 'SCOPE_REQUIRED');
    const noCoordination = jobV2(workspace);
    delete noCoordination.coordination;
    assertThrowsCode(() => resolveJobContract(noCoordination), 'COORDINATION_REQUIRED');
  });

  test('scope paths are validated after normalization and whole-workspace scope must be explicit', () => {
    for (const bad of ['./', '.', '/', '..', 'src/../..', 'C:\\outro', '/abs', ' ']) {
      assertThrowsCode(() => resolveJobContract(jobV2(workspace, { scope: { summary: 'x', paths: [bad] } })), 'SCOPE_PATH_INVALID', JSON.stringify(bad));
    }
    assertThrowsCode(() => resolveJobContract(jobV2(workspace, { scope: { summary: 'x', paths: [1] } })), 'SCOPE_PATH_INVALID');
    assertThrowsCode(() => resolveJobContract(jobV2(workspace, { scope: 'src' })), 'SCOPE_INVALID');
    assertThrowsCode(() => resolveJobContract(jobV2(workspace, { scope: { summary: 'x', paths: 'src' } })), 'SCOPE_INVALID');
    assertThrowsCode(() => resolveJobContract(jobV2(workspace, { scope: { summary: 'x', wholeWorkspace: 'yes' } })), 'SCOPE_INVALID');
    const whole = resolveJobContract(jobV2(workspace, { scope: { summary: 'todo o checkout aprovado', wholeWorkspace: true } }));
    assert.deepEqual(whole.scope, { summary: 'todo o checkout aprovado', paths: [], wholeWorkspace: true });
    const normalized = resolveJobContract(jobV2(workspace, { scope: { summary: 'x', paths: ['.\\src\\', './test//unit'] } }));
    assert.deepEqual(normalized.scope.paths, ['src/', 'test/unit']);
  });

  test('keeps all eight owners mandatory and reserves commit, push and deploy', () => {
    const missing = responsibilities() as Record<string, string>;
    delete missing.review;
    assertThrowsCode(() => resolveJobContract(jobV2(workspace, { coordination: coordination({ responsibilities: missing }) })), 'RESPONSIBILITY_MISSING');
    assertThrowsCode(() => resolveJobContract(jobV2(workspace, { coordination: coordination({ responsibilities: { ...responsibilities(), publish: 'codex' } }) })), 'RESPONSIBILITY_UNEXPECTED');
    assertThrowsCode(() => resolveJobContract(jobV2(workspace, { coordination: coordination({ responsibilities: responsibilities({ inspection: 'team' as never }) }) })), 'RESPONSIBILITY_ACTOR_INVALID');
    for (const reserved of ['commit', 'push', 'deploy'] as const) {
      assertThrowsCode(() => resolveJobContract(jobV2(workspace, { coordination: coordination({ responsibilities: responsibilities({ [reserved]: 'claude' }) }) })), 'RESERVED_RESPONSIBILITY', reserved);
    }
  });

  test('development profile removes mandatory safe-mode, dontAsk and blanket prompt denial', () => {
    const contract = resolveJobContract(jobV2(workspace));
    assert.deepEqual(contract.launch, {
      permissionMode: 'default',
      safeMode: false,
      permissionPromptsDisabled: false,
      restricted: false,
      strictMcpConfig: true,
    });
    assert.deepEqual(contract.capabilities, { edit: true, test: true, commands: 'classified' });
    assert.deepEqual(contract.limits, { maxTurns: null, maxTokens: null, maxRuntimeSeconds: null });
    assert.deepEqual(contract.auth, { allowApiBilling: false });
  });

  test('Claude only edits or tests when assigned', () => {
    const noEdit = resolveJobContract(jobV2(workspace, { coordination: coordination({ responsibilities: responsibilities({ implementation: 'codex' }) }) }));
    assert.equal(noEdit.capabilities.edit, false);
    assert.equal(noEdit.capabilities.test, true);
    const noTest = resolveJobContract(jobV2(workspace, { coordination: coordination({ responsibilities: responsibilities({ testing: 'codex' }) }) }));
    assert.equal(noTest.capabilities.test, false);
  });

  test('malformed explicit authorization fields are rejected instead of defaulted', () => {
    assertThrowsCode(() => resolveJobContract(jobV2(workspace, { profile: {} })), 'PROFILE_INVALID');
    assertThrowsCode(() => resolveJobContract(jobV2(workspace, { profile: ['development'] })), 'PROFILE_INVALID');
    assertThrowsCode(() => resolveJobContract(jobV2(workspace, { auth: 'yes' })), 'AUTH_INVALID');
    assertThrowsCode(() => resolveJobContract(jobV2(workspace, { auth: { allowApiBilling: 'true' } })), 'AUTH_INVALID');
    assertThrowsCode(() => resolveJobContract(jobV2(workspace, { auth: { allowApiBilling: true, extra: 1 } })), 'AUTH_INVALID');
    assertThrowsCode(() => resolveJobContract(jobV2(workspace, { codexThreadId: { toString: () => 'x' } })), 'THREAD_ID_INVALID');
    assertThrowsCode(() => resolveJobContract(jobV2(workspace, { coordination: coordination({ planSummary: 5 }) })), 'PLAN_SUMMARY_INVALID');
    const explicit = resolveJobContract(jobV2(workspace, { auth: { allowApiBilling: true } }));
    assert.equal(explicit.auth.allowApiBilling, true);
  });

  test('v2 read profile stays read-only and rejects legacy fields', () => {
    const readOnly = resolveJobContract(jobV2(workspace, { profile: 'read' }));
    assert.deepEqual(readOnly.capabilities, { edit: false, test: false, commands: 'none' });
    assertThrowsCode(() => resolveJobContract(jobV2(workspace, { mode: 'local' })), 'LEGACY_FIELD_IN_V2');
    assertThrowsCode(() => resolveJobContract(jobV2(workspace, { allowedCommands: [] })), 'LEGACY_FIELD_IN_V2');
    assertThrowsCode(() => resolveJobContract(jobV2(workspace, { timeoutSeconds: 10 })), 'LEGACY_FIELD_IN_V2');
    assertThrowsCode(() => resolveJobContract(jobV2(workspace, { profile: 'diagnostic' })), 'PROFILE_INVALID');
    assertThrowsCode(() => resolveJobContract(jobV2(workspace, { contractVersion: 3 })), 'CONTRACT_VERSION_UNSUPPORTED');
    assertThrowsCode(() => resolveJobContract(jobV2(workspace, { contractVersion: '2' })), 'CONTRACT_VERSION_UNSUPPORTED');
  });
});

describe('v2 execution target', () => {
  const worktreeJob = (worktree?: unknown, overrides: Record<string, unknown> = {}) =>
    jobV2(workspace, { execution: { mode: 'worktree', ...(worktree === undefined ? {} : { worktree }) }, ...overrides });

  test('an absent, null or explicit checkout target all resolve to the declared checkout', () => {
    const expected = { mode: 'checkout', worktree: null };
    assert.deepEqual(resolveJobContract(jobV2(workspace)).execution, expected);
    assert.deepEqual(resolveJobContract(jobV2(workspace, { execution: null })).execution, expected);
    assert.deepEqual(resolveJobContract(jobV2(workspace, { execution: { mode: 'checkout' } })).execution, expected);
  });

  test('a worktree target resolves with broker-derived defaults, and names when given', () => {
    assert.deepEqual(resolveJobContract(worktreeJob()).execution, {
      mode: 'worktree',
      worktree: { branch: null, baseRef: null, onExistingWork: 'refuse' },
    });
    assert.deepEqual(resolveJobContract(worktreeJob({ branch: 'codeorquestra/task-1', baseRef: 'main' })).execution, {
      mode: 'worktree',
      worktree: { branch: 'codeorquestra/task-1', baseRef: 'main', onExistingWork: 'refuse' },
    });
  });

  test('unexpected fields are refused rather than ignored, at both levels', () => {
    for (const job of [
      jobV2(workspace, { execution: 'worktree' }),
      jobV2(workspace, { execution: { mode: 'worktree', unexpected: 1 } }),
      jobV2(workspace, { execution: { mode: 'branch' } }),
      worktreeJob({ branch: 'main', unexpected: 1 }),
      // A worktree payload only means something in worktree mode; accepting it
      // beside `checkout` would silently discard what the caller asked for.
      jobV2(workspace, { execution: { mode: 'checkout', worktree: { branch: 'x' } } }),
      // Reserved for a future contract change, never a silent behaviour shift.
      worktreeJob({ onExistingWork: 'reuse' }),
    ]) {
      assertThrowsCode(() => resolveJobContract(job), 'EXECUTION_INVALID', JSON.stringify(job.execution));
    }
  });

  test('ref names are validated here, because they become git arguments', () => {
    for (const branch of ['-force', '..', 'a..b', 'feature/', 'feature/.hidden', 'feature/x.lock', 'x.lock', 'feature//x', 'trailing.', '.leading', 'com espaço', 'semi;colon', 'til~de', 'a'.repeat(102), 42]) {
      assertThrowsCode(() => resolveJobContract(worktreeJob({ branch })), 'EXECUTION_BRANCH_INVALID', `branch ${String(branch)}`);
    }
    // baseRef goes through the same gate, not a laxer one.
    assertThrowsCode(() => resolveJobContract(worktreeJob({ baseRef: 'origin/main;rm -rf' })), 'EXECUTION_BRANCH_INVALID');
    for (const branch of ['main', 'codeorquestra/task-4f2a', 'release-1.2.3', 'a_b', 'x']) {
      assert.equal(resolveJobContract(worktreeJob({ branch })).execution.worktree?.branch, branch);
    }
  });

  test('a worktree is only provisioned for an assigned implementation actually about to run', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      // Nothing writes in a read run, so it must see the tree the human sees.
      ['profile read', { profile: 'read' }],
      // Planning has no approved work to isolate yet.
      ['planning phase', { coordination: coordination({ phase: 'planning', planApproved: false, planSummary: 'Inspecionar antes de propor.' }) }],
      // Claude is not the one editing, so an isolated tree would stay empty.
      ['implementation not claude', { coordination: coordination({ responsibilities: responsibilities({ implementation: 'codex' }) }) }],
    ];
    for (const [label, overrides] of cases) {
      assertThrowsCode(() => resolveJobContract(worktreeJob(undefined, overrides)), 'WORKTREE_NOT_APPLICABLE', label);
    }
  });

  test('limits are optional, literal and refused when malformed', () => {
    // A job that never mentions `limits` resolves exactly as before: no budget.
    assert.deepEqual(resolveJobContract(jobV2(workspace)).limits, { maxTurns: null, maxTokens: null, maxRuntimeSeconds: null });
    assert.deepEqual(resolveJobContract(jobV2(workspace, { limits: null })).limits, { maxTurns: null, maxTokens: null, maxRuntimeSeconds: null });
    assert.deepEqual(resolveJobContract(jobV2(workspace, { limits: {} })).limits, { maxTurns: null, maxTokens: null, maxRuntimeSeconds: null });
    // One dimension limited leaves the others unlimited, not zero.
    assert.deepEqual(resolveJobContract(jobV2(workspace, { limits: { maxTokens: 5000 } })).limits, { maxTurns: null, maxTokens: 5000, maxRuntimeSeconds: null });
    assert.deepEqual(resolveJobContract(jobV2(workspace, { limits: { maxTurns: 3, maxTokens: 5000, maxRuntimeSeconds: 600 } })).limits, { maxTurns: 3, maxTokens: 5000, maxRuntimeSeconds: 600 });
    // "I set a budget" and "I set no budget" must never be one typo apart.
    for (const bad of [0, -1, 2.5, 'x', '5000', true, Number.MAX_SAFE_INTEGER + 1]) {
      assertThrowsCode(() => resolveJobContract(jobV2(workspace, { limits: { maxTokens: bad } })), 'LIMITS_INVALID', `maxTokens=${String(bad)}`);
      assertThrowsCode(() => resolveJobContract(jobV2(workspace, { limits: { maxTurns: bad } })), 'LIMITS_INVALID', `maxTurns=${String(bad)}`);
      assertThrowsCode(() => resolveJobContract(jobV2(workspace, { limits: { maxRuntimeSeconds: bad } })), 'LIMITS_INVALID', `maxRuntimeSeconds=${String(bad)}`);
    }
    assertThrowsCode(() => resolveJobContract(jobV2(workspace, { limits: 5000 })), 'LIMITS_INVALID');
    assertThrowsCode(() => resolveJobContract(jobV2(workspace, { limits: [5000] })), 'LIMITS_INVALID');
    assertThrowsCode(() => resolveJobContract(jobV2(workspace, { limits: { maxCost: 5 } })), 'LIMITS_INVALID');
    assertThrowsCode(() => resolveJobContract(jobV2(workspace, { limits: { maxTokens: 5000, maxCost: 5 } })), 'LIMITS_INVALID');
  });

  test('limits belong to v2 only and are refused in a legacy job instead of ignored', () => {
    const job = legacyJob(workspace, 'C:\\execucoes\\prompt.md');
    job.limits = { maxTokens: 5000 };
    assertThrowsCode(() => resolveJobContract(job), 'V2_FIELD_IN_LEGACY');
  });

  test('execution belongs to v2 only and is refused in a legacy job instead of ignored', () => {
    const job = legacyJob(workspace, 'C:\\execucoes\\prompt.md');
    job.execution = { mode: 'worktree' };
    assertThrowsCode(() => resolveJobContract(job), 'V2_FIELD_IN_LEGACY');
  });
});

describe('legacy v1 job preservation', () => {
  test('a legacy verify job resolves as version 1 with its original configuration preserved', () => {
    const contract = resolveJobContract(legacyJob(workspace, 'C:\\execucoes\\prompt.md'));
    assert.equal(contract.version, 1);
    assert.equal(contract.legacy?.mode, 'verify');
    assert.equal(contract.legacy?.executor, 'legacy-runner');
    assert.equal(contract.profile, 'restricted');
    assert.deepEqual(contract.capabilities, { edit: false, test: true, commands: 'exact-list' });
    assert.deepEqual(contract.launch, {
      permissionMode: 'dontAsk',
      safeMode: true,
      permissionPromptsDisabled: true,
      restricted: true,
      strictMcpConfig: true,
    });
    assert.deepEqual(contract.legacy?.allowedCommands, [{ rule: 'Bash(pwsh -NoProfile -File tests.ps1)', responsibility: 'testing' }]);
    assert.equal(contract.model.requested, 'fable', 'the legacy alias is preserved as configured');
    assert.equal(contract.model.resolved, 'claude-fable-5-1');
    assert.equal(contract.effort, 'high', 'the legacy default effort is preserved, not migrated');
    assert.deepEqual(contract.legacy?.timeoutPolicy, { mode: 'adaptive', renewEverySeconds: 1800, idleAfterSeconds: 1200, hardStopAfterSeconds: 7200 });
  });

  test('legacy explicit effort, model, fixed timeout and adaptive policy are preserved verbatim', () => {
    const job = legacyJob(workspace, 'C:\\execucoes\\prompt.md');
    job.effort = 'medium';
    job.model = 'sonnet';
    job.timeoutSeconds = 10;
    const contract = resolveJobContract(job);
    assert.equal(contract.effort, 'medium');
    assert.equal(contract.model.requested, 'sonnet');
    assert.equal(contract.model.resolved, null, 'an unauthorized legacy model stays visible for consultation and unresolved for v2');
    assert.deepEqual(contract.legacy?.timeoutPolicy, { mode: 'fixed', timeoutSeconds: 10 });
    const adaptive = legacyJob(workspace, 'C:\\execucoes\\prompt.md');
    adaptive.timeoutPolicy = { mode: 'adaptive', renewEverySeconds: 60, idleAfterSeconds: 30, hardStopAfterSeconds: 180 };
    assert.deepEqual(resolveJobContract(adaptive).legacy?.timeoutPolicy, { mode: 'adaptive', renewEverySeconds: 60, idleAfterSeconds: 30, hardStopAfterSeconds: 180 });
  });

  test('legacy timeout settings are validated like the legacy runner, never dropped', () => {
    const conflict = legacyJob(workspace, 'C:\\execucoes\\prompt.md');
    conflict.timeoutSeconds = 90;
    conflict.timeoutPolicy = { mode: 'adaptive' };
    assertThrowsCode(() => resolveJobContract(conflict), 'LEGACY_TIMEOUT_CONFLICT');
    for (const policy of [{ mode: 'bad' }, { mode: 'adaptive', renewEverySeconds: 0 }, { mode: 'adaptive', idleAfterSeconds: '30' }, { mode: 'adaptive', hardStopAfterSeconds: 10, renewEverySeconds: 20 }, { mode: 'adaptive', extra: 1 }]) {
      const job = legacyJob(workspace, 'C:\\execucoes\\prompt.md');
      job.timeoutPolicy = policy;
      assertThrowsCode(() => resolveJobContract(job), 'LEGACY_TIMEOUT_INVALID', JSON.stringify(policy));
    }
    const negative = legacyJob(workspace, 'C:\\execucoes\\prompt.md');
    negative.timeoutSeconds = -1;
    assertThrowsCode(() => resolveJobContract(negative), 'LEGACY_TIMEOUT_INVALID');
    const invalidEffort = legacyJob(workspace, 'C:\\execucoes\\prompt.md');
    invalidEffort.effort = 'turbo';
    assertThrowsCode(() => resolveJobContract(invalidEffort), 'EFFORT_INVALID');
  });

  test('legacy model lookups never resolve inherited property names', () => {
    for (const name of ['constructor', 'toString', '__proto__', 'valueOf']) {
      const job = legacyJob(workspace, 'C:\\execucoes\\prompt.md');
      job.model = name;
      const contract = resolveJobContract(job);
      assert.equal(contract.model.requested, name);
      assert.equal(contract.model.resolved, null, name);
    }
  });

  test('legacy jobs cannot use the v2 development profile', () => {
    const job = legacyJob(workspace, 'C:\\execucoes\\prompt.md');
    job.profile = 'development';
    assertThrowsCode(() => resolveJobContract(job), 'PROFILE_REQUIRES_V2');
  });

  test('legacy wildcard and critical command rules remain rejected', () => {
    const job = legacyJob(workspace, 'C:\\execucoes\\prompt.md');
    job.allowedCommands = [{ rule: 'Bash(git push:*)', responsibility: 'testing' }];
    assertThrowsCode(() => resolveJobContract(job), 'LEGACY_RULE_INVALID');
    job.allowedCommands = [{ rule: 'Bash(git push origin HEAD)', responsibility: 'testing' }];
    assertThrowsCode(() => resolveJobContract(job), 'LEGACY_RULE_CRITICAL');
  });
});
