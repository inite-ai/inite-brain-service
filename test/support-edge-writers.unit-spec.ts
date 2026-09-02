/**
 * Typed support graph writers (Drift-5, PROVENANCE_SUPPORT_EDGES) —
 * scene-backlink (supported_by) and the conflict resolver
 * (contradicted_by). Both flag-off cases pin BYTE-IDENTICAL query
 * sequences (the exact SQL strings issued today); the flag-on cases pin
 * the INSERT RELATION IGNORE payload shape. The derived_from mirrors of
 * the three summary writers are covered in compaction.unit-spec.ts /
 * recompose.unit-spec.ts next to their episode-stamp siblings.
 */
import { SceneBacklinkService } from '../src/admin/scene-backlink.service';
import { SEGMENTER_VERSION } from '../src/admin/scene-segmentation';
import type { SceneVersionService } from '../src/admin/scene-version';
import { FactResolverService } from '../src/ingest/fact-resolver.service';
import type { SurrealService } from '../src/db/surreal.service';

interface QueryCall {
  sql: string;
  params?: Record<string, unknown> | undefined;
}

const SAVED = {
  edges: process.env.PROVENANCE_SUPPORT_EDGES,
  backlink: process.env.SCENES_FACT_BACKLINK,
};
afterEach(() => {
  if (SAVED.edges === undefined) delete process.env.PROVENANCE_SUPPORT_EDGES;
  else process.env.PROVENANCE_SUPPORT_EDGES = SAVED.edges;
  if (SAVED.backlink === undefined) delete process.env.SCENES_FACT_BACKLINK;
  else process.env.SCENES_FACT_BACKLINK = SAVED.backlink;
});

describe('SceneBacklinkService — supported_by edges', () => {
  function makeStack() {
    const calls: QueryCall[] = [];
    const fakeDb = {
      async query<R>(sql: string, params?: Record<string, unknown>): Promise<R> {
        calls.push({ sql, params });
        if (sql.includes('FROM memory_episode WHERE segmenterVersion')) {
          return [[{ id: 'memory_episode:s1', conversationIds: ['conv1'] }]] as unknown as R;
        }
        if (sql.includes('FROM memory_episode_member WHERE in = $scene')) {
          return [[{ out: 'episode:e1' }, { out: 'episode:e2' }]] as unknown as R;
        }
        if (sql.includes('FROM knowledge_fact')) {
          return [
            [
              { id: 'knowledge_fact:f1', episodeIds: ['episode:e1'] },
              { id: 'knowledge_fact:f2', episodeIds: ['episode:other'] },
              { id: 'knowledge_fact:f3', episodeIds: ['episode:e2'] },
            ],
          ] as unknown as R;
        }
        return [[]] as unknown as R;
      },
    };
    const surreal = {
      withCompany: async <T>(_c: string, fn: (db: unknown) => Promise<T>) => fn(fakeDb),
    } as unknown as SurrealService;
    // Fingerprint flag off in the unit env ⇒ the real service resolves to
    // the literal SEGMENTER_VERSION; the stub pins that same contract
    // (scene-enrichment.unit-spec pattern).
    const fakeVersions = {
      resolve: () => ({
        version: SEGMENTER_VERSION,
        cfg: { topicBoundary: false, minCosine: 0.55, maxTurns: 40, embeddingSpaceId: null },
      }),
    } as unknown as SceneVersionService;
    return { svc: new SceneBacklinkService(surreal, fakeVersions), calls };
  }

  it('flag OFF (default): the query sequence is byte-identical — no memory_support anywhere', async () => {
    process.env.SCENES_FACT_BACKLINK = '1';
    delete process.env.PROVENANCE_SUPPORT_EDGES;
    const { svc, calls } = makeStack();
    const result = await svc.run('co_x');
    expect(result).toEqual({ scenes: 1, factsLinked: 2 });
    // The exact statement sequence of the pre-edge writer, in order.
    expect(calls.map((c) => c.sql.split(/\s+/).join(' ').trim())).toEqual([
      'SELECT id, conversationIds FROM memory_episode WHERE segmenterVersion = $v',
      'SELECT out FROM memory_episode_member WHERE in = $scene',
      'SELECT id, source.episodeIds AS episodeIds FROM knowledge_fact WHERE source.conversationId = $conv',
      'UPDATE knowledge_fact SET source.memoryEpisodeIds = array::union(source.memoryEpisodeIds ?? [], [$sceneId]), source.sceneLinkVersion = $v WHERE id INSIDE $factIds',
    ]);
  });

  it('flag ON: INSERT RELATION IGNORE lands AFTER the stamp UPDATE, stamps untouched', async () => {
    process.env.SCENES_FACT_BACKLINK = '1';
    process.env.PROVENANCE_SUPPORT_EDGES = '1';
    const { svc, calls } = makeStack();
    await svc.run('co_x');
    const updateIdx = calls.findIndex((c) => c.sql.includes('UPDATE knowledge_fact'));
    const insertIdx = calls.findIndex((c) =>
      c.sql.includes('INSERT RELATION IGNORE INTO memory_support'),
    );
    expect(updateIdx).toBeGreaterThanOrEqual(0);
    expect(insertIdx).toBeGreaterThan(updateIdx);
    const rows = calls[insertIdx]!.params!.rows as Array<Record<string, unknown>>;
    expect(rows.map((r) => ({ ...r, in: String(r.in), out: String(r.out) }))).toEqual([
      {
        in: 'knowledge_fact:f1',
        out: 'memory_episode:s1',
        kind: 'supported_by',
        writer: 'scene_backlink',
        writerVersion: SEGMENTER_VERSION,
      },
      {
        in: 'knowledge_fact:f3',
        out: 'memory_episode:s1',
        kind: 'supported_by',
        writer: 'scene_backlink',
        writerVersion: SEGMENTER_VERSION,
      },
    ]);
    // The stamp UPDATE itself is untouched by the flag.
    expect(calls[updateIdx]!.params!.factIds).toEqual(['knowledge_fact:f1', 'knowledge_fact:f3']);
  });

  it('master flag off (SCENES_FACT_BACKLINK unset): no queries at all, either way', async () => {
    delete process.env.SCENES_FACT_BACKLINK;
    process.env.PROVENANCE_SUPPORT_EDGES = '1';
    const { svc, calls } = makeStack();
    const result = await svc.run('co_x');
    expect(result).toEqual({ scenes: 0, factsLinked: 0 });
    expect(calls).toEqual([]);
  });
});

describe('FactResolverService — contradicted_by edges at the postResolve seam', () => {
  function makeStack(outcome: Record<string, unknown>) {
    const calls: QueryCall[] = [];
    const db = {
      query: jest.fn(async (sql: string, params?: Record<string, unknown>) => {
        calls.push({ sql, params });
        if (sql.includes('fn::resolve_fact')) return [outcome];
        return [[]];
      }),
    };
    const factEmbedding = {
      embed: jest.fn(async () => [0.1]),
      writeAltEmbeddingIfHype: jest.fn(async () => {}),
    };
    const predicateRegistry = {
      getSnapshot: jest.fn(async () => ({})),
      policyFor: jest.fn(() => ({ semantics: 'single_active' })),
    };
    const svc = new FactResolverService(factEmbedding as never, predicateRegistry as never);
    return { svc, db, calls };
  }

  const input = {
    companyId: 'co_x',
    entityId: 'knowledge_entity:e1',
    predicate: 'status',
    object: 'active customer',
    confidence: 0.9,
    validFrom: new Date('2026-01-01T00:00:00Z'),
    source: {},
    precomputedEmbedding: [0.1, 0.2],
  };

  const supportCalls = (calls: QueryCall[]) =>
    calls.filter((c) => c.sql.includes('memory_support'));

  it('flag OFF (default): NO memory_support query on any verdict', async () => {
    delete process.env.PROVENANCE_SUPPORT_EDGES;
    const { svc, db, calls } = makeStack({
      outcome: 'SUPERSEDED',
      factId: 'knowledge_fact:new',
      supersededFactIds: ['knowledge_fact:old'],
    });
    await svc.resolve(db as never, input);
    expect(supportCalls(calls)).toEqual([]);
  });

  it('flag ON, SUPERSEDED: one INSERT, loser → winner', async () => {
    process.env.PROVENANCE_SUPPORT_EDGES = '1';
    const { svc, db, calls } = makeStack({
      outcome: 'SUPERSEDED',
      factId: 'knowledge_fact:new',
      supersededFactIds: ['knowledge_fact:old'],
    });
    await svc.resolve(db as never, input);
    const inserts = supportCalls(calls);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.sql).toContain('INSERT RELATION IGNORE INTO memory_support');
    const rows = inserts[0]!.params!.rows as Array<Record<string, unknown>>;
    expect(rows.map((r) => ({ ...r, in: String(r.in), out: String(r.out) }))).toEqual([
      {
        in: 'knowledge_fact:old',
        out: 'knowledge_fact:new',
        kind: 'contradicted_by',
        writer: 'fact_resolver',
      },
    ]);
  });

  it('flag ON, COMPETING: the mutual pair per standing competitor', async () => {
    process.env.PROVENANCE_SUPPORT_EDGES = '1';
    const { svc, db, calls } = makeStack({
      outcome: 'COMPETING',
      factId: 'knowledge_fact:new',
      competingFactIds: ['knowledge_fact:standing'],
    });
    await svc.resolve(db as never, input);
    const rows = supportCalls(calls)[0]!.params!.rows as Array<Record<string, unknown>>;
    expect(rows.map((r) => [String(r.in), String(r.out)])).toEqual([
      ['knowledge_fact:standing', 'knowledge_fact:new'],
      ['knowledge_fact:new', 'knowledge_fact:standing'],
    ]);
  });

  it('flag ON, INSERTED/REJECTED: no edge write', async () => {
    process.env.PROVENANCE_SUPPORT_EDGES = '1';
    for (const outcome of ['INSERTED', 'REJECTED']) {
      const { svc, db, calls } = makeStack({ outcome, factId: 'knowledge_fact:new' });
      await svc.resolve(db as never, input);
      expect(supportCalls(calls)).toEqual([]);
    }
  });

  it('flag ON: an edge-write failure warns, never fails the ingest', async () => {
    process.env.PROVENANCE_SUPPORT_EDGES = '1';
    const { svc, db } = makeStack({
      outcome: 'SUPERSEDED',
      factId: 'knowledge_fact:new',
      supersededFactIds: ['knowledge_fact:old'],
    });
    db.query.mockImplementation(async (sql: string) => {
      if (sql.includes('memory_support')) throw new Error('unique index blew up');
      if (sql.includes('fn::resolve_fact')) {
        return [
          {
            outcome: 'SUPERSEDED',
            factId: 'knowledge_fact:new',
            supersededFactIds: ['knowledge_fact:old'],
          },
        ];
      }
      return [[]];
    });
    const { result } = await svc.resolve(db as never, input);
    expect(result.outcome).toBe('SUPERSEDED');
  });
});
