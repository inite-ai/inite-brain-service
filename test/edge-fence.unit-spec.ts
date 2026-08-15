import { buildEdgeFence } from '../src/search/internals/edge-fence';
import { expandViaEdges } from '../src/search/internals/edge-expansion';
import {
  fetchNeighbours,
  expandEntityIdsViaEdges,
} from '../src/search/internals/neighbours';
import { applyPprPrior } from '../src/search/internals/ppr';
import { fetchOneHopNeighbourIds } from '../src/search/internals/graph-retrieve-db';
import type { Surreal } from 'surrealdb';

/**
 * Graph research 2026-08, action 1 — the edge-read policy fence. Fact
 * reads have carried invalidation + fail-closed user scope since 0055;
 * edge reads carried NEITHER, so a fenced user's graph structure could
 * steer edge expansion / rerank context / PPR / multi-hop anchoring
 * for every other caller of the tenant. Two layers under test: the
 * edge-row SQL condition inside the traversal step, and the JS-side
 * peer-entity visibility check (edges carry no userId today — scope
 * lives on the peer rows user-forget already joins through).
 */

describe('buildEdgeFence', () => {
  it('fail-closed without a user: tenant-global edges and peers only', () => {
    const f = buildEdgeFence();
    expect(f.cond).toBe('invalidatedAt IS NONE AND userId IS NONE');
    expect(f.params).toEqual({});
    expect(f.allowsPeer(undefined)).toBe(true);
    expect(f.allowsPeer(null)).toBe(true);
    expect(f.allowsPeer('alice')).toBe(false);
  });

  it('scoped caller: global + own, never someone else', () => {
    const f = buildEdgeFence('alice');
    expect(f.cond).toBe(
      'invalidatedAt IS NONE AND (userId IS NONE OR userId = $edgeScopeUserId)',
    );
    expect(f.params).toEqual({ edgeScopeUserId: 'alice' });
    expect(f.allowsPeer(null)).toBe(true);
    expect(f.allowsPeer('alice')).toBe(true);
    expect(f.allowsPeer('bob')).toBe(false);
  });
});

function captureDb(results: unknown[][]): {
  db: Surreal;
  sql: string[];
  params: Array<Record<string, unknown>>;
} {
  const sql: string[] = [];
  const params: Array<Record<string, unknown>> = [];
  let call = 0;
  const db = {
    query: async (q: string, p?: Record<string, unknown>) => {
      sql.push(q);
      params.push(p ?? {});
      const r = results[Math.min(call, results.length - 1)];
      call += 1;
      return r;
    },
  } as unknown as Surreal;
  return { db, sql, params };
}

const warnless = { warn: () => {} };

describe('edge expansion under the fence', () => {
  const byEntity = new Map([
    [
      'knowledge_entity:seed',
      { entityId: 'knowledge_entity:seed', rankScore: 1, bestScore: 1, facts: [] },
    ],
  ]) as never;

  it('filters the traversal in SQL and scoped peers in JS', async () => {
    const { db, sql, params } = captureDb([
      [
        [
          {
            id: 'knowledge_entity:seed',
            outNeighbours: [
              {
                kind: 'knows',
                weight: 1,
                peer: { id: 'knowledge_entity:global', userId: null },
              },
              {
                kind: 'knows',
                weight: 1,
                peer: { id: 'knowledge_entity:alices', userId: 'alice' },
              },
            ],
            inNeighbours: null,
          },
        ],
      ],
      [[]], // neighbour-fact fetch
    ]);
    await expandViaEdges({
      db,
      logger: warnless,
      byEntity,
      baseWhere: { sql: '', params: {} },
      dto: { query: 'q' } as never,
      callerScopes: [],
      passesPolicy: () => true,
      config: { topSeeds: 3, maxNeighboursPerSeed: 5, alpha: 0.4 },
    });
    expect(sql[0]).toContain(
      '->(knowledge_edge WHERE invalidatedAt IS NONE AND userId IS NONE)',
    );
    expect(sql[0]).toContain('peer: out.{id, userId}');
    // The scoped peer never reaches the neighbour-fact fetch.
    expect(String(params[1].entityIds)).toContain('global');
    expect(String(params[1].entityIds)).not.toContain('alices');
  });

  it('a scoped caller binds their id into the edge filter', async () => {
    const { db, sql, params } = captureDb([[[]]]);
    await expandViaEdges({
      db,
      logger: warnless,
      byEntity,
      baseWhere: { sql: '', params: {} },
      dto: { query: 'q', userId: 'alice' } as never,
      callerScopes: [],
      passesPolicy: () => true,
      config: { topSeeds: 3, maxNeighboursPerSeed: 5, alpha: 0.4 },
    });
    expect(sql[0]).toContain('userId = $edgeScopeUserId');
    expect(params[0].edgeScopeUserId).toBe('alice');
  });

  it('fences prefetched neighbourhoods too (combined-leg path)', async () => {
    const { db, sql } = captureDb([[[]]]);
    const injected = await expandViaEdges({
      db,
      logger: warnless,
      byEntity,
      baseWhere: { sql: '', params: {} },
      dto: { query: 'q' } as never,
      callerScopes: [],
      passesPolicy: () => true,
      config: { topSeeds: 3, maxNeighboursPerSeed: 5, alpha: 0.4 },
      prefetchedNeighbours: new Map([
        [
          'knowledge_entity:seed',
          {
            outNeighbours: [
              {
                kind: 'knows',
                weight: 1,
                peer: { id: 'knowledge_entity:alices', userId: 'alice' },
              },
            ],
            inNeighbours: null,
          },
        ],
      ]),
    });
    // The only prefetched peer is scoped → nothing to inject, and the
    // seed was served from the prefetch so no traversal query ran.
    expect(injected).toBe(0);
    expect(sql).toHaveLength(0);
  });
});

describe('rerank neighbours under the fence', () => {
  it('drops scoped peers and filters the traversal', async () => {
    const { db, sql } = captureDb([
      [
        [
          {
            id: 'knowledge_entity:a',
            outNeighbours: [
              {
                kind: 'works_at',
                peer: {
                  id: 'knowledge_entity:acme',
                  type: 'other',
                  canonicalName: 'Acme',
                  userId: null,
                },
              },
              {
                kind: 'knows',
                peer: {
                  id: 'knowledge_entity:secret',
                  type: 'customer',
                  canonicalName: 'Secret Friend',
                  userId: 'bob',
                },
              },
            ],
            inNeighbours: null,
          },
        ],
      ],
    ]);
    const map = await fetchNeighbours({
      db,
      logger: warnless,
      entityIds: ['knowledge_entity:a'],
    });
    expect(sql[0]).toContain(
      '->(knowledge_edge WHERE invalidatedAt IS NONE AND userId IS NONE)',
    );
    const names = (map.get('knowledge_entity:a') ?? []).map(
      (n) => n.canonicalName,
    );
    expect(names).toEqual(['Acme']);
  });
});

describe('multi-hop id expansion under the fence', () => {
  it('scoped peers never join the anchor set', async () => {
    const { db, sql } = captureDb([
      [
        [
          {
            id: 'knowledge_entity:a',
            outNeighbours: [
              { peer: { id: 'knowledge_entity:global', userId: null } },
              { peer: { id: 'knowledge_entity:priv', userId: 'bob' } },
            ],
            inNeighbours: null,
          },
        ],
      ],
    ]);
    const out = await expandEntityIdsViaEdges({
      db,
      logger: warnless,
      entityIds: ['knowledge_entity:a'],
    });
    expect(sql[0]).toContain('invalidatedAt IS NONE AND userId IS NONE');
    expect(out).toContain('knowledge_entity:global');
    expect(out).not.toContain('knowledge_entity:priv');
  });
});

describe('PPR under the fence', () => {
  it('the in-subgraph edge query carries the fence condition', async () => {
    const { db, sql, params } = captureDb([[[]]]);
    const byEntity = new Map([
      ['knowledge_entity:a', { entityId: 'knowledge_entity:a', rankScore: 1, bestScore: 1, facts: [] }],
      ['knowledge_entity:b', { entityId: 'knowledge_entity:b', rankScore: 1, bestScore: 1, facts: [] }],
    ]);
    await applyPprPrior(db, byEntity as never, 'alice');
    expect(sql[0]).toContain(
      'invalidatedAt IS NONE AND (userId IS NONE OR userId = $edgeScopeUserId)',
    );
    expect(params[0].edgeScopeUserId).toBe('alice');
  });
});

describe('graph-retrieve neighbour walk under the fence', () => {
  it('tenant-global only, scoped peers dropped', async () => {
    const { db, sql } = captureDb([
      [
        [
          {
            id: 'knowledge_entity:seed',
            outNeighbours: [
              { peer: { id: 'knowledge_entity:pub', userId: null } },
              { peer: { id: 'knowledge_entity:priv', userId: 'carol' } },
            ],
            inNeighbours: null,
          },
        ],
      ],
    ]);
    const ids = await fetchOneHopNeighbourIds(db, ['knowledge_entity:seed']);
    expect(sql[0]).toContain('invalidatedAt IS NONE AND userId IS NONE');
    expect(ids).toEqual(['knowledge_entity:pub']);
  });
});

describe('resolveExpansionConfig — the alpha kill switch', () => {
  // Deferred import keeps this spec's header list stable.
  const { resolveExpansionConfig } = jest.requireActual(
    '../src/search/internals/edge-expansion',
  );

  it('an explicit 0 disables (the pre-fix parser mapped it to 0.4)', () => {
    expect(
      resolveExpansionConfig({
        SEARCH_EDGE_EXPANSION_ALPHA: '0',
      } as NodeJS.ProcessEnv).alpha,
    ).toBe(0);
  });

  it('default is OFF since the 2026-08-15 ablation; 0.4 re-enables', () => {
    expect(resolveExpansionConfig({} as NodeJS.ProcessEnv).alpha).toBe(0);
    expect(
      resolveExpansionConfig({
        SEARCH_EDGE_EXPANSION_ALPHA: '0.4',
      } as NodeJS.ProcessEnv).alpha,
    ).toBe(0.4);
    expect(
      resolveExpansionConfig({
        SEARCH_EDGE_EXPANSION_ALPHA: 'nope',
      } as NodeJS.ProcessEnv).alpha,
    ).toBe(0);
    expect(
      resolveExpansionConfig({
        SEARCH_EDGE_EXPANSION_ALPHA: '1.5',
      } as NodeJS.ProcessEnv).alpha,
    ).toBe(0);
  });

  it('alpha 0 skips the edge queries entirely', async () => {
    const { db, sql } = captureDb([[[]]]);
    const injected = await expandViaEdges({
      db,
      logger: warnless,
      byEntity: new Map([
        [
          'knowledge_entity:seed',
          { entityId: 'knowledge_entity:seed', rankScore: 1, bestScore: 1, facts: [] },
        ],
      ]) as never,
      baseWhere: { sql: '', params: {} },
      dto: { query: 'q' } as never,
      callerScopes: [],
      passesPolicy: () => true,
      config: { topSeeds: 3, maxNeighboursPerSeed: 5, alpha: 0 },
    });
    expect(injected).toBe(0);
    expect(sql).toHaveLength(0);
  });
});
