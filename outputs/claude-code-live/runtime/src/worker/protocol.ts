// IPC protocol between the broker (single writer of the event log) and a
// worker process (owner of one Claude Code session for one Codex task).
import type { JobContract } from '../contract/job-contract.ts';
import type { LaunchCustomizations } from '../trust/launch-customizations.ts';
import type { ActionSource, PendingRequestView, TransientFrame, TurnPolicyLevel, WorkerPhase } from '../shared/types.ts';

export interface WorkerDescriptor {
  taskId: string;
  runId: string;
  threadId: string;
  stateRoot: string;
  taskDir: string;
  runDir: string;
  contract: JobContract;
  prompt: string;
  resumeSessionId: string | null;
  resumeMode: 'new' | 'automatic' | 'explicit';
  launch: LaunchCustomizations;
  /** Declared capability of each approved MCP tool, keyed by full tool name. */
  approvedMcpTools: Record<string, { readOnly: boolean }>;
  /** Trusted subagent names the contract allows delegating to. */
  approvedAgents: string[];
  /** Trusted skill names the contract allows invoking. */
  approvedSkills: string[];
  executable: { path: string; runWith: 'node' | null; cliVersion: string | null };
  harness: { failPreparation?: string; adapterPath?: string; effortCap?: string; modelCatalog?: string[]; hooksApplied?: boolean; setModelDelayMs?: number } | null;
}

export type WorkerToBroker =
  | { t: 'ready'; simulated: boolean; adapter: string }
  | { t: 'event'; type: string; toolUseId?: string; data: Record<string, unknown> }
  | { t: 'phase'; phase: WorkerPhase; currentTool: string | null }
  | { t: 'transient'; frame: TransientFrame }
  | { t: 'request'; request: PendingRequestView }
  | { t: 'blob'; blobId: string; text: string; truncated: boolean; totalChars: number }
  | { t: 'turn_done'; interrupted: boolean }
  /** Outcome of a `set_model` request; the broker waits for it before applying. */
  | { t: 'model_result'; ok: boolean; model: string; activeModel: string; code: string | null }
  /** The CLI never confirmed a switch: which model is loaded is unknown. */
  | { t: 'model_uncertain'; model: string; previousModel: string; code: string }
  | { t: 'preparation_failed'; stage: string; code: string; message: string }
  | { t: 'run_ended'; status: 'COMPLETED' | 'FAIL' | 'CANCELLED'; code: string | null; message: string | null; exitCode: number };

export type BrokerToWorker =
  | { t: 'deliver'; messageId: string; text: string; source: ActionSource }
  | { t: 'answer'; requestId: string; decision: 'allow' | 'deny' | 'answer'; message?: string; answers?: Record<string, string | string[]>; source: ActionSource }
  | { t: 'interrupt'; source: ActionSource }
  | { t: 'end'; source: ActionSource }
  | { t: 'set_model'; model: string; reason: string; source: ActionSource }
  | { t: 'set_policy'; escalate: TurnPolicyLevel; reason: string; source: ActionSource }
  | { t: 'exit' };
