/**
 * Wave W4 of the 2026-07 performance audit — search-path tiktoken
 * counting offloaded to the JobWorkerPool.
 *
 * 1. The token-count worker-job returns exactly the counts the
 *    in-thread token-counter produces (real pool, size 1, first call
 *    pays the encoder build inside the worker).
 * 2. A short acquireTimeoutMs rejects instead of parking behind a busy
 *    pool — the never-park guarantee the request path relies on.
 * 3. applyOutputShaping trims IDENTICALLY on the offload and sync
 *    paths, and falls back to the sync loop on pool-throws /
 *    pool-disabled / below-threshold / flag-off.
 */
import { ConfigService } from '@nestjs/config';
import { join } from 'node:path';
import { JobWorkerPool } from '../src/jobs/job-worker-pool.service';
import { resolveSearchTuning } from '../src/search/retrieval-profile';
import {
  applyOutputShaping,
  tokenCountWorkerModulePath,
  type TokenCountPool,
} from '../src/search/internals/response-builder';
import { countJsonTokens, countTokens } from '../src/common/token-counter';
import type { SearchHit } from '../src/search/search.types';
import type { SearchDto } from '../src/search/dto/search.dto';

function makeConfig(env: Record<string, string> = {}): ConfigService {
  return {
    get: <T>(key: string, dflt?: T) => (env[key] ?? dflt) as T,
    getOrThrow: <T>(key: string) => env[key] as unknown as T,
  } as unknown as ConfigService;
}

const ECHO_FIXTURE = join(__dirname, 'fixtures', 'echo-worker-job.ts');

function mkHit(i: number, pad = 40): SearchHit {
  return {
    entityId: `knowledge_entity:e${i}`,
    entityType: 'person',
    canonicalName: `Entity ${i} ${'x'.repeat(pad)}`,
    externalRefs: {},
    facts: [
      {
        factId: `knowledge_fact:f${i}`,
        predicate: 'title',
        object: `value ${i} ${'y'.repeat(pad)}`,
        confidence: 0.9,
        validFrom: '2026-01-01T00:00:00.000Z',
        recordedAt: '2026-01-01T00:00:00.000Z',
        score: 0.5,
      },
    ],
    score: 1 - i / 100,
  } as unknown as SearchHit;
}

const ENV_KEYS = ['SEARCH_TOKEN_COUNT_OFFLOAD', 'SEARCH_TOKEN_OFFLOAD_MIN_HITS'];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('token-count.worker-job via a real JobWorkerPool', () => {
  it('returns counts identical to the in-thread token-counter', async () => {
    const pool = new JobWorkerPool(makeConfig({ JOB_WORKER_POOL_SIZE: '1' }));
    await pool.onModuleInit();
    try {
      const hits = Array.from({ length: 30 }, (_, i) => mkHit(i));
      const texts = hits.map((h) => JSON.stringify(h));
      const out = (await pool.run(tokenCountWorkerModulePath(), {
        texts,
      })) as { counts: number[] };
      expect(out.counts).toEqual(texts.map((t) => countTokens(t)));
      // Same numbers the sync shaping loop would use (minus its +1).
      expect(out.counts).toEqual(hits.map((h) => countJsonTokens(h)));
    } finally {
      await pool.onApplicationShutdown();
    }
  }, 20_000);

  it('rejects the input when texts is malformed', async () => {
    const pool = new JobWorkerPool(makeConfig({ JOB_WORKER_POOL_SIZE: '1' }));
    await pool.onModuleInit();
    try {
      await expect(
        pool.run(tokenCountWorkerModulePath(), { texts: [1, 2] }),
      ).rejects.toThrow(/expects \{ texts: string\[\] \}/);
    } finally {
      await pool.onApplicationShutdown();
    }
  }, 20_000);

  it('acquireTimeoutMs rejects fast instead of parking behind a busy pool', async () => {
    const pool = new JobWorkerPool(makeConfig({ JOB_WORKER_POOL_SIZE: '1' }));
    await pool.onModuleInit();
    try {
      const busy = pool.run(ECHO_FIXTURE, { mode: 'sleep' });
      // Let the first call claim the only worker.
      await new Promise((r) => setTimeout(r, 10));
      const started = Date.now();
      await expect(
        pool.run(ECHO_FIXTURE, { mode: 'echo' }, { acquireTimeoutMs: 25 }),
      ).rejects.toThrow(/acquire timed out after 25ms/);
      expect(Date.now() - started).toBeLessThan(1_000);
      await busy;
    } finally {
      await pool.onApplicationShutdown();
    }
  }, 20_000);
});

describe('applyOutputShaping offload vs sync parity', () => {
  const hits = Array.from({ length: 40 }, (_, i) => mkHit(i));
  const dto = { query: 'q', tokenBudget: 500 } as SearchDto;

  function stubPool(overrides: Partial<TokenCountPool> = {}): {
    pool: TokenCountPool;
    runMock: jest.Mock;
  } {
    const runMock = jest.fn(
      async (_module: string, input: unknown): Promise<unknown> => {
        const texts = (input as { texts: string[] }).texts;
        return { counts: texts.map((t) => countTokens(t)) };
      },
    );
    const pool: TokenCountPool = {
      enabled: () => true,
      run: runMock as TokenCountPool['run'],
      ...overrides,
    };
    return { pool, runMock };
  }

  it('trims identically to the sync path and passes the short acquire timeout', async () => {
    const syncOut = await applyOutputShaping(hits, dto);
    const { pool, runMock } = stubPool();
    const offloadOut = await applyOutputShaping(hits, dto, pool);
    expect(offloadOut).toEqual(syncOut);
    expect(runMock).toHaveBeenCalledTimes(1);
    expect(runMock.mock.calls[0][2]).toEqual({ acquireTimeoutMs: 25 });
    expect(countJsonTokens({ results: offloadOut })).toBeLessThanOrEqual(500);
  });

  it('falls back to the sync loop when the pool throws (busy/timeout)', async () => {
    const syncOut = await applyOutputShaping(hits, dto);
    const { pool, runMock } = stubPool();
    runMock.mockRejectedValue(
      new Error('worker acquire timed out after 25ms — pool exhausted/degraded'),
    );
    const out = await applyOutputShaping(hits, dto, pool);
    expect(out).toEqual(syncOut);
  });

  it('falls back when the pool reports disabled — run() never called', async () => {
    const syncOut = await applyOutputShaping(hits, dto);
    const { pool, runMock } = stubPool({ enabled: () => false });
    const out = await applyOutputShaping(hits, dto, pool);
    expect(out).toEqual(syncOut);
    expect(runMock).not.toHaveBeenCalled();
  });

  it('stays in-thread below the min-hits threshold', async () => {
    const few = hits.slice(0, 5);
    const fewDto = { query: 'q', tokenBudget: 100_000 } as SearchDto;
    const syncOut = await applyOutputShaping(few, fewDto);
    const { pool, runMock } = stubPool();
    const out = await applyOutputShaping(few, fewDto, pool);
    expect(out).toEqual(syncOut);
    expect(runMock).not.toHaveBeenCalled();
  });

  it('honours SEARCH_TOKEN_OFFLOAD_MIN_HITS overrides', async () => {
    process.env.SEARCH_TOKEN_OFFLOAD_MIN_HITS = '5';
    const few = hits.slice(0, 5);
    const { pool, runMock } = stubPool();
    // Env knobs now flow through the retrieval-profile bootstrap
    // (S5.2) — resolve the tuning snapshot the pipeline would pass.
    await applyOutputShaping(
      few,
      { query: 'q', tokenBudget: 100_000 } as SearchDto,
      pool,
      resolveSearchTuning(),
    );
    expect(runMock).toHaveBeenCalledTimes(1);
  });

  it('respects SEARCH_TOKEN_COUNT_OFFLOAD=0 (kill switch)', async () => {
    process.env.SEARCH_TOKEN_COUNT_OFFLOAD = '0';
    const syncOut = await applyOutputShaping(hits, dto);
    const { pool, runMock } = stubPool();
    const out = await applyOutputShaping(hits, dto, pool, resolveSearchTuning());
    expect(out).toEqual(syncOut);
    expect(runMock).not.toHaveBeenCalled();
  });

  it('falls back on a malformed worker reply (count length mismatch)', async () => {
    const syncOut = await applyOutputShaping(hits, dto);
    const { pool, runMock } = stubPool();
    runMock.mockResolvedValue({ counts: [1, 2, 3] });
    const out = await applyOutputShaping(hits, dto, pool);
    expect(out).toEqual(syncOut);
  });
});
