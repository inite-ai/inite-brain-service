import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MetricsService } from '../src/metrics/metrics.service';
import { CapabilityProbeService } from '../src/metrics/capability-probe.service';
import {
  CAPABILITY_COVERAGE,
  CAPABILITY_NAMES,
  classifyProbeFailure,
  isConclusive,
  PROBE_OUTCOMES,
} from '../src/metrics/capability-probe';

/**
 * The probe's decision rules, pinned. The failure class it exists for —
 * "the service reports healthy while a whole capability is dead" — was
 * produced twice this week (#502, #503) and reached production undetected
 * both times, so the interesting assertions here are the ones about what
 * the probe must NOT do: a saturated pool must not read as a dead pool.
 */

const ANONYMOUS = 'Anonymous access not allowed: Not enough permissions to perform this action';
const ACQUIRE_TIMEOUT =
  'Surreal scoped pool acquire timed out after 10000ms (pool=8, waiters=3). ' +
  'Likely a connection leak — check long-running requests in /admin/now.';
const FAIL_CLOSED =
  'scoped DB signin unavailable — failing closed rather than serving the request root-authorized: bad credentials';

type Stubs = {
  surreal: { withScopedCompany: jest.Mock };
  /** The fan-out roster as ApiKeyService.fanOutRoster() would hand it over: sorted. */
  apiKeys: { fanOutRoster: jest.Mock };
  embedder: { primaryDimensions: jest.Mock; embedUncached: jest.Mock; activeSpaceId: jest.Mock };
};

function makeStubs(overrides: Partial<Stubs> = {}): Stubs {
  return {
    surreal: { withScopedCompany: jest.fn().mockResolvedValue([[]]) },
    apiKeys: { fanOutRoster: jest.fn().mockReturnValue(['acme']) },
    embedder: {
      primaryDimensions: jest.fn().mockReturnValue(1024),
      embedUncached: jest.fn().mockResolvedValue(new Array(1024).fill(0.1)),
      activeSpaceId: jest.fn().mockReturnValue('bge-m3/1024'),
    },
    ...overrides,
  };
}

function build(stubs: Stubs): { svc: CapabilityProbeService; metrics: MetricsService } {
  const metrics = new MetricsService();
  const svc = new CapabilityProbeService(
    stubs.surreal as any,
    stubs.apiKeys as any,
    metrics,
    stubs.embedder as any,
  );
  return { svc, metrics };
}

const STRICT_GUARD_503 =
  "embedding space strict-guard: refusing to serve a query in 'openai:text-embedding-3-small:1536' " +
  "against rows in 'bge-m3:Xenova/bge-m3:1024' (different width). The primary embedder is not " +
  'ready; retry once warmup completes.';

/** Current value of a labelled gauge/counter series, or undefined. */
async function series(
  metrics: MetricsService,
  name: string,
  labels: Record<string, string>,
): Promise<number | undefined> {
  const metric = metrics.registry.getSingleMetric(name);
  if (!metric) return undefined;
  const snapshot = (await metric.get()) as {
    values: Array<{ labels: Record<string, string | number>; value: number }>;
  };
  const hit = snapshot.values.find((v) =>
    Object.entries(labels).every(([k, want]) => String(v.labels[k]) === want),
  );
  return hit?.value;
}

const ok = (metrics: MetricsService, capability: string) =>
  series(metrics, 'brain_capability_probe_ok', { capability });
const ticks = (metrics: MetricsService, capability: string, outcome: string) =>
  series(metrics, 'brain_capability_probe_total', { capability, outcome });

describe('capability probe — failure classification', () => {
  it('reads a pool acquire timeout as BUSY, not as a failure', () => {
    // The whole point: a saturated pool is answering, it is just not
    // answering us. #502 made the same call in readiness — a busy pool
    // must not pull the pod out of rotation, and must not page anyone.
    expect(classifyProbeFailure(new Error(ACQUIRE_TIMEOUT))).toBe('busy');
    expect(isConclusive('busy')).toBe(false);
  });

  it('reads the production anonymous-session error as UNAUTHORIZED', () => {
    expect(classifyProbeFailure(new Error(ANONYMOUS))).toBe('unauthorized');
  });

  it("reads brain's own fail-closed signin wrapper as UNAUTHORIZED", () => {
    // A rotated secret or a dropped brain_caller never reaches the DB's
    // own refusal — acquireScoped fails closed first. Same operator
    // problem, different first line.
    expect(classifyProbeFailure(new Error(FAIL_CLOSED))).toBe('unauthorized');
  });

  it('reads anything else as an error', () => {
    expect(classifyProbeFailure(new Error('connection refused'))).toBe('error');
    expect(classifyProbeFailure('not even an Error')).toBe('error');
  });

  it('classifies saturation BEFORE authorization (an acquire says nothing about auth)', () => {
    // A message that matches both patterns must land on busy: we never
    // observed the authorization, so claiming it failed is a fabrication.
    expect(classifyProbeFailure(new Error(`${ACQUIRE_TIMEOUT} — ${ANONYMOUS}`))).toBe('busy');
  });
});

describe('capability probe — scoped read', () => {
  const saved = process.env.CAPABILITY_PROBE_ENABLED;
  afterEach(() => {
    if (saved === undefined) delete process.env.CAPABILITY_PROBE_ENABLED;
    else process.env.CAPABILITY_PROBE_ENABLED = saved;
  });

  it('exercises the tenant read path end to end and reports serving', async () => {
    const stubs = makeStubs();
    const { svc, metrics } = build(stubs);

    const reports = await svc.runOnce();

    expect(reports).toContainEqual({ capability: 'scoped_read', outcome: 'serving' });
    expect(await ok(metrics, 'scoped_read')).toBe(1);
    expect(await ticks(metrics, 'scoped_read', 'serving')).toBe(1);
    // Not `pingScoped`'s RETURN 1: the probe goes through the tenant
    // database, the schema check, the scope binding and a real table read.
    const [companyId, scopes] = stubs.surreal.withScopedCompany.mock.calls[0];
    expect(companyId).toBe('acme');
    expect(scopes).toEqual(['brain:read']);
  });

  it('reports UNAUTHORIZED and names the pool + tenant when the session has lapsed', async () => {
    const stubs = makeStubs();
    stubs.surreal.withScopedCompany.mockRejectedValue(new Error(ANONYMOUS));
    const { svc, metrics } = build(stubs);

    const [scoped] = await svc.runOnce();

    expect(scoped?.outcome).toBe('unauthorized');
    // An operator must be able to act on the line alone.
    expect(scoped?.detail).toContain('tenant=acme');
    expect(scoped?.detail).toContain('db=co_acme');
    expect(scoped?.detail).toContain('scoped pool');
    expect(await ok(metrics, 'scoped_read')).toBe(0);
  });

  it('a BUSY tick leaves the up-gauge exactly where it was', async () => {
    // The load-bearing assertion. If saturation could flip the gauge, the
    // first traffic spike would page an operator about a healthy pool and
    // the alert would be muted within a week.
    const stubs = makeStubs();
    const { svc, metrics } = build(stubs);
    await svc.runOnce();
    expect(await ok(metrics, 'scoped_read')).toBe(1);

    stubs.surreal.withScopedCompany.mockRejectedValue(new Error(ACQUIRE_TIMEOUT));
    const [scoped] = await svc.runOnce();

    expect(await ok(metrics, 'scoped_read')).toBe(1);
    expect(await ticks(metrics, 'scoped_read', 'busy')).toBe(1);
    // …and it does not tell an operator to go restart a healthy pod.
    expect(scoped?.detail).toContain('saturation, not a failure');
    expect(scoped?.detail).not.toContain('restart it');
  });

  it('a busy tick does not backdate the last-success gauge either', async () => {
    const stubs = makeStubs();
    const { svc, metrics } = build(stubs);
    await svc.runOnce();
    const first = await series(metrics, 'brain_capability_probe_last_success_timestamp_seconds', {
      capability: 'scoped_read',
    });

    stubs.surreal.withScopedCompany.mockRejectedValue(new Error(ACQUIRE_TIMEOUT));
    await svc.runOnce();

    expect(
      await series(metrics, 'brain_capability_probe_last_success_timestamp_seconds', {
        capability: 'scoped_read',
      }),
    ).toBe(first);
  });

  it('an empty tenant table is a healthy tenant, not a dead capability', async () => {
    const stubs = makeStubs();
    stubs.surreal.withScopedCompany.mockResolvedValue([[]]);
    const { svc } = build(stubs);
    const [scoped] = await svc.runOnce();
    expect(scoped?.outcome).toBe('serving');
  });

  it('SKIPS (does not fail) when the roster has no tenant to probe', async () => {
    const stubs = makeStubs();
    stubs.apiKeys.fanOutRoster.mockReturnValue([]);
    const { svc, metrics } = build(stubs);

    const [scoped] = await svc.runOnce();

    expect(scoped?.outcome).toBe('skipped');
    expect(stubs.surreal.withScopedCompany).not.toHaveBeenCalled();
    expect(await ok(metrics, 'scoped_read')).toBeUndefined();
  });

  it('honours CAPABILITY_PROBE_TENANT over the roster when it names a known tenant', async () => {
    process.env.CAPABILITY_PROBE_TENANT = 'canary';
    try {
      const stubs = makeStubs();
      stubs.apiKeys.fanOutRoster.mockReturnValue(['acme', 'canary']);
      const { svc } = build(stubs);
      await svc.runOnce();
      expect(stubs.surreal.withScopedCompany.mock.calls[0][0]).toBe('canary');
    } finally {
      delete process.env.CAPABILITY_PROBE_TENANT;
    }
  });

  it('refuses an UNKNOWN CAPABILITY_PROBE_TENANT loudly, without touching the database', async () => {
    // withScopedCompany provisions the database it is handed. A typo in the
    // override used to create co_<typo> with the full migration set on
    // every boot — silently, while the probe reported that tenant healthy.
    process.env.CAPABILITY_PROBE_TENANT = 'typo';
    try {
      const stubs = makeStubs();
      const { svc, metrics } = build(stubs);
      const [scoped] = await svc.runOnce();
      expect(scoped?.outcome).toBe('error');
      expect(scoped?.detail).toContain("CAPABILITY_PROBE_TENANT='typo'");
      expect(scoped?.detail).toContain('co_typo');
      expect(stubs.surreal.withScopedCompany).not.toHaveBeenCalled();
      // Conclusive: the up-gauge goes to 0 and the alert pages the config error.
      expect(await ok(metrics, 'scoped_read')).toBe(0);
    } finally {
      delete process.env.CAPABILITY_PROBE_TENANT;
    }
  });

  it('picks the canary as the FIRST tenant of the fan-out roster — the same one every tick', async () => {
    // fanOutRoster() is sorted, so [0] is stable across ticks and pods; the
    // probe must not re-order or re-source it.
    const stubs = makeStubs({
      apiKeys: { fanOutRoster: jest.fn().mockReturnValue(['beta', 'zed']) },
    });
    const { svc } = build(stubs);
    await svc.runOnce();
    expect(stubs.surreal.withScopedCompany.mock.calls[0][0]).toBe('beta');
    expect(stubs.apiKeys.fanOutRoster).toHaveBeenCalled();
  });

  it('a suspended tenant named by the override is not on the fan-out roster — refused, not probed', async () => {
    process.env.CAPABILITY_PROBE_TENANT = 'sleeper';
    try {
      const stubs = makeStubs({ apiKeys: { fanOutRoster: jest.fn().mockReturnValue(['acme']) } });
      const { svc } = build(stubs);
      const [scoped] = await svc.runOnce();
      expect(scoped?.outcome).toBe('error');
      expect(stubs.surreal.withScopedCompany).not.toHaveBeenCalled();
    } finally {
      delete process.env.CAPABILITY_PROBE_TENANT;
    }
  });

  it('remembers the last report per capability for the health surfaces', async () => {
    const stubs = makeStubs();
    stubs.surreal.withScopedCompany.mockRejectedValue(new Error(ANONYMOUS));
    const { svc } = build(stubs);
    expect(svc.lastReports()).toEqual({});
    await svc.runOnce();
    const last = svc.lastReports();
    expect(last.scoped_read?.outcome).toBe('unauthorized');
    expect(last.embed?.outcome).toBe('serving');
    expect(Date.parse(last.scoped_read!.at)).toBeGreaterThan(0);
  });
});

describe('capability probe — embed', () => {
  it('measures the width that came back, not the embedder’s opinion of itself', async () => {
    // #503: isReady() was green from the first millisecond of boot while
    // every vector came back 1536 wide for a 1024-wide corpus. A probe
    // that asks the component the same question inherits its bugs.
    const stubs = makeStubs();
    stubs.embedder.embedUncached.mockResolvedValue(new Array(1536).fill(0.1));
    const { svc, metrics } = build(stubs);

    const reports = await svc.runOnce();
    const embed = reports.find((r) => r.capability === 'embed');

    expect(embed?.outcome).toBe('degraded');
    expect(embed?.detail).toContain('1536-wide');
    expect(embed?.detail).toContain('1024-wide');
    expect(await ok(metrics, 'embed')).toBe(0);
  });

  it('reports serving when the vector is in the configured space', async () => {
    const { svc, metrics } = build(makeStubs());
    await svc.runOnce();
    expect(await ok(metrics, 'embed')).toBe(1);
  });

  it("reads the strict space guard's 503 as DEGRADED — the refusal is the wrong-width condition", async () => {
    // With the guard on (the default) a not-warm primary never answers at
    // all: serveProvider refuses first. That is the production path; the
    // width measurement above is the flag-off path. Same outcome.
    const stubs = makeStubs();
    stubs.embedder.embedUncached.mockRejectedValue(new Error(STRICT_GUARD_503));
    const { svc, metrics } = build(stubs);

    const embed = (await svc.runOnce()).find((r) => r.capability === 'embed');

    expect(embed?.outcome).toBe('degraded');
    expect(embed?.detail).toContain('configured space');
    expect(embed?.detail).toContain('strict-guard');
    expect(await ok(metrics, 'embed')).toBe(0);
    expect(classifyProbeFailure(new Error(STRICT_GUARD_503))).toBe('degraded');
  });

  it('never lets a cached answer stand in for a live one', async () => {
    const stubs = makeStubs();
    const { svc } = build(stubs);
    await svc.runOnce();
    await svc.runOnce();
    // Through embed() a fixed probe string would be an LRU hit from the
    // second tick on, and the probe would be measuring the cache.
    expect(stubs.embedder.embedUncached).toHaveBeenCalledTimes(2);
  });

  it('skips rather than fails when no embedder is wired into the process', async () => {
    const metrics = new MetricsService();
    const stubs = makeStubs();
    const svc = new CapabilityProbeService(
      stubs.surreal as any,
      stubs.apiKeys as any,
      metrics,
      undefined,
    );
    const embed = (await svc.runOnce()).find((r) => r.capability === 'embed');
    expect(embed?.outcome).toBe('skipped');
    expect(await ok(metrics, 'embed')).toBeUndefined();
  });
});

describe('capability probe — scheduling', () => {
  const saved: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string) => {
    saved[k] = process.env[k];
    process.env[k] = v;
  };

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.useRealTimers();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('does nothing at all while the flag is off', async () => {
    setEnv('CAPABILITY_PROBE_ENABLED', '0');
    const stubs = makeStubs();
    const { svc } = build(stubs);

    svc.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(300_000);

    expect(stubs.surreal.withScopedCompany).not.toHaveBeenCalled();
    await svc.onApplicationShutdown();
  });

  it('is armed by default — a forgotten flag must not recreate the blindness', async () => {
    delete process.env.CAPABILITY_PROBE_ENABLED;
    setEnv('CAPABILITY_PROBE_INTERVAL_MS', '5000');
    const stubs = makeStubs();
    const { svc } = build(stubs);

    svc.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(5_000);

    expect(stubs.surreal.withScopedCompany).toHaveBeenCalledTimes(1);
    await svc.onApplicationShutdown();
  });

  it('probes on the configured interval once enabled', async () => {
    setEnv('CAPABILITY_PROBE_ENABLED', '1');
    setEnv('CAPABILITY_PROBE_INTERVAL_MS', '5000');
    const stubs = makeStubs();
    const { svc, metrics } = build(stubs);

    svc.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(11_000);
    await svc.onApplicationShutdown();

    expect(stubs.surreal.withScopedCompany).toHaveBeenCalledTimes(2);
    expect(await ticks(metrics, 'scoped_read', 'serving')).toBe(2);
  });

  it('shutdown waits for the tick in flight instead of pulling the pool from under it', async () => {
    setEnv('CAPABILITY_PROBE_ENABLED', '1');
    setEnv('CAPABILITY_PROBE_INTERVAL_MS', '5000');
    const stubs = makeStubs();
    let release!: () => void;
    stubs.surreal.withScopedCompany.mockReturnValue(
      new Promise<unknown[]>((resolve) => {
        release = () => resolve([[]]);
      }),
    );
    const { svc } = build(stubs);

    svc.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(5_000);
    expect(stubs.surreal.withScopedCompany).toHaveBeenCalledTimes(1);

    let shutDown = false;
    const shutdown = svc.onApplicationShutdown().then(() => {
      shutDown = true;
    });
    await jest.advanceTimersByTimeAsync(1_000);
    expect(shutDown).toBe(false); // still waiting on the probe
    release();
    await shutdown;
    expect(shutDown).toBe(true);
  });

  it('shutdown is bounded — a hung probe cannot hold the process open', async () => {
    setEnv('CAPABILITY_PROBE_ENABLED', '1');
    setEnv('CAPABILITY_PROBE_INTERVAL_MS', '5000');
    const stubs = makeStubs();
    stubs.surreal.withScopedCompany.mockReturnValue(new Promise(() => undefined));
    const { svc } = build(stubs);

    svc.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(5_000);
    let shutDown = false;
    const shutdown = svc.onApplicationShutdown().then(() => {
      shutDown = true;
    });
    await jest.advanceTimersByTimeAsync(20_000);
    await shutdown;
    expect(shutDown).toBe(true);
  });

  it('does not stack ticks when a capability hangs', async () => {
    setEnv('CAPABILITY_PROBE_ENABLED', '1');
    setEnv('CAPABILITY_PROBE_INTERVAL_MS', '5000');
    const stubs = makeStubs();
    stubs.surreal.withScopedCompany.mockReturnValue(new Promise(() => undefined));
    const { svc } = build(stubs);

    svc.onApplicationBootstrap();
    // Two further ticks land inside the first probe's 15s deadline.
    await jest.advanceTimersByTimeAsync(14_000);
    // Shutdown waits for the hung probe up to its (faked) drain bound.
    const shutdown = svc.onApplicationShutdown();
    await jest.advanceTimersByTimeAsync(20_000);
    await shutdown;

    expect(stubs.surreal.withScopedCompany).toHaveBeenCalledTimes(1);
  });

  it('stops probing on shutdown', async () => {
    setEnv('CAPABILITY_PROBE_ENABLED', '1');
    setEnv('CAPABILITY_PROBE_INTERVAL_MS', '5000');
    const stubs = makeStubs();
    const { svc } = build(stubs);

    svc.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(6_000);
    await svc.onApplicationShutdown();
    await jest.advanceTimersByTimeAsync(60_000);

    expect(stubs.surreal.withScopedCompany).toHaveBeenCalledTimes(1);
  });
});

describe('capability probe — armed series', () => {
  it('a skipped capability withdraws its armed series so it cannot read as "never succeeded"', async () => {
    const savedFlag = process.env.CAPABILITY_PROBE_ENABLED;
    process.env.CAPABILITY_PROBE_ENABLED = '1';
    // No embedder wired: the embed probe legitimately reports `skipped`.
    const stubs = makeStubs();
    const metrics = new MetricsService();
    const svc = new CapabilityProbeService(stubs.surreal as any, stubs.apiKeys as any, metrics);
    svc.onApplicationBootstrap();
    const armed = (capability: string) =>
      series(metrics, 'brain_capability_probe_armed_timestamp_seconds', { capability });
    expect(await armed('embed')).toBeDefined();
    expect(await armed('scoped_read')).toBeDefined();

    await svc.runOnce();

    expect(await armed('embed')).toBeUndefined();
    // The capability that actually ran keeps its arming time.
    expect(await armed('scoped_read')).toBeDefined();
    await svc.onApplicationShutdown();
    if (savedFlag === undefined) delete process.env.CAPABILITY_PROBE_ENABLED;
    else process.env.CAPABILITY_PROBE_ENABLED = savedFlag;
  });
});

describe('capability coverage gate', () => {
  /**
   * The generalisation, and its limit. Enumerating every capability brain
   * claims (145 flags, every route) is not something a registry can keep
   * honest. What IS enumerable is the service's own readiness contract:
   * `/ready` names its checks, and each one is polled at deploy time and
   * never again. This gate says every check has a CONTINUOUS counterpart,
   * so the next check to ship cannot quietly be deploy-time-only.
   *
   * Renaming a check is caught by the compiler instead (CAPABILITY_COVERAGE
   * is typed on `keyof ReadinessChecks`); this catches ADDING one. The
   * measurements next to the checks (`ReadinessDetail`) are not gates and
   * are not enumerated here.
   */
  const health = readFileSync(join(__dirname, '..', 'src', 'common', 'health.service.ts'), 'utf8');

  function readinessChecks(): string[] {
    const block = /export interface ReadinessChecks \{([\s\S]*?)\n\}/.exec(health);
    if (!block) throw new Error('ReadinessChecks interface not found — the gate cannot run');
    return [...block[1]!.matchAll(/^\s{2}(\w+)\??:/gm)]
      .map((m) => m[1]!)
      .filter((name) => name !== 'ready');
  }

  it('finds the readiness checks it is supposed to gate', () => {
    expect(readinessChecks().sort()).toEqual([
      'dbOk',
      'embedderReady',
      'evidenceStoreOk',
      'scopedOk',
    ]);
  });

  it('every readiness check is continuously exercised by some probe', () => {
    const covered = new Set(Object.values(CAPABILITY_COVERAGE).flat());
    const orphans = readinessChecks().filter((check) => !covered.has(check as never));
    expect(orphans).toEqual([]);
  });

  it('every declared capability has coverage, and every outcome is spelled once', () => {
    for (const capability of CAPABILITY_NAMES) {
      expect(CAPABILITY_COVERAGE[capability].length).toBeGreaterThan(0);
    }
    expect(new Set(PROBE_OUTCOMES).size).toBe(PROBE_OUTCOMES.length);
  });
});
