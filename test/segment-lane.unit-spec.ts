import {
  SegmentLaneService,
  rrfFuse,
} from '../src/synthesize/segment-lane.service';
import {
  windowSession,
  renderSegmentText,
  SegmentComposerService,
  SEGMENT_RECORDER,
} from '../src/admin/segment-composer.service';
import { EpisodeReadStoreService } from '../src/episodes/episode-read-store.service';
import type { SurrealService } from '../src/db/surreal.service';
import type { EmbedderService } from '../src/ai/embedder.service';
import type { RerankerService } from '../src/ai/reranker.service';
import type { FactEmbeddingService } from '../src/ingest/fact-embedding.service';

describe('windowSession (R1 positional segmentation)', () => {
  const t = (id: string) => ({
    id,
    speaker: 'A',
    text: id,
    occurredAt: '2023-05-01T10:00:00Z',
  });

  it('slides window 4 stride 2 with a tail window', () => {
    const turns = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(t);
    const windows = windowSession(turns, 4, 2);
    expect(windows.map((w) => w.map((x) => x.id))).toEqual([
      ['a', 'b', 'c', 'd'],
      ['c', 'd', 'e', 'f'],
      ['e', 'f', 'g'],
    ]);
  });

  it('short session → one window; empty → none', () => {
    expect(windowSession(['a', 'b'].map(t), 4, 2)).toHaveLength(1);
    expect(windowSession([], 4, 2)).toEqual([]);
  });

  it('renders dated speaker lines', () => {
    expect(
      renderSegmentText([
        { id: 'e1', speaker: 'Mel', text: 'hi', occurredAt: '2023-05-01T10:00:00Z' },
      ]),
    ).toBe('[2023-05-01] Mel: hi');
  });
});

describe('rrfFuse', () => {
  const row = (id: string) => ({ id, text: id, occurredAt: '2023-05-01' });

  it('ranks items present in both lists above single-list items', () => {
    const fused = rrfFuse([
      [row('a'), row('b'), row('c')],
      [row('c'), row('d')],
    ]);
    expect(String(fused[0].id)).toBe('c');
    expect(fused).toHaveLength(4);
  });

  it('dedupes by id keeping one row', () => {
    const fused = rrfFuse([[row('x')], [row('x')]]);
    expect(fused).toHaveLength(1);
  });
});

describe('SegmentComposerService', () => {
  it('windows sessions, embeds, and writes segments idempotently', async () => {
    const queries: Array<{ sql: string; params?: Record<string, unknown> }> = [];
    const db = {
      query: async (sql: string, params?: Record<string, unknown>) => {
        queries.push({ sql, params });
        if (sql.includes('GROUP BY conversationId'))
          return [[{ conversationId: 'conv-1' }]];
        if (sql.includes('FROM episode'))
          return [
            [
              { id: 'episode:e0', speaker: 'A', text: 'q1', occurredAt: '2023-05-01T10:00:00Z', piiClass: ['phone'] },
              { id: 'episode:e1', speaker: 'B', text: 'a1', occurredAt: '2023-05-01T10:01:00Z' },
            ],
          ];
        return [[]];
      },
    };
    const surreal = {
      withCompany: async (_c: string, fn: (d: unknown) => Promise<unknown>) =>
        fn(db),
    } as unknown as SurrealService;
    const embedding = {
      embedMany: async (t: string[]) => t.map(() => [1, 0]),
    } as unknown as FactEmbeddingService;
    const svc = new SegmentComposerService(surreal, embedding, new EpisodeReadStoreService(surreal));
    const res = await svc.run('co_x');
    expect(res).toMatchObject({ conversations: 1, segments: 1 });
    expect(
      queries.some((q) => q.sql.includes('DELETE episode_segment')),
    ).toBe(true);
    const insert = queries.find((q) =>
      q.sql.includes('INSERT INTO episode_segment'),
    );
    const rows = insert?.params?.rows as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].recorder).toBe(SEGMENT_RECORDER);
    expect(rows[0].piiClass).toEqual(['phone']);
    expect(String(rows[0].text)).toContain('[2023-05-01] A: q1');
  });
});

describe('SegmentLaneService', () => {
  // Activation lives in SynthesizeService (profile.verbatimEvidence ===
  // 'always'); the service takes topK/rerank explicitly.
  function makeLane(perQuery: Array<Array<Record<string, unknown>>>): {
    svc: SegmentLaneService;
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
    const embedder = {
      embed: async () => [1, 0],
    } as unknown as EmbedderService;
    return { svc: new SegmentLaneService(surreal, embedder), queries };
  }

  const base = {
    companyId: 'co_x',
    query: 'what did the kids paint?',
    callerScopes: ['brain:read', 'brain:read_pii'],
    topK: 5,
    rerank: false,
  };

  it('fuses dense+BM25 and renders chronologically', async () => {
    const { svc, queries } = makeLane([
      [
        { id: 's1', text: '[2023-06-01] A: later', occurredAt: '2023-06-01T10:00:00Z' },
        { id: 's2', text: '[2023-05-01] B: sunset palm tree', occurredAt: '2023-05-01T10:00:00Z' },
      ],
      [{ id: 's2', text: '[2023-05-01] B: sunset palm tree', occurredAt: '2023-05-01T10:00:00Z' }],
    ]);
    const lines = await svc.transcriptLines(base);
    // s2 wins fusion (both lists) but rendering is chronological.
    expect(lines).toEqual([
      '[2023-05-01] B: sunset palm tree',
      '[2023-06-01] A: later',
    ]);
    expect(queries[0].sql).toContain('vector::similarity::cosine');
    expect(queries[1].sql).toContain('@1@');
    // read_pii caller → no PII gate.
    expect(queries[0].sql).not.toContain('piiClass IS NONE');
  });

  it('gates PII for callers without brain:read_pii', async () => {
    const { svc, queries } = makeLane([[], []]);
    await svc.transcriptLines({ ...base, callerScopes: ['brain:read'] });
    expect(queries[0].sql).toContain('piiClass IS NONE');
    expect(queries[1].sql).toContain('piiClass IS NONE');
  });

  it('reranks the fused pool when asked and trims to topK', async () => {
    const rows = [
      { id: 's1', text: 'first', occurredAt: '2023-05-01T10:00:00Z' },
      { id: 's2', text: 'second', occurredAt: '2023-05-02T10:00:00Z' },
    ];
    const { svc } = makeLane([rows, []]);
    const reranker = {
      isEnabled: () => true,
      rerank: async () => [1, 0],
    } as unknown as RerankerService;
    (svc as unknown as { reranker: RerankerService }).reranker = reranker;
    const lines = await svc.transcriptLines({ ...base, topK: 1, rerank: true });
    expect(lines).toEqual(['second']);
  });

  it('degrades to [] on DB failure', async () => {
    const surreal = {
      withCompany: async () => {
        throw new Error('db down');
      },
    } as unknown as SurrealService;
    const embedder = { embed: async () => [1, 0] } as unknown as EmbedderService;
    const svc = new SegmentLaneService(surreal, embedder);
    expect(await svc.transcriptLines(base)).toEqual([]);
  });
});
