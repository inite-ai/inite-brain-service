import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HnswMaintenanceService } from '../src/admin/hnsw-maintenance.service';
import { HnswProvisionService } from '../src/admin/hnsw-provision.service';

/**
 * HNSW index PROVISIONING — the process hole behind #506.
 *
 * `SEARCH_HNSW_ENABLED=1` is set globally in deploy-brain.yml while
 * `HnswMaintenanceService.apply` had exactly ONE caller in the repository:
 * the admin route. No provisioning hook, no deploy step, no script, and
 * nothing recorded which tenants had indexes — so every tenant onboarded
 * since the last manual sweep started without one, and #506 measured what
 * that is (the KNN operator dropped from the plan, k arbitrary rows with a
 * NULL distance, no error).
 *
 * Everything asserted below about SurrealDB was measured on a scratch
 * `surrealdb/surrealdb:v3.2.4` container (20 000 × 1024-d, port 3058):
 *
 *   INFO FOR TABLE (index absent)          → 30–220 µs engine-side
 *   DEFINE INDEX … CONCURRENTLY over 20k   → returns in 2.4 ms, ready < 4 s
 *   DEFINE INDEX on an index that EXISTS   → ERROR "The index 'x' already
 *                                            exists" (it does NOT no-op)
 *   INFO FOR TABLE echoes the DDL, so the declared DIMENSION is readable
 *                                            from the existence probe alone
 */

const ALL = ['fact_embedding_hnsw', 'segment_embedding_hnsw'];

type IndexState = { status: 'ready' | 'indexing'; dimension?: number };

/**
 * A db that answers the two INFO probes from `present`, records every
 * statement, and reproduces the measured DEFINE-on-existing failure.
 */
function fakeDb(present: Record<string, IndexState>, defineError?: string) {
  const calls: string[] = [];
  const query = jest.fn(async (sql: string) => {
    calls.push(sql);
    if (sql.startsWith('INFO FOR TABLE')) {
      const indexes: Record<string, string> = {};
      for (const [name, st] of Object.entries(present)) {
        indexes[name] =
          `DEFINE INDEX ${name} ON t FIELDS f HNSW DIMENSION ${st.dimension ?? 1024} DIST COSINE EFC 200 M 16`;
      }
      return [{ events: {}, fields: {}, indexes, lives: {}, tables: {} }];
    }
    if (sql.startsWith('INFO FOR INDEX')) {
      const name = ALL.find((n) => sql.includes(n))!;
      const st = present[name];
      if (!st) throw new Error(`The index '${name}' does not exist`);
      return [{ building: { initial: 20000, pending: 0, status: st.status } }];
    }
    if (sql.trimStart().startsWith('DEFINE INDEX') && defineError) throw new Error(defineError);
    return [null];
  });
  return { calls, query };
}

function maintenance(db: ReturnType<typeof fakeDb>, dimension = 1024) {
  const surreal = {
    withCompany: async <T>(_c: string, fn: (d: unknown) => Promise<T>): Promise<T> => fn(db),
  };
  const embedder = {
    primaryDimensions: () => dimension,
    primarySpaceId: () => `bge:bge-m3:${dimension}:l2`,
  };
  return new HnswMaintenanceService(surreal as never, embedder as never);
}

const ddl = (calls: string[]) =>
  calls.filter((c) => /DEFINE INDEX|REMOVE INDEX/.test(c)).map((c) => c.trim());

describe('ensure — the idempotent action provisioning is allowed to call', () => {
  it('defines only the ABSENT indexes, always CONCURRENTLY, and never REMOVEs', async () => {
    // fact_embedding_hnsw is ready; the other three have never been built.
    const db = fakeDb({ fact_embedding_hnsw: { status: 'ready' } });
    const r = await maintenance(db).apply('co1', 'ensure');
    const emitted = ddl(db.calls);
    expect(emitted).toHaveLength(1);
    for (const stmt of emitted) {
      expect(stmt).toMatch(/^DEFINE INDEX/);
      expect(stmt).toContain('CONCURRENTLY');
      expect(stmt).toContain('DIMENSION 1024');
    }
    // The one property that makes it safe on a live tenant: a working index
    // is never dropped, so there is no window where the tenant is served
    // unranked rows because maintenance was running.
    expect(emitted.some((s) => s.startsWith('REMOVE'))).toBe(false);
    expect(r.created).toEqual(['segment_embedding_hnsw']);
    expect(r.concurrent).toBe(true);
  });

  it('emits NO DDL at all on an already-ready tenant — safe on every pass', async () => {
    const db = fakeDb(Object.fromEntries(ALL.map((n) => [n, { status: 'ready' as const }])));
    const r = await maintenance(db).apply('co1', 'ensure');
    expect(ddl(db.calls)).toEqual([]);
    expect(r.created).toEqual([]);
    expect(r.ready).toBe(true);
  });

  it('leaves a BUILDING index alone rather than restarting it', async () => {
    // #507: a build in flight serves the same unranked rows a missing index
    // does. A sweep that "repaired" it every pass would restart the same
    // build forever and never reach ready.
    const db = fakeDb({
      ...Object.fromEntries(ALL.map((n) => [n, { status: 'ready' as const }])),
      segment_embedding_hnsw: { status: 'indexing' as const },
    });
    const r = await maintenance(db).apply('co1', 'ensure');
    expect(ddl(db.calls)).toEqual([]);
    expect(r.ready).toBe(false);
    expect(r.builds.find((b) => b.index === 'segment_embedding_hnsw')!.state).toBe('building');
  });

  it('is concurrent — the synchronous DDL was a measured failure and no longer exists', async () => {
    const db = fakeDb({});
    const r = await maintenance(db).apply('co1', 'ensure');
    expect(r.concurrent).toBe(true);
    for (const stmt of ddl(db.calls)) expect(stmt).toContain('CONCURRENTLY');
  });

  it('never waits for the build, whatever waitMs says — the DDL returns and the sweep moves on', async () => {
    const db = fakeDb({});
    const started = Date.now();
    await maintenance(db).apply('co1', 'ensure', { waitMs: 60_000 });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('swallows the measured "already exists" race and propagates anything else', async () => {
    const raced = fakeDb({}, `The index 'fact_embedding_hnsw' already exists`);
    const r = await maintenance(raced).apply('co1', 'ensure');
    // The loser of the race reports nothing created — the desired state was
    // reached by the other writer, which is success, not failure.
    expect(r.created).toEqual([]);
    const broken = fakeDb({}, 'Failed to commit transaction');
    await expect(maintenance(broken).apply('co1', 'ensure')).rejects.toThrow('Failed to commit');
  });
});

describe('width is part of readiness', () => {
  it('an index at a foreign DIMENSION can never read as ready', async () => {
    // Measured: INFO FOR TABLE echoes the index DDL, so the declared width
    // is readable from the existence probe that already ran. An index at the
    // wrong width is `ready` to the engine and rejects every write.
    const db = fakeDb({
      ...Object.fromEntries(ALL.map((n) => [n, { status: 'ready' as const }])),
      segment_embedding_hnsw: { status: 'ready' as const, dimension: 1536 },
    });
    const r = await maintenance(db, 1024).apply('co1', 'status');
    expect(r.mismatched).toEqual(['segment_embedding_hnsw']);
    expect(r.ready).toBe(false);
  });

  it('ensure does not try to repair a mismatch — the repair is destructive', async () => {
    const db = fakeDb({
      ...Object.fromEntries(ALL.map((n) => [n, { status: 'ready' as const }])),
      segment_embedding_hnsw: { status: 'ready' as const, dimension: 1536 },
    });
    await maintenance(db, 1024).apply('co1', 'ensure');
    expect(ddl(db.calls)).toEqual([]);
  });
});

// ── the provisioning service ────────────────────────────────────────────

function provision(opts: {
  apply?: jest.Mock;
  roster?: string[];
  recorded?: Array<{ companyId: string; state: string }>;
  metrics?: {
    countHnswProvision: (o: string) => void;
    setHnswIndexTenants: (s: string, n: number) => void;
  };
  guard?: { run: (key: string, fn: () => Promise<unknown>, ttl?: number) => Promise<unknown> };
}) {
  const listeners: Array<(c: string) => void> = [];
  const surreal = { onTenantSchemaReady: (l: (c: string) => void) => listeners.push(l) };
  const apply =
    opts.apply ??
    jest.fn(async (companyId: string, action: string) => ({
      companyId,
      action,
      dimension: 1024,
      space: 'bge:bge-m3:1024:l2',
      indexes: ALL,
      concurrent: true,
      ready: true,
      builds: ALL.map((index) => ({ index, table: 't', state: 'ready' as const })),
      mismatched: [],
      created: action === 'ensure' ? ['segment_embedding_hnsw'] : [],
    }));
  const registry = {
    recordIndexState: jest.fn(async (companyId: string, o: { state: string }) => {
      opts.recorded?.push({ companyId, state: o.state });
    }),
    listIndexState: jest.fn(async () => []),
  };
  const apiKeys = { fanOutRoster: () => opts.roster ?? ['co1'] };
  const svc = new HnswProvisionService(
    surreal as never,
    { apply } as never,
    apiKeys as never,
    registry as never,
    opts.metrics as never,
    opts.guard as never,
  );
  return { svc, listeners, apply, registry };
}

function fakeGuard(held = false) {
  const calls: Array<{ key: string; ttl: number | undefined }> = [];
  const guard = {
    run: jest.fn(async (key: string, fn: () => Promise<unknown>, ttl?: number) => {
      calls.push({ key, ttl });
      return held ? null : fn();
    }),
  };
  return { guard, calls };
}

describe('HnswProvisionService — the hook', () => {
  beforeEach(() => {
    process.env.HNSW_PROVISION_ENABLED = '1';
  });
  afterEach(() => {
    delete process.env.HNSW_PROVISION_ENABLED;
    delete process.env.HNSW_PROVISION_MAX_BUILDS_PER_RUN;
    delete process.env.HNSW_PROVISION_TIME_BUDGET_MS;
  });

  it('takes the schema-ready hook — the one moment a tenant is created', async () => {
    const { svc, listeners, apply } = provision({});
    svc.onModuleInit();
    expect(listeners).toHaveLength(1);
    listeners[0]!('co-new');
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(apply).toHaveBeenCalledWith('co-new', 'ensure');
  });

  it('the hook is allocation-only: it never throws into the schema queue', () => {
    const apply = jest.fn(async () => {
      throw new Error('surreal is down');
    });
    const { svc, listeners } = provision({ apply });
    svc.onModuleInit();
    expect(() => listeners[0]!('co-new')).not.toThrow();
  });

  it('notes each tenant once per process — the hook is not a retry loop', async () => {
    const { svc, listeners, apply } = provision({});
    svc.onModuleInit();
    listeners[0]!('co1');
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    listeners[0]!('co1');
    await new Promise((r) => setImmediate(r));
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('does nothing at all while the master flag is off', async () => {
    delete process.env.HNSW_PROVISION_ENABLED;
    const { svc, listeners, apply, registry } = provision({});
    svc.onModuleInit();
    listeners[0]!('co-new');
    await new Promise((r) => setImmediate(r));
    expect(apply).not.toHaveBeenCalled();
    expect(registry.recordIndexState).not.toHaveBeenCalled();
    await expect(svc.runNightly()).resolves.toMatchObject({ tenants: [] });
  });
});

describe('HnswProvisionService — reconciliation', () => {
  beforeEach(() => {
    process.env.HNSW_PROVISION_ENABLED = '1';
  });
  afterEach(() => {
    delete process.env.HNSW_PROVISION_ENABLED;
    delete process.env.HNSW_PROVISION_MAX_BUILDS_PER_RUN;
  });

  it('walks the roster with ensure and records every observation', async () => {
    const recorded: Array<{ companyId: string; state: string }> = [];
    const { svc, apply } = provision({ roster: ['co1', 'co2'], recorded });
    const run = await svc.reconcileAll();
    expect(run.tenants.map((t) => t.companyId)).toEqual(['co1', 'co2']);
    expect(apply.mock.calls.map((c) => c[1])).toEqual(['ensure', 'ensure']);
    expect(recorded).toEqual([
      { companyId: 'co1', state: 'ready' },
      { companyId: 'co2', state: 'ready' },
    ]);
  });

  it('dryRun probes with status — no DDL is emitted, but the roster still learns', async () => {
    const recorded: Array<{ companyId: string; state: string }> = [];
    const { svc, apply } = provision({ recorded });
    const run = await svc.reconcileAll({ dryRun: true });
    expect(apply).toHaveBeenCalledWith('co1', 'status');
    expect(run.dryRun).toBe(true);
    expect(recorded).toHaveLength(1);
  });

  it('the build cap bounds DDL, not visibility', async () => {
    // Past the cap a tenant is still PROBED (status) and recorded, so the
    // roster tells the truth about it the same night; only the DDL waits.
    process.env.HNSW_PROVISION_MAX_BUILDS_PER_RUN = '1';
    const recorded: Array<{ companyId: string; state: string }> = [];
    const apply = jest.fn(async (companyId: string, action: string) => ({
      companyId,
      action,
      dimension: 1024,
      space: 's',
      indexes: ALL,
      concurrent: true,
      ready: false,
      builds: ALL.map((index) => ({ index, table: 't', state: 'absent' as const })),
      mismatched: [],
      created: action === 'ensure' ? ALL : [],
    }));
    const { svc } = provision({ apply, roster: ['co1', 'co2', 'co3'], recorded });
    const run = await svc.reconcileAll();
    expect(apply.mock.calls.map((c) => c[1])).toEqual(['ensure', 'status', 'status']);
    expect(run.skippedForCap).toBe(2);
    expect(recorded.map((r) => r.companyId)).toEqual(['co1', 'co2', 'co3']);
  });

  it('a failing tenant costs only itself (the dreams fan-out rule)', async () => {
    const apply = jest.fn(async (companyId: string) => {
      if (companyId === 'co1') throw new Error('database is gone');
      return {
        companyId,
        action: 'ensure',
        dimension: 1024,
        space: 's',
        indexes: ALL,
        concurrent: true,
        ready: true,
        builds: ALL.map((index) => ({ index, table: 't', state: 'ready' as const })),
        mismatched: [],
        created: [],
      };
    });
    const { svc } = provision({ apply, roster: ['co1', 'co2'] });
    const run = await svc.reconcileAll();
    expect(run.tenants[0]).toMatchObject({ companyId: 'co1', error: 'database is gone' });
    expect(run.tenants[1]).toMatchObject({ companyId: 'co2', ready: true });
  });

  it('a zero wall-clock budget skips the roster without touching a tenant', async () => {
    process.env.HNSW_PROVISION_TIME_BUDGET_MS = '0';
    const { svc, apply } = provision({ roster: ['co1', 'co2'] });
    const run = await svc.reconcileAll();
    expect(apply).not.toHaveBeenCalled();
    expect(run.budgetExhausted).toBe(true);
    expect(run.skippedForBudget).toBe(2);
    delete process.env.HNSW_PROVISION_TIME_BUDGET_MS;
  });

  it('records the fold, not the raw builds — mismatch outranks everything', async () => {
    const recorded: Array<{ companyId: string; state: string }> = [];
    const apply = jest.fn(async () => ({
      companyId: 'co1',
      action: 'ensure',
      dimension: 1024,
      space: 's',
      indexes: ALL,
      concurrent: true,
      ready: false,
      builds: ALL.map((index) => ({ index, table: 't', state: 'ready' as const })),
      mismatched: ['segment_embedding_hnsw'],
      created: [],
    }));
    const { svc } = provision({ apply, recorded });
    const run = await svc.reconcileAll();
    expect(run.tenants[0]!.state).toBe('mismatch');
    expect(recorded[0]!.state).toBe('mismatch');
  });

  it('a scoped reconcile never rewrites the roster-wide gauge', async () => {
    // The admin route always passes the caller's tenant scope. If a
    // one-tenant reconcile could write the gauge, "this tenant is ready"
    // would read as "the fleet is ready" until the next nightly pass.
    const gauge: Array<[string, number]> = [];
    const metrics = {
      countHnswProvision: jest.fn(),
      setHnswIndexTenants: (s: string, n: number) => gauge.push([s, n]),
    };
    const { svc } = provision({ roster: ['co1', 'co2'], metrics });
    await svc.reconcileAll({ tenants: ['co1'] });
    expect(gauge).toEqual([]);
    await svc.reconcileAll();
    expect(gauge).toContainEqual(['ready', 2]);
  });

  it('the nightly sweep has ONE gate: a retired HNSW_PROVISION_SCHEDULED=0 does not silence it', async () => {
    process.env.HNSW_PROVISION_SCHEDULED = '0';
    try {
      const { svc, apply } = provision({});
      const run = await svc.runNightly();
      expect(run.tenants.length).toBeGreaterThan(0);
      expect(apply).toHaveBeenCalled();
    } finally {
      delete process.env.HNSW_PROVISION_SCHEDULED;
    }
  });

  it('the nightly sweep is inert only when provisioning itself is off', async () => {
    process.env.HNSW_PROVISION_ENABLED = '0';
    try {
      const { svc, apply } = provision({});
      await expect(svc.runNightly()).resolves.toMatchObject({ tenants: [] });
      expect(apply).not.toHaveBeenCalled();
    } finally {
      process.env.HNSW_PROVISION_ENABLED = '1';
    }
  });
});

describe('migration 0133 — the roster columns', () => {
  const DIR = join(__dirname, '..', 'src', 'db', 'migrations');
  const sql = readFileSync(join(DIR, '0133_tenant_index_state.surql'), 'utf8');
  /** Prose explaining a rule must not trip the rule (the truth-gate idiom). */
  const body = sql.replace(/^\s*--.*$/gm, '');

  it('takes a migration number nothing else uses', () => {
    // migrationId is UNIQUE in schema_migrations: two branches shipping the
    // same number means one of them silently never applies.
    const numbers = readdirSync(DIR)
      .filter((f) => f.endsWith('.surql'))
      .map((f) => f.slice(0, 4));
    expect(numbers.filter((n) => n === '0133')).toHaveLength(1);
    expect(numbers).toEqual([...new Set(numbers)]);
  });

  it('is additive, option-typed, and mutates nothing', () => {
    for (const field of ['indexStateAt', 'indexDetail']) {
      expect(body).toContain(`DEFINE FIELD IF NOT EXISTS ${field} ON tenant_registry`);
    }
    expect(body).toContain('TYPE option<datetime>');
    expect(body).toContain('TYPE option<string>');
    // No backfill and no new index: 3.2.4's planner mishandles
    // UPDATE/DELETE … WHERE over an indexed field, and the only writer is a
    // point UPSERT by record id.
    expect(body).not.toMatch(/\b(UPDATE|DELETE|CREATE|UPSERT)\b/);
    expect(body).not.toMatch(/DEFINE INDEX/);
    // A DEFAULT would make an unobserved tenant look freshly checked.
    expect(body).not.toMatch(/DEFAULT/);
  });
});

describe('HnswProvisionService — the hook runs under a per-tenant lease', () => {
  const flush = async () => {
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  };
  beforeEach(() => {
    process.env.HNSW_PROVISION_ENABLED = '1';
  });
  afterEach(() => {
    delete process.env.HNSW_PROVISION_ENABLED;
  });

  it('one tenant, one lease: hnsw_provision_startup_<tenant> (id folded to a record-id-safe key), 30 min', async () => {
    const { guard, calls } = fakeGuard();
    const { svc, listeners, apply } = provision({ guard });
    svc.onModuleInit();
    listeners[0]!('co-new');
    await flush();
    expect(calls).toEqual([{ key: 'hnsw_provision_startup_co_new', ttl: 30 * 60 }]);
    expect(apply).toHaveBeenCalledWith('co-new', 'ensure');
  });

  it('a replica that finds the lease held skips: no DDL, no registry write', async () => {
    const { guard } = fakeGuard(true);
    const { svc, listeners, apply, registry } = provision({ guard });
    svc.onModuleInit();
    listeners[0]!('co-new');
    await flush();
    expect(apply).not.toHaveBeenCalled();
    expect(registry.recordIndexState).not.toHaveBeenCalled();
  });

  it('the nightly sweep keeps its own roster-wide lease', async () => {
    const { guard, calls } = fakeGuard();
    const { svc } = provision({ guard });
    await svc.runNightly();
    expect(calls).toEqual([{ key: 'hnsw_provision_all', ttl: 20 * 60 }]);
  });
});
