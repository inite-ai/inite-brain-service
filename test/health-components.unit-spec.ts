/**
 * The admin health grid speaks /ready's vocabulary.
 *
 * Before: the cockpit pinged the root pool and asked `isReady()` on its own,
 * had no scoped-pool row at all, and could show a green embedder while
 * /ready said "warming". These tests pin that every row about the request
 * path is DERIVED from HealthService.readiness() + the capability probe's
 * last outcome, never probed a second way.
 */
import { HealthComponentsService } from '../src/admin/health-components.service';
import { HealthComponentsResponseSchema } from '../src/contracts/admin/health-components.schema';
import type { ReadinessReport } from '../src/common/health.service';
import type { WarmupStatus } from '../src/common/warmup-status';
import type { LastProbeReport } from '../src/metrics/capability-probe.service';
import type { CapabilityName } from '../src/metrics/capability-probe';

type LastReports = Partial<Record<CapabilityName, LastProbeReport>>;

interface IntentFixture {
  enabled?: boolean;
  ready?: boolean;
  warmup?: WarmupStatus;
}

const READY: ReadinessReport = {
  dbOk: true,
  scopedOk: true,
  embedderReady: true,
  ready: true,
  detail: {
    dbLatencyMs: 3,
    scopedEnabled: true,
    scopedLatencyMs: 4,
    embedder: { ready: true, failures: 0, inFlight: false },
  },
};

type DetailOverrides = Partial<ReadinessReport['detail']>;

const at = (secondsAgo: number) => new Date(Date.now() - secondsAgo * 1000).toISOString();

function grid(
  readiness: Partial<Omit<ReadinessReport, 'detail'>> & { detail?: DetailOverrides } = {},
  last: LastReports = {},
  intent: IntentFixture = {},
) {
  const report: ReadinessReport = {
    ...READY,
    ...readiness,
    detail: { ...READY.detail, ...(readiness.detail ?? {}) },
  };
  const intentReady = intent.ready ?? true;
  const svc = new HealthComponentsService(
    { readiness: async () => report } as never,
    { lastReports: () => last } as never,
    { cacheStats: () => ({ provider: 'bge-m3', size: 7 }) } as never,
    {
      stats: () => ({
        enabled: intent.enabled ?? true,
        ready: intentReady,
        model: 'mini',
        cacheSize: 0,
      }),
      warmupStatus: () => intent.warmup ?? { ready: intentReady, failures: 0, inFlight: false },
    } as never,
    {
      stats: () => ({
        enabled: false,
        inFlight: false,
        lastTickAt: null,
        lastPendingRemaining: 0,
        totalConsumed: 0,
        tickCount: 0,
        lastError: null,
        sources: [],
        perBatchLimit: 100,
      }),
    } as never,
  );
  return svc.build();
}

const row = async (name: string, ...args: Parameters<typeof grid>) => {
  const res = await grid(...args);
  const hit = res.components.find((c) => c.name === name);
  if (!hit) throw new Error(`no row '${name}' in ${res.components.map((c) => c.name).join(', ')}`);
  return hit;
};

describe('health grid — scoped pool row (the one the cockpit never had)', () => {
  it('is ok when readiness says the read path authorizes and the probe last served', async () => {
    const r = await row(
      'scoped pool (brain_caller)',
      {},
      {
        scoped_read: { capability: 'scoped_read', outcome: 'serving', at: at(12) },
      },
    );
    expect(r.status).toBe('ok');
    expect(r.latencyMs).toBe(4);
    expect(r.message).toContain('authorizes reads');
    expect(r.message).toMatch(/probe serving 1[12]s ago/);
  });

  it('is DISABLED, not ok, when the scoped pool is not configured (reads run root-authorized)', async () => {
    // pingScoped() answers true vacuously in that state; a green row would
    // present the absence of a fence as a healthy fence.
    const r = await row('scoped pool (brain_caller)', { detail: { scopedEnabled: false } });
    expect(r.status).toBe('disabled');
    expect(r.message).toContain('SURREALDB_SCOPED_USER/PASS unset');
  });

  it('is degraded (socket fine, session cannot authorize) when readiness says scopedOk=false', async () => {
    const r = await row('scoped pool (brain_caller)', { scopedOk: false, ready: false });
    expect(r.status).toBe('degraded');
    expect(r.message).toContain('unauthorized');
  });

  it("is degraded when the probe's last conclusive outcome was a failure, even if the ping just passed", async () => {
    const r = await row(
      'scoped pool (brain_caller)',
      {},
      {
        scoped_read: {
          capability: 'scoped_read',
          outcome: 'unauthorized',
          detail: 'Anonymous access not allowed',
          at: at(30),
        },
      },
    );
    expect(r.status).toBe('degraded');
    expect(r.message).toContain('probe unauthorized');
    expect(r.message).toContain('Anonymous access not allowed');
  });

  it('a BUSY probe is not a failure — the row stays ok', async () => {
    const r = await row(
      'scoped pool (brain_caller)',
      {},
      {
        scoped_read: { capability: 'scoped_read', outcome: 'busy', at: at(5) },
      },
    );
    expect(r.status).toBe('ok');
    expect(r.message).toContain('probe busy');
  });

  it('is unreachable when the database itself is down', async () => {
    const r = await row('scoped pool (brain_caller)', {
      dbOk: false,
      scopedOk: false,
      ready: false,
    });
    expect(r.status).toBe('unreachable');
  });
});

describe('health grid — embedder row from the warmup bookkeeping', () => {
  it('is ok with the cache size and the probe outcome when /ready says ready', async () => {
    const r = await row(
      'embedder (bge-m3)',
      {},
      {
        embed: { capability: 'embed', outcome: 'serving', at: at(2) },
      },
    );
    expect(r.status).toBe('ok');
    expect(r.message).toContain('cache size 7');
    expect(r.message).toMatch(/probe serving [0-3]s ago/);
  });

  it('is warming, with the attempt in flight, while the first warmup runs', async () => {
    const r = await row('embedder (bge-m3)', {
      embedderReady: false,
      ready: false,
      detail: { embedder: { ready: false, failures: 0, inFlight: true } },
    });
    expect(r.status).toBe('warming');
    expect(r.message).toContain('attempt in flight');
    expect(r.message).toContain('refused (503)');
  });

  it('is DEGRADED with the last error and the next retry once a warmup has failed', async () => {
    const r = await row('embedder (bge-m3)', {
      embedderReady: false,
      ready: false,
      detail: {
        embedder: {
          ready: false,
          failures: 2,
          inFlight: false,
          lastError: 'HF 401 on tokenizer_config.json',
          nextRetryAt: '2026-09-09T15:00:00.000Z',
        },
      },
    });
    expect(r.status).toBe('degraded');
    expect(r.message).toContain('warmup failed 2×');
    expect(r.message).toContain('HF 401 on tokenizer_config.json');
    expect(r.message).toContain('next attempt at 2026-09-09T15:00:00.000Z');
  });

  it("is degraded when /ready says ready but the probe's last vector was outside the space", async () => {
    const r = await row(
      'embedder (bge-m3)',
      {},
      {
        embed: {
          capability: 'embed',
          outcome: 'degraded',
          detail: 'embedder answered 1536-wide, configured space is 1024-wide',
          at: at(40),
        },
      },
    );
    expect(r.status).toBe('degraded');
    expect(r.message).toContain('1536-wide');
  });
});

describe('health grid — intent classifier row from the same warmup bookkeeping', () => {
  it('is ok with the model and cache size once the model serves', async () => {
    const r = await row('intent classifier');
    expect(r.status).toBe('ok');
    expect(r.message).toBe('model=mini cache=0');
  });

  it('is disabled, not warming, when the classifier is switched off', async () => {
    const r = await row('intent classifier', {}, {}, { enabled: false });
    expect(r.status).toBe('disabled');
    expect(r.message).toBe('CHAT_ROUTE_NLI_ENABLED=0');
  });

  it('is warming with the attempt in flight while the first load runs', async () => {
    const r = await row(
      'intent classifier',
      {},
      {},
      { ready: false, warmup: { ready: false, failures: 0, inFlight: true } },
    );
    expect(r.status).toBe('warming');
    expect(r.message).toContain('warming up; attempt in flight');
    expect(r.message).toContain('punctuation-only intent heuristic');
  });

  it('is DEGRADED with the reason and the next retry once a warmup has failed (a gated repo used to read "warming" forever)', async () => {
    const r = await row(
      'intent classifier',
      {},
      {},
      {
        ready: false,
        warmup: {
          ready: false,
          failures: 3,
          inFlight: false,
          lastError:
            'model repo unavailable (gated or removed; set CHAT_ROUTE_NLI_MODEL to a public repo): ' +
            'Unauthorized access to file: "https://huggingface.co/Xenova/gone/resolve/main/config.json".',
          nextRetryAt: '2026-09-09T16:00:00.000Z',
        },
      },
    );
    expect(r.status).toBe('degraded');
    expect(r.message).toContain('warmup failed 3×');
    expect(r.message).toContain('Unauthorized access to file');
    expect(r.message).toContain('CHAT_ROUTE_NLI_MODEL');
    expect(r.message).toContain('next attempt at 2026-09-09T16:00:00.000Z');
    expect(r.message).toContain('model=mini');
  });
});

describe('health grid — wire contract and provenance', () => {
  it('matches the published schema with the new rows in place', async () => {
    const res = await grid();
    const parsed = HealthComponentsResponseSchema.safeParse(res);
    expect(parsed.success).toBe(true);
    expect(res.components.map((c) => c.name)).toEqual([
      'surrealdb',
      'scoped pool (brain_caller)',
      'embedder (bge-m3)',
      'intent classifier',
      'openai key',
      'changefeed consumer',
      'calibration',
    ]);
  });

  it('takes the database row from the readiness report, latency included — no second ping', async () => {
    const r = await row('surrealdb', { detail: { dbLatencyMs: 9 } });
    expect(r).toEqual({ name: 'surrealdb', status: 'ok', latencyMs: 9 });
    const down = await row('surrealdb', { dbOk: false, scopedOk: false, ready: false });
    expect(down.status).toBe('unreachable');
  });
});
