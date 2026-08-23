/**
 * Community label propagation on the JobWorkerPool.
 *
 * Two surfaces under test:
 *
 *   1. label-propagation.worker-job.ts through a REAL worker_thread pool
 *      (size 1) — the pool worker dynamic-imports the .ts handler via
 *      Node's native type stripping (same mechanism as the pool's own
 *      runner resolution) and its clusters must deep-equal a direct
 *      in-thread labelPropagation(buildAdjacency(edges)) call: the
 *      algorithm is pure and deterministic, so offloading may never
 *      change the output.
 *
 *   2. CommunityBuilderService offload wiring — a pool whose run()
 *      rejects must be invisible to the build result (in-thread
 *      fallback produces the identical communities), a pool that
 *      resolves is actually consumed, and COMMUNITIES_LP_OFFLOAD_MIN_EDGES=0
 *      never touches the pool.
 */
import { ConfigService } from '@nestjs/config';
import { join } from 'node:path';
import { JobWorkerPool } from '../src/jobs/job-worker-pool.service';
import { buildAdjacency, labelPropagation } from '../src/communities/label-propagation';
import {
  CommunityBuilderService,
  type CommunityBuildResult,
} from '../src/communities/community-builder.service';

const WORKER_JOB_PATH = join(
  __dirname,
  '..',
  'src',
  'communities',
  'label-propagation.worker-job.ts',
);

function makeConfig(env: Record<string, string> = {}): ConfigService {
  return {
    get: <T>(key: string, dflt?: T) => (env[key] ?? dflt) as T,
    getOrThrow: <T>(key: string) => env[key] as unknown as T,
  } as unknown as ConfigService;
}

/** Two weighted cliques bridged by a weak link, plus a stray pair. */
const FIXTURE_EDGES = [
  { from: 'a', to: 'b', weight: 5 },
  { from: 'b', to: 'c', weight: 5 },
  { from: 'a', to: 'c', weight: 5 },
  { from: 'c', to: 'n', weight: 5 },
  { from: 'n', to: 's', weight: 1 },
  { from: 'x', to: 'y' },
  { from: 'y', to: 'z' },
  { from: 'x', to: 'z' },
  { from: 'p', to: 'q', weight: 2 },
];

describe('label-propagation.worker-job on a real JobWorkerPool', () => {
  it('returns clusters deep-equal to the in-thread computation', async () => {
    const pool = new JobWorkerPool(makeConfig({ JOB_WORKER_POOL_SIZE: '1' }));
    await pool.onModuleInit();
    try {
      const out = await pool.run<{ clusters: string[][] }>(WORKER_JOB_PATH, {
        edges: FIXTURE_EDGES,
        maxIterations: 10,
      });
      const expected = labelPropagation(buildAdjacency(FIXTURE_EDGES), 10);
      expect(out.clusters).toEqual(expected);
      expect(expected.length).toBeGreaterThanOrEqual(3);
    } finally {
      await pool.onApplicationShutdown();
    }
  }, 15_000);

  it('serves repeat calls from the cached module with identical output', async () => {
    const pool = new JobWorkerPool(makeConfig({ JOB_WORKER_POOL_SIZE: '1' }));
    await pool.onModuleInit();
    try {
      const first = await pool.run<{ clusters: string[][] }>(WORKER_JOB_PATH, {
        edges: FIXTURE_EDGES,
      });
      const second = await pool.run<{ clusters: string[][] }>(WORKER_JOB_PATH, {
        edges: FIXTURE_EDGES.slice(0, 5),
      });
      expect(first.clusters).toEqual(labelPropagation(buildAdjacency(FIXTURE_EDGES)));
      expect(second.clusters).toEqual(labelPropagation(buildAdjacency(FIXTURE_EDGES.slice(0, 5))));
    } finally {
      await pool.onApplicationShutdown();
    }
  }, 15_000);
});

// ── CommunityBuilderService offload wiring ──────────────────────────

/** Two entity triangles — both clear the default minSize of 3. */
const E = (s: string): string => `knowledge_entity:${s}`;
const BUILDER_EDGES = [
  { in: E('a'), out: E('b') },
  { in: E('b'), out: E('c') },
  { in: E('a'), out: E('c') },
  { in: E('x'), out: E('y') },
  { in: E('y'), out: E('z') },
  { in: E('x'), out: E('z') },
];

interface CapturedBuild {
  result: CommunityBuildResult;
  /** Sorted member-id lists, one per CREATEd community, in build order. */
  memberSets: string[][];
}

function mkDb(): { db: { query: jest.Mock }; memberSets: string[][] } {
  const memberSets: string[][] = [];
  let created = 0;
  const query = jest.fn(async (sql: string, params?: Record<string, unknown>) => {
    if (sql.includes('GROUP ALL')) {
      return [[{ c: BUILDER_EDGES.length, maxAt: '2026-07-01T00:00:00Z' }]];
    }
    if (sql.includes('UPSERT community_build_state')) return [[]];
    if (sql.includes('FROM community_build_state')) return [[]];
    if (sql.includes('FROM knowledge_edge')) {
      return [
        BUILDER_EDGES.map((e) => ({
          ...e,
          weight: 1,
          createdAt: '2026-07-01T00:00:00Z',
        })),
      ];
    }
    if (sql.includes('FROM community_node')) return [[]];
    if (sql.includes('FROM knowledge_entity')) {
      return [[{ id: E('a'), canonicalName: 'Alpha' }]];
    }
    if (sql.includes('FROM knowledge_fact')) return [[]];
    if (sql.includes('CREATE community_node')) {
      created++;
      return [[{ id: `community_node:c${created}` }]];
    }
    if (sql.includes('RELATE')) {
      // Param values are StringRecordId instances; read the underlying
      // rid so the captured member sets carry real entity ids.
      const members = Object.entries(params ?? {})
        .filter(([k]) => k.startsWith('e'))
        .map(([, v]) => (v as { rid?: unknown }).rid ?? v)
        .map(String)
        .sort();
      memberSets.push(members);
      return [[]];
    }
    throw new Error(`unexpected query: ${sql}`);
  });
  return { db: { query }, memberSets };
}

function mkBuilder(pool?: JobWorkerPool): CommunityBuilderService {
  return new CommunityBuilderService(
    makeConfig({
      DREAMS_COMMUNITIES_ENABLED: '1',
      // Tiny threshold so the 6-edge fixture graph qualifies for offload.
      COMMUNITIES_LP_OFFLOAD_MIN_EDGES: '1',
    }),
    { embed: jest.fn(async () => [0.1, 0.2]) } as never,
    { generate: jest.fn(async () => 'summary') } as never,
    pool,
  );
}

async function runBuild(pool?: JobWorkerPool): Promise<CapturedBuild> {
  const { db, memberSets } = mkDb();
  const svc = mkBuilder(pool);
  const result = await svc.run(db as never);
  return { result, memberSets };
}

describe('CommunityBuilderService worker-pool offload', () => {
  it('falls back in-thread on pool failure with an identical result', async () => {
    const rejectingPool = {
      enabled: () => true,
      run: jest.fn().mockRejectedValue(new Error('pool exploded')),
    } as unknown as JobWorkerPool;

    const withPool = await runBuild(rejectingPool);
    const withoutPool = await runBuild(undefined);

    // The offload was attempted once, failed, and the fallback produced
    // exactly what a pool-less builder produces.
    expect((rejectingPool.run as jest.Mock).mock.calls).toHaveLength(1);
    expect(withPool.result).toEqual(withoutPool.result);
    expect(withPool.memberSets).toEqual(withoutPool.memberSets);
    expect(withPool.result.communitiesBuilt).toBe(2);
    expect(withPool.result.entitiesClustered).toBe(6);
  });

  it('consumes clusters computed by the pool when it succeeds', async () => {
    const pool = {
      enabled: () => true,
      run: jest.fn(async (modulePath: string, input: unknown) => {
        expect(modulePath).toMatch(/label-propagation\.worker-job\.(js|ts)$/);
        const { edges, maxIterations } = input as {
          edges: Array<{ from: string; to: string; weight?: number }>;
          maxIterations: number;
        };
        return { clusters: labelPropagation(buildAdjacency(edges), maxIterations) };
      }),
    } as unknown as JobWorkerPool;

    const offloaded = await runBuild(pool);
    const inThread = await runBuild(undefined);

    expect((pool.run as jest.Mock).mock.calls).toHaveLength(1);
    expect(offloaded.result).toEqual(inThread.result);
    expect(offloaded.memberSets).toEqual(inThread.memberSets);
  });

  it('never touches the pool when COMMUNITIES_LP_OFFLOAD_MIN_EDGES=0', async () => {
    const pool = {
      enabled: () => true,
      run: jest.fn(),
    } as unknown as JobWorkerPool;
    const { db } = mkDb();
    const svc = new CommunityBuilderService(
      makeConfig({
        DREAMS_COMMUNITIES_ENABLED: '1',
        COMMUNITIES_LP_OFFLOAD_MIN_EDGES: '0',
      }),
      { embed: jest.fn(async () => [0.1, 0.2]) } as never,
      { generate: jest.fn(async () => 'summary') } as never,
      pool,
    );

    const result = await svc.run(db as never);

    expect(pool.run).not.toHaveBeenCalled();
    expect(result.communitiesBuilt).toBe(2);
  });

  it('skips a disabled pool without calling run()', async () => {
    const pool = {
      enabled: () => false,
      run: jest.fn(),
    } as unknown as JobWorkerPool;

    const { result } = await runBuild(pool);

    expect(pool.run).not.toHaveBeenCalled();
    expect(result.communitiesBuilt).toBe(2);
  });
});
