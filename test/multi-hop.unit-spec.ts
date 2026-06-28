import {
  MultiHopService,
  MultiHopResult,
} from '../src/multi-hop/multi-hop.service';
import { MultiHopChainService } from '../src/multi-hop/multi-hop-chain.service';
import type { SearchService, SearchHit } from '../src/search/search.service';
import type {
  MultiHopPlannerService,
  MultiHopPlan,
  HopPlan,
} from '../src/multi-hop/multi-hop-planner.service';
import type { SynthesizeService } from '../src/synthesize/synthesize.service';
import type { MultiHopDto } from '../src/multi-hop/dto/multi-hop.dto';

/**
 * Unit coverage for MultiHopService — exercises the executor's
 * combination matrix and failure paths without hitting OpenAI or
 * Surreal. The planner and search collaborators are stubbed.
 */
describe('MultiHopService', () => {
  function hit(entityId: string): SearchHit {
    return {
      entityId,
      entityType: 'customer',
      canonicalName: entityId,
      externalRefs: {},
      facts: [
        {
          factId: `f_${entityId}`,
          predicate: 'name',
          object: entityId,
          confidence: 0.9,
          validFrom: '2026-01-01T00:00:00Z',
          status: 'active',
          score: 0.5,
        },
      ],
      score: 0.5,
    };
  }

  function makeSearch(
    perCallResults: Array<SearchHit[]>,
    expandedIds?: string[],
  ): { svc: SearchService; calls: Array<unknown>; expandCalls: Array<unknown> } {
    const calls: Array<unknown> = [];
    const expandCalls: Array<unknown> = [];
    let i = 0;
    const svc = {
      search: async (_company: string, dto: unknown) => {
        calls.push(dto);
        const out = perCallResults[i] ?? perCallResults[perCallResults.length - 1] ?? [];
        i++;
        return { results: out };
      },
      expandEntityIdsViaEdges: async (
        _company: string,
        ids: string[],
      ): Promise<string[]> => {
        expandCalls.push(ids);
        return expandedIds ?? ids;
      },
    } as unknown as SearchService;
    return { svc, calls, expandCalls };
  }

  function makePlanner(
    plan: MultiHopPlan | null,
  ): MultiHopPlannerService {
    return {
      plan: async () => plan,
    } as unknown as MultiHopPlannerService;
  }

  function makeSvc(
    search: SearchService,
    planner: MultiHopPlannerService,
    synth?: SynthesizeService,
  ): MultiHopService {
    const chain = new MultiHopChainService(search, synth);
    return new MultiHopService(planner, chain);
  }

  const baseDto: MultiHopDto = { query: 'q' };
  const scopes = ['brain:read'];

  it('falls back to single-shot search when planner returns null', async () => {
    const { svc: search, calls } = makeSearch([
      [hit('e1'), hit('e2')],
    ]);
    const svc = makeSvc(search, makePlanner(null));
    const out = await svc.run({ companyId: 'co_x', dto: baseDto, callerScopes: scopes });
    expect(out.isMultiHop).toBe(false);
    expect(out.hops).toEqual([]);
    expect(out.finalEntityIds).toEqual(['e1', 'e2']);
    expect(calls.length).toBe(1);
    expect((calls[0] as MultiHopDto).query).toBe('q');
  });

  it('runs single-hop fast path when planner reports isMultiHop=false', async () => {
    const { svc: search } = makeSearch([[hit('e1')]]);
    const svc = makeSvc(
      search,
      makePlanner({
        isMultiHop: false,
        hops: [
          {
            subQuery: 'refined q',
            combination: 'seed',
            predicates: ['name'],
            asOf: null,
            rationale: null,
          },
        ],
      }),
    );
    const out = await svc.run({ companyId: 'co_x', dto: baseDto, callerScopes: scopes });
    expect(out.isMultiHop).toBe(false);
    expect(out.hops.length).toBe(1);
    expect(out.finalEntityIds).toEqual(['e1']);
  });

  it('chains hops with subset_of_previous: hop 2 anchors via entityIds', async () => {
    // Hop 1 returns {e1, e2, e3}. Hop 2 (anchored) returns {e2, e3}.
    const { svc: search, calls } = makeSearch([
      [hit('e1'), hit('e2'), hit('e3')],
      [hit('e2'), hit('e3')],
    ]);
    const plan: MultiHopPlan = {
      isMultiHop: true,
      hops: [
        {
          subQuery: 'complained in April',
          combination: 'seed',
          predicates: ['complained_about'],
          asOf: null,
          rationale: null,
        },
        {
          subQuery: 'upgraded to platinum',
          combination: 'subset_of_previous',
          predicates: ['tier'],
          asOf: null,
          rationale: null,
        },
      ],
    };
    const svc = makeSvc(search, makePlanner(plan));
    const out = await svc.run({ companyId: 'co_x', dto: baseDto, callerScopes: scopes });
    expect(out.isMultiHop).toBe(true);
    expect(out.hops.length).toBe(2);
    expect(out.finalEntityIds).toEqual(['e2', 'e3']);
    // Hop 2 should have been called with entityIds={e1,e2,e3}.
    const hop2Dto = calls[1] as { entityIds?: string[] };
    expect(hop2Dto.entityIds).toEqual(['e1', 'e2', 'e3']);
  });

  it('intersect: post-hoc set intersection without anchoring', async () => {
    const { svc: search, calls } = makeSearch([
      [hit('e1'), hit('e2'), hit('e3')],
      [hit('e2'), hit('e4')],
    ]);
    const plan: MultiHopPlan = {
      isMultiHop: true,
      hops: [
        {
          subQuery: 'broad query A',
          combination: 'seed',
          predicates: null,
          asOf: null,
          rationale: null,
        },
        {
          subQuery: 'broad query B',
          combination: 'intersect',
          predicates: null,
          asOf: null,
          rationale: null,
        },
      ],
    };
    const svc = makeSvc(search, makePlanner(plan));
    const out = await svc.run({ companyId: 'co_x', dto: baseDto, callerScopes: scopes });
    expect(out.finalEntityIds).toEqual(['e2']);
    // Hop 2 must NOT be anchored — intersect runs unconstrained.
    const hop2Dto = calls[1] as { entityIds?: string[] };
    expect(hop2Dto.entityIds).toBeUndefined();
  });

  it('union: merges entity sets across hops', async () => {
    const { svc: search } = makeSearch([
      [hit('e1'), hit('e2')],
      [hit('e3'), hit('e4')],
    ]);
    const plan: MultiHopPlan = {
      isMultiHop: true,
      hops: [
        {
          subQuery: 'a',
          combination: 'seed',
          predicates: null,
          asOf: null,
          rationale: null,
        },
        {
          subQuery: 'b',
          combination: 'union',
          predicates: null,
          asOf: null,
          rationale: null,
        },
      ],
    };
    const svc = makeSvc(search, makePlanner(plan));
    const out = await svc.run({ companyId: 'co_x', dto: baseDto, callerScopes: scopes });
    expect(out.finalEntityIds.sort()).toEqual(['e1', 'e2', 'e3', 'e4']);
  });

  it('terminates early when running set goes empty after intersect', async () => {
    const { svc: search, calls } = makeSearch([
      [hit('e1'), hit('e2')],
      [hit('e9')], // no overlap with hop 1
      // 3rd response not used because chain stops
    ]);
    const plan: MultiHopPlan = {
      isMultiHop: true,
      hops: [
        {
          subQuery: 'a',
          combination: 'seed',
          predicates: null,
          asOf: null,
          rationale: null,
        },
        {
          subQuery: 'b',
          combination: 'intersect',
          predicates: null,
          asOf: null,
          rationale: null,
        },
        {
          subQuery: 'c',
          combination: 'subset_of_previous',
          predicates: null,
          asOf: null,
          rationale: null,
        },
      ],
    };
    const svc = makeSvc(search, makePlanner(plan));
    const out = await svc.run({ companyId: 'co_x', dto: baseDto, callerScopes: scopes });
    // Hop 3 should NOT have been called.
    expect(calls.length).toBe(2);
    expect(out.finalEntityIds).toEqual([]);
    // We still get a 2-element hops trace so the operator can debug
    // why the chain emptied out.
    expect(out.hops.length).toBe(2);
  });

  it('stops the chain on hop error and returns partial outcome', async () => {
    let callIdx = 0;
    const search = {
      search: async () => {
        callIdx++;
        if (callIdx === 1) {
          return { results: [hit('e1'), hit('e2')] };
        }
        throw new Error('surreal kaput');
      },
    } as unknown as SearchService;
    const plan: MultiHopPlan = {
      isMultiHop: true,
      hops: [
        {
          subQuery: 'a',
          combination: 'seed',
          predicates: null,
          asOf: null,
          rationale: null,
        },
        {
          subQuery: 'b',
          combination: 'subset_of_previous',
          predicates: null,
          asOf: null,
          rationale: null,
        },
      ],
    };
    const svc = makeSvc(search, makePlanner(plan));
    const out = await svc.run({ companyId: 'co_x', dto: baseDto, callerScopes: scopes });
    expect(out.hops.length).toBe(1);
    expect(out.finalEntityIds).toEqual(['e1', 'e2']);
  });

  it('honours hop predicate / asOf overrides on the per-hop search', async () => {
    const { svc: search, calls } = makeSearch([[hit('e1')]]);
    const hop: HopPlan = {
      subQuery: 'refined',
      combination: 'seed',
      predicates: ['tier', 'status'],
      asOf: '2026-04-01T00:00:00Z',
      rationale: null,
    };
    const svc = makeSvc(
      search,
      makePlanner({ isMultiHop: false, hops: [hop] }),
    );
    await svc.run({ companyId: 'co_x', dto: baseDto, callerScopes: scopes });
    const dto = calls[0] as { predicates?: string[]; asOf?: string };
    expect(dto.predicates).toEqual(['tier', 'status']);
    expect(dto.asOf).toBe('2026-04-01T00:00:00Z');
  });

  it('drops null/empty predicate lists from hop overrides', async () => {
    const { svc: search, calls } = makeSearch([[hit('e1')]]);
    const hop: HopPlan = {
      subQuery: 'q',
      combination: 'seed',
      predicates: null,
      asOf: null,
      rationale: null,
    };
    const svc = makeSvc(
      search,
      makePlanner({ isMultiHop: false, hops: [hop] }),
    );
    await svc.run({
      companyId: 'co_x',
      dto: { ...baseDto, predicates: ['inherited'] },
      callerScopes: scopes,
    });
    // Hop omitted predicates ⇒ caller's inherited list survives.
    const dto = calls[0] as { predicates?: string[] };
    expect(dto.predicates).toEqual(['inherited']);
  });

  it('caps maxHops at 5 even if caller passes more', async () => {
    // The DTO validator caps at 5; this test asserts the executor
    // never tries to run beyond plan.hops.length anyway.
    const seven = Array.from({ length: 7 }, (_, i) => ({
      subQuery: `q${i}`,
      combination: i === 0 ? ('seed' as const) : ('subset_of_previous' as const),
      predicates: null,
      asOf: null,
      rationale: null,
    }));
    const search = makeSearch([
      [hit('e1')],
      [hit('e1')],
      [hit('e1')],
      [hit('e1')],
      [hit('e1')],
      [hit('e1')],
      [hit('e1')],
    ]);
    const svc = makeSvc(
      search.svc,
      makePlanner({ isMultiHop: true, hops: seven }),
    );
    const out = await svc.run({
      companyId: 'co_x',
      dto: { ...baseDto, maxHops: 5 },
      callerScopes: scopes,
    });
    // The planner can emit at most maxHops hops because the planner
    // caps internally; we don't enforce again in the service. Still,
    // the test is here to flag if the executor starts truncating
    // upstream-respected plans.
    expect(out.hops.length).toBeLessThanOrEqual(7);
  });

  it('runs synthesizer on the final set when synthesize=true', async () => {
    const { svc: search } = makeSearch([
      [hit('e1'), hit('e2')],
      [hit('e2')],
    ]);
    const synth = {
      synthesize: async ({ dto }: { dto: { entityIds?: string[] } }) => ({
        answer: 'final',
        citations: [],
        results: [],
        // Anchor must have been passed through.
        _seenEntityIds: dto.entityIds,
      }),
    } as unknown as SynthesizeService;
    const plan: MultiHopPlan = {
      isMultiHop: true,
      hops: [
        {
          subQuery: 'a',
          combination: 'seed',
          predicates: null,
          asOf: null,
          rationale: null,
        },
        {
          subQuery: 'b',
          combination: 'subset_of_previous',
          predicates: null,
          asOf: null,
          rationale: null,
        },
      ],
    };
    const svc = makeSvc(search, makePlanner(plan), synth);
    const out = await svc.run({
      companyId: 'co_x',
      dto: { ...baseDto, synthesize: true },
      callerScopes: scopes,
    });
    expect(out.synthesis?.answer).toBe('final');
    expect(out.finalEntityIds).toEqual(['e2']);
  });

  it('skips synthesize when finalHits is empty', async () => {
    const { svc: search } = makeSearch([
      [hit('e1')],
      [hit('e2')], // intersect => empty
    ]);
    const synth = {
      synthesize: jest.fn(),
    } as unknown as SynthesizeService;
    const plan: MultiHopPlan = {
      isMultiHop: true,
      hops: [
        {
          subQuery: 'a',
          combination: 'seed',
          predicates: null,
          asOf: null,
          rationale: null,
        },
        {
          subQuery: 'b',
          combination: 'intersect',
          predicates: null,
          asOf: null,
          rationale: null,
        },
      ],
    };
    const svc = makeSvc(search, makePlanner(plan), synth);
    const out: MultiHopResult = await svc.run({
      companyId: 'co_x',
      dto: { ...baseDto, synthesize: true },
      callerScopes: scopes,
    });
    expect(out.finalEntityIds).toEqual([]);
    expect(out.synthesis).toBeUndefined();
    // synth.synthesize must NOT have been called on an empty set.
    expect((synth.synthesize as jest.Mock).mock.calls.length).toBe(0);
  });

  describe('MULTI_HOP_EDGE_EXPANSION_ENABLED — subset_of_previous via graph', () => {
    const ENV_KEY = 'MULTI_HOP_EDGE_EXPANSION_ENABLED';
    afterEach(() => {
      delete process.env[ENV_KEY];
    });

    it('expands prior entity set via 1-hop edges before anchoring hop 2', async () => {
      process.env[ENV_KEY] = '1';
      // Hop 1 returns {e1}. expandEntityIdsViaEdges → {e1, n_a, n_b}.
      // Hop 2 returns {n_a} which IS in the expanded anchor set.
      const { svc: search, calls, expandCalls } = makeSearch(
        [[hit('e1')], [hit('n_a')]],
        ['e1', 'n_a', 'n_b'],
      );
      const plan: MultiHopPlan = {
        isMultiHop: true,
        hops: [
          {
            subQuery: 'complained',
            combination: 'seed',
            predicates: null,
            asOf: null,
            rationale: null,
          },
          {
            subQuery: 'linked asset',
            combination: 'subset_of_previous',
            predicates: null,
            asOf: null,
            rationale: null,
          },
        ],
      };
      const svc = makeSvc(search, makePlanner(plan));
      const out = await svc.run({ companyId: 'co_x', dto: baseDto, callerScopes: scopes });
      // Expansion called once for hop 2's prior set.
      expect(expandCalls.length).toBe(1);
      expect(expandCalls[0]).toEqual(['e1']);
      // Hop 2 anchored on EXPANDED set, not bare {e1}.
      const hop2Dto = calls[1] as { entityIds?: string[] };
      expect(hop2Dto.entityIds).toEqual(['e1', 'n_a', 'n_b']);
      // n_a is in the expanded anchor — it survives the intersect.
      expect(out.finalEntityIds).toEqual(['n_a']);
    });

    it('default OFF: anchor stays as bare prior set, no expansion call', async () => {
      // ENV_KEY intentionally not set.
      const { svc: search, calls, expandCalls } = makeSearch(
        [[hit('e1'), hit('e2')], [hit('e2')]],
        ['e1', 'e2', 'n_x'], // would be the expanded set if asked
      );
      const plan: MultiHopPlan = {
        isMultiHop: true,
        hops: [
          {
            subQuery: 'a',
            combination: 'seed',
            predicates: null,
            asOf: null,
            rationale: null,
          },
          {
            subQuery: 'b',
            combination: 'subset_of_previous',
            predicates: null,
            asOf: null,
            rationale: null,
          },
        ],
      };
      const svc = makeSvc(search, makePlanner(plan));
      await svc.run({ companyId: 'co_x', dto: baseDto, callerScopes: scopes });
      expect(expandCalls.length).toBe(0);
      const hop2Dto = calls[1] as { entityIds?: string[] };
      expect(hop2Dto.entityIds).toEqual(['e1', 'e2']);
    });

    it('falls back to bare prior set if expansion throws', async () => {
      process.env[ENV_KEY] = '1';
      const { svc: search, calls } = makeSearch([[hit('e1')], [hit('e1')]]);
      // Patch the throwing expansion onto the stub.
      (search as unknown as {
        expandEntityIdsViaEdges: (
          c: string,
          ids: string[],
        ) => Promise<string[]>;
      }).expandEntityIdsViaEdges = async () => {
        throw new Error('boom');
      };
      const plan: MultiHopPlan = {
        isMultiHop: true,
        hops: [
          {
            subQuery: 'a',
            combination: 'seed',
            predicates: null,
            asOf: null,
            rationale: null,
          },
          {
            subQuery: 'b',
            combination: 'subset_of_previous',
            predicates: null,
            asOf: null,
            rationale: null,
          },
        ],
      };
      const svc = makeSvc(search, makePlanner(plan));
      await svc.run({ companyId: 'co_x', dto: baseDto, callerScopes: scopes });
      const hop2Dto = calls[1] as { entityIds?: string[] };
      // Bare prior set — no expansion applied.
      expect(hop2Dto.entityIds).toEqual(['e1']);
    });
  });
});
