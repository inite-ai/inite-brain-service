import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { Surreal } from 'surrealdb';
import { StringRecordId } from 'surrealdb';
import { SurrealService } from '../db/surreal.service';
import { ApiKeyService } from '../auth/api-key.service';
import { JobClaimService } from '../jobs/job-claim.service';
import { WorkerLoopService } from '../jobs/worker-loop.service';
import { SUMMARY_GENERATOR } from './compaction.types';
import { changefeedRow } from '../db/changefeed-row';
import type {
  SummaryGenerator,
  FactToSummarize,
} from './summary-generator';

/** Changefeed cursor key — distinct from the audit drain's per-table keys. */
const CURSOR = 'recompose:knowledge_fact';

/**
 * Statuses that mean "this fact's CONTENT is no longer what a derived artifact
 * was built from".
 *
 * `compacted` is deliberately NOT here. Compaction sets its sources to
 * 'compacted' in the same pass that CREATES the summary from them
 * (compaction-runner.service.ts:135) — treating that as a change would mark
 * every summary stale the instant it was born, and the recompute pass would
 * chase its own tail forever.
 */
const CONTENT_CHANGED = new Set(['superseded', 'retracted']);

/**
 * RecomposeService — Phase 1 of docs/roadmap/cascade-recompose-2026-07.md.
 *
 * THE BUG IT FIXES. `fn::resolve_fact` (0055), the path every routine fact
 * update takes, never touches `derivedFrom` — so a compaction summary keeps
 * serving a value its parent has since corrected. The system's only cascade
 * (`fn::cascade_retract`, 0069) fires from one call site, the explicit retract
 * API, and it cannot see a supersede at all: it filters `retractedAt IS NONE`
 * and writes status='retracted', while supersede writes 'superseded'.
 *
 * RECOMPUTE, NOT RETRACT. The naive fix — cascading a retract on supersede —
 * would destroy a summary on every routine update, and because compaction hides
 * its sources (status='compacted', embeddings dropped, every read surface
 * filters them out) the summary is the ONLY carrier of that knowledge. So a
 * changed parent marks the child STALE, and this pass RE-DERIVES it from the
 * parents' current versions. Retraction happens in exactly one case: no parent
 * survives.
 *
 * WHY A WATERMARK AND NOT A HOOK IN resolve_fact. The changefeed already
 * records every write, cannot miss work while a pod is down (the cursor simply
 * has not moved), and needs no edit to a 22-argument stored function whose
 * positional contract is a documented footgun.
 *
 * No feature flag: a summary that contradicts a corrected fact is a bug, not a
 * configuration.
 */
@Injectable()
export class RecomposeService implements OnModuleInit {
  private readonly logger = new Logger(RecomposeService.name);
  private readonly batchLimit = envInt('RECOMPOSE_BATCH', 500);

  // Nightly job owner in the candidate-sweeper mold.
  // eslint-disable-next-line max-params
  constructor(
    private readonly surreal: SurrealService,
    private readonly apiKeys: ApiKeyService,
    @Inject(SUMMARY_GENERATOR)
    private readonly summaryGenerator: SummaryGenerator,
    @Optional() private readonly workerLoop?: WorkerLoopService,
    @Optional() private readonly claim?: JobClaimService,
  ) {}

  onModuleInit(): void {
    this.workerLoop?.register(
      'recompose',
      (ctx) => this.runForTenant(ctx.companyId),
      { ttlSeconds: 900, maxAttempts: 2 },
    );
  }

  /** 03:05 UTC — after consolidation (02:40), before compaction (03:17), so a
   *  summary is fresh before the next pass rolls more facts into it. */
  @Cron('5 3 * * *', { timeZone: 'UTC' })
  async runNightly(): Promise<{ enqueued: number }> {
    if (!this.claim) return { enqueued: 0 };
    const today = new Date().toISOString().slice(0, 10);
    let enqueued = 0;
    for (const companyId of this.apiKeys.knownCompanyIds()) {
      try {
        const { created } = await this.claim.enqueue({
          jobType: 'recompose',
          companyId,
          triggeredBy: 'cron',
          dedupKey: `recompose_${today}`,
        });
        if (created) enqueued++;
      } catch (e) {
        this.logger.warn(
          `enqueue recompose for ${companyId} failed: ${(e as Error).message}`,
        );
      }
    }
    return { enqueued };
  }

  /** Invalidate, then recompute. Exposed for an operator/test to drive one pass. */
  async runForTenant(companyId: string): Promise<Record<string, unknown>> {
    const marked = await this.invalidate(companyId);
    const { recomputed, retracted } = await this.recompute(companyId);
    if (marked || recomputed || retracted) {
      this.logger.log(
        `recompose ${companyId}: marked=${marked} recomputed=${recomputed} retracted=${retracted}`,
      );
    }
    return { marked, recomputed, retracted };
  }

  /**
   * Drain the changefeed and mark every derived descendant of a
   * content-changed fact stale. Transitive and idempotent — the stored
   * function's `staleAt IS NONE` filter both terminates its recursion and makes
   * a re-run free.
   */
  async invalidate(companyId: string): Promise<number> {
    return this.surreal.withCompany(companyId, async (db) => {
      const since = await loadCursor(db);
      const [rows] = await db.query<[any[]]>(
        `SHOW CHANGES FOR TABLE knowledge_fact SINCE ${since} LIMIT ${this.batchLimit}`,
      );
      const changes = (rows as any[]) ?? [];
      let highest = since;
      const changed: string[] = [];
      for (const c of changes) {
        const vs = Number(c?.versionstamp ?? 0);
        // SINCE is inclusive of the boundary — skip the row the cursor sits on.
        if (vs <= since) continue;
        if (vs > highest) highest = vs;
        for (const item of (c?.changes as any[]) ?? []) {
          // `changefeedRow`, not `item.update` — on an UPDATE the latter is a
          // patch ARRAY and reading `.id` off it yields undefined, which is how
          // a drain silently sees creates only.
          const row = changefeedRow(item);
          if (!row?.id) continue;
          if (CONTENT_CHANGED.has(String(row.status))) changed.push(String(row.id));
        }
      }
      if (changed.length === 0) {
        if (highest > since) await advanceCursor(db, highest);
        return 0;
      }
      const [marked] = await db.query<[unknown[]]>(
        `RETURN fn::mark_derived_stale($parents, $reason, $now)`,
        {
          parents: changed.map((id) => new StringRecordId(id)),
          reason: 'parent_changed',
          now: new Date(),
        },
      );
      await advanceCursor(db, highest);
      return ((marked as unknown[]) ?? []).length;
    });
  }

  /**
   * Re-derive every stale compaction summary from its parents' CURRENT
   * versions, following each superseded parent along `supersededBy` to the row
   * that replaced it. A summary whose parents have all been retracted has
   * nothing left to say and is retracted itself — the only case where deletion
   * is the right answer.
   */
  async recompute(
    companyId: string,
  ): Promise<{ recomputed: number; retracted: number }> {
    return this.surreal.withCompany(companyId, async (db) => {
      const [rows] = await db.query<[any[]]>(
        `SELECT id, predicate, derivedFrom, staleAt FROM knowledge_fact
          WHERE staleAt IS NOT NONE
            AND retractedAt IS NONE
            AND source.kind = 'compaction-summary'
          LIMIT ${this.batchLimit}`,
      );
      let recomputed = 0;
      let retracted = 0;
      for (const summary of (rows as any[]) ?? []) {
        const parents = await this.currentParents(db, summary.derivedFrom ?? []);
        if (parents.length === 0) {
          await this.retractOrphan(db, String(summary.id));
          retracted += 1;
          continue;
        }
        if (await this.rewrite(db, String(summary.id), parents)) recomputed += 1;
      }
      return { recomputed, retracted };
    });
  }

  /**
   * The live version of each recorded parent: follow `supersededBy` (bounded,
   * so a corrupt chain cannot spin), drop anything retracted. A parent sitting
   * at status='compacted' is NORMAL — that is what compaction does to its
   * sources — so it counts as surviving.
   */
  private async currentParents(
    db: Surreal,
    recorded: unknown[],
  ): Promise<FactToSummarize[]> {
    if (recorded.length === 0) return [];
    const [rows] = await db.query<[any[]]>(
      `SELECT id, predicate, object, confidence, validFrom, validUntil,
              retractedAt, supersededBy
         FROM knowledge_fact WHERE id INSIDE $ids`,
      { ids: recorded.map((r) => new StringRecordId(String(r))) },
    );
    const out: FactToSummarize[] = [];
    for (const row of (rows as any[]) ?? []) {
      const live = await this.followSupersedes(db, row);
      if (!live || live.retractedAt) continue;
      out.push({
        factId: String(live.id),
        predicate: String(live.predicate),
        object: String(live.object),
        validFrom: isoOf(live.validFrom),
        validUntil: live.validUntil ? isoOf(live.validUntil) : undefined,
        confidence: Number(live.confidence ?? 0),
      });
    }
    // Chronological, matching how compaction built the summary originally.
    return out.sort((a, b) => (a.validFrom < b.validFrom ? -1 : 1));
  }

  /** Walk supersededBy to the current row. Bounded at 8 hops. */
  private async followSupersedes(db: Surreal, row: any): Promise<any | null> {
    let current = row;
    for (let hop = 0; hop < 8 && current?.supersededBy; hop++) {
      const [next] = await db.query<[any[]]>(
        `SELECT id, predicate, object, confidence, validFrom, validUntil,
                retractedAt, supersededBy
           FROM knowledge_fact WHERE id = $id`,
        { id: new StringRecordId(String(current.supersededBy)) },
      );
      const found = ((next as any[]) ?? [])[0];
      if (!found) return current;
      current = found;
    }
    return current;
  }

  /** Regenerate the summary text and clear the stale mark. */
  private async rewrite(
    db: Surreal,
    summaryId: string,
    parents: FactToSummarize[],
  ): Promise<boolean> {
    const text = await this.summaryGenerator.generate(parents);
    if (!text) return false;
    const meanConfidence =
      parents.reduce((acc, p) => acc + p.confidence, 0) / parents.length;
    await db.query(
      `UPDATE $id SET
         object = $object, confidence = $confidence,
         validFrom = <datetime>$validFrom,
         validUntil = <datetime>$validUntil,
         derivedFrom = $derivedFrom,
         staleAt = NONE, staleReason = NONE`,
      {
        id: new StringRecordId(summaryId),
        object: text,
        confidence: meanConfidence,
        validFrom: parents[0].validFrom,
        validUntil:
          parents[parents.length - 1].validUntil ??
          parents[parents.length - 1].validFrom,
        // Re-point at the CURRENT parents: a superseded parent we followed is
        // no longer what this summary is derived from, and leaving the old id
        // would make the next invalidation pass chase a dead row.
        derivedFrom: parents.map((p) => new StringRecordId(p.factId)),
      },
    );
    return true;
  }

  /** No parent survived — the summary has nothing left to summarise. */
  private async retractOrphan(db: Surreal, summaryId: string): Promise<void> {
    await db.query(
      `UPDATE $id SET
         status = 'retracted', retractedAt = time::now(),
         retractedBy = 'cascade',
         retractionReason = 'recompose: all parents retracted',
         validUntil = time::now(), staleAt = NONE, staleReason = NONE`,
      { id: new StringRecordId(summaryId) },
    );
  }
}

async function loadCursor(db: Surreal): Promise<number> {
  const [rows] = await db.query<[any[]]>(
    `SELECT lastVersionstamp FROM changefeed_state WHERE source = $s LIMIT 1`,
    { s: CURSOR },
  );
  return ((rows as any[]) ?? [])[0]?.lastVersionstamp ?? 0;
}

async function advanceCursor(db: Surreal, versionstamp: number): Promise<void> {
  await db.query(
    `UPSERT changefeed_state:[$s] CONTENT {
       source: $s, lastVersionstamp: $v, updatedAt: time::now()
     }`,
    { s: CURSOR, v: versionstamp },
  );
}

/** The SDK returns datetimes as Date; FactToSummarize wants ISO strings. */
function isoOf(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
