// Supervision is advisory: thresholds raise alerts and never terminate work.
import type { CoordinatorPresence, TaskState, WorkerPhase } from '../shared/types.ts';

export const SUPERVISION = {
  inactivityAlertMs: 1_200_000,
  elapsedAlertMs: 7_200_000,
  coordinatorAbsentMs: 90_000,
} as const;

export const COORDINATOR_ABSENT_LABEL = 'aguardando coordenador';

export interface SupervisionThresholds {
  inactivityAlertMs: number;
  elapsedAlertMs: number;
  coordinatorAbsentMs: number;
}

export interface SupervisionInput {
  now: number;
  runStartedAt: number;
  lastActivityAt: number;
  phase: WorkerPhase;
  processAlive: boolean;
  coordinatorLastSeenAt: number | null;
  pendingRequests: number;
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
  if (input.now - input.runStartedAt >= thresholds.elapsedAlertMs) alerts.push('elapsed_2h');
  const state: TaskState = waiting && input.phase !== 'waiting_permission' && input.phase !== 'waiting_question' ? 'waiting_permission' : input.phase;
  return { state, alerts, action: 'none', coordinatorPresence, coordinatorLabel, requiresReview: false };
}
