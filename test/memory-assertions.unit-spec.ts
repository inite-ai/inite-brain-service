import type { HttpBrainClient as BrainClient } from './eval/http-brain-client';
import { MemoryAssertionsChecker } from './eval/runner/memory-assertions';
import type { Scenario } from '../src/eval/types';

/**
 * Unit coverage for MemoryAssertionsChecker — exercises the decision
 * logic against a stub BrainClient. The real-eval path runs against
 * a spawned brain in test:eval; this suite catches assertion-shape
 * regressions without paying the spawn cost.
 */
describe('MemoryAssertionsChecker', () => {
  function stubClient(
    searchResponses: Array<{
      results: Array<{
        entityId: string;
        canonicalName: string;
        externalRefs: Record<string, string>;
        facts: Array<{ object: string }>;
      }>;
    }>,
  ): BrainClient {
    let i = 0;
    return {
      search: async () => {
        const r = searchResponses[i] ??
          searchResponses[searchResponses.length - 1] ?? { results: [] };
        i++;
        return r;
      },
    } as unknown as BrainClient;
  }

  function scen(assertions: Scenario['memoryAssertions']): Scenario {
    return {
      id: 's',
      vertical: 'cross',
      description: '',
      setup: [],
      queries: [],
      ...(assertions !== undefined ? { memoryAssertions: assertions } : {}),
    };
  }

  it('no_search_match passes when expected ref is absent from results', async () => {
    const client = stubClient([
      {
        results: [
          {
            entityId: 'e1',
            canonicalName: 'Other',
            externalRefs: { other__id: 'id' },
            facts: [],
          },
        ],
      },
    ]);
    const out = await new MemoryAssertionsChecker(client).check(
      scen([
        {
          description: 'forgotten one is gone',
          kind: 'no_search_match',
          query: 'q',
          expectedRefAbsent: 'memlc.forgotten',
        },
      ]),
    );
    expect(out[0]!.passed).toBe(true);
  });

  it('no_search_match fails when expected ref still surfaces', async () => {
    const client = stubClient([
      {
        results: [
          {
            entityId: 'e1',
            canonicalName: 'Forgotten One',
            externalRefs: { memlc__forgotten: 'forgotten' },
            facts: [],
          },
        ],
      },
    ]);
    const out = await new MemoryAssertionsChecker(client).check(
      scen([
        {
          description: 'forgotten one is gone',
          kind: 'no_search_match',
          query: 'q',
          expectedRefAbsent: 'memlc.forgotten',
        },
      ]),
    );
    expect(out[0]!.passed).toBe(false);
    expect(out[0]!.detail).toContain('Forgotten One');
  });

  it('search_object_present passes when ref surfaces with the object substring', async () => {
    const client = stubClient([
      {
        results: [
          {
            entityId: 'e1',
            canonicalName: 'Maya',
            externalRefs: { memlc__maya: 'maya' },
            facts: [{ object: 'platinum' }],
          },
        ],
      },
    ]);
    const out = await new MemoryAssertionsChecker(client).check(
      scen([
        {
          description: 'platinum surfaces',
          kind: 'search_object_present',
          query: 'maya tier',
          expectedRefPresent: 'memlc.maya',
          objectSubstring: 'platinum',
        },
      ]),
    );
    expect(out[0]!.passed).toBe(true);
  });

  it('search_object_present fails when ref surfaces but substring missing', async () => {
    const client = stubClient([
      {
        results: [
          {
            entityId: 'e1',
            canonicalName: 'Maya',
            externalRefs: { memlc__maya: 'maya' },
            facts: [{ object: 'gold' }],
          },
        ],
      },
    ]);
    const out = await new MemoryAssertionsChecker(client).check(
      scen([
        {
          description: 'platinum surfaces',
          kind: 'search_object_present',
          query: 'q',
          expectedRefPresent: 'memlc.maya',
          objectSubstring: 'platinum',
        },
      ]),
    );
    expect(out[0]!.passed).toBe(false);
    expect(out[0]!.detail).toContain('platinum');
  });

  it('search_object_absent passes when ref is missing entirely (stronger than required)', async () => {
    const client = stubClient([{ results: [] }]);
    const out = await new MemoryAssertionsChecker(client).check(
      scen([
        {
          description: 'gold gone',
          kind: 'search_object_absent',
          query: 'q',
          expectedRefAbsent: 'memlc.maya',
          objectSubstring: 'gold',
        },
      ]),
    );
    expect(out[0]!.passed).toBe(true);
  });

  it('search_object_absent fails when ref surfaces with the (forbidden) substring', async () => {
    const client = stubClient([
      {
        results: [
          {
            entityId: 'e1',
            canonicalName: 'Maya',
            externalRefs: { memlc__maya: 'maya' },
            facts: [{ object: 'gold' }, { object: 'platinum' }],
          },
        ],
      },
    ]);
    const out = await new MemoryAssertionsChecker(client).check(
      scen([
        {
          description: 'gold gone',
          kind: 'search_object_absent',
          query: 'q',
          expectedRefAbsent: 'memlc.maya',
          objectSubstring: 'gold',
        },
      ]),
    );
    expect(out[0]!.passed).toBe(false);
    expect(out[0]!.detail).toContain('gold');
  });

  it('search_object_absent passes when ref surfaces but substring not in any fact', async () => {
    const client = stubClient([
      {
        results: [
          {
            entityId: 'e1',
            canonicalName: 'Maya',
            externalRefs: { memlc__maya: 'maya' },
            facts: [{ object: 'platinum' }],
          },
        ],
      },
    ]);
    const out = await new MemoryAssertionsChecker(client).check(
      scen([
        {
          description: 'gold gone',
          kind: 'search_object_absent',
          query: 'q',
          expectedRefAbsent: 'memlc.maya',
          objectSubstring: 'gold',
        },
      ]),
    );
    expect(out[0]!.passed).toBe(true);
  });

  it('handles assertion-level exceptions gracefully', async () => {
    const client = {
      search: async () => {
        throw new Error('surreal angry');
      },
    } as unknown as BrainClient;
    const out = await new MemoryAssertionsChecker(client).check(
      scen([
        {
          description: 'whatever',
          kind: 'no_search_match',
          query: 'q',
          expectedRefAbsent: 'memlc.x',
        },
      ]),
    );
    expect(out[0]!.passed).toBe(false);
    expect(out[0]!.detail).toContain('surreal angry');
  });

  it('returns empty list when scenario has no memory assertions', async () => {
    const client = stubClient([]);
    const out = await new MemoryAssertionsChecker(client).check(scen(undefined));
    expect(out).toEqual([]);
  });

  it('runs each assertion independently — failure on N does not short-circuit N+1', async () => {
    const client = stubClient([
      // first assertion (no_search_match) — ref still present (fail)
      {
        results: [
          {
            entityId: 'e1',
            canonicalName: 'Still Here',
            externalRefs: { memlc__a: 'a' },
            facts: [],
          },
        ],
      },
      // second assertion (no_search_match) — ref absent (pass)
      { results: [] },
    ]);
    const out = await new MemoryAssertionsChecker(client).check(
      scen([
        {
          description: 'first must vanish',
          kind: 'no_search_match',
          query: 'q1',
          expectedRefAbsent: 'memlc.a',
        },
        {
          description: 'second must vanish',
          kind: 'no_search_match',
          query: 'q2',
          expectedRefAbsent: 'memlc.b',
        },
      ]),
    );
    expect(out.length).toBe(2);
    expect(out[0]!.passed).toBe(false);
    expect(out[1]!.passed).toBe(true);
  });
});
