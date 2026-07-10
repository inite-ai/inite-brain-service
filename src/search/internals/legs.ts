import type { Surreal } from 'surrealdb';
import type { EmbedderService } from '../../ai/embedder.service';
import type { FactRow } from './types';

/**
 * Vector leg — cosine similarity over `embedding`. The inline
 * projection `entityId.{...} AS entity` reads the linked entity
 * record in the same query, so no separate hydration round-trip is
 * needed. We deliberately don't add `FETCH entityId` — that would
 * overwrite the `entityId` field in-place with the entity object,
 * breaking `String(row.entityId)` for the grouping pass.
 *
 * HyPE: `altEmbedding` is the embedding of a hypothetical question
 * the fact answers (migration 0008). We take max(cos_main, cos_alt)
 * to close the question→statement gap without paying an LLM rewrite
 * on the read path. NONE alt (legacy facts or HyPE disabled)
 * contributes -1 so it never wins the max.
 */
export interface RunVectorLegOptions {
  db: Surreal;
  embedder: EmbedderService;
  query: string;
  k: number;
  baseWhere: { sql: string; params: Record<string, unknown> };
  /** For the HNSW-fallback warning; the leg stays silent without it. */
  logger?: { warn: (msg: string) => void };
}

export async function runVectorLeg({
  db,
  embedder,
  query,
  k,
  baseWhere,
  logger,
}: RunVectorLegOptions): Promise<FactRow[]> {
  const queryEmbedding = await embedder.embed(query);
  // HNSW path (opt-in): approximate KNN over the per-tenant indexes
  // created by POST /v1/admin/maintenance/hnsw. Any failure — most
  // commonly "no index on this tenant yet" — falls back to the exact
  // full scan below, so the flag can be flipped globally while tenants
  // are indexed one by one.
  if (process.env.SEARCH_HNSW_ENABLED === '1') {
    try {
      return await runVectorLegKnn({ db, queryEmbedding, k, baseWhere });
    } catch (e) {
      logger?.warn(
        `hnsw vector leg fell back to full scan: ${(e as Error).message}`,
      );
    }
  }
  const sql = `
      SELECT
        id, entityId, predicate, object, confidence,
        validFrom, validUntil, recordedAt, retractedAt, status, source,
        trustSnapshot, corroboration, userId,
        entityId.{id, type, canonicalName, externalRefs, mergedInto} AS entity,
        math::max([
          vector::similarity::cosine(embedding, $q),
          IF altEmbedding != NONE THEN vector::similarity::cosine(altEmbedding, $q) ELSE -1 END
        ]) AS simScore
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
 * HNSW KNN variant of the vector leg. Two KNN queries — the main
 * `embedding` index and the HyPE `altEmbedding` index — merged by max
 * cosine, mirroring the full scan's `math::max(cos, altCos)`. The KNN
 * operator picks candidates BEFORE the WHERE filters apply, so both
 * queries over-fetch (`SEARCH_HNSW_OVERFETCH × k`, capped 1000) to keep
 * filtered recall up; `SEARCH_HNSW_EF` is the HNSW search width. Throws
 * when the tenant has no index — the caller falls back to the scan.
 */
async function runVectorLegKnn({
  db,
  queryEmbedding,
  k,
  baseWhere,
}: {
  db: Surreal;
  queryEmbedding: number[];
  k: number;
  baseWhere: { sql: string; params: Record<string, unknown> };
}): Promise<FactRow[]> {
  const ef = positiveIntEnv('SEARCH_HNSW_EF', 100);
  const overfetch = positiveIntEnv('SEARCH_HNSW_OVERFETCH', 4);
  const kOver = Math.min(k * overfetch, 1000);
  const projection = `
        id, entityId, predicate, object, confidence,
        validFrom, validUntil, recordedAt, retractedAt, status, source,
        trustSnapshot, corroboration, userId,
        entityId.{id, type, canonicalName, externalRefs, mergedInto} AS entity`;
  // `<|K,EF|>` takes literals, not params — kOver/ef are validated ints.
  const [mainRows, altRows] = await Promise.all([
    db
      .query<[FactRow[]]>(
        `SELECT ${projection},
                vector::similarity::cosine(embedding, $q) AS simScore
           FROM knowledge_fact
           WHERE embedding <|${kOver},${ef}|> $q
             ${baseWhere.sql}
           ORDER BY simScore DESC
           LIMIT $k`,
        { ...baseWhere.params, q: queryEmbedding, k },
      )
      .then(([rows]) => (rows as FactRow[]) ?? []),
    db
      .query<[FactRow[]]>(
        `SELECT ${projection},
                vector::similarity::cosine(altEmbedding, $q) AS simScore
           FROM knowledge_fact
           WHERE altEmbedding <|${kOver},${ef}|> $q
             ${baseWhere.sql}
           ORDER BY simScore DESC
           LIMIT $k`,
        { ...baseWhere.params, q: queryEmbedding, k },
      )
      .then(([rows]) => (rows as FactRow[]) ?? []),
  ]);
  // Max-cosine merge across the two indexes — same semantics as the full
  // scan's math::max; no stage tag, both are the plain vector leg.
  const byId = new Map<string, FactRow>();
  for (const r of mainRows) byId.set(String(r.id), r);
  for (const r of altRows) {
    const key = String(r.id);
    const prior = byId.get(key);
    if (!prior) byId.set(key, r);
    else if ((r.simScore ?? -1) > (prior.simScore ?? -1)) {
      prior.simScore = r.simScore;
    }
  }
  return [...byId.values()]
    .sort((a, b) => (b.simScore ?? -1) - (a.simScore ?? -1))
    .slice(0, k);
}

function positiveIntEnv(name: string, fallback: number): number {
  const v = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/**
 * Merge alternative-query vector hits into the primary vector leg's
 * rows: a fact both legs found keeps one row with the max simScore; a
 * fact only a reformulation found joins the pool pre-tagged
 * 'query_expansion' so DecisionLog can attribute it (fusion appends its
 * own 'hype' tag after — insertion order keeps expansion dominant).
 */
export function mergeVectorRows(
  primary: FactRow[],
  altRows: FactRow[],
): FactRow[] {
  const byId = new Map<string, FactRow>();
  for (const r of primary) byId.set(String(r.id), r);
  for (const r of altRows) {
    const key = String(r.id);
    const prior = byId.get(key);
    if (prior) {
      if ((r.simScore ?? -1) > (prior.simScore ?? -1)) {
        prior.simScore = r.simScore;
      }
    } else {
      byId.set(key, { ...r, stages: ['query_expansion'] });
    }
  }
  return [...byId.values()];
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
export interface RunLexicalLegOptions {
  db: Surreal;
  logger: { warn: (msg: string) => void };
  query: string;
  k: number;
  baseWhere: { sql: string; params: Record<string, unknown> };
}

export async function runLexicalLeg({
  db,
  logger,
  query,
  k,
  baseWhere,
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
        id, entityId, predicate, object, confidence,
        validFrom, validUntil, recordedAt, retractedAt, status, source,
        trustSnapshot, corroboration, userId,
        entityId.{id, type, canonicalName, externalRefs, mergedInto} AS entity,
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
