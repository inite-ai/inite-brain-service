import { Injectable, Logger } from '@nestjs/common';
import { StringRecordId } from 'surrealdb';
import { SurrealService } from '../db/surreal.service';

/**
 * Backfill of the 0117 `userIds` member set on legacy episode_segment
 * rows (POST /v1/admin/maintenance/segments/backfill-user-ids).
 *
 * With PRIVACY_SEGMENT_USER_FENCE on, a row whose `userIds IS NONE`
 * (written before 0117) is FAIL-CLOSED hidden from every user-scoped
 * caller — this endpoint recomputes the member set from the row's
 * `episodeIds` grounding and stamps it, restoring visibility under the
 * per-member contract. Operator order: migrate 0117 → run this once per
 * tenant → flip the fence.
 *
 * 3.2.4 planner idiom (user-forget.service.ts): recomputing userIds
 * traverses episodeIds record links, an UPDATE shape the planner
 * mishandles — so the page SELECT uses a plain option-field WHERE
 * (safe shape), episodes are resolved by explicit ids, the set is
 * computed in TS, and every UPDATE is PRIMARY-KEY addressed
 * (`UPDATE $id SET userIds = $set`) — never a WHERE.
 *
 * Idempotent (only touches `userIds IS NONE` rows) and safe under a
 * rolling deploy: the post-0117 composer stamps `userIds` on every new
 * row already. A row referencing a MISSING episode (dangling ref —
 * should not occur, erasure deletes segments whole) is skipped and
 * counted; it stays hidden under the fence (fail-closed).
 *
 * Scenes (memory_episode) are NOT covered here: scene backfill =
 * re-run POST /v1/admin/maintenance/scenes (the composer's idempotent
 * atomic swap per conversation × segmenterVersion stamps userIds).
 */
const PAGE_SIZE = 200;
const DEFAULT_MAX_ROWS = 5000;
const MAX_ROWS_CAP = 50000;

export interface SegmentBackfillResult {
  scanned: number;
  updated: number;
  remaining: number;
  skippedDangling: number;
}

interface SegmentPageRow {
  id: unknown;
  episodeIds?: unknown[];
}

type QueryDb = {
  query: <T>(sql: string, params?: Record<string, unknown>) => Promise<T>;
};

@Injectable()
export class SegmentBackfillService {
  private readonly logger = new Logger(SegmentBackfillService.name);

  constructor(private readonly surreal: SurrealService) {}

  async backfillUserIds(
    companyId: string,
    opts: { maxRows?: number | undefined } = {},
  ): Promise<SegmentBackfillResult> {
    const maxRows = Math.min(
      Math.max(Math.floor(opts.maxRows ?? DEFAULT_MAX_ROWS), 1),
      MAX_ROWS_CAP,
    );
    const result: SegmentBackfillResult = {
      scanned: 0,
      updated: 0,
      remaining: 0,
      skippedDangling: 0,
    };
    await this.surreal.withCompany(companyId, async (db) => {
      // Skipped (dangling) rows keep `userIds IS NONE` and would reload
      // on every page — the seen-set makes each page's FRESH slice the
      // progress measure, so the loop terminates when a page brings
      // nothing new (all-dangling head) or the budget is spent.
      const seen = new Set<string>();
      for (;;) {
        const batch = Math.min(PAGE_SIZE, maxRows - result.scanned);
        if (batch <= 0) break;
        const [pageRows] = await db.query<[SegmentPageRow[]]>(
          `SELECT id, episodeIds FROM episode_segment WHERE userIds IS NONE LIMIT $batch`,
          { batch },
        );
        const page = pageRows ?? [];
        const fresh = page.filter((r) => !seen.has(String(r.id)));
        if (fresh.length === 0) break;
        await this.backfillPage(db, { fresh, result, seen });
        if (page.length < batch) break;
      }
      const [counts] = await db.query<[Array<{ n: number }>]>(
        `SELECT count() AS n FROM episode_segment WHERE userIds IS NONE GROUP ALL`,
      );
      result.remaining = counts?.[0]?.n ?? 0;
    });
    this.logger.log(
      `segment userIds backfill (${companyId}): scanned=${result.scanned} ` +
        `updated=${result.updated} remaining=${result.remaining} ` +
        `skippedDangling=${result.skippedDangling}`,
    );
    return result;
  }

  /** One page: resolve member episodes by id, stamp sorted sets. */
  private async backfillPage(
    db: QueryDb,
    ctx: { fresh: SegmentPageRow[]; result: SegmentBackfillResult; seen: Set<string> },
  ): Promise<void> {
    const { fresh, result, seen } = ctx;
    const episodeRefs = [
      ...new Set(fresh.flatMap((r) => (r.episodeIds ?? []).map((e) => String(e)))),
    ].map((id) => new StringRecordId(id));
    const [episodeRows] =
      episodeRefs.length > 0
        ? await db.query<[Array<{ id: unknown; userId?: string }>]>(`SELECT id, userId FROM $eps`, {
            eps: episodeRefs,
          })
        : [[] as Array<{ id: unknown; userId?: string }>];
    const userByEpisode = new Map(
      (episodeRows ?? []).map((e) => [String(e.id), e.userId] as const),
    );
    for (const seg of fresh) {
      seen.add(String(seg.id));
      result.scanned += 1;
      const refs = (seg.episodeIds ?? []).map((e) => String(e));
      if (refs.some((r) => !userByEpisode.has(r))) {
        // Dangling reference: stays hidden under the fence (fail-closed).
        result.skippedDangling += 1;
        continue;
      }
      const set = [
        ...new Set(refs.map((r) => userByEpisode.get(r)).filter((u): u is string => !!u)),
      ].sort();
      // Primary-key addressed — never a WHERE (3.2.4 planner idiom).
      await db.query(`UPDATE $id SET userIds = $set`, {
        id: new StringRecordId(String(seg.id)),
        set,
      });
      result.updated += 1;
    }
  }
}
