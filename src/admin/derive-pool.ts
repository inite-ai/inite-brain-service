/**
 * The landed-row pool for the write-time composition passes.
 *
 * This file used to be the aspect-rollup composer (July program A2).
 * That leg measured NULL/negative — 76.0 vs 77.8 (p=0.23) with
 * multi-hop −6.3 the wrong way, "rollups displace atoms"
 * (docs/roadmap/v11-session-2026-08.md §13) — and was retired. What
 * survives is what it shared with the leg that is still open: the
 * pool of rows a conversation actually landed, accumulated as the
 * resolver batch reports outcomes, which DERIVER_COMPOSE_PASS reads.
 *
 * A row enters the pool only when it LANDED (no SKIPPED/REJECTED
 * outcome) and only when it is not user-scoped — a composition over
 * one member's private row would leak it into a shared fact.
 */

export interface RollupMember {
  entityId: string;
  /** Aspect slug — the derived row's predicate. */
  predicate: string;
  /** The member proposition text. */
  object: string;
  validFrom: Date;
  /** True only for REAL event dates (deriver occurred_on, calendar
   *  round-tripped) — session-date fallbacks and cleared sentinels
   *  must not render as asserted event dates in the rollup text. */
  dated: boolean;
  /** Grounding turns of the member — unioned onto the rollup's source
   *  so the provenance/excerpt lane can follow it like any fact. */
  episodeIds?: string[];
}

export function accumulateLanded(
  pool: RollupMember[],
  rows: Array<{
    entityId: string;
    predicate: string;
    object: string;
    validFrom: Date;
    source?: { episodeIds?: unknown };
    userId?: string;
  }>,
  opts: {
    outcomes: Array<{ outcome: string }>;
    meta?: Array<{ dated: boolean }>;
  },
): void {
  const { outcomes, meta } = opts;
  rows.forEach((r, i) => {
    const o = outcomes[i]?.outcome;
    if (o === 'SKIPPED' || o === 'REJECTED') return;
    // Audit 2026-08-21 P0: user-scoped rows never feed the rollup /
    // compose pools — those aggregates land tenant-global, which would
    // launder one user's facts into everyone's view.
    if (typeof r.userId === 'string' && r.userId.length > 0) return;
    const eps = Array.isArray(r.source?.episodeIds)
      ? (r.source.episodeIds as unknown[]).filter((e): e is string => typeof e === 'string')
      : undefined;
    pool.push({
      entityId: r.entityId,
      predicate: r.predicate,
      object: r.object,
      validFrom: r.validFrom,
      dated: meta?.[i]?.dated ?? false,
      ...(eps && eps.length > 0 ? { episodeIds: eps } : {}),
    });
  });
}

/** Majority entity among a composition's member atoms (audit
 *  2026-08-19: attribution must not default to the first member). */
export function majorityEntityId(members: RollupMember[]): string {
  const counts = new Map<string, number>();
  for (const m of members) {
    counts.set(m.entityId, (counts.get(m.entityId) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return ranked[0]?.[0] ?? ''; // empty only when members is empty
}
