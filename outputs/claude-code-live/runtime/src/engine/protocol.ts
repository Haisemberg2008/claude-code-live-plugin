// Wire protocol of the installed Claude Code CLI in stream-json mode.
//
// CodeOrquestra drives the user's own, unmodified CLI installation: it spawns
// the resolved executable with `--input-format stream-json --output-format
// stream-json --verbose` and speaks the documented control protocol on the
// same stdio streams. No vendor SDK is imported or redistributed at runtime.
//
// Frames (one JSON document per line, UTF-8):
//   host -> cli   user messages, control_request, control_response
//   cli  -> host  system/assistant/user/result/stream_event, control_request,
//                 control_response, control_cancel_request, keep_alive
//
// The shapes below mirror the protocol the installed CLI documents for its
// stream-json surface. Field sets are intentionally partial: unknown frames
// and unknown fields are ignored rather than rejected, as the protocol is an
// open set that grows between CLI versions.

export type JsonObject = Record<string, unknown>;

export interface UserFrame {
  type: 'user';
  message: { role: 'user'; content: string | JsonObject[] };
  parent_tool_use_id: string | null;
  session_id?: string;
}

export interface ControlRequestFrame {
  type: 'control_request';
  request_id: string;
  request: JsonObject & { subtype: string };
}

export interface ControlSuccess {
  subtype: 'success';
  request_id: string;
  response?: JsonObject;
}

export interface ControlError {
  subtype: 'error';
  request_id: string;
  error: string;
}

export interface ControlResponseFrame {
  type: 'control_response';
  response: ControlSuccess | ControlError;
}

export interface ControlCancelFrame {
  type: 'control_cancel_request';
  request_id: string;
}

export type HostFrame = UserFrame | ControlRequestFrame | ControlResponseFrame;
export type CliFrame = ControlRequestFrame | ControlResponseFrame | ControlCancelFrame | ({ type: string } & JsonObject);

/** Permission answer carried in the control_response for `can_use_tool`. */
export type PermissionAnswer =
  | { behavior: 'allow'; updatedInput?: JsonObject }
  | { behavior: 'deny'; message: string; interrupt?: boolean };

/** Hook answer carried in the control_response for `hook_callback`. */
export interface HookAnswer {
  continue?: boolean;
  suppressOutput?: boolean;
  hookSpecificOutput?: JsonObject;
}

export const CONTROL_SUBTYPES = {
  initialize: 'initialize',
  interrupt: 'interrupt',
  setModel: 'set_model',
  canUseTool: 'can_use_tool',
  hookCallback: 'hook_callback',
} as const;

export interface CliLaunchPlan {
  /** Executable to run: the resolved installed CLI, or the node runtime. */
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
}

export interface BuildArgsInput {
  /** Absolute path of the installed CLI (native binary or bin script). */
  executablePath: string;
  /** 'node' when executablePath is a script that must run under node. */
  runWith: 'node' | null;
  model: string;
  effort: string;
  /** null keeps the CLI's own full coding tool preset. */
  tools: string[] | null;
  permissionMode: 'default' | 'dontAsk' | 'plan' | 'acceptEdits';
  /** 'host' routes prompts to us; 'none' denies anything that would prompt. */
  permissionPrompts: 'host' | 'none';
  /** Route permission prompts over this stdio control channel. */
  permissionPromptTool: boolean;
  settingSources: string[];
  strictMcpConfig: boolean;
  mcpServers: Record<string, unknown>;
  resumeSessionId: string | null;
  safeMode: boolean;
  restricted: boolean;
  additionalDirectories: string[];
  debugFile: string | null;
}

/**
 * Builds the CLI argument vector. Only flags the installed CLI advertises are
 * used; the caller verifies advertisement during preflight and refuses to
 * launch when a required flag is missing.
 */
export function buildCliArgs(input: BuildArgsInput): string[] {
  const args: string[] = ['--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--include-partial-messages'];
  args.push('--model', input.model);
  args.push('--effort', input.effort);
  if (input.tools === null) args.push('--tools', 'default');
  else if (input.tools.length === 0) args.push('--tools', '');
  else args.push('--tools', input.tools.join(','));
  args.push('--permission-mode', input.permissionMode);
  args.push('--permission-prompts', input.permissionPrompts);
  if (input.permissionPromptTool) args.push('--permission-prompt-tool', 'stdio');
  args.push(`--setting-sources=${input.settingSources.join(',')}`);
  if (input.strictMcpConfig) args.push('--strict-mcp-config');
  if (Object.keys(input.mcpServers).length > 0) args.push('--mcp-config', JSON.stringify({ mcpServers: input.mcpServers }));
  if (input.resumeSessionId) args.push(`--resume=${input.resumeSessionId}`);
  if (input.safeMode) args.push('--safe-mode');
  if (input.restricted) args.push('--restricted');
  for (const directory of input.additionalDirectories) args.push('--add-dir', directory);
  if (input.debugFile) args.push('--debug-file', input.debugFile);
  return args;
}

/** Flags this runtime depends on; preflight requires every one of them. */
export const REQUIRED_CLI_FLAGS = [
  '--output-format',
  '--input-format',
  '--verbose',
  '--include-partial-messages',
  '--model',
  '--effort',
  '--tools',
  '--permission-mode',
  '--permission-prompts',
  '--permission-prompt-tool',
  '--setting-sources',
  '--strict-mcp-config',
  '--mcp-config',
  '--resume',
] as const;

export function planLaunch(input: BuildArgsInput, cwd: string, env: Record<string, string | undefined>): CliLaunchPlan {
  const args = buildCliArgs(input);
  return input.runWith === 'node'
    ? { command: process.execPath, args: [input.executablePath, ...args], cwd, env }
    : { command: input.executablePath, args, cwd, env };
}
