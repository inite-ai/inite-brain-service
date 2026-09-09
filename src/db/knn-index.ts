import type { Surreal } from 'surrealdb';

/**
 * Missing-HNSW-index detection for the `<|k,ef|>` KNN legs.
 *
 * SurrealDB (3.2.4) does not error when the `<|K,EF|>` operator has no index
 * to ride — or an index that is still building CONCURRENTLY. It drops the
 * operator from the plan (`EXPLAIN` shows a bare `TableScan`) and answers
 * with the table's first k rows in storage order, `vector::distance::knn()`
 * projecting NULL on every one of them. Every KNN leg was written against
 * the opposite assumption ("throws when the tenant has no index"), so the
 * fallback never fired and un-indexed tenants were served unranked rows that
 * looked exactly like ranked ones. Production runs `SEARCH_HNSW_ENABLED=1`
 * while index creation is a per-tenant admin call, so that is the common
 * state, not an edge case.
 *
 * THE SIGNAL is the rows themselves: a numeric distance on any row means
 * the operator ran; NULL on every row means it was dropped. Exact and free.
 *
 * THE MEMO. Detecting the drop after the fact still costs the KNN table
 * scan, the exact scan, and two `INFO` round-trips per query — on every
 * search, dense-scan lane, ingest mention and dedup seed of an un-indexed
 * tenant. So a dropped operator is remembered per (namespace, database,
 * table, index) for `KNN_INDEX_MEMO_TTL_MS`: while the memo is fresh the
 * legs skip the KNN attempt and run the exact scan directly (one scan, no
 * diagnostics), and the operator-facing line is emitted once per
 * `KNN_INDEX_WARN_EVERY_MS` rather than per request. Index builds clear the
 * memo (`resetKnnIndexMemo`); the TTL bounds the lag when they do not.
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

/** What an HNSW index is doing on a tenant. */
export type HnswIndexState = 'ready' | 'building' | 'absent' | 'unknown';

export interface HnswIndexSpec {
  table: string;
  index: string;
}

export interface HnswIndexProbe {
  state: HnswIndexState;
  /** Rows walked by the initial build, when the engine reports it. */
  initial?: number;
  /** Rows queued behind the build (live writes), when reported. */
  pending?: number;
  /** The DIMENSION the engine echoes back in the index DDL; absent when the
   *  DDL shape is not the one we expect, so a parse miss reads as "not
   *  checked", never as "matches". */
  dimension?: number;
}

type ProbeDb = Pick<Surreal, 'query'>;
type MemoDb = ProbeDb & Partial<Pick<Surreal, 'namespace' | 'database'>>;
/** The legs' logger shape; `debug` is optional because plain objects stand in for Nest's Logger in tests. */
export interface KnnDiagnosticLogger {
  warn: (msg: string) => void;
  error?: (msg: string) => void;
  debug?: (msg: string) => void;
}

/**
 * The one INFO probe every consumer shares — read-only and best-effort: any
 * error answers `unknown` rather than escalating, because a diagnostic must
 * not turn a recovered query into a failed one.
 *
 * `INFO FOR TABLE` is the existence probe because `INFO FOR INDEX` THROWS on
 * an absent index; `INFO FOR INDEX` is then consulted only when the index
 * exists, to separate a finished index from one still building. A
 * synchronously built index reports no `building` block at all — `ready`.
 */
export async function probeHnswIndex(db: ProbeDb, spec: HnswIndexSpec): Promise<HnswIndexProbe> {
  try {
    const [info] = await db.query<[{ indexes?: Record<string, string> }]>(
      `INFO FOR TABLE ${spec.table};`,
    );
    const indexes = (info as { indexes?: Record<string, string> } | undefined)?.indexes;
    const ddl = indexes?.[spec.index];
    if (typeof ddl !== 'string') return { state: 'absent' };
    const declared = /DIMENSION\s+(\d+)/i.exec(ddl);
    const dimension = declared ? { dimension: parseInt(declared[1]!, 10) } : {};
    const [detail] = await db.query<
      [{ building?: { status?: string; initial?: number; pending?: number } }]
    >(`INFO FOR INDEX ${spec.index} ON ${spec.table};`);
    const building = (
      detail as { building?: { status?: string; initial?: number; pending?: number } } | undefined
    )?.building;
    if (!building || building.status === undefined) return { state: 'ready', ...dimension };
    return {
      state: building.status === 'ready' ? 'ready' : 'building',
      ...(typeof building.initial === 'number' ? { initial: building.initial } : {}),
      ...(typeof building.pending === 'number' ? { pending: building.pending } : {}),
      ...dimension,
    };
  } catch {
    return { state: 'unknown' };
  }
}

/** `probeHnswIndex` reduced to its state. */
export async function hnswIndexState(db: ProbeDb, spec: HnswIndexSpec): Promise<HnswIndexState> {
  return (await probeHnswIndex(db, spec)).state;
}

/** How long a dropped-operator observation keeps the KNN attempt skipped. */
export const KNN_INDEX_MEMO_TTL_MS = 60_000;
/** Minimum gap between two operator-facing lines about the same index. */
export const KNN_INDEX_WARN_EVERY_MS = 60 * 60_000;

interface MemoEntry {
  state: HnswIndexState;
  at: number;
  warnedAt: number;
}

const memo = new Map<string, MemoEntry>();

/**
 * The memo key: the connection's selected namespace/database plus the index.
 * A connection that has not selected a database (unit fakes, admin paths)
 * yields null, which disables the memo for that call — every such call then
 * behaves as before: probe and log.
 */
export function knnIndexKey(db: MemoDb, spec: HnswIndexSpec): string | null {
  const ns = db.namespace;
  const database = db.database;
  if (!ns || !database) return null;
  return `${ns}/${database}/${spec.table}/${spec.index}`;
}

/**
 * True when this tenant's index was observed absent or still building
 * within the TTL — the leg should run its exact scan directly instead of
 * paying for a KNN statement it knows will come back unranked.
 */
export function knnIndexKnownUnusable(
  db: MemoDb,
  spec: HnswIndexSpec,
  now: number = Date.now(),
): boolean {
  const key = knnIndexKey(db, spec);
  if (!key) return false;
  const entry = memo.get(key);
  if (!entry || now - entry.at >= KNN_INDEX_MEMO_TTL_MS) return false;
  return entry.state === 'absent' || entry.state === 'building';
}

/**
 * Record that a `<|k,ef|>` statement came back with the operator dropped:
 * find out why (probing at most once per TTL per index), remember it, and
 * tell the operator — ERROR the first time in an hour (with
 * `SEARCH_HNSW_ENABLED=1` this is a live misconfiguration whose remedy is
 * one admin call), a debug crumb after that. Returns the observed state.
 */
export async function noteKnnOperatorDropped(
  db: MemoDb,
  spec: HnswIndexSpec,
  opts: { logger?: KnnDiagnosticLogger | undefined; now?: number | undefined } = {},
): Promise<HnswIndexState> {
  const { logger } = opts;
  const now = opts.now ?? Date.now();
  const key = knnIndexKey(db, spec);
  const prev = key ? memo.get(key) : undefined;
  const fresh = prev !== undefined && now - prev.at < KNN_INDEX_MEMO_TTL_MS;
  const state = fresh ? prev.state : await hnswIndexState(db, spec);
  const warnedAt = prev?.warnedAt ?? 0;
  const shout = now - warnedAt >= KNN_INDEX_WARN_EVERY_MS;
  // `at` is the PROBE time: a cached observation must not extend the skip,
  // or a tenant could stay skipped indefinitely on repeated observations.
  if (key) memo.set(key, { state, at: fresh ? prev.at : now, warnedAt: shout ? now : warnedAt });
  const message = knnDroppedMessage(spec, state);
  if (shout) (logger?.error ?? logger?.warn)?.(message);
  else logger?.debug?.(message);
  return state;
}

/** Forget every observation — after an index build, or between tests. */
export function resetKnnIndexMemo(): void {
  memo.clear();
}

/**
 * The single operator-facing sentence for a dropped KNN operator. The exact
 * scan the caller falls back to is the same query every tenant runs with
 * the flag off, so the request is still answered correctly — the shout is
 * about the tenant being un-indexed, not about the request failing.
 */
export function knnDroppedMessage(spec: HnswIndexSpec, state: HnswIndexState): string {
  const why =
    state === 'absent'
      ? `index '${spec.index}' does not exist on this tenant — build it with POST /v1/admin/maintenance/hnsw`
      : state === 'building'
        ? `index '${spec.index}' exists but is still building — it is not usable until it reports ready`
        : `index '${spec.index}' state could not be determined`;
  return (
    `hnsw KNN operator was DROPPED on ${spec.table} (every row came back with a null ` +
    `distance, i.e. unranked table-order rows): ${why}. Falling back to the exact scan` +
    ` (skipping KNN on this tenant for the next ${KNN_INDEX_MEMO_TTL_MS / 1000}s).`
  );
}
