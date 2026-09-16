// One Claude Code session for one Codex task.
//
// The worker owns a single installed-CLI process, resolves permission and
// question requests visibly, routes hook decisions through the shared
// classifier under the contract's normalized capability gate, redacts public
// text, and reports every public event to the broker (the single writer of
// the durable log).
import { createHash, randomUUID } from 'node:crypto';
import { classifyToolAction, type ActionContext, type Decision } from '../policy/action-classifier.ts';
import { boundedPreview, boundBlob } from '../events/preview.ts';
import { redactSensitiveText, sanitizeHiddenContent, TextRedactionStream } from '../events/redaction.ts';
import { CREDENTIAL_ENV_VARS, PROVIDER_ENV_VARS } from '../preflight/cli-resolver.ts';
import { recordEngineExit, recordEngineProcess } from '../broker/process-tree.ts';
import { AUTHORIZED_MODELS } from '../contract/job-contract.ts';
import { BRAND, RUNTIME_VERSION, type ActionSource, type PendingRequestView, type TurnPolicyLevel, type WorkerPhase } from '../shared/types.ts';
import { planLaunch, type JsonObject, type PermissionAnswer } from '../engine/protocol.ts';
import { SessionClient, type HookContext, type PermissionContext } from '../engine/session-client.ts';
import type { EngineAdapter } from './engine-adapter.ts';
import type { BrokerToWorker, WorkerDescriptor, WorkerToBroker } from './protocol.ts';
import { sanitizeClaudeUsageReport } from '../usage/claude-usage.ts';

type Send = (message: WorkerToBroker) => void;

interface PendingResolution {
  request: PendingRequestView;
  input: JsonObject;
  resolve: (result: PermissionAnswer) => void;
}

const STDERR_LIMIT = 16 * 1024;
/** How long an unrequested shutdown waits for the exit status before deciding. */
const SHUTDOWN_EXIT_GRACE_MS = 3000;
const PRETOOLUSE_CALLBACK = 'codeorquestra-pretooluse';
/** Tools whose surface IS the user interaction; never shown as tool rows. */
const INTERACTIVE_TOOLS = new Set(['AskUserQuestion']);

export function buildSystemPromptAppendix(descriptor: WorkerDescriptor): string {
  const c = descriptor.contract;
  const owners = Object.entries(c.coordination.responsibilities).map(([key, owner]) => `${key}=${owner}`).join(', ');
  const scope = c.scope.wholeWorkspace ? 'todo o workspace aprovado' : c.scope.paths.join(', ');
  const capabilities = [
    c.capabilities.edit ? 'edição de arquivos no escopo' : 'SEM edição de arquivos',
    c.capabilities.test ? 'execução de testes/verificações' : 'SEM execução de testes',
    c.capabilities.commands === 'none' ? 'SEM comandos de shell' : 'comandos classificados caso a caso',
  ].join('; ');
  return [
    `Contexto ${BRAND.name} (integração local independente; o Codex coordena e você executa somente o que a matriz atribui ao Claude).`,
    `Plano aprovado (escopo ${c.coordination.scopeId}, revisão ${c.coordination.approvalRevision}): ${c.coordination.planSummary}`,
    `Responsáveis: ${owners}.`,
    `Capacidades desta execução: ${capabilities}.`,
    `Escopo de edição: ${scope}. Resumo: ${c.scope.summary}`,
    'Commit, push, PR, deploy, publicação, instalação global e alteração de configuração instalada são reservados ao Codex ou ao usuário; nunca os execute.',
    'Ações fora do escopo conhecido geram um pedido de permissão visível ao coordenador; aguarde a decisão em vez de contornar.',
    'Não inclua segredos, credenciais ou dados pessoais nas respostas; o transcript público é armazenado.',
  ].join('\n');
}

export function sanitizedChildEnv(env: NodeJS.ProcessEnv, allowApiBilling: boolean, extra: Record<string, string>): Record<string, string | undefined> {
  const output: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!allowApiBilling && ((CREDENTIAL_ENV_VARS as readonly string[]).includes(key) || (PROVIDER_ENV_VARS as readonly string[]).includes(key))) continue;
    output[key] = value;
  }
  return { ...output, ...extra };
}

/** Tools the CLI may expose, derived from the contract's normalized capabilities. */
export function toolsForContract(contract: WorkerDescriptor['contract']): string[] | null {
  if (contract.capabilities.edit && contract.capabilities.commands === 'classified') return null; // full CLI preset
  const tools = ['Read', 'Glob', 'Grep', 'TodoWrite', 'AskUserQuestion'];
  if (contract.capabilities.test || contract.capabilities.commands !== 'none') tools.push('Bash');
  if (contract.capabilities.edit) tools.push('Write', 'Edit', 'NotebookEdit');
  return tools;
}

export class WorkerSession {
  private readonly descriptor: WorkerDescriptor;
  private readonly adapter: EngineAdapter;
  private readonly send: Send;
  private client: SessionClient | null = null;
  private phase: WorkerPhase = 'starting';
  private turnActive = false;
  /** Extra escalation asked for mid-run; only ever adds permission checks. */
  private policy: TurnPolicyLevel = 'none';
  private interruptPending = false;
  private interruptSource: ActionSource | null = null;
  private endRequested = false;
  private cancelledByEnd = false;
  private sessionId: string | null;
  private requestedModel: string;
  private observedModel: string | null = null;
  private pending = new Map<string, PendingResolution>();
  private openTools = new Map<string, string>();
  private interactiveTools = new Set<string>();
  private textStreams = new Map<string, TextRedactionStream>();
  private stderrTail = '';
  private turn = 0;
  private runEnded = false;
  private failedTurn = false;
  private currentDeliveryId: string | null = null;
  private toolCounter = 0;
  /** Tool uses this runtime already reported as blocked, by tool_use_id. */
  private blockedTools = new Set<string>();
  /** True once `initialize` succeeded and user frames may be sent. */
  private protocolReady = false;
  /** In-flight model switch; no turn may start while it is pending. */
  private modelTransition: Promise<void> | null = null;
  /** True once a switch went unconfirmed: the loaded model is unknown. */
  private modelUncertain = false;
  /** Deliveries that arrived before the handshake finished; never dropped. */
  private heldDeliveries: Array<{ messageId: string; text: string; source: ActionSource }> = [];

  constructor(descriptor: WorkerDescriptor, adapter: EngineAdapter, send: Send) {
    this.descriptor = descriptor;
    this.adapter = adapter;
    this.send = send;
    this.sessionId = descriptor.resumeSessionId;
    this.requestedModel = descriptor.contract.model.resolved ?? descriptor.contract.model.requested;
  }

  private emit(type: string, data: Record<string, unknown>, toolUseId?: string): void {
    this.send({ t: 'event', type, ...(toolUseId ? { toolUseId } : {}), data });
  }

  /**
   * A pending interactive request always wins over a generic tool phase, so
   * the panel can never label a question as a permission prompt.
   */
  private setPhase(phase: WorkerPhase): void {
    let effective = phase;
    if (phase !== 'terminal' && this.pending.size > 0) {
      const kinds = [...this.pending.values()].map((entry) => entry.request.kind);
      effective = kinds.includes('question') ? 'waiting_question' : 'waiting_permission';
    }
    this.phase = effective;
    const currentTool = this.openTools.size ? [...this.openTools.values()].at(-1) ?? null : null;
    this.send({ t: 'phase', phase: effective, currentTool });
  }

  private actionContext(): ActionContext {
    const c = this.descriptor.contract;
    return {
      profile: c.profile,
      workspace: c.workspace,
      scopePaths: c.scope.paths,
      wholeWorkspace: c.scope.wholeWorkspace,
      responsibilities: c.coordination.responsibilities,
      capabilities: c.capabilities,
      approvedMcpServers: Object.keys(this.descriptor.launch.mcpServers),
      approvedMcpTools: this.descriptor.approvedMcpTools,
      approvedAgents: this.descriptor.approvedAgents ?? [],
      approvedSkills: this.descriptor.approvedSkills ?? [],
      // A delegated agent runs under this same contract: it may not pick
      // another model, nor a weaker effort than the one this run authorizes.
      authorizedModels: [...AUTHORIZED_MODELS],
      requiredEffort: c.effort,
      escalate: this.policy,
    };
  }

  async start(): Promise<void> {
    this.setPhase('starting');
    const d = this.descriptor;
    const c = d.contract;
    const env = sanitizedChildEnv(process.env, c.auth.allowApiBilling, {
      ...d.launch.env,
      CLAUDE_CODE_ENTRYPOINT: 'codeorquestra',
      CODEORQUESTRA_VERSION: RUNTIME_VERSION,
    });
    const plan = planLaunch({
      executablePath: d.executable.path,
      runWith: d.executable.runWith,
      model: this.requestedModel,
      effort: c.effort,
      tools: toolsForContract(c),
      permissionMode: c.launch.permissionMode,
      permissionPrompts: c.launch.permissionPromptsDisabled ? 'none' : 'host',
      permissionPromptTool: !c.launch.permissionPromptsDisabled,
      settingSources: d.launch.settingSources,
      strictMcpConfig: true,
      mcpServers: d.launch.mcpServers,
      resumeSessionId: this.sessionId,
      safeMode: c.launch.safeMode,
      restricted: c.launch.restricted,
      additionalDirectories: [],
      debugFile: null,
    }, c.workspace, env);

    let proc;
    try {
      proc = this.adapter.spawn(plan);
      // Record the engine PID so a crashed worker still leaves an accountable
      // descendant the broker can reconcile before releasing the writer lock.
      recordEngineProcess(d.runDir, proc.pid);
    } catch (error) {
      this.emit('preparation_failed', { stage: 'cli-spawn', code: 'CLI_SPAWN_FAILED', message: `Não foi possível iniciar o Claude Code instalado (${(error as Error).name}).` });
      this.finish('FAIL', 'CLI_SPAWN_FAILED', 'Não foi possível iniciar o Claude Code instalado.', 1);
      return;
    }
    this.client = new SessionClient({
      process: proc,
      hooks: [{ event: 'PreToolUse', callbackId: PRETOOLUSE_CALLBACK }],
      appendSystemPrompt: buildSystemPromptAppendix(d),
      callbacks: {
        canUseTool: (tool, input, context) => this.canUseTool(tool, input, context),
        onHook: (event, input, context) => this.onHook(event, input, context),
        onStderr: (text) => { this.stderrTail = (this.stderrTail + text).slice(-STDERR_LIMIT); },
        onProblem: (problem) => this.emit('transport_problem', { code: problem.code, detail: problem.detail }),
      },
    });

    // The CLI exiting is the proof its process is gone; record it so the
    // broker can release the checkout instead of quarantining it.
    void this.client.exit.then(({ code, signal }) => recordEngineExit(d.runDir, code, signal));

    try {
      const initialized = await this.client.initialize();
      this.emit('cli_initialized', {
        hooksApplied: initialized.hooksApplied,
        modelCatalogSize: initialized.models?.length ?? null,
        modelSupport: describeModelSupport(initialized.models, this.requestedModel),
      });
      // PreToolUse is the gate that blocks reserved operations and out-of-scope
      // writes before they run. A CLI that did not apply it would execute tools
      // with no gate at all, so preparation fails closed before any work.
      if (initialized.hooksApplied !== true) {
        this.abortRun('PRETOOLUSE_HOOK_NOT_APPLIED', `O CLI instalado não confirmou a aplicação do hook PreToolUse (hooks_applied=${String(initialized.hooksApplied)}); sem esse controle nenhum trabalho é iniciado.`);
        return;
      }
      if (initialized.models && describeModelSupport(initialized.models, this.requestedModel) === 'unsupported') {
        this.abortRun('MODEL_NOT_OFFERED_BY_CLI', `O catálogo do CLI instalado não oferece ${this.requestedModel}; nenhum outro modelo é iniciado no lugar.`);
        return;
      }
      // The broker may deliver the first message as soon as we announce
      // ourselves, before the protocol handshake finished. Those deliveries are
      // held, never dropped, and start their turn here in arrival order.
      this.protocolReady = true;
      for (const held of this.heldDeliveries.splice(0)) this.deliver(held.messageId, held.text, held.source);
    } catch (error) {
      const code = (error as { code?: string }).code ?? 'CLI_INITIALIZE_FAILED';
      this.emit('preparation_failed', { stage: 'cli-initialize', code, message: `A inicialização do protocolo com o CLI falhou (${code}).` });
      this.finish('FAIL', code, 'A inicialização do protocolo com o CLI falhou.', 1);
      return;
    }

    try {
      for await (const message of this.client.conversation()) {
        await this.handle(message);
        if (this.runEnded) break;
      }
      if (!this.runEnded) await this.finishFromShutdown();
    } catch (error) {
      const code = (error as { code?: string }).code ?? (error as Error).name ?? 'SESSION_ERROR';
      this.finish('FAIL', String(code), `A sessão terminou com erro (${String(code)}).`, 1);
    }
  }

  /**
   * Decides the terminal outcome after the conversation stream ended.
   *
   * A closed stream is not success. The outcome needs three facts: whether the
   * protocol completed the work (no turn left running, no failed turn), whether
   * WE asked the CLI to close, and how the process actually exited. A CLI that
   * died on its own — non-zero code or a signal — is a failure even if the last
   * turn had finished, and is never reported as COMPLETED or CANCELLED.
   *
   * stdout ends before the process is reaped, so when nobody asked for the
   * close we wait for the exit status first. Deciding without it would report
   * "the stream ended mid-turn" for a CLI that actually crashed, hiding the
   * exit code and the real cause behind a vaguer reason.
   */
  private async finishFromShutdown(): Promise<void> {
    if (!this.endRequested) await this.client?.settleExit(SHUTDOWN_EXIT_GRACE_MS);
    if (this.runEnded) return;
    const exit = this.client?.exitInfo ?? null;
    const abnormal = exit !== null && !this.endRequested && (exit.signal !== null || (exit.code !== null && exit.code !== 0));
    if (abnormal) {
      const detail = exit.signal ? `sinal ${exit.signal}` : `código ${String(exit.code)}`;
      this.finish('FAIL', 'CLI_EXITED_UNEXPECTEDLY', `O Claude Code encerrou sozinho (${detail}) sem que o encerramento fosse solicitado; o resultado não pode ser aceito como concluído.`, 1);
      return;
    }
    if (this.failedTurn) {
      this.finish('FAIL', 'TURN_FAILED', 'A sessão terminou após um turno com erro; revise as evidências antes de aceitar.', 1);
      return;
    }
    // The stream ended mid-turn without the process dying abnormally: it either
    // exited cleanly with no result, or it is still running with a closed
    // stdout. Either way the work was not completed, so it is not a completion.
    if (this.turnActive && !this.endRequested) {
      const detail = exit === null ? 'o processo continuou ativo com a saída fechada' : `o processo terminou com código ${String(exit.code)}`;
      this.finish('FAIL', 'CLI_STREAM_ENDED_MID_TURN', `O fluxo do Claude Code terminou no meio de um turno, sem resultado (${detail}); a execução fica como falha para revisão.`, 1);
      return;
    }
    // Nobody asked for this and the process never reported an exit: stdout
    // closed while the CLI may still be running. There is no evidence the work
    // finished, so this is a failure to review, never a confirmed completion.
    if (!this.endRequested && exit === null) {
      this.finish('FAIL', 'CLI_EXIT_UNKNOWN', 'O fluxo do Claude Code terminou sem que o processo informasse seu encerramento; ele pode continuar ativo. A execução fica como falha para revisão.', 1);
      return;
    }
    const cancelled = this.turnActive || this.cancelledByEnd;
    const message = this.endRequested
      ? (cancelled ? 'Sessão encerrada pelo coordenador durante um turno.' : 'Sessão encerrada pelo coordenador.')
      : null;
    this.finish(cancelled ? 'CANCELLED' : 'COMPLETED', null, message, 0);
  }

  private finish(status: 'COMPLETED' | 'FAIL' | 'CANCELLED', code: string | null, message: string | null, exitCode: number): void {
    if (this.runEnded) return;
    this.runEnded = true;
    for (const pending of this.pending.values()) pending.resolve({ behavior: 'deny', message: 'Sessão encerrada antes da decisão.' });
    this.pending.clear();
    if (this.stderrTail.trim()) this.emit('stderr_tail', { preview: boundedPreview(redactSensitiveText(this.stderrTail), 2048).preview });
    this.setPhase('terminal');
    this.send({ t: 'run_ended', status, code, message, exitCode });
    void this.client?.close(4000);
  }

  handleBrokerMessage(message: BrokerToWorker): void {
    switch (message.t) {
      case 'deliver':
        this.deliver(message.messageId, message.text, message.source);
        break;
      case 'answer':
        this.answer(message);
        break;
      case 'interrupt':
        void this.interrupt(message.source);
        break;
      case 'end':
        void this.end(message.source);
        break;
      case 'set_model':
        void this.setModel(message.model, message.reason, message.source);
        break;
      case 'set_policy':
        this.setPolicy(message.escalate, message.reason, message.source);
        break;
      case 'exit':
        void this.client?.close(1000).then(() => process.exit(0));
        setTimeout(() => process.exit(0), 2000).unref();
        break;
      default:
        break;
    }
  }

  private deliver(messageId: string, text: string, source: ActionSource): void {
    if (this.runEnded) return;
    // An unconfirmed switch leaves the loaded model unknown; starting a turn
    // would run it on a model nobody can name.
    if (this.modelUncertain) {
      this.emit('delivery_blocked', { messageId, source, reason: 'MODEL_UNCERTAIN', message: 'O modelo em vigor não foi confirmado pelo CLI; nenhum turno novo é iniciado até revisão explícita.' });
      return;
    }
    // Held, never dropped: before the handshake, and while the model is still
    // switching, so no turn can begin on an indeterminate model.
    if (!this.client || !this.protocolReady || this.modelTransition) {
      this.heldDeliveries.push({ messageId, text, source });
      return;
    }
    this.turn += 1;
    this.turnActive = true;
    this.interruptPending = false;
    this.currentDeliveryId = messageId;
    this.emit('turn_started', { turn: this.turn, messageId, source });
    this.setPhase('busy_model');
    try {
      this.client.send(text, this.sessionId);
    } catch (error) {
      this.turnActive = false;
      this.emit('turn_send_failed', { messageId, code: (error as { code?: string }).code ?? 'SEND_FAILED' });
      this.send({ t: 'turn_done', interrupted: false });
    }
  }

  private answer(message: Extract<BrokerToWorker, { t: 'answer' }>): void {
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    this.pending.delete(message.requestId);
    const { request } = pending;
    const note = message.message ? redactSensitiveText(message.message).slice(0, 2000) : null;
    if (request.kind === 'question') {
      const answers = message.answers ?? {};
      this.emit('question_answered', { requestId: request.requestId, source: message.source, answers: redactAnswers(answers), decision: message.decision });
      if (message.decision === 'deny') pending.resolve({ behavior: 'deny', message: note ?? 'Pergunta recusada pelo coordenador.' });
      else pending.resolve({ behavior: 'allow', updatedInput: { ...pending.input, answers } });
    } else {
      this.emit('permission_resolved', { requestId: request.requestId, decision: message.decision === 'allow' ? 'allow' : 'deny', source: message.source, message: note, tool: request.tool });
      if (message.decision === 'allow') pending.resolve({ behavior: 'allow', updatedInput: pending.input });
      else pending.resolve({ behavior: 'deny', message: note ?? 'Negado pelo coordenador.' });
    }
    if (this.runEnded || this.pending.size > 0) return;
    this.setPhase(this.openTools.size ? 'busy_tool' : 'busy_model');
  }

  /**
   * Tightens what this run may do without asking, while it is running.
   *
   * Every tool call consults the classifier through the PreToolUse hook, so a
   * restriction takes effect on the NEXT call rather than the next turn. That
   * is the point: the reason to restrict is usually something happening right
   * now. It can only ask for more decisions, never grant one, so applying it
   * mid-turn takes nothing away from the invariant that only an explicit
   * interrupt aborts a turn.
   */
  private setPolicy(escalate: TurnPolicyLevel, reason: string, source: ActionSource): void {
    this.policy = escalate;
    this.emit('policy_changed', { escalate, reason, source, duringTurn: this.turnActive });
  }

  private async interrupt(source: ActionSource): Promise<void> {
    if (!this.client || !this.turnActive) return;
    this.interruptPending = true;
    this.interruptSource = source;
    for (const [requestId, pending] of this.pending) {
      this.pending.delete(requestId);
      this.emit('permission_resolved', { requestId, decision: 'deny', source, message: 'Turno interrompido.', tool: pending.request.tool });
      pending.resolve({ behavior: 'deny', message: 'Turno interrompido pelo coordenador.', interrupt: true });
    }
    try {
      await this.client.interrupt();
    } catch (error) {
      this.emit('interrupt_failed', { code: (error as { code?: string }).code ?? 'INTERRUPT_FAILED' });
    }
  }

  private async end(source: ActionSource): Promise<void> {
    if (this.endRequested) return;
    this.endRequested = true;
    this.cancelledByEnd = this.turnActive;
    this.emit('session_end_requested', { source, duringTurn: this.turnActive });
    // Arm the bounded fallback BEFORE awaiting the interrupt, so a hung
    // interrupt can never prevent cleanup.
    const fallback = setTimeout(() => {
      if (!this.runEnded) {
        this.finish(this.cancelledByEnd || this.turnActive ? 'CANCELLED' : 'COMPLETED', null, 'Sessão encerrada pelo coordenador.', 0);
      }
    }, 8000);
    fallback.unref();
    if (this.turnActive) await this.interrupt(source);
    this.client?.endInput();
  }

  /**
   * Applies a model change between turns.
   *
   * The transition is reserved for its whole duration: a message that arrives
   * while the CLI is still switching is held, not delivered, so a turn can
   * never start on an indeterminate model. Every outcome is reported back, and
   * a refusal leaves the previously active model explicit.
   */
  private async setModel(model: string, reason: string, source: ActionSource): Promise<void> {
    const refuse = (code: string): void => {
      this.emit('model_change_refused', { model, reason: code, source, activeModel: this.requestedModel });
      this.send({ t: 'model_result', ok: false, model, activeModel: this.requestedModel, code });
    };
    if (!this.client || !this.protocolReady) return refuse('SESSION_NOT_READY');
    if (this.modelUncertain) return refuse('MODEL_UNCERTAIN');
    if (this.turnActive) return refuse('TURN_IN_PROGRESS');
    if (this.modelTransition) return refuse('MODEL_CHANGE_IN_PROGRESS');
    const from = this.requestedModel;
    const transition = (async () => {
      try {
        await this.client!.setModel(model);
        this.requestedModel = model;
        this.emit('model_changed', { from, to: model, reason: redactSensitiveText(reason).slice(0, 500), source, strategy: 'in_session' });
        this.send({ t: 'model_result', ok: true, model, activeModel: model, code: null });
      } catch (error) {
        const code = (error as { code?: string }).code ?? 'SET_MODEL_FAILED';
        if (code === 'CONTROL_REQUEST_TIMEOUT') {
          // The request was sent and never answered: the CLI may have applied
          // it. Claiming the old model is still active would be a guess, so the
          // run is marked uncertain and no further turn is started here.
          this.modelUncertain = true;
          this.emit('model_change_uncertain', { model, previousModel: from, code, note: 'O CLI não respondeu; o modelo em vigor é desconhecido.' });
          this.send({ t: 'model_uncertain', model, previousModel: from, code });
          return;
        }
        // The CLI refused the switch: the active model stays the old one,
        // stated explicitly, instead of an assumed new one.
        this.emit('model_change_failed', { model, code, activeModel: from });
        this.send({ t: 'model_result', ok: false, model, activeModel: from, code });
      }
    })();
    this.modelTransition = transition;
    try {
      await transition;
    } finally {
      this.modelTransition = null;
      // Anything that arrived during the switch starts now, on a known model.
      for (const held of this.heldDeliveries.splice(0)) this.deliver(held.messageId, held.text, held.source);
    }
  }

  // ------------------------------------------------------------ decisions

  private decide(tool: string, input: JsonObject): { decision: Decision; reason: string; message: string } {
    const result = classifyToolAction({ tool, input }, this.actionContext());
    return { decision: result.decision, reason: result.reason, message: result.message };
  }

  private async onHook(event: string, input: JsonObject, _context: HookContext): Promise<{ continue: boolean; hookSpecificOutput?: JsonObject }> {
    if (event !== 'PreToolUse') return { continue: true };
    const tool = String((input as { tool_name?: unknown }).tool_name ?? '');
    const toolInput = ((input as { tool_input?: unknown }).tool_input && typeof (input as { tool_input?: unknown }).tool_input === 'object'
      ? (input as { tool_input: JsonObject }).tool_input
      : {}) as JsonObject;
    const toolUseId = String((input as { tool_use_id?: unknown }).tool_use_id ?? '');
    if (tool === 'AskUserQuestion' || tool === 'ExitPlanMode') return { continue: true };
    const decision = this.decide(tool, toolInput);
    if (decision.decision === 'deny') {
      if (toolUseId) this.blockedTools.add(toolUseId);
      this.emit('tool_blocked', { tool, reason: decision.reason, message: decision.message, enforcedBy: 'PreToolUse', inputPreview: previewInput(toolInput) }, toolUseId || undefined);
      return { continue: true, hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: decision.message } };
    }
    if (decision.decision === 'allow') {
      return { continue: true, hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: decision.message } };
    }
    return { continue: true, hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: decision.message } };
  }

  private canUseTool(toolName: string, input: JsonObject, context: PermissionContext): Promise<PermissionAnswer> {
    const isQuestion = toolName === 'AskUserQuestion';
    const decision = isQuestion
      ? { decision: 'escalate' as const, reason: 'QUESTION', message: 'Pergunta do Claude aguardando resposta.' }
      : this.decide(toolName, input);
    if (decision.decision === 'allow') return Promise.resolve({ behavior: 'allow', updatedInput: input });
    if (decision.decision === 'deny') {
      this.blockedTools.add(context.toolUseId);
      this.emit('tool_blocked', { tool: toolName, reason: decision.reason, message: decision.message, enforcedBy: 'canUseTool', inputPreview: previewInput(input) }, context.toolUseId);
      return Promise.resolve({ behavior: 'deny', message: decision.message });
    }
    // A signal that is already aborted must settle now; registering a listener
    // would leave an unresolved request forever.
    if (context.signal.aborted) {
      this.emit('permission_resolved', { requestId: context.requestId, decision: 'deny', source: 'system', message: 'Pedido já cancelado pelo CLI antes da decisão.', tool: toolName });
      return Promise.resolve({ behavior: 'deny', message: 'Pedido cancelado antes da decisão.' });
    }
    const request: PendingRequestView = {
      requestId: `req-${randomUUID()}`,
      runId: this.descriptor.runId,
      kind: isQuestion ? 'question' : 'permission',
      tool: toolName,
      reason: decision.reason,
      message: decision.message,
      inputPreview: previewInput(input),
      questions: isQuestion ? extractQuestions(input) : [],
      createdAt: new Date().toISOString(),
      state: 'pending',
    };
    if (isQuestion) {
      this.emit('question_asked', {
        requestId: request.requestId,
        questions: request.questions,
        summary: request.questions.map((q) => q.question).join(' | ').slice(0, 500),
        title: safeText(context.title, 200),
      }, context.toolUseId);
    } else {
      this.emit('permission_requested', {
        requestId: request.requestId,
        tool: toolName,
        reason: decision.reason,
        decision: 'escalate',
        message: decision.message,
        inputPreview: request.inputPreview,
        title: safeText(context.title, 200),
        cliReason: safeText(context.decisionReason, 300),
        cliReasonType: safeText(context.decisionReasonType, 60),
      }, context.toolUseId);
    }
    this.send({ t: 'request', request });
    this.setPhase(isQuestion ? 'waiting_question' : 'waiting_permission');
    return new Promise<PermissionAnswer>((resolve) => {
      let settled = false;
      const settle = (answer: PermissionAnswer) => {
        if (settled) return;
        settled = true;
        resolve(answer);
      };
      this.pending.set(request.requestId, { request, input, resolve: settle });
      context.signal.addEventListener('abort', () => {
        if (this.pending.delete(request.requestId)) {
          this.emit('permission_resolved', { requestId: request.requestId, decision: 'deny', source: 'system', message: 'Solicitação cancelada pelo CLI.', tool: toolName });
          settle({ behavior: 'deny', message: 'Solicitação cancelada.' });
        }
      }, { once: true });
    });
  }

  // ----------------------------------------------------------- CLI frames

  private async handle(raw: JsonObject): Promise<void> {
    const message = sanitizeHiddenContent(raw).sanitized as JsonObject;
    switch (message.type) {
      case 'system': {
        const subtype = String(message.subtype ?? '');
        if (subtype === 'init') this.onInit(message);
        else if (subtype === 'permission_denied') {
          // The CLI echoes a denial we already published from PreToolUse or
          // canUseTool. One decision is one row: only a block we did not make
          // ourselves is news.
          const toolUseId = typeof message.tool_use_id === 'string' ? message.tool_use_id : undefined;
          if (!toolUseId || !this.blockedTools.has(toolUseId)) {
            this.emit('tool_blocked', {
              tool: String(message.tool_name ?? '?'),
              reason: 'CLI_DENIED',
              message: safeText(message.message as string | undefined, 500) ?? '',
              enforcedBy: 'cli',
            }, toolUseId);
          }
        } else {
          this.emit('system_notice', { subtype });
        }
        break;
      }
      case 'stream_event':
        this.onStreamEvent(message as { event?: JsonObject });
        break;
      case 'assistant':
        this.onAssistant(message);
        break;
      case 'user':
        this.onUser(message);
        break;
      case 'result':
        this.onResult(message);
        break;
      case 'auth_status':
        this.emit('auth_status', { isAuthenticating: message.isAuthenticating === true, hasError: Boolean(message.error) });
        break;
      default:
        break;
    }
  }

  private onInit(message: JsonObject): void {
    const sessionId = typeof message.session_id === 'string' ? message.session_id : null;
    const observed = typeof message.model === 'string' ? message.model : null;
    this.sessionId = sessionId ?? this.sessionId;
    this.observedModel = observed;
    const effortObserved = typeof message.effort === 'string' ? message.effort : null;
    const apiKeySource = typeof message.apiKeySource === 'string' ? message.apiKeySource : null;
    this.emit('session_init', {
      sessionId,
      observedModel: observed,
      effortObservedByCli: effortObserved,
      cliVersion: typeof message.claude_code_version === 'string' ? message.claude_code_version : null,
      capabilities: Array.isArray(message.capabilities) ? message.capabilities : [],
      apiKeySource,
      permissionMode: typeof message.permissionMode === 'string' ? message.permissionMode : null,
      mcpServers: Array.isArray(message.mcp_servers) ? (message.mcp_servers as Array<{ name: string; status: string }>).map((server) => ({ name: server.name, status: server.status })) : [],
      resumeMode: this.descriptor.resumeMode,
    });
    const c = this.descriptor.contract;
    if (observed && !modelMatches(this.requestedModel, observed)) {
      this.abortRun('MODEL_MISMATCH', `O CLI iniciou a sessão com ${observed}, diferente do modelo autorizado ${this.requestedModel}; nenhuma substituição silenciosa é aceita.`);
      return;
    }
    if (effortObserved !== null && effortObserved !== c.effort) {
      this.abortRun('EFFORT_DOWNGRADED_BY_CLI', `O CLI aplicará esforço ${effortObserved} em vez de ${c.effort} (limite de conta, modelo ou política); o trabalho não continua em silêncio com esforço reduzido.`);
      return;
    }
    if (apiKeySource && ['ANTHROPIC_API_KEY', 'apiKeyHelper', '/login managed key'].includes(apiKeySource) && !c.auth.allowApiBilling) {
      this.abortRun('AUTH_API_BILLING_NOT_AUTHORIZED', `A sessão usaria credencial de API (${apiKeySource}) sem autorização explícita de cobrança.`);
      return;
    }
    if (this.phase === 'starting') this.setPhase(this.turnActive ? 'busy_model' : 'idle');
  }

  private abortRun(code: string, message: string): void {
    this.emit('preparation_failed', { stage: 'session-init', code, message });
    this.client?.endInput();
    this.finish('FAIL', code, message, 1);
  }

  private onStreamEvent(message: { event?: JsonObject }): void {
    const event = message.event;
    if (!event) return;
    const type = String(event.type ?? '');
    const index = String(event.index ?? 0);
    if (type === 'content_block_start') {
      const block = event.content_block as { type?: string } | undefined;
      if (block?.type === 'text') this.textStreams.set(index, new TextRedactionStream());
      return;
    }
    if (type === 'content_block_delta') {
      const delta = event.delta as { type?: string; text?: string } | undefined;
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        let stream = this.textStreams.get(index);
        if (!stream) {
          stream = new TextRedactionStream();
          this.textStreams.set(index, stream);
        }
        const visible = stream.push(delta.text);
        this.send({ t: 'transient', frame: { kind: 'text_progress', taskId: this.descriptor.taskId, runId: this.descriptor.runId, blockId: `${this.turn}:${index}`, text: visible.slice(-8192), ts: new Date().toISOString() } });
      }
      return;
    }
    if (type === 'content_block_stop') this.textStreams.delete(index);
  }

  private onAssistant(message: JsonObject): void {
    const body = (message.message ?? {}) as { model?: unknown; content?: unknown };
    const model = typeof body.model === 'string' ? body.model : null;
    if (model) {
      if (!modelMatches(this.requestedModel, model)) {
        this.abortRun('MODEL_MISMATCH', `Uma mensagem do assistente veio de ${model}, diferente do modelo autorizado ${this.requestedModel}; o trabalho não é aceito.`);
        return;
      }
      this.observedModel = model;
    }
    const error = typeof message.error === 'string' ? message.error : null;
    if (error) {
      this.emit('assistant_error', { code: error });
      if (['authentication_failed', 'billing_error', 'cloud_credential_error', 'oauth_org_not_allowed', 'account_on_hold'].includes(error)) {
        this.abortRun(`ASSISTANT_${error.toUpperCase()}`, 'A sessão parou por falha de autenticação, autorização ou cobrança; nenhuma tentativa alternativa é feita.');
        return;
      }
    }
    const content = Array.isArray(body.content) ? (body.content as Array<Record<string, unknown>>) : [];
    for (const block of content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        const text = redactSensitiveText(block.text);
        const preview = boundedPreview(text, 64 * 1024);
        this.emit('assistant_text', {
          text: preview.preview,
          truncated: preview.truncated,
          totalChars: preview.totalChars,
          model: this.observedModel,
          messageId: this.currentDeliveryId,
          parentToolUseId: typeof message.parent_tool_use_id === 'string' ? message.parent_tool_use_id : null,
        });
      } else if (block.type === 'tool_use' && typeof block.name === 'string') {
        const id = typeof block.id === 'string' ? block.id : `toolu_local_${(this.toolCounter += 1)}`;
        const input = (block.input && typeof block.input === 'object' ? block.input : {}) as JsonObject;
        if (INTERACTIVE_TOOLS.has(block.name)) {
          // Interactive tools are published as decision rows, never as a
          // generic tool row that would contradict the decision state.
          this.interactiveTools.add(id);
          continue;
        }
        this.openTools.set(id, block.name);
        this.emit('tool_start', { name: block.name, inputPreview: previewInput(input), inputHash: hashInput(input), parentToolUseId: typeof message.parent_tool_use_id === 'string' ? message.parent_tool_use_id : null }, id);
        this.setPhase('busy_tool');
      }
    }
  }

  private onUser(message: JsonObject): void {
    const body = (message.message ?? {}) as { content?: unknown };
    const content = Array.isArray(body.content) ? (body.content as Array<Record<string, unknown>>) : [];
    for (const block of content) {
      if (block.type !== 'tool_result') continue;
      const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
      if (this.interactiveTools.delete(id)) continue;
      const text = redactSensitiveText(toolResultText(block.content));
      const preview = boundedPreview(text);
      let blobId: string | null = null;
      if (preview.truncated) {
        blobId = `blob-${randomUUID()}`;
        const blob = boundBlob(text);
        this.send({ t: 'blob', blobId, text: blob.text, truncated: blob.truncated, totalChars: blob.totalChars });
      }
      const name = this.openTools.get(id) ?? null;
      this.openTools.delete(id);
      this.emit('tool_result', { name, isError: block.is_error === true, preview: preview.preview, truncated: preview.truncated, totalChars: preview.totalChars, pages: preview.pages, blobId }, id);
    }
    if (this.turnActive && this.pending.size === 0) this.setPhase(this.openTools.size ? 'busy_tool' : 'busy_model');
  }

  private onResult(message: JsonObject): void {
    const interrupted = this.interruptPending;
    this.turnActive = false;
    this.interruptPending = false;
    this.openTools.clear();
    this.textStreams.clear();
    const subtype = String(message.subtype ?? '');
    const isError = message.is_error === true || subtype !== 'success';
    const resultText = subtype === 'success' && typeof message.result === 'string' ? redactSensitiveText(message.result) : '';
    const preview = boundedPreview(resultText, 64 * 1024);
    const usage = message.usage as {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    } | undefined;
    const denials = Array.isArray(message.permission_denials) ? message.permission_denials.length : 0;
    const data = {
      turn: this.turn,
      subtype,
      isError,
      resultText: preview.preview,
      truncated: preview.truncated,
      numTurns: typeof message.num_turns === 'number' ? message.num_turns : null,
      durationMs: typeof message.duration_ms === 'number' ? message.duration_ms : null,
      // Persist only the documented numeric counters. Missing fields remain
      // absent so the meter can label a report as partial instead of zero.
      usage: sanitizeClaudeUsageReport(usage),
      permissionDenials: denials,
      terminalReason: typeof message.terminal_reason === 'string' ? message.terminal_reason : null,
      errors: Array.isArray(message.errors) ? (message.errors as string[]).map((error) => redactSensitiveText(String(error)).slice(0, 300)) : [],
      model: this.observedModel,
    };
    if (interrupted) this.emit('turn_interrupted', { ...data, source: this.interruptSource ?? 'system' });
    else if (isError) {
      // A failed turn is terminal evidence: it never reports COMPLETED later.
      this.failedTurn = true;
      this.emit('turn_failed', data);
    } else this.emit('turn_completed', data);
    const sessionId = typeof message.session_id === 'string' ? message.session_id : null;
    if (sessionId && this.sessionId !== sessionId) {
      this.sessionId = sessionId;
      this.emit('session_init', { sessionId, observedModel: this.observedModel, effortObservedByCli: null, resumeMode: this.descriptor.resumeMode, source: 'result' });
    }
    if (isError && !interrupted) {
      this.setPhase('terminal');
      this.send({ t: 'turn_done', interrupted: false });
      this.client?.endInput();
      this.finish('FAIL', 'TURN_FAILED', `O turno terminou com erro (${subtype}); revise as evidências.`, 1);
      return;
    }
    this.setPhase('idle');
    this.send({ t: 'turn_done', interrupted });
    if (this.endRequested) this.client?.endInput();
  }
}

function describeModelSupport(models: Array<{ value?: string; resolvedModel?: string }> | null, requested: string): 'confirmed' | 'unsupported' | 'unknown' {
  if (!models || models.length === 0) return 'unknown';
  return models.some((model) => model.value === requested || model.resolvedModel === requested) ? 'confirmed' : 'unsupported';
}

function modelMatches(requested: string, observed: string): boolean {
  return observed === requested || observed.startsWith(`${requested}-`);
}

function safeText(value: string | null | undefined, limit: number): string | null {
  if (typeof value !== 'string' || !value) return null;
  // Interactive fields come from the CLI and may carry ANSI escapes; they are
  // redacted and stripped before they cross IPC or reach any renderer.
  const stripped = value.replace(/\[[0-9;?]*[ -/]*[@-~]/g, '');
  return boundedPreview(redactSensitiveText(stripped), limit).preview;
}

export function previewInput(input: JsonObject): string {
  return boundedPreview(redactSensitiveText(JSON.stringify(input ?? {}, null, 0)), 2048).preview;
}

/**
 * A stable fingerprint of a tool's input, so "the same call again" is a fact
 * instead of a guess from a truncated preview. Keys are sorted recursively, so
 * two calls that differ only in key order are correctly the same call. The
 * digest is only ever compared: it is never shown and never reversed.
 */
export function hashInput(input: JsonObject): string {
  return createHash('sha256').update(canonicalJson(input ?? {})).digest('hex').slice(0, 16);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function redactAnswers(answers: Record<string, string | string[]>): Record<string, string | string[]> {
  const output: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(answers)) {
    const safeKey = redactSensitiveText(key).slice(0, 300);
    output[safeKey] = Array.isArray(value) ? value.map((item) => redactSensitiveText(item).slice(0, 500)) : redactSensitiveText(value).slice(0, 500);
  }
  return output;
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : '')).join('\n');
  }
  return '';
}

function extractQuestions(input: JsonObject): PendingRequestView['questions'] {
  const raw = Array.isArray(input.questions) ? (input.questions as Array<Record<string, unknown>>) : [];
  return raw.map((entry) => ({
    question: safeText(String(entry.question ?? ''), 1000) ?? '',
    ...(typeof entry.header === 'string' ? { header: safeText(entry.header, 120) ?? '' } : {}),
    options: Array.isArray(entry.options)
      ? (entry.options as Array<Record<string, unknown>>).map((option) => ({
          label: safeText(String(option.label ?? ''), 200) ?? '',
          ...(typeof option.description === 'string' ? { description: safeText(option.description, 500) ?? '' } : {}),
        }))
      : [],
    ...(typeof entry.multiSelect === 'boolean' ? { multiSelect: entry.multiSelect } : {}),
  }));
}
