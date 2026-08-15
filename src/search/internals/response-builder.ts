import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { countJsonTokens } from '../../common/token-counter';
import type { SearchDto } from '../dto/search.dto';
import type { SearchHit } from '../search.types';
import type { SearchTuning } from '../retrieval-profile';
import type { EntityBucket } from './types';

/** The shaping slice of SearchTuning; defaults mirror the env defaults. */
export type ShapingTuning = Pick<
  SearchTuning,
  'tokenCountOffload' | 'tokenOffloadMinHits'
>;

/**
 * Assemble final SearchHit rows from the fact-centric top-K bucket
 * list. Matched facts render sorted by score; `factsPerEntity` caps the
 * per-entity window (under fact-centric selection the global budget
 * already bounded the total, so the cap is a formality that keeps the
 * hit shape stable).
 */
export interface AssembleHitsOptions {
  topEntities: EntityBucket[];
  entityTypes: string[] | undefined;
  requireProvenance?: boolean;
  /** Per-entity fact cap. Default 5. */
  factsPerEntity?: number;
}

export function assembleHits({
  topEntities,
  entityTypes,
  requireProvenance = false,
  factsPerEntity = 5,
}: AssembleHitsOptions): SearchHit[] {
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
      const matchedSorted = e.facts
        .filter((sf) => !requireProvenance || hasProvenance(sf.row.source))
        .sort((a, b) => b.score - a.score);
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
      const matchedRender = matchedSorted.map(({ row, score, breakdown }) => ({
        factId: String(row.id),
        predicate: row.predicate,
        object: row.object,
        confidence: row.confidence,
        validFrom: row.validFrom,
        validUntil: row.validUntil ?? undefined,
        status: row.status,
        sourceKey: row.trustSnapshot?.sourceKey ?? undefined,
        ...(row.highlight ? { highlight: row.highlight } : {}),
        score,
        breakdown,
      }));
      return {
        entityId: e.entityId,
        entityType: ent.type,
        canonicalName: ent.canonicalName,
        externalRefs: mergedRefs,
        facts: matchedRender.slice(0, factsPerEntity),
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
  tuning?: ShapingTuning,
): Promise<number[]> {
  const syncCounts = () => results.map((hit) => countJsonTokens(hit) + 1);
  const offloadEnabled = tuning?.tokenCountOffload ?? true;
  const minHits = tuning?.tokenOffloadMinHits ?? OFFLOAD_MIN_HITS_DEFAULT;
  if (!pool || !offloadEnabled || results.length < minHits || !pool.enabled()) {
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
// eslint-disable-next-line max-params
export async function applyOutputShaping(
  hits: SearchHit[],
  dto: SearchDto,
  pool?: TokenCountPool,
  tuning?: ShapingTuning,
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
    const perHit = await countHitTokens(results, pool, tuning);
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
