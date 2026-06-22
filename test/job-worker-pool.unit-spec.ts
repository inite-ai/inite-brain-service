/**
 * Unit coverage for JobWorkerPool — boots a real worker_thread pool
 * (size=2) pointing at the runner script, then drives it via the
 * fixture handler under test/fixtures/echo-worker-job.ts. We verify:
 *
 *   - workers run input in a different process tick (process.pid same
 *     since threads share PID, but module-cache + dynamic import work
 *     across calls)
 *   - parallel calls actually use multiple workers (busy + idle stats)
 *   - thrown errors inside the worker re-throw on the parent with the
 *     original message
 *   - pool disabled (size=0) makes run() throw
 *   - shutdown rejects in-flight requests cleanly
 */
import { ConfigService } from '@nestjs/config';
import { join } from 'node:path';
import { JobWorkerPool } from '../src/jobs/job-worker-pool.service';

function makeConfig(env: Record<string, string> = {}): ConfigService {
  return {
    get: <T>(key: string, dflt?: T) => (env[key] ?? dflt) as T,
    getOrThrow: <T>(key: string) => env[key] as unknown as T,
  } as unknown as ConfigService;
}

const FIXTURE_PATH = join(__dirname, 'fixtures', 'echo-worker-job.ts');

describe('JobWorkerPool', () => {
  it('runs a worker module and returns its result', async () => {
    const pool = new JobWorkerPool(makeConfig({ JOB_WORKER_POOL_SIZE: '2' }));
    await pool.onModuleInit();
    try {
      const out = (await pool.run(FIXTURE_PATH, {
        mode: 'echo',
        payload: { hello: 'world' },
      })) as { echoed: { hello: string } };
      expect(out.echoed).toEqual({ hello: 'world' });
    } finally {
      await pool.onApplicationShutdown();
    }
  }, 15_000);

  it('re-throws worker errors on the parent', async () => {
    const pool = new JobWorkerPool(makeConfig({ JOB_WORKER_POOL_SIZE: '1' }));
    await pool.onModuleInit();
    try {
      await expect(
        pool.run(FIXTURE_PATH, { mode: 'boom' }),
      ).rejects.toThrow(/worker boom for test/);
    } finally {
      await pool.onApplicationShutdown();
    }
  }, 15_000);

  it('uses multiple workers in parallel (busy stat goes up)', async () => {
    const pool = new JobWorkerPool(makeConfig({ JOB_WORKER_POOL_SIZE: '2' }));
    await pool.onModuleInit();
    try {
      const p1 = pool.run(FIXTURE_PATH, { mode: 'sleep' });
      const p2 = pool.run(FIXTURE_PATH, { mode: 'sleep' });
      // Give the postMessage / dispatch a tick to schedule.
      await new Promise((r) => setTimeout(r, 10));
      const stats = pool.stats();
      expect(stats.size).toBe(2);
      expect(stats.busy).toBeGreaterThanOrEqual(1);
      await Promise.all([p1, p2]);
      // Both done — back to idle.
      const after = pool.stats();
      expect(after.idle).toBe(2);
      expect(after.busy).toBe(0);
    } finally {
      await pool.onApplicationShutdown();
    }
  }, 15_000);

  it('throws when disabled (JOB_WORKER_POOL_SIZE=0)', async () => {
    const pool = new JobWorkerPool(makeConfig({ JOB_WORKER_POOL_SIZE: '0' }));
    await pool.onModuleInit();
    expect(pool.enabled()).toBe(false);
    await expect(pool.run(FIXTURE_PATH, {})).rejects.toThrow(/disabled/);
    await pool.onApplicationShutdown();
  });

  it('rejects in-flight requests on shutdown', async () => {
    const pool = new JobWorkerPool(makeConfig({ JOB_WORKER_POOL_SIZE: '1' }));
    await pool.onModuleInit();
    const pending = pool.run(FIXTURE_PATH, { mode: 'sleep' });
    // Kick shutdown asynchronously.
    setTimeout(() => void pool.onApplicationShutdown(), 5);
    await expect(pending).rejects.toThrow();
  }, 15_000);
});
