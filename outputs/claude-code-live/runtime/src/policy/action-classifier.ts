// Text-based guardrails for tool actions.
//
// This is a classification layer used by the PreToolUse hook and the
// permission callback; it is NOT an operating-system sandbox and cannot
// inspect what a project script does once it runs. Decisions: allow (known in
// scope), deny (reserved, out of capability or sensitive, with an intelligible
// reason) or escalate (a visible request to the coordinator).
//
// Two invariants drive the design:
//   * the contract's normalized capabilities gate writes and shell work, so a
//     planning or read profile can never regain them through a callback, a
//     delegated agent or a skill;
//   * path checks apply to the RESOLVED target, so a symlink or junction
//     inside the workspace cannot smuggle a sensitive file or an unapproved
//     directory past the scope check.
import fs from 'node:fs';
import path from 'node:path';
import type { Responsibilities } from '../shared/types.ts';

export type Decision = 'allow' | 'deny' | 'escalate';

export interface ActionCapabilities {
  edit: boolean;
  test: boolean;
  commands: 'classified' | 'exact-list' | 'none';
}

export interface ActionContext {
  profile: 'development' | 'read';
  workspace: string;
  scopePaths: string[];
  wholeWorkspace?: boolean;
  responsibilities: Responsibilities;
  /** Normalized contract capabilities; derived from the profile when omitted. */
  capabilities?: ActionCapabilities;
  approvedMcpServers?: string[];
  /** Declared capability of each approved MCP tool, keyed by full tool name. */
  approvedMcpTools?: Record<string, { readOnly: boolean }>;
  approvedAgents?: string[];
  approvedSkills?: string[];
  /** Models the contract authorizes; a delegation may not override them. */
  authorizedModels?: string[];
  /** Effort this run was authorized with; a delegation may not weaken it. */
  requiredEffort?: string;
}

export interface ActionResult {
  decision: Decision;
  reason: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface ToolAction {
  tool: string;
  input: Record<string, unknown>;
}

const FILE_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const FILE_READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS']);
const HARMLESS_TOOLS = new Set(['TodoWrite', 'TodoRead', 'AskUserQuestion', 'ExitPlanMode', 'EnterPlanMode', 'ToolSearch']);
const DELEGATION_TOOLS = new Set(['Task', 'Agent']);
/** Effort a delegation must run with when the context declares none. */
const REQUIRED_DELEGATION_EFFORT = 'xhigh';
const NETWORK_TOOLS = new Set(['WebFetch', 'WebSearch']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell', 'BashOutput', 'KillShell']);

export const SENSITIVE_PATH_PATTERNS: RegExp[] = [
  /(^|[\\/])\.env(\.[^\\/]*)?$/i,
  /(^|[\\/])\.envrc$/i,
  /(^|[\\/])id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|pfx|p12|jks|keystore)$/i,
  /(^|[\\/])(credentials|secrets?)(\.[^\\/]*)?\.(json|ya?ml|toml|ini|txt)$/i,
  /(^|[\\/])service-account[^\\/]*\.json$/i,
  /(^|[\\/])\.git[\\/](config|credentials)$/i,
  /(^|[\\/])\.(npmrc|netrc|pypirc|yarnrc(\.yml)?|git-credentials)$/i,
  /(^|[\\/])\.aws[\\/]/i,
  /(^|[\\/])\.ssh[\\/]/i,
  /(^|[\\/])\.gnupg[\\/]/i,
  /(^|[\\/])\.claude[\\/]\.credentials\.json$/i,
  /(^|[\\/])\.claude\.json$/i,
  /(^|[\\/])secrets?[\\/]/i,
  /(^|[\\/])\.docker[\\/]config\.json$/i,
  /(^|[\\/])\.kube[\\/]config$/i,
  /(^|[\\/])\.codex[\\/](auth\.json|config\.toml)$/i,
];

interface Rule { pattern: RegExp; reason: string }

const RESERVED_RULES: Rule[] = [
  { pattern: /^git\b.*\bpush\b/i, reason: 'RESERVED_OPERATION_PUSH' },
  { pattern: /^gh\s+pr\s+(create|merge|close|ready|edit|reopen)\b/i, reason: 'RESERVED_OPERATION_PUSH' },
  { pattern: /^git\b.*\b(commit|merge|cherry-pick|revert)\b/i, reason: 'RESERVED_OPERATION_COMMIT' },
  // Provisioning a worktree is the broker's job, never the agent's: a checkout
  // created behind our back carries no writer lock, no trust record and no
  // entry in the orphan sweep. `git worktree list` is inspection and is left to
  // INSPECTION_RULES below.
  { pattern: /^git\s+worktree\s+(add|remove|move|prune|lock|unlock|repair)\b/i, reason: 'RESERVED_OPERATION_WORKTREE' },
  { pattern: /^(npm|pnpm|yarn|bun)\s+(publish|deprecate|dist-tag|unpublish)\b/i, reason: 'RESERVED_OPERATION_DEPLOY' },
  { pattern: /^(docker\s+push|kubectl\s+(apply|delete|rollout|scale)|terraform\s+(apply|destroy)|pulumi\s+(up|destroy)|firebase\s+deploy|vercel\b|netlify\s+deploy|gh\s+release\b|helm\s+(install|upgrade|uninstall)|twine\s+upload|cargo\s+publish|dotnet\s+nuget\s+push|az\s+\S+.*\bdeploy\b|aws\s+\S+.*\bdeploy\b|gcloud\s+\S+.*\bdeploy\b|fly\s+deploy|heroku\s+)/i, reason: 'RESERVED_OPERATION_DEPLOY' },
  { pattern: /^(npm|pnpm|yarn|bun)\s+(i|install|add|uninstall|remove|update|link|rm|un)\b.*(\s|^)(-g|--global)\b/i, reason: 'RESERVED_OPERATION_INSTALL' },
  { pattern: /^(npm|pnpm|yarn|bun)\s+(-g|--global)\b/i, reason: 'RESERVED_OPERATION_INSTALL' },
  { pattern: /^npx\s+(-g|--global)\b/i, reason: 'RESERVED_OPERATION_INSTALL' },
  { pattern: /^codex\s+(plugin|mcp|config)\b/i, reason: 'RESERVED_OPERATION_INSTALL' },
  { pattern: /^claude\s+(plugin|mcp|install|update|migrate-installer|doctor\s+--fix)\b/i, reason: 'RESERVED_OPERATION_INSTALL' },
  { pattern: /^(winget|choco|scoop|brew|apt|apt-get|yum|dnf|pacman|snap)\s+(install|remove|uninstall|upgrade|update)\b/i, reason: 'RESERVED_OPERATION_INSTALL' },
  { pattern: /^(Install-Module|Install-Package|Uninstall-Module)\b/i, reason: 'RESERVED_OPERATION_INSTALL' },
  { pattern: /^claude\s+(config|auth|login|logout|setup-token)\b/i, reason: 'RESERVED_OPERATION_CONFIG' },
  { pattern: /^codex\s+(login|logout)\b/i, reason: 'RESERVED_OPERATION_CONFIG' },
  { pattern: /^git\s+config\s+(--global|--system)\b/i, reason: 'RESERVED_OPERATION_CONFIG' },
  { pattern: /^npm\s+(config\s+set|login|adduser|logout|token)\b/i, reason: 'RESERVED_OPERATION_CONFIG' },
  { pattern: /^gh\s+auth\b/i, reason: 'RESERVED_OPERATION_CONFIG' },
  { pattern: /^(setx|reg\s+add|reg\s+delete|Set-ItemProperty\s+.*HK(LM|CU)|New-ItemProperty\s+.*HK(LM|CU))\b/i, reason: 'RESERVED_OPERATION_CONFIG' },
];

const DESTRUCTIVE_RULES: RegExp[] = [
  /^rm\s+(?=.*\s-[a-z]*r)/i,
  /^rm\s+-[a-z]*f/i,
  /^rmdir\b.*\s\/s\b/i,
  /^rd\b.*\s\/s\b/i,
  /^del\b.*\s\/[sq]\b/i,
  /^(Remove-Item|ri|rm|erase)\b.*-(Recurse|Force)/i,
  /^git\s+(checkout\s+--|checkout\s+\.|restore\b|reset\s+--hard|clean\b|stash\b|branch\s+-[dD]\b|tag\s+-d\b|rebase\b|filter-branch\b|reflog\s+expire|gc\s+--prune)/i,
  /^(format|mkfs|dd\s+if=|diskpart|fsutil)\b/i,
  /^(truncate|Clear-Content|Remove-Item|Clear-RecycleBin)\b/i,
  /^find\b.*\s-delete\b/i,
];

const INTERPRETER_EVAL_RULES: RegExp[] = [
  /^(node|bun|deno)\s+(-e|--eval|-p|--print|--input-type)\b/i,
  /^(python|python3|py)\s+-c\b/i,
  /^(pwsh|powershell)\b.*\s-(c|command|encodedcommand|ec|e)\b/i,
  /^(bash|sh|zsh|dash|ksh)\s+-c\b/i,
  /^cmd(\.exe)?\s+\/[ck]\b/i,
  /^(eval|exec|source)\s/i,
  /^\.\s/,
  /^(Invoke-Expression|iex|Invoke-Command|icm)\b/i,
  /^find\b.*\s-(exec|execdir|ok|okdir)\b/i,
  /^xargs\b/i,
  /^(perl|ruby|php)\s+-e\b/i,
];

const NETWORK_RULES: RegExp[] = [
  /^(curl|wget|ssh|scp|sftp|ftp|telnet|nc|ncat|nmap|ping|tracert|traceroute|Invoke-WebRequest|iwr|Invoke-RestMethod|irm|Start-BitsTransfer|Test-NetConnection|tnc)\b/i,
  /^git\s+(fetch|pull|clone|ls-remote|remote\s+add|submodule\s+update)\b/i,
  /^(npm|pnpm|yarn)\s+(view|search|info|show|whoami|ping|audit)\b/i,
  /^gh\b/i,
  /^(pip|pip3)\s+(download|search)\b/i,
];

const DEPENDENCY_RULES: RegExp[] = [
  /^(npm|pnpm|yarn|bun)\s+(i|install|ci|add|update|upgrade|uninstall|remove|link|dedupe|prune|rebuild|un|rm)\b/i,
  /^npx\b/i,
  /^(pip|pip3)\s+(install|uninstall)\b/i,
  /^(pipx|poetry\s+(add|install|remove|update)|uv\s+(add|pip|sync|tool))\b/i,
  /^cargo\s+(add|install|update)\b/i,
  /^go\s+(get|install|mod\s+(download|tidy))\b/i,
  /^dotnet\s+(add|restore|tool)\b/i,
  /^composer\s+(require|install|update|remove)\b/i,
  /^(gem\s+install|bundle\s+(install|add|update))\b/i,
];

const PROCESS_KILL_BROAD = /^(taskkill\b.*\/im\b|Stop-Process\b.*-Name\b|pkill\b|killall\b|Get-Process\b.*\|\s*Stop-Process)/i;
const PROCESS_KILL = /^(taskkill|Stop-Process|kill|spps)\b/i;
// `worktree` is deliberately absent: its mutating subcommands are denied by
// RESERVED_RULES, and `git worktree list` must reach INSPECTION_RULES. Listing
// it here made that inspection alternative unreachable, because this test runs
// first.
const GIT_STATE_RULES = /^git\s+(add|rm|mv|switch|checkout\s+(?![-.])|init|tag|notes|update-index|submodule|lfs)\b/i;
const ENV_DISCLOSURE = /^(env|printenv|set|Get-ChildItem\s+env:|gci\s+env:|ls\s+env:|dir\s+env:|\[Environment\]::GetEnvironmentVariables)\b/i;

const INSPECTION_RULES: RegExp[] = [
  /^git\s+(status|diff|log|show|blame|rev-parse|ls-files|describe|shortlog|cat-file|grep|reflog|stash\s+list|worktree\s+list|config\s+(--get|--list|-l)\b|branch(\s+(-a|-r|--list|-v|-vv|--show-current|--contains))*\s*$|remote(\s+-v)?\s*$)/i,
  /^(ls|dir|pwd|cat|type|more|less|head|tail|wc|echo|printf|tree|find|findstr|grep|rg|egrep|fgrep|sort|uniq|cut|tr|diff|cmp|file|stat|du|df|which|where|whoami|hostname|date|nl|basename|dirname|realpath|readlink|jq|yq|xxd|od|strings)\b/i,
  /^sed\s+-n\b/i,
  /^(Get-ChildItem|gci|Get-Content|gc|Get-Item|gi|Get-Location|gl|Select-String|sls|Test-Path|Resolve-Path|rvpa|Get-Command|gcm|Get-Process|gps|Measure-Object|Write-Output|Write-Host|Get-Date|Get-FileHash|Compare-Object|Format-List|Format-Table|Select-Object|ConvertFrom-Json|Get-Help|Split-Path|Join-Path)\b/i,
  /^node\s+(-v|--version)\s*$/i,
  /^(npm|pnpm|yarn)\s+(-v|--version|ls|list|outdated|explain|why|run\s*$|help)\b/i,
  /^npx\s+--version\b/i,
  /^(tsc|python|python3|pwsh|dotnet|go|cargo|rustc|java|javac|ruby|php|deno|bun)\s+(-v|-V|--version|--info|version)\s*$/i,
  /^(sleep|timeout|Start-Sleep)\b/i,
];

const TESTING_RULES: RegExp[] = [
  /^(npm|pnpm|yarn|bun)\s+(test|t|run(-script)?\s+\S+|exec\s+\S+)\b/i,
  /^node\s+/i,
  /^(pytest|vitest|jest|mocha|ava|tap|karma|cypress\s+run|playwright\s+test|go\s+(test|build|vet)|cargo\s+(test|check|clippy|build)|dotnet\s+(test|build)|python\s+-m\s+(pytest|unittest)|python3\s+-m\s+(pytest|unittest)|pwsh\s+.*-File\s+\S+|tsc\b|eslint\b|prettier\b|vite\s+build|esbuild\b|make\b|gradlew?\s+(test|build|check)|mvn\s+(test|verify|package|compile)|phpunit|rspec|mix\s+test|dotnet\s+run|python\s+\S+\.py|python3\s+\S+\.py|ruby\s+\S+\.rb|php\s+\S+\.php)\b/i,
];

const IMPLEMENTATION_RULES: RegExp[] = [
  /^(mkdir|md|New-Item|ni|touch|cp|copy|Copy-Item|cpi|mv|move|Move-Item|mi|ren|rename|Rename-Item|rni|Set-Content|sc|Add-Content|ac|Out-File|tee|patch|chmod|attrib|icacls)\b/i,
  /^sed\s+-i\b/i,
  /^git\s+apply\b/i,
];

const MESSAGES: Record<string, string> = {
  RESERVED_OPERATION_PUSH: 'Operação reservada: push, abertura ou merge de PR pertencem ao Codex ou ao usuário; o Claude não pode executá-los.',
  RESERVED_OPERATION_COMMIT: 'Operação reservada: commit, merge e reescrita de histórico pertencem ao Codex ou ao usuário.',
  RESERVED_OPERATION_DEPLOY: 'Operação reservada: publicação e deploy são mutações externas fora do escopo do Claude.',
  RESERVED_OPERATION_WORKTREE: 'Operação reservada: criar, remover ou mover worktrees altera o repositório de forma persistente e é feito pelo broker, não pelo Claude. Listar worktrees é permitido.',
  GIT_ADMIN_AREA: 'Escrita negada: o diretório administrativo .git contém hooks e referências que passam a valer no próximo commit, que não pertence ao Claude.',
  RESERVED_OPERATION_INSTALL: 'Operação reservada: instalação global, de plugins ou de gerenciadores de pacotes altera a máquina e exige ação do Codex ou do usuário.',
  RESERVED_OPERATION_CONFIG: 'Operação reservada: configuração instalada, autenticação e registro do sistema não podem ser alterados pelo Claude.',
  SENSITIVE_FILE: 'Arquivo sensível bloqueado: credenciais, chaves, variáveis de ambiente ou configuração de autenticação não são lidos nem escritos.',
  SENSITIVE_TARGET: 'O caminho aponta (via link ou junção) para um arquivo sensível; bloqueado pelo destino resolvido.',
  OUTSIDE_WORKSPACE: 'Caminho fora do workspace aprovado; escritas só são permitidas dentro do workspace.',
  OUTSIDE_WORKSPACE_READ: 'Leitura fora do workspace aprovado; requer decisão do coordenador.',
  OUTSIDE_SCOPE_PATH: 'Caminho dentro do workspace, mas fora dos diretórios do escopo aprovado; requer decisão do coordenador.',
  IN_SCOPE_IMPLEMENTATION: 'Edição dentro do escopo aprovado e atribuída ao Claude.',
  IN_WORKSPACE_READ: 'Leitura dentro do workspace aprovado.',
  INSPECTION_COMMAND: 'Comando de inspeção conhecido dentro do workspace.',
  TESTING_COMMAND: 'Comando de teste ou verificação atribuído ao Claude. Guardrail textual: o script do projeto não é inspecionado.',
  IMPLEMENTATION_COMMAND: 'Comando que grava dentro do escopo aprovado, atribuído ao Claude.',
  EXTERNAL_NETWORK: 'Ação de rede externa; requer decisão do coordenador antes de executar.',
  DESTRUCTIVE: 'Comando potencialmente destrutivo (remoção recursiva, descarte de alterações, reescrita); requer decisão do coordenador.',
  INTERPRETER_EVAL: 'Avaliação de código arbitrário por interpretador ou execução encadeada; a classificação textual não consegue prever o efeito, requer decisão do coordenador.',
  DEPENDENCY_CHANGE: 'Alteração de dependências ou execução de pacote remoto; requer decisão do coordenador.',
  PROCESS_KILL_BROAD: 'Encerramento de processos por nome afetaria outros processos do usuário; requer decisão do coordenador.',
  PROCESS_KILL: 'Encerramento de processo; requer decisão do coordenador.',
  GIT_STATE_CHANGE: 'Alteração de estado do git (índice, branch, worktree); requer decisão do coordenador porque o Codex controla o histórico.',
  ENV_DISCLOSURE: 'Listagem do ambiente pode expor credenciais no transcript; requer decisão do coordenador.',
  SHELL_SUBSTITUTION: 'Substituição de comando ou processo impede classificar o que será executado; requer decisão do coordenador.',
  UNCLASSIFIED_COMMAND: 'Comando não reconhecido como parte do escopo aprovado; requer decisão do coordenador.',
  UNCLASSIFIED_TOOL: 'Ferramenta não reconhecida; requer decisão do coordenador.',
  NOT_ASSIGNED_IMPLEMENTATION: 'A responsabilidade implementation não pertence ao Claude neste plano; escritas (edições, redirecionamentos, movimentações) não são permitidas.',
  NOT_ASSIGNED_TESTING: 'A responsabilidade testing não pertence ao Claude neste plano; comandos de teste não são permitidos.',
  NOT_ASSIGNED_INSPECTION: 'Nenhuma responsabilidade de leitura (inspection, implementation ou testing) pertence ao Claude neste plano.',
  CAPABILITY_EDIT_NOT_GRANTED: 'Esta execução não concede edição de arquivos (fase de planejamento ou perfil somente leitura); nenhuma escrita é permitida por nenhum caminho.',
  CAPABILITY_COMMANDS_NOT_GRANTED: 'Esta execução não concede comandos de shell (fase de planejamento ou perfil somente leitura).',
  MCP_APPROVED_READ: 'Ferramenta MCP aprovada e declarada somente leitura.',
  MCP_EXTERNAL_MUTATION: 'A aprovação do servidor MCP não autoriza mutações externas; esta ferramenta requer decisão do coordenador.',
  MCP_TOOL_SEMANTICS_UNKNOWN: 'A semântica desta ferramenta MCP não foi declarada na aprovação; requer decisão do coordenador.',
  MCP_SERVER_NOT_APPROVED: 'Servidor MCP não aprovado no inventário de confiança do projeto.',
  AGENT_NOT_APPROVED: 'Subagente não aprovado no inventário de confiança; a delegação herda as mesmas permissões e exige decisão do coordenador.',
  SKILL_NOT_APPROVED: 'Skill não aprovada no inventário de confiança; requer decisão do coordenador.',
  DELEGATION_MODEL_OVERRIDE: 'A delegação tentou escolher outro modelo; somente os modelos autorizados do contrato podem ser usados.',
  DELEGATION_EFFORT_OVERRIDE: 'A delegação tentou usar outro esforço; o subagente executa com o mesmo esforço aprovado para esta execução (Extra/xhigh).',
  DELEGATION_WITHOUT_CAPABILITY: 'A delegação pediria capacidades que esta execução não concede; o subagente não pode exceder o contrato.',
  BUILTIN_SAFE: 'Ferramenta interna sem efeito externo.',
  READ_ONLY_PROFILE: 'Perfil somente leitura: ferramentas de escrita e comandos não estão disponíveis.',
  HARMLESS_COMMAND: 'Comando inofensivo.',
};

function result(decision: Decision, reason: string, details?: Record<string, unknown>): ActionResult {
  return { decision, reason, message: MESSAGES[reason] ?? reason, ...(details ? { details } : {}) };
}

const SEVERITY: Record<Decision, number> = { allow: 1, escalate: 2, deny: 3 };

function worst(results: ActionResult[]): ActionResult {
  let chosen = results[0]!;
  for (const candidate of results) if (SEVERITY[candidate.decision] > SEVERITY[chosen.decision]) chosen = candidate;
  return chosen;
}

function normalizeForCompare(p: string): string {
  const normalized = path.normalize(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/** Resolves the deepest existing ancestor through junctions and symlinks. */
function realpathContained(target: string): string {
  let probe = target;
  const trailing: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(probe);
      return trailing.length ? path.join(real, ...trailing.reverse()) : real;
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return target;
      trailing.push(path.basename(probe));
      probe = parent;
    }
  }
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(normalizeForCompare(parent), normalizeForCompare(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export interface ResolvedTarget {
  /** Lexically resolved path as written by the caller. */
  absolute: string;
  /** Path after following symlinks and junctions; the authority for checks. */
  resolved: string;
  inside: boolean;
  /** True when the alias and its real target differ. */
  redirected: boolean;
}

export function resolveWorkspacePath(workspace: string, candidate: string): ResolvedTarget {
  const absolute = path.resolve(workspace, candidate);
  const workspaceReal = realpathContained(workspace);
  const resolved = realpathContained(absolute);
  return {
    absolute,
    resolved,
    inside: isInside(workspaceReal, resolved),
    redirected: normalizeForCompare(absolute) !== normalizeForCompare(resolved),
  };
}

export function isSensitivePath(candidate: string): boolean {
  const text = candidate.replace(/["']/g, '');
  return SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(text));
}

/** `.git` as a whole path segment. `.gitignore`, `.gitattributes` and
 *  `.github` are ordinary project files and must not match. */
const GIT_ADMIN_SEGMENT = /(^|[\\/])\.git([\\/]|$)/i;

/**
 * Whether a write lands anywhere in a git administrative area.
 *
 * Only `.git/config` and `.git/credentials` are sensitive by pattern, which
 * left `.git/hooks/pre-commit` writable — arbitrary code that runs on the next
 * commit, and commit always belongs to the coordinator or the user. Containment
 * cannot catch it either: in a worktree `.git` is a *file* holding `gitdir: …`,
 * so the resolved path stays inside the working tree while the write reaches
 * the repository's shared admin directory.
 */
export function targetsGitAdminArea(candidate: string): boolean {
  return GIT_ADMIN_SEGMENT.test(candidate.replace(/["']/g, ''));
}

function capabilitiesOf(context: ActionContext): ActionCapabilities {
  if (context.capabilities) return context.capabilities;
  if (context.profile === 'read') return { edit: false, test: false, commands: 'none' };
  return {
    edit: context.responsibilities.implementation === 'claude',
    test: context.responsibilities.testing === 'claude',
    commands: context.profile === 'development' ? 'classified' : 'exact-list',
  };
}

function scopeContains(context: ActionContext, resolved: string): boolean {
  if (context.wholeWorkspace) return true;
  if (context.scopePaths.length === 0) return false;
  const workspaceReal = realpathContained(context.workspace);
  const rel = path.relative(normalizeForCompare(workspaceReal), normalizeForCompare(resolved)).replace(/\\/g, '/');
  if (rel.startsWith('..')) return false;
  for (const scope of context.scopePaths) {
    const clean = scope.replace(/\\/g, '/').replace(/^\.\//, '');
    const lowered = process.platform === 'win32' ? clean.toLowerCase() : clean;
    const relCompare = process.platform === 'win32' ? rel.toLowerCase() : rel;
    const dir = lowered.endsWith('/') ? lowered : `${lowered}/`;
    if (relCompare === lowered.replace(/\/$/, '') || relCompare.startsWith(dir)) return true;
  }
  return false;
}

function pathFromInput(input: Record<string, unknown>): string | null {
  for (const key of ['file_path', 'notebook_path', 'path', 'filePath']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

function canRead(responsibilities: Responsibilities): boolean {
  return responsibilities.inspection === 'claude' || responsibilities.implementation === 'claude' || responsibilities.testing === 'claude';
}

/**
 * Shared read-target policy for anything a command names: the decision follows
 * the RESOLVED path, so a link or junction inside the scope cannot be used to
 * reach a sensitive file or leave the workspace. `outside` says how leaving the
 * workspace is treated, which differs between a declared path argument and a
 * redirection input.
 */
function checkSensitiveTarget(context: ActionContext, candidate: string): ActionResult | null {
  if (isSensitivePath(candidate)) return result('deny', 'SENSITIVE_FILE', { token: candidate });
  const resolved = resolveWorkspacePath(context.workspace, candidate);
  if (isSensitivePath(resolved.absolute)) return result('deny', 'SENSITIVE_FILE', { token: candidate });
  if (isSensitivePath(resolved.resolved)) {
    return result('deny', resolved.redirected ? 'SENSITIVE_TARGET' : 'SENSITIVE_FILE', { token: candidate, resolved: resolved.resolved });
  }
  return null;
}

function checkReadTarget(context: ActionContext, candidate: string, outside: 'deny' | 'escalate'): ActionResult | null {
  const sensitive = checkSensitiveTarget(context, candidate);
  if (sensitive) return sensitive;
  const resolved = resolveWorkspacePath(context.workspace, candidate);
  if (!resolved.inside) {
    return outside === 'deny'
      ? result('deny', 'OUTSIDE_WORKSPACE', { path: candidate, ...(resolved.redirected ? { resolved: resolved.resolved } : {}) })
      : result('escalate', 'OUTSIDE_WORKSPACE_READ', { path: candidate, ...(resolved.redirected ? { resolved: resolved.resolved } : {}) });
  }
  return null;
}

/** Shared write-target policy: capability, sensitivity, containment, scope. */
function checkWriteTarget(target: string, context: ActionContext): ActionResult | null {
  const capabilities = capabilitiesOf(context);
  if (!capabilities.edit) {
    return context.responsibilities.implementation === 'claude'
      ? result('deny', 'CAPABILITY_EDIT_NOT_GRANTED', { path: target })
      : result('deny', 'NOT_ASSIGNED_IMPLEMENTATION', { path: target });
  }
  if (isSensitivePath(target)) return result('deny', 'SENSITIVE_FILE', { path: target });
  const resolved = resolveWorkspacePath(context.workspace, target);
  if (isSensitivePath(resolved.absolute)) return result('deny', 'SENSITIVE_FILE', { path: target });
  if (isSensitivePath(resolved.resolved)) return result('deny', resolved.redirected ? 'SENSITIVE_TARGET' : 'SENSITIVE_FILE', { path: target, resolved: resolved.resolved });
  // Checked on both spellings: a symlink into `.git` redirects, and a worktree's
  // `.git` file keeps the resolved path inside the working tree.
  if (targetsGitAdminArea(target) || targetsGitAdminArea(resolved.absolute) || targetsGitAdminArea(resolved.resolved)) {
    return result('deny', 'GIT_ADMIN_AREA', { path: target, ...(resolved.redirected ? { resolved: resolved.resolved } : {}) });
  }
  if (!resolved.inside) return result('deny', 'OUTSIDE_WORKSPACE', { path: target, ...(resolved.redirected ? { resolved: resolved.resolved } : {}) });
  if (!scopeContains(context, resolved.resolved)) return result('escalate', 'OUTSIDE_SCOPE_PATH', { path: target, ...(resolved.redirected ? { resolved: resolved.resolved } : {}) });
  return null;
}

function classifyFileAction(tool: string, input: Record<string, unknown>, context: ActionContext): ActionResult {
  const write = FILE_WRITE_TOOLS.has(tool);
  const raw = pathFromInput(input);
  const candidate = raw ?? context.workspace;
  if (write) {
    const problem = checkWriteTarget(candidate, context);
    return problem ?? result('allow', 'IN_SCOPE_IMPLEMENTATION');
  }
  if (isSensitivePath(candidate)) return result('deny', 'SENSITIVE_FILE', { path: raw });
  const resolved = resolveWorkspacePath(context.workspace, candidate);
  if (isSensitivePath(resolved.absolute)) return result('deny', 'SENSITIVE_FILE', { path: raw });
  if (isSensitivePath(resolved.resolved)) return result('deny', resolved.redirected ? 'SENSITIVE_TARGET' : 'SENSITIVE_FILE', { path: raw, resolved: resolved.resolved });
  if (!resolved.inside) return result('escalate', 'OUTSIDE_WORKSPACE_READ', { path: raw, ...(resolved.redirected ? { resolved: resolved.resolved } : {}) });
  if (!canRead(context.responsibilities)) return result('deny', 'NOT_ASSIGNED_INSPECTION');
  return result('allow', 'IN_WORKSPACE_READ');
}

function splitSegments(command: string): string[] {
  return command
    .split(/\r?\n|&&|\|\||;|\|/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function stripEnvAssignments(segment: string): string {
  return segment.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, '');
}

function tokens(segment: string): string[] {
  return segment.match(/"[^"]*"|'[^']*'|\S+/g)?.map((token) => token.replace(/^["']|["']$/g, '')) ?? [];
}

/**
 * Windows-style switches (`/IM`, `/F`, `/c`) are options, not paths. A single
 * leading slash followed by one segment is treated as a switch; a genuine
 * rooted POSIX path (`/etc/passwd`) still counts as a path.
 */
function looksLikePath(token: string): boolean {
  if (/^[A-Za-z]:[\\/]/.test(token) || token.startsWith('\\\\') || token.includes('..')) return true;
  if (token.startsWith('/')) return /^\/[^/]+\/.+/.test(token);
  return false;
}

/**
 * Broader than looksLikePath: any token that plausibly names a file, including
 * ordinary relative references such as `src/config.ts`. Used only to check the
 * RESOLVED target for sensitivity, never for workspace containment — a Windows
 * switch like `/IM` must keep being a switch, not a rooted path.
 */
function looksLikeFileReference(token: string): boolean {
  if (!token || token.startsWith('-')) return false;
  if (looksLikePath(token)) return true;
  if (token.startsWith('/')) return false;
  return /[\\/]/.test(token) || /^\.[^\\/]+$/.test(token) || /\.[A-Za-z0-9]{1,8}$/.test(token);
}

const NPM_VALUE_OPTIONS = new Set(['--prefix', '-C', '--workspace', '-w', '--loglevel', '--cache', '--userconfig', '--registry', '--script-shell']);
const NPM_FLAG_OPTIONS = /^(-s|-q|-d|-dd|-ddd|--silent|--quiet|--verbose|--no-audit|--no-fund|--ignore-scripts|--workspaces|--if-present|--json|--offline|--prefer-offline|--legacy-peer-deps|--no-save|--save-exact|--yes|-y|--no-progress|--foreground-scripts)$/i;
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);
const GIT_FLAG_OPTIONS = /^(--no-pager|-P|--no-optional-locks|--paginate|-p|--literal-pathspecs|--glob-pathspecs|--noglob-pathspecs|--icase-pathspecs|--no-replace-objects|--bare)$/i;

/** Strips leading global options so `npm --prefix x install` classifies by its subcommand. */
function normalizeCommandTokens(segmentTokens: string[]): { normalized: string; declaredPaths: string[] } {
  const declaredPaths: string[] = [];
  const first = (segmentTokens[0] ?? '').toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
  let rest = segmentTokens.slice(1);
  const isNpm = ['npm', 'pnpm', 'yarn', 'bun'].includes(first);
  const isGit = first === 'git';
  if (isNpm || isGit) {
    const valueOptions = isNpm ? NPM_VALUE_OPTIONS : GIT_VALUE_OPTIONS;
    const flagOptions = isNpm ? NPM_FLAG_OPTIONS : GIT_FLAG_OPTIONS;
    while (rest.length) {
      const token = rest[0]!;
      const eq = /^(--?[A-Za-z-]+)=(.*)$/.exec(token);
      if (eq && valueOptions.has(eq[1]!)) {
        if (['--prefix', '-C', '--git-dir', '--work-tree', '--cwd', '--workspace', '-w'].includes(eq[1]!)) declaredPaths.push(eq[2]!);
        rest = rest.slice(1);
        continue;
      }
      if (valueOptions.has(token)) {
        if (['--prefix', '-C', '--git-dir', '--work-tree', '--workspace', '-w'].includes(token) && rest[1]) declaredPaths.push(rest[1]!);
        rest = rest.slice(2);
        continue;
      }
      if (flagOptions.test(token)) {
        rest = rest.slice(1);
        continue;
      }
      break;
    }
  }
  return { normalized: [segmentTokens[0] ?? '', ...rest].join(' '), declaredPaths };
}

function pathArguments(segmentTokens: string[]): string[] {
  const found: string[] = [];
  for (let index = 1; index < segmentTokens.length; index += 1) {
    const token = segmentTokens[index]!;
    if ((token === '--cwd' || token === '-cwd' || token === '--dir' || token === '--WorkingDirectory') && index + 1 < segmentTokens.length) found.push(segmentTokens[index + 1]!);
    const eq = /^(--cwd|--dir)=(.+)$/.exec(token);
    if (eq) found.push(eq[2]!);
    if (looksLikePath(token) && !token.startsWith('-')) found.push(token);
  }
  return found;
}

interface Redirections { outputs: string[]; inputs: string[] }

function redirections(segment: string): Redirections {
  const outputs: string[] = [];
  const inputs: string[] = [];
  const outputPattern = /(?:^|[^<>0-9]|\b[0-9])(>{1,2})\s*("[^"]+"|'[^']+'|[^\s|&;<>]+)/g;
  let match: RegExpExecArray | null;
  while ((match = outputPattern.exec(segment)) !== null) {
    const target = match[2]!.replace(/^["']|["']$/g, '');
    if (target && !/^&\d$/.test(target) && target !== '/dev/null' && target.toLowerCase() !== 'nul') outputs.push(target);
  }
  const inputPattern = /(?:^|[^<>])<(?![<(])\s*("[^"]+"|'[^']+'|[^\s|&;<>]+)/g;
  while ((match = inputPattern.exec(segment)) !== null) inputs.push(match[1]!.replace(/^["']|["']$/g, ''));
  return { outputs, inputs };
}

function positionals(segmentTokens: string[]): string[] {
  return segmentTokens.slice(1).filter((token) => !token.startsWith('-') && !/^\/[^/]*$/.test(token));
}

/** Files written by output options of otherwise read-only commands, and move/copy destinations. */
function optionWriteTargets(segmentTokens: string[]): string[] {
  const command = (segmentTokens[0] ?? '').toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
  const targets: string[] = [];
  const valueAfter = (flags: string[]) => {
    for (let index = 1; index < segmentTokens.length; index += 1) {
      const token = segmentTokens[index]!;
      if (flags.includes(token) && segmentTokens[index + 1]) targets.push(segmentTokens[index + 1]!);
      const eq = /^(--?[A-Za-z-]+)=(.+)$/.exec(token);
      if (eq && flags.includes(eq[1]!)) targets.push(eq[2]!);
    }
  };
  switch (command) {
    case 'sort':
      valueAfter(['-o', '--output']);
      break;
    case 'uniq': {
      const args = positionals(segmentTokens);
      if (args.length >= 2) targets.push(args[1]!);
      break;
    }
    case 'find':
      valueAfter(['-fprint', '-fprint0', '-fprintf', '-fls']);
      break;
    case 'tee':
      targets.push(...positionals(segmentTokens));
      break;
    case 'cp':
    case 'copy':
    case 'copy-item':
    case 'cpi': {
      const args = positionals(segmentTokens);
      if (args.length >= 2) targets.push(args[args.length - 1]!);
      valueAfter(['-Destination']);
      break;
    }
    case 'mv':
    case 'move':
    case 'move-item':
    case 'mi':
    case 'ren':
    case 'rename':
    case 'rename-item':
    case 'rni':
      targets.push(...positionals(segmentTokens));
      valueAfter(['-Destination', '-NewName', '-Path']);
      break;
    case 'out-file':
    case 'set-content':
    case 'sc':
    case 'add-content':
    case 'ac': {
      valueAfter(['-Path', '-FilePath', '-LiteralPath']);
      const args = positionals(segmentTokens);
      if (args.length >= 1 && !targets.length) targets.push(args[0]!);
      break;
    }
    case 'sed':
      if (segmentTokens.some((token) => /^-i/.test(token))) targets.push(...positionals(segmentTokens).filter((token) => !token.startsWith('s/')).slice(-1));
      break;
    case 'dd':
      valueAfter(['of']);
      for (const token of segmentTokens) { const m = /^of=(.+)$/.exec(token); if (m) targets.push(m[1]!); }
      break;
    default:
      break;
  }
  return targets;
}

function classifyCommandSegment(segment: string, context: ActionContext, whole: string): ActionResult {
  const stripped = stripEnvAssignments(segment);
  const segmentTokens = tokens(stripped);
  if (segmentTokens.length === 0) return result('allow', 'HARMLESS_COMMAND');
  for (const token of segmentTokens) if (isSensitivePath(token)) return result('deny', 'SENSITIVE_FILE', { token });
  const { normalized, declaredPaths } = normalizeCommandTokens(segmentTokens);
  for (const rule of RESERVED_RULES) if (rule.pattern.test(stripped) || rule.pattern.test(normalized)) return result('deny', rule.reason, { command: stripped });
  for (const candidate of declaredPaths) {
    const problem = checkReadTarget(context, candidate, 'deny');
    if (problem) return problem;
  }
  const redirect = redirections(segment);
  for (const input of redirect.inputs) {
    const problem = checkReadTarget(context, input, 'escalate');
    if (problem) return problem;
  }
  const writes = [...redirect.outputs, ...optionWriteTargets(segmentTokens)];
  for (const target of writes) {
    const problem = checkWriteTarget(target, context);
    if (problem) return problem;
  }
  // Containment is decided on tokens that really look like paths; sensitivity
  // is decided on anything that names a file, because a plain relative name can
  // still be a link to a credential file.
  for (const candidate of pathArguments(segmentTokens)) {
    const problem = checkReadTarget(context, candidate, 'deny');
    if (problem) return problem;
  }
  for (let index = 1; index < segmentTokens.length; index += 1) {
    const token = segmentTokens[index]!;
    if (!looksLikeFileReference(token)) continue;
    const problem = checkSensitiveTarget(context, token);
    if (problem) return problem;
  }
  const base = normalized;
  if (DESTRUCTIVE_RULES.some((rule) => rule.test(base))) return result('escalate', 'DESTRUCTIVE', { command: stripped });
  if (INTERPRETER_EVAL_RULES.some((rule) => rule.test(base))) return result('escalate', 'INTERPRETER_EVAL', { command: stripped });
  if (ENV_DISCLOSURE.test(base)) return result('escalate', 'ENV_DISCLOSURE');
  if (NETWORK_RULES.some((rule) => rule.test(base))) return result('escalate', 'EXTERNAL_NETWORK', { command: stripped });
  if (DEPENDENCY_RULES.some((rule) => rule.test(base))) return result('escalate', 'DEPENDENCY_CHANGE', { command: stripped });
  if (PROCESS_KILL_BROAD.test(base)) return result('escalate', 'PROCESS_KILL_BROAD');
  if (PROCESS_KILL.test(base)) return result('escalate', 'PROCESS_KILL');
  if (GIT_STATE_RULES.test(base)) return result('escalate', 'GIT_STATE_CHANGE');
  let category: ActionResult | null = null;
  if (INSPECTION_RULES.some((rule) => rule.test(base))) {
    if (!canRead(context.responsibilities)) return result('deny', 'NOT_ASSIGNED_INSPECTION');
    category = result('allow', 'INSPECTION_COMMAND');
  } else if (TESTING_RULES.some((rule) => rule.test(base))) {
    if (context.responsibilities.testing !== 'claude') return result('deny', 'NOT_ASSIGNED_TESTING');
    if (!capabilitiesOf(context).test) return result('deny', 'CAPABILITY_COMMANDS_NOT_GRANTED');
    category = result('allow', 'TESTING_COMMAND');
  } else if (IMPLEMENTATION_RULES.some((rule) => rule.test(base))) {
    const problem = checkWriteTarget(context.workspace, context);
    if (problem && problem.reason !== 'OUTSIDE_SCOPE_PATH') return problem;
    category = result('allow', 'IMPLEMENTATION_COMMAND');
  }
  if (!category) return result('escalate', 'UNCLASSIFIED_COMMAND', { command: stripped.slice(0, 200), whole: whole.length > 200 ? `${whole.slice(0, 200)}…` : whole });
  if (writes.length) {
    return { ...result('allow', category.reason === 'INSPECTION_COMMAND' ? 'IMPLEMENTATION_COMMAND' : category.reason), details: { writes } };
  }
  return category;
}

function classifyCommand(command: string, context: ActionContext): ActionResult {
  if (capabilitiesOf(context).commands === 'none') return result('deny', 'CAPABILITY_COMMANDS_NOT_GRANTED', { command: command.slice(0, 120) });
  const segments = splitSegments(command);
  if (segments.length === 0) return result('escalate', 'UNCLASSIFIED_COMMAND');
  const results = segments.map((segment) => classifyCommandSegment(segment, context, command));
  const substitution = /\$\(|`|<\(|>\(|\$\{[^}]*\(/.test(command);
  if (substitution) {
    const inner = command.match(/\$\(([^)]*)\)|`([^`]*)`/g) ?? [];
    for (const piece of inner) {
      const innerCommand = piece.replace(/^\$\(|^`|\)$|`$/g, '');
      results.push(...splitSegments(innerCommand).map((segment) => classifyCommandSegment(segment, context, command)));
    }
    results.push(result('escalate', 'SHELL_SUBSTITUTION'));
  }
  return worst(results);
}

function classifyMcp(tool: string, context: ActionContext): ActionResult {
  const match = /^mcp__(.+?)__(.+)$/.exec(tool);
  const server = match ? match[1]! : '';
  if (!server || !context.approvedMcpServers?.includes(server)) return result('deny', 'MCP_SERVER_NOT_APPROVED', { server });
  const declared = context.approvedMcpTools?.[tool];
  if (!declared) return result('escalate', 'MCP_TOOL_SEMANTICS_UNKNOWN', { server, tool });
  if (declared.readOnly) return result('allow', 'MCP_APPROVED_READ', { server });
  return result('escalate', 'MCP_EXTERNAL_MUTATION', { server, tool });
}

/**
 * Delegation (Task/Agent) and Skill invocation inherit this execution's
 * contract: the target must be trusted, may not pick another model, and may
 * not ask for a capability this run does not grant.
 */
function classifyDelegation(tool: string, input: Record<string, unknown>, context: ActionContext): ActionResult {
  const capabilities = capabilitiesOf(context);
  const model = typeof input.model === 'string' ? input.model : null;
  // Without a declared model set there is nothing to check against, and an
  // unchecked delegation could launch any model: refuse instead of assuming.
  if (model && (!context.authorizedModels || !context.authorizedModels.includes(model))) {
    return result('deny', 'DELEGATION_MODEL_OVERRIDE', { tool, model });
  }
  const effort = typeof input.effort === 'string' ? input.effort : null;
  if (effort && effort !== (context.requiredEffort ?? REQUIRED_DELEGATION_EFFORT)) {
    return result('deny', 'DELEGATION_EFFORT_OVERRIDE', { tool, effort });
  }
  if (tool === 'Skill') {
    const name = String(input.skill ?? input.name ?? input.command ?? '');
    if (!name || !(context.approvedSkills ?? []).includes(name)) return result('escalate', 'SKILL_NOT_APPROVED', { skill: name || null });
    return result('allow', 'BUILTIN_SAFE', { skill: name });
  }
  const agent = String(input.subagent_type ?? input.agent ?? input.agent_type ?? '');
  if (!agent || !(context.approvedAgents ?? []).includes(agent)) return result('escalate', 'AGENT_NOT_APPROVED', { agent: agent || null });
  if (!capabilities.edit && !capabilities.test && capabilities.commands === 'none') {
    return result('escalate', 'DELEGATION_WITHOUT_CAPABILITY', { agent });
  }
  return result('allow', 'BUILTIN_SAFE', { agent });
}

export function classifyToolAction(action: ToolAction, context: ActionContext): ActionResult {
  const { tool, input } = action;
  if (tool.startsWith('mcp__')) return classifyMcp(tool, context);
  if (DELEGATION_TOOLS.has(tool) || tool === 'Skill') return classifyDelegation(tool, input, context);
  if (context.profile === 'read') {
    if (FILE_READ_TOOLS.has(tool)) return classifyFileAction(tool, input, context);
    if (HARMLESS_TOOLS.has(tool)) return result('allow', 'BUILTIN_SAFE');
    return result('deny', 'READ_ONLY_PROFILE', { tool });
  }
  if (FILE_WRITE_TOOLS.has(tool) || FILE_READ_TOOLS.has(tool)) return classifyFileAction(tool, input, context);
  if (NETWORK_TOOLS.has(tool)) return result('escalate', 'EXTERNAL_NETWORK', { tool });
  if (HARMLESS_TOOLS.has(tool)) return result('allow', 'BUILTIN_SAFE');
  if (SHELL_TOOLS.has(tool)) {
    const command = typeof input.command === 'string' ? input.command : '';
    return classifyCommand(command, context);
  }
  return result('escalate', 'UNCLASSIFIED_TOOL', { tool });
}
