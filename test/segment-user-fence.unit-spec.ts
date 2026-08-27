import { segmentUserGate } from '../src/auth/segment-scope';
import { SegmentLaneService } from '../src/synthesize/segment-lane.service';
import { MentionScanService } from '../src/synthesize/mention-scan.service';
import { runSegmentLegs } from '../src/search/internals/segment-leg';
import { SegmentComposerService } from '../src/admin/segment-composer.service';
import { SceneComposerService } from '../src/admin/scene-composer.service';
import { SEGMENTER_VERSION } from '../src/admin/scene-segmentation';
import { EpisodeReadStoreService } from '../src/episodes/episode-read-store.service';
import type { SurrealService } from '../src/db/surreal.service';
import type { EmbedderService } from '../src/ai/embedder.service';
import type { FactEmbeddingService } from '../src/ingest/fact-embedding.service';
import type { ProjectionRegistryService } from '../src/episodes/projection-registry.service';
import type { SceneEnricherService } from '../src/admin/scene-enricher.service';
import type { SceneBacklinkService } from '../src/admin/scene-backlink.service';
import type { SceneVersionService } from '../src/admin/scene-version';

/**
 * Mixed-user scope fence (migration 0117, PRIVACY_SEGMENT_USER_FENCE).
 *
 * THE DEFECT: a window whose member turns belong to ≥2 users folds to
 * userId = NONE (tenant-global), so the legacy 0055 gate served a mixed
 * A+B window — verbatim text included — to EVERY user-scoped caller.
 * These pin the shared segmentUserGate() across ALL FOUR read seams
 * (fence off ≡ today's exact strings; fence on = per-member
 * visibility, fail-closed on un-backfilled rows) and the write side
 * (both composers persist the sorted member set).
 */
const GLOBAL_ONLY = 'AND userId IS NONE';
const SCOPED_LEGACY = 'AND (userId IS NONE OR userId = $scopeUserId)';
const SCOPED_FENCED =
  'AND (userId = $scopeUserId OR (userId IS NONE AND userIds IS NOT NONE AND (array::len(userIds) = 0 OR userIds CONTAINS $scopeUserId)))';

const savedFence = process.env.PRIVACY_SEGMENT_USER_FENCE;
function fenceOn(): void {
  process.env.PRIVACY_SEGMENT_USER_FENCE = '1';
}
function fenceOff(): void {
  delete process.env.PRIVACY_SEGMENT_USER_FENCE;
}
afterEach(() => {
  if (savedFence === undefined) delete process.env.PRIVACY_SEGMENT_USER_FENCE;
  else process.env.PRIVACY_SEGMENT_USER_FENCE = savedFence;
});

function recorder(): {
  surreal: SurrealService;
  queries: Array<{ sql: string; params?: Record<string, unknown> | undefined }>;
} {
  const queries: Array<{ sql: string; params?: Record<string, unknown> | undefined }> = [];
  const surreal = {
    withCompany: async (_co: string, fn: (db: unknown) => Promise<unknown>) =>
      fn({
        query: async (sql: string, params?: Record<string, unknown>) => {
          queries.push({ sql, params });
          return [[]];
        },
      }),
  } as unknown as SurrealService;
  return { surreal, queries };
}

describe('segmentUserGate (the ONE gate of all four seams)', () => {
  it('fence off: byte-identical legacy strings', () => {
    fenceOff();
    expect(segmentUserGate(undefined)).toEqual({ clause: GLOBAL_ONLY, params: {} });
    expect(segmentUserGate('u1')).toEqual({
      clause: SCOPED_LEGACY,
      params: { scopeUserId: 'u1' },
    });
  });

  it('fence on: per-member visibility, fail-closed on userIds IS NONE', () => {
    fenceOn();
    const gate = segmentUserGate('u1');
    expect(gate.clause).toBe(SCOPED_FENCED);
    expect(gate.params).toEqual({ scopeUserId: 'u1' });
    // The fail-closed leg is load-bearing: a pre-backfill row (userIds
    // IS NONE) must be hidden, never treated as global.
    expect(gate.clause).toContain('userIds IS NOT NONE');
  });

  it('fence on: tenant-global caller unchanged (M2M keeps the tenant boundary)', () => {
    fenceOn();
    expect(segmentUserGate(undefined)).toEqual({ clause: GLOBAL_ONLY, params: {} });
  });
});

interface SeamCase {
  name: string;
  /** Runs the seam; resolves to the recorded seam queries. */
  run: (
    userId: string | undefined,
  ) => Promise<Array<{ sql: string; params?: Record<string, unknown> | undefined }>>;
  /** How many recorded queries must carry the gate. */
  gated: number;
}

function makeLaneSeam(method: 'transcriptLines' | 'topSegmentAnchors'): SeamCase {
  return {
    name: `segment lane ${method}`,
    gated: 2,
    run: async (userId) => {
      const { surreal, queries } = recorder();
      const embedder = { embed: async () => [1, 0] } as unknown as EmbedderService;
      const svc = new SegmentLaneService(surreal, embedder);
      if (method === 'transcriptLines') {
        await svc.transcriptLines({
          companyId: 'co_x',
          query: 'q',
          callerScopes: ['brain:read'],
          userId,
          topK: 5,
          rerank: false,
        });
      } else {
        await svc.topSegmentAnchors({
          companyId: 'co_x',
          query: 'q',
          callerScopes: ['brain:read'],
          userId,
          limit: 5,
        });
      }
      return queries;
    },
  };
}

const seams: SeamCase[] = [
  makeLaneSeam('transcriptLines'),
  makeLaneSeam('topSegmentAnchors'),
  {
    name: 'fused search leg (runSegmentLegs)',
    gated: 2,
    run: async (userId) => {
      const queries: Array<{ sql: string; params?: Record<string, unknown> | undefined }> = [];
      const db = {
        query: async (sql: string, params?: Record<string, unknown>) => {
          queries.push({ sql, params });
          return [[]];
        },
      };
      await runSegmentLegs({
        db: db as never,
        queryText: 'q',
        queryVector: [1, 0],
        fetchK: 12,
        callerScopes: ['brain:read'],
        userId,
        mode: 'hybrid',
      });
      return queries;
    },
  },
  {
    name: 'mention scan (mentionLines)',
    gated: 2,
    run: async (userId) => {
      const { surreal, queries } = recorder();
      const embedder = { embed: async () => [1, 0] } as unknown as EmbedderService;
      await new MentionScanService(surreal, embedder).mentionLines({
        companyId: 'co_x',
        query: 'when did we discuss the trip',
        callerScopes: ['brain:read'],
        userId,
      });
      return queries;
    },
  },
];

describe.each(seams.map((s) => [s.name, s] as const))('seam: %s', (_name, seam) => {
  it("fence off + scoped: today's exact legacy clause on every leg", async () => {
    fenceOff();
    const queries = await seam.run('u1');
    expect(queries.length).toBeGreaterThanOrEqual(seam.gated);
    for (const q of queries) {
      expect(q.sql).toContain(SCOPED_LEGACY);
      expect(q.params?.scopeUserId).toBe('u1');
    }
  });

  it('fence off + unscoped: tenant-global only', async () => {
    fenceOff();
    const queries = await seam.run(undefined);
    for (const q of queries) {
      expect(q.sql).toContain(GLOBAL_ONLY);
      expect(q.params?.scopeUserId).toBeUndefined();
    }
  });

  it('fence on + scoped: per-member clause incl. the fail-closed leg', async () => {
    fenceOn();
    const queries = await seam.run('u1');
    expect(queries.length).toBeGreaterThanOrEqual(seam.gated);
    for (const q of queries) {
      expect(q.sql).toContain(SCOPED_FENCED);
      expect(q.sql).not.toContain(SCOPED_LEGACY);
      expect(q.params?.scopeUserId).toBe('u1');
    }
  });

  it('fence on + unscoped: tenant-global caller unchanged', async () => {
    fenceOn();
    const queries = await seam.run(undefined);
    for (const q of queries) {
      expect(q.sql).toContain(GLOBAL_ONLY);
      expect(q.sql).not.toContain('userIds');
    }
  });
});

describe('segment composer persists the sorted member set (0117 write side)', () => {
  async function composeWith(
    turns: Array<{ userId?: string }>,
  ): Promise<Array<Record<string, unknown>>> {
    const queries: Array<{ sql: string; params?: Record<string, unknown> | undefined }> = [];
    const db = {
      query: async (sql: string, params?: Record<string, unknown>) => {
        queries.push({ sql, params });
        if (sql.includes('GROUP BY conversationId')) return [[{ conversationId: 'conv-1' }]];
        if (sql.includes('FROM episode'))
          return [
            turns.map((t, i) => ({
              id: `episode:e${i}`,
              speaker: 'A',
              text: `t${i}`,
              occurredAt: `2023-05-01T10:0${i}:00Z`,
              ...(t.userId ? { userId: t.userId } : {}),
            })),
          ];
        return [[]];
      },
    };
    const surreal = {
      withCompany: async (_c: string, fn: (d: unknown) => Promise<unknown>) => fn(db),
    } as unknown as SurrealService;
    const embedding = {
      embedMany: async (t: string[]) => t.map(() => [1, 0]),
    } as unknown as FactEmbeddingService;
    const svc = new SegmentComposerService(
      surreal,
      embedding,
      new EpisodeReadStoreService(surreal),
    );
    await svc.run('co_x');
    const swap = queries.find((q) => q.sql.includes('INSERT INTO episode_segment'));
    return (swap?.params?.rows as Array<Record<string, unknown>>) ?? [];
  }

  it('mixed window: userIds sorted, userId stays undefined (write is unconditional)', async () => {
    const rows = await composeWith([{ userId: 'uB' }, { userId: 'uA' }]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userIds).toEqual(['uA', 'uB']); // sorted, not insertion order
    expect(rows[0]!.userId).toBeUndefined();
    expect(rows[0]!.scope).toEqual([]);
  });

  it('single-user window: userIds mirrors the userId stamp', async () => {
    const rows = await composeWith([{ userId: 'u1' }, { userId: 'u1' }]);
    expect(rows[0]!.userIds).toEqual(['u1']);
    expect(rows[0]!.userId).toBe('u1');
  });

  it('all-global window: userIds is [] (NOT undefined — [] means purely global)', async () => {
    const rows = await composeWith([{}, {}]);
    expect(rows[0]!.userIds).toEqual([]);
    expect(rows[0]!.userId).toBeUndefined();
  });
});

describe('scene composer persists fold.userIds (0117 write side)', () => {
  const savedScenes = process.env.SCENES_SEGMENTATION_ENABLED;
  afterEach(() => {
    if (savedScenes === undefined) delete process.env.SCENES_SEGMENTATION_ENABLED;
    else process.env.SCENES_SEGMENTATION_ENABLED = savedScenes;
  });

  it('sceneRows carry the sorted member set', async () => {
    process.env.SCENES_SEGMENTATION_ENABLED = '1';
    const queries: Array<{ sql: string; params?: Record<string, unknown> | undefined }> = [];
    const db = {
      query: async (sql: string, params?: Record<string, unknown>) => {
        queries.push({ sql, params });
        if (sql.includes('GROUP BY conversationId')) return [[{ conversationId: 'conv-1' }]];
        if (sql.includes('FROM episode'))
          return [
            [
              {
                id: 'episode:s0',
                speaker: 'A',
                text: 'hello there',
                occurredAt: '2023-05-01T10:00:00Z',
                userId: 'uB',
              },
              {
                id: 'episode:s1',
                speaker: 'B',
                text: 'hi back',
                occurredAt: '2023-05-01T10:01:00Z',
                userId: 'uA',
              },
            ],
          ];
        return [[]];
      },
    };
    const surreal = {
      withCompany: async (_c: string, fn: (d: unknown) => Promise<unknown>) => fn(db),
    } as unknown as SurrealService;
    const embedding = {
      embedMany: async (t: string[]) => t.map(() => [1, 0]),
    } as unknown as FactEmbeddingService;
    const registry = {
      begin: async () => undefined,
      complete: async () => undefined,
      fail: async () => undefined,
      markResidual: async () => undefined,
    } as unknown as ProjectionRegistryService;
    const svc = new SceneComposerService(
      surreal,
      embedding,
      new EpisodeReadStoreService(surreal),
      registry,
      {
        enrich: async () => ({ scenes: 0, enriched: 0, failed: 0 }),
      } as unknown as SceneEnricherService,
      { run: async () => undefined } as unknown as SceneBacklinkService,
      // Neutral version world: fingerprint off (default), literal PR2
      // version — this spec pins the userIds fold, not scene identity.
      {
        resolve: () => ({
          version: SEGMENTER_VERSION,
          cfg: { topicBoundary: false, minCosine: 0.55, maxTurns: 40, embeddingSpaceId: null },
        }),
      } as unknown as SceneVersionService,
    );
    await svc.run('co_x');
    const swap = queries.find((q) => q.sql.includes('INSERT INTO memory_episode'));
    const rows = (swap?.params?.sceneRows as Array<Record<string, unknown>>) ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userIds).toEqual(['uA', 'uB']); // sorted member set
    expect(rows[0]!.userId).toBeUndefined(); // mixed scene stays unstamped
  });
});
