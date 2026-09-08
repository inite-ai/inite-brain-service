import type { Surreal } from 'surrealdb';

/**
 * Missing-HNSW-index detection for the `<|k,ef|>` KNN legs.
 *
 * THE DEFECT. SurrealDB does not error when the `<|K,EF|>` operator has no
 * index to ride. It drops the operator from the plan and answers the rest
 * of the statement — `EXPLAIN` shows a bare `TableScan` — so the query
 * returns the first k rows in TABLE ORDER with `vector::distance::knn()`
 * projecting NULL. Measured on `surrealdb/surrealdb:v3.2.4` (3 000 × 1024-d,
 * scratch container):
 *
 *   no index   → [{"knnDist":null,"n":1144},{"knnDist":null,"n":2781}, …]
 *                EXPLAIN → SelectProject → TableScan (no KnnScan node)
 *   index ready→ [{"knnDist":0.8998…,"n":1802},{"knnDist":0.8999…,"n":2007}, …]
 *
 * Every KNN leg in this repo was written against the OPPOSITE assumption —
 * "throws when the tenant has no index — the caller falls back to the scan"
 * — so the `catch` that implements the fallback never fires and the leg
 * hands its caller k arbitrary rows with no similarity score. Production
 * runs `SEARCH_HNSW_ENABLED=1` while index creation is a manual per-tenant
 * admin call, so any tenant whose index was never built is served unranked
 * rows that look exactly like ranked ones.
 *
 * THE SIGNAL. `knnDist === null` on every returned row is a DIRECT
 * observation that the operator was not applied — not an inference from an
 * error that never arrives. It costs nothing (the rows are already in hand)
 * and it is exact: when the index rides, SurrealDB projects a number on
 * every row; when it is dropped, it projects NULL on every row.
 *
 * It also covers a second state that `INFO FOR TABLE` alone cannot see.
 * A `DEFINE INDEX … CONCURRENTLY` build EXISTS from the moment the DDL
 * returns but is not usable until it reports `ready`, and during the build
 * the KNN operator is dropped exactly as if no index existed (measured: at
 * `t+0.1s`, `{"initial":16,"pending":0,"status":"indexing"}` returned the
 * same three null-distance rows as the un-indexed table; at `t+1.2s`,
 * `status:"ready"` returned real distances). So "the index exists" is not
 * the property a KNN leg needs — "the operator was applied" is, and that is
 * what this module tests.
 */

/**
 * True when SurrealDB answered a `<|k,ef|>` statement WITHOUT applying the
 * KNN operator — the rows are the table's first k in storage order and the
 * distance projection is NULL on all of them.
 *
 * Conservative on purpose: an empty result is NOT reported as dropped (an
 * empty tenant, or gates that ate every approximate neighbour, look the
 * same from here and the callers already have their own empty-pool
 * doctrine), and a single ranked row is enough to say the operator ran.
 */
export function knnOperatorDropped(
  rows: readonly unknown[] | null | undefined,
  distanceField: string,
): boolean {
  if (!Array.isArray(rows) || rows.length === 0) return false;
  return rows.every((row) => typeof (row as Record<string, unknown>)?.[distanceField] !== 'number');
}

/** What an HNSW index is doing on a tenant, for the diagnostic log. */
export type HnswIndexState = 'ready' | 'building' | 'absent' | 'unknown';

/**
 * Why the KNN operator was dropped, for the operator-facing log line.
 *
 * Read-only and best-effort: it runs ONLY on the failure path (never on the
 * hot path), and any error answers `'unknown'` rather than escalating — a
 * diagnostic must not turn a recovered query into a failed one.
 *
 * `INFO FOR TABLE` is the existence probe because `INFO FOR INDEX` THROWS
 * on an absent index ("The index 'x' does not exist"); `INFO FOR INDEX` is
 * then consulted only when the index does exist, to separate a finished
 * index from one still building (`{building:{status:'indexing'|'ready',…}}`).
 */
export async function hnswIndexState(
  db: Pick<Surreal, 'query'>,
  spec: { table: string; index: string },
): Promise<HnswIndexState> {
  try {
    const [info] = await db.query<[{ indexes?: Record<string, string> }]>(
      `INFO FOR TABLE ${spec.table};`,
    );
    const indexes = (info as { indexes?: Record<string, string> } | undefined)?.indexes;
    if (!indexes || typeof indexes[spec.index] !== 'string') return 'absent';
  } catch {
    return 'unknown';
  }
  try {
    const [detail] = await db.query<[{ building?: { status?: string } }]>(
      `INFO FOR INDEX ${spec.index} ON ${spec.table};`,
    );
    const status = (detail as { building?: { status?: string } } | undefined)?.building?.status;
    if (status === undefined) return 'ready';
    return status === 'ready' ? 'ready' : 'building';
  } catch {
    return 'unknown';
  }
}

/**
 * The single operator-facing sentence for a dropped KNN operator. ERROR,
 * not WARN: with `SEARCH_HNSW_ENABLED=1` this is a live misconfiguration
 * that has been answering searches with unranked rows, and the remedy is
 * one admin call. The exact scan the caller falls back to is the same query
 * every tenant runs with the flag off, so the request is still answered
 * correctly — the shout is about the tenant being un-indexed, not about the
 * request failing.
 */
export function knnDroppedMessage(
  spec: { table: string; index: string },
  state: HnswIndexState,
): string {
  const why =
    state === 'absent'
      ? `index '${spec.index}' does not exist on this tenant — build it with POST /v1/admin/maintenance/hnsw`
      : state === 'building'
        ? `index '${spec.index}' exists but is still building — it is not usable until it reports ready`
        : `index '${spec.index}' state could not be determined`;
  return (
    `hnsw KNN operator was DROPPED on ${spec.table} (every row came back with a null ` +
    `distance, i.e. unranked table-order rows): ${why}. Falling back to the exact scan.`
  );
}
