// Derives the legacy compatibility files (status.json, resultado.json and
// acompanhamento.txt) from the durable event log. Text deltas are never
// counted twice: only completed assistant messages appear in the transcript.
import type { EventRecord, RunStatus } from '../shared/types.ts';

export const LEGACY_STATUS_KEYS = [
  'status', 'codexThreadId', 'startedAt', 'sessionId', 'result', 'exitCode', 'elapsedSeconds', 'toolCalls',
  'workspace', 'requestedModel', 'selectedModel', 'model', 'effort', 'mode', 'profile', 'coordination',
  'usage', 'usageCheckedAt', 'toolErrors', 'permissionDenials', 'lastActivityAt', 'runtimeSeconds',
  'resumeMode', 'allowedCommands', 'timeoutPolicy', 'timeoutReason', 'failureStage',
] as const;

export const SUPERVISED_TIMEOUT_POLICY = { mode: 'supervised', inactivityAlertSeconds: 1200, elapsedAlertSeconds: 7200, killTimers: false } as const;

export interface DerivedStatus extends Record<string, unknown> {
  status: RunStatus;
  codexThreadId: string | null;
  startedAt: string | null;
  sessionId: string | null;
  result: string | null;
  exitCode: number | null;
  elapsedSeconds: number;
  toolCalls: string[];
  workspace: string | null;
  requestedModel: string | null;
  selectedModel: string | null;
  model: string | null;
  effort: string | null;
  effortConfirmed: null;
  effortObservedByCli: string | null;
  mode: string | null;
  profile: string | null;
  coordination: unknown;
  usage: unknown;
  usageCheckedAt: string | null;
  toolErrors: number;
  permissionDenials: number;
  lastActivityAt: string | null;
  runtimeSeconds: number;
  resumeMode: string;
  allowedCommands: unknown[];
  timeoutPolicy: typeof SUPERVISED_TIMEOUT_POLICY;
  timeoutReason: null;
  failureStage: string | null;
  failureCode: string | null;
  contractVersion: number | null;
  runId: string | null;
  taskId: string | null;
  currentTool: string | null;
  requiresReview: boolean;
  telemetryFailures: number;
  turns: number;
  modelReason: string | null;
  endedAt: string | null;
  alerts: string[];
}

export interface DerivedFiles {
  status: DerivedStatus;
  result: DerivedStatus;
  acompanhamento: string;
}

function seconds(from: string | null, to: string | null): number {
  if (!from || !to) return 0;
  const delta = (Date.parse(to) - Date.parse(from)) / 1000;
  return Number.isFinite(delta) && delta > 0 ? Math.round(delta * 10) / 10 : 0;
}

export function deriveCompatibilityFiles(events: EventRecord[], options: { now?: string; processAlive?: boolean } = {}): DerivedFiles {
  const now = options.now ?? new Date().toISOString();
  const status: DerivedStatus = {
    status: 'STARTING',
    codexThreadId: null,
    startedAt: null,
    sessionId: null,
    result: null,
    exitCode: null,
    elapsedSeconds: 0,
    toolCalls: [],
    workspace: null,
    requestedModel: null,
    selectedModel: null,
    model: null,
    effort: null,
    effortConfirmed: null,
    effortObservedByCli: null,
    mode: null,
    profile: null,
    coordination: null,
    usage: null,
    usageCheckedAt: null,
    toolErrors: 0,
    permissionDenials: 0,
    lastActivityAt: null,
    runtimeSeconds: 0,
    resumeMode: 'new',
    allowedCommands: [],
    timeoutPolicy: SUPERVISED_TIMEOUT_POLICY,
    timeoutReason: null,
    failureStage: null,
    failureCode: null,
    contractVersion: null,
    runId: null,
    taskId: null,
    currentTool: null,
    requiresReview: false,
    telemetryFailures: 0,
    turns: 0,
    modelReason: null,
    endedAt: null,
    alerts: [],
  };
  const lines: string[] = [];
  const openTools = new Map<string, string>();
  let terminal = false;
  let runId: string | null = null;
  let sessionStartedAt: string | null = null;

  for (const event of events) {
    if (runId && event.runId !== runId && event.type === 'run_started') {
      // A newer run resets per-run counters; the latest run wins.
      break;
    }
    const data = event.data;
    status.lastActivityAt = event.ts;
    switch (event.type) {
      case 'run_started': {
        runId = event.runId;
        status.runId = event.runId;
        status.taskId = event.taskId;
        status.codexThreadId = event.threadId ?? null;
        status.startedAt = (data.startedAt as string) ?? event.ts;
        status.requestedModel = (data.requestedModel as string) ?? null;
        status.selectedModel = status.requestedModel;
        status.modelReason = (data.modelReason as string) ?? null;
        status.effort = (data.effort as string) ?? null;
        status.workspace = (data.workspace as string) ?? null;
        status.profile = (data.profile as string) ?? null;
        status.mode = (data.mode as string) ?? null;
        status.coordination = data.coordination ?? null;
        status.contractVersion = (data.contractVersion as number) ?? null;
        status.resumeMode = (data.resumeMode as string) ?? 'new';
        status.allowedCommands = Array.isArray(data.allowedCommands) ? (data.allowedCommands as unknown[]) : [];
        status.status = 'STARTING';
        lines.push('CODEORQUESTRA - ACOMPANHAMENTO AO VIVO');
        lines.push(`Tarefa Codex: ${status.codexThreadId ?? 'desconhecida'} | Execução: ${event.runId}`);
        lines.push(`Modelo solicitado: ${status.requestedModel ?? '?'} | Esforço configurado: ${status.effort ?? '?'} (confirmação de servidor: não disponível)`);
        break;
      }
      case 'session_init': {
        status.sessionId = (data.sessionId as string) ?? status.sessionId;
        status.model = (data.observedModel as string) ?? null;
        status.effortObservedByCli = (data.effortObservedByCli as string | null) ?? null;
        status.status = 'RUNNING';
        sessionStartedAt = event.ts;
        lines.push(`[Conectado] Modelo observado: ${status.model ?? '?'} | Sessão: ${status.sessionId ?? '?'}`);
        break;
      }
      case 'quota_observed': {
        status.usage = data.snapshot ?? null;
        status.usageCheckedAt = (data.attemptedAt as string) ?? event.ts;
        lines.push(`[Uso] Consulta: ${status.usageCheckedAt} | ${data.snapshot ? `recomendação ${String(data.recommendation)}` : 'INDISPONIVEL'}`);
        break;
      }
      case 'turn_started': {
        status.turns += 1;
        break;
      }
      case 'assistant_text': {
        lines.push(String(data.text ?? ''));
        break;
      }
      case 'tool_start': {
        const name = String(data.name ?? '?');
        status.toolCalls.push(name);
        status.currentTool = name;
        if (event.toolUseId) openTools.set(event.toolUseId, name);
        lines.push(`[Ferramenta] ${name}`);
        break;
      }
      case 'tool_result': {
        if (data.isError) {
          status.toolErrors += 1;
          lines.push('[Ferramenta] Falha reportada; conferir resultado antes de aprovar.');
        }
        if (event.toolUseId) openTools.delete(event.toolUseId);
        status.currentTool = openTools.size ? [...openTools.values()].at(-1) ?? null : null;
        break;
      }
      case 'tool_blocked': {
        status.permissionDenials += 1;
        lines.push(`[Bloqueado] ${String(data.tool ?? '?')}: ${String(data.reason ?? '')}`);
        break;
      }
      case 'permission_requested': {
        lines.push(`[Permissão] ${String(data.tool ?? '?')} aguarda decisão (${String(data.reason ?? '')}).`);
        break;
      }
      case 'permission_resolved': {
        if (data.decision === 'deny') status.permissionDenials += 1;
        lines.push(`[Permissão] ${String(data.decision ?? '?')} por ${String(data.source ?? '?')}.`);
        break;
      }
      case 'question_asked': {
        lines.push(`[Pergunta] ${String(data.summary ?? '')}`);
        break;
      }
      case 'question_answered': {
        lines.push(`[Pergunta] respondida por ${String(data.source ?? '?')}.`);
        break;
      }
      case 'message_queued': {
        lines.push(`[Fila] Orientação ${String(data.messageId ?? '')} recebida de ${String(data.source ?? '?')}.`);
        break;
      }
      case 'message_delivered': {
        lines.push(`[Fila] Orientação ${String(data.messageId ?? '')} entregue ao próximo turno.`);
        break;
      }
      case 'turn_completed': {
        status.result = (data.resultText as string) ?? status.result;
        status.currentTool = null;
        break;
      }
      case 'turn_interrupted': {
        lines.push(`[Interrompido] Turno interrompido por ${String(data.source ?? '?')}.`);
        status.currentTool = null;
        break;
      }
      case 'alert': {
        const alert = String(data.alert ?? '');
        if (!status.alerts.includes(alert)) status.alerts.push(alert);
        lines.push(`[Alerta] ${alert}: apenas alerta, sem encerramento automático.`);
        break;
      }
      case 'telemetry_write_failed': {
        status.telemetryFailures += 1;
        lines.push(`[Telemetria] Falha ao gravar ${String(data.file ?? '?')} (${String(data.code ?? '?')}); a execução continua.`);
        break;
      }
      case 'model_changed': {
        status.requestedModel = (data.to as string) ?? status.requestedModel;
        status.selectedModel = status.requestedModel;
        status.modelReason = (data.reason as string) ?? status.modelReason;
        lines.push(`[Modelo] ${String(data.from ?? '?')} -> ${String(data.to ?? '?')} (${String(data.reason ?? '')})`);
        break;
      }
      case 'preparation_failed': {
        status.status = 'FAIL';
        status.failureStage = (data.stage as string) ?? null;
        status.failureCode = (data.code as string) ?? null;
        status.result = (data.message as string) ?? 'Falha na preparação.';
        status.endedAt = event.ts;
        terminal = true;
        lines.push(`[FAIL] Etapa: ${status.failureStage ?? '?'} (${status.failureCode ?? '?'}). ${status.result}`);
        break;
      }
      case 'worker_disconnected': {
        status.status = 'UNCERTAIN';
        status.requiresReview = true;
        lines.push('[Incerto] O worker desapareceu sem resultado; revise antes de retomar.');
        break;
      }
      case 'run_ended': {
        status.status = (data.status as RunStatus) ?? 'COMPLETED';
        status.exitCode = (data.exitCode as number | null) ?? null;
        status.endedAt = (data.endedAt as string) ?? event.ts;
        status.failureCode = (data.code as string) ?? status.failureCode;
        if (typeof data.message === 'string' && data.message) status.result = status.result ?? data.message;
        terminal = true;
        lines.push(`[Encerrado] ${status.status}`);
        break;
      }
      default:
        break;
    }
  }

  if (!terminal && status.startedAt) {
    if (options.processAlive === false) {
      status.status = 'UNCERTAIN';
      status.requiresReview = true;
    }
  }
  const end = status.endedAt ?? now;
  status.elapsedSeconds = seconds(status.startedAt, end);
  status.runtimeSeconds = seconds(sessionStartedAt, end);
  if (terminal || status.status === 'UNCERTAIN') {
    lines.push('COMPLETED confirma o fim da execução; a aprovação depende da revisão independente dos artefatos.');
  }
  const result = { ...status };
  return { status, result, acompanhamento: `${lines.join('\n')}\n` };
}
