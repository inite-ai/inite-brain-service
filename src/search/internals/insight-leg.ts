import type { Surreal } from 'surrealdb';
import type { FactRow } from './types';
import {
  derivedVersionFence,
  type ReadPin,
} from '../../episodes/read-pin.service';

/**
 * Insight fusion leg (V8 §1 — the qualified insight lane).
 *
 * Retrieves derived INSIGHT rows — aspect aggregates written by the
 * aggregate composer (source.recorder='aggregate-composer-v1') and
 * promotion/compaction summaries (predicate 'summary_*') — as their own
 * pseudo-fact pool: dense + BM25 in parallel, ready for the SAME convex
 * fuse() the fact legs use (one fusion doctrine, audit #21).
 *
 * The design mirrors the fused segment leg with one deliberate
 * inversion: segments enter the pipeline and compete for the fact
 * budget; insights must NOT. The naive cut (compose aggregates into
 * wd-v2 and let the fact legs carry them) is a measured null — MS tie,
 * BEAM −2.0pp, summarization DOWN — because aggregate rows displace
 * the atomic facts the generator needed. So under
 * insightEvidence='routed' the fact legs EXCLUDE these rows
 * (where-builder excludeInsightRows) and this leg feeds a SEPARATE
 * prompt slot (INSIGHT_TOP_K below, not factBudget), only for the
 * question classes that pay for it (summary / enumeration lanes —
 * dispatch is the caller's job; this leg is class-agnostic).
 */
export interface InsightLegOptions {
  db: Pick<Surreal, 'query'>;
  queryText: string;
  queryVector: number[] | null;
  /** Candidates per leg (the lane idiom: max(topK*3, 12)). */
  fetchK: number;
  callerScopes: string[];
  userId?: string;
  /**
   * Derived world(s) this read serves (same pin the fact legs apply):
   * a batch-composed aggregate is stamped with its world and must not
   * leak into legacy reads, nor vice versa. An array is the multiworld
   * READ union (§10).
   */
  derivedVersion: ReadPin;
}

export interface InsightRow {
  id: unknown;
  predicate: string;
  object: string;
  validFrom?: unknown;
  score?: number;
  // Policy fields (audit 2026-08-19 P1): the insight lane's row filter
  // reads these — a projection without them judged rules over null.
  source?: unknown;
  trustSnapshot?: {
    authority?: number;
    declaredTrust?: number;
    learnedTrust?: number;
  } | null;
  corroboration?: { count?: number } | null;
  userId?: string | null;
}

/**
 * Insights per prompt — the SEPARATE budget slot. A tuning constant by
 * design (the segment-leg precedent: prefer a constant over a knob
 * until a leg says otherwise); deliberately NOT part of factBudget so
 * insights can never displace atomic facts.
 */
export const INSIGHT_TOP_K = 4;

/**
 * Per-insight prompt budget. Aggregate objects are enumerating
 * propositions and summaries are compaction prose — a handful of long
 * ones must not blow up the prompt the way unbudgeted segments did
 * (V6: fused ran 8.6-12.4k prompt tokens vs ~4.6k control before the
 * segment budget landed).
 */
const INSIGHT_PROMPT_CHAR_BUDGET = 800;

function budgetText(text: string): string {
  if (text.length <= INSIGHT_PROMPT_CHAR_BUDGET) return text;
  const cut = text.slice(0, INSIGHT_PROMPT_CHAR_BUDGET);
  const atWord = cut.slice(0, cut.lastIndexOf(' ') + 1 || undefined);
  return `${atWord.trimEnd()} […]`;
}

function toFactRow(r: InsightRow, kind: 'vector' | 'lexical'): FactRow {
  const valid = String(r.validFrom ?? '');
  return {
    id: r.id,
    entityId: r.id,
    predicate: r.predicate,
    object: budgetText(r.object),
    confidence: 1,
    validFrom: valid,
    recordedAt: new Date().toISOString(),
    status: 'active',
    source: r.source ?? { vertical: 'insight' },
    ...(r.trustSnapshot !== undefined ? { trustSnapshot: r.trustSnapshot } : {}),
    ...(r.corroboration !== undefined ? { corroboration: r.corroboration } : {}),
    ...(r.userId !== undefined ? { userId: r.userId } : {}),
    ...(kind === 'vector'
      ? { simScore: r.score ?? 0 }
      : { bm25Score: r.score ?? 0 }),
  };
}

/**
 * Run the two insight queries. Same shared idioms as every leg: PII
 * fence for callers without brain:read_pii, fail-closed user scope
 * (0055), derived-world pin, lifecycle closure. Returns pseudo-FactRow
 * lists for the shared convex fuse().
 */
export async function runInsightLegs({
  db,
  queryText,
  queryVector,
  fetchK,
  callerScopes,
  userId,
  derivedVersion,
}: InsightLegOptions): Promise<{
  vectorRows: FactRow[];
  lexicalRows: FactRow[];
}> {
  const piiGate = callerScopes.includes('brain:read_pii')
    ? ''
    : 'AND piiClass IS NONE';
  const userGate = userId
    ? 'AND (userId IS NONE OR userId = $scopeUserId)'
    : 'AND userId IS NONE';
  const userParams = userId ? { scopeUserId: userId } : {};
  const worldFence = derivedVersionFence(derivedVersion);
  const worldGate = worldFence.clause;
  const worldParams = worldFence.params;
  // The inverse of the fact legs' excludeInsightRows arbitration.
  const insightGate = `AND (source.recorder = $insightRecorder
             OR string::starts_with(predicate, 'summary_'))
           AND retractedAt IS NONE
           AND status != 'compacted'`;
  const shared = {
    insightRecorder: 'aggregate-composer-v1',
    ...userParams,
    ...worldParams,
  };

  const [denseRes, bm25Res] = await Promise.all([
    queryVector
      ? db.query<[InsightRow[]]>(
          `SELECT id, predicate, object, validFrom,
                  source, trustSnapshot, corroboration, userId,
                  vector::similarity::cosine(embedding, $q) AS score
             FROM knowledge_fact
            WHERE embedding != NONE ${insightGate} ${piiGate} ${userGate} ${worldGate}
            ORDER BY score DESC
            LIMIT $k`,
          { q: queryVector, k: fetchK, ...shared },
        )
      : Promise.resolve([[] as InsightRow[]]),
    db.query<[InsightRow[]]>(
      `SELECT id, predicate, object, validFrom,
              source, trustSnapshot, corroboration, userId,
              math::max([search::score(1), search::score(2)]) AS score
         FROM knowledge_fact
        WHERE (searchHaystack @1@ $q OR object @2@ $q)
          ${insightGate} ${piiGate} ${userGate} ${worldGate}
        ORDER BY score DESC
        LIMIT $k`,
      { q: queryText, k: fetchK, ...shared },
    ),
  ]);
  return {
    vectorRows: (denseRes[0] ?? []).map((r) => toFactRow(r, 'vector')),
    lexicalRows: (bm25Res[0] ?? []).map((r) => toFactRow(r, 'lexical')),
  };
}
