// Derives collaboration-room rows from durable events: public messages with
// authorship, tools with available results, decisions and system notices.
import type { EventRecord, QueueEntryView } from '../../src/shared/types.ts';

export type Row =
  | { kind: 'message'; key: string; gseq: number; ts: string; author: string; source: string; text: string; truncated: boolean; totalChars: number; state: QueueEntryView['state'] | null }
  | { kind: 'tool'; key: string; gseq: number; ts: string; name: string; toolUseId: string; inputPreview: string; result: null | { preview: string; isError: boolean; truncated: boolean; totalChars: number; pages: number; blobId: string | null; ts: string }; blocked: null | { reason: string; message: string; enforcedBy: string } }
  | { kind: 'decision'; key: string; gseq: number; ts: string; requestKind: 'permission' | 'question'; requestId: string; tool: string; reason: string; message: string; inputPreview: string; questions: Array<{ question: string; header?: string; options: Array<{ label: string; description?: string }>; multiSelect?: boolean }>; resolution: null | { decision: string; source: string; message: string | null; ts: string } }
  | { kind: 'system'; key: string; gseq: number; ts: string; tone: 'info' | 'warn' | 'error' | 'ok'; text: string };

export const SOURCE_LABELS: Record<string, string> = {
  browser: 'Navegador',
  'local-secret': 'Codex (terminal)',
  mcp: 'Codex (MCP)',
  system: 'Sistema',
  worker: 'Worker',
};

/** Public timestamps are always local time, identical in feed and inspector. */
export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? String(iso) : date.toLocaleTimeString('pt-BR');
}

function label(source: unknown): string {
  return SOURCE_LABELS[String(source)] ?? String(source ?? 'desconhecido');
}

function decisionLabel(decision: unknown, source: unknown): string {
  const who = source === 'browser' ? 'pelo navegador' : source === 'system' ? 'pelo sistema' : 'pelo Codex';
  if (decision === 'allow') return `Permitido ${who}`;
  if (decision === 'deny') return `Negado ${who}`;
  return `Respondido ${who}`;
}

export function buildRows(events: EventRecord[], queue: QueueEntryView[]): Row[] {
  const rows: Row[] = [];
  const tools = new Map<string, Extract<Row, { kind: 'tool' }>>();
  const decisions = new Map<string, Extract<Row, { kind: 'decision' }>>();
  const queueState = new Map(queue.map((entry) => [entry.messageId, entry.state]));
  for (const event of events) {
    const gseq = event.gseq ?? event.seq;
    const key = `${event.taskId}:${gseq}`;
    const data = event.data;
    switch (event.type) {
      case 'assistant_text':
        rows.push({ kind: 'message', key, gseq, ts: event.ts, author: `Claude · ${String(data.model ?? 'modelo não observado')}`, source: 'claude', text: String(data.text ?? ''), truncated: data.truncated === true, totalChars: Number(data.totalChars ?? String(data.text ?? '').length), state: null });
        break;
      // The annotation itself, as a system line. The guidance it produced shows
      // up as its own message_queued row, so the text is not duplicated here.
      case 'diff_annotated':
        rows.push({ kind: 'system', key, gseq, ts: event.ts, tone: 'info', text: `Anotação de revisão em ${String(data.file ?? '?')}${data.hunk ? ` (${String(data.hunk)})` : ''} por ${label(data.source)}` });
        break;
      case 'message_queued':
        rows.push({ kind: 'message', key, gseq, ts: event.ts, author: label(data.source), source: String(data.source ?? ''), text: String(data.textPreview ?? ''), truncated: false, totalChars: 0, state: queueState.get(String(data.messageId)) ?? 'queued' });
        break;
      case 'tool_start': {
        const row: Extract<Row, { kind: 'tool' }> = { kind: 'tool', key, gseq, ts: event.ts, name: String(data.name ?? '?'), toolUseId: event.toolUseId ?? key, inputPreview: String(data.inputPreview ?? ''), result: null, blocked: null };
        tools.set(row.toolUseId, row);
        rows.push(row);
        break;
      }
      case 'tool_result': {
        const row = event.toolUseId ? tools.get(event.toolUseId) : undefined;
        const result = { preview: String(data.preview ?? ''), isError: data.isError === true, truncated: data.truncated === true, totalChars: Number(data.totalChars ?? 0), pages: Number(data.pages ?? 1), blobId: typeof data.blobId === 'string' ? data.blobId : null, ts: event.ts };
        if (row) row.result = result;
        else rows.push({ kind: 'tool', key, gseq, ts: event.ts, name: String(data.name ?? '?'), toolUseId: event.toolUseId ?? key, inputPreview: '', result, blocked: null });
        break;
      }
      case 'tool_blocked': {
        const row = event.toolUseId ? tools.get(event.toolUseId) : undefined;
        const blocked = { reason: String(data.reason ?? ''), message: String(data.message ?? ''), enforcedBy: String(data.enforcedBy ?? '') };
        if (row) row.blocked = blocked;
        else rows.push({ kind: 'system', key, gseq, ts: event.ts, tone: 'warn', text: `Bloqueado: ${String(data.tool ?? '?')} — ${blocked.reason}. ${blocked.message}` });
        break;
      }
      case 'permission_requested':
      case 'question_asked': {
        const row: Extract<Row, { kind: 'decision' }> = {
          kind: 'decision', key, gseq, ts: event.ts,
          requestKind: event.type === 'question_asked' ? 'question' : 'permission',
          requestId: String(data.requestId ?? ''),
          tool: String(data.tool ?? 'AskUserQuestion'),
          reason: String(data.reason ?? (event.type === 'question_asked' ? 'QUESTION' : '')),
          message: String(data.message ?? data.summary ?? ''),
          inputPreview: String(data.inputPreview ?? ''),
          questions: Array.isArray(data.questions) ? (data.questions as Extract<Row, { kind: 'decision' }>['questions']) : [],
          resolution: null,
        };
        decisions.set(row.requestId, row);
        rows.push(row);
        break;
      }
      case 'permission_resolved':
      case 'question_answered': {
        const row = decisions.get(String(data.requestId ?? ''));
        const resolution = { decision: String(data.decision ?? 'answer'), source: String(data.source ?? ''), message: typeof data.message === 'string' ? data.message : null, ts: event.ts };
        if (row) row.resolution = resolution;
        rows.push({ kind: 'system', key, gseq, ts: event.ts, tone: resolution.decision === 'deny' ? 'warn' : 'ok', text: decisionLabel(resolution.decision, resolution.source) });
        break;
      }
      case 'turn_interrupted':
        rows.push({ kind: 'system', key, gseq, ts: event.ts, tone: 'warn', text: `Turno interrompido (${label(data.source)}).` });
        break;
      case 'session_end_requested':
        rows.push({ kind: 'system', key, gseq, ts: event.ts, tone: 'info', text: `Encerramento solicitado (${label(data.source)}).` });
        break;
      case 'run_started':
        rows.push({ kind: 'system', key, gseq, ts: event.ts, tone: 'info', text: `Execução iniciada: modelo solicitado ${String(data.requestedModel ?? '?')} (${String(data.modelReason ?? 'sem motivo')}), esforço ${String(data.effort ?? '?')}.` });
        break;
      case 'session_init':
        rows.push({ kind: 'system', key, gseq, ts: event.ts, tone: 'ok', text: `Sessão ${String(data.sessionId ?? '?')} conectada; modelo observado ${String(data.observedModel ?? '?')}.` });
        break;
      case 'preparation_failed':
        rows.push({ kind: 'system', key, gseq, ts: event.ts, tone: 'error', text: `Falha na preparação (${String(data.stage ?? '?')}, ${String(data.code ?? '?')}): ${String(data.message ?? '')}` });
        break;
      case 'run_ended':
        rows.push({ kind: 'system', key, gseq, ts: event.ts, tone: data.status === 'COMPLETED' ? 'ok' : 'error', text: `Execução encerrada: ${String(data.status ?? '?')}${data.code ? ` (${String(data.code)})` : ''}${data.message ? ` — ${String(data.message)}` : ''}. COMPLETED confirma apenas o transporte; a aceitação depende da revisão independente.` });
        break;
      case 'turn_failed':
        rows.push({ kind: 'system', key, gseq, ts: event.ts, tone: 'error', text: `Turno terminou com erro (${String(data.subtype ?? '?')}${data.terminalReason ? `, ${String(data.terminalReason)}` : ''}).` });
        break;
      case 'descendants_not_reconciled':
        rows.push({ kind: 'system', key, gseq, ts: event.ts, tone: 'error', text: String(data.note ?? 'Processos da execução sobreviveram; a trava do checkout ficou em quarentena.') });
        break;
      case 'review_acknowledged':
        rows.push({ kind: 'system', key, gseq, ts: event.ts, tone: 'ok', text: `Revisão confirmada por ${label(data.source)}.` });
        break;
      case 'alert':
        rows.push({ kind: 'system', key, gseq, ts: event.ts, tone: 'warn', text: `Alerta de supervisão: ${String(data.alert ?? '?')} (sem encerramento automático).` });
        break;
      case 'budget_exhausted':
        rows.push({ kind: 'system', key, gseq, ts: event.ts, tone: 'error', text: `Orçamento esgotado: ${budgetSummary(data)}. O turno em andamento termina; nenhum outro é entregue.` });
        break;
      case 'telemetry_write_failed':
        rows.push({ kind: 'system', key, gseq, ts: event.ts, tone: 'warn', text: `Falha de observabilidade ao gravar ${String(data.file ?? '?')} (${String(data.code ?? '?')}); a execução continua.` });
        break;
      case 'worker_disconnected':
        rows.push({ kind: 'system', key, gseq, ts: event.ts, tone: 'error', text: 'O worker desapareceu sem resultado; a execução ficou incerta e exige revisão.' });
        break;
      case 'broker_recovered':
        rows.push({ kind: 'system', key, gseq, ts: event.ts, tone: 'warn', text: 'O broker reiniciou com trabalho em andamento; revise antes de retomar. Mensagens na fila não foram reenviadas.' });
        break;
      case 'model_changed':
        rows.push({ kind: 'system', key, gseq, ts: event.ts, tone: 'info', text: `Modelo alterado de ${String(data.from ?? '?')} para ${String(data.to ?? '?')}: ${String(data.reason ?? '')}` });
        break;
      case 'quota_observed':
        rows.push({ kind: 'system', key, gseq, ts: event.ts, tone: 'info', text: data.snapshot ? `Capacidade observada às ${formatTime(data.observedAt as string)}: recomendação ${String(data.recommendation ?? '?')}.` : `Capacidade indisponível na consulta das ${formatTime(data.attemptedAt as string)}.` });
        break;
      case 'assistant_error':
        rows.push({ kind: 'system', key, gseq, ts: event.ts, tone: 'error', text: `Erro do modelo: ${String(data.code ?? '?')}` });
        break;
      case 'final_result_not_persisted':
        rows.push({ kind: 'system', key, gseq, ts: event.ts, tone: 'error', text: `Resultado final NÃO persistido: ${String(data.message ?? '')}` });
        break;
      default:
        break;
    }
  }
  return rows;
}

/** "tokens 54/40, turnos 2/5": only the dimensions the job actually limited. */
function budgetSummary(data: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [field, name] of [['tokens', 'tokens'], ['turns', 'turnos'], ['runtimeSeconds', 'segundos']] as const) {
    const dimension = data[field];
    if (dimension && typeof dimension === 'object') {
      const { used, limit } = dimension as { used?: unknown; limit?: unknown };
      if (typeof used === 'number' && typeof limit === 'number') parts.push(`${name} ${used}/${limit}`);
    }
  }
  return parts.length ? parts.join(', ') : 'limite atingido';
}
