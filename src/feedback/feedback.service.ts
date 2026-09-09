import { Injectable, Logger, Optional } from '@nestjs/common';
import type { BrainScope } from '../auth/api-key.types';
import { FactsService } from '../facts/facts.service';
import { StringRecordId, type Surreal } from 'surrealdb';
import { SurrealService, runTransaction } from '../db/surreal.service';
import { retryOnUniqueViolation } from '../db/surreal-retry';
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

/** The RETURN slot of the vote transaction: the verdict the vote replaced. */
interface CastVoteRow {
  prior?: FeedbackVerdict | null;
}

/**
 * Cast one standing vote and learn what it replaced — in ONE transaction.
 *
 * The prior verdict and the write used to be two round-trips (a SELECT,
 * then an INSERT … ON DUPLICATE KEY UPDATE). Two concurrent votes from the
 * same actor both saw "no prior vote" in the gap: the UNIQUE index kept one
 * row, but each request then emitted its own `+1` rollup delta, and the
 * fact's confirmedCount counted one standing vote twice (audit 2026-09-06,
 * F8). Reading the prior INSIDE the transaction that writes the vote makes
 * the delta a function of what the database actually replaced: under
 * contention the server serialises the two — the second one sees the
 * first's row as its prior (a same-verdict replacement, net zero) — or
 * aborts it with a write conflict, which the retry re-runs against the
 * committed row. Either way exactly one vote stands and exactly one `+1`
 * is emitted.
 *
 * Returns the replaced verdict, or undefined for a first vote.
 */
export async function castVote(
  db: Surreal,
  v: {
    fact: StringRecordId;
    verdict: FeedbackVerdict;
    actor: string;
    reason: string | undefined;
  },
): Promise<FeedbackVerdict | undefined> {
  return retryOnUniqueViolation(async () => {
    const row = await runTransaction<CastVoteRow | null | undefined>(db, (tx) => {
      tx.add(
        `LET $prior = (SELECT VALUE verdict FROM retrieval_feedback
            WHERE factId = $fact AND actor = $actor LIMIT 1)[0]`,
      )
        // One standing vote per (fact, actor): the UNIQUE index routes a
        // repeat into the UPDATE branch — verdict replaced, not stacked.
        .add(
          `INSERT INTO retrieval_feedback {
             factId: $fact, verdict: $verdict, actor: $actor,
             reason: $reason, createdAt: time::now()
           } ON DUPLICATE KEY UPDATE
             verdict = $verdict, reason = $reason, createdAt = time::now()`,
        )
        .add(`RETURN { prior: $prior }`)
        .bind('fact', v.fact)
        .bind('verdict', v.verdict)
        .bind('actor', v.actor)
        // undefined → NONE on the wire; option<string> rejects NULL.
        .bind('reason', v.reason);
    });
    const prior = row?.prior;
    return prior === null || prior === undefined ? undefined : prior;
  });
}

@Injectable()
export class FeedbackService {
  private readonly logger = new Logger(FeedbackService.name);

  // eslint-disable-next-line max-params -- Nest DI constructor; each param is an injection token
  constructor(
    private readonly surreal: SurrealService,
    private readonly facts: FactsService,
    @Optional() private readonly metrics?: MetricsService,
    @Optional() private readonly outcomes?: MemoryOutcomeService,
  ) {}

  async record(p: {
    companyId: string;
    factId: string;
    verdict: FeedbackVerdict;
    reason?: string | undefined;
    actor: string;
    /** The caller's scopes — the visibility fence is the read path's. */
    scopes: readonly BrainScope[];
  }): Promise<RecordFeedbackResult> {
    // A vote changes a fact's trust signals, so the caller must be allowed
    // to SEE the fact: same tenant, same user scope (a user-bound token
    // cannot rate another user's personal memory), same row policy. This
    // is the read path's own fence (FactsService.getFact) and it answers
    // 404 for every miss, so existence never leaks through a 201/404 split.
    // Before this, `brain:write` plus a guessed id was enough.
    await this.facts.getFact({ companyId: p.companyId, factId: p.factId, scopes: p.scopes });
    return this.surreal.withCompany(p.companyId, async (db) => {
      const fact = new StringRecordId(`knowledge_fact:${idTailOf(p.factId)}`);
      const prior = await castVote(db, {
        fact,
        verdict: p.verdict,
        actor: p.actor,
        reason: p.reason,
      });
      const replaced = prior !== undefined;
      this.metrics?.countFeedback(p.verdict);
      this.emitOutcome(p.companyId, String(fact), p.verdict, prior, p.actor);
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
