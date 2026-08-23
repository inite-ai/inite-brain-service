import {
  buildNeighbourMap,
  expandViaEdges,
} from '../src/search/internals/edge-expansion';
import type { FactRow } from '../src/search/internals/types';

/**
 * Combined vector+graph leg — the vector KNN query projects each fact's entity
 * neighbourhood inline (SEARCH_COMBINED_VECTOR_GRAPH). These tests pin the
 * app-side halves that are DB-independent: harvesting the prefetched map from
 * the leg's rows, and edge-expansion serving covered seeds from it while only
 * the uncovered seeds hit the DB.
 */
function row(partial: Partial<FactRow>): FactRow {
  return {
    id: 'knowledge_fact:x',
    entityId: 'knowledge_entity:e1',
    predicate: 'p',
    object: 'o',
    confidence: 1,
    validFrom: '2023-01-01T00:00:00Z',
    recordedAt: '2023-01-01T00:00:00Z',
    status: 'active',
    source: {},
    ...partial,
  };
}

describe('buildNeighbourMap', () => {
  it('returns undefined when no row carries neighbours (flag off)', () => {
    expect(buildNeighbourMap([row({}), row({ entityId: 'knowledge_entity:e2' })]))
      .toBeUndefined();
  });

  it('harvests neighbours keyed by entity, first non-null per entity wins', () => {
    const rows = [
      row({
        entityId: 'knowledge_entity:e1',
        outNeighbours: [{ kind: 'knows', weight: 1, peer: { id: 'knowledge_entity:n1' } }],
        inNeighbours: [],
      }),
      row({ entityId: 'knowledge_entity:e1', outNeighbours: [], inNeighbours: [] }), // dup entity, ignored
      row({
        entityId: 'knowledge_entity:e2',
        outNeighbours: [],
        inNeighbours: [{ kind: 'mentors', peer: { id: 'knowledge_entity:n2' } }],
      }),
    ];
    const map = buildNeighbourMap(rows)!;
    expect(map.size).toBe(2);
    expect(map.get('knowledge_entity:e1')?.outNeighbours?.[0]?.peer?.id).toBe('knowledge_entity:n1');
    expect(map.get('knowledge_entity:e2')?.inNeighbours?.[0]?.peer?.id).toBe('knowledge_entity:n2');
  });
});

describe('expandViaEdges prefetch', () => {
  // Minimal bucket map: two seeds, both with a fact so they can be selected.
  function bucket(entityId: string) {
    return {
      entityId,
      rankScore: 1,
      degree: 1,
      facts: [{ row: row({ entityId }), score: 1, breakdown: {} as never }],
    };
  }

  it('serves covered seeds from the map and only queries uncovered ones', async () => {
    let queriedIds: unknown[] | null = null;
    const db = {
      query: async (_sql: string, params: { ids: unknown[] }) => {
        queriedIds = params.ids;
        return [[]]; // no neighbours for the uncovered seed
      },
    } as never;
    const byEntity = new Map<string, any>([
      ['knowledge_entity:e1', bucket('knowledge_entity:e1')],
      ['knowledge_entity:e2', bucket('knowledge_entity:e2')],
    ]);
    const prefetched = new Map([
      ['knowledge_entity:e1', { outNeighbours: [], inNeighbours: [] }],
    ]);
    await expandViaEdges({
      db,
      logger: { warn: () => {} },
      byEntity,
      baseWhere: { sql: '', params: {} },
      dto: { query: 'q' } as never,
      callerScopes: [],
      passesPolicy: () => true,
      prefetchedNeighbours: prefetched,
      config: { topSeeds: 5, maxNeighboursPerSeed: 5, maxInjected: 50, minEdgeWeight: 0 } as never,
    });
    // e1 was covered by prefetch → NOT in the DB query; only e2 queried.
    expect(queriedIds).not.toBeNull();
    expect(queriedIds!.length).toBe(1);
    expect(String(queriedIds![0])).toContain('e2');
  });

  it('queries all seeds when no prefetch is supplied (legacy behaviour)', async () => {
    let queriedIds: unknown[] | null = null;
    const db = {
      query: async (_sql: string, params: { ids: unknown[] }) => {
        queriedIds = params.ids;
        return [[]];
      },
    } as never;
    const byEntity = new Map<string, any>([
      ['knowledge_entity:e1', bucket('knowledge_entity:e1')],
      ['knowledge_entity:e2', bucket('knowledge_entity:e2')],
    ]);
    await expandViaEdges({
      db,
      logger: { warn: () => {} },
      byEntity,
      baseWhere: { sql: '', params: {} },
      dto: { query: 'q' } as never,
      callerScopes: [],
      passesPolicy: () => true,
      config: { topSeeds: 5, maxNeighboursPerSeed: 5, maxInjected: 50, minEdgeWeight: 0 } as never,
    });
    expect(queriedIds!.length).toBe(2);
  });
});
