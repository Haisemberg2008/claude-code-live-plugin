import type { ClaudeUsageView, EventRecord } from '../shared/types.ts';

export interface NormalizedClaudeTurnUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  totalInputTokens: number;
  totalObservedTokens: number;
  quality: 'reported' | 'partial';
}

function token(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export interface ClaudeUsageReport {
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
}

export function sanitizeClaudeUsageReport(value: unknown): ClaudeUsageReport | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const usage = value as Record<string, unknown>;
  const report = {
    input_tokens: token(usage.input_tokens ?? usage.inputTokens ?? usage.input),
    output_tokens: token(usage.output_tokens ?? usage.outputTokens ?? usage.output),
    cache_read_input_tokens: token(usage.cache_read_input_tokens ?? usage.cachedInputTokens ?? usage.cacheRead),
    cache_creation_input_tokens: token(usage.cache_creation_input_tokens ?? usage.cacheWriteInputTokens ?? usage.cacheWrite),
  };
  return Object.values(report).some((item) => item !== null) ? report : null;
}

export function normalizeClaudeUsage(value: unknown): NormalizedClaudeTurnUsage | null {
  const usage = sanitizeClaudeUsageReport(value);
  if (!usage) return null;
  const inputTokens = usage.input_tokens;
  const outputTokens = usage.output_tokens;
  const cachedInputTokens = usage.cache_read_input_tokens;
  const cacheWriteInputTokens = usage.cache_creation_input_tokens;
  const totalInputTokens = (inputTokens ?? 0) + (cachedInputTokens ?? 0) + (cacheWriteInputTokens ?? 0);
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    totalInputTokens,
    totalObservedTokens: totalInputTokens + (outputTokens ?? 0),
    quality: [inputTokens, outputTokens, cachedInputTokens, cacheWriteInputTokens].every((item) => item !== null) ? 'reported' : 'partial',
  };
}

interface MutableTotal {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  totalInputTokens: number;
  totalObservedTokens: number;
  partial: boolean;
}

function emptyTotal(): MutableTotal {
  return { turns: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, totalInputTokens: 0, totalObservedTokens: 0, partial: false };
}

function add(total: MutableTotal, usage: NormalizedClaudeTurnUsage): void {
  total.turns += 1;
  total.inputTokens += usage.inputTokens ?? 0;
  total.outputTokens += usage.outputTokens ?? 0;
  total.cachedInputTokens += usage.cachedInputTokens ?? 0;
  total.cacheWriteInputTokens += usage.cacheWriteInputTokens ?? 0;
  total.totalInputTokens += usage.totalInputTokens;
  total.totalObservedTokens += usage.totalObservedTokens;
  total.partial ||= usage.quality === 'partial';
}

export interface ClaudeUsageSnapshot {
  version: 1;
  seen: string[];
  total: MutableTotal;
  models: Array<[string, MutableTotal]>;
  lastObservedAt: string | null;
}

export class ClaudeUsageAccumulator {
  private readonly seen = new Set<string>();
  private readonly total = emptyTotal();
  private readonly models = new Map<string, MutableTotal>();
  private lastObservedAt: string | null = null;

  static fromEvents(events: EventRecord[]): ClaudeUsageAccumulator {
    const accumulator = new ClaudeUsageAccumulator();
    for (const event of events) accumulator.addEvent(event);
    return accumulator;
  }

  /**
   * The accumulator's own state, so it can be restored without replaying the
   * log that produced it.
   *
   * `seen` is part of the state, not an optimisation: it is what makes
   * addEvent idempotent per (runId, turn), so a restored accumulator that
   * later sees a repeated turn must still refuse to count it twice.
   */
  toJSON(): ClaudeUsageSnapshot {
    return {
      version: 1,
      seen: [...this.seen],
      total: { ...this.total },
      models: [...this.models.entries()].map(([model, total]) => [model, { ...total }]),
      lastObservedAt: this.lastObservedAt,
    };
  }

  /** Returns null for anything it does not fully recognise, so the caller replays the log. */
  static fromJSON(value: unknown): ClaudeUsageAccumulator | null {
    if (!value || typeof value !== 'object') return null;
    const snapshot = value as Partial<ClaudeUsageSnapshot>;
    if (snapshot.version !== 1 || !Array.isArray(snapshot.seen) || !Array.isArray(snapshot.models) || !snapshot.total) return null;
    const accumulator = new ClaudeUsageAccumulator();
    for (const key of snapshot.seen) {
      if (typeof key !== 'string') return null;
      accumulator.seen.add(key);
    }
    Object.assign(accumulator.total, snapshot.total);
    for (const entry of snapshot.models) {
      if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !entry[1]) return null;
      accumulator.models.set(entry[0], { ...(entry[1] as MutableTotal) });
    }
    accumulator.lastObservedAt = typeof snapshot.lastObservedAt === 'string' ? snapshot.lastObservedAt : null;
    return accumulator;
  }

  addEvent(event: EventRecord): boolean {
    if (!['turn_completed', 'turn_interrupted', 'turn_failed'].includes(event.type)) return false;
    const turn = token(event.data.turn);
    if (turn === null) return false;
    const key = `${event.runId}:${turn}`;
    if (this.seen.has(key)) return false;
    const usage = normalizeClaudeUsage(event.data.usage ?? event.data.tokens);
    if (!usage) return false;
    this.seen.add(key);
    const model = typeof event.data.model === 'string' && event.data.model.trim() ? event.data.model.trim() : 'desconhecido';
    add(this.total, usage);
    const modelTotal = this.models.get(model) ?? emptyTotal();
    add(modelTotal, usage);
    this.models.set(model, modelTotal);
    this.lastObservedAt = event.ts;
    return true;
  }

  snapshot(observedAt = this.lastObservedAt): ClaudeUsageView {
    const quality = this.total.turns === 0 ? 'unavailable' : this.total.partial ? 'partial' : 'reported';
    return {
      quality,
      observedAt: this.total.turns === 0 ? null : observedAt,
      turns: this.total.turns,
      inputTokens: this.total.inputTokens,
      outputTokens: this.total.outputTokens,
      cachedInputTokens: this.total.cachedInputTokens,
      cacheWriteInputTokens: this.total.cacheWriteInputTokens,
      totalInputTokens: this.total.totalInputTokens,
      totalObservedTokens: this.total.totalObservedTokens,
      byModel: [...this.models.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([model, total]) => ({
        model,
        turns: total.turns,
        inputTokens: total.inputTokens,
        outputTokens: total.outputTokens,
        cachedInputTokens: total.cachedInputTokens,
        cacheWriteInputTokens: total.cacheWriteInputTokens,
        totalInputTokens: total.totalInputTokens,
        totalObservedTokens: total.totalObservedTokens,
        quality: total.partial ? 'partial' : 'reported',
      })),
    };
  }
}
