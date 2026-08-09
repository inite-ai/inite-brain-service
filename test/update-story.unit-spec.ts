import {
  appendUpdateStories,
  renderUpdateStory,
} from '../src/synthesize/update-story';
import { UpdateStoryService } from '../src/synthesize/update-story.service';
import type { SurrealService } from '../src/db/surreal.service';
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

describe('appendUpdateStories', () => {
  const lines = [
    '[knowledge_fact:w1] Alex (person) — work: works at Baz (as of 2026-03-01)',
    '[knowledge_fact:o1] Alex (person) — preferences: likes tea (as of 2026-01-01)',
  ];

  it('appends the suffix to matching lines only', () => {
    const out = appendUpdateStories(
      lines,
      new Map([
        ['knowledge_fact:w1', ' [previously: works at Foo — until 2026-03-01]'],
      ]),
    );
    expect(out[0]).toBe(
      lines[0] + ' [previously: works at Foo — until 2026-03-01]',
    );
    expect(out[1]).toBe(lines[1]);
  });

  it('empty map passes lines through byte-identical', () => {
    expect(appendUpdateStories(lines, new Map())).toEqual(lines);
  });
});

describe('UpdateStoryService', () => {
  function makeService(
    byWinner: Record<string, Array<Record<string, unknown>>>,
    capture?: string[],
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
    return new UpdateStoryService(surreal);
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
