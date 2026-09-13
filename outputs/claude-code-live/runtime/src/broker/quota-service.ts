// Advisory quota observation: runs the CLI's /usage under the global mutex
// shared with the legacy runner, parses the sanitized text, and records the
// attempt and the observation timestamps. Failure is visible and never blocks.
import { withGlobalQuotaMutex } from '../quota/global-mutex.ts';
import { evaluateQuotaRecommendation, parseUsageText, type UsageSnapshot } from '../quota/usage-parser.ts';
import { queryUsageText } from '../preflight/cli-probe.ts';
import type { ResolvedExecutable } from '../preflight/cli-resolver.ts';
import type { AuthorizedModel, QuotaView } from '../shared/types.ts';

export interface QuotaObservation {
  attemptedAt: string;
  observedAt: string | null;
  snapshot: UsageSnapshot | null;
  failure: { code: string; attemptedAt: string } | null;
}

export class QuotaService {
  private last: QuotaObservation | null = null;
  private inFlight: Promise<QuotaObservation> | null = null;
  private readonly waitMs: number;

  constructor(options: { waitMs?: number } = {}) {
    this.waitMs = options.waitMs ?? 30000;
  }

  get lastObservation(): QuotaObservation | null {
    return this.last;
  }

  async observe(executable: Extract<ResolvedExecutable, { status: 'resolved' }> | null): Promise<QuotaObservation> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      const attemptedAt = new Date().toISOString();
      if (!executable) {
        const observation: QuotaObservation = { attemptedAt, observedAt: null, snapshot: null, failure: { code: 'CLI_NOT_RESOLVED', attemptedAt } };
        this.last = observation;
        return observation;
      }
      try {
        const outcome = await withGlobalQuotaMutex(() => queryUsageText(executable), { waitMs: this.waitMs });
        const observedAt = new Date().toISOString();
        const snapshot = parseUsageText(outcome.value, observedAt);
        const observation: QuotaObservation = { attemptedAt: outcome.attemptedAt, observedAt, snapshot, failure: null };
        this.last = observation;
        return observation;
      } catch (error) {
        const code = (error as { code?: string }).code ?? 'USAGE_QUERY_FAILED';
        const observation: QuotaObservation = { attemptedAt, observedAt: null, snapshot: null, failure: { code, attemptedAt } };
        this.last = observation;
        return observation;
      } finally {
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }

  view(requestedModel: AuthorizedModel, observation: QuotaObservation | null = this.last): QuotaView {
    if (!observation) return { observedAt: null, attemptedAt: null, recommendation: 'unknown', alternate: null, snapshot: null, failure: null };
    const recommendation = evaluateQuotaRecommendation({ usage: observation.snapshot, requestedModel, ...(observation.failure ? { failure: observation.failure } : {}) });
    return {
      observedAt: observation.observedAt,
      attemptedAt: observation.attemptedAt,
      recommendation: recommendation.recommendation,
      alternate: recommendation.alternate,
      snapshot: observation.snapshot ? { session: observation.snapshot.session, allModels: observation.snapshot.allModels, fable: observation.snapshot.fable, alertLevel: observation.snapshot.alertLevel } : null,
      failure: observation.failure,
    };
  }
}
