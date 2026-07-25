import { EpisodeLaneService } from '../src/synthesize/episode-lane.service';
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
  return { svc: new EpisodeLaneService(surreal), queries };
}

describe('EpisodeLaneService (P2)', () => {
  const saved = process.env.SEARCH_EPISODIC_LANE_ENABLED;
  afterEach(() => {
    if (saved === undefined) delete process.env.SEARCH_EPISODIC_LANE_ENABLED;
    else process.env.SEARCH_EPISODIC_LANE_ENABLED = saved;
  });

  const base = {
    companyId: 'co_x',
    query: 'What did Melanie paint?',
    callerScopes: ['brain:read', 'brain:read_pii'],
  };

  it('returns [] with zero DB calls when the flag is off', async () => {
    delete process.env.SEARCH_EPISODIC_LANE_ENABLED;
    const { svc, queries } = makeLane([]);
    expect(await svc.transcriptLines(base)).toEqual([]);
    expect(queries).toHaveLength(0);
  });

  it('renders dated speaker lines in chronological order', async () => {
    process.env.SEARCH_EPISODIC_LANE_ENABLED = '1';
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
    process.env.SEARCH_EPISODIC_LANE_ENABLED = '1';
    const { svc, queries } = makeLane([]);
    await svc.transcriptLines({ ...base, callerScopes: ['brain:read'] });
    expect(queries[0].sql).toContain('AND piiClass IS NONE');
    await svc.transcriptLines(base);
    expect(queries[1].sql).not.toContain('piiClass IS NONE');
  });

  it('degrades to [] on query failure', async () => {
    process.env.SEARCH_EPISODIC_LANE_ENABLED = '1';
    const surreal = {
      withCompany: async () => {
        throw new Error('index rebuilding');
      },
    } as unknown as SurrealService;
    const svc = new EpisodeLaneService(surreal);
    expect(await svc.transcriptLines(base)).toEqual([]);
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
