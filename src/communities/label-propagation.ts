/**
 * Label Propagation Algorithm for community detection — a faithful,
 * deterministic port of graphiti's
 * `graphiti_core/utils/maintenance/community_operations.py:93-150`.
 *
 * Each node starts in its own community (label = its own id). On every
 * sweep a node adopts the label carrying the greatest summed edge weight
 * among its neighbours. Iterate until a sweep changes nothing or the cap
 * is hit. Connected, densely-linked entities converge onto a shared
 * label → one community.
 *
 * Determinism (we diverge from graphiti's random tie-break on purpose):
 *   - nodes are swept in sorted id order,
 *   - ties on summed weight break toward the lexicographically smallest
 *     label.
 * This makes the output reproducible, which the unit tests rely on and
 * which keeps community ids stable across rebuilds when the graph is
 * unchanged.
 *
 * Pure: no IO, no clock, no randomness. Mirrors the style of the PPR
 * helpers in `src/search/internals/ppr.ts`.
 */
export interface WeightedNeighbor {
  to: string;
  w: number;
}

export function labelPropagation(
  adjacency: Map<string, WeightedNeighbor[]>,
  maxIterations = 10,
): string[][] {
  const nodes = [...adjacency.keys()].sort();
  const labels = new Map<string, string>();
  for (const n of nodes) labels.set(n, n);

  for (let iter = 0; iter < maxIterations; iter++) {
    let changed = false;
    for (const node of nodes) {
      const next = dominantNeighbourLabel(adjacency.get(node) ?? [], labels);
      if (next !== null && next !== labels.get(node)) {
        labels.set(node, next);
        changed = true;
      }
    }
    if (!changed) break;
  }

  return groupByLabel(nodes, labels);
}

/**
 * The neighbour label carrying the greatest summed incident weight; ties
 * break toward the smallest label id (determinism). Null when the node has
 * no labelled neighbours.
 */
function dominantNeighbourLabel(
  neighbours: WeightedNeighbor[],
  labels: Map<string, string>,
): string | null {
  const weightByLabel = new Map<string, number>();
  for (const nb of neighbours) {
    const lab = labels.get(nb.to);
    if (lab === undefined) continue;
    weightByLabel.set(lab, (weightByLabel.get(lab) ?? 0) + nb.w);
  }
  let best: string | null = null;
  let bestW = -Infinity;
  for (const [lab, w] of weightByLabel) {
    if (w > bestW || (w === bestW && (best === null || lab < best))) {
      best = lab;
      bestW = w;
    }
  }
  return best;
}

/** Bucket nodes by final label; sorted members, deterministic order. */
function groupByLabel(
  nodes: string[],
  labels: Map<string, string>,
): string[][] {
  const groups = new Map<string, string[]>();
  for (const node of nodes) {
    const lab = labels.get(node)!;
    const arr = groups.get(lab);
    if (arr) arr.push(node);
    else groups.set(lab, [node]);
  }
  return [...groups.values()]
    .map((g) => g.sort())
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/**
 * Build an undirected, weight-summed adjacency map from raw edges.
 * Pure — same shape as `buildPprAdjacency` in the search internals.
 * Edges whose endpoints are equal (self-loops) are dropped.
 */
export function buildAdjacency(
  edges: Array<{ from: string; to: string; weight?: number }>,
): Map<string, WeightedNeighbor[]> {
  const adj = new Map<string, WeightedNeighbor[]>();
  const ensure = (id: string): WeightedNeighbor[] => {
    let arr = adj.get(id);
    if (!arr) {
      arr = [];
      adj.set(id, arr);
    }
    return arr;
  };
  for (const e of edges) {
    if (!e.from || !e.to || e.from === e.to) continue;
    const w = typeof e.weight === 'number' && e.weight > 0 ? e.weight : 1.0;
    ensure(e.from).push({ to: e.to, w });
    ensure(e.to).push({ to: e.from, w });
  }
  return adj;
}
