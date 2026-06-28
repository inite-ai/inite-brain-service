import { Surreal, StringRecordId } from 'surrealdb';
import type { EntityBucket } from './types';

const ALPHA = 0.85;
const ITERATIONS = 3;
const PPR_BOOST_BETA = 0.5;

type PprEdge = { in: unknown; out: unknown; weight?: number };

/** PPR step 1 — fetch in-subgraph edges. */
async function fetchPprEdges(
  db: Surreal,
  ids: string[],
): Promise<PprEdge[]> {
  const ridIds = ids.map((s) => new StringRecordId(s));
  const [edgeRows] = await db.query<[PprEdge[]]>(
    `SELECT in, out, weight FROM knowledge_edge
       WHERE in INSIDE $ids AND out INSIDE $ids`,
    { ids: ridIds },
  );
  return (edgeRows as PprEdge[]) ?? [];
}

/** PPR step 2 — undirected adjacency + per-node out-weight. Pure. */
export function buildPprAdjacency(
  ids: string[],
  edges: PprEdge[],
): {
  adj: Map<string, Array<{ to: string; w: number }>>;
  outWeight: Map<string, number>;
} {
  const adj = new Map<string, Array<{ to: string; w: number }>>();
  for (const id of ids) adj.set(id, []);
  for (const e of edges) {
    const a = String(e.in);
    const b = String(e.out);
    const w = typeof e.weight === 'number' ? e.weight : 1.0;
    if (adj.has(a) && adj.has(b)) {
      adj.get(a)!.push({ to: b, w });
      adj.get(b)!.push({ to: a, w });
    }
  }
  const outWeight = new Map<string, number>();
  for (const [src, nbrs] of adj) {
    outWeight.set(src, nbrs.reduce((acc, n) => acc + n.w, 0));
  }
  return { adj, outWeight };
}

/** PPR step 3 — bestScore-weighted seed, Σ = 1. Null on zero mass. */
export function buildPprSeed(
  byEntity: Map<string, { bestScore: number }>,
): Map<string, number> | null {
  const seedRaw = new Map<string, number>();
  let seedSum = 0;
  for (const [id, b] of byEntity) {
    const s = Math.max(b.bestScore, 0);
    seedRaw.set(id, s);
    seedSum += s;
  }
  if (seedSum === 0) return null;
  const seed = new Map<string, number>();
  for (const [id, s] of seedRaw) seed.set(id, s / seedSum);
  return seed;
}

/** PPR step 4 — power-iteration `r ← α·M·r + (1−α)·seed` with
 *  dangling-node mass returned to the seed slot. */
export interface RunPprIterationsOptions {
  ids: string[];
  adj: Map<string, Array<{ to: string; w: number }>>;
  outWeight: Map<string, number>;
  seed: Map<string, number>;
}

export function runPprIterations({
  ids,
  adj,
  outWeight,
  seed,
}: RunPprIterationsOptions): Map<string, number> {
  let r = new Map(seed);
  for (let i = 0; i < ITERATIONS; i++) {
    const next = new Map<string, number>();
    for (const id of ids) next.set(id, (1 - ALPHA) * (seed.get(id) ?? 0));
    for (const [src, mass] of r) {
      const ow = outWeight.get(src) ?? 0;
      if (ow === 0) {
        // Dangling node (no out-edges) — redistribute its mass across the
        // seed (personalization) vector, the textbook PPR teleport. The old
        // code parked it on the node's own slot, which let dead-end seeds
        // hoard α·mass every iteration and over-rank themselves. `seed` is
        // already normalised, so the total mass is preserved (no loss).
        for (const [sid, sv] of seed) {
          next.set(sid, (next.get(sid) ?? 0) + ALPHA * mass * sv);
        }
        continue;
      }
      for (const nbr of adj.get(src) ?? []) {
        const flow = ALPHA * mass * (nbr.w / ow);
        next.set(nbr.to, (next.get(nbr.to) ?? 0) + flow);
      }
    }
    r = next;
  }
  return r;
}

/** PPR step 5 — multiply rankScore by (1 + β·r_norm). */
export function applyPprBoost(
  byEntity: Map<string, EntityBucket>,
  r: Map<string, number>,
): void {
  let maxR = 0;
  for (const v of r.values()) if (v > maxR) maxR = v;
  if (maxR === 0) return;
  for (const [id, bucket] of byEntity) {
    const rNorm = (r.get(id) ?? 0) / maxR;
    bucket.rankScore = bucket.rankScore * (1 + PPR_BOOST_BETA * rNorm);
  }
}

/**
 * Personalized PageRank prior over the candidate-entity subgraph.
 * Mutates `byEntity[*].rankScore` in place. Algorithm: fetch in-
 * subgraph edges; seed each candidate by its bestScore (row-normalised);
 * power-iterate `r ← α·M·r + (1−α)·seed` with α=0.85, 3 iterations;
 * boost rankScore by (1 + β·r_norm) with β=0.5.
 *
 * Returns silently when there are no edges in the subgraph or seed mass
 * is zero — PPR with no transitions reduces to the identity.
 */
export async function applyPprPrior(
  db: Surreal,
  byEntity: Map<string, EntityBucket>,
): Promise<void> {
  const ids = [...byEntity.keys()];
  if (ids.length < 2) return;
  const edges = await fetchPprEdges(db, ids);
  if (edges.length === 0) return;

  const { adj, outWeight } = buildPprAdjacency(ids, edges);
  const seed = buildPprSeed(byEntity);
  if (!seed) return;

  const r = runPprIterations({ ids, adj, outWeight, seed });
  applyPprBoost(byEntity, r);
}
