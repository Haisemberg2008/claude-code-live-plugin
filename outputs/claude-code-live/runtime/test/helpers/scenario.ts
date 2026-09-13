// Directive language understood by the harness-only fake Claude Code process
// (test/helpers/fake-claude-process.ts). Directives are embedded in user
// message text so each task or turn scripts its own fake behaviour.
//
// Directive strings such as "curl https://…" or "git push" are DATA for the
// simulator: nothing is ever executed by the fake.
//
//   say: TEXT              emit assistant text (stream deltas + completed message)
//   thinking: TEXT         emit a thinking block (must never be persisted)
//   tool: NAME {JSON}      emit tool_use, route it through PreToolUse/can_use_tool, emit tool_result
//   ask: QUESTION          emit an AskUserQuestion tool_use awaiting an answer
//   sleep: MS              stay busy in a harmless Bash "sleep" tool for MS ms (interruptible)
//   spawn: MS              spawn a real child+grandchild process tree (descendant regression)
//   big: N                 emit a text block with N characters
//   stderr: TEXT           write TEXT to the fake process stderr
//   fail: TEXT             end the turn with an error result
//   crash: CODE            die mid-turn with that exit code and no result
//   (plain text)           reply "Recebido: <text>"

export const ENV = {
  harness: 'CODEORQUESTRA_TEST_HARNESS',
  adapter: 'CODEORQUESTRA_TEST_ADAPTER',
  cli: 'CODEORQUESTRA_TEST_CLI',
  traceDir: 'CODEORQUESTRA_FAKE_TRACE_DIR',
  supervision: 'CODEORQUESTRA_TEST_SUPERVISION_MS',
  effortCap: 'CODEORQUESTRA_FAKE_EFFORT_CAP',
  modelCatalog: 'CODEORQUESTRA_FAKE_MODEL_CATALOG',
  usage: 'CODEORQUESTRA_FAKE_USAGE',
  cliVersion: 'CODEORQUESTRA_FAKE_CLI_VERSION',
  omitFlags: 'CODEORQUESTRA_FAKE_OMIT_FLAGS',
  hooksApplied: 'CODEORQUESTRA_FAKE_HOOKS_APPLIED',
  setModelDelay: 'CODEORQUESTRA_FAKE_SET_MODEL_DELAY_MS',
  authMethod: 'CODEORQUESTRA_FAKE_AUTH_METHOD',
  apiProvider: 'CODEORQUESTRA_FAKE_API_PROVIDER',
} as const;

export const FAKE_TRACE_DIR_ENV = ENV.traceDir;
export const TEST_ADAPTER_ENV = ENV.adapter;
export const TEST_HARNESS_ENV = ENV.harness;
export const TEST_SUPERVISION_ENV = ENV.supervision;
export const TEST_CLI_ENV = ENV.cli;
export const FAKE_EFFORT_CAP_ENV = ENV.effortCap;
export const FAKE_USAGE_ENV = ENV.usage;

export function script(lines: string[]): string {
  return lines.join('\n');
}

export function toolDirective(name: string, input: Record<string, unknown>): string {
  return `tool: ${name} ${JSON.stringify(input)}`;
}

export interface TraceEntry {
  ts: string;
  kind: 'query' | 'initialize' | 'canUseTool' | 'hook' | 'interrupt' | 'setModel' | 'result' | 'spawn' | 'error';
  data: Record<string, unknown>;
}

export interface LauncherTraceEntry {
  ts: string;
  args: string[];
  outcome: 'served' | 'FORBIDDEN_GENERATION';
}
