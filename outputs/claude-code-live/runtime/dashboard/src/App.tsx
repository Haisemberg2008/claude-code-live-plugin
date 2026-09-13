// Task collaboration room: tasks on the left, the public conversation, tool
// and decision feed in the middle with a queue composer, and the inspector on
// the right. Everything rendered comes from durable events or the task view;
// text is rendered as escaped React content only.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EventRecord, PendingRequestView, StatusResponse, TaskView, TransientFrame } from '../../src/shared/types.ts';
import { ApiError, getBlobPage, getEvents, getEventsBefore, getStatus, postAction, subscribe, type ConnectionState } from './api.ts';
import { buildRows, formatTime, SOURCE_LABELS, type Row } from './feed.ts';

const PAGE_ROWS = 80;
const DISPLAY_LIMIT = 4096;
const MAX_EVENTS_PER_TASK = 5000;

const STATE_LABELS: Record<string, string> = {
  starting: 'Preparando',
  busy_model: 'Gerando resposta',
  busy_tool: 'Executando ferramenta',
  waiting_permission: 'Aguardando permissão',
  waiting_question: 'Aguardando resposta à pergunta',
  idle: 'Ociosa (aguardando próximo turno)',
  terminal: 'Encerrada',
  disconnected: 'Desconectada',
  uncertain: 'Incerta (revisão necessária)',
};

const TERMINAL_STATUSES = new Set(['COMPLETED', 'FAIL', 'BLOCKED', 'CANCELLED', 'UNCERTAIN', 'TIMEOUT']);

/** Outcome of a finished run. The row already says the session ended, so the
 *  badge carries the outcome instead of repeating the same word. */
const OUTCOME_LABELS: Record<string, string> = {
  COMPLETED: 'Concluída',
  CANCELLED: 'Cancelada',
  FAIL: 'Falhou',
  BLOCKED: 'Bloqueada',
  UNCERTAIN: 'Incerta',
  TIMEOUT: 'Tempo esgotado',
};

function formatElapsed(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function formatCount(value: number | null): string {
  return value === null ? '—' : new Intl.NumberFormat('pt-BR').format(value);
}

function qualityLabel(value: string): string {
  return value === 'reported' ? 'reportado' : value === 'estimated' ? 'estimado' : value === 'partial' ? 'parcial' : 'indisponível';
}

function formatReset(value: number | null): string {
  return value === null ? '—' : new Date(value * 1000).toLocaleString('pt-BR');
}

function isActive(task: TaskView): boolean {
  return Boolean(task.currentRun && !TERMINAL_STATUSES.has(task.currentRun.status));
}

/** Shortens an identifier for display while keeping the full value available. */
function abbreviate(value: string | null, keep = 10): string {
  if (!value) return '—';
  return value.length <= keep * 2 + 1 ? value : `${value.slice(0, keep)}…${value.slice(-keep)}`;
}

export function App() {
  const [tasks, setTasks] = useState<Map<string, TaskView>>(new Map());
  const [events, setEvents] = useState<Map<string, EventRecord[]>>(new Map());
  const [transient, setTransient] = useState<Map<string, Map<string, string>>>(new Map());
  const [selected, setSelected] = useState<string | null>(null);
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [identity, setIdentity] = useState<StatusResponse['identity'] | null>(null);
  const [broker, setBroker] = useState<StatusResponse['broker'] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [historyGap, setHistoryGap] = useState(false);
  const [drawer, setDrawer] = useState<'tasks' | 'inspector' | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const cursorRef = useRef(0);
  const epochRef = useRef<string | null>(null);

  // Elapsed time and coordinator presence must keep moving during silence.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const appendEvent = useCallback((event: EventRecord) => {
    setEvents((previous) => {
      const list = previous.get(event.taskId) ?? [];
      const key = event.gseq ?? event.seq;
      if (list.some((existing) => (existing.gseq ?? existing.seq) === key)) return previous;
      const next = new Map(previous);
      const merged = [...list, event];
      next.set(event.taskId, merged.length > MAX_EVENTS_PER_TASK ? merged.slice(merged.length - MAX_EVENTS_PER_TASK) : merged);
      return next;
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    getStatus().then((status) => {
      if (cancelled) return;
      setIdentity(status.identity);
      setBroker(status.broker);
      epochRef.current = status.cursorEpoch;
      setTasks(new Map(status.tasks.map((task) => [task.taskId, task])));
    }).catch((error: unknown) => setLoadError(error instanceof ApiError ? error.code : 'Falha ao carregar o estado.'));
    const stop = subscribe({
      onState: setConnection,
      onReady: (info) => {
        if (epochRef.current && info.epoch !== epochRef.current) {
          // The broker restarted: previous sequence numbers are meaningless.
          setEvents(new Map());
          cursorRef.current = 0;
          setHistoryGap(true);
        }
        epochRef.current = info.epoch;
      },
      onReset: () => {
        setEvents(new Map());
        cursorRef.current = 0;
        setHistoryGap(true);
      },
      onTask: (task) => setTasks((previous) => new Map(previous).set(task.taskId, task)),
      onEvent: (event) => {
        const gseq = event.gseq ?? 0;
        if (gseq > cursorRef.current) cursorRef.current = gseq;
        appendEvent(event);
        if (event.type === 'assistant_text' || event.type === 'turn_completed' || event.type === 'turn_interrupted' || event.type === 'turn_failed') {
          setTransient((previous) => {
            if (!previous.has(event.taskId)) return previous;
            const next = new Map(previous);
            next.delete(event.taskId);
            return next;
          });
        }
      },
      onTransient: (frame: TransientFrame) => setTransient((previous) => {
        const next = new Map(previous);
        const blocks = new Map(next.get(frame.taskId) ?? []);
        blocks.set(frame.blockId, frame.text);
        next.set(frame.taskId, blocks);
        return next;
      }),
    }, () => cursorRef.current, () => epochRef.current);
    return () => { cancelled = true; stop(); };
  }, [appendEvent]);

  const loadHistory = useCallback(async (taskId: string) => {
    try {
      const page = await getEvents(taskId, 0, 2000);
      setEvents((previous) => {
        const next = new Map(previous);
        const seen = new Set<number>();
        const merged: EventRecord[] = [];
        for (const event of [...page.events, ...(previous.get(taskId) ?? [])]) {
          const key = event.gseq ?? event.seq;
          if (seen.has(key)) continue;
          seen.add(key);
          merged.push(event);
        }
        merged.sort((a, b) => (a.gseq ?? a.seq) - (b.gseq ?? b.seq));
        next.set(taskId, merged);
        return next;
      });
      setHistoryGap(page.gapped);
    } catch (error) {
      setLoadError(error instanceof ApiError ? error.code : 'Falha ao carregar o histórico.');
    }
  }, []);

  /**
   * Walks backwards through history the panel never received. "Load older" is
   * a real fetch, not a reveal of rows already in memory, so a log longer than
   * one page stays reachable instead of being erased from the view.
   */
  const loadOlder = useCallback(async (taskId: string) => {
    const known = events.get(taskId) ?? [];
    const oldest = known.reduce<number | null>((lowest, event) => (lowest === null || event.seq < lowest ? event.seq : lowest), null);
    if (oldest === null || oldest <= 1) return;
    try {
      const page = await getEventsBefore(taskId, oldest);
      if (page.events.length === 0) return;
      setEvents((previous) => {
        const next = new Map(previous);
        const seen = new Set<number>();
        const merged: EventRecord[] = [];
        for (const event of [...page.events, ...(previous.get(taskId) ?? [])]) {
          const key = event.gseq ?? event.seq;
          if (seen.has(key)) continue;
          seen.add(key);
          merged.push(event);
        }
        merged.sort((a, b) => (a.gseq ?? a.seq) - (b.gseq ?? b.seq));
        next.set(taskId, merged);
        return next;
      });
      setHistoryGap(false);
    } catch (error) {
      setLoadError(error instanceof ApiError ? error.code : 'Falha ao carregar o histórico anterior.');
    }
  }, [events]);

  const ordered = useMemo(() => [...tasks.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [tasks]);
  const active = ordered.filter(isActive);
  const history = ordered.filter((task) => !isActive(task));
  const task = selected ? tasks.get(selected) ?? null : null;

  const select = useCallback((taskId: string) => {
    setSelected(taskId);
    setDrawer(null);
    void loadHistory(taskId);
  }, [loadHistory]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">CO</span>
          <div>
            <div className="brand-name">CodeOrquestra</div>
            <div className="brand-tagline">Codex com Opus e Fable</div>
          </div>
        </div>
        <div className="topbar-status">
          <span className={`conn conn-${connection}`}>{connection === 'open' ? 'conectado' : connection === 'unauthorized' ? 'sessão expirada' : connection === 'reconnecting' ? 'reconectando…' : 'conectando…'}</span>
          {identity?.taskScope ? <span className="scope">painel limitado a uma tarefa</span> : null}
          {broker ? <span className="muted">broker {broker.version}{broker.simulatedAdapter ? ' · adaptador simulado' : ''}</span> : null}
          <button type="button" className="ghost mobile-only" onClick={() => setDrawer(drawer === 'tasks' ? null : 'tasks')}>Tarefas</button>
          <button type="button" className="ghost mobile-only" onClick={() => setDrawer(drawer === 'inspector' ? null : 'inspector')}>Inspetor</button>
        </div>
      </header>
      <div className="disclaimer">Integração local independente que apenas controla o Claude Code já instalado; não é produto oficial nem parceria entre OpenAI e Anthropic. Todo o conteúdo exibido é texto público derivado de eventos reais; raciocínio interno nunca é exibido.</div>
      {connection === 'unauthorized' ? <div className="banner error" role="alert">A sessão do painel expirou. Gere um novo link com <code>codeorquestra dashboard</code> e abra-o novamente.</div> : null}
      {historyGap ? <div className="banner warn" role="status">O histórico exibido foi reiniciado: o broker não pôde cobrir o cursor anterior. Use “Carregar histórico” para buscar o que está disponível.</div> : null}
      {loadError ? <div className="banner error">Erro ao carregar: {loadError}</div> : null}
      <div className="layout">
        <nav className={`sidebar ${drawer === 'tasks' ? 'open' : ''}`} aria-label="Tarefas">
          <TaskList title="Ativas" tasks={active} selected={selected} onSelect={select} />
          <TaskList title="Histórico" tasks={history} selected={selected} onSelect={select} />
          {ordered.length === 0 ? <p className="empty">Nenhuma tarefa ativa. Registre uma tarefa no terminal do Codex e inicie uma execução.</p> : null}
        </nav>
        <main className="room">
          {/* A task-scoped panel never sees the fleet: the toggle itself is
              hidden, not just the data, so the surface matches the scope. */}
          {!identity?.taskScope && active.length > 1 && !task ? (
            <FleetBoard tasks={active} now={now} onSelect={select} />
          ) : task ? (
            <Room
              key={task.taskId}
              task={task}
              events={events.get(task.taskId) ?? []}
              transient={transient.get(task.taskId) ?? null}
              now={now}
              onLoadHistory={() => void loadHistory(task.taskId)}
              onLoadOlder={() => void loadOlder(task.taskId)}
            />
          ) : (
            <div className="empty-room">
              <h1>{ordered.length === 0 ? 'Nenhuma tarefa ativa' : 'Selecione uma tarefa'}</h1>
              <p className="muted">O painel mostra a conversa pública, as ferramentas e as decisões pendentes de cada tarefa Codex.</p>
            </div>
          )}
        </main>
        <aside className={`inspector ${drawer === 'inspector' ? 'open' : ''}`} aria-label="Inspetor">
          {task ? <Inspector task={task} now={now} /> : <p className="empty">Sem tarefa selecionada.</p>}
        </aside>
      </div>
    </div>
  );
}

/** The badges a task carries, in one place so the list and the board agree. */
function TaskBadges({ task }: { task: TaskView }) {
  return (
    <span className="task-meta">
      <span className={`state state-${task.state}`}>{STATE_LABELS[task.state] ?? task.state}</span>
      {task.simulated ? <span className="badge">Simulado</span> : null}
      {task.currentRun && TERMINAL_STATUSES.has(task.currentRun.status)
        ? <span className={`badge ${task.currentRun.status === 'COMPLETED' ? 'ok' : task.currentRun.status === 'CANCELLED' ? '' : 'error'}`} data-testid="run-outcome">{OUTCOME_LABELS[task.currentRun.status] ?? task.currentRun.status}</span>
        : null}
      {task.pendingRequests.length ? <span className="badge warn">{task.pendingRequests.length} decisão(ões)</span> : null}
      {task.requiresReview ? <span className="badge error">revisão</span> : null}
    </span>
  );
}

function TaskList({ title, tasks, selected, onSelect }: { title: string; tasks: TaskView[]; selected: string | null; onSelect: (id: string) => void }) {
  return (
    <section className="task-section">
      <h2 className="section-title">{title} <span className="count">{tasks.length}</span></h2>
      <ul className="task-list">
        {tasks.map((task) => (
          <li key={task.taskId}>
            <button type="button" data-testid="task-item" className={`task-item ${task.taskId === selected ? 'selected' : ''}`} onClick={() => onSelect(task.taskId)} aria-pressed={task.taskId === selected}>
              <span className="task-thread" title={task.threadId}>{task.threadId}</span>
              <TaskBadges task={task} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Every active task at once, for when several are running in parallel.
 *
 * Shows what a coordinator has to decide between: who is blocked on a decision,
 * who is writing where, and which branch each one is on.
 */
function FleetBoard({ tasks, now, onSelect }: { tasks: TaskView[]; now: number; onSelect: (id: string) => void }) {
  return (
    <div className="fleet" data-testid="fleet-board">
      <h1 className="fleet-title">Frota <span className="count">{tasks.length}</span></h1>
      <p className="muted">Cada tarefa Codex trabalha na própria árvore. Clique para abrir a conversa completa.</p>
      <div className="fleet-grid">
        {tasks.map((task) => {
          const run = task.currentRun;
          const elapsed = run ? Math.max(0, Math.round(((run.endedAt ? Date.parse(run.endedAt) : now) - Date.parse(run.startedAt)) / 1000)) : 0;
          return (
            <button key={task.taskId} type="button" className={`fleet-card ${task.pendingRequests.length ? 'needs-decision' : ''}`} data-testid="fleet-card" onClick={() => onSelect(task.taskId)}>
              <span className="fleet-thread" title={task.threadId}>{task.threadId}</span>
              <TaskBadges task={task} />
              <dl className="fleet-facts">
                <dt>Árvore</dt>
                <dd className="mono wrap">{task.worktree ? task.worktree.branch : 'checkout declarado'}</dd>
                <dt>Ferramenta</dt>
                <dd>{run?.currentTool ?? 'nenhuma'}</dd>
                <dt>Arquivos</dt>
                <dd>{task.changedFiles.claudeAuthored.length} do Claude · {task.changedFiles.observed.length} observados</dd>
                <dt>Tempo</dt>
                <dd>{run ? formatElapsed(elapsed) : '—'}</dd>
              </dl>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Room({ task, events, transient, now, onLoadHistory, onLoadOlder }: { task: TaskView; events: EventRecord[]; transient: Map<string, string> | null; now: number; onLoadHistory: () => void; onLoadOlder: () => void }) {
  const rows = useMemo(() => buildRows(events, task.queue), [events, task.queue]);
  const [visible, setVisible] = useState(PAGE_ROWS);
  const [composer, setComposer] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  // Confirmation is bound to the exact task and run it was opened for.
  const [confirmEnd, setConfirmEnd] = useState<{ taskId: string; runId: string | null } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = feedRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [rows.length, transient]);

  const run = task.currentRun;
  const canAct = Boolean(run && !TERMINAL_STATUSES.has(run.status)) && task.state !== 'uncertain' && task.state !== 'disconnected';
  const act = useCallback(async (name: string, action: string, body: Record<string, unknown>) => {
    setBusy(name);
    setActionError(null);
    try {
      await postAction(task.taskId, action, body);
      return true;
    } catch (error) {
      setActionError(error instanceof ApiError ? `${action}: ${error.code}` : String(error));
      return false;
    } finally {
      setBusy(null);
    }
  }, [task.taskId]);

  const shown = rows.slice(Math.max(0, rows.length - visible));
  const hidden = rows.length - shown.length;
  // Once every locally known row is on screen, older history still lives in the
  // broker; the button then fetches instead of revealing.
  const oldestSeq = events.reduce((lowest, event) => (event.seq < lowest ? event.seq : lowest), Number.MAX_SAFE_INTEGER);

  return (
    <div className="room-inner">
      <div className="room-header">
        <h1 className="room-title" title={task.threadId}>{task.threadId}</h1>
        <div className="room-sub">
          <span className={`state state-${task.state}`}>{STATE_LABELS[task.state] ?? task.state}</span>
          {task.coordinatorPresence === 'absent' ? <span className="badge warn">{task.coordinatorLabel ?? 'aguardando coordenador'}</span> : <span className="badge ok">coordenador presente</span>}
          {task.alerts.map((alert) => <span key={alert} className="badge warn">alerta: {alert}</span>)}
          {run?.currentTool ? <span className="badge">ferramenta: {run.currentTool}</span> : null}
        </div>
      </div>
      <div className="feed" ref={feedRef}>
        <div className="feed-top">
          <button type="button" className="ghost small" onClick={onLoadHistory}>Carregar histórico</button>
          {hidden > 0
            ? <button type="button" className="ghost small" onClick={() => setVisible((v) => v + PAGE_ROWS)}>Carregar anteriores ({hidden} ocultas)</button>
            : oldestSeq > 1
              ? <button type="button" className="ghost small" data-testid="fetch-older" onClick={onLoadOlder}>Carregar anteriores (buscar no broker)</button>
              : null}
        </div>
        {shown.map((row) => <RowView key={row.key} row={row} task={task} onAnswer={(body) => act('answer', 'answer', body)} />)}
        {transient && transient.size ? [...transient.entries()].map(([blockId, text]) => (
          <article key={`live-${blockId}`} className="row message live source-claude" data-testid="live-progress" data-actor="claude" data-event-role="response">
            <div className="row-head"><span className="origin-label origin-claude">Resposta do Claude</span><span className="author">Claude (em andamento)</span><span className="muted">texto parcial, redigido por segurança</span></div>
            <pre className="text">{text}</pre>
          </article>
        )) : null}
      </div>
      {actionError ? <div className="banner error" role="alert">Ação recusada: {actionError}</div> : null}
      <form className="composer" onSubmit={async (event) => {
        event.preventDefault();
        if (!composer.trim()) return;
        const ok = await act('message', 'message', { text: composer });
        if (ok) setComposer('');
      }}>
        <label className="composer-label" htmlFor="composer-text">Orientação para o próximo turno</label>
        <textarea id="composer-text" aria-label="Orientação para o próximo turno" value={composer} onChange={(event) => setComposer(event.target.value)} rows={3} placeholder="A orientação entra na fila e é entregue quando o turno atual terminar. Só a interrupção aborta um turno." disabled={!canAct} />
        <div className="composer-actions">
          <button type="submit" className="primary" disabled={!canAct || busy !== null || !composer.trim()}>Enfileirar orientação</button>
          <button type="button" className="ghost" disabled={!canAct || busy !== null} onClick={() => void act('interrupt', 'interrupt', {})}>Interromper turno</button>
          <button type="button" className="danger" disabled={!canAct || busy !== null} onClick={() => setConfirmEnd({ taskId: task.taskId, runId: run?.runId ?? null })}>Encerrar sessão</button>
        </div>
      </form>
      {confirmEnd && confirmEnd.taskId === task.taskId ? (
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="end-title">
            <h2 id="end-title">Encerrar a sessão desta tarefa?</h2>
            <p>Tarefa <strong>{task.threadId}</strong>. O encerramento será solicitado ao worker e à árvore ainda atribuível. Processos órfãos em segundo plano não são uma garantia do sistema operacional; em caso incerto, o checkout fica em quarentena. O log e os arquivos alterados permanecem.</p>
            <div className="composer-actions">
              <button
                type="button"
                className="danger"
                onClick={async () => {
                  const target = confirmEnd;
                  setConfirmEnd(null);
                  if (!target || target.taskId !== task.taskId || target.runId !== (run?.runId ?? null)) {
                    setActionError('A confirmação não corresponde mais à execução selecionada; nada foi encerrado.');
                    return;
                  }
                  await act('end', 'end', {});
                }}
              >Confirmar encerramento</button>
              <button type="button" className="ghost" onClick={() => setConfirmEnd(null)}>Cancelar</button>
            </div>
          </div>
        </div>
      ) : null}
      <span className="sr-only" aria-live="polite">{`Atualizado às ${formatTime(new Date(now).toISOString())}`}</span>
    </div>
  );
}

function RowView({ row, task, onAnswer }: { row: Row; task: TaskView; onAnswer: (body: Record<string, unknown>) => Promise<boolean> }) {
  if (row.kind === 'message') return <MessageRow row={row} />;
  if (row.kind === 'tool') return <ToolRow row={row} taskId={task.taskId} />;
  if (row.kind === 'decision') return <DecisionRow row={row} task={task} onAnswer={onAnswer} />;
  return (
    <article className={`row system tone-${row.tone}`} data-testid="system-row">
      <span className="time">{formatTime(row.ts)}</span>
      <span className="text">{row.text}</span>
    </article>
  );
}

function MessageRow({ row }: { row: Extract<Row, { kind: 'message' }> }) {
  const [full, setFull] = useState(false);
  const tooLong = row.text.length > DISPLAY_LIMIT;
  const text = full || !tooLong ? row.text : row.text.slice(0, DISPLAY_LIMIT);
  const actor = row.source === 'claude' ? 'claude' : 'codex';
  const eventRole = actor === 'claude' ? 'response' : 'instruction';
  return (
    <article className={`row message source-${row.source} actor-${actor}`} data-testid="message-row" data-actor={actor} data-event-role={eventRole}>
      <div className="row-head">
        <span className={`origin-label origin-${actor}`}>{actor === 'claude' ? 'Resposta do Claude' : 'Orientação do Codex'}</span>
        <span className="author">{row.author}</span>
        <span className="time">{formatTime(row.ts)}</span>
        {row.state ? <span className={`badge ${row.state === 'queued' ? 'warn' : row.state === 'requires_review' ? 'error' : ''}`}>{row.state === 'queued' ? 'Na fila' : row.state === 'delivered' ? 'Entregue' : 'Requer revisão'}</span> : null}
      </div>
      <pre className="text">{text}</pre>
      {tooLong || row.truncated ? (
        <div className="truncation">
          <span>Saída truncada para visualização{row.truncated ? ` (${row.totalChars} caracteres no total)` : ''}.</span>
          {tooLong ? <button type="button" className="ghost small" onClick={() => setFull((v) => !v)}>{full ? 'Mostrar menos' : 'Mostrar completo'}</button> : null}
        </div>
      ) : null}
    </article>
  );
}

function ToolRow({ row, taskId }: { row: Extract<Row, { kind: 'tool' }>; taskId: string }) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<{ page: number; pages: number; text: string } | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const loadPage = async (number: number) => {
    if (!row.result?.blobId) return;
    try {
      const data = await getBlobPage(taskId, row.result.blobId, number);
      setPage({ page: data.page, pages: data.pages, text: data.text });
      setPageError(null);
    } catch (error) {
      setPageError(error instanceof ApiError ? error.code : 'falha ao carregar');
    }
  };
  const status = row.blocked ? 'bloqueada' : row.result ? (row.result.isError ? 'erro' : 'concluída') : 'em execução';
  return (
    <article className={`row tool ${row.blocked ? 'blocked' : row.result?.isError ? 'error' : ''}`} data-testid="tool-row" data-actor="claude" data-event-role="command">
      <div className="row-head">
        <span className="origin-label origin-tool">Comando do Claude</span>
        <span className="author">Ferramenta {row.name}</span>
        <span className={`badge ${status === 'erro' || status === 'bloqueada' ? 'warn' : status === 'concluída' ? 'ok' : ''}`}>{status}</span>
        <span className="time">{formatTime(row.ts)}{row.result ? ` → ${formatTime(row.result.ts)}` : ''}</span>
        <button type="button" className="ghost small" aria-expanded={open} onClick={() => setOpen((v) => !v)}>{open ? 'Ocultar detalhes' : 'Detalhes'}</button>
      </div>
      {row.blocked ? <p className="text">Bloqueada por {row.blocked.enforcedBy}: {row.blocked.reason}. {row.blocked.message}</p> : null}
      {open ? (
        <div className="tool-details">
          <h3>Entrada (prévia segura)</h3>
          <pre className="text">{row.inputPreview || '(sem entrada)'}</pre>
          <h3>Resultado {row.result ? (row.result.isError ? '(erro)' : '') : '(ainda indisponível)'}</h3>
          {row.result ? <pre className="text">{row.result.preview}</pre> : null}
          {row.result?.truncated ? (
            <div className="truncation">
              <span>Saída truncada para visualização ({row.result.totalChars} caracteres, {row.result.pages} páginas).</span>
              {row.result.blobId ? <button type="button" className="ghost small" onClick={() => void loadPage(page ? Math.min(page.pages, page.page + 1) : 1)}>{page ? `Próxima página (${page.page}/${page.pages})` : 'Ver páginas'}</button> : null}
              {page ? <pre className="text">{page.text}</pre> : null}
              {pageError ? <span className="muted">{pageError}</span> : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function DecisionRow({ row, task, onAnswer }: { row: Extract<Row, { kind: 'decision' }>; task: TaskView; onAnswer: (body: Record<string, unknown>) => Promise<boolean> }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const pending: PendingRequestView | undefined = task.pendingRequests.find((request) => request.requestId === row.requestId);
  const runId = pending?.runId ?? task.currentRun?.runId ?? '';
  const resolved = row.resolution;
  return (
    <article className={`row decision ${resolved ? 'resolved' : 'pending'}`} data-testid={row.requestKind === 'question' ? 'question-request' : 'permission-request'}>
      <div className="row-head">
        <span className="author">{row.requestKind === 'question' ? 'Pergunta do Claude' : `Permissão: ${row.tool}`}</span>
        <span className="badge warn">{row.reason}</span>
        <span className="time">{formatTime(row.ts)}</span>
      </div>
      <p className="text">{row.message}</p>
      {row.inputPreview ? <pre className="text small">{row.inputPreview}</pre> : null}
      {row.requestKind === 'question' ? row.questions.map((question) => (
        <fieldset key={question.question} className="question">
          <legend>{question.header ? `${question.header}: ` : ''}{question.question}</legend>
          {question.options.map((option) => (
            <label key={option.label} className="option">
              <input type="radio" name={`${row.requestId}:${question.question}`} value={option.label} checked={answers[question.question] === option.label} onChange={() => setAnswers((previous) => ({ ...previous, [question.question]: option.label }))} disabled={Boolean(resolved) || !pending} />
              <span>{option.label}</span>{option.description ? <span className="muted"> — {option.description}</span> : null}
            </label>
          ))}
        </fieldset>
      )) : null}
      {resolved ? <p className="muted">Decisão: {resolved.decision === 'deny' ? 'negada' : resolved.decision === 'allow' ? 'permitida' : 'respondida'} por {SOURCE_LABELS[resolved.source] ?? resolved.source} às {formatTime(resolved.ts)}{resolved.message ? ` — ${resolved.message}` : ''}</p> : pending ? (
        <div className="decision-actions">
          {row.requestKind === 'question' ? (
            <button type="button" className="primary" disabled={row.questions.some((question) => !answers[question.question])} onClick={() => void onAnswer({ requestId: row.requestId, runId, decision: 'answer', answers })}>Enviar resposta</button>
          ) : (
            <>
              <input type="text" className="note" value={note} onChange={(event) => setNote(event.target.value)} placeholder="Motivo (opcional)" aria-label="Motivo da decisão" />
              <button type="button" className="primary" onClick={() => void onAnswer({ requestId: row.requestId, runId, decision: 'allow', message: note || undefined })}>Permitir</button>
              <button type="button" className="danger" onClick={() => void onAnswer({ requestId: row.requestId, runId, decision: 'deny', message: note || 'Negado pelo navegador.' })}>Negar</button>
            </>
          )}
        </div>
      ) : <p className="muted">Pedido não está mais pendente nesta execução.</p>}
    </article>
  );
}

function Inspector({ task, now }: { task: TaskView; now: number }) {
  const run = task.currentRun;
  const quota = task.quota;
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const liveElapsed = run ? Math.max(0, Math.round(((run.endedAt ? Date.parse(run.endedAt) : now) - Date.parse(run.startedAt)) / 1000)) : 0;
  const presenceAge = task.coordinatorLastSeenAt ? Math.round((now - Date.parse(task.coordinatorLastSeenAt)) / 1000) : null;
  return (
    <div className="inspector-inner">
      <h2 className="section-title">Tarefa</h2>
      <dl>
        <dt>Identificador</dt><dd className="mono" title={task.taskId}>{abbreviate(task.taskId)}</dd>
        <dt>Thread Codex</dt><dd className="mono" title={task.threadId}>{abbreviate(task.threadId, 12)}</dd>
        <dt>Workspace</dt><dd className="mono wrap" title={task.workspace ?? ''}>{task.workspace ?? '—'}</dd>
        {task.worktree ? (
          <>
            <dt>Worktree</dt><dd className="mono wrap">{task.worktree.branch}</dd>
            <dt>Declarado</dt><dd className="mono wrap" title={task.worktree.declaredWorkspace ?? ''}>{task.worktree.declaredWorkspace ?? '—'}</dd>
          </>
        ) : null}
        <dt>Estado</dt><dd>{STATE_LABELS[task.state] ?? task.state}</dd>
        <dt>Coordenador</dt><dd>{task.coordinatorPresence === 'present' ? `presente (há ${presenceAge ?? 0}s)` : 'aguardando coordenador'}</dd>
        {task.requiresReview ? <><dt>Revisão</dt><dd className="warn-text">Execução incerta ou desconectada: revise antes de retomar.</dd></> : null}
      </dl>
      <h2 className="section-title">Modelo e esforço</h2>
      <dl>
        <dt>Modelo solicitado</dt><dd className="mono">{run?.requestedModel ?? '—'}</dd>
        <dt>Motivo</dt><dd className="wrap">{run?.modelReason ?? '—'}</dd>
        <dt>Modelo confirmado</dt><dd className="mono">{run?.observedModel ?? 'não confirmado ainda'}</dd>
        <dt>Esforço</dt><dd>Extra (xhigh) configurado{run?.effortObservedByCli ? `; CLI aplicará ${run.effortObservedByCli}` : ''}; confirmação de servidor: indisponível</dd>
        <dt>Sessão</dt><dd className="mono" title={run?.sessionId ?? task.previousSessionId ?? ''}>{abbreviate(run?.sessionId ?? task.previousSessionId)}</dd>
      </dl>
      <h2 className="section-title">Execução</h2>
      <dl>
        <dt>Status</dt><dd>{run?.status ?? '—'}{run?.failureCode ? ` (${run.failureCode}${run.failureStage ? ` em ${run.failureStage}` : ''})` : ''}</dd>
        <dt>Ferramenta atual</dt><dd>{run?.currentTool ?? 'nenhuma'}</dd>
        <dt>Última atividade</dt><dd>{formatTime(run?.lastActivityAt)}</dd>
        <dt>Tempo decorrido</dt><dd>{run ? formatElapsed(liveElapsed) : '—'}</dd>
        <dt>Turnos</dt><dd>{run?.turns ?? 0}</dd>
        <dt>Falhas de telemetria</dt><dd>{run?.telemetryFailures ?? 0}</dd>
        <dt>Alertas</dt><dd className="wrap">{task.alerts.length ? task.alerts.join(', ') : 'nenhum (20 min sem atividade e 2 h decorridas só alertam)'}</dd>
      </dl>
      <h2 className="section-title">Capacidade</h2>
      {quota.snapshot ? (
        <dl>
          <dt>Sessão</dt><dd>{quota.snapshot.session.remainingPercent}% restante</dd>
          <dt>Semana (todos)</dt><dd>{quota.snapshot.allModels.remainingPercent}% restante</dd>
          <dt>Semana (Fable)</dt><dd>{quota.snapshot.fable.remainingPercent}% restante</dd>
          <dt>Observado em</dt><dd>{formatTime(quota.observedAt)}</dd>
          <dt>Recomendação</dt><dd className="wrap">{quota.recommendation === 'consider_alternate' ? `considerar ${quota.alternate}` : quota.recommendation === 'shared_limit' ? 'limite compartilhado próximo' : 'ok'}</dd>
        </dl>
      ) : (
        <dl>
          <dt>Uso</dt><dd className="wrap">Indisponível{quota.attemptedAt ? ` (tentativa ${formatTime(quota.attemptedAt)}${quota.failure ? `, ${quota.failure.code}` : ''})` : ''}</dd>
        </dl>
      )}
      <div className="section-heading-row">
        <h2 className="section-title">Consumo por fonte</h2>
        <button type="button" className="ghost small" disabled={refreshing} onClick={async () => {
          setRefreshing(true);
          setRefreshError(null);
          try {
            await postAction(task.taskId, 'usage-refresh', {});
          } catch (error) {
            setRefreshError(error instanceof ApiError ? error.code : 'Falha ao atualizar');
          } finally {
            setRefreshing(false);
          }
        }}>{refreshing ? 'Atualizando…' : 'Atualizar consumo'}</button>
      </div>
      <p className="muted small">Fontes independentes. Os valores não são somados como custo e estimativas nunca são tratadas como medição exata.</p>
      <div className="usage-grid">
        <section className="usage-card usage-card-claude" data-testid="usage-claude">
          <div className="usage-card-head"><h3>Claude nesta tarefa</h3><span className={`badge usage-${task.usage.claude.quality}`}>{qualityLabel(task.usage.claude.quality)}</span></div>
          <dl>
            <dt>Entrada</dt><dd>{formatCount(task.usage.claude.inputTokens)}</dd>
            <dt>Saída</dt><dd>{formatCount(task.usage.claude.outputTokens)}</dd>
            <dt>Cache lido</dt><dd>{formatCount(task.usage.claude.cachedInputTokens)}</dd>
            <dt>Cache criado</dt><dd>{formatCount(task.usage.claude.cacheWriteInputTokens)}</dd>
            <dt>Total observado</dt><dd>{formatCount(task.usage.claude.totalObservedTokens)}</dd>
            <dt>Turnos</dt><dd>{task.usage.claude.turns}</dd>
            <dt>Último registro</dt><dd>{formatTime(task.usage.claude.observedAt)}</dd>
          </dl>
          {task.usage.claude.byModel.length ? <ul className="usage-models">{task.usage.claude.byModel.map((item) => <li key={item.model}><span className="mono wrap">{item.model}</span><span>{formatCount(item.totalObservedTokens)} · {item.turns} turno(s)</span></li>)}</ul> : null}
        </section>
        <section className="usage-card usage-card-codex" data-testid="usage-codex-task">
          <div className="usage-card-head"><h3>Codex nesta tarefa</h3><span className={`badge usage-${task.usage.codex.task.quality}`}>{qualityLabel(task.usage.codex.task.quality)}</span></div>
          {task.usage.codex.task.groups.length ? <ul className="usage-models">{task.usage.codex.task.groups.map((item, index) => <li key={`${item.model ?? 'modelo'}-${index}`}><span className="mono wrap">{item.model ?? 'modelo não informado'} · {item.reasoningEffort ?? 'esforço não informado'}</span><span>{formatCount(item.totalTokens)} tokens estimados</span></li>)}</ul> : <p className="muted small">Estimativa por tarefa não disponibilizada por esta versão ou conta.</p>}
          <p className="muted small">Consulta: {formatTime(task.usage.codex.queriedAt)}</p>
        </section>
        <section className="usage-card" data-testid="usage-codex-limits">
          <div className="usage-card-head"><h3>Limites Codex</h3><span className={`badge usage-${task.usage.codex.limits.quality}`}>{qualityLabel(task.usage.codex.limits.quality)}</span></div>
          {task.usage.codex.limits.buckets.length ? task.usage.codex.limits.buckets.map((bucket) => <dl key={bucket.id}>
            <dt>Limite</dt><dd>{bucket.name ?? bucket.id}</dd>
            {bucket.primary ? <><dt>Janela principal</dt><dd>{bucket.primary.usedPercent}% usado · {bucket.primary.remainingPercent}% restante</dd><dt>Renovação</dt><dd>{formatReset(bucket.primary.resetsAt)}</dd></> : null}
            {bucket.secondary ? <><dt>Janela secundária</dt><dd>{bucket.secondary.usedPercent}% usado · {bucket.secondary.remainingPercent}% restante</dd><dt>Renovação</dt><dd>{formatReset(bucket.secondary.resetsAt)}</dd></> : null}
          </dl>) : <p className="muted small">Limites da conta indisponíveis.</p>}
        </section>
        <section className="usage-card" data-testid="usage-codex-activity">
          <div className="usage-card-head"><h3>Atividade Codex</h3><span className={`badge usage-${task.usage.codex.activity.quality}`}>{qualityLabel(task.usage.codex.activity.quality)}</span></div>
          <dl>
            <dt>Acumulado</dt><dd>{formatCount(task.usage.codex.activity.lifetimeTokens)}</dd>
            <dt>Pico diário</dt><dd>{formatCount(task.usage.codex.activity.peakDailyTokens)}</dd>
            <dt>Hoje</dt><dd>{formatCount(task.usage.codex.activity.daily.at(-1)?.tokens ?? null)}</dd>
          </dl>
        </section>
      </div>
      {refreshError ? <p className="warn-text small">Atualização indisponível: {refreshError}</p> : null}
      <h2 className="section-title">Arquivos alterados observados</h2>
      <p className="muted small">Observado pelo git do workspace; não é prova de autoria do Claude.</p>
      <ul className="files">{task.changedFiles.observed.length ? task.changedFiles.observed.slice(0, 50).map((file) => <li key={file} className="mono wrap">{file}</li>) : <li className="muted">nenhum observado</li>}</ul>
      <h3 className="section-title small">Autoria do Claude comprovada</h3>
      <ul className="files">{task.changedFiles.claudeAuthored.length ? task.changedFiles.claudeAuthored.map((file) => <li key={file} className="mono wrap">{file}</li>) : <li className="muted">nenhuma edição registrada pelas ferramentas</li>}</ul>
      <h2 className="section-title">Revisão</h2>
      <p className="warn-text">Revisão independente pendente: COMPLETED confirma apenas o transporte.</p>
      <h2 className="section-title">Fila</h2>
      <ul className="files">{task.queue.length ? task.queue.map((entry) => <li key={entry.messageId} className="wrap">{SOURCE_LABELS[entry.source] ?? entry.source} · {entry.state === 'queued' ? 'Na fila' : entry.state === 'delivered' ? 'Entregue' : 'Requer revisão'} · {formatTime(entry.receivedAt)}</li>) : <li className="muted">vazia</li>}</ul>
    </div>
  );
}
