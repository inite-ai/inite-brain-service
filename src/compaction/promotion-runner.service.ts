import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StringRecordId, Surreal } from 'surrealdb';
import { SurrealService, runTransaction } from '../db/surreal.service';
import { EmbedderService } from '../ai/embedder.service';
import { PREDICATE_POLICIES } from '../ingest/conflict-resolver';
import { ConcatSummaryGenerator, FactToSummarize, SummaryGenerator } from './summary-generator';
import { SUMMARY_GENERATOR } from './compaction.types';
import { envFlagEnabled } from '../common/env-validation';
import { summaryEpisodeStampEnabled, supportEdgesEnabled } from '../common/provenance-flags';
import { ungroundedExcludeEnabled } from '../common/evidence-flags';
import { unionEpisodeIds } from '../common/episode-ids';
import { insertDerivedFromEdges } from './support-edge-mirror';
import { compactionOverridesFor } from './compaction-overrides';

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
 * Because it replaces active memory, the summary's VALIDITY is the
 * originals' validity (open-ended if any member is open-ended; else the
 * latest member close) and the span of the summarised events is kept
 * separately as `source.eventRange` — see summaryValidityOf. The
 * replacement and the compaction of the originals are ONE transaction:
 * at no point are the originals hidden without a summary standing in
 * for them.
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
  /** `source.episodeIds AS eps` — grounding stamp of the member (FLEXIBLE). */
  eps?: unknown;
  /** `source.conversationId AS conversationId` — evidence context of the member (FLEXIBLE). */
  conversationId?: unknown;
  /** Claim grounding state (0115) — selected ONLY under
   *  EVIDENCE_UNGROUNDED_EXCLUDE; absent = legacy (still promotes). */
  groundingStatus?: unknown;
}

/**
 * Per-run promotion schedule: the age cutoff plus the effective
 * thresholds (env defaults overlaid per tenant). One object so the
 * per-group path stays within the max-params=3 budget.
 */
interface PromotionSchedule {
  cutoff: Date;
  minGroup: number;
  minEpisodes: number;
}

@Injectable()
export class PromotionRunnerService {
  private readonly logger = new Logger(PromotionRunnerService.name);
  private readonly enabled: boolean;
  private readonly ageDays: number;
  private readonly minGroup: number;
  private readonly maxGroups: number;
  private readonly minEpisodes: number;
  private readonly conflictGuard: boolean;
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
    this.enabled = envFlagEnabled(config.get<string>('COMPACTION_PROMOTION_ENABLED'));
    this.ageDays = parseInt(config.get<string>('COMPACTION_PROMOTION_AGE_DAYS', '180'), 10);
    this.minGroup = parseInt(config.get<string>('COMPACTION_PROMOTION_MIN_GROUP', '5'), 10);
    this.maxGroups = parseInt(config.get<string>('COMPACTION_PROMOTION_MAX_GROUPS', '20'), 10);
    // Consolidation gate (Brain v2 PR8): corroboration floor (0 = off)
    // + competing-sibling guard. The floor is per-tenant overridable via
    // the tenant schedule (compaction-overrides.ts); the guard is boolean.
    this.minEpisodes = parseInt(config.get<string>('COMPACTION_PROMOTION_MIN_EPISODES', '0'), 10);
    this.conflictGuard = envFlagEnabled(config.get<string>('COMPACTION_PROMOTION_CONFLICT_GUARD'));
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
    // Per-tenant resolution schedule (COMPACTION_TENANT_OVERRIDES): a
    // tenant entry overrides the process defaults; unset = byte-identical.
    const override = compactionOverridesFor(companyId);
    const ageDays = override.promotionAgeDays ?? this.ageDays;
    const schedule: PromotionSchedule = {
      // Date param → native datetime; the 2.x `d$param` cast fails to
      // parse on SurrealDB 3.x (see compactCompany).
      cutoff: new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000),
      minGroup: override.promotionMinGroup ?? this.minGroup,
      minEpisodes: override.promotionMinEpisodes ?? this.minEpisodes,
    };

    return this.surreal.withCompany(companyId, async (db) => {
      const groups = await this.findPromotableGroups(db, schedule);
      for (const group of groups.slice(0, this.maxGroups)) {
        try {
          const promoted = await this.promoteGroup(db, group, schedule);
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
    schedule: PromotionSchedule,
  ): Promise<Array<{ entityId: unknown; predicate: string; userId?: string | null }>> {
    // User scope (0055) is part of the group key — a user's episodic
    // history folds into THAT user's summary, never a blended one.
    const [rows] = (await db.query(
      `SELECT entityId, predicate, userId, count() AS n FROM knowledge_fact
       WHERE status = 'active' AND retractedAt IS NONE
         AND recordedAt < $cutoff
         AND !string::starts_with(predicate, 'summary_')
       GROUP BY entityId, predicate, userId`,
      { cutoff: schedule.cutoff },
    )) as [
      Array<{
        entityId: unknown;
        predicate: string;
        userId?: string | null;
        n: number;
      }>,
    ];
    return (rows ?? [])
      .filter((g) => g.n >= schedule.minGroup)
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

  /**
   * The member SELECT + the Drift-1 consolidation gate
   * (EVIDENCE_UNGROUNDED_EXCLUDE), extracted from promoteGroup for the
   * complexity budget. The groundingStatus column joins the SELECT only
   * while the flag is on, so the off-state query string stays
   * byte-identical; the TS-side exclusion runs BEFORE the group-size
   * floor — an ungrounded member must not consolidate NOR count toward
   * the group qualifying. Legacy rows (absent groundingStatus) still
   * promote: no backfill, fail-open for pre-flag data by design.
   */
  private async loadPromotableMembers(
    db: Surreal,
    args: {
      group: { entityId: unknown; predicate: string; userId?: string | null };
      schedule: PromotionSchedule;
      scopeClause: string;
      scopeParams: Record<string, unknown>;
    },
  ): Promise<PromotableRow[]> {
    const ungroundedExclude = ungroundedExcludeEnabled();
    const groundingColumn = ungroundedExclude ? ',\n              groundingStatus' : '';
    const [rows] = (await db.query(
      `SELECT id, entityId, predicate, object, validFrom, validUntil, confidence, userId,
              source.episodeIds AS eps,
              source.conversationId AS conversationId${groundingColumn}
       FROM knowledge_fact
       WHERE entityId = $entity AND predicate = $predicate
         AND status = 'active' AND retractedAt IS NONE
         AND recordedAt < $cutoff
         ${args.scopeClause}
       ORDER BY validFrom ASC`,
      {
        entity: args.group.entityId,
        predicate: args.group.predicate,
        cutoff: args.schedule.cutoff,
        ...args.scopeParams,
      },
    )) as [PromotableRow[]];
    const members = (rows ?? []) as PromotableRow[];
    return ungroundedExclude ? members.filter((m) => m.groundingStatus !== 'ungrounded') : members;
  }

  /**
   * Fold one group's aged tail into a summary fact. Returns count folded.
   *
   * Consolidation gate order (Brain v2 PR8): corroboration floor →
   * conflict guard → the existing summarize/create/compact flow.
   */
  private async promoteGroup(
    db: Surreal,
    group: { entityId: unknown; predicate: string; userId?: string | null },
    schedule: PromotionSchedule,
  ): Promise<number> {
    const { scopeClause, scopeParams } = scopeFilterFor(group);
    const members = await this.loadPromotableMembers(db, {
      group,
      schedule,
      scopeClause,
      scopeParams,
    });
    if (members.length < schedule.minGroup) return 0;

    // Corroboration floor (COMPACTION_PROMOTION_MIN_EPISODES > 0): a
    // summary must consolidate INDEPENDENT evidence, so the floor counts
    // distinct evidence contexts — not member rows. Five facts from ONE
    // conversation are one witness, not five (distinctEvidenceContexts).
    if (schedule.minEpisodes > 0) {
      const distinct = distinctEvidenceContexts(members);
      if (distinct.size < schedule.minEpisodes) {
        this.logger.debug(
          `promotion skipped (corroboration floor): ${String(group.entityId)}/${group.predicate} ` +
            `distinct=${distinct.size} < ${schedule.minEpisodes}`,
        );
        return 0;
      }
    }

    // Conflict guard (COMPACTION_PROMOTION_CONFLICT_GUARD): the members
    // are status='active' by the WHERE above, so the signal for a
    // contested group is its sibling COMPETING pool — same (entity,
    // predicate) and the same user scope as the member query. A
    // contested group must never fold silently into one summary: abort
    // LOUDLY and leave the rows for the conflict engine to settle.
    if (this.conflictGuard) {
      const [countRows] = (await db.query(
        `SELECT count() AS n FROM knowledge_fact
         WHERE entityId = $entity AND predicate = $predicate
           AND status = 'competing' AND retractedAt IS NONE
           ${scopeClause}
         GROUP ALL`,
        { entity: group.entityId, predicate: group.predicate, ...scopeParams },
      )) as [Array<{ n: number }>];
      const competing = countRows?.[0]?.n ?? 0;
      if (competing > 0) {
        this.logger.warn(
          `contested group NOT promoted: ${String(group.entityId)}/${group.predicate}, ` +
            `${competing} competing rows`,
        );
        return 0;
      }
    }

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
      // Write-guarded: persisted as the promoted fact's embedding.
      embedding = await this.embedder.embedForWrite(summaryText);
    } catch (e) {
      this.logger.warn(
        `promotion summary embed failed (${group.predicate}): ${(e as Error).message}`,
      );
    }

    const first = members[0];
    const last = members[members.length - 1];
    if (!first || !last) return 0; // members non-empty (length ≥ minGroup)
    const meanConfidence = members.reduce((acc, m) => acc + m.confidence, 0) / members.length;
    const validity = summaryValidityOf(members);

    // Evidence plane (PROVENANCE_SUMMARY_EPISODE_STAMP): the summary
    // carries the union of its members' grounding stamps (window-deriver
    // idiom, capped 64). Flag off → empty union.
    const episodeIds = summaryEpisodeStampEnabled()
      ? unionEpisodeIds(members.map((m) => m.eps))
      : [];

    const doc: Record<string, unknown> = {
      entityId: first.entityId,
      predicate: `summary_${group.predicate}`,
      object: summaryText,
      confidence: meanConfidence,
      validFrom: validity.validFrom,
      // Open-ended stays open-ended: `validUntil` is omitted, not null —
      // `option<datetime>` reads NONE either way, and the search filter
      // `validUntil IS NONE OR validUntil > time::now()` admits it.
      ...(validity.validUntil ? { validUntil: validity.validUntil } : {}),
      source: {
        kind: 'promotion',
        // The interval the summarised EVENTS span — provenance, not
        // validity. This used to be smuggled into validUntil, which is
        // what made every summary of open-ended history expire at birth.
        eventRange: validity.eventRange,
        ...(episodeIds.length ? { episodeIds } : {}),
      },
      derivedFrom: members.map((m) => m.id),
      status: 'active',
      ...(group.userId ? { userId: group.userId } : {}),
      ...(embedding ? { embedding } : {}),
    };

    // One transaction: the replacement lands and the originals close
    // together, or neither does. Two round-trips used to leave a window
    // (crash, pool loss) where the originals were compacted — hidden from
    // every read surface, embeddings dropped — with no summary carrying
    // their content, or a summary next to five still-active originals.
    // Record-id params — 3.x does not coerce string↔record (see
    // compaction-runner).
    //
    // Atomic is not enough: the members were selected BEFORE the awaited
    // summary + embedding window, so the close carries the full member
    // predicate and its row count is checked against what was
    // summarised. A member retracted or already compacted inside the
    // window (a second pass over the same group) makes the counts differ
    // and THROWS — the group is skipped, not promoted over content that
    // moved. Nothing is written, the CREATE included.
    const ids = members.map((m) => new StringRecordId(String(m.id)));
    const createdRows = await runTransaction<Array<{ id: unknown }> | undefined>(db, (tx) => {
      tx.bind('doc', doc).bind('ids', ids).bind('expected', ids.length);
      tx.add(
        `LET $closed = (UPDATE knowledge_fact
           SET status = 'compacted', embedding = NONE
           WHERE id INSIDE $ids AND status = 'active' AND retractedAt IS NONE
           RETURN AFTER)`,
      );
      tx.add(
        `IF array::len($closed) != $expected ` +
          `{ THROW 'promotion members moved under the summary' }`,
      );
      tx.add(`LET $created = (CREATE knowledge_fact CONTENT $doc RETURN AFTER)`);
      tx.add(`RETURN $created`);
    });
    const summary = createdRows?.[0];
    if (!summary?.id) {
      throw new Error(`promotion transaction returned no summary row for ${group.predicate}`);
    }

    await this.mirrorDerivedFromEdges(db, {
      summaryId: String(summary.id),
      memberIds: members.map((m) => String(m.id)),
    });
    return members.length;
  }

  /**
   * Typed support graph (PROVENANCE_SUPPORT_EDGES, default off): mirror
   * the EXACT derivedFrom array just written as
   * summary-derived_from->member edges. Best-effort — the summary
   * already landed and the members must still be compacted, so a mirror
   * failure warns, never aborts. Off ⇒ zero queries, the write sequence
   * is byte-identical.
   */
  private async mirrorDerivedFromEdges(
    db: Surreal,
    mirror: { summaryId: string; memberIds: string[] },
  ): Promise<void> {
    if (!supportEdgesEnabled()) return;
    try {
      await insertDerivedFromEdges(db, { ...mirror, writer: 'promotion_runner' });
    } catch (e) {
      this.logger.warn(
        `promotion derived_from edge mirror failed (non-fatal): ${(e as Error).message}`,
      );
    }
  }
}

function isoOf(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

/** What the promotion summary is valid for, and what it summarises. */
export interface SummaryValidity {
  /** Earliest member validFrom — the summary holds from the first event. */
  validFrom: string | Date;
  /**
   * The validity the originals actually had: open-ended (undefined) if
   * ANY member is open-ended, else the latest member validUntil. Never
   * derived from validFrom — a group of open-ended events used to get
   * `validUntil = last.validFrom`, i.e. a replacement born expired.
   */
  validUntil?: string | Date;
  /** The interval the summarised events span (member validFrom..last
   *  event boundary) — provenance stored on `source`, not validity. */
  eventRange: { from: string; to: string };
}

/**
 * Validity of a promotion summary, derived from its members (sorted by
 * validFrom ASC, as the member SELECT orders them).
 *
 * A summary REPLACES active memory — the originals are compacted and
 * hidden from every read surface — so it must be visible for exactly as
 * long as the originals would have been: open-ended events yield an
 * open-ended summary; a group whose every member has closed yields a
 * summary closed at the latest of those closings. The events' own time
 * span is kept separately as `eventRange` so nothing the old
 * `validUntil` encoded is lost — it just no longer decides visibility.
 */
export function summaryValidityOf(
  // The SDK hands datetime columns back as Date; a stub may pass ISO text.
  members: ReadonlyArray<{ validFrom: string | Date; validUntil?: string | Date | null }>,
): SummaryValidity {
  const first = members[0];
  const last = members[members.length - 1];
  if (!first || !last) throw new Error('summaryValidityOf: no members');
  const open = members.some((m) => m.validUntil === undefined || m.validUntil === null);
  let latestClose: string | Date | undefined;
  if (!open) {
    for (const m of members) {
      const until = m.validUntil as string | Date;
      if (latestClose === undefined || toMs(until) > toMs(latestClose)) latestClose = until;
    }
  }
  return {
    validFrom: first.validFrom,
    ...(latestClose !== undefined ? { validUntil: latestClose } : {}),
    eventRange: {
      from: isoOf(first.validFrom),
      to: isoOf(last.validUntil ?? last.validFrom),
    },
  };
}

function toMs(v: string | Date): number {
  return v instanceof Date ? v.getTime() : new Date(v).getTime();
}

/** User-scope member filter (0055) — shared by the member SELECT and the
 *  conflict-guard count so the two can never disagree on scope. */
function scopeFilterFor(group: { userId?: string | null }): {
  scopeClause: string;
  scopeParams: Record<string, unknown>;
} {
  return {
    scopeClause: group.userId ? 'AND userId = $scopeUser' : 'AND userId IS NONE',
    scopeParams: group.userId ? { scopeUser: group.userId } : {},
  };
}

/**
 * Pure: the distinct evidence CONTEXTS behind a promotable group — the
 * unit the corroboration floor counts (audit 2026-09-06 F10).
 *
 * ONE level of independence: a member's context is its conversation.
 * Every reply of one conversation is the same witness, however many
 * scene/episode stamps it carries — the union of episode ids AND
 * conversation ids that used to be counted here made one reply from one
 * conversation two witnesses and five replies up to six. Episode ids are
 * the FALLBACK for a member whose conversation is unknown (legacy rows,
 * document-derived facts), and even then an episode a conversation-known
 * member already claims is not a second witness. A member with neither
 * says nothing about independence and contributes no context.
 */
export function distinctEvidenceContexts(
  members: ReadonlyArray<{ eps?: unknown; conversationId?: unknown }>,
): Set<string> {
  const contexts = new Set<string>();
  const claimedEpisodes = new Set<string>();
  const orphans: unknown[] = [];
  for (const m of members) {
    if (typeof m.conversationId === 'string' && m.conversationId.length > 0) {
      contexts.add(`conversation:${m.conversationId}`);
      for (const ep of unionEpisodeIds([m.eps])) claimedEpisodes.add(ep);
    } else {
      orphans.push(m.eps);
    }
  }
  for (const ep of unionEpisodeIds(orphans)) {
    if (!claimedEpisodes.has(ep)) contexts.add(ep);
  }
  return contexts;
}
