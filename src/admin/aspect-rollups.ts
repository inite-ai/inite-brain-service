/**
 * Aspect rollups (DERIVER_ASPECT_ROLLUPS, July program A2 /
 * docs/roadmap/locomo-sota-architecture-2026-07.md §6.3 item 4) — the
 * write-time composition lever for the measured largest miss bucket:
 * MH-enumeration golds where every list item EXISTS as its own
 * proposition but no single atom holds the list (42 of 166 armD
 * misses sit in the gold-absent bucket dominated by this class).
 *
 * Composition is MECHANICAL — group this run's landed rows per
 * (entity, aspect), sort members chronologically, join into one
 * list-fact. No LLM: deterministic under re-derive (one embeddings batch per conversation is the only added cost),
 * and the members are already self-contained sentences (the deriver
 * contract). An LLM-composed variant is the follow-up only if the
 * mechanical leg shows signal.
 *
 * The rollup writes as predicate `<aspect>_rollup` so it never
 * competes in the same slot as its members (slot semantics group by
 * (entity, predicate)); validFrom = newest member (the rollup is
 * current as of its last addition); provenance marks rollup: true and
 * carries the member count.
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

export interface ComposedRollup {
  entityId: string;
  predicate: string;
  object: string;
  validFrom: Date;
  memberCount: number;
  /** Deduped union of member grounding turns (insertion-capped). */
  episodeIds: string[];
}

/** Aspects whose rollup is meaningless noise (identity is one value;
 *  `other` is a grab-bag). */
const SKIP_ASPECTS = new Set(['identity', 'other']);

export function composeAspectRollups(
  pool: RollupMember[],
  opts?: {
    /** Minimum members before a rollup is worth a row (default 3). */
    minMembers?: number;
    /** Object-length cap, chars (default 2400 — the digest precedent). */
    charCap?: number;
  },
): ComposedRollup[] {
  const minMembers = opts?.minMembers ?? 3;
  const charCap = opts?.charCap ?? 2400;
  const groups = new Map<string, RollupMember[]>();
  for (const m of pool) {
    if (!m.object?.trim() || SKIP_ASPECTS.has(m.predicate)) continue;
    const key = `${m.entityId}::${m.predicate}`;
    const g = groups.get(key);
    if (g) g.push(m);
    else groups.set(key, [m]);
  }
  const out: ComposedRollup[] = [];
  for (const members of groups.values()) {
    const rollup = composeGroup(members, minMembers, charCap);
    if (rollup) out.push(rollup);
  }
  return out;
}

/** One (entity, aspect) group → one rollup row, or null under the
 *  member floor. Split from the group loop for the complexity gate. */
function composeGroup(
  members: RollupMember[],
  minMembers: number,
  charCap: number,
): ComposedRollup | null {
  {
    // Sort BEFORE dedupe: identical texts recurring across sessions
    // keep the EARLIEST-dated copy (first-emitted kept the wrong date
    // and position once the date audit rewrites occurred_on without
    // changing the text).
    members.sort((a, b) => a.validFrom.getTime() - b.validFrom.getTime());
    const seen = new Set<string>();
    const unique = members.filter((m) => {
      const k = m.object.trim().toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    if (unique.length < minMembers) return null;
    // The header/suffix envelope rides INSIDE the cap — the §12 audit
    // pre-registered a 2400-char ceiling on the stored object.
    const ENVELOPE = 100;
    const budget = Math.max(0, charCap - ENVELOPE);
    const parts: string[] = [];
    let length = 0;
    let kept = 0;
    const episodeIds: string[] = [];
    const seenEps = new Set<string>();
    for (const m of unique) {
      const text = m.object.trim().replace(/\.\s*$/, '');
      // A session-date fallback rendered as "(YYYY-MM-DD)" would
      // convert mention metadata into an asserted event date no atom
      // ever claimed — exactly the off-by-days class. Date-stamp only
      // audited/real event dates.
      const piece = m.dated
        ? `${text} (${m.validFrom.toISOString().slice(0, 10)})`
        : text;
      // Keep the CHRONOLOGICAL PREFIX under the cap — enumeration golds
      // skew to the full history, and a silent mid-list cut is worse
      // than a stated one.
      if (length + piece.length + 2 > budget) break;
      parts.push(piece);
      length += piece.length + 2;
      kept += 1;
      for (const ep of m.episodeIds ?? []) {
        if (!seenEps.has(ep) && seenEps.size < 64) {
          seenEps.add(ep);
          episodeIds.push(ep);
        }
      }
    }
    if (kept < minMembers) return null;
    const truncated = kept < unique.length ? `; …and ${unique.length - kept} more` : '';
    return {
      entityId: unique[0].entityId,
      predicate: `${unique[0].predicate}_rollup`,
      object: `Complete ${unique[0].predicate} record (${kept}${truncated ? ` of ${unique.length}` : ''} items): ${parts.join('; ')}${truncated}`,
      validFrom: unique[unique.length - 1].validFrom,
      memberCount: unique.length,
      episodeIds,
    };
  }
}

/**
 * Fold this batch's LANDED rows into the conversation pool — outcomes
 * align with rows by index (the resolver batch contract); SKIPPED /
 * REJECTED rows are not propositions and never roll up.
 */
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
      ? (r.source.episodeIds as unknown[]).filter(
          (e): e is string => typeof e === 'string',
        )
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
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}
