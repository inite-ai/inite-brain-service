import { ConfigService } from '@nestjs/config';
import { EpisodeReadStoreService } from '../src/episodes/episode-read-store.service';
import {
  WindowDeriverService,
  segmentSessions,
  buildDeriverSystem,
  DERIVER_ASSISTANT_SECTION,
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
    derived: Array<Record<string, unknown>>;
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
    const derived: Array<Record<string, unknown>> = [];
    const factResolver = {
      resolveDerivedBatch: async (
        _db: unknown,
        rows: Array<Record<string, unknown>>,
      ) => {
        derived.push(...rows);
        return rows.map(() => ({ outcome: 'INSERTED' }));
      },
    } as unknown as import('../src/ingest/fact-resolver.service').FactResolverService;
    const svc = new WindowDeriverService(
      surreal,
      config,
      embedding,
      new EpisodeReadStoreService(surreal),
      factResolver,
    );
    (svc as unknown as { openai: unknown }).openai = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{ message: { content: JSON.stringify(llm) } }],
          }),
        },
      },
    };
    return { svc, queries, derived };
  }

  it('writes versioned propositions with resolved subject and provenance', async () => {
    const { svc, queries, derived } = makeSvc({
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
    // S4/0079: the write goes through the ONE write primitive
    // (fn::resolve_facts via FactResolverService), not a raw INSERT.
    const rows = derived;
    expect(rows).toHaveLength(2);
    expect(rows[0].predicate).toBe('pets');
    expect(rows[0].derivedVersion).toBe(WINDOW_DERIVER_VERSION);
    expect(String(rows[0].object)).toContain('Luna and Oliver');
    const source = rows[0].source as Record<string, unknown>;
    expect(source.recorder).toBe(WINDOW_DERIVER_VERSION);
    expect(source.episodeIds).toEqual(['episode:e1']);
    // Audit W3 #1: derived rows must carry the fields the read path
    // assumes; the resolver stamps the trust snapshot from sourceTrust.
    expect(rows[0].lang).toBe('en');
    expect(rows[0].script).toBeDefined();
    expect(rows[0].sourceTrust as number).toBeGreaterThan(0);
  });

  it('uses occurred_on as validFrom when parseable', async () => {
    const { svc, derived } = makeSvc({
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
    const rows = derived;
    expect(rows[0].validFrom).toEqual(new Date('2022-06-15T00:00:00.000Z'));
  });

  it('impossible calendar occurred_on falls back to the session date', async () => {
    const { svc, derived } = makeSvc({
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
    const rows = derived;
    expect(rows[0].validFrom).toEqual(new Date('2023-05-01T10:00:00Z'));
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

  describe('world forks (Mandela guard + flip + gc)', () => {
    const savedPin = process.env.RETRIEVAL_DERIVED_VERSION;
    afterEach(() => {
      if (savedPin === undefined) delete process.env.RETRIEVAL_DERIVED_VERSION;
      else process.env.RETRIEVAL_DERIVED_VERSION = savedPin;
    });

    const oneProp = {
      propositions: [
        {
          subject: 'Caroline',
          aspect: 'pets',
          proposition: 'p',
          occurred_on: null,
          turns: [1],
        },
      ],
    };

    it('refuses to derive into the live read pin without force', async () => {
      process.env.RETRIEVAL_DERIVED_VERSION = 'wd-v2';
      const { svc, queries } = makeSvc(oneProp);
      await expect(svc.run('co_x', { version: 'wd-v2' })).rejects.toThrow(
        'live read pin',
      );
      expect(queries).toHaveLength(0);
      // force overrides for deliberate in-place eval rewrites
      const { svc: svc2 } = makeSvc(oneProp);
      const res = await svc2.run('co_x', { version: 'wd-v2', force: true });
      expect(res.propositions).toBe(1);
    });

    it('activate flips the pin only after a successful run', async () => {
      process.env.RETRIEVAL_DERIVED_VERSION = 'wd-v2';
      const { svc } = makeSvc(oneProp);
      const res = await svc.run('co_x', { version: 'wd-v3', activate: true });
      expect(res.activated).toBe(true);
      expect(res.previousVersion).toBe('wd-v2');
      // Audit W2 #9: activation is a REGISTRY write, never a process.env
      // mutation — a per-tenant flip must not repoint other tenants on
      // this pod, and other pods must see it too.
      expect(process.env.RETRIEVAL_DERIVED_VERSION).toBe('wd-v2');
    });

    it('gc reaps residual versions but never the pin, keeps, or legacy', async () => {
      process.env.RETRIEVAL_DERIVED_VERSION = 'wd-v3';
      const queries: Array<{ sql: string; params?: Record<string, unknown> }> =
        [];
      const db = {
        query: async (sql: string, params?: Record<string, unknown>) => {
          queries.push({ sql, params });
          if (sql.includes('GROUP BY derivedVersion'))
            return [
              [
                { derivedVersion: 'wd-v1', n: 100 },
                { derivedVersion: 'wd-v2', n: 200 },
                { derivedVersion: 'wd-v3', n: 300 },
              ],
            ];
          return [[]];
        },
      };
      const surreal = {
        withCompany: async (
          _c: string,
          fn: (d: unknown) => Promise<unknown>,
        ) => fn(db),
      } as unknown as SurrealService;
      const config = {
        get: (k: string, d?: string) => d,
        getOrThrow: () => 'sk',
      } as unknown as ConfigService;
      const embedding = {
        embedMany: async (t: string[]) => t.map(() => [1, 0]),
      } as unknown as FactEmbeddingService;
      const svc = new WindowDeriverService(surreal, config, embedding, new EpisodeReadStoreService(surreal), {
        resolveDerivedBatch: async () => [],
      } as unknown as import('../src/ingest/fact-resolver.service').FactResolverService);
      const res = await svc.gc('co_x', { keep: ['wd-v2'] });
      expect(res.deleted).toEqual({ 'wd-v1': 100 });
      expect(res.kept.sort()).toEqual(['wd-v2', 'wd-v3']);
      const dels = queries.filter((q) =>
        q.sql.includes('DELETE knowledge_fact'),
      );
      expect(dels).toHaveLength(1);
      expect(dels[0].params?.version).toBe('wd-v1');
    });

    it('gc REFUSES with no pin, no registry evidence, and no explicit keep', async () => {
      delete process.env.RETRIEVAL_DERIVED_VERSION;
      const db = {
        query: async (sql: string) =>
          sql.includes('GROUP BY derivedVersion')
            ? [[{ derivedVersion: 'wd-v1', n: 100 }]]
            : [[]],
      };
      const surreal = {
        withCompany: async (
          _c: string,
          fn: (d: unknown) => Promise<unknown>,
        ) => fn(db),
      } as unknown as SurrealService;
      const config = {
        get: (k: string, d?: string) => d,
        getOrThrow: () => 'sk',
      } as unknown as ConfigService;
      const embedding = {
        embedMany: async (t: string[]) => t.map(() => [1, 0]),
      } as unknown as FactEmbeddingService;
      const svc = new WindowDeriverService(surreal, config, embedding, new EpisodeReadStoreService(surreal), {
        resolveDerivedBatch: async () => [],
      } as unknown as import('../src/ingest/fact-resolver.service').FactResolverService);
      await expect(svc.gc('co_x')).rejects.toThrow(/gc refused/);
    });

    it('gc keep-set includes registry live/building/built worlds even with no pin', async () => {
      delete process.env.RETRIEVAL_DERIVED_VERSION;
      const queries: Array<{ sql: string; params?: Record<string, unknown> }> =
        [];
      const db = {
        query: async (sql: string, params?: Record<string, unknown>) => {
          queries.push({ sql, params });
          if (sql.includes('GROUP BY derivedVersion'))
            return [
              [
                { derivedVersion: 'wd-old', n: 10 },
                { derivedVersion: 'wd-live', n: 20 },
                { derivedVersion: 'wd-next', n: 5 },
              ],
            ];
          return [[]];
        },
      };
      const surreal = {
        withCompany: async (
          _c: string,
          fn: (d: unknown) => Promise<unknown>,
        ) => fn(db),
      } as unknown as SurrealService;
      const config = {
        get: (k: string, d?: string) => d,
        getOrThrow: () => 'sk',
      } as unknown as ConfigService;
      const embedding = {
        embedMany: async (t: string[]) => t.map(() => [1, 0]),
      } as unknown as FactEmbeddingService;
      const registry = {
        list: async () => [
          { name: 'facts', version: 'wd-live', status: 'live' },
          { name: 'facts', version: 'wd-next', status: 'building' },
          { name: 'facts', version: 'wd-old', status: 'residual' },
        ],
        dropVersions: async () => undefined,
      } as unknown as import('../src/episodes/projection-registry.service').ProjectionRegistryService;
      const svc = new WindowDeriverService(
        surreal,
        config,
        embedding,
        new EpisodeReadStoreService(surreal),
        {
          resolveDerivedBatch: async () => [],
        } as unknown as import('../src/ingest/fact-resolver.service').FactResolverService,
        registry,
      );
      const res = await svc.gc('co_x');
      expect(res.deleted).toEqual({ 'wd-old': 10 });
      expect(res.kept.sort()).toEqual(['wd-live', 'wd-next']);
    });
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

describe('buildDeriverSystem (E3a assistant-content lockstep)', () => {
  it('flag off: byte-identical base contract, no assistance aspect', () => {
    const base = buildDeriverSystem();
    expect(base).toBe(buildDeriverSystem({ assistantContent: false }));
    expect(base).not.toContain('ASSISTANT-SIDE CONTRIBUTIONS');
    expect(base).not.toContain('"assistance"');
  });

  it('flag on: appends the section verbatim after the base contract', () => {
    const on = buildDeriverSystem({ assistantContent: true });
    expect(on.startsWith(buildDeriverSystem())).toBe(true);
    expect(on).toContain(DERIVER_ASSISTANT_SECTION);
    expect(on).toContain('aspect "assistance"');
    expect(on).toContain('the CONTRIBUTING participant');
  });
});
