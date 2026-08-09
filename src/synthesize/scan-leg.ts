import type { Surreal } from 'surrealdb';
import type { CoverageScanMode } from '../search/retrieval-profile';

/**
 * Shared dense leg of the two coverage-first scan lanes (mention-scan
 * over episode_segment, query_arc over knowledge_fact) — V11 agenda §5
 * scale gate.
 *
 * 'brute' emits the legacy exact filtered top-k (full-table cosine
 * ORDER BY) byte-identically. 'hnsw' swaps the table walk for the
 * approximate KNN operator (`<|kOver,ef|>`) against the tenant's HNSW
 * index, overfetching to compensate SurrealDB's post-KNN WHERE
 * filtering, and FALLS BACK to the brute scan on any error or an empty
 * post-filter pool — an empty pool under KNN is most likely gate
 * starvation (every approximate neighbor eaten by the pii/user/world
 * gates), which the exact scan recovers in exactly the rare thin case.
 *
 * Pure query composition + execution — no DI, no env; the tuning
 * arrives from the resolved profile via the lane services.
 */

export interface CoverageScanTuning {
  mode: CoverageScanMode;
  /** HNSW candidate-list size; clamped up to the overfetched k. */
  ef: number;
  /** Overfetch multiplier over the requested k. */
  overfetch: number;
}

/** Legacy behavior for callers without a resolved profile (unit
 *  fixtures, partial wiring): the exact brute scan. */
export const BRUTE_ONLY: CoverageScanTuning = {
  mode: 'brute',
  ef: 400,
  overfetch: 4,
};

/** Hard cap on KNN candidates per leg — headroom over the search-leg
 *  1000 cap (coverage k is 200-400, not 48) while bounding the walk. */
const SCAN_KNN_K_CAP = 4000;

export interface DenseScanLegRequest {
  db: Pick<Surreal, 'query'>;
  table: 'episode_segment' | 'knowledge_fact';
  /** Projected columns, e.g. 'id, text, occurredAt'. */
  projection: string;
  /** Gate tail interpolated after the embedding guard — the lane's
   *  pii/user (+atomic/world) predicates, each 'AND …'-shaped. */
  gates: string;
  /** Bind params for the gates + $q (topic vector) + $k. */
  params: Record<string, unknown>;
  k: number;
  tuning: CoverageScanTuning;
  logger?: { warn(message: string): void };
}

/**
 * Run the dense scan leg in the tuned mode. Returns raw rows; the
 * caller keeps its own merge/filter pipeline. Never throws in 'hnsw'
 * mode short of the brute fallback itself throwing — the lanes' outer
 * degrade-to-[] contract stays the single failure boundary.
 */
export async function runDenseScanLeg<Row>(
  req: DenseScanLegRequest,
): Promise<Row[]> {
  const { db, params, k, tuning, logger } = req;
  if (tuning.mode !== 'hnsw') return runBrute(req);
  const kOver = Math.min(k * tuning.overfetch, SCAN_KNN_K_CAP);
  // ef below the candidate count is never useful in HNSW; the knob only
  // matters when raised ABOVE the overfetched k.
  const ef = Math.max(tuning.ef, kOver);
  try {
    // kOver/ef are validated ints (positiveIntEnv/profile overlay) —
    // safe to interpolate; the KNN operator takes no bind params.
    const [rows] = await db.query<[Row[]]>(
      `SELECT ${req.projection},
        vector::similarity::cosine(embedding, $q) AS score
   FROM ${req.table}
  WHERE embedding <|${kOver},${ef}|> $q ${req.gates}
  ORDER BY score DESC
  LIMIT $k`,
      params,
    );
    if (rows && rows.length > 0) return rows;
    logger?.warn(
      `hnsw dense scan leg empty after gates (${req.table}, kOver=${kOver}) — falling back to full scan`,
    );
  } catch (e) {
    logger?.warn(
      `hnsw dense scan leg failed (${req.table}): ${(e as Error).message} — falling back to full scan`,
    );
  }
  return runBrute(req);
}

/** The legacy exact leg — byte-identical to the pre-HNSW lane SQL. */
async function runBrute<Row>(req: DenseScanLegRequest): Promise<Row[]> {
  const [rows] = await req.db.query<[Row[]]>(
    `SELECT ${req.projection},
        vector::similarity::cosine(embedding, $q) AS score
   FROM ${req.table}
  WHERE embedding != NONE ${req.gates}
  ORDER BY score DESC
  LIMIT $k`,
    req.params,
  );
  return rows ?? [];
}
