import type { Surreal } from 'surrealdb';
import { runSegmentLegs } from '../src/search/internals/segment-leg';
import { SearchRetrievalService } from '../src/search/search-retrieval.service';
import { resolveRetrievalProfileFor } from '../src/search/retrieval-profile';
import type { EmbedderService } from '../src/ai/embedder.service';
import type { CalibrationService } from '../src/ai/calibration/calibration.service';
import type { PipelineContext } from '../src/search/pipeline-context';

/**
 * Audit W4 #18: verbatim had no read-path expression — quotes never
 * entered SearchHit, never got scored/reranked against facts, and were
 * structurally uncitable. Under verbatimEvidence='fused', segments run
 * as a retrieval leg through the same convex fusion and scoring.
 */
function recordingDb(perQuery: Record<string, unknown[]>): {
  db: Pick<Surreal, 'query'>;
  queries: Array<{ sql: string; params?: Record<string, unknown> }>;
} {
  const queries: Array<{ sql: string; params?: Record<string, unknown> }> = [];
  const db = {
    query: async (sql: string, params?: Record<string, unknown>) => {
      queries.push({ sql, params });
      for (const [marker, rows] of Object.entries(perQuery)) {
        if (sql.includes(marker)) return [rows];
      }
      return [[]];
    },
  } as Pick<Surreal, 'query'>;
  return { db, queries };
}

const SEG = {
  id: 'episode_segment:s1',
  conversationId: 'conv-1',
  text: '[2023-05-01] Caroline: my cats are Luna and Oliver',
  occurredAt: '2023-05-01T10:00:00Z',
  score: 0.9,
};

describe('runSegmentLegs', () => {
  it('shapes segments as citable pseudo-FactRows with both leg scores', async () => {
    const { db, queries } = recordingDb({
      'vector::similarity::cosine': [SEG],
      'search::score(1)': [{ ...SEG, score: 3.2 }],
    });
    const { vectorRows, lexicalRows } = await runSegmentLegs({
      db,
      queryText: 'cats',
      queryVector: [1, 0],
      fetchK: 12,
      callerScopes: ['brain:read'],
      mode: 'hybrid',
    });
    expect(vectorRows).toHaveLength(1);
    expect(lexicalRows).toHaveLength(1);
    const row = vectorRows[0]!;
    expect(row.predicate).toBe('verbatim');
    expect(String(row.entityId)).toBe('episode_segment:s1');
    expect(row.entity?.type).toBe('segment');
    expect(row.entity?.canonicalName).toContain('conv-1');
    expect(row.confidence).toBe(1);
    expect(row.validFrom).toBe('2023-05-01T10:00:00Z');
    expect(row.simScore).toBe(0.9);
    expect(lexicalRows[0]!.bm25Score).toBe(3.2);
    // PII fence + fail-closed user scope on BOTH queries (0055 / W1 #14).
    for (const q of queries) {
      expect(q.sql).toContain('AND piiClass IS NONE');
      expect(q.sql).toContain('AND userId IS NONE');
    }
  });

  it('brain:read_pii lifts the PII fence; userId opens the user scope', async () => {
    const { db, queries } = recordingDb({});
    await runSegmentLegs({
      db,
      queryText: 'cats',
      queryVector: [1, 0],
      fetchK: 12,
      callerScopes: ['brain:read', 'brain:read_pii'],
      userId: 'u1',
      mode: 'hybrid',
    });
    for (const q of queries) {
      expect(q.sql).not.toContain('piiClass IS NONE');
      expect(q.sql).toContain('userId IS NONE OR userId = $scopeUserId');
      expect(q.params?.scopeUserId).toBe('u1');
    }
  });

  it('lexical mode skips the dense query, vector mode skips BM25', async () => {
    const { db, queries } = recordingDb({});
    await runSegmentLegs({
      db,
      queryText: 'cats',
      queryVector: null,
      fetchK: 12,
      callerScopes: [],
      mode: 'lexical',
    });
    expect(queries).toHaveLength(1);
    expect(queries[0]!.sql).toContain('search::score(1)');
  });
});

describe('SearchRetrievalService.runSegmentLegStage', () => {
  it('returns segment buckets scored through the shared pipeline', async () => {
    const { db } = recordingDb({
      'vector::similarity::cosine': [SEG],
      'search::score(1)': [SEG],
    });
    const svc = new SearchRetrievalService(
      { embed: async () => [1, 0] } as unknown as EmbedderService,
      { calibrate: (x: number) => x } as unknown as CalibrationService,
    );
    const ctx = {
      dto: { query: 'cats' },
      mode: 'hybrid',
      companyId: 'co_x',
      callerScopes: ['brain:read'],
      asOf: null,
      profile: resolveRetrievalProfileFor('co_x'),
    } as unknown as PipelineContext;
    const buckets = await svc.runSegmentLegStage(db as Surreal, ctx);
    expect(buckets.size).toBe(1);
    const bucket = buckets.get('episode_segment:s1')!;
    expect(bucket.facts[0]!.row.predicate).toBe('verbatim');
    expect(bucket.facts[0]!.row.stages).toContain('segment');
    expect(bucket.bestScore).toBeGreaterThan(0);
  });

  it('degrades to an empty map on a failing db', async () => {
    const svc = new SearchRetrievalService(
      { embed: async () => [1, 0] } as unknown as EmbedderService,
      { calibrate: (x: number) => x } as unknown as CalibrationService,
    );
    const db = {
      query: async () => {
        throw new Error('db down');
      },
    } as unknown as Surreal;
    const ctx = {
      dto: { query: 'cats' },
      mode: 'hybrid',
      companyId: 'co_x',
      callerScopes: [],
      asOf: null,
      profile: resolveRetrievalProfileFor('co_x'),
    } as unknown as PipelineContext;
    const buckets = await svc.runSegmentLegStage(db, ctx);
    expect(buckets.size).toBe(0);
  });
});

describe('SearchRetrievalService.runSegmentLegStage segmentTopK cap', () => {
  it('keeps only the top-K segment buckets by score', async () => {
    const rows = Array.from({ length: 9 }, (_, i) => ({
      id: `episode_segment:s${i}`,
      conversationId: 'conv-1',
      text: `window ${i}`,
      occurredAt: '2023-05-01T10:00:00Z',
      score: 0.9 - i * 0.05,
    }));
    const db = {
      query: async (sql: string) =>
        sql.includes('vector::similarity::cosine') ? [rows] : [[]],
    } as unknown as Surreal;
    const svc = new SearchRetrievalService(
      { embed: async () => [1, 0] } as unknown as EmbedderService,
      { calibrate: (x: number) => x } as unknown as CalibrationService,
    );
    const profile = resolveRetrievalProfileFor('co_x');
    const ctx = {
      dto: { query: 'cats' },
      mode: 'vector',
      companyId: 'co_x',
      callerScopes: [],
      asOf: null,
      profile,
    } as unknown as PipelineContext;
    const buckets = await svc.runSegmentLegStage(db, ctx);
    expect(profile.segmentTopK).toBe(5);
    expect(buckets.size).toBe(5);
    expect(buckets.has('episode_segment:s0')).toBe(true);
    expect(buckets.has('episode_segment:s8')).toBe(false);
  });
});

describe("profile verbatimEvidence 'fused'", () => {
  const saved = process.env.RETRIEVAL_VERBATIM_EVIDENCE;
  afterEach(() => {
    if (saved === undefined) delete process.env.RETRIEVAL_VERBATIM_EVIDENCE;
    else process.env.RETRIEVAL_VERBATIM_EVIDENCE = saved;
  });

  it('resolves from env and per-tenant overrides', () => {
    process.env.RETRIEVAL_VERBATIM_EVIDENCE = 'fused';
    expect(resolveRetrievalProfileFor('co_x').verbatimEvidence).toBe('fused');
    const profile = resolveRetrievalProfileFor('co_y', {
      ...process.env,
      RETRIEVAL_VERBATIM_EVIDENCE: 'shape_conditioned',
      RETRIEVAL_PROFILE_OVERRIDES: JSON.stringify({
        co_y: { verbatimEvidence: 'fused' },
      }),
    });
    expect(profile.verbatimEvidence).toBe('fused');
  });
});
