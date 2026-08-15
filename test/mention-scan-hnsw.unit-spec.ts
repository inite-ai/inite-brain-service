import { MentionScanService } from '../src/synthesize/mention-scan.service';
import type { SurrealService } from '../src/db/surreal.service';
import type { EmbedderService } from '../src/ai/embedder.service';

/**
 * V11 §5 — the mention-scan lane under the tuned dense leg. The lane's
 * own pipeline (floors, per-session collapse, line pick) is covered by
 * mention-scan.unit-spec; here the contracts are the leg SQL per mode,
 * the gate tail surviving the KNN rewrite, and the degrade-to-[]
 * failure boundary the sibling lanes already pin.
 */

function makeService(rows: {
  dense: Array<Record<string, unknown>>;
  bm25: Array<Record<string, unknown>>;
  capture?: string[];
}): MentionScanService {
  const surreal = {
    withCompany: async (_c: string, fn: (db: unknown) => Promise<unknown>) => {
      let call = 0;
      return fn({
        query: async (sql: string) => {
          rows.capture?.push(sql);
          call += 1;
          return [call === 1 ? rows.dense : rows.bm25];
        },
      });
    },
  } as unknown as SurrealService;
  const embedder = {
    embed: async () => [0.1, 0.2],
  } as unknown as EmbedderService;
  return new MentionScanService(surreal, embedder);
}

describe('MentionScanService dense-leg modes', () => {
  const segment = {
    id: 'episode_segment:s1',
    text: '[2026-01-05] user: kicked off the parser project',
    occurredAt: '2026-01-05T09:00:00Z',
    score: 0.9,
  };

  it('defaults to the exact scan when no tuning is passed', async () => {
    const capture: string[] = [];
    const svc = makeService({ dense: [segment], bm25: [], capture });
    await svc.mentionLines({
      companyId: 'c1',
      query: 'In what order did I raise the parser project aspects?',
      callerScopes: [],
    });
    expect(capture[0]).toContain('embedding != NONE');
    expect(capture[0]).not.toContain('<|');
  });

  it('hnsw tuning emits the KNN leg with the pii/user gates intact', async () => {
    const capture: string[] = [];
    // The hnsw leg returns the walk's distance, not a cosine score.
    const { score: _score, ...bare } = segment;
    const svc = makeService({
      dense: [{ ...bare, knnDist: 0.1 }],
      bm25: [],
      capture,
    });
    const lines = await svc.mentionLines({
      companyId: 'c1',
      query: 'In what order did I raise the parser project aspects?',
      callerScopes: [],
      scan: { mode: 'hnsw', ef: 400, overfetch: 4 },
    });
    // k=400 × 4 = 1600 (Lane A keeps the shared multiplier).
    expect(capture[0]).toContain('embedding <|1600,1600|> $q');
    expect(capture[0]).toContain('piiClass IS NONE');
    expect(capture[0]).toContain('userId IS NONE');
    // The BM25 leg is untouched by the mode.
    expect(capture[1]).toContain('text @1@ $topic');
    expect(lines.length).toBeGreaterThan(0);
  });

  it('counts a zero-score BM25 match as a lexical mention (IDF collapse)', async () => {
    // BM25 scores 0 when every topic term appears in every doc; a row
    // the matches operator returned is still a lexical mention, so it
    // must survive filterMentions even when the dense sims sit under
    // the absolute floor.
    const svc = makeService({
      dense: [],
      bm25: [{ ...segment, score: 0 }],
    });
    const lines = await svc.mentionLines({
      companyId: 'c1',
      query: 'List the order of parser project',
      callerScopes: [],
    });
    expect(lines).toHaveLength(1);
  });

  it("lex='or_terms' rewrites the BM25 leg as per-term matchers", async () => {
    const capture: string[] = [];
    const svc = makeService({ dense: [], bm25: [segment], capture });
    const lines = await svc.mentionLines({
      companyId: 'c1',
      query: 'In what order did I raise the parser project aspects?',
      callerScopes: [],
      lex: 'or_terms',
    });
    // Topic strips to 'raise the parser project aspects' → four terms.
    expect(capture[1]).toContain('text @1@ $t0 OR text @2@ $t1');
    expect(capture[1]).toContain(
      'math::sum([search::score(1), search::score(2), ' +
        'search::score(3), search::score(4)])',
    );
    expect(capture[1]).not.toContain('$topic');
    expect(lines.length).toBeGreaterThan(0);
  });

  it('degrades to [] on any failure (the sibling-lane contract)', async () => {
    const surreal = {
      withCompany: async () => {
        throw new Error('db down');
      },
    } as unknown as SurrealService;
    const embedder = {
      embed: async () => [0.1],
    } as unknown as EmbedderService;
    const svc = new MentionScanService(surreal, embedder);
    await expect(
      svc.mentionLines({ companyId: 'c1', query: 'q', callerScopes: [] }),
    ).resolves.toEqual([]);
  });
});
