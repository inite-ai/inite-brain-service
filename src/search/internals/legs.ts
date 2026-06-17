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
export async function runVectorLeg(
  db: Surreal,
  embedder: EmbedderService,
  query: string,
  k: number,
  baseWhere: { sql: string; params: Record<string, unknown> },
): Promise<FactRow[]> {
  const queryEmbedding = await embedder.embed(query);
  const sql = `
      SELECT
        id, entityId, predicate, object, confidence,
        validFrom, validUntil, recordedAt, retractedAt, status, source,
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
export async function runLexicalLeg(
  db: Surreal,
  logger: { warn: (msg: string) => void },
  query: string,
  k: number,
  baseWhere: { sql: string; params: Record<string, unknown> },
): Promise<FactRow[]> {
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
