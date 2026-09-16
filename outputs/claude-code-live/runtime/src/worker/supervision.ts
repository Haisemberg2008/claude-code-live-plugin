// Supervision is advisory: thresholds raise alerts and never terminate work.
import type { CoordinatorPresence, TaskState, WorkerPhase } from '../shared/types.ts';

export const SUPERVISION = {
  inactivityAlertMs: 1_200_000,
  elapsedAlertMs: 7_200_000,
  coordinatorAbsentMs: 90_000,
  /**
   * Waiting for a decision is not idleness — but it is not progress either.
   *
   * A run blocked on a permission or a question makes no events, so it is
   * deliberately exempt from the inactivity alert. The consequence was that it
   * could sit for hours emitting nothing at all, which from outside is
   * indistinguishable from work in progress. This threshold says the other true
   * thing: nobody has answered, and the run is going nowhere until someone
   * does. Two minutes, because the cost of the alert is a line in the feed and
   * the cost of missing it is an afternoon.
   */
  decisionPendingMs: 120_000,
} as const;

export const COORDINATOR_ABSENT_LABEL = 'aguardando coordenador';

/**
 * A ratio, not a duration, so it lives outside the millisecond thresholds. At
 * 80% of any declared limit the run is still allowed to go on; the alert exists
 * so that exhaustion is never the first thing anyone hears about the budget.
 */
export const BUDGET_WARNING_RATIO = 0.8;

/** How full the presumed context window has to be before it is worth saying. */
export const CONTEXT_HIGH_RATIO = 0.8;

export interface SupervisionThresholds {
  inactivityAlertMs: number;
  elapsedAlertMs: number;
  coordinatorAbsentMs: number;
  decisionPendingMs: number;
}

export interface SupervisionInput {
  now: number;
  runStartedAt: number;
  lastActivityAt: number;
  phase: WorkerPhase;
  processAlive: boolean;
  coordinatorLastSeenAt: number | null;
  pendingRequests: number;
  /** When the oldest unanswered request arrived; null when none is pending. */
  oldestPendingRequestAt: number | null;
  /** Highest used/limit across the run's declared limits; null when the job set none. */
  budgetRatio: number | null;
  /** True once this run's tool history showed a loop. Reported, never acted on. */
  thrashing: boolean;
  /** Last turn's prompt over the presumed context window; null before the first turn. */
  contextRatio: number | null;
  brokerRestartedDuringRun: boolean;
  terminal: boolean;
  thresholds?: SupervisionThresholds;
}

export interface SupervisionResult {
  state: TaskState;
  alerts: string[];
  action: 'none';
  coordinatorPresence: CoordinatorPresence;
  coordinatorLabel: string | null;
  requiresReview: boolean;
}

export function evaluateSupervision(input: SupervisionInput): SupervisionResult {
  const thresholds = input.thresholds ?? SUPERVISION;
  const coordinatorPresence: CoordinatorPresence = input.coordinatorLastSeenAt !== null && input.now - input.coordinatorLastSeenAt < thresholds.coordinatorAbsentMs ? 'present' : 'absent';
  const coordinatorLabel = coordinatorPresence === 'absent' ? COORDINATOR_ABSENT_LABEL : null;
  if (input.terminal || input.phase === 'terminal') {
    return { state: 'terminal', alerts: [], action: 'none', coordinatorPresence, coordinatorLabel, requiresReview: false };
  }
  if (input.brokerRestartedDuringRun) {
    return { state: 'uncertain', alerts: [], action: 'none', coordinatorPresence, coordinatorLabel, requiresReview: true };
  }
  if (!input.processAlive) {
    return { state: 'disconnected', alerts: [], action: 'none', coordinatorPresence, coordinatorLabel, requiresReview: true };
  }
  const waiting = input.phase === 'waiting_permission' || input.phase === 'waiting_question' || input.pendingRequests > 0;
  const alerts: string[] = [];
  if (!waiting && input.now - input.lastActivityAt >= thresholds.inactivityAlertMs) alerts.push('inactivity_20m');
  // A separate claim from inactivity, not a replacement for it: `inactivity_20m`
  // still correctly stays silent while waiting, because waiting is not idling.
  if (waiting && input.oldestPendingRequestAt !== null && input.now - input.oldestPendingRequestAt >= thresholds.decisionPendingMs) alerts.push('decision_pending');
  if (input.now - input.runStartedAt >= thresholds.elapsedAlertMs) alerts.push('elapsed_2h');
  // The budget alerts do not depend on waiting: a run blocked on a decision has
  // spent what it spent. Exhaustion is enforced by the broker refusing the next
  // turn; here it is only named, like every other alert.
  // A loop is named as soon as the broker sees it in the tool history; like
  // every other alert it only says what is true. Restricting the run, ending
  // it after the turn, or letting it continue are all the coordinator's call.
  if (input.thrashing) alerts.push('thrashing');
  // A full context is not a failure, it is a warning that the next turn will
  // be compacted and something will be forgotten. Said early enough to plan
  // for, never acted on.
  if (input.contextRatio !== null && input.contextRatio >= CONTEXT_HIGH_RATIO) alerts.push('context_high');
  if (input.budgetRatio !== null) {
    if (input.budgetRatio >= BUDGET_WARNING_RATIO) alerts.push('budget_warning');
    if (input.budgetRatio >= 1) alerts.push('budget_exhausted');
  }
  const state: TaskState = waiting && input.phase !== 'waiting_permission' && input.phase !== 'waiting_question' ? 'waiting_permission' : input.phase;
  return { state, alerts, action: 'none', coordinatorPresence, coordinatorLabel, requiresReview: false };
}
