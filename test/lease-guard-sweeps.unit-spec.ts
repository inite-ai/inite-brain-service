/**
 * The nightly sweeps that used to run raw on every replica — the inline
 * compaction fallback, outcome prune, the strategy deprecate sweep and the
 * memory-quality snapshot — now run under DistributedLeaseGuard: each body
 * runs once, under its own key with a TTL past its worst case, and a replica
 * that finds the lease held skips with the empty result. Without a guard
 * (unit fixtures, single-process dev) each body still runs exactly as before.
 */
import type { DistributedLeaseGuard } from '../src/common/distributed-lease.guard';
import { CompactionService } from '../src/compaction/compaction.service';
import { OutcomePruneService } from '../src/outcomes/outcome-prune.service';
import { StrategyDistillService } from '../src/strategy/strategy-distill.service';
import { MemoryQualityService } from '../src/metrics/memory-quality.service';

function fakeGuard(held = false) {
  const calls: Array<{ key: string; ttl: number | undefined }> = [];
  const run = jest.fn(async (key: string, fn: () => Promise<unknown>, ttl?: number) => {
    calls.push({ key, ttl });
    return held ? null : fn();
  });
  return { guard: { run } as unknown as DistributedLeaseGuard, calls, run };
}

// ── compaction (inline fallback) ─────────────────────────────────────────

function compaction(guard?: DistributedLeaseGuard) {
  const stats = { companyId: 'co_a', factsCompacted: 3, summariesCreated: 0, bytesFreed: 0 };
  const runner = { compactAll: jest.fn(async () => [stats]) };
  // No claim service wired: the cron takes the inline path.
  const queue = {
    hasClaim: false,
    queueModeEnabled: () => true,
    knownTenants: () => ['co_a'],
    register: jest.fn(),
  };
  const promotion = { isEnabled: () => false };
  const svc = new CompactionService(
    runner as never,
    queue as never,
    promotion as never,
    undefined,
    guard,
  );
  return { svc, runner };
}

describe('CompactionService — inline daily pass under the distributed lease', () => {
  it('runs the inline pass under compaction_all with an hour of TTL', async () => {
    const { guard, calls } = fakeGuard();
    const { svc, runner } = compaction(guard);
    const out = await svc.runDaily();
    expect(runner.compactAll).toHaveBeenCalledTimes(1);
    expect(Array.isArray(out) && out).toHaveLength(1);
    expect(calls).toEqual([{ key: 'compaction_all', ttl: 60 * 60 }]);
  });

  it('a replica that finds the lease held skips: nothing compacted, empty result', async () => {
    const { guard } = fakeGuard(true);
    const { svc, runner } = compaction(guard);
    expect(await svc.runDaily()).toEqual([]);
    expect(runner.compactAll).not.toHaveBeenCalled();
  });

  it('without a guard the inline pass runs as before', async () => {
    const { svc, runner } = compaction();
    expect(await svc.runDaily()).toHaveLength(1);
    expect(runner.compactAll).toHaveBeenCalledTimes(1);
  });

  it('the process-local flag still refuses a same-pod overlap', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { svc, runner } = compaction();
    runner.compactAll.mockImplementationOnce(async () => {
      await gate;
      return [];
    });
    const first = svc.runDaily();
    expect(await svc.runDaily()).toEqual([]);
    release();
    await first;
    expect(runner.compactAll).toHaveBeenCalledTimes(1);
  });
});

// ── outcome prune ────────────────────────────────────────────────────────

function prune(guard?: DistributedLeaseGuard) {
  const queries: string[] = [];
  const surreal = {
    withCompany: async (_c: string, fn: (db: unknown) => Promise<unknown>) =>
      fn({
        query: async (sql: string) => {
          queries.push(sql);
          return [[]];
        },
      }),
  };
  const apiKeys = { fanOutRoster: () => ['co_a', 'co_b'] };
  return { svc: new OutcomePruneService(surreal as never, apiKeys as never, guard), queries };
}

describe('OutcomePruneService — nightly prune under the distributed lease', () => {
  beforeEach(() => {
    process.env.OUTCOME_TELEMETRY_ENABLED = '1';
    // The decision leg (0119) is default-on; this suite isolates the
    // other legs, so it says so rather than relying on a default.
    process.env.OUTCOME_DECISION_CAPTURE = '0';
  });
  afterEach(() => {
    delete process.env.OUTCOME_TELEMETRY_ENABLED;
    delete process.env.OUTCOME_DECISION_CAPTURE;
  });

  it('walks the roster under outcome_prune with an hour of TTL', async () => {
    const { guard, calls } = fakeGuard();
    const { svc, queries } = prune(guard);
    expect(await svc.runNightly()).toEqual({ tenants: 2, pruned: 0 });
    expect(queries).toHaveLength(2);
    expect(calls).toEqual([{ key: 'outcome_prune', ttl: 60 * 60 }]);
  });

  it('a replica that finds the lease held skips: no query, empty result', async () => {
    const { guard } = fakeGuard(true);
    const { svc, queries } = prune(guard);
    expect(await svc.runNightly()).toEqual({ tenants: 0, pruned: 0 });
    expect(queries).toEqual([]);
  });

  it('the master flag is checked before the lease: a disabled prune never touches it', async () => {
    delete process.env.OUTCOME_TELEMETRY_ENABLED;
    const { guard, run } = fakeGuard();
    const { svc } = prune(guard);
    expect(await svc.runNightly()).toEqual({ tenants: 0, pruned: 0 });
    expect(run).not.toHaveBeenCalled();
  });
});

// ── strategy deprecate sweep ─────────────────────────────────────────────

function sweep(guard?: DistributedLeaseGuard) {
  const env: Record<string, string> = {
    OPENAI_API_KEY: 'sk-test',
    OPENAI_CHAT_MODEL: 'gpt-4o-mini',
    STRATEGY_DISTILL_CRON_ENABLED: '1',
  };
  const config = {
    get: (k: string, d?: string) => env[k] ?? d,
    getOrThrow: (k: string) => {
      const v = env[k];
      if (v === undefined) throw new Error(`missing ${k}`);
      return v;
    },
  };
  const strategies = {
    isEnabled: () => true,
    deprecateSweep: jest.fn(async () => ({ scanned: 4, deprecated: 1 })),
  };
  const apiKeys = { fanOutRoster: () => ['co_a', 'co_b'] };
  const svc = new StrategyDistillService(
    strategies as never,
    apiKeys as never,
    config as never,
    guard,
  );
  return { svc, strategies };
}

describe('StrategyDistillService — nightly sweep under the distributed lease', () => {
  it('walks the roster under strategy_sweep with half an hour of TTL', async () => {
    const { guard, calls } = fakeGuard();
    const { svc, strategies } = sweep(guard);
    expect(await svc.runNightlySweep()).toEqual({
      tenants: 2,
      scanned: 8,
      deprecated: 2,
      failed: 0,
    });
    expect(strategies.deprecateSweep).toHaveBeenCalledTimes(2);
    expect(calls).toEqual([{ key: 'strategy_sweep', ttl: 30 * 60 }]);
  });

  it('a replica that finds the lease held skips: no sweep, zero stats', async () => {
    const { guard } = fakeGuard(true);
    const { svc, strategies } = sweep(guard);
    expect(await svc.runNightlySweep()).toEqual({
      tenants: 0,
      scanned: 0,
      deprecated: 0,
      failed: 0,
    });
    expect(strategies.deprecateSweep).not.toHaveBeenCalled();
  });

  it('without a guard the sweep runs as before', async () => {
    const { svc, strategies } = sweep();
    expect((await svc.runNightlySweep()).tenants).toBe(2);
    expect(strategies.deprecateSweep).toHaveBeenCalledTimes(2);
  });
});

// ── memory-quality snapshot ──────────────────────────────────────────────

function quality(guard?: DistributedLeaseGuard) {
  const db = {
    query: async (sql: string) => {
      if (sql.includes('GROUP BY status')) return [[{ status: 'active', n: 1 }]];
      return [[{ n: 0 }]];
    },
  };
  const surreal = {
    withCompany: jest.fn(async (_c: string, fn: (d: typeof db) => Promise<unknown>) => fn(db)),
  };
  const apiKeys = { fanOutRoster: () => ['co_a'] };
  const metrics = { setMemoryQuality: jest.fn() };
  const svc = new MemoryQualityService(surreal as never, apiKeys as never, metrics as never, guard);
  return { svc, surreal, metrics };
}

describe('MemoryQualityService — nightly snapshot under the distributed lease', () => {
  it('collects and publishes under memory_quality with half an hour of TTL', async () => {
    const { guard, calls } = fakeGuard();
    const { svc, metrics } = quality(guard);
    await svc.collectNightly();
    expect(metrics.setMemoryQuality).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([{ key: 'memory_quality', ttl: 30 * 60 }]);
  });

  it('a replica that finds the lease held skips: no query, no gauge write', async () => {
    const { guard } = fakeGuard(true);
    const { svc, surreal, metrics } = quality(guard);
    await svc.collectNightly();
    expect(surreal.withCompany).not.toHaveBeenCalled();
    expect(metrics.setMemoryQuality).not.toHaveBeenCalled();
  });

  it('without a guard the pass runs as before', async () => {
    const { svc, metrics } = quality();
    await svc.collectNightly();
    expect(metrics.setMemoryQuality).toHaveBeenCalledTimes(1);
  });
});
