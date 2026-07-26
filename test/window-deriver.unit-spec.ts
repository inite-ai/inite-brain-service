import { ConfigService } from '@nestjs/config';
import {
  WindowDeriverService,
  segmentSessions,
  WINDOW_DERIVER_VERSION,
  type EpisodeRow,
} from '../src/admin/window-deriver.service';
import { buildBaseWhere } from '../src/search/internals/where-builder';
import type { SurrealService } from '../src/db/surreal.service';
import type { FactEmbeddingService } from '../src/ingest/fact-embedding.service';

describe('segmentSessions', () => {
  const ep = (id: string, iso: string): EpisodeRow => ({
    id,
    speaker: 'A',
    text: id,
    occurredAt: iso,
  });

  it('splits on the inactivity gap and keeps order', () => {
    const sessions = segmentSessions(
      [
        ep('a', '2023-05-01T10:00:00Z'),
        ep('b', '2023-05-01T10:05:00Z'),
        ep('c', '2023-05-02T09:00:00Z'),
      ],
      60 * 60 * 1000,
    );
    expect(sessions.map((s) => s.map((e) => e.id))).toEqual([
      ['a', 'b'],
      ['c'],
    ]);
  });

  it('one session when gaps stay under the threshold', () => {
    const sessions = segmentSessions(
      [ep('a', '2023-05-01T10:00:00Z'), ep('b', '2023-05-01T10:59:00Z')],
      60 * 60 * 1000,
    );
    expect(sessions).toHaveLength(1);
  });

  it('empty input → no sessions', () => {
    expect(segmentSessions([])).toEqual([]);
  });
});

describe('buildBaseWhere derived-version namespace', () => {
  const saved = process.env.RETRIEVAL_DERIVED_VERSION;
  afterEach(() => {
    if (saved === undefined) delete process.env.RETRIEVAL_DERIVED_VERSION;
    else process.env.RETRIEVAL_DERIVED_VERSION = saved;
  });

  it('defaults to the legacy namespace', () => {
    delete process.env.RETRIEVAL_DERIVED_VERSION;
    const { sql } = buildBaseWhere({
      dto: {} as never,
      asOf: null,
      includeRetracted: false,
      includeContested: false,
    });
    expect(sql).toContain('derivedVersion IS NONE');
  });

  it('pins the versioned namespace when set', () => {
    process.env.RETRIEVAL_DERIVED_VERSION = 'wd-v2';
    const { sql, params } = buildBaseWhere({
      dto: {} as never,
      asOf: null,
      includeRetracted: false,
      includeContested: false,
    });
    expect(sql).toContain('derivedVersion = $derivedVersion');
    expect(params.derivedVersion).toBe('wd-v2');
    expect(sql).not.toContain('derivedVersion IS NONE');
  });
});

describe('WindowDeriverService (P3 v1 batch)', () => {
  function makeSvc(llm: unknown): {
    svc: WindowDeriverService;
    queries: Array<{ sql: string; params?: Record<string, unknown> }>;
  } {
    const queries: Array<{ sql: string; params?: Record<string, unknown> }> = [];
    const db = {
      query: async (sql: string, params?: Record<string, unknown>) => {
        queries.push({ sql, params });
        if (sql.includes('GROUP BY conversationId'))
          return [[{ conversationId: 'conv-1', n: 3 }]];
        if (sql.includes('FROM episode'))
          return [
            [
              { id: 'episode:e0', speaker: 'Melanie', text: 'Do you have pets?', occurredAt: '2023-05-01T10:00:00Z' },
              { id: 'episode:e1', speaker: 'Caroline', text: 'Luna and Oliver! They are so sweet', occurredAt: '2023-05-01T10:01:00Z' },
            ],
          ];
        if (sql.includes('FROM knowledge_entity'))
          return [[{ id: 'knowledge_entity:car' }]];
        return [[]];
      },
    };
    const surreal = {
      withCompany: async (_c: string, fn: (d: unknown) => Promise<unknown>) =>
        fn(db),
    } as unknown as SurrealService;
    const config = {
      get: (k: string, d?: string) => (k === 'OPENAI_API_KEY' ? 'sk' : d),
      getOrThrow: () => 'sk',
    } as unknown as ConfigService;
    const embedding = {
      embedMany: async (t: string[]) => t.map(() => [1, 0]),
    } as unknown as FactEmbeddingService;
    const svc = new WindowDeriverService(surreal, config, embedding);
    (svc as unknown as { openai: unknown }).openai = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{ message: { content: JSON.stringify(llm) } }],
          }),
        },
      },
    };
    return { svc, queries };
  }

  it('writes versioned propositions with resolved subject and provenance', async () => {
    const { svc, queries } = makeSvc({
      propositions: [
        {
          subject: 'Caroline',
          aspect: 'pets',
          proposition: "Caroline's cats are named Luna and Oliver.",
          occurred_on: null,
          turns: [1],
        },
        {
          subject: 'Nobody',
          aspect: 'other',
          proposition: 'third-party subject reattaches to the grounding speaker',
          occurred_on: null,
          turns: [0],
        },
      ],
    });
    const res = await svc.run('co_x');
    // The third-party proposition is counted unresolved but NOT dropped —
    // it re-attaches to the speaker of its grounding turn.
    expect(res).toMatchObject({
      conversations: 1,
      sessions: 1,
      propositions: 2,
      unresolvedSubjects: 1,
    });
    const del = queries.find((q) => q.sql.includes('DELETE knowledge_fact'));
    expect(del?.params?.version).toBe(WINDOW_DERIVER_VERSION);
    const create = queries.find((q) => q.sql.includes('CREATE knowledge_fact'));
    expect(create?.params?.predicate).toBe('pets');
    expect(create?.params?.version).toBe(WINDOW_DERIVER_VERSION);
    expect(create?.params?.object).toContain('Luna and Oliver');
    const source = create?.params?.source as Record<string, unknown>;
    expect(source.recorder).toBe(WINDOW_DERIVER_VERSION);
    expect(source.episodeIds).toEqual(['episode:e1']);
  });

  it('uses occurred_on as validFrom when parseable', async () => {
    const { svc, queries } = makeSvc({
      propositions: [
        {
          subject: 'Caroline',
          aspect: 'events',
          proposition: 'Caroline attended a pride festival in 2022.',
          occurred_on: '2022-06-15',
          turns: [1],
        },
      ],
    });
    await svc.run('co_x');
    const create = queries.find((q) => q.sql.includes('CREATE knowledge_fact'));
    expect(create?.params?.validFrom).toEqual(
      new Date('2022-06-15T00:00:00.000Z'),
    );
  });

  it('impossible calendar occurred_on falls back to the session date', async () => {
    const { svc, queries } = makeSvc({
      propositions: [
        {
          subject: 'Caroline',
          aspect: 'events',
          proposition: 'Caroline attended a workshop.',
          occurred_on: '2023-02-30',
          turns: [1],
        },
      ],
    });
    const res = await svc.run('co_x');
    // The regex admits 2023-02-30 but it is not a real date — the guard
    // must fall back instead of poisoning the CREATE (used to skip the
    // whole conversation on conv-48).
    expect(res.propositions).toBe(1);
    const create = queries.find((q) => q.sql.includes('CREATE knowledge_fact'));
    expect(create?.params?.validFrom).toEqual(new Date('2023-05-01T10:00:00Z'));
  });

  it('conversationId filter derives only the requested conversation', async () => {
    const { svc, queries } = makeSvc({
      propositions: [
        {
          subject: 'Caroline',
          aspect: 'pets',
          proposition: 'p',
          occurred_on: null,
          turns: [1],
        },
      ],
    });
    const res = await svc.run('co_x', { conversationId: 'conv-other' });
    expect(res.conversations).toBe(0);
    expect(res.propositions).toBe(0);
    expect(
      queries.some((q) => q.sql.includes('DELETE knowledge_fact')),
    ).toBe(false);
  });

  it('records conversation failures without failing the run', async () => {
    const { svc } = makeSvc({ propositions: [] });
    (svc as unknown as { openai: unknown }).openai = {
      chat: {
        completions: {
          create: async () => {
            throw new Error('llm down');
          },
        },
      },
    };
    const res = await svc.run('co_x');
    expect(res.conversations).toBe(0);
    expect(res.skipped).toEqual([
      { conversationId: 'conv-1', reason: 'llm down' },
    ]);
  });
});
