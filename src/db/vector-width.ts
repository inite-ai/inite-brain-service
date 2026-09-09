/**
 * The width gate every cosine scan carries.
 *
 * `vector::similarity::cosine(col, $q)` is not a per-row miss when one row's
 * vector has a different width from the query — on SurrealDB 3.2.4 it is an
 * error for the WHOLE statement (measured; see test/embedding-space.e2e-spec).
 * So one row embedded under another model — a 1536-wide OpenAI vector in a
 * bge-m3 1024 corpus, which is exactly what the preprod tenant held on
 * 2026-09-09 — takes dense retrieval down for every row of the table, and
 * on the write path (fn::resolve_fact's dedup gate) fails every write of the
 * entity's aspect.
 *
 * The gate is one clause, placed right after the `!= NONE` guard that every
 * scan already has:
 *
 *     WHERE col != NONE AND array::len(col) = array::len($q)
 *
 * `AND` short-circuits (measured), so the cosine never sees a foreign-width
 * row; such a row is simply not a candidate. It is invisible, not fatal —
 * which is the right degradation: the census (VectorCorpusService) reports
 * it, the metric counts it, and the reindex repairs it.
 *
 * A truth test (test/embedding-space-truth.unit-spec.ts) fails the build when
 * a cosine scan appears anywhere in src/ without this clause in the same
 * statement, so the next scan site cannot forget it.
 */
export function sameWidthGate(field: string, param = 'q'): string {
  return `${field} != NONE AND array::len(${field}) = array::len($${param})`;
}

/** The exact clause the truth test looks for next to a cosine on `field`. */
export function widthGateClause(field: string, param = 'q'): string {
  return `array::len(${field}) = array::len($${param})`;
}
