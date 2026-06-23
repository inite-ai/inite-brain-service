/**
 * Label-propagation community detection — pure-function unit coverage.
 *
 * The algorithm is a deterministic port of graphiti's
 * community_operations.py. These tests pin the properties the builder
 * relies on: dense clusters collapse onto one label, disconnected
 * components stay separate, isolated nodes are singletons, and the output
 * is reproducible (so community ids stay stable across rebuilds on an
 * unchanged graph).
 */
import {
  buildAdjacency,
  labelPropagation,
  type WeightedNeighbor,
} from '../src/communities/label-propagation';

function clusterOf(groups: string[][], node: string): string[] {
  return groups.find((g) => g.includes(node)) ?? [];
}

describe('labelPropagation — community detection', () => {
  it('collapses two disjoint cliques into two communities', () => {
    const adj = buildAdjacency([
      // clique 1: a-b-c
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
      { from: 'a', to: 'c' },
      // clique 2: x-y-z
      { from: 'x', to: 'y' },
      { from: 'y', to: 'z' },
      { from: 'x', to: 'z' },
    ]);
    const groups = labelPropagation(adj);
    expect(groups).toHaveLength(2);
    expect(clusterOf(groups, 'a').sort()).toEqual(['a', 'b', 'c']);
    expect(clusterOf(groups, 'x').sort()).toEqual(['x', 'y', 'z']);
  });

  it('keeps disconnected components in separate communities', () => {
    const adj = buildAdjacency([
      { from: 'a', to: 'b' },
      { from: 'c', to: 'd' },
    ]);
    const groups = labelPropagation(adj);
    expect(groups).toHaveLength(2);
    expect(clusterOf(groups, 'a').sort()).toEqual(['a', 'b']);
    expect(clusterOf(groups, 'c').sort()).toEqual(['c', 'd']);
  });

  it('pulls a weakly-linked node toward its heavier neighbourhood', () => {
    // n sits between the cluster (heavy, weight 5 to c) and a stray (light,
    // weight 1 to s). It should land with the heavy cluster.
    const adj = buildAdjacency([
      { from: 'a', to: 'b', weight: 5 },
      { from: 'b', to: 'c', weight: 5 },
      { from: 'a', to: 'c', weight: 5 },
      { from: 'c', to: 'n', weight: 5 },
      { from: 'n', to: 's', weight: 1 },
    ]);
    const groups = labelPropagation(adj);
    expect(clusterOf(groups, 'n')).toContain('a');
    expect(clusterOf(groups, 'n')).toContain('c');
  });

  it('returns an empty list for an empty graph', () => {
    expect(labelPropagation(new Map())).toEqual([]);
  });

  it('is deterministic — identical input yields identical output', () => {
    const edges = [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
      { from: 'd', to: 'e' },
    ];
    const first = labelPropagation(buildAdjacency(edges));
    const second = labelPropagation(buildAdjacency(edges));
    expect(second).toEqual(first);
  });
});

describe('buildAdjacency — undirected weight-summed graph', () => {
  it('mirrors every edge in both directions', () => {
    const adj = buildAdjacency([{ from: 'a', to: 'b', weight: 2 }]);
    expect(adj.get('a')).toEqual([{ to: 'b', w: 2 }] as WeightedNeighbor[]);
    expect(adj.get('b')).toEqual([{ to: 'a', w: 2 }] as WeightedNeighbor[]);
  });

  it('drops self-loops and defaults non-positive weights to 1', () => {
    const adj = buildAdjacency([
      { from: 'a', to: 'a', weight: 9 }, // self-loop dropped
      { from: 'a', to: 'b', weight: 0 }, // 0 → default 1
    ]);
    expect(adj.has('a')).toBe(true);
    expect(adj.get('a')).toEqual([{ to: 'b', w: 1 }]);
  });
});
