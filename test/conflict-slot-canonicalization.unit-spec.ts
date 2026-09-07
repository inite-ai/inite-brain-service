import { FactResolverService, canonicalSlotFor } from '../src/ingest/fact-resolver.service';

/**
 * CONFLICT_SLOT_CANONICALIZATION — write-side slot canonicalization at
 * the shared buildResolveCall seam (canonicalSlotFor). The conflict
 * machinery pairs only identical (userId, entity, predicate), but the
 * extractor splits one contradicted attribute across two predicates
 * (state-transitions s07, measured live): "runs until December 2026"
 * lands as (office lease, duration_limit) — an append_only harvest
 * predicate — while "ends in September 2026" lands as (office lease,
 * status), so no collision structurally exists and
 * CONFLICT_MENTION_FACT_SLOT is starved. The flag routes the
 * calendar-anchored duration_limit arm into the canonical status slot
 * at write time (static declared alias table + calendar-anchor regex —
 * no DB read, no fuzzy matching, no LLM), so both arms meet in ONE slot
 * and the normal single_active/bitemporal machinery adjudicates.
 *
 * The state_change entry closes the remaining EXTRACTION LANDING
 * LOTTERY (run stmtq22rtp): the same two turns can land both arms as
 * (office lease, state_change) — append_only, no pair by design. A
 * calendar-anchored lifecycle claim on a KNOWN NON-PERSON subject
 * reroutes to status too; a person's own state_change history (the
 * transition lanes' timeline substrate) and unknown-typed subjects
 * never do. Pins:
 *  - flag off (unset AND '0') → extracted-predicate passthrough, the
 *    resolver call byte-identical;
 *  - flag on: the EXACT s07 shapes meet in one slot — both arms bind
 *    predicate 'status' regardless of arrival order, the rerouted arm
 *    is re-embedded with the canonical slot text, and with
 *    CONFLICT_MENTION_FACT_SLOT also on both bind semantics
 *    'bitemporal' (COMPETING passthrough);
 *  - non-contradicting different predicates untouched: a bare unit
 *    duration ("30 days") stays in append_only duration_limit;
 *  - other predicates, the direct typed path, and facts carrying an
 *    EDC predicateAlias (0082 canon) are untouched;
 *  - different entities bind their own $eid — pool separation stays
 *    the fn's entityId filter, canonicalization never crosses entities.
 */
describe('FactResolverService — CONFLICT_SLOT_CANONICALIZATION', () => {
  afterEach(() => {
    delete process.env.CONFLICT_SLOT_CANONICALIZATION;
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
      embed: jest.fn(async () => [0.5]),
      writeAltEmbeddingIfHype: jest.fn(async () => {}),
    };
    // Mirrors PredicateRegistryService.policyFor over the CORE seed: the
    // two s07 slots return their seed policies; anything else falls to
    // the DEFAULT_FALLBACK sentinel ('__default__', append_only).
    const predicateRegistry = {
      getSnapshot: jest.fn(async () => ({})),
      policyFor: jest.fn((_c: string, predicate: string) => {
        if (predicate === 'status') return { predicateId: 'status', semantics: 'single_active' };
        if (predicate === 'duration_limit')
          return { predicateId: 'duration_limit', semantics: 'append_only' };
        if (predicate === 'state_change')
          return { predicateId: 'state_change', semantics: 'append_only' };
        return { predicateId: '__default__', semantics: 'append_only' };
      }),
    };
    const svc = new FactResolverService(factEmbedding as never, predicateRegistry as never);
    return { svc, db, queries, factEmbedding };
  }

  /** The two s07 arms exactly as measured live on the stand. */
  const DECEMBER_ARM = { predicate: 'duration_limit', object: 'until December 2026' };
  const SEPTEMBER_ARM = { predicate: 'status', object: 'ends in September 2026' };

  /**
   * The third observed landing (hermetic battery run stmtq22rtp): the
   * extraction lottery put BOTH lease arms into state_change on the
   * office-lease ARTIFACT entity — an append_only predicate where no
   * conflict pair can form by design.
   */
  const DECEMBER_STATE_ARM = {
    predicate: 'state_change',
    object: 'runs until December 2026',
    entityType: 'asset',
  };
  const SEPTEMBER_STATE_ARM = {
    predicate: 'state_change',
    object: 'ends in September 2026',
    entityType: 'asset',
  };

  function input(
    f: { predicate: string; object: string; entityType?: string },
    opts: {
      recordOutcomeMetric?: boolean;
      userId?: string;
      entityId?: string;
      predicateAlias?: string;
    } = {},
  ) {
    return {
      companyId: 'co_x',
      entityId: opts.entityId ?? 'knowledge_entity:office-lease',
      predicate: f.predicate,
      object: f.object,
      confidence: 0.9,
      validFrom: new Date('2026-08-08T10:00:00Z'),
      source: {},
      precomputedEmbedding: [0.1, 0.2],
      ...(f.entityType !== undefined ? { entityType: f.entityType } : {}),
      ...(opts.recordOutcomeMetric !== undefined
        ? { recordOutcomeMetric: opts.recordOutcomeMetric }
        : {}),
      ...(opts.userId !== undefined ? { userId: opts.userId } : {}),
      ...(opts.predicateAlias !== undefined ? { predicateAlias: opts.predicateAlias } : {}),
    };
  }

  const resolveCalls = (queries: Array<{ sql: string; params: Record<string, unknown> }>) =>
    queries.filter((q) => q.sql.includes('fn::resolve_fact('));

  it('flag off: extracted-predicate passthrough, resolver call byte-identical', async () => {
    // Baseline pin: with the flag unset AND with it explicitly '0', the
    // fn::resolve_fact invocation binds the exact same parameters — the
    // default-off promise is byte-identical current behavior.
    const unset = make();
    const outUnset = await unset.svc.resolve(unset.db as never, input(DECEMBER_ARM));
    process.env.CONFLICT_SLOT_CANONICALIZATION = '0';
    const off = make();
    const outOff = await off.svc.resolve(off.db as never, input(DECEMBER_ARM));

    for (const run of [unset, off]) {
      const params = resolveCalls(run.queries)[0]!.params;
      expect(params.predicate).toBe('duration_limit');
      expect(params.semantics).toBe('append_only');
      // The caller's precomputed vector rides through untouched.
      expect(params.embedding).toEqual([0.1, 0.2]);
      expect(run.factEmbedding.embed).not.toHaveBeenCalled();
    }
    expect(outUnset.semantics).toBe('append_only');
    expect(outOff.semantics).toBe('append_only');
    expect(resolveCalls(off.queries)[0]!.params).toEqual(resolveCalls(unset.queries)[0]!.params);
  });

  it('flag on: the exact s07 shapes meet in ONE slot regardless of arrival order', async () => {
    process.env.CONFLICT_SLOT_CANONICALIZATION = '1';
    const { svc, db, queries, factEmbedding } = make();
    // December arm first (as on the stand: conv s07a precedes s07b).
    await svc.resolve(db as never, input(DECEMBER_ARM));
    await svc.resolve(db as never, input(SEPTEMBER_ARM));
    const calls = resolveCalls(queries);
    expect(calls).toHaveLength(2);
    // Both arms bind the canonical slot — the collision now exists.
    expect(calls[0]!.params.predicate).toBe('status');
    expect(calls[1]!.params.predicate).toBe('status');
    // The rerouted arm is re-embedded with the CANONICAL slot text (the
    // vector it would carry had the extractor chosen status), so the
    // bitemporal cosine gate compares like-with-like; the native arm
    // keeps its precomputed vector.
    expect(factEmbedding.embed).toHaveBeenCalledTimes(1);
    expect(factEmbedding.embed).toHaveBeenCalledWith('status: until December 2026');
    expect(calls[0]!.params.embedding).toEqual([0.5]);
    expect(calls[1]!.params.embedding).toEqual([0.1, 0.2]);
    // Objects ride into the fn VERBATIM — no value rewriting.
    expect(calls[0]!.params.object).toBe('until December 2026');
    expect(calls[1]!.params.object).toBe('ends in September 2026');
  });

  it('flag on alone: canonical slot takes its registry policy (single_active)', async () => {
    process.env.CONFLICT_SLOT_CANONICALIZATION = '1';
    const { svc, db, queries } = make();
    const out = await svc.resolve(db as never, input(DECEMBER_ARM));
    expect(resolveCalls(queries)[0]!.params.semantics).toBe('single_active');
    expect(out.semantics).toBe('single_active');
  });

  it('flag on + CONFLICT_MENTION_FACT_SLOT: composes into the bitemporal margin doctrine, COMPETING pair linked', async () => {
    process.env.CONFLICT_SLOT_CANONICALIZATION = '1';
    process.env.CONFLICT_MENTION_FACT_SLOT = '1';
    const { svc, db, queries } = make({
      factId: 'knowledge_fact:new',
      outcome: 'COMPETING',
      competingFactIds: ['knowledge_fact:prior'],
    });
    const out = await svc.resolve(db as never, input(DECEMBER_ARM));
    expect(resolveCalls(queries)[0]!.params.semantics).toBe('bitemporal');
    expect(out.semantics).toBe('bitemporal');
    expect(out.result.outcome).toBe('COMPETING');
    expect(out.result.competingFactIds).toEqual(['knowledge_fact:prior']);
  });

  it('flag on + bare unit duration ("30 days"): non-contradicting harvest bulk untouched', async () => {
    process.env.CONFLICT_SLOT_CANONICALIZATION = '1';
    const { svc, db, queries, factEmbedding } = make();
    const out = await svc.resolve(
      db as never,
      input({ predicate: 'duration_limit', object: '30 days' }),
    );
    const params = resolveCalls(queries)[0]!.params;
    expect(params.predicate).toBe('duration_limit');
    expect(params.semantics).toBe('append_only');
    expect(params.embedding).toEqual([0.1, 0.2]);
    expect(factEmbedding.embed).not.toHaveBeenCalled();
    expect(out.semantics).toBe('append_only');
  });

  it('flag on + predicates outside the declared table: untouched even with a calendar anchor', async () => {
    process.env.CONFLICT_SLOT_CANONICALIZATION = '1';
    const { svc, db, queries } = make();
    await svc.resolve(
      db as never,
      input({ predicate: 'preference', object: 'until December 2026' }),
    );
    await svc.resolve(
      db as never,
      input({ predicate: 'lease_end_date', object: 'ends in September 2026' }),
    );
    const calls = resolveCalls(queries);
    expect(calls[0]!.params.predicate).toBe('preference');
    expect(calls[1]!.params.predicate).toBe('lease_end_date');
  });

  it('flag on + direct path (recordOutcomeMetric): untouched — the caller stated its slot', async () => {
    process.env.CONFLICT_SLOT_CANONICALIZATION = '1';
    const { svc, db, queries } = make();
    const out = await svc.resolve(db as never, input(DECEMBER_ARM, { recordOutcomeMetric: true }));
    expect(resolveCalls(queries)[0]!.params.predicate).toBe('duration_limit');
    expect(out.semantics).toBe('append_only');
  });

  it('flag on + EDC predicateAlias present: 0082 owns the canon, never clobbered', async () => {
    process.env.CONFLICT_SLOT_CANONICALIZATION = '1';
    const { svc, db, queries } = make();
    await svc.resolve(db as never, input(DECEMBER_ARM, { predicateAlias: 'contract_term' }));
    const params = resolveCalls(queries)[0]!.params;
    expect(params.predicate).toBe('duration_limit');
    expect(params.predicate_alias).toBe('contract_term');
  });

  it('flag on: a state_change LOTTERY landing on the artifact reroutes into the same canonical slot', async () => {
    // Battery run stmtq22rtp: the SAME two corpus turns landed both
    // arms as (office lease, state_change) — append_only, no pair can
    // form. The fix: calendar-anchored ARTIFACT lifecycle claims land
    // in status regardless of which predicate the extraction chose.
    process.env.CONFLICT_SLOT_CANONICALIZATION = '1';
    const { svc, db, queries, factEmbedding } = make();
    await svc.resolve(db as never, input(DECEMBER_STATE_ARM));
    await svc.resolve(db as never, input(SEPTEMBER_STATE_ARM));
    const calls = resolveCalls(queries);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.params.predicate).toBe('status');
    expect(calls[1]!.params.predicate).toBe('status');
    // Both rerouted arms are re-embedded with the CANONICAL slot text.
    expect(factEmbedding.embed).toHaveBeenCalledTimes(2);
    expect(factEmbedding.embed).toHaveBeenNthCalledWith(1, 'status: runs until December 2026');
    expect(factEmbedding.embed).toHaveBeenNthCalledWith(2, 'status: ends in September 2026');
    // Objects ride into the fn VERBATIM — no value rewriting.
    expect(calls[0]!.params.object).toBe('runs until December 2026');
    expect(calls[1]!.params.object).toBe('ends in September 2026');
    // Canonical slot's registry policy applies (single_active).
    expect(calls[0]!.params.semantics).toBe('single_active');
  });

  it('flag on: a person-subject state_change with a calendar anchor stays in its slot (service seam)', async () => {
    process.env.CONFLICT_SLOT_CANONICALIZATION = '1';
    const { svc, db, queries, factEmbedding } = make();
    const out = await svc.resolve(
      db as never,
      input({
        predicate: 'state_change',
        object: 'cancelled the lease effective December 2026',
        entityType: 'customer',
      }),
    );
    const params = resolveCalls(queries)[0]!.params;
    expect(params.predicate).toBe('state_change');
    expect(params.semantics).toBe('append_only');
    expect(params.embedding).toEqual([0.1, 0.2]);
    expect(factEmbedding.embed).not.toHaveBeenCalled();
    expect(out.semantics).toBe('append_only');
  });

  it('flag off: a state_change landing is passthrough byte-identical, entityType inert', async () => {
    const unset = make();
    await unset.svc.resolve(unset.db as never, input(DECEMBER_STATE_ARM));
    process.env.CONFLICT_SLOT_CANONICALIZATION = '0';
    const off = make();
    await off.svc.resolve(off.db as never, input(DECEMBER_STATE_ARM));
    for (const run of [unset, off]) {
      const params = resolveCalls(run.queries)[0]!.params;
      expect(params.predicate).toBe('state_change');
      expect(params.semantics).toBe('append_only');
      expect(params.embedding).toEqual([0.1, 0.2]);
      expect(run.factEmbedding.embed).not.toHaveBeenCalled();
    }
    expect(resolveCalls(off.queries)[0]!.params).toEqual(resolveCalls(unset.queries)[0]!.params);
  });

  it('flag on + different entities: each binds its own $eid — no cross-entity collision', async () => {
    process.env.CONFLICT_SLOT_CANONICALIZATION = '1';
    const { svc, db, queries } = make();
    await svc.resolve(db as never, input(DECEMBER_ARM, { entityId: 'knowledge_entity:lease-a' }));
    await svc.resolve(db as never, input(SEPTEMBER_ARM, { entityId: 'knowledge_entity:lease-b' }));
    const calls = resolveCalls(queries);
    expect(calls[0]!.params.eid).toBe('lease-a');
    expect(calls[1]!.params.eid).toBe('lease-b');
  });

  describe('canonicalSlotFor — the pure decision', () => {
    it('flag off: undefined for every shape', () => {
      expect(canonicalSlotFor(DECEMBER_ARM, 'mention')).toBeUndefined();
      expect(canonicalSlotFor(SEPTEMBER_ARM, 'mention')).toBeUndefined();
    });

    it('flag on: reroutes exactly the calendar-anchored declared-table shapes, mention path only', () => {
      process.env.CONFLICT_SLOT_CANONICALIZATION = '1';
      // The s07 duration arm reroutes; the status arm is already native
      // (identity — not in the table, no rewrite needed).
      expect(canonicalSlotFor(DECEMBER_ARM, 'mention')).toBe('status');
      expect(canonicalSlotFor(SEPTEMBER_ARM, 'mention')).toBeUndefined();
      // Calendar-anchor variants.
      expect(
        canonicalSlotFor({ predicate: 'duration_limit', object: 'December 15, 2026' }, 'mention'),
      ).toBe('status');
      expect(
        canonicalSlotFor({ predicate: 'duration_limit', object: 'through 2026-09-30' }, 'mention'),
      ).toBe('status');
      // Conservative misses: unit durations, month without a year,
      // abbreviations — no reroute.
      expect(
        canonicalSlotFor({ predicate: 'duration_limit', object: '30 days' }, 'mention'),
      ).toBeUndefined();
      expect(
        canonicalSlotFor({ predicate: 'duration_limit', object: 'ends in September' }, 'mention'),
      ).toBeUndefined();
      expect(
        canonicalSlotFor({ predicate: 'duration_limit', object: 'until Dec 2026' }, 'mention'),
      ).toBeUndefined();
      // Direct path and alias-carrying facts never reroute.
      expect(canonicalSlotFor(DECEMBER_ARM, 'direct')).toBeUndefined();
      expect(
        canonicalSlotFor({ ...DECEMBER_ARM, predicateAlias: 'contract_term' }, 'mention'),
      ).toBeUndefined();
    });

    it('state_change entry: reroutes ONLY a calendar-anchored claim on a known non-person subject', () => {
      process.env.CONFLICT_SLOT_CANONICALIZATION = '1';
      // The stmtq22rtp lottery landings — artifact subject, anchored.
      expect(canonicalSlotFor(DECEMBER_STATE_ARM, 'mention')).toBe('status');
      expect(canonicalSlotFor(SEPTEMBER_STATE_ARM, 'mention')).toBe('status');
      // Every non-person extraction type qualifies; person types never do.
      for (const entityType of ['asset', 'project', 'topic', 'location', 'other']) {
        expect(canonicalSlotFor({ ...DECEMBER_STATE_ARM, entityType }, 'mention')).toBe('status');
      }
      for (const entityType of ['customer', 'staff']) {
        expect(canonicalSlotFor({ ...DECEMBER_STATE_ARM, entityType }, 'mention')).toBeUndefined();
      }
      // UNKNOWN subject type misses conservatively (a caller that does
      // not thread it — e.g. the document commit path — never reroutes).
      expect(
        canonicalSlotFor(
          { predicate: 'state_change', object: 'runs until December 2026' },
          'mention',
        ),
      ).toBeUndefined();
      // Direct path stays untouched even for a qualifying shape.
      expect(canonicalSlotFor(DECEMBER_STATE_ARM, 'direct')).toBeUndefined();
      // duration_limit keeps its live-proven anchor-only gate: the
      // non-person guard is per-entry and does NOT spread to it.
      expect(canonicalSlotFor({ ...DECEMBER_ARM, entityType: 'customer' }, 'mention')).toBe(
        'status',
      );
    });

    it('state_change entry: the battery corpus transition spans never reroute (pinned verbatim)', () => {
      process.env.CONFLICT_SLOT_CANONICALIZATION = '1';
      // The EXACT state_change objects the harvest lanes produce from
      // the s02/s03/s10/s11 corpus turns (verb-phrase spans, verbatim
      // substrings of scenarios.ts). All bind to the PERSON holder
      // (bindStateHolder: person in sentence, else speaker), so the
      // non-person guard alone already excludes them; none carries a
      // full-month-plus-year or ISO anchor either — the corpus's ISO
      // dates live only in verb-less log-header sentences the lanes'
      // clause capture cannot cross into. Belt AND suspenders: assert
      // no reroute under the person type, and ALSO no anchor match even
      // if a lottery landing put the same span on a non-person entity.
      const corpusSpans = [
        'replaced my laptop today', // s02
        'joined the chess club today', // s03
        'quit the chess club today', // s03
        'rejoined the chess club today', // s03
        'Signed up for the standing desk trial this morning', // s10
        'Returned the standing desk by evening', // s10
        'Sold the Canon R6', // s11
      ];
      for (const object of corpusSpans) {
        expect(
          canonicalSlotFor(
            { predicate: 'state_change', object, entityType: 'customer' },
            'mention',
          ),
        ).toBeUndefined();
        expect(
          canonicalSlotFor({ predicate: 'state_change', object, entityType: 'asset' }, 'mention'),
        ).toBeUndefined();
      }
      // A person-subject claim WITH an anchor still never reroutes: a
      // person's own lifecycle history is timeline substrate.
      expect(
        canonicalSlotFor(
          {
            predicate: 'state_change',
            object: 'cancelled the gym membership until December 2026',
            entityType: 'customer',
          },
          'mention',
        ),
      ).toBeUndefined();
    });
  });
});
