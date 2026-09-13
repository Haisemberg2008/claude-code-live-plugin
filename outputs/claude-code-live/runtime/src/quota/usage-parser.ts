// Sanitized /usage parser (port of the legacy PowerShell parser with the same
// literal semantics) plus the advisory 3% recommendation.
import type { AuthorizedModel } from '../shared/types.ts';

export class UsageError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'UsageError';
    this.code = code;
  }
}

export interface UsageLimit {
  usedPercent: number;
  remainingPercent: number;
  resets: string;
}

export interface UsageSnapshot {
  session: UsageLimit;
  allModels: UsageLimit;
  fable: UsageLimit;
  alertLevel: 'ok' | 'warning' | 'critical';
  observedAt: string;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readLimit(text: string, label: string): UsageLimit {
  const pattern = new RegExp(`^${escapeRegExp(label)}:\\s*(\\d{1,3})% used.*?resets\\s+(.+)$`, 'im');
  const match = pattern.exec(text);
  if (!match) throw new UsageError('USAGE_FORMAT_UNEXPECTED', `Campo de uso não encontrado: ${label}`);
  const used = Number(match[1]);
  if (!Number.isInteger(used) || used < 0 || used > 100) throw new UsageError('USAGE_FORMAT_UNEXPECTED', `Percentual inválido: ${label}`);
  return { usedPercent: used, remainingPercent: 100 - used, resets: match[2]!.trim() };
}

export function parseUsageText(text: string, observedAt: string): UsageSnapshot {
  const session = readLimit(text, 'Current session');
  const allModels = readLimit(text, 'Current week (all models)');
  const fable = readLimit(text, 'Current week (Fable)');
  const minimum = Math.min(session.remainingPercent, allModels.remainingPercent, fable.remainingPercent);
  const alertLevel = minimum <= 5 ? 'critical' : minimum <= 20 ? 'warning' : 'ok';
  return { session, allModels, fable, alertLevel, observedAt };
}

export interface QuotaRecommendation {
  recommendation: 'ok' | 'consider_alternate' | 'shared_limit' | 'unknown';
  alternate: AuthorizedModel | null;
  blocking: false;
  thresholdPercent: number;
  effectiveRemainingPercent: number | null;
  observedAt: string | null;
  failure?: { code: string; attemptedAt: string };
}

export function evaluateQuotaRecommendation(input: {
  usage: UsageSnapshot | null;
  requestedModel: AuthorizedModel;
  failure?: { code: string; attemptedAt: string };
  thresholdPercent?: number;
}): QuotaRecommendation {
  const thresholdPercent = input.thresholdPercent ?? 3;
  if (!input.usage) {
    return {
      recommendation: 'unknown',
      alternate: null,
      blocking: false,
      thresholdPercent,
      effectiveRemainingPercent: null,
      observedAt: null,
      ...(input.failure ? { failure: input.failure } : {}),
    };
  }
  const shared = Math.min(input.usage.session.remainingPercent, input.usage.allModels.remainingPercent);
  if (shared <= thresholdPercent) {
    return { recommendation: 'shared_limit', alternate: null, blocking: false, thresholdPercent, effectiveRemainingPercent: shared, observedAt: input.usage.observedAt };
  }
  if (input.requestedModel === 'claude-fable-5-1') {
    const effective = Math.min(shared, input.usage.fable.remainingPercent);
    if (effective <= thresholdPercent) {
      return { recommendation: 'consider_alternate', alternate: 'claude-opus-5', blocking: false, thresholdPercent, effectiveRemainingPercent: effective, observedAt: input.usage.observedAt };
    }
    return { recommendation: 'ok', alternate: null, blocking: false, thresholdPercent, effectiveRemainingPercent: effective, observedAt: input.usage.observedAt };
  }
  return { recommendation: 'ok', alternate: null, blocking: false, thresholdPercent, effectiveRemainingPercent: shared, observedAt: input.usage.observedAt };
}
