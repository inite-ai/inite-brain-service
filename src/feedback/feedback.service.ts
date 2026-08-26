import { Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { StringRecordId } from 'surrealdb';
import { SurrealService } from '../db/surreal.service';
import { MetricsService } from '../metrics/metrics.service';
import { idTailOf } from '../ingest/ingest-utils';
import {
  MemoryOutcomeService,
  type OutcomeCounter,
  type OutcomeEventInput,
  type StatDelta,
} from '../outcomes/memory-outcome.service';

/**
 * FeedbackService — the write side of the retrieval feedback loop
 * (migration 0054).
 *
 * Consumers that retrieved a fact report back: 'helpful' (the fact
 * answered the question), 'incorrect' (the fact is wrong — the
 * strongest signal, a loss for its source at the nightly refit), or
 * 'not_helpful' (irrelevant retrieval — stored for future ranking
 * work, deliberately NOT a trust signal: an off-topic hit says nothing
 * about the source's reliability).
 *
 * One standing vote per (fact, caller key): the UNIQUE index turns
 * repeat feedback into a verdict replacement, so a single consumer
 * cannot stack votes and farm its own source's reputation. Trust
 * consumption lives in the calibration refit (buildFeedbackTrustEvents).
 */
export type FeedbackVerdict = 'helpful' | 'not_helpful' | 'incorrect';

export interface RecordFeedbackResult {
  factId: string;
  verdict: FeedbackVerdict;
  replaced: boolean;
}

/**
 * 0107 outcome mapping. 'not_helpful' maps to NO event and NO counter
 * on purpose — relevance ≠ correctness, the same reasoning that keeps
 * it out of source trust (0054:15-17): an irrelevant retrieval says
 * nothing about whether the fact itself is right.
 */
const OUTCOME_EVENT: Record<FeedbackVerdict, OutcomeEventInput['event'] | null> = {
  helpful: 'user_confirmed',
  incorrect: 'user_rejected',
  not_helpful: null,
};
const OUTCOME_BUCKET: Record<FeedbackVerdict, OutcomeCounter | null> = {
  helpful: 'confirmedCount',
  incorrect: 'rejectedCount',
  not_helpful: null,
};

@Injectable()
export class FeedbackService {
  private readonly logger = new Logger(FeedbackService.name);

  constructor(
    private readonly surreal: SurrealService,
    @Optional() private readonly metrics?: MetricsService,
    @Optional() private readonly outcomes?: MemoryOutcomeService,
  ) {}

  async record(p: {
    companyId: string;
    factId: string;
    verdict: FeedbackVerdict;
    reason?: string | undefined;
    actor: string;
  }): Promise<RecordFeedbackResult> {
    return this.surreal.withCompany(p.companyId, async (db) => {
      const [factRows] = await db.query<[Array<{ id: unknown }>]>(
        `SELECT id FROM type::record('knowledge_fact', $tail)`,
        { tail: idTailOf(p.factId) },
      );
      if (!((factRows as Array<{ id: unknown }>) ?? [])[0]) {
        throw new NotFoundException('fact not found');
      }

      const fact = new StringRecordId(`knowledge_fact:${idTailOf(p.factId)}`);
      // One standing vote per (fact, actor): the UNIQUE index routes a
      // repeat into the UPDATE branch — verdict replaced, not stacked.
      // The prior verdict is read alongside so the 0107 rollup can move
      // the replaced vote out of its old bucket (−1 old / +1 new).
      const [existing] = await db.query<[Array<{ id: unknown; verdict: FeedbackVerdict }>]>(
        `SELECT id, verdict FROM retrieval_feedback WHERE factId = $fact AND actor = $actor`,
        { fact, actor: p.actor },
      );
      const prior = ((existing as Array<{ id: unknown; verdict: FeedbackVerdict }>) ?? [])[0];
      const replaced = prior !== undefined;
      await db.query(
        `INSERT INTO retrieval_feedback {
           factId: $fact, verdict: $verdict, actor: $actor,
           reason: $reason, createdAt: time::now()
         } ON DUPLICATE KEY UPDATE
           verdict = $verdict, reason = $reason, createdAt = time::now()`,
        {
          fact,
          verdict: p.verdict,
          actor: p.actor,
          // undefined → NONE on the wire; option<string> rejects NULL.
          reason: p.reason,
        },
      );
      this.metrics?.countFeedback(p.verdict);
      this.emitOutcome(p.companyId, String(fact), p.verdict, prior?.verdict, p.actor);
      this.logger.log(
        `feedback ${p.companyId}: ${String(fact)} ${p.verdict}${replaced ? ' (replaced)' : ''}`,
      );
      return { factId: String(fact), verdict: p.verdict, replaced };
    });
  }

  /**
   * Outcome telemetry (0107) — detached inside the service, guarded
   * no-op when unwired or flag-off. RAW event: every helpful/incorrect
   * vote appends one row (an audit trail of votes, including repeats).
   * ROLLUP: explicit signed deltas mirror the 0054 one-standing-vote
   * semantics — a NEW vote is +1 on its bucket; a REPLACED vote is −1
   * on the old bucket and +1 on the new one, so a same-verdict repeat
   * nets zero and the counters always reflect standing votes, never
   * vote volume.
   */
  // eslint-disable-next-line max-params -- one 0107 emit seam; a params object would just rename the five values
  private emitOutcome(
    companyId: string,
    factId: string,
    verdict: FeedbackVerdict,
    priorVerdict: FeedbackVerdict | undefined,
    actor: string,
  ): void {
    if (!this.outcomes || !MemoryOutcomeService.enabled()) return;
    const events: OutcomeEventInput[] = [];
    const eventName = OUTCOME_EVENT[verdict];
    if (eventName) {
      events.push({ subjectKind: 'fact', subjectId: factId, event: eventName, actor });
    }
    const newBucket = OUTCOME_BUCKET[verdict];
    const oldBucket = priorVerdict !== undefined ? OUTCOME_BUCKET[priorVerdict] : null;
    const statDeltas: StatDelta[] = [];
    if (oldBucket && oldBucket !== newBucket) {
      statDeltas.push({ subjectKind: 'fact', subjectId: factId, counter: oldBucket, delta: -1 });
    }
    if (newBucket && oldBucket !== newBucket) {
      statDeltas.push({
        subjectKind: 'fact',
        subjectId: factId,
        counter: newBucket,
        delta: 1,
        // A confirmation is a verified use — same 'auto' semantics.
        ...(newBucket === 'confirmedCount' ? { lastVerifiedUseAt: new Date() } : {}),
      });
    }
    if (events.length === 0 && statDeltas.length === 0) return;
    this.outcomes.recordOutcomes({ companyId, events, statDeltas });
  }
}
