import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StringRecordId, Surreal } from 'surrealdb';
import { SurrealService, dbCreate } from '../db/surreal.service';
import { EmbedderService } from '../ai/embedder.service';
import { PREDICATE_POLICIES } from '../ingest/conflict-resolver';
import {
  ConcatSummaryGenerator,
  FactToSummarize,
  SummaryGenerator,
} from './summary-generator';
import { SUMMARY_GENERATOR } from './compaction.types';
import { envFlagEnabled } from '../common/env-validation';

/**
 * PromotionRunnerService — episodic→semantic promotion.
 *
 * Compaction only ever touches CLOSED facts (superseded / retracted /
 * expired) — old-but-true episodic memory grew without bound: an entity
 * with three years of `preference` / `interacted_with` history dragged
 * every individual event through retrieval forever. This pass promotes
 * aged groups of append_only facts into one semantic summary fact:
 *
 *   ≥ COMPACTION_PROMOTION_MIN_GROUP active facts, same (entity,
 *   predicate), all older than COMPACTION_PROMOTION_AGE_DAYS →
 *   SummaryGenerator (same DI token as compaction: concat, or LLM when
 *   DREAMS_LLM_SUMMARY_ENABLED) → one ACTIVE `summary_<predicate>` fact
 *   with `derivedFrom` pointing at the originals → originals become
 *   status='compacted', embedding=NONE.
 *
 * Unlike compaction rollups the summary IS embedded (best-effort) — it
 * REPLACES the originals in the active set, so it must stay reachable
 * on the vector leg, not just BM25.
 *
 * Deliberately narrow:
 *   - append_only semantics only (single_active keeps one live value;
 *     bitemporal actives are claims the conflict engine owns);
 *   - `summary_*` predicates excluded — a summary is never re-promoted;
 *   - fresh members of a group stay active untouched — only the aged
 *     tail is folded;
 *   - retraction cascade still works: retracting the summary cascades
 *     down derivedFrom (FactsService), and the originals stay auditable
 *     as compacted rows.
 *
 * Default off (COMPACTION_PROMOTION_ENABLED); bounded per run.
 */
export interface PromotionStats {
  companyId: string;
  groupsPromoted: number;
  factsPromoted: number;
}

interface PromotableRow {
  id: unknown;
  entityId: unknown;
  predicate: string;
  object: string;
  validFrom: string;
  validUntil?: string | null;
  confidence: number;
  userId?: string | null;
}

@Injectable()
export class PromotionRunnerService {
  private readonly logger = new Logger(PromotionRunnerService.name);
  private readonly enabled: boolean;
  private readonly ageDays: number;
  private readonly minGroup: number;
  private readonly maxGroups: number;
  private readonly summaryGenerator: SummaryGenerator;

  // Fourth dep is the embedder — promotion summaries replace active
  // facts, so they must be vector-reachable; see class docblock.
  // eslint-disable-next-line max-params
  constructor(
    private readonly surreal: SurrealService,
    config: ConfigService,
    private readonly embedder: EmbedderService,
    @Optional() @Inject(SUMMARY_GENERATOR) injectedGenerator?: SummaryGenerator,
  ) {
    this.enabled =
      envFlagEnabled(config.get<string>('COMPACTION_PROMOTION_ENABLED'));
    this.ageDays = parseInt(
      config.get<string>('COMPACTION_PROMOTION_AGE_DAYS', '180'),
      10,
    );
    this.minGroup = parseInt(
      config.get<string>('COMPACTION_PROMOTION_MIN_GROUP', '5'),
      10,
    );
    this.maxGroups = parseInt(
      config.get<string>('COMPACTION_PROMOTION_MAX_GROUPS', '20'),
      10,
    );
    this.summaryGenerator = injectedGenerator ?? new ConcatSummaryGenerator();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async promoteCompany(companyId: string): Promise<PromotionStats> {
    const stats: PromotionStats = {
      companyId,
      groupsPromoted: 0,
      factsPromoted: 0,
    };
    if (!this.enabled) return stats;
    // Date param → native datetime; the 2.x `d$param` cast fails to parse
    // on SurrealDB 3.x (see compactCompany).
    const cutoff = new Date(Date.now() - this.ageDays * 24 * 60 * 60 * 1000);

    return this.surreal.withCompany(companyId, async (db) => {
      const groups = await this.findPromotableGroups(db, cutoff);
      for (const group of groups.slice(0, this.maxGroups)) {
        try {
          const promoted = await this.promoteGroup(db, group, cutoff);
          if (promoted > 0) {
            stats.groupsPromoted++;
            stats.factsPromoted += promoted;
          }
        } catch (e) {
          this.logger.warn(
            `promotion failed for ${String(group.entityId)}/${group.predicate}: ${(e as Error).message}`,
          );
        }
      }
      if (stats.groupsPromoted > 0) {
        this.logger.log(
          `Promoted ${stats.factsPromoted} fact(s) into ${stats.groupsPromoted} summary(ies) in tenant ${companyId}`,
        );
      }
      return stats;
    });
  }

  /**
   * (entity, predicate) groups holding ≥ minGroup aged active facts,
   * append_only semantics only, summaries excluded. The age filter sits
   * IN the query so a group of mostly-fresh events doesn't qualify on
   * its total size.
   */
  private async findPromotableGroups(
    db: Surreal,
    cutoff: Date,
  ): Promise<
    Array<{ entityId: unknown; predicate: string; userId?: string | null }>
  > {
    // User scope (0055) is part of the group key — a user's episodic
    // history folds into THAT user's summary, never a blended one.
    const [rows] = (await db.query(
      `SELECT entityId, predicate, userId, count() AS n FROM knowledge_fact
       WHERE status = 'active' AND retractedAt IS NONE
         AND recordedAt < $cutoff
         AND !string::starts_with(predicate, 'summary_')
       GROUP BY entityId, predicate, userId`,
      { cutoff },
    )) as [
      Array<{
        entityId: unknown;
        predicate: string;
        userId?: string | null;
        n: number;
      }>,
    ];
    return (rows ?? [])
      .filter((g) => g.n >= this.minGroup)
      .filter((g) => {
        // 0082: SEED lookup, not policyFor — the unknown-predicate
        // fallback is append_only now, but a coined (open-vocabulary)
        // predicate is a specific observation; folding those into a
        // `summary_<coinage>` row would trade recall drivers for a
        // paraphrase. Promotion keeps folding exactly the predicates it
        // always folded: seed-declared append_only event history.
        const seed = PREDICATE_POLICIES[g.predicate];
        return seed !== undefined && seed.semantics === 'append_only';
      });
  }

  /** Fold one group's aged tail into a summary fact. Returns count folded. */
  private async promoteGroup(
    db: Surreal,
    group: { entityId: unknown; predicate: string; userId?: string | null },
    cutoff: Date,
  ): Promise<number> {
    const scopeClause = group.userId
      ? 'AND userId = $scopeUser'
      : 'AND userId IS NONE';
    const [rows] = (await db.query(
      `SELECT id, entityId, predicate, object, validFrom, validUntil, confidence, userId
       FROM knowledge_fact
       WHERE entityId = $entity AND predicate = $predicate
         AND status = 'active' AND retractedAt IS NONE
         AND recordedAt < $cutoff
         ${scopeClause}
       ORDER BY validFrom ASC`,
      {
        entity: group.entityId,
        predicate: group.predicate,
        cutoff,
        ...(group.userId ? { scopeUser: group.userId } : {}),
      },
    )) as [PromotableRow[]];
    const members = (rows ?? []) as PromotableRow[];
    if (members.length < this.minGroup) return 0;

    // The SDK returns datetime columns as Date objects; FactToSummarize
    // (and the concat generator's `.slice`) expect ISO strings.
    const summaryText = await this.summaryGenerator.generate(
      members.map(
        (m) =>
          ({
            factId: String(m.id),
            predicate: m.predicate,
            object: m.object,
            validFrom: isoOf(m.validFrom),
            validUntil: m.validUntil ? isoOf(m.validUntil) : undefined,
            confidence: m.confidence,
          }) satisfies FactToSummarize,
      ),
    );
    if (!summaryText) return 0;

    // Best-effort embedding — a promotion summary replaces active memory
    // and must stay vector-reachable; on embed failure it still lands
    // (BM25-only, same as compaction rollups).
    let embedding: number[] | null = null;
    try {
      embedding = await this.embedder.embed(summaryText);
    } catch (e) {
      this.logger.warn(
        `promotion summary embed failed (${group.predicate}): ${(e as Error).message}`,
      );
    }

    const first = members[0];
    const last = members[members.length - 1];
    if (!first || !last) return 0; // members non-empty (length ≥ minGroup)
    const earliest = first.validFrom;
    const meanConfidence =
      members.reduce((acc, m) => acc + m.confidence, 0) / members.length;

    await dbCreate(db, 'knowledge_fact', {
      entityId: first.entityId,
      predicate: `summary_${group.predicate}`,
      object: summaryText,
      confidence: meanConfidence,
      validFrom: earliest,
      validUntil: last.validUntil ?? last.validFrom,
      source: { kind: 'promotion' },
      derivedFrom: members.map((m) => m.id),
      status: 'active',
      ...(group.userId ? { userId: group.userId } : {}),
      ...(embedding ? { embedding } : {}),
    });

    // Record-id params — 3.x does not coerce string↔record (see
    // compaction-runner).
    const ids = members.map((m) => new StringRecordId(String(m.id)));
    await db.query(
      `UPDATE knowledge_fact
         SET status = 'compacted', embedding = NONE
         WHERE id INSIDE $ids`,
      { ids },
    );
    return members.length;
  }
}

function isoOf(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v);
}
