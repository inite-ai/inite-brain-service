import { EpisodeLaneService } from '../src/synthesize/episode-lane.service';
import { EpisodeReadStoreService } from '../src/episodes/episode-read-store.service';
import { buildGeneratorUserMessage } from '../src/synthesize/synthesize.service';
import type { SurrealService } from '../src/db/surreal.service';

function makeLane(rows: Array<Record<string, unknown>>): {
  svc: EpisodeLaneService;
  queries: Array<{ sql: string; params: Record<string, unknown> }>;
} {
  const queries: Array<{ sql: string; params: Record<string, unknown> }> = [];
  const surreal = {
    withCompany: async (
      _co: string,
      fn: (db: unknown) => Promise<unknown>,
    ) =>
      fn({
        query: async (sql: string, params: Record<string, unknown>) => {
          queries.push({ sql, params });
          return [rows];
        },
      }),
  } as unknown as SurrealService;
  return { svc: new EpisodeLaneService(surreal, new EpisodeReadStoreService(surreal)), queries };
}

describe('EpisodeLaneService (P2)', () => {
  // Activation lives in SynthesizeService (profile.verbatimEvidence);
  // this service always runs when called and takes the cap explicitly.
  const base = {
    companyId: 'co_x',
    query: 'What did Melanie paint?',
    callerScopes: ['brain:read', 'brain:read_pii'],
    limit: 8,
  };

  it('renders dated speaker lines in chronological order', async () => {
    const { svc, queries } = makeLane([
      // BM25 score order: newest first — the lane must re-sort by time.
      { speaker: 'Melanie', text: 'I painted a sunset', occurredAt: '2023-06-01T10:00:00Z' },
      { speaker: 'Caroline', text: 'Show me the horse painting', occurredAt: '2023-05-01T10:00:00Z' },
    ]);
    const lines = await svc.transcriptLines(base);
    expect(lines).toEqual([
      '[2023-05-01] Caroline: Show me the horse painting',
      '[2023-06-01] Melanie: I painted a sunset',
    ]);
    expect(queries[0].sql).toContain('FROM episode');
    expect(queries[0].sql).toContain('@1@ $q');
  });

  it('gates piiClass rows away from callers without brain:read_pii', async () => {
    const { svc, queries } = makeLane([]);
    await svc.transcriptLines({ ...base, callerScopes: ['brain:read'] });
    expect(queries[0].sql).toContain('AND piiClass IS NONE');
    await svc.transcriptLines(base);
    expect(queries[1].sql).not.toContain('piiClass IS NONE');
  });

  it('degrades to [] on query failure', async () => {
    const surreal = {
      withCompany: async () => {
        throw new Error('index rebuilding');
      },
    } as unknown as SurrealService;
    const svc = new EpisodeLaneService(surreal, new EpisodeReadStoreService(surreal));
    expect(await svc.transcriptLines(base)).toEqual([]);
  });
});

describe('EpisodeLaneService.sourceExcerpts (A1 provenance lane)', () => {
  function makeProvLane(perQuery: Array<Array<Record<string, unknown>>>): {
    svc: EpisodeLaneService;
    queries: Array<{ sql: string; params: Record<string, unknown> }>;
  } {
    const queries: Array<{ sql: string; params: Record<string, unknown> }> = [];
    const surreal = {
      withCompany: async (
        _co: string,
        fn: (db: unknown) => Promise<unknown>,
      ) =>
        fn({
          query: async (sql: string, params: Record<string, unknown>) => {
            queries.push({ sql, params });
            return [perQuery[queries.length - 1] ?? []];
          },
        }),
    } as unknown as SurrealService;
    return { svc: new EpisodeLaneService(surreal, new EpisodeReadStoreService(surreal)), queries };
  }

  const base = {
    companyId: 'co_x',
    factIds: ['knowledge_fact:f1', 'knowledge_fact:f2'],
    callerScopes: ['brain:read', 'brain:read_pii'],
    cap: 16,
  };

  it('empty factIds → [] with zero DB calls', async () => {
    const { svc, queries } = makeProvLane([]);
    expect(await svc.sourceExcerpts({ ...base, factIds: [] })).toEqual([]);
    expect(queries).toHaveLength(0);
  });

  it('follows provenance, dedupes episodes, renders chronologically', async () => {
    const { svc, queries } = makeProvLane([
      [
        { eps: ['episode:e2', 'episode:e1'] },
        { eps: ['episode:e1'] }, // duplicate across facts
      ],
      [
        { speaker: 'Melanie', text: 'later turn', occurredAt: '2023-06-01T10:00:00Z' },
        { speaker: 'Mel', text: 'a cup with a dog face', occurredAt: '2023-05-01T10:00:00Z' },
      ],
    ]);
    const lines = await svc.sourceExcerpts(base);
    expect(lines).toEqual([
      '[2023-05-01] Mel: a cup with a dog face',
      '[2023-06-01] Melanie: later turn',
    ]);
    // Fact fetch uses record-id binding, not string interpolation.
    expect(queries[0].sql).toContain('INSIDE $ids');
    expect(String((queries[0].params.ids as unknown[])[0])).toBe(
      'knowledge_fact:f1',
    );
    // Episode fetch got the deduped id set.
    expect((queries[1].params.ids as unknown[]).map(String)).toEqual([
      'episode:e2',
      'episode:e1',
    ]);
    // read_pii caller → no PII gate in the episode query.
    expect(queries[1].sql).not.toContain('piiClass IS NONE');
  });

  it('caps episodes first-seen and gates PII without brain:read_pii', async () => {
    const { svc, queries } = makeProvLane([
      [{ eps: ['episode:e1', 'episode:e2'] }],
      [{ speaker: 'A', text: 't', occurredAt: '2023-05-01T00:00:00Z' }],
    ]);
    const lines = await svc.sourceExcerpts({
      ...base,
      cap: 1,
      callerScopes: ['brain:read'],
    });
    expect(lines).toHaveLength(1);
    expect((queries[1].params.ids as unknown[]).map(String)).toEqual([
      'episode:e1',
    ]);
    expect(queries[1].sql).toContain('piiClass IS NONE');
  });

  it('degrades to [] on DB failure and with empty factIds', async () => {
    const surreal = {
      withCompany: async () => {
        throw new Error('db down');
      },
    } as unknown as SurrealService;
    const svc = new EpisodeLaneService(surreal, new EpisodeReadStoreService(surreal));
    expect(await svc.sourceExcerpts(base)).toEqual([]);
    const { svc: svc2, queries } = makeProvLane([]);
    expect(await svc2.sourceExcerpts({ ...base, factIds: [] })).toEqual([]);
    expect(queries).toHaveLength(0);
  });
});

describe('EpisodeLaneService.assistantTurns (multiworld §10 assistant lane)', () => {
  const base = {
    companyId: 'co_x',
    query: 'What did you recommend for the rate limiter?',
    callerScopes: ['brain:read', 'brain:read_pii'],
    limit: 6,
    match: 'assistant',
  };

  it('filters by case-insensitive speaker suffix and renders quotes', async () => {
    const { svc, queries } = makeLane([
      {
        speaker: 'conv_1__assistant',
        text: 'Use the token bucket',
        occurredAt: '2023-05-01T10:00:00Z',
      },
    ]);
    const lines = await svc.assistantTurns(base);
    expect(lines).toEqual([
      '[2023-05-01] conv_1__assistant: Use the token bucket',
    ]);
    expect(queries[0].sql).toContain(
      "string::ends_with(string::lowercase(speaker), $speakerSuffix)",
    );
    expect(queries[0].params.speakerSuffix).toBe('assistant');
  });

  it('lowercases the configured match before binding', async () => {
    const { svc, queries } = makeLane([]);
    await svc.assistantTurns({ ...base, match: 'Assistant' });
    expect(queries[0].params.speakerSuffix).toBe('assistant');
  });

  it('clamps runaway turns to the per-line budget (audit 2026-08-21 #7)', async () => {
    const { svc } = makeLane([
      {
        speaker: 'conv_1__assistant',
        text: 'x'.repeat(5000),
        occurredAt: '2023-05-01T10:00:00Z',
      },
    ]);
    const [line] = await svc.assistantTurns(base);
    expect(line.length).toBeLessThan(700);
    expect(line).toContain('…');
  });

  it('keeps the PII fence for callers without brain:read_pii', async () => {
    const { svc, queries } = makeLane([]);
    await svc.assistantTurns({ ...base, callerScopes: ['brain:read'] });
    expect(queries[0].sql).toContain('AND piiClass IS NONE');
  });

  it('degrades to [] on failure', async () => {
    const surreal = {
      withCompany: async () => {
        throw new Error('down');
      },
    } as unknown as SurrealService;
    const svc = new EpisodeLaneService(
      surreal,
      new EpisodeReadStoreService(surreal),
    );
    expect(await svc.assistantTurns(base)).toEqual([]);
  });
});

describe('EpisodeLaneService.groundingQuotes (multiworld §10 facts-as-keys)', () => {
  function makeQuoteLane(perQuery: Array<Array<Record<string, unknown>>>): {
    svc: EpisodeLaneService;
    queries: Array<{ sql: string; params: Record<string, unknown> }>;
  } {
    const queries: Array<{ sql: string; params: Record<string, unknown> }> = [];
    const surreal = {
      withCompany: async (
        _co: string,
        fn: (db: unknown) => Promise<unknown>,
      ) =>
        fn({
          query: async (sql: string, params: Record<string, unknown>) => {
            queries.push({ sql, params });
            return [perQuery[queries.length - 1] ?? []];
          },
        }),
    } as unknown as SurrealService;
    return {
      svc: new EpisodeLaneService(surreal, new EpisodeReadStoreService(surreal)),
      queries,
    };
  }

  const base = {
    companyId: 'co_x',
    factIds: ['knowledge_fact:f1', 'knowledge_fact:f2'],
    callerScopes: ['brain:read', 'brain:read_pii'],
  };

  it('binds each fact to ITS first grounding turn quote', async () => {
    const { svc } = makeQuoteLane([
      [
        { id: 'knowledge_fact:f1', eps: ['episode:e1', 'episode:e2'] },
        { id: 'knowledge_fact:f2', eps: ['episode:e3'] },
      ],
      [
        {
          id: 'episode:e1',
          speaker: 'Mel',
          text: 'a cup with a dog face',
          occurredAt: '2023-05-01T10:00:00Z',
        },
        {
          id: 'episode:e3',
          speaker: 'Caroline',
          text: 'moved to Portland',
          occurredAt: '2023-06-02T10:00:00Z',
        },
      ],
    ]);
    const map = await svc.groundingQuotes(base);
    expect(map.get('knowledge_fact:f1')).toBe(
      ' [source 2023-05-01 Mel: "a cup with a dog face"]',
    );
    expect(map.get('knowledge_fact:f2')).toBe(
      ' [source 2023-06-02 Caroline: "moved to Portland"]',
    );
  });

  it('caps runaway turn text and skips fenced-out episodes', async () => {
    const { svc } = makeQuoteLane([
      [
        { id: 'knowledge_fact:f1', eps: ['episode:e1'] },
        { id: 'knowledge_fact:f2', eps: ['episode:gone'] },
      ],
      [
        {
          id: 'episode:e1',
          speaker: 'A',
          text: 'x'.repeat(500),
          occurredAt: '2023-05-01T10:00:00Z',
        },
        // episode:gone is absent — fenced or deleted.
      ],
    ]);
    const map = await svc.groundingQuotes(base);
    expect(map.get('knowledge_fact:f1')!.length).toBeLessThan(300);
    expect(map.get('knowledge_fact:f1')).toContain('…');
    expect(map.has('knowledge_fact:f2')).toBe(false);
  });

  it('empty factIds → empty map, zero DB calls; failures degrade', async () => {
    const { svc, queries } = makeQuoteLane([]);
    expect((await svc.groundingQuotes({ ...base, factIds: [] })).size).toBe(0);
    expect(queries).toHaveLength(0);
    const surreal = {
      withCompany: async () => {
        throw new Error('db down');
      },
    } as unknown as SurrealService;
    const broken = new EpisodeLaneService(
      surreal,
      new EpisodeReadStoreService(surreal),
    );
    expect((await broken.groundingQuotes(base)).size).toBe(0);
  });
});

describe('buildGeneratorUserMessage transcript section', () => {
  const base = {
    query: 'q',
    factLines: ['[knowledge_fact:1] A (person) — p: v'],
    answerLang: null,
  };

  it('is byte-identical without transcript lines', () => {
    expect(buildGeneratorUserMessage(base)).toBe(
      `Query: q\n\nRetrieved facts:\n${base.factLines[0]}`,
    );
    expect(buildGeneratorUserMessage({ ...base, transcriptLines: [] })).toBe(
      buildGeneratorUserMessage(base),
    );
  });

  it('appends the typed section after facts with the cite-facts-only note', () => {
    const msg = buildGeneratorUserMessage({
      ...base,
      transcriptLines: ['[2023-05-01] Melanie: I painted a sunset'],
    });
    expect(msg).toContain('Transcript excerpts');
    expect(msg).toContain('cite factIds only');
    expect(msg.indexOf('Transcript excerpts')).toBeGreaterThan(
      msg.indexOf('Retrieved facts:'),
    );
  });
});
