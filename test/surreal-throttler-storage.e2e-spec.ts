/**
 * SurrealThrottlerStorage against a REAL SurrealDB (testcontainers, started
 * by test/global-setup.ts): two storage instances on two SurrealService
 * connections model two replicas behind a load balancer sharing one
 * `throttle_bucket` table (migration 0141).
 *
 * Pins the finding: with process-local buckets N replicas granted N× the
 * limit. Here one count, one block and one window are shared; a database
 * outage fails over to per-process counting and is logged, never 5xx.
 */
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SurrealService } from '../src/db/surreal.service';
import { SurrealThrottlerStorage } from '../src/common/surreal-throttler.storage';

const TTL = 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('SurrealThrottlerStorage — buckets shared across replicas (real SurrealDB)', () => {
  const savedPool = process.env.SURREALDB_POOL_SIZE;
  let replicaA: SurrealService;
  let replicaB: SurrealService;
  let storageA: SurrealThrottlerStorage;
  let storageB: SurrealThrottlerStorage;
  const run = Date.now().toString(36);
  const key = (tag: string) => `k:${tag}-${run}`;

  beforeAll(async () => {
    process.env.SURREALDB_POOL_SIZE = '2';
    replicaA = new SurrealService(new ConfigService());
    await replicaA.onModuleInit();
    replicaB = new SurrealService(new ConfigService());
    await replicaB.onModuleInit();
    storageA = new SurrealThrottlerStorage(replicaA);
    storageB = new SurrealThrottlerStorage(replicaB);
  }, 120_000);

  afterAll(async () => {
    storageA?.onApplicationShutdown();
    storageB?.onApplicationShutdown();
    await replicaA?.onApplicationShutdown();
    await replicaB?.onApplicationShutdown();
    if (savedPool === undefined) delete process.env.SURREALDB_POOL_SIZE;
    else process.env.SURREALDB_POOL_SIZE = savedPool;
  });

  it('two replicas see one combined count for one credential', async () => {
    const k = key('shared');
    await storageA.increment(k, TTL, 10, TTL, 'default');
    await storageA.increment(k, TTL, 10, TTL, 'default');
    const fromB = await storageB.increment(k, TTL, 10, TTL, 'default');
    expect(fromB.totalHits).toBe(3);
    expect(fromB.isBlocked).toBe(false);
    expect(fromB.timeToExpire).toBeGreaterThan(0);
    expect(fromB.timeToExpire).toBeLessThanOrEqual(60);
    const fromA = await storageA.increment(k, TTL, 10, TTL, 'default');
    expect(fromA.totalHits).toBe(4);
  });

  it('an overflow on one replica blocks the credential on the other', async () => {
    const k = key('block');
    for (let i = 0; i < 3; i++) {
      expect((await storageA.increment(k, TTL, 3, TTL, 'expensive')).isBlocked).toBe(false);
    }
    const overflow = await storageA.increment(k, TTL, 3, TTL, 'expensive');
    expect(overflow.totalHits).toBe(4);
    expect(overflow.isBlocked).toBe(true);
    expect(overflow.timeToBlockExpire).toBeGreaterThan(0);

    const onB = await storageB.increment(k, TTL, 3, TTL, 'expensive');
    expect(onB.isBlocked).toBe(true);
    // Blocked hits are not counted (NestJS in-memory semantics).
    expect(onB.totalHits).toBe(4);
  });

  it('throttler names are separate buckets for the same tracker key', async () => {
    const k = key('names');
    await storageA.increment(k, TTL, 10, TTL, 'default');
    await storageA.increment(k, TTL, 10, TTL, 'default');
    const expensive = await storageB.increment(k, TTL, 10, TTL, 'expensive');
    expect(expensive.totalHits).toBe(1);
  });

  it('an expired window is reset by the next hit from either replica', async () => {
    const k = key('expiry');
    for (let i = 0; i < 3; i++) await storageA.increment(k, 1_000, 10, 1_000, 'default');
    await sleep(1_200);
    const fresh = await storageB.increment(k, 1_000, 10, 1_000, 'default');
    expect(fresh.totalHits).toBe(1);
    expect(fresh.isBlocked).toBe(false);
  });

  it('concurrent hits from both replicas are all counted (conflicts retried)', async () => {
    const k = key('parallel');
    const results = await Promise.all([
      ...Array.from({ length: 5 }, () => storageA.increment(k, TTL, 100, TTL, 'default')),
      ...Array.from({ length: 5 }, () => storageB.increment(k, TTL, 100, TTL, 'default')),
    ]);
    expect(Math.max(...results.map((r) => r.totalHits))).toBe(10);
    expect(new Set(results.map((r) => r.totalHits)).size).toBe(10);
  }, 30_000);

  it('sweepExpired removes buckets whose window and block have passed, nothing else', async () => {
    const dead = key('gc-dead');
    const live = key('gc-live');
    await storageA.increment(dead, 300, 10, 300, 'default');
    await storageA.increment(live, TTL, 10, TTL, 'default');
    await storageA.increment(live, TTL, 10, TTL, 'default');
    await sleep(500);
    expect(await storageB.sweepExpired()).toBeGreaterThanOrEqual(1);
    // Swept → the next hit starts a fresh window…
    expect((await storageA.increment(dead, TTL, 10, TTL, 'default')).totalHits).toBe(1);
    // …while the live bucket kept its count.
    expect((await storageB.increment(live, TTL, 10, TTL, 'default')).totalHits).toBe(3);
  });

  it('fails over to per-process counting, logged once per window, when the database is down', async () => {
    const dead = {
      withAdminDb: async () => {
        throw new Error('system db unreachable');
      },
    } as unknown as SurrealService;
    const storage = new SurrealThrottlerStorage(dead);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const first = await storage.increment('k:dead', TTL, 10, TTL, 'default');
      expect(first).toMatchObject({ totalHits: 1, isBlocked: false });
      const second = await storage.increment('k:dead', TTL, 10, TTL, 'default');
      expect(second.totalHits).toBe(2);
      const outageLines = warn.mock.calls.filter((c) =>
        String(c[0]).includes('Shared throttle storage unavailable'),
      );
      expect(outageLines).toHaveLength(1);
    } finally {
      warn.mockRestore();
      storage.onApplicationShutdown();
    }
  });
});
