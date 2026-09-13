// Preflight for the user's installed Claude Code CLI.
//
// CodeOrquestra never ships or substitutes a CLI: it resolves the executable
// the user already installed (through the Windows npm shim when needed),
// verifies that this exact build advertises every flag the runtime depends on,
// and refuses to launch otherwise. Model support and authentication evidence
// are reported honestly, including when they are simply unknown.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { REQUIRED_CLI_FLAGS } from '../engine/protocol.ts';
import type { AuthorizedModel } from '../shared/types.ts';

export { REQUIRED_CLI_FLAGS };

export type ResolvedExecutable =
  | {
      status: 'resolved';
      source: 'npm-shim' | 'direct';
      launcherPath: string;
      packageDir: string | null;
      packageVersion: string | null;
      executablePath: string;
      kind: 'native' | 'script';
      runWith: 'node' | null;
    }
  | { status: 'not_found'; launcherPath: string; code: 'CLI_NOT_FOUND'; vendorCliUsed: false };

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function readPackage(packageDir: string): Promise<{ version: string | null; bin: string | null }> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(packageDir, 'package.json'), 'utf8')) as { version?: string; bin?: string | Record<string, string> };
    const bin = typeof parsed.bin === 'string' ? parsed.bin : parsed.bin?.claude ?? null;
    return { version: parsed.version ?? null, bin };
  } catch {
    return { version: null, bin: null };
  }
}

async function resolveFromPackage(launcherPath: string, packageDir: string, platform: string): Promise<ResolvedExecutable> {
  const { version, bin } = await readPackage(packageDir);
  const nativeCandidates = platform === 'win32' ? [path.join(packageDir, 'bin', 'claude.exe')] : [path.join(packageDir, 'bin', 'claude')];
  for (const candidate of nativeCandidates) {
    if (await exists(candidate)) {
      return { status: 'resolved', source: 'npm-shim', launcherPath, packageDir, packageVersion: version, executablePath: candidate, kind: 'native', runWith: null };
    }
  }
  const script = path.join(packageDir, bin ?? 'cli.js');
  if (await exists(script)) {
    return { status: 'resolved', source: 'npm-shim', launcherPath, packageDir, packageVersion: version, executablePath: script, kind: 'script', runWith: 'node' };
  }
  return { status: 'not_found', launcherPath, code: 'CLI_NOT_FOUND', vendorCliUsed: false };
}

export async function resolveClaudeExecutable(input: { launcherPath: string; platform?: string }): Promise<ResolvedExecutable> {
  const platform = input.platform ?? process.platform;
  const launcherPath = input.launcherPath;
  if (!(await exists(launcherPath))) return { status: 'not_found', launcherPath, code: 'CLI_NOT_FOUND', vendorCliUsed: false };
  const lower = launcherPath.toLowerCase();
  if (lower.endsWith('.exe')) {
    return { status: 'resolved', source: 'direct', launcherPath, packageDir: null, packageVersion: null, executablePath: launcherPath, kind: 'native', runWith: null };
  }
  if (/\.(c?js|mjs)$/.test(lower)) {
    const packageDir = path.dirname(launcherPath);
    const { version } = await readPackage(packageDir);
    return { status: 'resolved', source: 'direct', launcherPath, packageDir, packageVersion: version, executablePath: launcherPath, kind: 'script', runWith: 'node' };
  }
  const base = path.basename(lower);
  if (base === 'claude' || base === 'claude.cmd' || base === 'claude.ps1') {
    const content = await fs.readFile(launcherPath, 'utf8').catch(() => '');
    const match = /node_modules[\\/]@anthropic-ai[\\/]claude-code[\\/]/.exec(content);
    const shimDir = path.dirname(launcherPath);
    const packageDir = path.join(shimDir, 'node_modules', '@anthropic-ai', 'claude-code');
    if (match || (await exists(packageDir))) return resolveFromPackage(launcherPath, packageDir, platform);
    if (platform !== 'win32' && !content.startsWith('#!')) {
      return { status: 'resolved', source: 'direct', launcherPath, packageDir: null, packageVersion: null, executablePath: launcherPath, kind: 'native', runWith: null };
    }
  }
  return { status: 'not_found', launcherPath, code: 'CLI_NOT_FOUND', vendorCliUsed: false };
}

export interface ModelDescriptor {
  value: string;
  resolvedModel?: string;
}

export interface CompatibilityInput {
  cliVersion: string | null;
  runtimeVersion: string;
  advertisedFlags: string[] | null;
  supportedModels: ModelDescriptor[] | null;
  requestedModel: AuthorizedModel;
}

export interface CompatibilityDiagnosis {
  status: 'compatible' | 'incompatible' | 'unknown';
  code: string | null;
  action: 'proceed' | 'report_to_coordinator';
  vendorCliUsed: false;
  missingCapabilities: string[];
  modelSupport: 'confirmed' | 'unconfirmed' | 'unknown';
  notes: string[];
  message: string;
}

/**
 * Compatibility is decided by the capabilities the installed build actually
 * advertises, never by comparing version numbers.
 */
export function diagnoseCliCompatibility(input: CompatibilityInput): CompatibilityDiagnosis {
  const notes: string[] = [];
  let modelSupport: CompatibilityDiagnosis['modelSupport'] = 'unknown';
  if (input.supportedModels) {
    const matches = input.supportedModels.some((model) => model.value === input.requestedModel || model.resolvedModel === input.requestedModel);
    modelSupport = matches ? 'confirmed' : 'unconfirmed';
    if (!matches) notes.push(`O catálogo consultado não lista ${input.requestedModel} nem um alias que resolva para ele; a evidência final é o modelo observado no init da sessão.`);
  } else {
    notes.push('O catálogo de modelos do CLI não foi consultado nesta etapa; o modelo observado no init é a evidência.');
  }
  if (input.advertisedFlags === null) {
    return { status: 'unknown', code: 'CAPABILITIES_UNKNOWN', action: 'report_to_coordinator', vendorCliUsed: false, missingCapabilities: [], modelSupport, notes, message: 'Não foi possível confirmar as capacidades do CLI instalado; a execução não inicia sem essa evidência.' };
  }
  const missing = REQUIRED_CLI_FLAGS.filter((flag) => !input.advertisedFlags!.includes(flag));
  if (missing.length) {
    return { status: 'incompatible', code: 'CLI_MISSING_CAPABILITY', action: 'report_to_coordinator', vendorCliUsed: false, missingCapabilities: [...missing], modelSupport, notes, message: `O Claude Code instalado (${input.cliVersion ?? 'versão desconhecida'}) não anuncia ${missing.join(', ')}, exigidos por este runtime. Nenhum CLI alternativo é usado.` };
  }
  return { status: 'compatible', code: null, action: 'proceed', vendorCliUsed: false, missingCapabilities: [], modelSupport, notes, message: `O Claude Code instalado (${input.cliVersion ?? 'versão desconhecida'}) anuncia as capacidades exigidas pelo runtime ${input.runtimeVersion}; modelo ${input.requestedModel} ${modelSupport === 'confirmed' ? 'confirmado no catálogo' : modelSupport === 'unconfirmed' ? 'não confirmado no catálogo (verificar no init)' : 'sem catálogo consultado'}.` };
}

export interface AuthAssessment {
  ok: boolean;
  code: 'AUTH_SUBSCRIPTION' | 'AUTH_API_BILLING_NOT_AUTHORIZED' | 'AUTH_API_BILLING_AUTHORIZED' | 'AUTH_STATUS_UNKNOWN' | 'AUTH_NOT_LOGGED_IN';
  evidence: string[];
  message: string;
}

export const CREDENTIAL_ENV_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK', 'ANTHROPIC_FOUNDRY_API_KEY', 'ANTHROPIC_FOUNDRY_AUTH_TOKEN', 'ANTHROPIC_AWS_API_KEY'] as const;
export const PROVIDER_ENV_VARS = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_MANTLE', 'ANTHROPIC_BASE_URL'] as const;

export interface AuthStatusSummary {
  loggedIn: boolean | null;
  authMethod: string | null;
  apiProvider: string | null;
  subscriptionType: string | null;
}

/**
 * Decides whether a launch may proceed on the authentication path it would
 * actually use. Fails closed: an inconclusive probe is not evidence of a
 * subscription, and billable credentials require explicit job authorization.
 */
export function assessAuthPath(input: { env: Record<string, string | undefined>; authStatus: AuthStatusSummary | null; allowApiBilling: boolean }): AuthAssessment {
  const evidence: string[] = [];
  for (const name of CREDENTIAL_ENV_VARS) if (input.env[name]) evidence.push(`${name} presente no ambiente`);
  for (const name of PROVIDER_ENV_VARS) if (input.env[name]) evidence.push(`${name} presente no ambiente`);
  const status = input.authStatus;
  if (status) {
    if (status.apiProvider && status.apiProvider !== 'firstParty') evidence.push(`apiProvider=${status.apiProvider}`);
    if (status.authMethod && /api|key|console/i.test(status.authMethod)) evidence.push(`authMethod=${status.authMethod}`);
  }
  if (evidence.length && !input.allowApiBilling) {
    return { ok: false, code: 'AUTH_API_BILLING_NOT_AUTHORIZED', evidence, message: 'Credenciais de API ou provedor de nuvem detectadas; este caminho pode gerar cobrança por API e exige autorização separada (auth.allowApiBilling) no job.' };
  }
  if (evidence.length) {
    return { ok: true, code: 'AUTH_API_BILLING_AUTHORIZED', evidence, message: 'Caminho de API autorizado explicitamente pelo job (auth.allowApiBilling).' };
  }
  if (status?.loggedIn === false) return { ok: false, code: 'AUTH_NOT_LOGGED_IN', evidence, message: 'O Claude Code instalado não está autenticado; faça login pelo fluxo normal do CLI antes de iniciar.' };
  const confirmed = status !== null && status.loggedIn === true && status.apiProvider === 'firstParty' && typeof status.authMethod === 'string' && status.authMethod.length > 0;
  if (!confirmed) {
    return { ok: false, code: 'AUTH_STATUS_UNKNOWN', evidence, message: 'Estado de autenticação não confirmado pela sondagem; a execução não inicia sem assinatura verificada ou auth.allowApiBilling explícito no job.' };
  }
  return { ok: true, code: 'AUTH_SUBSCRIPTION', evidence, message: 'Autenticação por assinatura confirmada pelo CLI instalado (sem detalhes de conta retidos).' };
}

export interface ProbeResult {
  cliVersion: string | null;
  advertisedFlags: string[] | null;
  authStatus: AuthStatusSummary | null;
  supportedModels?: ModelDescriptor[] | null;
}

export interface PreflightInput {
  launcherPath: string;
  platform?: string;
  requestedModel: AuthorizedModel;
  runtimeVersion: string;
  probe: (executable: Extract<ResolvedExecutable, { status: 'resolved' }>) => Promise<ProbeResult>;
  env?: Record<string, string | undefined>;
  allowApiBilling?: boolean;
}

export type PreflightResult =
  | {
      status: 'ready';
      executable: Extract<ResolvedExecutable, { status: 'resolved' }>;
      launch: { executablePath: string; runWith: 'node' | null; model: AuthorizedModel; effort: 'xhigh'; fallbackModel: null };
      observed: { cliVersion: string | null; advertisedFlags: string[] | null; authStatus: AuthStatusSummary | null };
      diagnosis: CompatibilityDiagnosis;
      auth: AuthAssessment;
      vendorCliUsed: false;
    }
  | { status: 'failed'; failureStage: 'cli-resolution' | 'cli-probe' | 'cli-compatibility' | 'auth-path'; code: string; message: string; launch: null; vendorCliUsed: false; diagnosis?: CompatibilityDiagnosis };

function summarize(error: unknown): string {
  const code = (error as { code?: string })?.code;
  if (code) return `código ${code}`;
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0]!.slice(0, 80);
}

export async function resolvePreflight(input: PreflightInput): Promise<PreflightResult> {
  const executable = await resolveClaudeExecutable({ launcherPath: input.launcherPath, ...(input.platform ? { platform: input.platform } : {}) });
  if (executable.status !== 'resolved') {
    return { status: 'failed', failureStage: 'cli-resolution', code: 'CLI_NOT_FOUND', message: `Executável do Claude Code não encontrado a partir de ${input.launcherPath}; inspecione a instalação. Nenhum CLI de terceiros é usado como substituto.`, launch: null, vendorCliUsed: false };
  }
  let probe: ProbeResult;
  try {
    probe = await input.probe(executable);
  } catch (error) {
    return { status: 'failed', failureStage: 'cli-probe', code: 'CLI_PROBE_FAILED', message: `A sondagem do Claude Code instalado falhou (${summarize(error)}); detalhes brutos suprimidos.`, launch: null, vendorCliUsed: false };
  }
  const diagnosis = diagnoseCliCompatibility({
    cliVersion: probe.cliVersion,
    runtimeVersion: input.runtimeVersion,
    advertisedFlags: probe.advertisedFlags,
    supportedModels: probe.supportedModels ?? null,
    requestedModel: input.requestedModel,
  });
  if (diagnosis.action !== 'proceed') {
    return { status: 'failed', failureStage: 'cli-compatibility', code: diagnosis.code ?? 'CLI_INCOMPATIBLE', message: diagnosis.message, launch: null, vendorCliUsed: false, diagnosis };
  }
  // The subprocess inherits the real environment, so the assessment sees it too.
  const auth = assessAuthPath({ env: input.env ?? process.env, authStatus: probe.authStatus, allowApiBilling: input.allowApiBilling ?? false });
  if (!auth.ok) {
    return { status: 'failed', failureStage: 'auth-path', code: auth.code, message: `${auth.message}${auth.evidence.length ? ` Evidência: ${auth.evidence.join('; ')}.` : ''}`, launch: null, vendorCliUsed: false, diagnosis };
  }
  return {
    status: 'ready',
    executable,
    launch: { executablePath: executable.executablePath, runWith: executable.runWith, model: input.requestedModel, effort: 'xhigh', fallbackModel: null },
    observed: { cliVersion: probe.cliVersion, advertisedFlags: probe.advertisedFlags, authStatus: probe.authStatus },
    diagnosis,
    auth,
    vendorCliUsed: false,
  };
}
