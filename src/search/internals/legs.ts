import type { Surreal } from 'surrealdb';
import type { EmbedderService } from '../../ai/embedder.service';
import type { FactRow } from './types';
import type { SearchTuning } from '../retrieval-profile';

/** The slice of SearchTuning the legs consume (kept narrow for tests). */
export type LegTuning = Pick<
  SearchTuning,
  | 'combinedVectorGraph'
  | 'hnswEnabled'
  | 'hnswEf'
  | 'hnswOverfetch'
  | 'highlightEnabled'
>;

const DEFAULT_LEG_TUNING: LegTuning = {
  combinedVectorGraph: false,
  hnswEnabled: false,
  hnswEf: 100,
  hnswOverfetch: 4,
  highlightEnabled: false,
};

/**
 * Vector leg — cosine similarity over `embedding`. The inline
 * projection `entityId.{...} AS entity` reads the linked entity
 * record in the same query, so no separate hydration round-trip is
 * needed. We deliberately don't add `FETCH entityId` — that would
 * overwrite the `entityId` field in-place with the entity object,
 * breaking `String(row.entityId)` for the grouping pass.
 */
/**
 * Combined vector+graph: fold the fact's entity neighbourhood into the KNN
 * query so candidate generation is ONE SurrealQL round-trip (KNN + `->edge->`
 * traversal as co-equal projections) instead of a vector query followed by a
 * separate edge-expansion lookup — SurrealDB's native hybrid-retrieval strength.
 * Off (default) → empty string → the query is byte-identical to before; the
 * legacy separate edge-expansion query runs instead. Verified on 3.2.0.
 */
const combinedGraphProjection = (on: boolean): string =>
  on
    ? `entityId->knowledge_edge.{ kind, weight, peer: out.{id} } AS outNeighbours,
     entityId<-knowledge_edge.{ kind, weight, peer: in.{id} } AS inNeighbours,`
    : '';

export interface RunVectorLegOptions {
  db: Surreal;
  embedder: EmbedderService;
  query: string;
  k: number;
  baseWhere: { sql: string; params: Record<string, unknown> };
  /** For the HNSW-fallback warning; the leg stays silent without it. */
  logger?: { warn: (msg: string) => void };
  /** Resolved by the retrieval-profile bootstrap (S5.2). */
  tuning?: LegTuning;
}

export async function runVectorLeg({
  db,
  embedder,
  query,
  k,
  baseWhere,
  logger,
  tuning = DEFAULT_LEG_TUNING,
}: RunVectorLegOptions): Promise<FactRow[]> {
  const queryEmbedding = await embedder.embed(query);
  // HNSW path (opt-in): approximate KNN over the per-tenant indexes
  // created by POST /v1/admin/maintenance/hnsw. Any failure — most
  // commonly "no index on this tenant yet" — falls back to the exact
  // full scan below, so the flag can be flipped globally while tenants
  // are indexed one by one.
  if (tuning.hnswEnabled) {
    try {
      return await runVectorLegKnn({ db, queryEmbedding, k, baseWhere, tuning });
    } catch (e) {
      logger?.warn(
        `hnsw vector leg fell back to full scan: ${(e as Error).message}`,
      );
    }
  }
  const sql = `
      SELECT
        id, entityId, predicate, predicateAlias, object, confidence,
        validFrom, validUntil, recordedAt, retractedAt, status, source,
        trustSnapshot, corroboration, userId,
        entityId.{id, type, canonicalName, externalRefs, mergedInto} AS entity,
        ${combinedGraphProjection(tuning.combinedVectorGraph)}
        vector::similarity::cosine(embedding, $q) AS simScore
      FROM knowledge_fact
      WHERE embedding != NONE
        ${baseWhere.sql}
      ORDER BY simScore DESC
      LIMIT $k
    `;
  const [rows] = await db.query<[FactRow[]]>(sql, {
    ...baseWhere.params,
    q: queryEmbedding,
    k,
  });
  return (rows as FactRow[]) ?? [];
}

/**
 * HNSW KNN variant of the vector leg. The KNN operator picks candidates
 * BEFORE the WHERE filters apply, so the query over-fetches
 * (`SEARCH_HNSW_OVERFETCH × k`, capped 1000) to keep filtered recall
 * up; `SEARCH_HNSW_EF` is the HNSW search width. Throws when the tenant
 * has no index — the caller falls back to the scan.
 */
async function runVectorLegKnn({
  db,
  queryEmbedding,
  k,
  baseWhere,
  tuning,
}: {
  db: Surreal;
  queryEmbedding: number[];
  k: number;
  baseWhere: { sql: string; params: Record<string, unknown> };
  tuning: LegTuning;
}): Promise<FactRow[]> {
  const ef = tuning.hnswEf;
  const kOver = Math.min(k * tuning.hnswOverfetch, 1000);
  const projection = `
        id, entityId, predicate, predicateAlias, object, confidence,
        validFrom, validUntil, recordedAt, retractedAt, status, source,
        trustSnapshot, corroboration, userId,
        entityId.{id, type, canonicalName, externalRefs, mergedInto} AS entity`;
  // `<|K,EF|>` takes literals, not params — kOver/ef are validated ints.
  //
  // The projection MUST be vector::distance::knn(), not a fresh cosine
  // call: re-projecting vector::similarity::cosine next to the KNN
  // operator drops the planner off the KnnScan and costs more than the
  // full scan (V11 audit A4 — 6-8s vs 0.45s brute on a 20k stand table;
  // one such query at kOver=1600 OOM-killed a 16GB SurrealDB). COSINE
  // distance = 1 − cosine similarity; converted below so consumers
  // (fusion normalization, margin cuts) keep exact sim semantics.
  const [rows] = await db.query<[Array<FactRow & { knnDist?: number }>]>(
    `SELECT ${projection},
            vector::distance::knn() AS knnDist
       FROM knowledge_fact
       WHERE embedding <|${kOver},${ef}|> $q
         ${baseWhere.sql}
       ORDER BY knnDist ASC
       LIMIT $k`,
    { ...baseWhere.params, q: queryEmbedding, k },
  );
  return (rows ?? []).map(({ knnDist, ...rest }) => ({
    ...rest,
    simScore: typeof knnDist === 'number' ? 1 - knnDist : undefined,
  })) as FactRow[];
}

/**
 * Lexical leg — BM25 over the `searchHaystack` (predicate + object,
 * migration 0007) and `object` (legacy index, migration 0002) via the
 * `@N@` per-index score operator. Two scored fields combined with
 * `math::max(score1, score2)` give us the better of the two — haystack
 * catches predicate-bridge queries (e.g. "complain" matching
 * `complained_about`), object stays for exact-token matches that
 * benefit from a narrower surface (transaction ids, canonical phrases
 * that should not be diluted by predicate tokens).
 *
 * Fails soft to `[]` when the SEARCH index is missing (fresh tenants
 * / test fixtures pre-dating migration 0007) — the vector leg keeps
 * serving the request.
 */
/**
 * BM25 match-snippet projection (SEARCH_HIGHLIGHT_ENABLED). The FULLTEXT
 * indexes already carry HIGHLIGHTS but search::highlight was never queried.
 * Highlights the searchHaystack match (ref 1 — the field the lexical WHERE
 * matches on for most rows). Off (default) → empty string → byte-identical.
 */
const highlightProjection = (on: boolean): string =>
  on ? `search::highlight('<em>', '</em>', 1) AS highlight,` : '';

export interface RunLexicalLegOptions {
  db: Surreal;
  logger: { warn: (msg: string) => void };
  query: string;
  k: number;
  baseWhere: { sql: string; params: Record<string, unknown> };
  /** Resolved by the retrieval-profile bootstrap (S5.2). */
  tuning?: LegTuning;
}

export async function runLexicalLeg({
  db,
  logger,
  query,
  k,
  baseWhere,
  tuning = DEFAULT_LEG_TUNING,
}: RunLexicalLegOptions): Promise<FactRow[]> {
  // Parens around the OR clause are LOAD-BEARING. SurrealQL
  // evaluates AND with higher precedence than OR (same as SQL),
  // so without them the WHERE parses as
  //   searchHaystack @1@ $q  OR  (object @2@ $q AND <baseWhere>)
  // — meaning a row that matches via the haystack index bypasses
  // EVERY filter in baseWhere (retractedAt IS NONE, status,
  // confidence, asOf, predicates, entityIds). Caught by a
  // memory-lifecycle eval failure where retracted facts surfaced
  // with status='retracted' on a query that hit searchHaystack.
  const sql = `
      SELECT
        id, entityId, predicate, predicateAlias, object, confidence,
        validFrom, validUntil, recordedAt, retractedAt, status, source,
        trustSnapshot, corroboration, userId,
        entityId.{id, type, canonicalName, externalRefs, mergedInto} AS entity,
        ${highlightProjection(tuning.highlightEnabled)}
        math::max([search::score(1), search::score(2)]) AS bm25Score
      FROM knowledge_fact
      WHERE (searchHaystack @1@ $query OR object @2@ $query)
        ${baseWhere.sql}
      ORDER BY bm25Score DESC
      LIMIT $k
    `;
  try {
    const [rows] = await db.query<[FactRow[]]>(sql, {
      ...baseWhere.params,
      query,
      k,
    });
    return (rows as FactRow[]) ?? [];
  } catch (err) {
    logger.warn(`Lexical leg fell back to empty: ${(err as Error).message}`);
    return [];
  }
}
