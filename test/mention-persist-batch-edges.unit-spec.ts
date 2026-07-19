import { MentionPersistService } from '../src/ingest/mention-persist.service';
import type { IngestMentionDto } from '../src/ingest/dto/ingest-mention.dto';

/**
 * INGEST_BATCH_EDGES — batched edge persistence. The per-edge loop and the
 * batched path must produce the SAME edge set (idempotent RELATE keyed on
 * UNIQUE(in,out,kind)); the batch just collapses N round-trips into two —
 * one multi-statement existence check, then one multi-statement RELATE for
 * only the edges that don't already exist. This suite drives the private
 * batched method against a fake DB that records queries so we can assert the
 * round-trip shape, the in-batch dedup, and the concurrent-race fallback.
 */
describe('MentionPersistService batched edge persistence', () => {
  type Q = { sql: string; params: Record<string, unknown> };

  /**
   * @param existingIdx  statement indices the existence check reports as present
   * @param relateThrows batch RELATE trips UNIQUE (concurrent-race simulation)
   */
  function fakeDb(opts: { existingIdx?: number[]; relateThrows?: boolean }) {
    const queries: Q[] = [];
    const existing = new Set(opts.existingIdx ?? []);
    const db = {
      query: async (sql: string, params: Record<string, unknown>) => {
        queries.push({ sql, params });
        const s = sql.trimStart();
        const indexedCount = () => {
          let i = 0;
          while (params[`f${i}`] !== undefined) i++;
          return i;
        };
        // Multi-statement existence check (batched, indexed params f0/t0/k0…).
        if (s.startsWith('SELECT id FROM knowledge_edge') && params.f0 !== undefined) {
          const n = indexedCount();
          return Array.from({ length: n }, (_v, i) =>
            existing.has(i) ? [{ id: `knowledge_edge:exist_${i}` }] : [],
          );
        }
        // Multi-statement RELATE (batched, indexed params).
        if (s.startsWith('RELATE') && params.f0 !== undefined) {
          if (opts.relateThrows) {
            throw new Error('Database index already contains a record');
          }
          const n = indexedCount();
          return Array.from({ length: n }, (_v, i) => [{ id: `knowledge_edge:new_${i}` }]);
        }
        // Per-edge createEdgeBetween RELATE (fallback path, flat params).
        if (s.startsWith('RELATE') && params.from !== undefined) {
          return [[{ id: `knowledge_edge:fb_${String(params.from)}_${String(params.to)}` }]];
        }
        return [[]];
      },
    };
    return { db, queries };
  }

  function make(): MentionPersistService {
    return new MentionPersistService(
      undefined as never,
      undefined as never,
      undefined as never,
    );
  }

  const dto = {
    contextRef: {
      vertical: 'locomo',
      eventId: 'ev1',
      conversationId: 'c1',
      messageId: 'm1',
    },
  } as unknown as IngestMentionDto;

  function run(
    svc: MentionPersistService,
    db: unknown,
    extraction: unknown,
    entityIds: string[],
  ): Promise<string[]> {
    return (
      svc as unknown as {
        persistEdgesBatched: (
          db: unknown,
          extraction: unknown,
          entityIds: string[],
          dto: IngestMentionDto,
        ) => Promise<string[]>;
      }
    ).persistEdgesBatched(db, extraction, entityIds, dto);
  }

  afterEach(() => {
    delete process.env.INGEST_BATCH_EDGES;
  });

  it('all-new edges → existence check + one RELATE batch (2 round-trips)', async () => {
    const { db, queries } = fakeDb({ existingIdx: [] });
    const extraction = {
      edges: [
        { fromEntityIndex: 0, toEntityIndex: 1, kind: 'knows', confidence: 0.9 },
        { fromEntityIndex: 1, toEntityIndex: 2, kind: 'likes', confidence: 0.8 },
      ],
    };
    const ids = await run(make(), db, extraction, ['entity:a', 'entity:b', 'entity:c']);
    expect(ids).toEqual(['knowledge_edge:new_0', 'knowledge_edge:new_1']);
    expect(queries).toHaveLength(2);
    expect(queries[0].sql.trimStart().startsWith('SELECT id FROM knowledge_edge')).toBe(
      true,
    );
    expect(queries[1].sql.trimStart().startsWith('RELATE')).toBe(true);
    // Edge content threaded through: kind + source with confidence.
    expect(queries[1].params.k0).toBe('knows');
    expect(queries[1].params.s0).toMatchObject({ vertical: 'locomo', confidence: 0.9 });
  });

  it('re-ingest (all edges already exist) → single round-trip, no RELATE', async () => {
    const { db, queries } = fakeDb({ existingIdx: [0, 1] });
    const extraction = {
      edges: [
        { fromEntityIndex: 0, toEntityIndex: 1, kind: 'knows', confidence: 0.9 },
        { fromEntityIndex: 1, toEntityIndex: 2, kind: 'likes', confidence: 0.8 },
      ],
    };
    const ids = await run(make(), db, extraction, ['entity:a', 'entity:b', 'entity:c']);
    expect(ids).toEqual(['knowledge_edge:exist_0', 'knowledge_edge:exist_1']);
    expect(queries).toHaveLength(1);
    expect(queries[0].sql.trimStart().startsWith('SELECT')).toBe(true);
  });

  it('mixed → existing kept, only missing RELATEd', async () => {
    const { db, queries } = fakeDb({ existingIdx: [0] });
    const extraction = {
      edges: [
        { fromEntityIndex: 0, toEntityIndex: 1, kind: 'knows', confidence: 0.9 },
        { fromEntityIndex: 1, toEntityIndex: 2, kind: 'likes', confidence: 0.8 },
      ],
    };
    const ids = await run(make(), db, extraction, ['entity:a', 'entity:b', 'entity:c']);
    expect(ids).toEqual(['knowledge_edge:exist_0', 'knowledge_edge:new_0']);
    expect(queries).toHaveLength(2);
    // Only ONE edge in the RELATE batch (the missing one).
    expect(queries[1].params.f1).toBeUndefined();
    expect(queries[1].params.k0).toBe('likes');
  });

  it('in-batch duplicate (from,to,kind) collapses to one candidate', async () => {
    const { db, queries } = fakeDb({ existingIdx: [] });
    const extraction = {
      edges: [
        { fromEntityIndex: 0, toEntityIndex: 1, kind: 'knows', confidence: 0.9 },
        { fromEntityIndex: 0, toEntityIndex: 1, kind: 'knows', confidence: 0.5 },
      ],
    };
    const ids = await run(make(), db, extraction, ['entity:a', 'entity:b']);
    expect(ids).toEqual(['knowledge_edge:new_0']);
    // Existence check has exactly one statement (no f1).
    expect(queries[0].params.f1).toBeUndefined();
  });

  it('skips self-edges and unresolved entity indexes', async () => {
    const { db, queries } = fakeDb({ existingIdx: [] });
    const extraction = {
      edges: [
        { fromEntityIndex: 0, toEntityIndex: 0, kind: 'self', confidence: 1 }, // self
        { fromEntityIndex: 0, toEntityIndex: 5, kind: 'dangling', confidence: 1 }, // no entity[5]
        { fromEntityIndex: 0, toEntityIndex: 1, kind: 'knows', confidence: 0.9 }, // valid
      ],
    };
    const ids = await run(make(), db, extraction, ['entity:a', 'entity:b']);
    expect(ids).toEqual(['knowledge_edge:new_0']);
    expect(queries[0].params.f1).toBeUndefined(); // only the one valid candidate
  });

  it('empty edge set → no query, empty result', async () => {
    const { db, queries } = fakeDb({ existingIdx: [] });
    const ids = await run(make(), db, { edges: [] }, ['entity:a']);
    expect(ids).toEqual([]);
    expect(queries).toHaveLength(0);
  });

  it('concurrent-race unique violation → per-edge fallback, no ids lost', async () => {
    const { db, queries } = fakeDb({ existingIdx: [], relateThrows: true });
    const extraction = {
      edges: [
        { fromEntityIndex: 0, toEntityIndex: 1, kind: 'knows', confidence: 0.9 },
        { fromEntityIndex: 1, toEntityIndex: 2, kind: 'likes', confidence: 0.8 },
      ],
    };
    const ids = await run(make(), db, extraction, ['entity:a', 'entity:b', 'entity:c']);
    // Both edges still resolved via the per-edge idempotent primitive.
    expect(ids).toEqual([
      'knowledge_edge:fb_entity:a_entity:b',
      'knowledge_edge:fb_entity:b_entity:c',
    ]);
    // existence + failed batch RELATE + 2 per-edge RELATEs = 4 queries.
    expect(queries).toHaveLength(4);
  });

  it('flag dispatch: persistEdges routes to the batched path when INGEST_BATCH_EDGES=1', async () => {
    process.env.INGEST_BATCH_EDGES = '1';
    const { db, queries } = fakeDb({ existingIdx: [] });
    const extraction = {
      edges: [{ fromEntityIndex: 0, toEntityIndex: 1, kind: 'knows', confidence: 0.9 }],
    };
    const ids = await (
      make() as unknown as {
        persistEdges: (
          db: unknown,
          p: { extraction: unknown; entityIds: string[]; dto: IngestMentionDto },
        ) => Promise<string[]>;
      }
    ).persistEdges(db, { extraction, entityIds: ['entity:a', 'entity:b'], dto });
    expect(ids).toEqual(['knowledge_edge:new_0']);
    // Batched shape (existence check first), not the per-edge loop.
    expect(queries[0].sql.trimStart().startsWith('SELECT id FROM knowledge_edge')).toBe(
      true,
    );
  });
});
