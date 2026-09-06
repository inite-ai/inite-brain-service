import { FactResolverService, conflictSlotSemantics } from '../src/ingest/fact-resolver.service';

/**
 * CONFLICT_MENTION_FACT_SLOT — semantics promotion at the shared
 * buildResolveCall seam (conflictSlotSemantics). The mention/extraction
 * path (no recordOutcomeMetric) promotes a 'single_active' registry
 * policy — whose fn::resolve_fact branch supersedes UNCONDITIONALLY and
 * can never surface a COMPETING pair — to 'bitemporal', so two
 * conversations asserting contradictory values of one (userId, entity,
 * predicate) slot form a linked competing pair instead of the second
 * silently replacing the first (state-transitions s07). Pins:
 *  - flag off → registry passthrough, resolver call byte-identical;
 *  - flag on + mention + single_active → 'bitemporal', COMPETING pair
 *    surfaces linked (competingFactIds passthrough);
 *  - equal value → the fn's exact `object = $object` corroboration is
 *    what decides sameness (verbatim object binding, CORROBORATED
 *    passes through — no TS-side fuzzy matching);
 *  - different users bind their own $user_id (0055 scope-local pool);
 *  - flag on + direct path → untouched (no leak across paths);
 *  - flag on + unknown predicate → append_only bulk untouched.
 */
describe('FactResolverService — CONFLICT_MENTION_FACT_SLOT promotion', () => {
  afterEach(() => {
    delete process.env.CONFLICT_MENTION_FACT_SLOT;
    delete process.env.CONFLICT_DIRECT_FACT_SLOT;
  });

  function make(
    resolveRow: Record<string, unknown> = { factId: 'knowledge_fact:x', outcome: 'INSERTED' },
  ) {
    const queries: Array<{ sql: string; params: Record<string, unknown> }> = [];
    const db = {
      query: jest.fn(async (sql: string, params: Record<string, unknown>) => {
        queries.push({ sql, params });
        return [resolveRow];
      }),
    };
    const factEmbedding = {
      embed: jest.fn(async () => [0.1]),
      writeAltEmbeddingIfHype: jest.fn(async () => {}),
    };
    // Mirrors PredicateRegistryService.policyFor: a known slot predicate
    // returns its single_active definition; anything else falls to the
    // DEFAULT_FALLBACK sentinel ('__default__', append_only).
    const predicateRegistry = {
      getSnapshot: jest.fn(async () => ({})),
      policyFor: jest.fn((_c: string, predicate: string) =>
        predicate === 'address'
          ? { predicateId: 'address', semantics: 'single_active' }
          : { predicateId: '__default__', semantics: 'append_only' },
      ),
    };
    const svc = new FactResolverService(factEmbedding as never, predicateRegistry as never);
    return { svc, db, queries };
  }

  function input(
    predicate: string,
    opts: { recordOutcomeMetric?: boolean; userId?: string; object?: string } = {},
  ) {
    return {
      companyId: 'co_x',
      entityId: 'knowledge_entity:e1',
      predicate,
      object: opts.object ?? 'lease ends December 2026',
      confidence: 0.9,
      validFrom: new Date('2026-08-08T10:00:00Z'),
      source: {},
      precomputedEmbedding: [0.1, 0.2],
      ...(opts.recordOutcomeMetric !== undefined
        ? { recordOutcomeMetric: opts.recordOutcomeMetric }
        : {}),
      ...(opts.userId !== undefined ? { userId: opts.userId } : {}),
    };
  }

  const resolveCalls = (queries: Array<{ sql: string; params: Record<string, unknown> }>) =>
    queries.filter((q) => q.sql.includes('fn::resolve_fact('));

  const semanticsParam = (queries: Array<{ sql: string; params: Record<string, unknown> }>) =>
    resolveCalls(queries)[0]?.params.semantics;

  it('flag off: mention-path single_active passthrough, resolver call byte-identical', async () => {
    // Baseline pin: with the flag unset AND with it explicitly '0', the
    // fn::resolve_fact invocation binds the exact same parameters — the
    // default-off promise is byte-identical current behavior.
    const unset = make();
    const outUnset = await unset.svc.resolve(unset.db as never, input('address'));
    process.env.CONFLICT_MENTION_FACT_SLOT = '0';
    const off = make();
    const outOff = await off.svc.resolve(off.db as never, input('address'));

    expect(outUnset.semantics).toBe('single_active');
    expect(outOff.semantics).toBe('single_active');
    expect(semanticsParam(unset.queries)).toBe('single_active');
    expect(resolveCalls(off.queries)[0]!.params).toEqual(resolveCalls(unset.queries)[0]!.params);
  });

  it('flag on + mention + single_active: promoted to bitemporal, competing pair surfaces linked', async () => {
    process.env.CONFLICT_MENTION_FACT_SLOT = '1';
    const { svc, db, queries } = make({
      factId: 'knowledge_fact:new',
      outcome: 'COMPETING',
      competingFactIds: ['knowledge_fact:prior'],
    });
    const out = await svc.resolve(db as never, input('address'));
    expect(semanticsParam(queries)).toBe('bitemporal');
    expect(out.semantics).toBe('bitemporal');
    expect(out.result.outcome).toBe('COMPETING');
    expect(out.result.competingFactIds).toEqual(['knowledge_fact:prior']);
  });

  it("flag on: value-sameness is the fn's exact object binding — CORROBORATED passes through", async () => {
    process.env.CONFLICT_MENTION_FACT_SLOT = '1';
    const { svc, db, queries } = make({
      factId: 'knowledge_fact:new',
      outcome: 'CORROBORATED',
      corroboratedFactId: 'knowledge_fact:prior',
    });
    const out = await svc.resolve(
      db as never,
      input('address', { object: 'lease ends December 2026' }),
    );
    // The object rides into the fn VERBATIM — sameness stays the fn's
    // `object = $object` corroboration check, no TS-side fuzzy matching.
    expect(resolveCalls(queries)[0]!.params.object).toBe('lease ends December 2026');
    expect(out.result.outcome).toBe('CORROBORATED');
    expect(out.result.corroboratedFactId).toBe('knowledge_fact:prior');
  });

  it('flag on: different users bind their own $user_id (0055 scope-local pool, no collision)', async () => {
    process.env.CONFLICT_MENTION_FACT_SLOT = '1';
    const { svc, db, queries } = make();
    await svc.resolve(db as never, input('address', { userId: 'user-a' }));
    await svc.resolve(db as never, input('address', { userId: 'user-b' }));
    const calls = resolveCalls(queries);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.params.user_id).toBe('user-a');
    expect(calls[1]!.params.user_id).toBe('user-b');
  });

  it('flag on + direct path (recordOutcomeMetric): untouched — no leak across paths', async () => {
    process.env.CONFLICT_MENTION_FACT_SLOT = '1';
    const { svc, db, queries } = make();
    const out = await svc.resolve(db as never, input('address', { recordOutcomeMetric: true }));
    expect(semanticsParam(queries)).toBe('single_active');
    expect(out.semantics).toBe('single_active');
  });

  it('flag on + mention + unknown predicate: append_only open-vocabulary bulk untouched', async () => {
    process.env.CONFLICT_MENTION_FACT_SLOT = '1';
    const { svc, db, queries } = make();
    const out = await svc.resolve(db as never, input('lease_end_date'));
    expect(semanticsParam(queries)).toBe('append_only');
    expect(out.semantics).toBe('append_only');
  });

  describe('conflictSlotSemantics — the shared pure decision', () => {
    const slot = { predicateId: 'address', semantics: 'single_active' };
    const fallback = { predicateId: '__default__', semantics: 'append_only' };

    it('both flags off: registry passthrough on both paths', () => {
      expect(conflictSlotSemantics(slot, 'mention')).toBe('single_active');
      expect(conflictSlotSemantics(slot, 'direct')).toBe('single_active');
      expect(conflictSlotSemantics(fallback, 'mention')).toBe('append_only');
      expect(conflictSlotSemantics(fallback, 'direct')).toBe('append_only');
    });

    it('mention flag on: only mention-path single_active promotes', () => {
      process.env.CONFLICT_MENTION_FACT_SLOT = '1';
      expect(conflictSlotSemantics(slot, 'mention')).toBe('bitemporal');
      expect(conflictSlotSemantics(fallback, 'mention')).toBe('append_only');
      expect(conflictSlotSemantics(slot, 'direct')).toBe('single_active');
      expect(conflictSlotSemantics(fallback, 'direct')).toBe('append_only');
    });

    it('direct flag on: only direct-path fallback promotes (mention side untouched)', () => {
      process.env.CONFLICT_DIRECT_FACT_SLOT = '1';
      expect(conflictSlotSemantics(fallback, 'direct')).toBe('bitemporal');
      expect(conflictSlotSemantics(slot, 'direct')).toBe('single_active');
      expect(conflictSlotSemantics(slot, 'mention')).toBe('single_active');
      expect(conflictSlotSemantics(fallback, 'mention')).toBe('append_only');
    });

    it('both flags on: each path keeps its own promotion rule', () => {
      process.env.CONFLICT_DIRECT_FACT_SLOT = '1';
      process.env.CONFLICT_MENTION_FACT_SLOT = '1';
      expect(conflictSlotSemantics(fallback, 'direct')).toBe('bitemporal');
      expect(conflictSlotSemantics(slot, 'mention')).toBe('bitemporal');
      expect(conflictSlotSemantics(slot, 'direct')).toBe('single_active');
      expect(conflictSlotSemantics(fallback, 'mention')).toBe('append_only');
    });
  });
});
