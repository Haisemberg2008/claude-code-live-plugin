// Harness-only fake of the installed Claude Code process.
//
// It speaks the SAME newline-delimited stream-json control protocol the real
// CLI does, over in-memory pipes, so framing, control correlation, hooks,
// permission prompts, interrupt and set_model are all exercised for real while
// no authenticated CLI is ever started. It never reaches a network and never
// executes the command strings it is given: those are data for the simulator.
import { appendFileSync, mkdirSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import readline from 'node:readline';
import { readEnv } from '../../src/shared/env.ts';
import type { CliLaunchPlan } from '../../src/engine/protocol.ts';
import type { ClaudeProcessHandle } from '../../src/engine/transport.ts';

type Dict = Record<string, unknown>;

function traceFile(): string | null {
  const dir = readEnv('FAKE_TRACE_DIR');
  if (!dir) return null;
  mkdirSync(dir, { recursive: true });
  return path.join(dir, `${process.pid}.jsonl`);
}

function trace(kind: string, data: Dict): void {
  const file = traceFile();
  if (!file) return;
  appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), kind, data })}\n`, 'utf8');
}

interface ParsedArgs {
  model: string | null;
  effort: string | null;
  tools: string | null;
  permissionMode: string | null;
  permissionPrompts: string | null;
  permissionPromptTool: string | null;
  settingSources: string | null;
  strictMcpConfig: boolean;
  mcpServers: string[];
  resume: string | null;
  includePartialMessages: boolean;
  outputFormat: string | null;
  inputFormat: string | null;
  safeMode: boolean;
  restricted: boolean;
  addDirs: string[];
}

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    model: null, effort: null, tools: null, permissionMode: null, permissionPrompts: null, permissionPromptTool: null,
    settingSources: null, strictMcpConfig: false, mcpServers: [], resume: null, includePartialMessages: false,
    outputFormat: null, inputFormat: null, safeMode: false, restricted: false, addDirs: [],
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const value = args[index + 1];
    switch (arg) {
      case '--model': parsed.model = value ?? null; index += 1; break;
      case '--effort': parsed.effort = value ?? null; index += 1; break;
      case '--tools': parsed.tools = value ?? ''; index += 1; break;
      case '--permission-mode': parsed.permissionMode = value ?? null; index += 1; break;
      case '--permission-prompts': parsed.permissionPrompts = value ?? null; index += 1; break;
      case '--permission-prompt-tool': parsed.permissionPromptTool = value ?? null; index += 1; break;
      case '--strict-mcp-config': parsed.strictMcpConfig = true; break;
      case '--include-partial-messages': parsed.includePartialMessages = true; break;
      case '--safe-mode': parsed.safeMode = true; break;
      case '--restricted': parsed.restricted = true; break;
      case '--output-format': parsed.outputFormat = value ?? null; index += 1; break;
      case '--input-format': parsed.inputFormat = value ?? null; index += 1; break;
      case '--add-dir': if (value) parsed.addDirs.push(value); index += 1; break;
      case '--mcp-config': {
        try {
          parsed.mcpServers = Object.keys((JSON.parse(value ?? '{}') as { mcpServers?: Dict }).mcpServers ?? {});
        } catch {
          parsed.mcpServers = [];
        }
        index += 1;
        break;
      }
      default:
        if (arg.startsWith('--setting-sources=')) parsed.settingSources = arg.slice('--setting-sources='.length);
        else if (arg.startsWith('--resume=')) parsed.resume = arg.slice('--resume='.length);
        break;
    }
  }
  return parsed;
}

function parseDirectives(text: string): Array<{ kind: string; arg: string }> {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const known = ['say', 'thinking', 'tool', 'ask', 'sleep', 'spawn', 'big', 'stderr', 'fail', 'crash'];
  const directives: Array<{ kind: string; arg: string }> = [];
  let hasDirective = false;
  for (const line of lines) {
    const match = /^([a-z]+):\s*(.*)$/.exec(line);
    if (match && known.includes(match[1]!)) {
      hasDirective = true;
      directives.push({ kind: match[1]!, arg: match[2] ?? '' });
    }
  }
  if (!hasDirective) directives.push({ kind: 'say', arg: `Recebido: ${text.slice(0, 200)}` });
  return directives;
}

const DEFAULT_CATALOG = [
  { value: 'fable', resolvedModel: 'claude-fable-5-1', displayName: 'Fable 5.1', description: 'simulado' },
  { value: 'opus', resolvedModel: 'claude-opus-5', displayName: 'Opus 5', description: 'simulado' },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet 5', description: 'simulado' },
];

export const spawnClaudeProcess = (plan: CliLaunchPlan): ClaudeProcessHandle => {
  const args = parseArgs(plan.args);
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter();
  /** Kept only so the handles stay referenced; never used to tidy up on exit. */
  const children: ChildProcess[] = [];
  let exitCode: number | null = null;
  let closed = false;
  let interrupted = false;
  let sleeper: { cancel: () => void } | null = null;
  let model = args.model ?? 'claude-fable-5-1';
  const effortCap = readEnv('FAKE_EFFORT_CAP');
  const effort = effortCap ?? args.effort;
  const catalogOverride = readEnv('FAKE_MODEL_CATALOG');
  const catalog = catalogOverride ? catalogOverride.split(',').filter(Boolean).map((value) => ({ value, resolvedModel: value, displayName: value, description: 'simulado' })) : DEFAULT_CATALOG;
  const sessionId = args.resume ?? randomUUID();
  let hookCallbackId: string | null = null;
  let appendedPrompt: string | null = null;
  let toolCounter = 0;
  let turnCounter = 0;
  let requestCounter = 0;
  const permissionDenials: Dict[] = [];
  const pendingHostAnswers = new Map<string, (response: Dict | null) => void>();

  trace('query', {
    model,
    effort: args.effort,
    permissionMode: args.permissionMode,
    permissionPrompts: args.permissionPrompts,
    permissionPromptTool: args.permissionPromptTool,
    cwd: plan.cwd,
    includePartialMessages: args.includePartialMessages,
    outputFormat: args.outputFormat,
    inputFormat: args.inputFormat,
    settingSourcesMode: args.settingSources === null ? 'default' : args.settingSources === '' ? 'pending-trust' : args.settingSources,
    strictMcpConfig: args.strictMcpConfig,
    mcpServers: args.mcpServers,
    tools: args.tools,
    resume: args.resume,
    safeMode: args.safeMode,
    restricted: args.restricted,
    // The resolved installed executable is always passed explicitly: either as
    // the command itself, or as the first argument when it runs under node.
    command: path.basename(plan.command),
    entryArg: plan.args[0] ?? null,
    envHasApiKey: Boolean(plan.env.ANTHROPIC_API_KEY),
    envHasProviderSwitch: Boolean(plan.env.CLAUDE_CODE_USE_BEDROCK ?? plan.env.CLAUDE_CODE_USE_VERTEX ?? plan.env.ANTHROPIC_BASE_URL),
    autoMemoryDisabled: plan.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY === '1',
    entrypoint: plan.env.CLAUDE_CODE_ENTRYPOINT ?? null,
    vendorSdkImported: false,
  });

  const write = (frame: Dict): void => {
    if (closed) return;
    stdout.write(`${JSON.stringify(frame)}\n`);
  };
  const emit = (frame: Dict): void => write({ ...frame, session_id: sessionId, uuid: randomUUID() });

  const askHost = (request: Dict): Promise<Dict | null> => {
    requestCounter += 1;
    const requestId = `cli_req_${requestCounter}`;
    return new Promise((resolve) => {
      pendingHostAnswers.set(requestId, resolve);
      write({ type: 'control_request', request_id: requestId, request: request });
    });
  };

  const sleepInterruptible = (ms: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(() => { sleeper = null; resolve(); }, ms);
    sleeper = { cancel: () => { clearTimeout(timer); sleeper = null; resolve(); } };
  });

  const say = (text: string): void => {
    const index = 0;
    if (args.includePartialMessages) {
      emit({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', index, content_block: { type: 'text', text: '' } } });
      const chunks = text.length > 4096 ? text.match(/[\s\S]{1,4096}/g) ?? [text] : [text.slice(0, Math.ceil(text.length / 2)), text.slice(Math.ceil(text.length / 2))].filter(Boolean);
      for (const chunk of chunks) emit({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index, delta: { type: 'text_delta', text: chunk } } });
      emit({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_stop', index } });
    }
    emit({ type: 'assistant', parent_tool_use_id: null, message: { id: `msg_${randomUUID()}`, role: 'assistant', model, content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: text.length } } });
  };

  const execute = async (name: string, input: Dict): Promise<{ text: string; isError: boolean }> => {
    if (name === 'Bash' && typeof input.command === 'string' && /^sleep\s+([\d.]+)/.test(input.command)) {
      const seconds = Number(/^sleep\s+([\d.]+)/.exec(input.command)![1]);
      await sleepInterruptible(seconds * 1000);
      return { text: interrupted ? '[fake] sleep interrompido' : `[fake] slept ${seconds}s`, isError: false };
    }
    if (name === 'AskUserQuestion') return { text: `[fake] respostas: ${JSON.stringify(input.answers ?? {})}`, isError: false };
    if (name === 'Read') return { text: `[fake] conteúdo simulado de ${String(input.file_path ?? '')}`, isError: false };
    return { text: `[fake] ${name} executado (simulado)`, isError: false };
  };

  const runTool = async (name: string, input: Dict): Promise<void> => {
    toolCounter += 1;
    const id = `toolu_fake_${toolCounter}`;
    emit({ type: 'assistant', parent_tool_use_id: null, message: { id: `msg_${randomUUID()}`, role: 'assistant', model, content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } } });
    let decision: string | undefined;
    let decisionReason: string | undefined;
    if (hookCallbackId && name !== 'AskUserQuestion') {
      const response = await askHost({
        subtype: 'hook_callback',
        callback_id: hookCallbackId,
        tool_use_id: id,
        input: { hook_event_name: 'PreToolUse', tool_name: name, tool_input: input, tool_use_id: id, session_id: sessionId, cwd: plan.cwd, permission_mode: args.permissionMode ?? 'default' },
      });
      const specific = (response?.hookSpecificOutput ?? {}) as Dict;
      decision = typeof specific.permissionDecision === 'string' ? specific.permissionDecision : undefined;
      decisionReason = typeof specific.permissionDecisionReason === 'string' ? specific.permissionDecisionReason : undefined;
      trace('hook', { event: 'PreToolUse', tool: name, decision: decision ?? null });
    }
    let result: { text: string; isError: boolean };
    if (decision === 'deny') {
      permissionDenials.push({ tool_name: name, tool_use_id: id, tool_input: input });
      emit({ type: 'system', subtype: 'permission_denied', tool_name: name, tool_use_id: id, message: decisionReason ?? 'negado pelo hook', decision_reason_type: 'hook' });
      result = { text: `Permission denied by PreToolUse hook: ${decisionReason ?? ''}`, isError: true };
    } else if (decision === 'allow') {
      result = await execute(name, input);
    } else {
      // Anything the hook did not pre-approve goes to the host prompt surface.
      const response = await askHost({
        subtype: 'can_use_tool',
        tool_name: name,
        input,
        tool_use_id: id,
        title: `Claude quer usar ${name}`,
        ...(decisionReason ? { decision_reason: decisionReason, decision_reason_type: 'hook' } : {}),
      });
      const behavior = typeof response?.behavior === 'string' ? response.behavior : 'deny';
      trace('canUseTool', { tool: name, resolution: behavior, message: behavior === 'deny' ? String(response?.message ?? '') : null });
      if (behavior === 'allow') {
        const updated = (response?.updatedInput && typeof response.updatedInput === 'object' ? response.updatedInput : input) as Dict;
        result = await execute(name, updated);
      } else {
        permissionDenials.push({ tool_name: name, tool_use_id: id, tool_input: input });
        result = { text: `Permission denied: ${String(response?.message ?? 'negado')}`, isError: true };
      }
    }
    emit({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: result.text, is_error: result.isError }] } });
  };

  const spawnTree = (ms: number): void => {
    const script = `const cp=require('node:child_process');const g=cp.spawn(process.execPath,['-e','setTimeout(()=>{}, ${ms})'],{stdio:'ignore'});process.stdout.write(JSON.stringify({child:process.pid,grandchild:g.pid})+'\\n');setTimeout(()=>{}, ${ms});`;
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    children.push(child);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      try {
        const pids = JSON.parse(chunk.trim()) as { child: number; grandchild: number };
        trace('spawn', { pids: [pids.child, pids.grandchild] });
      } catch {
        // ignore
      }
    });
  };

  const runTurn = async (text: string): Promise<void> => {
    turnCounter += 1;
    interrupted = false;
    let lastText = '';
    let failed: string | null = null;
    const started = Date.now();
    for (const directive of parseDirectives(text)) {
      if (interrupted || closed) break;
      switch (directive.kind) {
        case 'say': say(directive.arg); lastText = directive.arg; break;
        case 'thinking':
          if (args.includePartialMessages) {
            emit({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } });
            emit({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: directive.arg } } });
          }
          emit({ type: 'assistant', parent_tool_use_id: null, message: { id: `msg_${randomUUID()}`, role: 'assistant', model, content: [{ type: 'thinking', thinking: directive.arg, signature: 'fake-signature' }], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } });
          break;
        case 'tool': {
          const space = directive.arg.indexOf(' ');
          const name = space < 0 ? directive.arg : directive.arg.slice(0, space);
          let input: Dict = {};
          try { input = space < 0 ? {} : JSON.parse(directive.arg.slice(space + 1)) as Dict; } catch { input = { raw: directive.arg }; }
          await runTool(name, input);
          break;
        }
        case 'ask':
          await runTool('AskUserQuestion', { questions: [{ question: directive.arg, header: 'Decisão', options: [{ label: 'Sim', description: 'Confirmar' }, { label: 'Não', description: 'Recusar' }], multiSelect: false }] });
          break;
        case 'sleep':
          await runTool('Bash', { command: `sleep ${Number(directive.arg) / 1000}` });
          break;
        case 'spawn':
          spawnTree(Number(directive.arg) || 60000);
          say('processos filhos criados (simulação)');
          break;
        case 'big': {
          const size = Number(directive.arg) || 20000;
          const big = Array.from({ length: Math.ceil(size / 10) }, (_, i) => `bloco${i} `).join('').slice(0, size);
          say(big);
          lastText = 'saída grande';
          break;
        }
        case 'stderr': stderr.write(`${directive.arg}\n`); break;
        case 'fail': failed = directive.arg; break;
        case 'crash':
          // Dies like a real CLI that fell over: no result frame, a non-zero
          // exit, and nobody asked for the session to close.
          trace('error', { crash: directive.arg });
          finish(Number(directive.arg) || 1);
          return;
        default: break;
      }
    }
    const base = {
      duration_ms: Date.now() - started,
      duration_api_ms: 1,
      num_turns: turnCounter,
      stop_reason: interrupted ? 'interrupted' : 'end_turn',
      total_cost_usd: 0,
      usage: { input_tokens: 10, output_tokens: 10 },
      modelUsage: {},
      permission_denials: permissionDenials.splice(0),
    };
    trace('result', { turn: turnCounter, interrupted, failed: failed !== null, model });
    if (failed !== null) emit({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [failed], ...base });
    else emit({ type: 'result', subtype: 'success', is_error: false, result: interrupted ? '[interrompido]' : lastText, ...(interrupted ? { terminal_reason: 'aborted_tools' } : {}), ...base });
  };

  // Serializes turns: the CLI processes one user message at a time.
  let turnChain: Promise<unknown> = Promise.resolve();
  const enqueueTurn = (text: string): void => {
    turnChain = turnChain.then(() => runTurn(text), () => runTurn(text));
  };

  const respond = (requestId: string, payload: Dict): void => write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: payload } });

  const reader = readline.createInterface({ input: stdin, crlfDelay: Infinity });
  reader.on('line', (line) => {
    if (!line.trim()) return;
    let frame: Dict;
    try {
      frame = JSON.parse(line) as Dict;
    } catch {
      return;
    }
    if (frame.type === 'control_response') {
      const response = frame.response as { request_id: string; subtype: string; response?: Dict } | undefined;
      if (!response) return;
      const resolve = pendingHostAnswers.get(response.request_id);
      if (resolve) {
        pendingHostAnswers.delete(response.request_id);
        resolve(response.subtype === 'success' ? response.response ?? {} : null);
      }
      return;
    }
    if (frame.type === 'control_request') {
      const requestId = String(frame.request_id ?? '');
      const request = (frame.request ?? {}) as Dict;
      const subtype = String(request.subtype ?? '');
      if (subtype === 'initialize') {
        const hooks = (request.hooks ?? {}) as Record<string, Array<{ hookCallbackIds?: string[] }>>;
        hookCallbackId = hooks.PreToolUse?.[0]?.hookCallbackIds?.[0] ?? null;
        appendedPrompt = typeof request.appendSystemPrompt === 'string' ? request.appendSystemPrompt : null;
        trace('initialize', { hookEvents: Object.keys(hooks), hasAppendSystemPrompt: Boolean(appendedPrompt), systemPromptSnapshot: request.systemPromptSnapshot === true });
        // The harness can simulate a CLI build that does NOT apply our hooks.
        const hooksApplied = readEnv('FAKE_HOOKS_APPLIED') === 'false' ? false : hookCallbackId !== null;
        respond(requestId, { commands: [], agents: [], output_style: 'default', available_output_styles: ['default'], models: catalog, account: { subscriptionType: 'simulado', apiProvider: 'firstParty' }, hooks_applied: hooksApplied });
        // The CLI announces the session right after it is configured.
        emit({
          type: 'system', subtype: 'init', model, effort, apiKeySource: 'none', claude_code_version: '2.1.263-fake',
          cwd: plan.cwd, tools: (args.tools === 'default' ? ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep', 'AskUserQuestion'] : (args.tools ?? '').split(',').filter(Boolean)),
          mcp_servers: args.mcpServers.map((name) => ({ name, status: 'connected' })), permissionMode: args.permissionMode ?? 'default',
          slash_commands: [], output_style: 'default', skills: [], plugins: [], capabilities: ['interrupt_receipt_v1'],
        });
        return;
      }
      if (subtype === 'interrupt') {
        trace('interrupt', {});
        interrupted = true;
        sleeper?.cancel();
        respond(requestId, { still_queued: [] });
        return;
      }
      if (subtype === 'set_model') {
        const next = typeof request.model === 'string' ? request.model : 'claude-fable-5-1';
        trace('setModel', { model: next });
        // A configurable delay makes the in-flight window deterministic, so a
        // test can observe the reservation instead of racing it.
        const delay = Number(readEnv('FAKE_SET_MODEL_DELAY_MS') ?? '0') || 0;
        const apply = (): void => {
          model = next;
          respond(requestId, {});
        };
        if (delay > 0) setTimeout(apply, delay).unref();
        else apply();
        return;
      }
      write({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error: `unsupported: ${subtype}` } });
      return;
    }
    if (frame.type === 'user') {
      const content = (frame.message as { content?: unknown } | undefined)?.content;
      const text = typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.map((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : '')).join('\n')
          : '';
      enqueueTurn(text);
    }
  });

  const finish = (code: number): void => {
    if (closed) return;
    closed = true;
    exitCode = code;
    // Children are deliberately NOT killed here. A real CLI that dies does not
    // tidy up the tool processes it started, and the runtime must prove they
    // are gone on its own; cleaning them here would hide exactly that.
    for (const resolve of pendingHostAnswers.values()) resolve(null);
    pendingHostAnswers.clear();
    sleeper?.cancel();
    reader.close();
    stdout.end();
    stderr.end();
    setImmediate(() => emitter.emit('exit', code, null));
  };

  // Host closed stdin: finish the current turn, then exit like the CLI does.
  stdin.on('end', () => {
    void turnChain.then(() => setTimeout(() => finish(0), 20)).catch(() => finish(0));
  });

  const handle: ClaudeProcessHandle = {
    pid: process.pid,
    stdin,
    stdout,
    stderr,
    get exitCode() { return exitCode; },
    kill() { finish(143); },
    on(event: 'exit' | 'error', listener: (...eventArgs: never[]) => void) { emitter.on(event, listener as (...listenerArgs: unknown[]) => void); },
  };
  return handle;
};
