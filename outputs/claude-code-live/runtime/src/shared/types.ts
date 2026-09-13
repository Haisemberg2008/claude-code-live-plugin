// Types shared by the backend (broker, worker, MCP adapter, CLI) and the
// dashboard. This module must stay free of Node-only imports.

export const BRAND = {
  name: 'CodeOrquestra',
  tagline: 'Codex com Opus e Fable',
  /** Primary technical identifier for new artifacts. */
  technicalId: 'codeorquestra',
  /** Documented legacy alias: installed plugin, skill and state paths keep it. */
  legacyTechnicalId: 'claude-code-live',
  disclaimer: 'Integração local independente que apenas controla o Claude Code já instalado pelo usuário; não é produto oficial nem parceria entre OpenAI e Anthropic.',
} as const;

export const RUNTIME_VERSION = '0.1.0';

export type Owner = 'codex' | 'claude' | 'user' | 'not_applicable';
export const RESPONSIBILITY_KEYS = ['planning', 'inspection', 'implementation', 'testing', 'review', 'commit', 'push', 'deploy'] as const;
export type ResponsibilityKey = (typeof RESPONSIBILITY_KEYS)[number];
export type Responsibilities = Record<ResponsibilityKey, Owner>;

export interface Coordination {
  phase: 'planning' | 'execution';
  scopeId: string;
  approvalRevision: number;
  planSummary: string;
  planApproved: boolean;
  responsibilities: Responsibilities;
}

export type AuthorizedModel = 'claude-fable-5-1' | 'claude-opus-5';
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Phases reported by the worker process itself. */
export type WorkerPhase = 'starting' | 'busy_model' | 'busy_tool' | 'waiting_permission' | 'waiting_question' | 'idle' | 'terminal';
/** Task states as seen by the broker (worker phase plus liveness). */
export type TaskState = WorkerPhase | 'disconnected' | 'uncertain';
/** TIMEOUT only exists in legacy (v1) history; v2 never produces it. */
export type RunStatus = 'STARTING' | 'RUNNING' | 'COMPLETED' | 'FAIL' | 'BLOCKED' | 'CANCELLED' | 'UNCERTAIN' | 'TIMEOUT';
export type ActionSource = 'browser' | 'local-secret' | 'mcp' | 'system' | 'worker';
export type CoordinatorPresence = 'present' | 'absent';

export interface EventInput {
  type: string;
  taskId: string;
  runId: string;
  threadId?: string;
  toolUseId?: string;
  data: Record<string, unknown>;
}

export interface EventRecord extends EventInput {
  seq: number;
  /** Broker-wide sequence, assigned by the broker (the single writer). */
  gseq?: number;
  ts: string;
}

/** Live-only frame (never persisted): redacted progress of the current text block. */
export interface TransientFrame {
  kind: 'text_progress';
  taskId: string;
  runId: string;
  blockId: string;
  text: string;
  ts: string;
}

export interface PendingRequestView {
  requestId: string;
  runId: string;
  kind: 'permission' | 'question';
  tool: string;
  reason: string;
  message: string;
  inputPreview: string;
  questions: Array<{ question: string; header?: string; options: Array<{ label: string; description?: string }>; multiSelect?: boolean }>;
  createdAt: string;
  state: 'pending' | 'resolved';
}

export interface QueueEntryView {
  messageId: string;
  source: ActionSource;
  textPreview: string;
  receivedAt: string;
  deliveredAt: string | null;
  state: 'queued' | 'delivered' | 'requires_review';
}

export interface QuotaView {
  observedAt: string | null;
  attemptedAt: string | null;
  recommendation: 'ok' | 'consider_alternate' | 'shared_limit' | 'unknown';
  alternate: AuthorizedModel | null;
  snapshot: null | {
    session: { usedPercent: number; remainingPercent: number; resets: string };
    allModels: { usedPercent: number; remainingPercent: number; resets: string };
    fable: { usedPercent: number; remainingPercent: number; resets: string };
    alertLevel: 'ok' | 'warning' | 'critical';
  };
  failure: null | { code: string; attemptedAt: string };
}

export type UsageQuality = 'reported' | 'estimated' | 'partial' | 'unavailable';

export interface ClaudeModelUsage {
  model: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  totalInputTokens: number;
  totalObservedTokens: number;
  quality: 'reported' | 'partial';
}

export interface ClaudeUsageView {
  quality: 'reported' | 'partial' | 'unavailable';
  observedAt: string | null;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  totalInputTokens: number;
  totalObservedTokens: number;
  byModel: ClaudeModelUsage[];
}

export interface CodexRateLimitWindow {
  usedPercent: number;
  remainingPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface CodexRateLimitBucket {
  id: string;
  name: string | null;
  planType: string | null;
  primary: CodexRateLimitWindow | null;
  secondary: CodexRateLimitWindow | null;
}

export interface CodexUsageView {
  quality: 'reported' | 'partial' | 'unavailable';
  queriedAt: string | null;
  limits: { quality: 'reported' | 'partial' | 'unavailable'; buckets: CodexRateLimitBucket[] };
  activity: {
    quality: 'reported' | 'partial' | 'unavailable';
    lifetimeTokens: number | null;
    peakDailyTokens: number | null;
    longestRunningTurnSec: number | null;
    currentStreakDays: number | null;
    longestStreakDays: number | null;
    daily: Array<{ startDate: string; tokens: number }>;
  };
  task: {
    quality: 'estimated' | 'partial' | 'unavailable';
    groups: Array<{
      model: string | null;
      reasoningEffort: string | null;
      inputTokens: number | null;
      cachedInputTokens: number | null;
      netNewInputTokens: number | null;
      outputTokens: number | null;
      totalTokens: number | null;
    }>;
  };
  failure: { code: string } | null;
}

export interface HybridUsageView {
  claude: ClaudeUsageView;
  codex: CodexUsageView;
}

export interface RunView {
  runId: string;
  status: RunStatus;
  sessionId: string | null;
  requestedModel: string;
  modelReason: string;
  observedModel: string | null;
  effortConfigured: EffortLevel;
  /** Effort the CLI reported it will send (system/init); null when not reported. */
  effortObservedByCli: string | null;
  /** Server-side confirmation does not exist in the current SDK; always null. */
  effortConfirmed: null;
  currentTool: string | null;
  workerPid: number | null;
  failureStage: string | null;
  failureCode: string | null;
  telemetryFailures: number;
  startedAt: string;
  endedAt: string | null;
  lastActivityAt: string | null;
  elapsedSeconds: number;
  turns: number;
  profile: string;
  contractVersion: 1 | 2;
  resumeMode: 'new' | 'automatic' | 'explicit';
}

export interface TaskView {
  taskId: string;
  threadId: string;
  workspace: string | null;
  state: TaskState;
  simulated: boolean;
  alerts: string[];
  coordinatorPresence: CoordinatorPresence;
  coordinatorLastSeenAt: string | null;
  coordinatorLabel: string | null;
  requiresReview: boolean;
  currentRun: RunView | null;
  previousSessionId: string | null;
  pendingRequests: PendingRequestView[];
  queue: QueueEntryView[];
  quota: QuotaView;
  usage: HybridUsageView;
  changedFiles: { observed: string[]; claudeAuthored: string[]; observedAt: string | null };
  reviewPending: boolean;
  createdAt: string;
  updatedAt: string;
  lastEventSeq: number;
}

export interface BrokerInfo {
  version: string;
  tagline: string;
  startedAt: string;
  pid: number;
  simulatedAdapter: boolean;
}

export interface StatusResponse {
  broker: BrokerInfo;
  identity: { source: ActionSource; taskScope: string | null };
  tasks: TaskView[];
  /** Increments whenever the broker restarts; clients reset their cursor. */
  cursorEpoch: string;
}
