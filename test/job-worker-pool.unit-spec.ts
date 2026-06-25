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

async function waitFor(pred: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('waitFor: condition not met within timeout');
}

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

  it('times out a wedged worker call and self-heals the slot', async () => {
    const pool = new JobWorkerPool(
      makeConfig({ JOB_WORKER_POOL_SIZE: '1', JOB_WORKER_CALL_TIMEOUT_MS: '200' }),
    );
    await pool.onModuleInit();
    try {
      await expect(pool.run(FIXTURE_PATH, { mode: 'hang' })).rejects.toThrow(
        /timed out/,
      );
      // The timed-out worker was terminated; the pool should respawn a
      // replacement and accept new work again. Wait for an *idle* worker, not
      // just size===1 — the terminated slot lingers in `workers` until its
      // async 'exit' fires, so size===1 can briefly count the dead worker.
      await waitFor(() => pool.stats().idle === 1, 8_000);
      const out = (await pool.run(FIXTURE_PATH, {
        mode: 'echo',
        payload: { ok: 1 },
      })) as { echoed: { ok: number } };
      expect(out.echoed).toEqual({ ok: 1 });
    } finally {
      await pool.onApplicationShutdown();
    }
  }, 20_000);

  it('respawns a worker that crashes mid-job', async () => {
    const pool = new JobWorkerPool(makeConfig({ JOB_WORKER_POOL_SIZE: '1' }));
    await pool.onModuleInit();
    try {
      await expect(pool.run(FIXTURE_PATH, { mode: 'crash' })).rejects.toThrow();
      await waitFor(() => pool.stats().idle === 1, 8_000);
      const out = (await pool.run(FIXTURE_PATH, {
        mode: 'echo',
        payload: { back: true },
      })) as { echoed: { back: boolean } };
      expect(out.echoed).toEqual({ back: true });
    } finally {
      await pool.onApplicationShutdown();
    }
  }, 20_000);

  it('rejects in-flight requests on shutdown', async () => {
    const pool = new JobWorkerPool(makeConfig({ JOB_WORKER_POOL_SIZE: '1' }));
    await pool.onModuleInit();
    const pending = pool.run(FIXTURE_PATH, { mode: 'sleep' });
    // Kick shutdown asynchronously.
    setTimeout(() => void pool.onApplicationShutdown(), 5);
    await expect(pending).rejects.toThrow();
  }, 15_000);
});
