/**
 * Scene gist encoder pass (Brain v2 PR3, SCENES_GIST_EMBEDDING) — the
 * producer the 0106 `gistEmbedding` column never had, over a scripted
 * Surreal/embedder double. No network, no Nest, no paid calls.
 *
 * Pins:
 *   - FLAG OFF is byte-identical: zero queries, zero embed calls (both
 *     doubles THROW if touched) and an all-zero result;
 *   - selection: only scenes of the CURRENT effective world that carry NO
 *     vector, bounded by SCENE_EMBED_MAX_PER_RUN, ordered for determinism;
 *   - BOTH GIST KINDS: the pass embeds the canonical `gist`, never the
 *     enricher's `enrichedGist` revision sibling — one seam covering the
 *     deterministic AND the LLM-enriched world, and the same text the
 *     reindex sweep re-embeds;
 *   - ONE embedMany batch per run (never one call per scene);
 *   - the write is a BOUND-ID UPDATE (never a WHERE over an indexed
 *     field — the 3.2.4 planner bug);
 *   - space stamp = the fact-side convention: written ONLY under
 *     EMBEDDING_SPACE_TRACKING, and always together with the vector;
 *   - a blank gist is never embedded (no zero vector enters the space);
 *   - an embed failure SOFT-fails the run: warn, count, no write, no throw;
 *   - the composer's post-swap hook is skipped with the flag off (pinned
 *     with a throwing encoder stub).
 */
import type { SurrealService } from '../src/db/surreal.service';
import type { FactEmbeddingService } from '../src/ingest/fact-embedding.service';
import type { SceneVersionService } from '../src/admin/scene-version';
import type { EpisodeReadStoreService } from '../src/episodes/episode-read-store.service';
import type { ProjectionRegistryService } from '../src/episodes/projection-registry.service';
import type { SceneEnricherService } from '../src/admin/scene-enricher.service';
import type { SceneBacklinkService } from '../src/admin/scene-backlink.service';
import type { SceneEvidenceLinkerService } from '../src/admin/scene-evidence-linker.service';
import {
  SceneGistEmbeddingService,
  SCENE_EMBED_MAX_PER_RUN,
} from '../src/admin/scene-gist-embedding.service';
import { SceneComposerService } from '../src/admin/scene-composer.service';
import { SEGMENTER_VERSION } from '../src/admin/scene-segmentation';

const SAVED = {
  gistEmbedding: process.env.SCENES_GIST_EMBEDDING,
  spaceTracking: process.env.EMBEDDING_SPACE_TRACKING,
  segmentation: process.env.SCENES_SEGMENTATION_ENABLED,
};
const restore = () => {
  for (const [k, v] of [
    ['SCENES_GIST_EMBEDDING', SAVED.gistEmbedding],
    ['EMBEDDING_SPACE_TRACKING', SAVED.spaceTracking],
    ['SCENES_SEGMENTATION_ENABLED', SAVED.segmentation],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
};

const SPACE_ID = 'openai:text-embedding-3-small:1536:l2';

interface Captured {
  queries: Array<{ sql: string; params: Record<string, unknown> | undefined }>;
  batches: string[][];
}

interface BuildOpts {
  /** Rows the selection SELECT returns. */
  rows?: Array<Record<string, unknown>>;
  /** Throw from embedMany (the soft-fail path). */
  failEmbed?: boolean;
  /** Throw from the per-row UPDATE (the per-row degrade). */
  failWrite?: boolean;
}

function build(opts: BuildOpts = {}): { svc: SceneGistEmbeddingService; captured: Captured } {
  const captured: Captured = { queries: [], batches: [] };
  const db = {
    query: async (sql: string, params?: Record<string, unknown>) => {
      captured.queries.push({ sql, params });
      if (sql.includes('UPDATE $id')) {
        if (opts.failWrite) throw new Error('write boom');
        return [[]];
      }
      if (sql.includes('FROM memory_episode')) return [opts.rows ?? []];
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const surreal = {
    withCompany: async (_c: string, fn: (d: typeof db) => Promise<unknown>) => fn(db),
  } as unknown as SurrealService;
  const embedding = {
    embedMany: async (texts: string[]) => {
      captured.batches.push(texts);
      if (opts.failEmbed) throw new Error('embedder down');
      return texts.map((_t, i) => [i + 1, 0, 0]);
    },
    activeSpaceId: () => SPACE_ID,
  } as unknown as FactEmbeddingService;
  const versions = {
    resolve: () => ({
      version: SEGMENTER_VERSION,
      cfg: { topicBoundary: false, minCosine: 0.55, maxTurns: 40, embeddingSpaceId: null },
    }),
  } as unknown as SceneVersionService;
  return { svc: new SceneGistEmbeddingService(surreal, embedding, versions), captured };
}

/** The double every OFF-path test uses: any touch at all is a failure. */
function throwingDoubles(): {
  surreal: SurrealService;
  embedding: FactEmbeddingService;
  versions: SceneVersionService;
} {
  return {
    surreal: {
      withCompany: async () => {
        throw new Error('no query may be issued with SCENES_GIST_EMBEDDING off');
      },
    } as unknown as SurrealService,
    embedding: {
      embedMany: async () => {
        throw new Error('the embedder must not be called with SCENES_GIST_EMBEDDING off');
      },
      activeSpaceId: () => {
        throw new Error('the space must not be resolved with SCENES_GIST_EMBEDDING off');
      },
    } as unknown as FactEmbeddingService,
    versions: {
      resolve: () => {
        throw new Error('no version may be resolved with SCENES_GIST_EMBEDDING off');
      },
    } as unknown as SceneVersionService,
  };
}

const scene = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  gist: `2026-07-01 10:00 · 2 turns — opens: "${id}"`,
  ...over,
});

const updates = (c: Captured) => c.queries.filter((q) => q.sql.includes('UPDATE $id'));
const selects = (c: Captured) => c.queries.filter((q) => q.sql.startsWith('SELECT'));

describe('SceneGistEmbeddingService — the flag-off pin', () => {
  afterAll(restore);

  it('flag off ⇒ NO query, NO embed call, NO version resolve, all-zero result', async () => {
    delete process.env.SCENES_GIST_EMBEDDING;
    const d = throwingDoubles();
    const svc = new SceneGistEmbeddingService(d.surreal, d.embedding, d.versions);
    await expect(svc.run('co_test')).resolves.toEqual({
      scenes: 0,
      embedded: 0,
      skipped: 0,
      failed: 0,
    });
  });
});

describe('SceneGistEmbeddingService — selection, batching and the write', () => {
  beforeAll(() => {
    process.env.SCENES_GIST_EMBEDDING = '1';
    delete process.env.EMBEDDING_SPACE_TRACKING;
  });
  afterAll(restore);

  it('selects only vector-less scenes of the current world, bounded and ordered', async () => {
    const { svc, captured } = build({ rows: [scene('memory_episode:s1')] });
    await svc.run('co_test');
    const select = selects(captured)[0]!;
    expect(select.sql).toContain('FROM memory_episode');
    expect(select.sql).toContain('segmenterVersion = $v');
    // The idempotency fence: a scene that already carries a vector is
    // never re-embedded here (moving vectors between spaces is the
    // reindex sweep's job, not this pass's).
    expect(select.sql).toContain('gistEmbedding IS NONE');
    expect(select.sql).toContain('ORDER BY id');
    expect(select.sql).toContain('LIMIT $cap');
    // No conversation narrowing unless the caller asked for one.
    expect(select.sql).not.toContain('conversationIds');
    expect(select.params).toEqual({ v: SEGMENTER_VERSION, cap: SCENE_EMBED_MAX_PER_RUN });
  });

  it('narrows to one conversation when asked', async () => {
    const { svc, captured } = build({ rows: [] });
    await svc.run('co_test', { conversationId: 'proj:c1' });
    const select = selects(captured)[0]!;
    expect(select.sql).toContain('AND conversationIds CONTAINS $conv');
    expect(select.params).toMatchObject({ conv: 'proj:c1' });
  });

  it('embeds the CANONICAL gist — never the enricher’s enrichedGist sibling', async () => {
    // BOTH GIST KINDS through one seam: an ENRICHED scene still has its
    // immutable `gist` encoded, which is exactly the text the 0106 BM25
    // index covers and the text the reindex sweep re-embeds.
    const { svc, captured } = build({
      rows: [
        scene('memory_episode:plain'),
        {
          id: 'memory_episode:enriched',
          gist: 'deterministic render',
          enrichedGist: 'an abstractive summary the model wrote',
        },
      ],
    });
    const result = await svc.run('co_test');
    expect(result).toEqual({ scenes: 2, embedded: 2, skipped: 0, failed: 0 });
    // ONE batch for the whole run, not one call per scene.
    expect(captured.batches).toHaveLength(1);
    expect(captured.batches[0]).toEqual([
      '2026-07-01 10:00 · 2 turns — opens: "memory_episode:plain"',
      'deterministic render',
    ]);
    expect(captured.batches[0]!.join(' ')).not.toContain('abstractive');
  });

  it('writes each vector by BOUND ID, with no space column while tracking is off', async () => {
    const { svc, captured } = build({ rows: [scene('memory_episode:s1')] });
    await svc.run('co_test');
    const [update] = updates(captured);
    expect(update!.sql).toBe('UPDATE $id SET gistEmbedding = $embedding');
    // Primary-key addressed — never a WHERE over an indexed field.
    expect(update!.sql).not.toContain('WHERE');
    expect(update!.params).toEqual({ id: 'memory_episode:s1', embedding: [1, 0, 0] });
    expect(update!.params).not.toHaveProperty('space');
  });

  it('a blank gist is skipped — never embedded, never written', async () => {
    const { svc, captured } = build({
      rows: [scene('memory_episode:ok'), { id: 'memory_episode:blank', gist: '   ' }],
    });
    const result = await svc.run('co_test');
    expect(result).toEqual({ scenes: 2, embedded: 1, skipped: 1, failed: 0 });
    expect(captured.batches[0]).toHaveLength(1);
    expect(updates(captured)).toHaveLength(1);
  });

  it('nothing to do ⇒ no batch and no write', async () => {
    const { svc, captured } = build({ rows: [] });
    const result = await svc.run('co_test');
    expect(result).toEqual({ scenes: 0, embedded: 0, skipped: 0, failed: 0 });
    expect(captured.batches).toEqual([]);
    expect(updates(captured)).toEqual([]);
  });
});

describe('SceneGistEmbeddingService — the space stamp (the fact-side convention)', () => {
  afterAll(restore);

  it('EMBEDDING_SPACE_TRACKING on ⇒ vector and space id are written TOGETHER', async () => {
    process.env.SCENES_GIST_EMBEDDING = '1';
    process.env.EMBEDDING_SPACE_TRACKING = '1';
    const { svc, captured } = build({ rows: [scene('memory_episode:s1')] });
    await svc.run('co_test');
    const [update] = updates(captured);
    // Verbatim the reindex engine's writeVector clause, with this table's
    // vector column — so a space migration treats scenes like every other
    // embedded surface.
    expect(update!.sql).toBe(
      'UPDATE $id SET gistEmbedding = $embedding, embeddingSpaceId = $space',
    );
    expect(update!.params).toMatchObject({ space: SPACE_ID });
  });

  it('tracking off ⇒ the space is never even resolved', async () => {
    process.env.SCENES_GIST_EMBEDDING = '1';
    delete process.env.EMBEDDING_SPACE_TRACKING;
    const { captured } = build({ rows: [scene('memory_episode:s1')] });
    const surreal = {
      withCompany: async (_c: string, fn: (d: unknown) => Promise<unknown>) =>
        fn({
          query: async (sql: string, params?: Record<string, unknown>) => {
            captured.queries.push({ sql, params });
            return [sql.includes('UPDATE') ? [] : [scene('memory_episode:s1')]];
          },
        }),
    } as unknown as SurrealService;
    const embedding = {
      embedMany: async (t: string[]) => t.map(() => [1, 0, 0]),
      activeSpaceId: () => {
        throw new Error('activeSpaceId must not be called with tracking off');
      },
    } as unknown as FactEmbeddingService;
    const versions = {
      resolve: () => ({
        version: SEGMENTER_VERSION,
        cfg: { topicBoundary: false, minCosine: 0.55, maxTurns: 40, embeddingSpaceId: null },
      }),
    } as unknown as SceneVersionService;
    await expect(
      new SceneGistEmbeddingService(surreal, embedding, versions).run('co_test'),
    ).resolves.toMatchObject({ embedded: 1 });
  });
});

describe('SceneGistEmbeddingService — degrade, never fail', () => {
  beforeAll(() => {
    process.env.SCENES_GIST_EMBEDDING = '1';
    delete process.env.EMBEDDING_SPACE_TRACKING;
  });
  afterAll(restore);

  it('an embed-batch failure soft-fails the run: warn, count, no write, no throw', async () => {
    const { svc, captured } = build({
      rows: [scene('memory_episode:a'), scene('memory_episode:b')],
      failEmbed: true,
    });
    const warn = jest
      .spyOn((svc as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn')
      .mockImplementation(() => undefined);
    const result = await svc.run('co_test');
    expect(result).toEqual({ scenes: 2, embedded: 0, skipped: 0, failed: 2 });
    expect(updates(captured)).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('embed batch failed'));
  });

  it('a per-row write failure is counted, not thrown', async () => {
    const { svc, captured } = build({ rows: [scene('memory_episode:a')], failWrite: true });
    jest
      .spyOn((svc as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn')
      .mockImplementation(() => undefined);
    const result = await svc.run('co_test');
    expect(result).toEqual({ scenes: 1, embedded: 0, skipped: 0, failed: 1 });
    expect(updates(captured)).toHaveLength(1);
  });
});

describe('SceneComposerService — the post-swap encoder hook', () => {
  afterAll(restore);

  /** Composer wired against no-op collaborators; only the hook matters. */
  function composerWith(encoder: SceneGistEmbeddingService): SceneComposerService {
    const surreal = {
      withCompany: async (_c: string, fn: (d: unknown) => Promise<unknown>) =>
        fn({ query: async () => [[]] }),
    } as unknown as SurrealService;
    return new SceneComposerService(
      surreal,
      { embedMany: async () => [] } as unknown as FactEmbeddingService,
      { conversationCounts: async () => [] } as unknown as EpisodeReadStoreService,
      {
        begin: async () => undefined,
        complete: async () => undefined,
        fail: async () => undefined,
        markResidual: async () => undefined,
      } as unknown as ProjectionRegistryService,
      {} as unknown as SceneEnricherService,
      {} as unknown as SceneBacklinkService,
      {} as unknown as SceneEvidenceLinkerService,
      {
        resolve: () => ({
          version: SEGMENTER_VERSION,
          cfg: { topicBoundary: false, minCosine: 0.55, maxTurns: 40, embeddingSpaceId: null },
        }),
      } as unknown as SceneVersionService,
      encoder,
    );
  }

  it('SCENES_GIST_EMBEDDING off ⇒ the encoder is NEVER called and no field is added', async () => {
    process.env.SCENES_SEGMENTATION_ENABLED = '1';
    delete process.env.SCENES_GIST_EMBEDDING;
    const throwing = {
      run: async () => {
        throw new Error('the encoder must not run with SCENES_GIST_EMBEDDING off');
      },
    } as unknown as SceneGistEmbeddingService;
    const result = await composerWith(throwing).run('co_test');
    expect(result.gistEmbedded).toBeUndefined();
  });

  it('flag on ⇒ the encoder runs after the swap and its count is surfaced', async () => {
    process.env.SCENES_SEGMENTATION_ENABLED = '1';
    process.env.SCENES_GIST_EMBEDDING = '1';
    const encoder = {
      run: async () => ({ scenes: 3, embedded: 3, skipped: 0, failed: 0 }),
    } as unknown as SceneGistEmbeddingService;
    const result = await composerWith(encoder).run('co_test');
    expect(result.gistEmbedded).toBe(3);
  });
});
