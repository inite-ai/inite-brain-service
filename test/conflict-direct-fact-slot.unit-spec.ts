import { FactResolverService } from '../src/ingest/fact-resolver.service';

/**
 * CONFLICT_DIRECT_FACT_SLOT — semantics promotion at the
 * buildResolveCall seam. The typed direct path (recordOutcomeMetric,
 * set only by FactIngestService.ingestFact) promotes an
 * unknown-predicate fact (registry '__default__' fallback, semantics
 * append_only) to 'bitemporal' so same-slot direct writes can form
 * conflicts. Pins:
 *  - flag off → append_only passthrough (byte-identical);
 *  - flag on + direct + unknown predicate → 'bitemporal';
 *  - flag on + KNOWN predicate → registry policy untouched;
 *  - flag on + mention path (no recordOutcomeMetric) → untouched.
 */
describe('FactResolverService — CONFLICT_DIRECT_FACT_SLOT promotion', () => {
  afterEach(() => {
    delete process.env.CONFLICT_DIRECT_FACT_SLOT;
  });

  function make() {
    const queries: Array<{ sql: string; params: Record<string, unknown> }> = [];
    const db = {
      query: jest.fn(async (sql: string, params: Record<string, unknown>) => {
        queries.push({ sql, params });
        return [{ factId: 'knowledge_fact:x', outcome: 'INSERTED' }];
      }),
    };
    const factEmbedding = {
      embed: jest.fn(async () => [0.1]),
      writeAltEmbeddingIfHype: jest.fn(async () => {}),
    };
    // Mirrors PredicateRegistryService.policyFor: a known predicate
    // returns its own definition; anything else falls to the
    // DEFAULT_FALLBACK sentinel ('__default__', append_only).
    const predicateRegistry = {
      getSnapshot: jest.fn(async () => ({})),
      policyFor: jest.fn((_c: string, predicate: string) =>
        predicate === 'status'
          ? { predicateId: 'status', semantics: 'single_active' }
          : { predicateId: '__default__', semantics: 'append_only' },
      ),
    };
    const svc = new FactResolverService(factEmbedding as never, predicateRegistry as never);
    return { svc, db, queries };
  }

  function input(predicate: string, recordOutcomeMetric?: boolean) {
    return {
      companyId: 'co_x',
      entityId: 'knowledge_entity:e1',
      predicate,
      object: '17:00',
      confidence: 0.9,
      validFrom: new Date('2026-01-01T00:00:00Z'),
      source: {},
      precomputedEmbedding: [0.1, 0.2],
      ...(recordOutcomeMetric !== undefined ? { recordOutcomeMetric } : {}),
    };
  }

  const semanticsParam = (queries: Array<{ sql: string; params: Record<string, unknown> }>) => {
    const call = queries.find((q) => q.sql.includes('fn::resolve_fact('));
    return call?.params.semantics;
  };

  it('flag off: direct-path unknown predicate stays append_only (byte-identical)', async () => {
    const { svc, db, queries } = make();
    const out = await svc.resolve(db as never, input('payout_cutoff', true));
    expect(semanticsParam(queries)).toBe('append_only');
    expect(out.semantics).toBe('append_only');
  });

  it('flag on + direct path + unknown predicate: promoted to bitemporal', async () => {
    process.env.CONFLICT_DIRECT_FACT_SLOT = '1';
    const { svc, db, queries } = make();
    const out = await svc.resolve(db as never, input('payout_cutoff', true));
    expect(semanticsParam(queries)).toBe('bitemporal');
    expect(out.semantics).toBe('bitemporal');
  });

  it('flag on + KNOWN predicate: registry policy untouched', async () => {
    process.env.CONFLICT_DIRECT_FACT_SLOT = '1';
    const { svc, db, queries } = make();
    const out = await svc.resolve(db as never, input('status', true));
    expect(semanticsParam(queries)).toBe('single_active');
    expect(out.semantics).toBe('single_active');
  });

  it('flag on + mention path (no recordOutcomeMetric): untouched', async () => {
    process.env.CONFLICT_DIRECT_FACT_SLOT = '1';
    const { svc, db, queries } = make();
    const out = await svc.resolve(db as never, input('payout_cutoff'));
    expect(semanticsParam(queries)).toBe('append_only');
    expect(out.semantics).toBe('append_only');
  });
});
