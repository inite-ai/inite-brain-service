import { Surreal, StringRecordId } from 'surrealdb';
import type { SearchDto } from '../dto/search.dto';
import type { EntityBucket, FactRow, NeighbourEdge } from './types';
import { buildEdgeFence } from './edge-fence';

/**
 * Pick the top-N entity ids from the post-bucketing map by rankScore.
 * Pure function — the candidate-expansion logic can be tested without
 * spinning a SurrealDB instance. Returns an empty list when topN ≤ 0
 * or no buckets carry positive rankScore.
 *
 * Why we cap at topN: edge-expansion is O(seeds × avg-degree) on the
 * follow-up SQL — bounding seeds keeps the extra round trip cheap.
 * Why we drop zero-score seeds: a bucket with rankScore=0 already
 * lost the entity round; expanding from it would inject neighbours
 * with even lower inherited scores and just pad the rerank window.
 */
export function selectEdgeExpansionSeeds(
  byEntity: Map<string, { entityId: string; rankScore: number }>,
  topN: number,
): Array<{ entityId: string; rankScore: number }> {
  if (topN <= 0) return [];
  return [...byEntity.values()]
    .filter((b) => b.rankScore > 0)
    .sort((a, b) => b.rankScore - a.rankScore)
    .slice(0, topN)
    .map((b) => ({ entityId: b.entityId, rankScore: b.rankScore }));
}

/**
 * Merge edge-discovered neighbours into the byEntity map. Skips
 * neighbours already present (they were retrieved by vector/BM25
 * directly — vector evidence is strictly stronger than graph-walk
 * inheritance, so we do not touch their score). For genuinely new
 * neighbours, inject a synthetic bucket whose rankScore is the
 * inherited fraction of the seed's rankScore.
 *
 * Returns the count of newly-injected buckets — caller uses it for
 * the span attribute / metric.
 *
 * Pure (mutates the map in place but no IO) — unit-testable.
 */
export function mergeExpandedNeighbours<
  T extends {
    entityId: string;
    rankScore: number;
    bestScore: number;
    facts: unknown[];
  },
>(
  byEntity: Map<string, T>,
  expansions: Array<{
    seedEntityId: string;
    seedRankScore: number;
    neighbourEntityId: string;
    edgeWeight: number;
    bucketFactory: () => T;
  }>,
  alpha: number,
): number {
  if (alpha <= 0) return 0;
  let injected = 0;
  // De-duplicate: if the same neighbour is reachable from multiple
  // seeds, keep the strongest inherited score (max, not sum — we do
  // not want a hub neighbour to outrank a directly-retrieved hit
  // just because it sits next to many seeds).
  const bestInherited = new Map<string, number>();
  for (const e of expansions) {
    const inherited = alpha * e.seedRankScore * e.edgeWeight;
    if (inherited <= 0) continue;
    if (byEntity.has(e.neighbourEntityId)) continue;
    const prev = bestInherited.get(e.neighbourEntityId) ?? 0;
    if (inherited > prev) bestInherited.set(e.neighbourEntityId, inherited);
  }
  for (const e of expansions) {
    if (byEntity.has(e.neighbourEntityId)) continue;
    const inherited = bestInherited.get(e.neighbourEntityId);
    if (inherited === undefined) continue;
    // Only the seeding pass for this neighbour wins the factory call.
    bestInherited.delete(e.neighbourEntityId);
    const bucket = e.bucketFactory();
    bucket.rankScore = inherited;
    bucket.bestScore = Math.max(bucket.bestScore, inherited);
    byEntity.set(e.neighbourEntityId, bucket);
    injected += 1;
  }
  return injected;
}

export interface ExpansionConfig {
  topSeeds: number;
  maxNeighboursPerSeed: number;
  alpha: number;
}

/** Pure fallback for callers that resolve no env (unit fixtures).
 *  alpha 0 = edge expansion OFF — the 2026-08-15 default flip: the
 *  LoCoMo dev-5 ablation on the one edge-bearing eval world measured
 *  NULL (ON 75.3 vs OFF 74.8, n=762 paired, p=0.61 — inside the
 *  same-config replication noise floor of ±17 flips), so the default
 *  path stops paying two graph round-trips per search. Re-enable per
 *  tenant with SEARCH_EDGE_EXPANSION_ALPHA=0.4. */
const DEFAULT_EXPANSION_CONFIG: ExpansionConfig = {
  topSeeds: 3,
  maxNeighboursPerSeed: 5,
  alpha: 0,
};

/**
 * Env resolution lives with the caller-supplied env — the S5.2 boundary
 * allows raw environment reads only in the retrieval-profile bootstrap,
 * which calls this from resolveSearchTuning().
 */
export function resolveExpansionConfig(env: NodeJS.ProcessEnv): ExpansionConfig {
  const topSeeds = Math.max(
    1,
    parseInt(env.SEARCH_EDGE_EXPANSION_TOP_SEEDS ?? '3', 10) || 3,
  );
  const maxNeighboursPerSeed = Math.max(
    1,
    parseInt(env.SEARCH_EDGE_EXPANSION_MAX_NEIGHBOURS ?? '5', 10) || 5,
  );
  // 0 is meaningful — the kill switch AND the default since the
  // 2026-08-15 ablation (see DEFAULT_EXPANSION_CONFIG). The pre-fix
  // parser (`rawAlpha > 0`) silently mapped an explicit 0 back to the
  // old 0.4 default, so the documented "0 disables edge expansion"
  // had never been reachable via env — caught by the ablation arm
  // running byte-identical to its baseline.
  const rawAlpha = parseFloat(env.SEARCH_EDGE_EXPANSION_ALPHA ?? '0');
  const alpha =
    Number.isFinite(rawAlpha) && rawAlpha >= 0 && rawAlpha <= 1
      ? rawAlpha
      : 0;
  return { topSeeds, maxNeighboursPerSeed, alpha };
}

/**
 * Edge-based candidate expansion. Picks top-N entities by rankScore as
 * seeds, walks their 1-hop neighbourhood over `knowledge_edge`, and
 * injects neighbours that weren't already retrieved by vector/BM25 as
 * new buckets. Each injected bucket carries the inherited rankScore
 * plus the neighbour's top-N active facts (under the same bitemporal
 * closure / policy gates as the leg queries) so the reranker has real
 * fact bodies to score.
 *
 * Two SurrealDB round trips, both indexed: edge fan-out hits
 * edge_in_idx / edge_out_idx; neighbour-fact fetch hits
 * fact_entity_pred_idx.
 *
 * Failure-soft: any query error logs and returns 0 — the pipeline
 * continues with the pre-expansion candidate set.
 */
export interface ExpandViaEdgesOptions {
  db: Surreal;
  logger: { warn: (msg: string) => void };
  byEntity: Map<string, EntityBucket>;
  baseWhere: { sql: string; params: Record<string, unknown> };
  dto: SearchDto;
  callerScopes: string[];
  passesPolicy: (row: FactRow, dto: SearchDto, scopes: string[]) => boolean;
  config?: ExpansionConfig;
  /**
   * Neighbourhoods already fetched inline by the combined vector+graph leg
   * (SEARCH_COMBINED_VECTOR_GRAPH), keyed by entity id. Seeds covered here are
   * served from it; only the uncovered seeds hit the DB — saving the separate
   * round-trip for everything the vector KNN already surfaced.
   */
  prefetchedNeighbours?:
    | Map<
        string,
        { outNeighbours: NeighbourEdge[] | null; inNeighbours: NeighbourEdge[] | null }
      >
    | undefined;
}

/**
 * Build the seed→neighbourhood map from vector-leg facts that carried their
 * entity's edges inline (combined vector+graph leg). Returns undefined when no
 * row has neighbours (flag off / lexical-only), so callers pass nothing and
 * edge-expansion behaves exactly as before. One entity can back several facts;
 * first non-null wins (same entity ⇒ same neighbourhood).
 */
export function buildNeighbourMap(
  rows: FactRow[],
):
  | Map<string, { outNeighbours: NeighbourEdge[] | null; inNeighbours: NeighbourEdge[] | null }>
  | undefined {
  const map = new Map<
    string,
    { outNeighbours: NeighbourEdge[] | null; inNeighbours: NeighbourEdge[] | null }
  >();
  for (const r of rows) {
    if (r.outNeighbours === undefined && r.inNeighbours === undefined) continue;
    const eid = String(r.entityId);
    if (map.has(eid)) continue;
    map.set(eid, {
      outNeighbours: r.outNeighbours ?? null,
      inNeighbours: r.inNeighbours ?? null,
    });
  }
  return map.size > 0 ? map : undefined;
}

export async function expandViaEdges({
  db,
  logger,
  byEntity,
  baseWhere,
  dto,
  callerScopes,
  passesPolicy,
  config = DEFAULT_EXPANSION_CONFIG,
  prefetchedNeighbours,
}: ExpandViaEdgesOptions): Promise<number> {
  // alpha ≤ 0 = the kill switch: skip BEFORE the edge fan-out and the
  // neighbour-fact fetch — the merge would inject nothing anyway, so
  // paying the two round trips is pure waste.
  if (config.alpha <= 0) return 0;
  const seeds = selectEdgeExpansionSeeds(byEntity, config.topSeeds);
  if (seeds.length === 0) return 0;

  type EdgeRow = {
    id: unknown;
    outNeighbours: NeighbourEdge[] | null;
    inNeighbours: NeighbourEdge[] | null;
  };
  const edgeRows: EdgeRow[] = [];
  // Serve seeds the combined leg already fetched; query only the rest.
  const uncovered = seeds.filter((s) => {
    const pre = prefetchedNeighbours?.get(s.entityId);
    if (!pre) return true;
    edgeRows.push({
      id: s.entityId,
      outNeighbours: pre.outNeighbours ?? null,
      inNeighbours: pre.inNeighbours ?? null,
    });
    return false;
  });
  if (uncovered.length > 0) {
    const seedRids = uncovered.map((s) => new StringRecordId(s.entityId));
    const fence = buildEdgeFence(dto.userId);
    try {
      const [rows] = await db.query<[EdgeRow[]]>(
        `SELECT
             id,
             ->(knowledge_edge WHERE ${fence.cond}).{ kind, weight, peer: out.{id, userId} } AS outNeighbours,
             <-(knowledge_edge WHERE ${fence.cond}).{ kind, weight, peer: in.{id, userId} } AS inNeighbours
           FROM $ids`,
        { ids: seedRids, ...fence.params },
      );
      edgeRows.push(...((rows as EdgeRow[]) ?? []));
    } catch (err) {
      logger.warn(
        `expandViaEdges: neighbour query failed, skipping expansion: ${(err as Error).message}`,
      );
      if (edgeRows.length === 0) return 0;
    }
  }

  // Collect (seedId, neighbourId, weight) tuples. Dedupe per-seed by
  // neighbour, capped at maxNeighboursPerSeed. Drop identity_of
  // self-loops (post-merge residue) — they cannot inject anything new.
  // The peer-side fence ALSO covers prefetched neighbourhoods (the
  // combined vector+graph leg projects peer.userId for exactly this).
  const peerFence = buildEdgeFence(dto.userId);
  type Tuple = { seedId: string; neighbourId: string; weight: number };
  const tuples: Tuple[] = [];
  for (const row of edgeRows) {
    const seedId = String(row.id);
    const seenForSeed = new Set<string>();
    const consider = (
      side: Array<{
        kind: string;
        weight?: number;
        peer: { id: unknown; userId?: string | null } | null;
      }> | null,
    ) => {
      if (!side) return;
      for (const e of side) {
        if (!e?.peer) continue;
        if (!peerFence.allowsPeer(e.peer.userId)) continue;
        const peerId = String(e.peer.id);
        if (peerId === seedId) continue;
        // Skip neighbours already retrieved — vector evidence is
        // strictly stronger than graph-walk inheritance.
        if (byEntity.has(peerId)) continue;
        if (seenForSeed.has(peerId)) continue;
        if (seenForSeed.size >= config.maxNeighboursPerSeed) break;
        seenForSeed.add(peerId);
        const w =
          typeof e.weight === 'number' && e.weight > 0 ? e.weight : 1.0;
        tuples.push({ seedId, neighbourId: peerId, weight: w });
      }
    };
    consider(row.outNeighbours);
    consider(row.inNeighbours);
  }
  if (tuples.length === 0) return 0;

  // Fetch top facts for the union of neighbour ids. One query — grouped
  // client-side. Same bitemporal closure / policy gates as the leg
  // queries.
  const neighbourIdSet = new Set(tuples.map((t) => t.neighbourId));
  const neighbourRids = [...neighbourIdSet].map((s) => new StringRecordId(s));
  const factsByNeighbour = new Map<string, FactRow[]>();
  try {
    const sql = `
        SELECT
          id, entityId, predicate, object, confidence,
          validFrom, validUntil, recordedAt, retractedAt, status, source,
        trustSnapshot, corroboration, userId,
          entityId.{id, type, canonicalName, externalRefs, mergedInto} AS entity
        FROM knowledge_fact
        WHERE entityId INSIDE $entityIds
          ${baseWhere.sql}
        ORDER BY recordedAt DESC
        LIMIT 200
      `;
    const [rows] = await db.query<[FactRow[]]>(sql, {
      ...baseWhere.params,
      entityIds: neighbourRids,
    });
    for (const row of (rows as FactRow[]) ?? []) {
      if (!passesPolicy(row, dto, callerScopes)) continue;
      const key = String(row.entityId);
      const list = factsByNeighbour.get(key) ?? [];
      if (list.length < 5) list.push(row); // cap per neighbour
      factsByNeighbour.set(key, list);
    }
  } catch (err) {
    logger.warn(
      `expandViaEdges: neighbour-fact query failed: ${(err as Error).message}`,
    );
    return 0;
  }

  // Build expansions for the static merger. Bucket factory is
  // closure-captured so the merger stays pure / unit-testable.
  const seedRankByEntity = new Map(
    seeds.map((s) => [s.entityId, s.rankScore]),
  );
  const expansions = tuples
    .map((t) => {
      const facts = factsByNeighbour.get(t.neighbourId);
      if (!facts || facts.length === 0) return null;
      const seedRankScore = seedRankByEntity.get(t.seedId) ?? 0;
      return {
        seedEntityId: t.seedId,
        seedRankScore,
        neighbourEntityId: t.neighbourId,
        edgeWeight: t.weight,
        bucketFactory: () => {
          // Wrap each FactRow in the same shape the main scoring
          // loop produces — score=0 because these facts didn't go
          // through vector/BM25 ranking. They inherit visibility via
          // the bucket's rankScore, not per-fact score. Stage tag is
          // `edge_expansion` so DecisionLog can surface this provenance.
          const scoredFacts = facts.map((row) => {
            const fused = {
              ...row,
              fusedScore: 0,
              stages: [...(row.stages ?? []), 'edge_expansion' as const],
            };
            return {
              row: fused,
              score: 0,
              breakdown: {
                fusedScore: 0,
                confidence: row.confidence,
                decay: 1,
                finalScore: 0,
                stages: fused.stages,
              },
            };
          });
          return {
            entityId: t.neighbourId,
            rankScore: 0,
            bestScore: 0,
            facts: scoredFacts,
          };
        },
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  return mergeExpandedNeighbours(byEntity, expansions, config.alpha);
}
