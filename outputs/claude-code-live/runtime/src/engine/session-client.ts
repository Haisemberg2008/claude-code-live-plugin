// Conversation client for one installed-CLI process.
//
// Owns the control-protocol correlation in both directions: our requests
// (initialize, interrupt, set_model) and the CLI's requests (can_use_tool,
// hook_callback). Conversation frames are exposed as an async iterator.
import { AsyncQueue } from '../worker/async-queue.ts';
import { CONTROL_SUBTYPES, type ControlRequestFrame, type HookAnswer, type JsonObject, type PermissionAnswer } from './protocol.ts';
import { readFrames, writeFrame, type ClaudeProcessHandle } from './transport.ts';

/** How long stdout may still be drained after the process exited. */
const DRAIN_TIMEOUT_MS = 5_000;

export class EngineError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
  }
}

export interface PermissionContext {
  toolUseId: string;
  requestId: string;
  agentId: string | null;
  title: string | null;
  displayName: string | null;
  description: string | null;
  decisionReason: string | null;
  decisionReasonType: string | null;
  signal: AbortSignal;
}

export interface HookContext {
  callbackId: string;
  toolUseId: string | null;
  signal: AbortSignal;
}

export interface SessionClientCallbacks {
  canUseTool: (toolName: string, input: JsonObject, context: PermissionContext) => Promise<PermissionAnswer>;
  onHook: (event: string, input: JsonObject, context: HookContext) => Promise<HookAnswer>;
  onStderr: (text: string) => void;
  onProblem: (problem: { code: string; detail: string }) => void;
}

export interface InitializeResult {
  models: Array<{ value?: string; resolvedModel?: string }> | null;
  account: JsonObject | null;
  hooksApplied: boolean | null;
  raw: JsonObject;
}

/** Hook events registered with the CLI at initialize time. */
export interface HookRegistration {
  event: string;
  callbackId: string;
  matcher?: string;
}

export interface SessionClientOptions {
  process: ClaudeProcessHandle;
  callbacks: SessionClientCallbacks;
  hooks: HookRegistration[];
  appendSystemPrompt: string | null;
  requestTimeoutMs?: number;
}

interface PendingOutbound {
  resolve: (value: JsonObject) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class SessionClient {
  private readonly proc: ClaudeProcessHandle;
  private readonly callbacks: SessionClientCallbacks;
  private readonly hooks: HookRegistration[];
  private readonly appendSystemPrompt: string | null;
  private readonly requestTimeoutMs: number;
  private readonly outbound = new Map<string, PendingOutbound>();
  private readonly inboundAborts = new Map<string, AbortController>();
  private readonly messages = new AsyncQueue<JsonObject>();
  private counter = 0;
  private closed = false;
  private exited = false;
  private exit_: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  private drainTimer: NodeJS.Timeout | null = null;
  private readonly exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;

  constructor(options: SessionClientOptions) {
    this.proc = options.process;
    this.callbacks = options.callbacks;
    this.hooks = options.hooks;
    this.appendSystemPrompt = options.appendSystemPrompt;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120000;
    this.exitPromise = new Promise((resolve) => {
      this.proc.on('exit', (code, signal) => {
        this.exited = true;
        this.exit_ = { code, signal };
        // Outbound control requests can no longer be answered.
        this.failAllOutbound(new EngineError('CLI_EXITED', `O processo Claude Code encerrou (código ${String(code)}${signal ? `, sinal ${signal}` : ''}).`));
        // The conversation queue is NOT ended here: stdout may still hold
        // complete frames — including the final `result` — that were written
        // before the process died. Ending now would discard the very evidence
        // the terminal outcome depends on. pump() closes the queue when the
        // stream really ends; the guard below bounds a stream that never does.
        this.armDrainDeadline();
        resolve({ code, signal });
      });
    });
    this.proc.on('error', (error) => {
      this.failAllOutbound(new EngineError('CLI_SPAWN_FAILED', `Falha ao executar o Claude Code instalado (${error.name}).`));
      this.messages.end();
    });
    if (this.proc.stderr) {
      this.proc.stderr.setEncoding('utf8');
      this.proc.stderr.on('data', (chunk: string) => this.callbacks.onStderr(chunk));
    }
    void this.pump();
  }

  get exit(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    return this.exitPromise;
  }

  /** How the process ended, or null while it is still running. */
  get exitInfo(): { code: number | null; signal: NodeJS.Signals | null } | null {
    return this.exit_;
  }

  /**
   * Waits briefly for the exit status so a caller can decide an outcome that
   * depends on it.
   *
   * stdout reaching its end and the process being reaped are separate events,
   * and the stream usually ends first. Without this wait, a caller that acts
   * the moment the conversation closes would see no exit status at all and
   * would have to guess why the session ended. Returns null when the process
   * is still running after the deadline — a fact, not a guess.
   */
  async settleExit(timeoutMs = 2000): Promise<{ code: number | null; signal: NodeJS.Signals | null } | null> {
    if (this.exit_) return this.exit_;
    await Promise.race([
      this.exitPromise,
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        timer.unref();
      }),
    ]);
    return this.exit_;
  }

  get hasExited(): boolean {
    return this.exited;
  }

  /** Bounds the post-exit drain so a stream that never ends cannot hang a run. */
  private armDrainDeadline(): void {
    if (this.drainTimer) return;
    this.drainTimer = setTimeout(() => {
      this.callbacks.onProblem({ code: 'STDOUT_DRAIN_TIMEOUT', detail: `saída não terminou em ${DRAIN_TIMEOUT_MS}ms após o encerramento do processo` });
      this.messages.end();
    }, DRAIN_TIMEOUT_MS);
    this.drainTimer.unref();
  }

  /** Conversation frames (system/assistant/user/result/stream_event/...). */
  conversation(): AsyncIterable<JsonObject> {
    return this.messages.iterable();
  }

  private failAllOutbound(error: Error): void {
    for (const [id, pending] of this.outbound) {
      clearTimeout(pending.timer);
      this.outbound.delete(id);
      pending.reject(error);
    }
    for (const [, controller] of this.inboundAborts) controller.abort();
    this.inboundAborts.clear();
  }

  private async pump(): Promise<void> {
    try {
      for await (const frame of readFrames(this.proc.stdout, this.callbacks.onProblem)) {
        const type = (frame as { type?: unknown }).type;
        if (type === 'control_response') {
          this.onControlResponse(frame as { response: { subtype: string; request_id: string; response?: JsonObject; error?: string } });
          continue;
        }
        if (type === 'control_request') {
          void this.onControlRequest(frame as ControlRequestFrame);
          continue;
        }
        if (type === 'control_cancel_request') {
          const id = String((frame as { request_id?: unknown }).request_id ?? '');
          this.inboundAborts.get(id)?.abort();
          continue;
        }
        if (type === 'keep_alive') continue;
        this.messages.push(frame as JsonObject);
      }
    } catch (error) {
      this.callbacks.onProblem({ code: 'STDOUT_READ_FAILED', detail: (error as Error).name });
    } finally {
      // stdout reached its real end: everything the CLI wrote has been read.
      if (this.drainTimer) clearTimeout(this.drainTimer);
      this.messages.end();
    }
  }

  private onControlResponse(frame: { response: { subtype: string; request_id: string; response?: JsonObject; error?: string } }): void {
    const response = frame.response;
    const pending = this.outbound.get(response.request_id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.outbound.delete(response.request_id);
    if (response.subtype === 'error') pending.reject(new EngineError('CONTROL_REQUEST_FAILED', response.error ?? 'pedido de controle recusado pelo CLI'));
    else pending.resolve(response.response ?? {});
  }

  private async onControlRequest(frame: ControlRequestFrame): Promise<void> {
    const requestId = frame.request_id;
    const subtype = frame.request.subtype;
    const controller = new AbortController();
    this.inboundAborts.set(requestId, controller);
    try {
      if (subtype === CONTROL_SUBTYPES.canUseTool) {
        const request = frame.request as unknown as {
          tool_name: string; input: JsonObject; tool_use_id: string; agent_id?: string;
          title?: string; display_name?: string; description?: string; decision_reason?: string; decision_reason_type?: string;
        };
        const answer = await this.callbacks.canUseTool(request.tool_name, request.input ?? {}, {
          toolUseId: request.tool_use_id,
          requestId,
          agentId: request.agent_id ?? null,
          title: request.title ?? null,
          displayName: request.display_name ?? null,
          description: request.description ?? null,
          decisionReason: request.decision_reason ?? null,
          decisionReasonType: request.decision_reason_type ?? null,
          signal: controller.signal,
        });
        this.respond(requestId, answer as unknown as JsonObject);
        return;
      }
      if (subtype === CONTROL_SUBTYPES.hookCallback) {
        const request = frame.request as unknown as { callback_id: string; input: JsonObject; tool_use_id?: string };
        const event = String((request.input as { hook_event_name?: unknown } | undefined)?.hook_event_name ?? '');
        const answer = await this.callbacks.onHook(event, request.input ?? {}, {
          callbackId: request.callback_id,
          toolUseId: request.tool_use_id ?? null,
          signal: controller.signal,
        });
        this.respond(requestId, answer as unknown as JsonObject);
        return;
      }
      // Unknown request types are refused explicitly so the CLI can fall back
      // to its own default instead of waiting forever.
      this.respondError(requestId, `pedido de controle não suportado: ${subtype}`);
    } catch (error) {
      this.respondError(requestId, `falha ao responder ${subtype} (${(error as Error).name})`);
    } finally {
      this.inboundAborts.delete(requestId);
    }
  }

  private respond(requestId: string, payload: JsonObject): void {
    if (this.closed || this.exited) return;
    try {
      writeFrame(this.proc.stdin, { type: 'control_response', response: { subtype: 'success', request_id: requestId, response: payload } });
    } catch (error) {
      this.callbacks.onProblem({ code: 'CONTROL_RESPONSE_LOST', detail: (error as Error).name });
    }
  }

  private respondError(requestId: string, message: string): void {
    if (this.closed || this.exited) return;
    try {
      writeFrame(this.proc.stdin, { type: 'control_response', response: { subtype: 'error', request_id: requestId, error: message } });
    } catch {
      // the process is already gone
    }
  }

  private request(subtype: string, extra: JsonObject = {}, timeoutMs = this.requestTimeoutMs): Promise<JsonObject> {
    if (this.closed || this.exited) return Promise.reject(new EngineError('CLI_EXITED', 'A sessão Claude Code já foi encerrada.'));
    this.counter += 1;
    const requestId = `req_${process.pid}_${this.counter}`;
    return new Promise<JsonObject>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.outbound.delete(requestId);
        try {
          writeFrame(this.proc.stdin, { type: 'control_response', response: { subtype: 'error', request_id: requestId, error: 'timeout' } });
        } catch { /* best effort */ }
        reject(new EngineError('CONTROL_REQUEST_TIMEOUT', `O CLI não respondeu ao pedido ${subtype} em ${timeoutMs}ms.`));
      }, timeoutMs);
      timer.unref();
      this.outbound.set(requestId, { resolve, reject, timer });
      try {
        // `subtype` last so an extra field can never shadow the request kind.
        writeFrame(this.proc.stdin, { type: 'control_request', request_id: requestId, request: { ...extra, subtype } });
      } catch (error) {
        clearTimeout(timer);
        this.outbound.delete(requestId);
        reject(error as Error);
      }
    });
  }

  /** Registers hooks and the appended system prompt before the first turn. */
  async initialize(): Promise<InitializeResult> {
    const byEvent: Record<string, Array<{ hookCallbackIds: string[]; matcher?: string }>> = {};
    for (const hook of this.hooks) {
      const list = byEvent[hook.event] ?? (byEvent[hook.event] = []);
      const existing = list.find((entry) => entry.matcher === hook.matcher);
      if (existing) existing.hookCallbackIds.push(hook.callbackId);
      else list.push({ hookCallbackIds: [hook.callbackId], ...(hook.matcher !== undefined ? { matcher: hook.matcher } : {}) });
    }
    const payload: JsonObject = { hooks: byEvent, systemPromptSnapshot: true };
    if (this.appendSystemPrompt) payload.appendSystemPrompt = this.appendSystemPrompt;
    const response = await this.request(CONTROL_SUBTYPES.initialize, payload, 60000);
    return {
      models: Array.isArray(response.models) ? (response.models as Array<{ value?: string; resolvedModel?: string }>) : null,
      account: (response.account as JsonObject | undefined) ?? null,
      hooksApplied: typeof response.hooks_applied === 'boolean' ? response.hooks_applied : null,
      raw: response,
    };
  }

  async interrupt(): Promise<{ stillQueued: string[] }> {
    const response = await this.request(CONTROL_SUBTYPES.interrupt, {}, 30000);
    return { stillQueued: Array.isArray(response.still_queued) ? (response.still_queued as string[]) : [] };
  }

  async setModel(model: string): Promise<void> {
    await this.request(CONTROL_SUBTYPES.setModel, { model }, 30000);
  }

  send(text: string, sessionId: string | null): void {
    if (this.closed || this.exited) throw new EngineError('CLI_EXITED', 'A sessão Claude Code já foi encerrada.');
    writeFrame(this.proc.stdin, {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      ...(sessionId ? { session_id: sessionId } : {}),
    });
  }

  /** Closes stdin so the CLI can shut down gracefully. */
  endInput(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.proc.stdin.end();
    } catch {
      // already closed
    }
  }

  /** Bounded teardown: graceful stdin close, then a scoped kill. */
  async close(graceMs = 4000): Promise<void> {
    this.endInput();
    if (this.exited) return;
    const timer = setTimeout(() => {
      try {
        this.proc.kill('SIGKILL');
      } catch {
        // already gone
      }
    }, graceMs);
    timer.unref();
    await this.exitPromise;
    clearTimeout(timer);
  }
}
