// Literal fixtures for the v2 job contract. Values here are the expected
// public contract; production code must match them, not the other way round.

export const FABLE = 'claude-fable-5-1';
export const OPUS = 'claude-opus-5';
export const EFFORT = 'xhigh';

export type Owner = 'codex' | 'claude' | 'user' | 'not_applicable';
export type Responsibilities = Record<
  'planning' | 'inspection' | 'implementation' | 'testing' | 'review' | 'commit' | 'push' | 'deploy',
  Owner
>;

export function responsibilities(overrides: Partial<Responsibilities> = {}): Responsibilities {
  return {
    planning: 'codex',
    inspection: 'claude',
    implementation: 'claude',
    testing: 'claude',
    review: 'codex',
    commit: 'codex',
    push: 'codex',
    deploy: 'not_applicable',
    ...overrides,
  };
}

export function coordination(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    phase: 'execution',
    scopeId: 'codeorquestra-v2',
    approvalRevision: 1,
    planSummary: 'Implementar o runtime v2 com testes.',
    planApproved: true,
    responsibilities: responsibilities(),
    ...overrides,
  };
}

export function jobV2(workspace: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: 2,
    workspace,
    prompt: 'Olá. Implemente o recurso aprovado dentro do escopo.',
    profile: 'development',
    model: { requested: FABLE, reason: 'Tarefa longa de implementação com capacidade Fable disponível.' },
    effort: EFFORT,
    coordination: coordination(),
    scope: {
      summary: 'Runtime v2 em outputs/claude-code-live/runtime',
      paths: ['outputs/claude-code-live/runtime/'],
    },
    ...overrides,
  };
}

export function legacyJob(workspace: string, promptFile: string): Record<string, unknown> {
  return {
    workspace,
    promptFile,
    mode: 'verify',
    profile: 'restricted',
    coordination: coordination({ responsibilities: responsibilities({ implementation: 'codex' }) }),
    allowedCommands: [{ rule: 'Bash(pwsh -NoProfile -File tests.ps1)', responsibility: 'testing' }],
  };
}

export const USAGE_SAMPLE = [
  'Current session: 10% used · resets Sep 6, 9:19pm (America/Sao_Paulo)',
  'Current week (all models): 23% used · resets Sep 10, 8:59pm (America/Sao_Paulo)',
  'Current week (Fable): 44% used · resets Sep 10, 8:59pm (America/Sao_Paulo)',
].join('\n');
