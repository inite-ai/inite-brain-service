import {
  applyFactSuffixes,
  renderUpdateStory,
} from '../src/synthesize/update-story';
import { UpdateStoryService } from '../src/synthesize/update-story.service';
import { buildGeneratorUserMessage } from '../src/synthesize/generator-prompt';
import type { SurrealService } from '../src/db/surreal.service';
import type { PredicateRegistryService } from '../src/ai/predicate-registry.service';
import {
  resolveRetrievalProfile,
  resolveRetrievalProfileFor,
} from '../src/search/retrieval-profile';

/**
 * V10 §2 — update-story rendering. The v9lifecycle diagnosis: BEAM
 * knowledge_update golds ask for the update STORY (old + new value),
 * and the bitemporal closure hides the old one at asOf — so write-side
 * lifecycle made the row WORSE. The winner's prompt line now carries a
 * compact history suffix built from the reverse supersededBy links,
 * without re-including superseded rows in retrieval.
 */

describe('renderUpdateStory', () => {
  it('renders previously/earlier with day-granular until dates', () => {
    expect(
      renderUpdateStory([
        { object: 'works at Foo', validUntil: '2026-03-01T00:00:00Z' },
        { object: 'works at Bar', validUntil: '2026-01-15T09:30:00Z' },
      ]),
    ).toBe(
      ' [previously: works at Foo — until 2026-03-01; earlier: works at Bar — until 2026-01-15]',
    );
  });

  it('caps at three entries and tolerates missing dates', () => {
    const s = renderUpdateStory([
      { object: 'v3' },
      { object: 'v2' },
      { object: 'v1' },
      { object: 'v0' },
    ]);
    expect(s).toBe(' [previously: v3; earlier: v2; earlier: v1]');
  });

  it('empty history renders nothing', () => {
    expect(renderUpdateStory([])).toBe('');
  });

  it('caps runaway predecessor text', () => {
    const s = renderUpdateStory([{ object: 'x'.repeat(400) }]);
    expect(s.length).toBeLessThan(150);
    expect(s).toContain('…');
  });
});

describe('applyFactSuffixes', () => {
  const lines = [
    '[knowledge_fact:w1] Alex (person) — work: works at Baz (as of 2026-03-01)',
    '[knowledge_fact:o1] Alex (person) — preferences: likes tea (as of 2026-01-01)',
  ];

  it('appends the suffix to matching lines only', () => {
    const out = applyFactSuffixes(lines, [
      new Map([
        ['knowledge_fact:w1', ' [previously: works at Foo — until 2026-03-01]'],
      ]),
    ]);
    expect(out[0]).toBe(
      lines[0] + ' [previously: works at Foo — until 2026-03-01]',
    );
    expect(out[1]).toBe(lines[1]);
  });

  it('stacks maps in order on the same line (stories then quotes)', () => {
    const out = applyFactSuffixes(lines, [
      new Map([['knowledge_fact:w1', ' [previously: works at Foo]']]),
      new Map([['knowledge_fact:w1', ' [source 2026-02-01 Alex: "joined Baz"]']]),
    ]);
    expect(out[0]).toBe(
      lines[0] +
        ' [previously: works at Foo]' +
        ' [source 2026-02-01 Alex: "joined Baz"]',
    );
  });

  it('empty and absent maps pass lines through byte-identical', () => {
    expect(applyFactSuffixes(lines, [new Map(), undefined])).toEqual(lines);
  });
});

describe('UpdateStoryService', () => {
  function makeService(
    byWinner: Record<string, Array<Record<string, unknown>>>,
    capture?: string[],
    registry?: PredicateRegistryService,
  ): UpdateStoryService {
    const surreal = {
      withCompany: async (
        _c: string,
        fn: (db: unknown) => Promise<unknown>,
      ) =>
        fn({
          query: async (sql: string, params: { winners: string[] }) => {
            capture?.push(sql);
            const rows = params.winners.flatMap((w) => byWinner[w] ?? []);
            return [null, rows];
          },
        }),
    } as unknown as SurrealService;
    return new UpdateStoryService(surreal, registry);
  }

  it('walks the reverse chain and renders most-recent-first', async () => {
    const svc = makeService({
      'knowledge_fact:w1': [
        {
          id: 'knowledge_fact:l1',
          supersededBy: 'knowledge_fact:w1',
          object: 'works at Foo',
          validUntil: '2026-03-01T00:00:00Z',
        },
      ],
      'knowledge_fact:l1': [
        {
          id: 'knowledge_fact:l0',
          supersededBy: 'knowledge_fact:l1',
          object: 'works at Bar',
          validUntil: '2026-01-15T00:00:00Z',
        },
      ],
    });
    const out = await svc.previousStories({
      companyId: 'c1',
      factIds: ['knowledge_fact:w1', 'knowledge_fact:noHistory'],
      callerScopes: [],
    });
    expect(out.get('knowledge_fact:w1')).toBe(
      ' [previously: works at Foo — until 2026-03-01; earlier: works at Bar — until 2026-01-15]',
    );
    expect(out.has('knowledge_fact:noHistory')).toBe(false);
  });

  it('drops history rows whose predicate requires a scope the caller lacks', async () => {
    // Audit 2026-08-13 P0: a superseded ancestor may carry a different
    // predicate than the policy-filtered winner (slot arbitration is
    // cosine-keyed), so the history line runs its own row-policy check.
    const registry = {
      rowPolicyLookup:
        async () => (p: string) =>
          p === 'internal_only'
            ? { requiresScope: 'sec:internal', piiClass: 'none' }
            : { piiClass: 'none' },
    } as unknown as PredicateRegistryService;
    const byWinner = {
      'knowledge_fact:w1': [
        {
          id: 'knowledge_fact:l1',
          predicate: 'status_update',
          supersededBy: 'knowledge_fact:w1',
          object: 'works at Foo',
          validUntil: '2026-03-01T00:00:00Z',
        },
        {
          id: 'knowledge_fact:l2',
          predicate: 'internal_only',
          supersededBy: 'knowledge_fact:w1',
          object: 'secret prior value',
          validUntil: '2026-02-01T00:00:00Z',
        },
      ],
    };
    const without = await makeService(byWinner, undefined, registry)
      .previousStories({
        companyId: 'c1',
        factIds: ['knowledge_fact:w1'],
        callerScopes: [],
      });
    expect(without.get('knowledge_fact:w1')).toBe(
      ' [previously: works at Foo — until 2026-03-01]',
    );
    const withScope = await makeService(byWinner, undefined, registry)
      .previousStories({
        companyId: 'c1',
        factIds: ['knowledge_fact:w1'],
        callerScopes: ['sec:internal'],
      });
    expect(withScope.get('knowledge_fact:w1')).toBe(
      ' [previously: works at Foo — until 2026-03-01; earlier: secret prior value — until 2026-02-01]',
    );
  });

  it('applies the superseded-only filter and the PII/user gates', async () => {
    const capture: string[] = [];
    const svc = makeService({}, capture);
    await svc.previousStories({
      companyId: 'c1',
      factIds: ['knowledge_fact:w1'],
      callerScopes: [],
    });
    expect(capture[0]).toContain("status = 'superseded'");
    expect(capture[0]).toContain('retractedAt IS NONE');
    expect(capture[0]).toContain('piiClass IS NONE');
    expect(capture[0]).toContain('userId IS NONE');
  });

  it('degrades to an empty map on failure', async () => {
    const surreal = {
      withCompany: async () => {
        throw new Error('db down');
      },
    } as unknown as SurrealService;
    const svc = new UpdateStoryService(surreal);
    await expect(
      svc.previousStories({
        companyId: 'c1',
        factIds: ['knowledge_fact:w1'],
        callerScopes: [],
      }),
    ).resolves.toEqual(new Map());
  });

  it('no evidence facts → no query', async () => {
    const capture: string[] = [];
    const svc = makeService({}, capture);
    const out = await svc.previousStories({
      companyId: 'c1',
      factIds: [],
      callerScopes: [],
    });
    expect(out.size).toBe(0);
    expect(capture).toEqual([]);
  });
});

describe('date-arbitrated conflict frame (V10 §2b)', () => {
  const base = {
    query: 'What is the average response time of the dashboard API?',
    factLines: [
      '[knowledge_fact:a] Alex (person) — work: response ~300ms (as of 2024-04-05)',
      '[knowledge_fact:b] Alex (person) — work: response ~250ms (as of 2024-04-25)',
    ],
    answerLang: null,
    conflicts: [
      { factIds: ['knowledge_fact:a', 'knowledge_fact:b'], label: 'work' },
    ],
  };

  it('on — pair-classifying frame: denial hedge + value commit-latest', () => {
    const msg = buildGeneratorUserMessage({
      ...base,
      dateArbitratedConflicts: true,
    });
    expect(msg).toContain('DENIAL conflict');
    expect(msg).toContain("contradictory information");
    expect(msg).toContain('VALUE update');
    expect(msg).toContain('previously');
    expect(msg).not.toContain('do NOT silently pick a side');
  });

  it('off — byte-identical blanket hedge frame', () => {
    const msg = buildGeneratorUserMessage(base);
    expect(msg).toContain('do NOT silently pick a side');
    expect(msg).not.toContain('DENIAL conflict');
  });

  it('equal/missing-date ambiguity path stays in the frame text', () => {
    const msg = buildGeneratorUserMessage({
      ...base,
      dateArbitratedConflicts: true,
    });
    expect(msg).toContain('dates are equal or');
    expect(msg).toContain('ask which one');
  });
});

describe('RETRIEVAL_UPDATE_STORY profile point', () => {
  it('defaults off; env enables; overlays per tenant', () => {
    expect(
      resolveRetrievalProfile({} as NodeJS.ProcessEnv).updateStoryRendering,
    ).toBe(false);
    expect(
      resolveRetrievalProfile({
        RETRIEVAL_UPDATE_STORY: '1',
      } as NodeJS.ProcessEnv).updateStoryRendering,
    ).toBe(true);
    const env = {
      RETRIEVAL_PROFILE_OVERRIDES: JSON.stringify({
        beamco: { updateStoryRendering: true },
      }),
    } as NodeJS.ProcessEnv;
    expect(
      resolveRetrievalProfileFor('beamco', env).updateStoryRendering,
    ).toBe(true);
    expect(
      resolveRetrievalProfileFor('other', env).updateStoryRendering,
    ).toBe(false);
  });
});
