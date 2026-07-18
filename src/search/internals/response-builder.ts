import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { countJsonTokens } from '../../common/token-counter';
import { envFlagEnabled } from '../../common/env-validation';
import type { SearchDto } from '../dto/search.dto';
import type { SearchHit } from '../search.types';
import type { EntityBucket, FactRow } from './types';

/**
 * Assemble final SearchHit rows from a reranked top-K bucket list plus
 * the backfilled per-entity fact map. Two-stage fact rendering:
 *   1. Matched facts first, sorted by score (existing behaviour).
 *   2. Backfill — pick at most ONE fact per NEW predicate not already
 *      represented in matched. Recency breaks per-predicate ties.
 *      Predicate-diverse instead of pure recency because the
 *      per-predicate eval surfaced that recency-only order buries
 *      dob/address under repeated occupation/genre facts on
 *      wikidata-shape entities.
 *
 * Per-entity cap defaults to 5 but is tunable via `factsPerEntity`
 * (SEARCH_FACTS_PER_ENTITY): an entity that consolidates hundreds of facts
 * (a chatty speaker) needs a wider window so a substantive fact ranked 6th+
 * still reaches synthesis. The diversity step keeps the cap useful: a query
 * for "Anton Chekhov born 1860" gets {name, dob, address, occupation, genre}
 * instead of {name, occupation×4}. `backfillPerPredicate` relaxes the strict
 * one-fact-per-predicate rule (a crisp `preference` fact was dropped when a
 * different `preference` already matched), and backfill is ordered by lexical
 * relevance to the query so a query-relevant fact beats a merely-recent one.
 */
export interface AssembleHitsOptions {
  topEntities: EntityBucket[];
  backfillByEntity: Map<string, FactRow[]>;
  entityTypes: string[] | undefined;
  requireProvenance?: boolean;
  /** Per-entity fact cap. Default 5. */
  factsPerEntity?: number;
  /** Max backfill facts per predicate. Default 1 (the historical rule). */
  backfillPerPredicate?: number;
  /** Raw query text — backfill is ordered by token overlap against it. */
  query?: string;
}

/** Content tokens of the query, ≥3 chars, lowercased — for backfill ordering. */
function queryTokens(query: string | undefined): Set<string> {
  if (!query) return new Set();
  return new Set(
    query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3),
  );
}

/** Count of a fact object's tokens that appear in the query token set. */
function relevanceOverlap(object: string, terms: Set<string>): number {
  if (terms.size === 0) return 0;
  let n = 0;
  for (const t of object.toLowerCase().split(/[^a-z0-9]+/)) {
    if (t.length >= 3 && terms.has(t)) n++;
  }
  return n;
}

export function assembleHits({
  topEntities,
  backfillByEntity,
  entityTypes,
  requireProvenance = false,
  factsPerEntity = 5,
  backfillPerPredicate = 1,
  query,
}: AssembleHitsOptions): SearchHit[] {
  const qTerms = queryTokens(query);
  // requireProvenance — DTO compliance primitive: keep only facts whose
  // ingest path preserved a non-empty `source` trail (vertical/eventId/
  // messageId). `source` is on FactRow here but not projected onto the
  // wire-format SearchHit fact, so the filter has to run at assembly time.
  const hasProvenance = (src: unknown): boolean =>
    !!src && typeof src === 'object' && Object.keys(src as object).length > 0;
  return topEntities
    .filter((e) => {
      if (!entityTypes) return true;
      const ent = e.facts[0]?.row.entity;
      return ent ? entityTypes.includes(ent.type) : false;
    })
    .map((e) => {
      const ent = e.facts[0]?.row.entity ?? {
        id: e.entityId,
        type: 'other',
        canonicalName: e.entityId,
        externalRefs: {},
      };
      // Merge externalRefs across all facts in the bucket. After
      // identity-merge re-attribution, the bucket contains both the
      // survivor's own facts (carrying survivor refs only) and the
      // loser's facts (now carrying merged refs); the union is the
      // right display so cross-vertical refs all resolve to the same
      // hit.
      const mergedRefs: Record<string, string> = {};
      for (const sf of e.facts) {
        const refs = sf.row.entity?.externalRefs;
        if (refs) Object.assign(mergedRefs, refs);
      }
      const matchedFactIds = new Set(e.facts.map((sf) => String(sf.row.id)));
      const matchedRender = e.facts
        .filter((sf) => !requireProvenance || hasProvenance(sf.row.source))
        .sort((a, b) => b.score - a.score)
        .map(({ row, score, breakdown }) => ({
          factId: String(row.id),
          predicate: row.predicate,
          object: row.object,
          confidence: row.confidence,
          validFrom: row.validFrom,
          validUntil: row.validUntil ?? undefined,
          status: row.status,
          sourceKey: row.trustSnapshot?.sourceKey ?? undefined,
          score,
          breakdown,
        }));
      // Count predicates already used by matched facts — backfill tops each
      // predicate up to `backfillPerPredicate` total across matched+backfill.
      const predicateCount = new Map<string, number>();
      for (const f of matchedRender) {
        predicateCount.set(f.predicate, (predicateCount.get(f.predicate) ?? 0) + 1);
      }
      // Relevance-ordered backfill is opt-in with the widened window: it only
      // engages when backfillPerPredicate > 1 (the benchmark knob). At the
      // default (1) backfill stays PURE RECENCY — byte-identical to the
      // historical behaviour — so enabling nothing changes nothing. (The
      // reorder is query-driven and would otherwise fire on every call, which
      // is not default-safe.)
      const relevanceOrder = backfillPerPredicate > 1 && qTerms.size > 0;
      const backfillRows = (backfillByEntity.get(e.entityId) ?? [])
        .filter((r) => !matchedFactIds.has(String(r.id)))
        .filter((r) => !requireProvenance || hasProvenance(r.source))
        .sort((a, b) => {
          if (relevanceOrder) {
            const rel =
              relevanceOverlap(b.object, qTerms) -
              relevanceOverlap(a.object, qTerms);
            if (rel !== 0) return rel;
          }
          return (
            new Date(b.recordedAt).getTime() - new Date(a.recordedAt).getTime()
          );
        });
      const backfillRender: typeof matchedRender = [];
      for (const row of backfillRows) {
        const used = predicateCount.get(row.predicate) ?? 0;
        if (used >= backfillPerPredicate) continue;
        predicateCount.set(row.predicate, used + 1);
        backfillRender.push({
          factId: String(row.id),
          predicate: row.predicate,
          object: row.object,
          confidence: row.confidence,
          validFrom: row.validFrom,
          validUntil: row.validUntil ?? undefined,
          status: row.status,
          sourceKey: row.trustSnapshot?.sourceKey ?? undefined,
          score: 0,
          breakdown: {
            fusedScore: 0,
            confidence: row.confidence,
            decay: 1,
            predBoost: 1,
            finalScore: 0,
            stages: ['backfill'],
          },
        });
      }
      return {
        entityId: e.entityId,
        entityType: ent.type,
        canonicalName: ent.canonicalName,
        externalRefs: mergedRefs,
        facts: [...matchedRender, ...backfillRender].slice(0, factsPerEntity),
        score: e.bestScore,
      };
    })
    .filter((hit) => !requireProvenance || hit.facts.length > 0);
}

/**
 * Minimal structural slice of JobWorkerPool that the shaping path needs.
 * Kept as an interface so response-builder (a pure function module)
 * doesn't import the jobs service and unit tests can stub it.
 */
export interface TokenCountPool {
  enabled(): boolean;
  run<R = unknown>(
    modulePath: string,
    input: unknown,
    opts?: { acquireTimeoutMs?: number },
  ): Promise<R>;
}

/** Never park the request path behind a busy pool longer than this. */
const OFFLOAD_ACQUIRE_TIMEOUT_MS = 25;
/** Below this many hits the postMessage round-trip costs more than it saves. */
const OFFLOAD_MIN_HITS_DEFAULT = 24;

let cachedWorkerModulePath: string | null = null;

/**
 * Absolute path of the token-count worker-job handed to pool.run().
 * Same `.js`-after-build / `.ts`-in-dev idiom as the pool's own
 * runner resolution. Exported for the offload unit tests.
 */
export function tokenCountWorkerModulePath(): string {
  if (cachedWorkerModulePath) return cachedWorkerModulePath;
  const dist = join(__dirname, '..', '..', 'common', 'token-count.worker-job.js');
  cachedWorkerModulePath = existsSync(dist)
    ? dist
    : join(__dirname, '..', '..', 'common', 'token-count.worker-job.ts');
  return cachedWorkerModulePath;
}

function offloadMinHits(): number {
  const raw = process.env.SEARCH_TOKEN_OFFLOAD_MIN_HITS;
  const n = raw === undefined ? Number.NaN : parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 ? n : OFFLOAD_MIN_HITS_DEFAULT;
}

/**
 * Per-hit token counts (+1 per hit for the array comma). Serialisation
 * happens on the main thread either way; for large hit lists the
 * tiktoken encoding — the actual CPU hog — batches out to the worker
 * pool with a short acquire timeout. ANY offload failure (pool busy,
 * disabled, shutting down, worker error, malformed reply) falls back
 * to the existing synchronous loop, so shaping never degrades and the
 * request path never parks behind long CPU-bound jobs.
 */
async function countHitTokens(
  results: SearchHit[],
  pool?: TokenCountPool,
): Promise<number[]> {
  const syncCounts = () => results.map((hit) => countJsonTokens(hit) + 1);
  const offloadEnabled = envFlagEnabled(
    process.env.SEARCH_TOKEN_COUNT_OFFLOAD ?? '1',
  );
  if (
    !pool ||
    !offloadEnabled ||
    results.length < offloadMinHits() ||
    !pool.enabled()
  ) {
    return syncCounts();
  }
  const texts = results.map((hit) => JSON.stringify(hit));
  try {
    const out = await pool.run<{ counts: number[] }>(
      tokenCountWorkerModulePath(),
      { texts },
      { acquireTimeoutMs: OFFLOAD_ACQUIRE_TIMEOUT_MS },
    );
    const counts = out?.counts;
    if (!Array.isArray(counts) || counts.length !== results.length) {
      return syncCounts();
    }
    return counts.map((c) => c + 1);
  } catch {
    return syncCounts();
  }
}

/**
 * Apply post-hits KnowQL-lite shaping: confidenceFloor, outputShape,
 * tokenBudget. Pure transforms — input list is not mutated.
 *
 * confidenceFloor — stricter than DTO.minConfidence (which gates raw
 * fact field). Applied AFTER decay×confidence weighting, so it shapes
 * "agent's confidence in the answer".
 *
 * outputShape — `compact` keeps only the top fact per entity (score
 * stripped); `ids` strips facts entirely, keeping entity headers.
 *
 * tokenBudget — drop entities (lowest-score first) until the
 * serialised payload fits. Tokens counted exactly via tiktoken
 * (cl100k_base) on the JSON-serialised body — same encoding the
 * downstream OpenAI/Anthropic billing uses, so the budget the caller
 * specifies is the budget they'll actually consume. Async because the
 * per-hit counting may batch out to the worker pool (see
 * countHitTokens); semantics are identical on both paths.
 */
export async function applyOutputShaping(
  hits: SearchHit[],
  dto: SearchDto,
  pool?: TokenCountPool,
): Promise<SearchHit[]> {
  let results = hits;
  if (dto.confidenceFloor !== undefined) {
    const floor = dto.confidenceFloor;
    results = results
      .map((r) => ({
        ...r,
        facts: r.facts.filter((f) => f.score >= floor),
      }))
      .filter((r) => r.facts.length > 0);
  }
  const shape = dto.outputShape ?? 'full';
  if (shape === 'compact') {
    results = results.map((r) => ({
      ...r,
      facts: r.facts.slice(0, 1).map((f) => ({
        ...f,
        score: undefined as unknown as number,
      })),
    }));
  } else if (shape === 'ids') {
    results = results.map((r) => ({
      entityId: r.entityId,
      entityType: r.entityType,
      canonicalName: r.canonicalName,
      externalRefs: {},
      facts: [],
      score: r.score,
    }));
  }
  if (dto.tokenBudget !== undefined) {
    const budget = dto.tokenBudget;
    // One tiktoken pass per hit + one for the envelope, then a
    // prefix-sum cut. The previous loop re-encoded the ENTIRE remaining
    // payload after every pop — O(N) full encodes of an up-to-100-hit
    // JSON body, synchronous on the main thread. Per-hit sums
    // over-estimate the joined encoding only slightly (BPE merges
    // across boundaries reduce tokens; +1 covers the array comma), so
    // the budget stays a hard ceiling. The per-hit encodes batch out
    // to the worker pool for large lists (sync fallback inside).
    const envelopeTokens = countJsonTokens({ results: [] });
    const perHit = await countHitTokens(results, pool);
    let used = envelopeTokens;
    let keep = 0;
    for (const hitTokens of perHit) {
      if (used + hitTokens > budget) break;
      used += hitTokens;
      keep += 1;
    }
    results = results.slice(0, keep);
    // Safety net for the non-compositional corner: verify the joined
    // encoding once; in the rare over-budget case trim the tail —
    // bounded by the estimate error (a hit or two), not by N.
    while (results.length > 0 && countJsonTokens({ results }) > budget) {
      results.pop();
    }
  }
  return results;
}
