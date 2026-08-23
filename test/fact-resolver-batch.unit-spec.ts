import { FactResolverService } from '../src/ingest/fact-resolver.service';

/**
 * FactResolverService.resolveMany — batched mention persistence (INGEST_BATCH_FACTS).
 * append_only facts collapse into ONE fn::resolve_facts round-trip; single_active/
 * bitemporal keep the per-fact fn::resolve_fact path (KeyedMutex serialized).
 * Results must come back in the ORIGINAL input order regardless of partitioning.
 */
describe('FactResolverService.resolveMany', () => {
  const sem = (p: string) =>
    p === 'status' || p === 'address' ? 'single_active' : 'append_only';

  function make() {
    const queries: Array<{ sql: string; params: any }> = [];
    const db = {
      query: jest.fn(async (sql: string, params: any) => {
        queries.push({ sql, params });
        if (sql.includes('fn::resolve_facts')) {
          return [
            params.facts.map((f: any, i: number) => ({
              factId: `knowledge_fact:batch${i}_${f.object}`,
              outcome: 'INSERTED',
            })),
          ];
        }
        return [{ factId: `knowledge_fact:single_${params.object}`, outcome: 'INSERTED' }];
      }),
    };
    const factEmbedding = {
      embed: jest.fn(async () => [0.1]),
      writeAltEmbeddingIfHype: jest.fn(async () => {}),
    };
    const predicateRegistry = {
      getSnapshot: jest.fn(async () => ({})),
      policyFor: jest.fn((_c: string, predicate: string) => ({
        semantics: sem(predicate),
      })),
    };
    const svc = new FactResolverService(
      factEmbedding as never,
      predicateRegistry as never,
    );
    return { svc, db, queries };
  }

  function input(predicate: string, object: string) {
    return {
      companyId: 'co_x',
      entityId: 'knowledge_entity:e1',
      predicate,
      object,
      confidence: 0.9,
      validFrom: new Date('2023-01-01T00:00:00Z'),
      source: {},
      precomputedEmbedding: [0.1, 0.2],
    };
  }

  const batchQ = (qs: Array<{ sql: string; params: any }>) =>
    qs.filter((q) => q.sql.includes('fn::resolve_facts'));
  const perFactQ = (qs: Array<{ sql: string; params: any }>) =>
    qs.filter(
      (q) => q.sql.includes('fn::resolve_fact(') && !q.sql.includes('resolve_facts'),
    );

  it('all append_only → ONE fn::resolve_facts batch, results in order', async () => {
    const { svc, db, queries } = make();
    const out = await svc.resolveMany(db as never, [
      input('preference', 'a'),
      input('interacted_with', 'b'),
      input('intent', 'c'),
    ]);
    expect(batchQ(queries)).toHaveLength(1);
    expect(batchQ(queries)[0]!.params.facts).toHaveLength(3);
    expect(perFactQ(queries)).toHaveLength(0);
    expect(out.map((o) => o.result.factId)).toEqual([
      'knowledge_fact:batch0_a',
      'knowledge_fact:batch1_b',
      'knowledge_fact:batch2_c',
    ]);
    expect(out.every((o) => o.semantics === 'append_only')).toBe(true);
  });

  it('mixed → append_only batched, single_active per-fact, ORIGINAL order preserved', async () => {
    const { svc, db, queries } = make();
    const out = await svc.resolveMany(db as never, [
      input('preference', 'a'),
      input('status', 's'),
      input('intent', 'c'),
    ]);
    expect(batchQ(queries)[0]!.params.facts.map((f: any) => f.object)).toEqual([
      'a',
      'c',
    ]);
    expect(perFactQ(queries)).toHaveLength(1);
    expect(perFactQ(queries)[0]!.params.object).toBe('s');
    // Result order matches INPUT order: a(batch), s(single), c(batch).
    expect(out.map((o) => o.result.factId)).toEqual([
      'knowledge_fact:batch0_a',
      'knowledge_fact:single_s',
      'knowledge_fact:batch1_c',
    ]);
    expect(out.map((o) => o.semantics)).toEqual([
      'append_only',
      'single_active',
      'append_only',
    ]);
  });

  it('batch failure → append_only falls back to per-fact (no fact lost)', async () => {
    const { svc, db, queries } = make();
    (db.query as jest.Mock).mockImplementation(async (sql: string, params: any) => {
      queries.push({ sql, params });
      if (sql.includes('fn::resolve_facts')) throw new Error('boom');
      return [{ factId: `knowledge_fact:fb_${params.object}`, outcome: 'INSERTED' }];
    });
    const out = await svc.resolveMany(db as never, [
      input('preference', 'a'),
      input('intent', 'c'),
    ]);
    expect(batchQ(queries)).toHaveLength(1); // attempted
    expect(perFactQ(queries)).toHaveLength(2); // then per-fact fallback for both
    expect(out.map((o) => o.result.factId)).toEqual([
      'knowledge_fact:fb_a',
      'knowledge_fact:fb_c',
    ]);
  });

  it('empty input → no query, empty result', async () => {
    const { svc, db, queries } = make();
    expect(await svc.resolveMany(db as never, [])).toEqual([]);
    expect(queries).toHaveLength(0);
  });
});
