// Versioned job contract. Only v2 exists: the v1 shape (no contractVersion,
// `mode`/`allowedCommands`/`timeoutPolicy`) belonged to the PowerShell runner
// retired in September 2026 and is refused with a migration hint, never
// silently reinterpreted. Every rejection carries a machine-readable code.
import { RESPONSIBILITY_KEYS, type AuthorizedModel, type Coordination, type EffortLevel, type Owner, type Responsibilities } from '../shared/types.ts';

export const CONTRACT_VERSION = 2;
export const AUTHORIZED_MODELS: readonly AuthorizedModel[] = ['claude-fable-5-1', 'claude-opus-5'];
export const REQUIRED_EFFORT = 'xhigh';
const OWNERS: readonly Owner[] = ['codex', 'claude', 'user', 'not_applicable'];
const RESERVED_RESPONSIBILITIES: readonly (keyof Responsibilities)[] = ['commit', 'push', 'deploy'];
const THREAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export class ContractError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ContractError';
    this.code = code;
  }
}

export interface WorktreeRequest {
  /** null lets the broker derive a name from the task; it never comes from git output. */
  branch: string | null;
  /** null means the repository's current HEAD. */
  baseRef: string | null;
  /**
   * Only 'refuse' today. Adopting a worktree that still holds uncommitted work
   * must be an explicit contract change rather than a silent behaviour shift,
   * because the normal end state of a successful run *is* uncommitted work:
   * commit can never belong to Claude.
   */
  onExistingWork: 'refuse';
}

/**
 * Where a run's files live. `checkout` is the historical behaviour — the
 * declared workspace itself — and is what every contract written before this
 * field resolves to.
 */
export interface ExecutionTarget {
  mode: 'checkout' | 'worktree';
  worktree: WorktreeRequest | null;
}

export interface JobContract {
  version: 2;
  profile: 'development' | 'read';
  workspace: string;
  prompt: string | null;
  promptFile: string | null;
  /** requested is the exact configured value; resolved is the authorized id or null. */
  model: { requested: string; resolved: AuthorizedModel | null; reason: string };
  effort: EffortLevel;
  coordination: Coordination;
  scope: { summary: string; paths: string[]; wholeWorkspace: boolean };
  execution: ExecutionTarget;
  /**
   * How the CLI is launched. Literal, not configurable: the interactive
   * profile always runs with visible permission prompts and without the
   * `--safe-mode`/`--restricted` containment the retired v1 runner used.
   */
  launch: {
    permissionMode: 'default';
    safeMode: false;
    permissionPromptsDisabled: false;
    restricted: false;
    strictMcpConfig: true;
  };
  capabilities: { edit: boolean; test: boolean; commands: 'classified' | 'exact-list' | 'none' };
  /**
   * Per-run budget, all three optional. A null is "no limit", which is what
   * every job resolved to before the field was implemented.
   */
  limits: { maxTurns: number | null; maxTokens: number | null; maxRuntimeSeconds: number | null };
  auth: { allowApiBilling: boolean };
  resumeFrom: string | null;
  codexThreadId: string | null;
}

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function own(value: Dict, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

export function resolveCoordination(value: unknown): Coordination {
  if (!isDict(value)) throw new ContractError('COORDINATION_REQUIRED', 'coordination é obrigatório em todo job.');
  const phase = stringField(own(value, 'phase'));
  if (phase !== 'planning' && phase !== 'execution') throw new ContractError('PHASE_INVALID', 'coordination.phase deve ser planning ou execution.');
  const scopeId = stringField(own(value, 'scopeId'))?.trim() ?? '';
  if (!scopeId) throw new ContractError('SCOPE_ID_REQUIRED', 'coordination.scopeId é obrigatório.');
  const revision = own(value, 'approvalRevision');
  if (!isPositiveInteger(revision)) throw new ContractError('APPROVAL_REVISION_INVALID', 'coordination.approvalRevision deve ser um inteiro positivo.');
  const approved = own(value, 'planApproved');
  if (typeof approved !== 'boolean') throw new ContractError('PLAN_APPROVED_INVALID', 'coordination.planApproved deve ser booleano.');
  const summaryRaw = own(value, 'planSummary');
  if (summaryRaw !== undefined && typeof summaryRaw !== 'string') throw new ContractError('PLAN_SUMMARY_INVALID', 'coordination.planSummary deve ser texto.');
  const planSummary = (summaryRaw ?? '').trim();
  const responsibilities = resolveResponsibilities(own(value, 'responsibilities'));
  if (phase === 'execution') {
    if (!approved) throw new ContractError('PLAN_NOT_APPROVED', 'A execução exige plano explicitamente aprovado.');
    if (!planSummary) throw new ContractError('PLAN_SUMMARY_REQUIRED', 'coordination.planSummary é obrigatório na execução.');
  }
  return { phase, scopeId, approvalRevision: revision, planSummary, planApproved: approved, responsibilities };
}

export function resolveResponsibilities(value: unknown): Responsibilities {
  if (!isDict(value)) throw new ContractError('RESPONSIBILITY_MISSING', 'coordination.responsibilities é obrigatório com as oito responsabilidades.');
  for (const key of Object.keys(value)) {
    if (!(RESPONSIBILITY_KEYS as readonly string[]).includes(key)) {
      throw new ContractError('RESPONSIBILITY_UNEXPECTED', `coordination.responsibilities contém a etapa inesperada ${key}.`);
    }
  }
  const result = {} as Responsibilities;
  for (const key of RESPONSIBILITY_KEYS) {
    const raw = own(value, key);
    if (typeof raw !== 'string' || !raw.trim()) throw new ContractError('RESPONSIBILITY_MISSING', `coordination.responsibilities.${key} é obrigatório.`);
    const actor = raw.trim().toLowerCase() as Owner;
    if (!OWNERS.includes(actor)) throw new ContractError('RESPONSIBILITY_ACTOR_INVALID', `coordination.responsibilities.${key} tem um ator inválido.`);
    if (RESERVED_RESPONSIBILITIES.includes(key) && actor === 'claude') {
      throw new ContractError('RESERVED_RESPONSIBILITY', `O Claude não pode ser responsável por ${key}.`);
    }
    result[key] = actor;
  }
  return result;
}

function resolveEffortV2(value: unknown): 'xhigh' {
  if (value === undefined || value === null) return 'xhigh';
  if (value !== 'xhigh') throw new ContractError('EFFORT_NOT_XHIGH', 'Somente o esforço xhigh (Extra) é autorizado em jobs v2; nenhum downgrade é permitido.');
  return 'xhigh';
}

function resolveThreadId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !THREAD_ID_PATTERN.test(value)) throw new ContractError('THREAD_ID_INVALID', 'codexThreadId deve conter apenas letras, números, sublinhado ou hífen, com até 128 caracteres.');
  return value;
}

function resolveWorkspace(value: unknown): string {
  const workspace = stringField(value)?.trim() ?? '';
  if (!workspace) throw new ContractError('WORKSPACE_REQUIRED', 'workspace é obrigatório.');
  return workspace;
}

function normalizeScopePath(raw: string): string {
  let text = raw.trim().replace(/\\/g, '/');
  while (text.startsWith('./')) text = text.slice(2);
  text = text.replace(/\/{2,}/g, '/');
  return text;
}

function resolveScope(value: unknown, phase: 'planning' | 'execution'): { summary: string; paths: string[]; wholeWorkspace: boolean } {
  if (value === undefined || value === null) {
    if (phase === 'execution') throw new ContractError('SCOPE_REQUIRED', 'scope com summary e paths não vazios (ou wholeWorkspace: true) é obrigatório na execução.');
    return { summary: '', paths: [], wholeWorkspace: false };
  }
  if (!isDict(value)) throw new ContractError('SCOPE_INVALID', 'scope deve ser um objeto com summary, paths e opcionalmente wholeWorkspace.');
  const summaryRaw = own(value, 'summary');
  if (summaryRaw !== undefined && typeof summaryRaw !== 'string') throw new ContractError('SCOPE_INVALID', 'scope.summary deve ser texto.');
  const summary = (summaryRaw ?? '').trim();
  const wholeRaw = own(value, 'wholeWorkspace');
  if (wholeRaw !== undefined && typeof wholeRaw !== 'boolean') throw new ContractError('SCOPE_INVALID', 'scope.wholeWorkspace deve ser booleano.');
  const wholeWorkspace = wholeRaw === true;
  const pathsRaw = own(value, 'paths');
  if (pathsRaw !== undefined && !Array.isArray(pathsRaw)) throw new ContractError('SCOPE_INVALID', 'scope.paths deve ser uma lista de caminhos relativos.');
  const paths: string[] = [];
  for (const entry of pathsRaw ?? []) {
    if (typeof entry !== 'string') throw new ContractError('SCOPE_PATH_INVALID', 'scope.paths só aceita textos.');
    const normalized = normalizeScopePath(entry);
    const segments = normalized.split('/').filter((segment) => segment.length > 0);
    if (segments.length === 0 || segments.some((segment) => segment === '.' || segment === '..') || /^[A-Za-z]:/.test(normalized) || normalized.startsWith('/')) {
      throw new ContractError('SCOPE_PATH_INVALID', `scope.paths contém um caminho inválido (${JSON.stringify(entry)}); use caminhos relativos dentro do workspace ou wholeWorkspace: true.`);
    }
    paths.push(normalized);
  }
  if (phase === 'execution' && (!summary || (paths.length === 0 && !wholeWorkspace))) {
    throw new ContractError('SCOPE_REQUIRED', 'scope.summary e scope.paths não podem estar vazios na execução, salvo wholeWorkspace: true explícito.');
  }
  return { summary, paths, wholeWorkspace };
}

function resolveModelV2(value: unknown): { requested: AuthorizedModel; resolved: AuthorizedModel; reason: string } {
  let requested: string | null = null;
  let reason: string | null = null;
  if (typeof value === 'string') {
    requested = value;
  } else if (isDict(value)) {
    requested = stringField(own(value, 'requested'));
    reason = stringField(own(value, 'reason'));
  }
  if (!requested || !AUTHORIZED_MODELS.includes(requested as AuthorizedModel)) {
    throw new ContractError('MODEL_NOT_AUTHORIZED', `Modelo não autorizado: somente ${AUTHORIZED_MODELS.join(' e ')} são permitidos, com o identificador exato.`);
  }
  if (!reason || !reason.trim()) throw new ContractError('MODEL_REASON_REQUIRED', 'model.reason deve explicar a escolha do modelo.');
  return { requested: requested as AuthorizedModel, resolved: requested as AuthorizedModel, reason: reason.trim() };
}

function resolvePrompt(job: Dict): { prompt: string | null; promptFile: string | null } {
  const prompt = stringField(own(job, 'prompt'));
  const promptFile = stringField(own(job, 'promptFile'));
  if ((prompt === null || !prompt.trim()) && (promptFile === null || !promptFile.trim())) {
    throw new ContractError('PROMPT_REQUIRED', 'prompt ou promptFile é obrigatório.');
  }
  return { prompt: prompt && prompt.trim() ? prompt : null, promptFile: promptFile && promptFile.trim() ? promptFile : null };
}

function resolveProfileField(job: Dict, fallback: string): string {
  const raw = own(job, 'profile');
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'string') throw new ContractError('PROFILE_INVALID', 'profile deve ser texto; campos de autorização malformados são rejeitados.');
  return raw;
}

function resolveAuth(job: Dict): { allowApiBilling: boolean } {
  const raw = own(job, 'auth');
  if (raw === undefined || raw === null) return { allowApiBilling: false };
  if (!isDict(raw)) throw new ContractError('AUTH_INVALID', 'auth deve ser um objeto.');
  const allow = own(raw, 'allowApiBilling');
  if (allow !== undefined && typeof allow !== 'boolean') throw new ContractError('AUTH_INVALID', 'auth.allowApiBilling deve ser booleano.');
  for (const key of Object.keys(raw)) if (key !== 'allowApiBilling') throw new ContractError('AUTH_INVALID', `auth contém o campo inesperado ${key}.`);
  return { allowApiBilling: allow === true };
}

const LIMIT_FIELDS = ['maxTurns', 'maxTokens', 'maxRuntimeSeconds'] as const;

/**
 * A budget for one run. Absent means unlimited, so no contract version bump:
 * a job that never mentions `limits` resolves exactly as it always did.
 *
 * The same rigour as `auth`: a limit that is present but malformed is refused,
 * never rounded or defaulted, because "I set a budget" and "I set no budget"
 * must not be one typo apart.
 */
function resolveLimits(job: Dict): JobContract['limits'] {
  const raw = own(job, 'limits');
  const limits: JobContract['limits'] = { maxTurns: null, maxTokens: null, maxRuntimeSeconds: null };
  if (raw === undefined || raw === null) return limits;
  if (!isDict(raw)) throw new ContractError('LIMITS_INVALID', 'limits deve ser um objeto.');
  for (const key of Object.keys(raw)) {
    if (!(LIMIT_FIELDS as readonly string[]).includes(key)) throw new ContractError('LIMITS_INVALID', `limits contém o campo inesperado ${key}.`);
  }
  for (const field of LIMIT_FIELDS) {
    const value = own(raw, field);
    if (value === undefined || value === null) continue;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
      throw new ContractError('LIMITS_INVALID', `limits.${field} deve ser um inteiro positivo (ou ausente para não limitar).`);
    }
    limits[field] = value;
  }
  return limits;
}

const REF_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/;

/**
 * Validates a git ref name here, where every other adversarial input is already
 * validated, because it becomes an argument to `git worktree add`. The allowlist
 * is deliberately narrower than git's own rules: a name git would accept but
 * that we did not anticipate is refused rather than passed through.
 */
function resolveRefName(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new ContractError('EXECUTION_BRANCH_INVALID', `execution.worktree.${field} deve ser texto ou null.`);
  const invalid = (why: string): never => {
    throw new ContractError('EXECUTION_BRANCH_INVALID', `execution.worktree.${field} ${why}`);
  };
  // A leading '-' would be read as an option by git; the first character of the
  // pattern being alphanumeric already excludes it, along with leading '.' .
  if (!REF_NAME.test(value)) invalid('aceita apenas letras, dígitos, ponto, hífen, barra e sublinhado, começando por letra ou dígito, com no máximo 101 caracteres.');
  if (value.includes('..')) invalid('não pode conter "..".');
  if (value.endsWith('/') || value.endsWith('.')) invalid('não pode terminar em "/" nem ".".');
  for (const part of value.split('/')) {
    if (part === '') invalid('não pode conter componentes vazios ("//").');
    if (part.startsWith('.')) invalid('não pode ter componente começando com ".".');
    if (part.endsWith('.lock')) invalid('não pode ter componente terminando em ".lock".');
  }
  return value;
}

/**
 * Resolves where the run's files live.
 *
 * An absent or null `execution` resolving to `checkout` is the entire
 * backward-compatibility story for this field: every v2 job written before it
 * existed keeps the same workspace and the same writer lock as today, so no
 * contractVersion bump is needed.
 */
function resolveExecution(job: Dict, coordination: Coordination, profile: 'development' | 'read'): ExecutionTarget {
  const raw = own(job, 'execution');
  if (raw === undefined || raw === null) return { mode: 'checkout', worktree: null };
  if (!isDict(raw)) throw new ContractError('EXECUTION_INVALID', 'execution deve ser um objeto.');
  for (const key of Object.keys(raw)) {
    if (key !== 'mode' && key !== 'worktree') throw new ContractError('EXECUTION_INVALID', `execution contém o campo inesperado ${key}.`);
  }
  const mode = own(raw, 'mode');
  if (mode !== 'checkout' && mode !== 'worktree') throw new ContractError('EXECUTION_INVALID', 'execution.mode deve ser checkout ou worktree.');
  const worktreeRaw = own(raw, 'worktree');
  if (mode === 'checkout') {
    if (worktreeRaw !== undefined && worktreeRaw !== null) throw new ContractError('EXECUTION_INVALID', 'execution.worktree só é aceito quando execution.mode é worktree.');
    return { mode: 'checkout', worktree: null };
  }
  // A worktree exists to let an assigned implementation run in parallel with
  // another task on the same repository. Every other shape would provision a
  // checkout that nothing is going to write to.
  if (profile === 'read') throw new ContractError('WORKTREE_NOT_APPLICABLE', 'O perfil read não toma trava de escrita e deve inspecionar a mesma árvore que o usuário vê.');
  if (coordination.phase !== 'execution') throw new ContractError('WORKTREE_NOT_APPLICABLE', 'Um worktree só é provisionado na fase de execução.');
  if (coordination.responsibilities.implementation !== 'claude') throw new ContractError('WORKTREE_NOT_APPLICABLE', 'Um worktree só é provisionado quando implementation pertence ao Claude.');
  if (worktreeRaw === undefined || worktreeRaw === null) return { mode: 'worktree', worktree: { branch: null, baseRef: null, onExistingWork: 'refuse' } };
  if (!isDict(worktreeRaw)) throw new ContractError('EXECUTION_INVALID', 'execution.worktree deve ser um objeto ou null.');
  for (const key of Object.keys(worktreeRaw)) {
    if (key !== 'branch' && key !== 'baseRef' && key !== 'onExistingWork') throw new ContractError('EXECUTION_INVALID', `execution.worktree contém o campo inesperado ${key}.`);
  }
  const onExistingWork = own(worktreeRaw, 'onExistingWork');
  if (onExistingWork !== undefined && onExistingWork !== 'refuse') throw new ContractError('EXECUTION_INVALID', 'execution.worktree.onExistingWork aceita apenas "refuse".');
  return {
    mode: 'worktree',
    worktree: {
      branch: resolveRefName(own(worktreeRaw, 'branch'), 'branch'),
      baseRef: resolveRefName(own(worktreeRaw, 'baseRef'), 'baseRef'),
      onExistingWork: 'refuse',
    },
  };
}

function resolveV2(job: Dict): JobContract {
  for (const [field, replacement] of Object.entries(V1_FIELD_REPLACEMENTS)) {
    if (Object.prototype.hasOwnProperty.call(job, field)) throw new ContractError('LEGACY_FIELD_IN_V2', `O campo ${field} pertencia ao contrato v1, aposentado; no v2, ${replacement}.`);
  }
  const workspace = resolveWorkspace(own(job, 'workspace'));
  const { prompt, promptFile } = resolvePrompt(job);
  const profileRaw = resolveProfileField(job, 'development');
  if (profileRaw === 'diagnostic' || profileRaw === 'restricted') throw new ContractError('PROFILE_INVALID', 'Os perfis diagnostic e restricted pertenciam ao contrato v1, aposentado; use development ou read.');
  if (profileRaw !== 'development' && profileRaw !== 'read') throw new ContractError('PROFILE_INVALID', 'profile deve ser development ou read.');
  const coordination = resolveCoordination(own(job, 'coordination'));
  const model = resolveModelV2(own(job, 'model'));
  const effort = resolveEffortV2(own(job, 'effort'));
  const scope = resolveScope(own(job, 'scope'), coordination.phase);
  const execution = resolveExecution(job, coordination, profileRaw);
  const codexThreadId = resolveThreadId(own(job, 'codexThreadId'));
  const auth = resolveAuth(job);
  const limits = resolveLimits(job);
  const resumeFrom = stringField(own(job, 'resumeFrom'));
  const readOnly = profileRaw === 'read' || coordination.phase === 'planning';
  const capabilities = readOnly
    ? { edit: false, test: false, commands: 'none' as const }
    : {
        edit: coordination.responsibilities.implementation === 'claude',
        test: coordination.responsibilities.testing === 'claude',
        commands: 'classified' as const,
      };
  return {
    version: 2,
    profile: profileRaw,
    workspace,
    prompt,
    promptFile,
    model,
    effort,
    coordination,
    scope,
    execution,
    launch: { permissionMode: 'default', safeMode: false, permissionPromptsDisabled: false, restricted: false, strictMcpConfig: true },
    capabilities,
    limits,
    auth,
    resumeFrom,
    codexThreadId,
  };
}

/**
 * What each retired v1 field became, so a refusal says where to go instead of
 * only what is wrong. A job carrying one of these is a v1 job by shape, and
 * the v1 executor no longer exists.
 */
const V1_FIELD_REPLACEMENTS: Record<string, string> = {
  mode: 'use profile (development ou read); as capacidades derivam da matriz de responsabilidades',
  allowedCommands: 'não há allowlist: o classificador de ações decide por caminho resolvido e escala o resto ao coordenador',
  modelPolicy: 'declare model.requested com model.reason e troque entre turnos com codeorquestra_set_model',
  timeoutPolicy: 'use limits.maxRuntimeSeconds; a supervisão só alerta e nunca encerra',
  timeoutSeconds: 'use limits.maxRuntimeSeconds; a supervisão só alerta e nunca encerra',
};

export function resolveJobContract(job: unknown): JobContract {
  if (!isDict(job)) throw new ContractError('JOB_INVALID', 'O job deve ser um objeto JSON.');
  const version = own(job, 'contractVersion');
  if (version === undefined || version === null) {
    throw new ContractError('CONTRACT_VERSION_REQUIRED', `contractVersion é obrigatório. Um job sem ele tem o formato v1, cujo runner PowerShell foi aposentado; envie contractVersion: ${CONTRACT_VERSION} conforme references/runtime-v2.md.`);
  }
  if (version !== CONTRACT_VERSION) throw new ContractError('CONTRACT_VERSION_UNSUPPORTED', `contractVersion ${String(version)} não é suportado; use ${CONTRACT_VERSION}.`);
  return resolveV2(job);
}
