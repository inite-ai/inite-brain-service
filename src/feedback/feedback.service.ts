import { Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { StringRecordId } from 'surrealdb';
import { SurrealService } from '../db/surreal.service';
import { MetricsService } from '../metrics/metrics.service';
import { idTailOf } from '../ingest/ingest-utils';

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

@Injectable()
export class FeedbackService {
  private readonly logger = new Logger(FeedbackService.name);

  constructor(
    private readonly surreal: SurrealService,
    @Optional() private readonly metrics?: MetricsService,
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

      const fact = new StringRecordId(
        `knowledge_fact:${idTailOf(p.factId)}`,
      );
      // One standing vote per (fact, actor): the UNIQUE index routes a
      // repeat into the UPDATE branch — verdict replaced, not stacked.
      const [existing] = await db.query<[Array<{ id: unknown }>]>(
        `SELECT id FROM retrieval_feedback WHERE factId = $fact AND actor = $actor`,
        { fact, actor: p.actor },
      );
      const replaced = ((existing as Array<{ id: unknown }>) ?? []).length > 0;
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
      this.logger.log(
        `feedback ${p.companyId}: ${String(fact)} ${p.verdict}${replaced ? ' (replaced)' : ''}`,
      );
      return { factId: String(fact), verdict: p.verdict, replaced };
    });
  }
}
