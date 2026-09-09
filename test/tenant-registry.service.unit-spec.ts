/**
 * TenantRegistryService + registry-backed ApiKeyService.knownCompanyIds()
 * (R4 finding #1: production tenant roster).
 *
 * The load-bearing guarantees:
 *   - knownCompanyIds() is registry-backed but SYNCHRONOUS (fan-out callers
 *     unchanged), and returns registry tenants when the roster is populated.
 *   - An EMPTY/absent registry falls back to the BRAIN_API_KEYS set,
 *     BYTE-IDENTICAL (order included) to pre-R4 behaviour.
 *   - A prod-JWKS shape (BRAIN_API_KEYS empty, registry populated) surfaces
 *     the registry roster — fan-out is no longer [].
 *   - register()/touch() upsert the system-DB row and reconcile the cache;
 *     touch() throttles its DB write and never blocks/throws.
 */
import { ConfigService } from '@nestjs/config';
import { ApiKeyService } from '../src/auth/api-key.service';
import { TenantRegistryService } from '../src/auth/tenant-registry.service';
import type { SurrealService } from '../src/db/surreal.service';

// ── fakes ──────────────────────────────────────────────────────────────
function makeConfig(brainApiKeys: string): ConfigService {
  return {
    get: <T>(key: string, def?: T): T =>
      key === 'BRAIN_API_KEYS' ? (brainApiKeys as unknown as T) : (def as T),
  } as unknown as ConfigService;
}

function keyEntry(companyId: string) {
  return {
    keyHash: ApiKeyService.hash(`secret_${companyId}`),
    companyId,
    scopes: ['brain:read'],
  };
}

function makeApiKeys(companyIds: string[], registry?: TenantRegistryService): ApiKeyService {
  const raw = JSON.stringify(companyIds.map(keyEntry));
  const svc = new ApiKeyService(makeConfig(raw), registry);
  svc.onModuleInit();
  return svc;
}

interface RecordedQuery {
  sql: string;
  vars?: Record<string, unknown> | undefined;
}

function makeFakeSurreal() {
  const queries: RecordedQuery[] = [];
  let rosterRows: Array<{ companyId: string; status: string }> = [];
  let stateRows: Array<Record<string, unknown>> = [];
  /** What the registry row's status reads as when a touch() write echoes it. */
  const statusInDb = new Map<string, string>();
  const surreal = {
    async withAdminDb<T>(fn: (db: unknown) => Promise<T>): Promise<T> {
      const db = {
        async query<R>(sql: string, vars?: Record<string, unknown>): Promise<R> {
          queries.push({ sql, vars });
          if (sql.includes('SELECT companyId, status FROM tenant_registry')) {
            return [rosterRows] as unknown as R;
          }
          if (sql.includes('indexState')) return [stateRows] as unknown as R;
          if (sql.includes('RETURN status')) {
            // The real UPSERT creates a missing row with DEFAULT 'active'
            // and leaves an existing row's status alone.
            const id = String(vars?.companyId);
            const status = statusInDb.get(id) ?? 'active';
            statusInDb.set(id, status);
            return [[{ status }]] as unknown as R;
          }
          return [[]] as unknown as R;
        },
      };
      return fn(db);
    },
  } as unknown as SurrealService;
  return {
    surreal,
    queries,
    setActive(rows: string[]) {
      rosterRows = rows.map((companyId) => ({ companyId, status: 'active' }));
    },
    setRoster(rows: Array<{ companyId: string; status: string }>) {
      rosterRows = rows;
    },
    setStatusInDb(companyId: string, status: string) {
      statusInDb.set(companyId, status);
    },
    setStateRows(rows: Array<Record<string, unknown>>) {
      stateRows = rows;
    },
  };
}

/** Let fire-and-forget touch() writes settle. */
const flush = () => new Promise((r) => setImmediate(r));

// ── knownCompanyIds fallback / union ────────────────────────────────────
describe('ApiKeyService.knownCompanyIds() — registry-backed with BRAIN_API_KEYS fallback', () => {
  it('no registry injected → static set (byte-identical to pre-R4)', () => {
    const svc = makeApiKeys(['co_a', 'co_b']);
    expect(svc.knownCompanyIds()).toEqual(['co_a', 'co_b']);
  });

  it('empty registry → static set unchanged, order preserved (byte-identical)', () => {
    const registry = { activeCompanyIds: () => [] } as unknown as TenantRegistryService;
    const withReg = makeApiKeys(['co_a', 'co_b'], registry);
    const withoutReg = makeApiKeys(['co_a', 'co_b']);
    expect(withReg.knownCompanyIds()).toEqual(withoutReg.knownCompanyIds());
    expect(withReg.knownCompanyIds()).toEqual(['co_a', 'co_b']);
  });

  it('registry that only mirrors static keys → still byte-identical (static-first union)', () => {
    const registry = {
      activeCompanyIds: () => ['co_a', 'co_b'],
    } as unknown as TenantRegistryService;
    const svc = makeApiKeys(['co_a', 'co_b'], registry);
    expect(svc.knownCompanyIds()).toEqual(['co_a', 'co_b']);
  });

  it('registry adds new tenants → deduped union, static first', () => {
    const registry = {
      activeCompanyIds: () => ['co_b', 'co_c', 'co_d'],
    } as unknown as TenantRegistryService;
    const svc = makeApiKeys(['co_a', 'co_b'], registry);
    expect(svc.knownCompanyIds()).toEqual(['co_a', 'co_b', 'co_c', 'co_d']);
  });

  it('prod-JWKS: BRAIN_API_KEYS empty + registry populated → roster (fan-out no longer [])', () => {
    const registry = {
      activeCompanyIds: () => ['co_prod1', 'co_prod2'],
    } as unknown as TenantRegistryService;
    const svc = makeApiKeys([], registry); // static table disabled/empty in prod
    expect(svc.knownCompanyIds()).toEqual(['co_prod1', 'co_prod2']);
  });

  it('noteResolvedTenant() forwards the resolved tenant to the registry (the auth hook)', () => {
    const touched: string[] = [];
    const registry = {
      activeCompanyIds: () => [],
      touch: (id: string) => touched.push(id),
    } as unknown as TenantRegistryService;
    const svc = makeApiKeys([], registry);
    svc.noteResolvedTenant('co_jwks');
    expect(touched).toEqual(['co_jwks']);
  });

  it('noteResolvedTenant() is a safe no-op when no registry is wired', () => {
    const svc = makeApiKeys(['co_a']);
    expect(() => svc.noteResolvedTenant('co_a')).not.toThrow();
  });
});

// ── TenantRegistryService ───────────────────────────────────────────────
describe('TenantRegistryService', () => {
  it('degrades to in-memory no-op when no SurrealService is wired', async () => {
    const svc = new TenantRegistryService();
    svc.onModuleInit();
    expect(svc.activeCompanyIds()).toEqual([]);
    await svc.register('co_x');
    expect(svc.activeCompanyIds()).toEqual(['co_x']);
    svc.touch('co_y');
    expect(svc.activeCompanyIds().sort()).toEqual(['co_x', 'co_y']);
    expect(await svc.listActive()).toEqual([]); // no DB → empty read
    svc.onModuleDestroy();
  });

  it('register() upserts the system-DB row and caches the tenant', async () => {
    const { surreal, queries } = makeFakeSurreal();
    const svc = new TenantRegistryService(surreal);
    await svc.register('co-prod-1', { status: 'active', schemaVersion: '0104' });
    const upsert = queries.find((q) => q.sql.includes('UPSERT'));
    expect(upsert).toBeDefined();
    expect(upsert!.sql).toContain("type::record('tenant_registry', $companyId)");
    expect(upsert!.vars).toMatchObject({
      companyId: 'co-prod-1',
      status: 'active',
      schemaVersion: '0104',
    });
    expect(svc.activeCompanyIds()).toEqual(['co-prod-1']);
    svc.onModuleDestroy();
  });

  it('register({status:suspended}) drops the tenant from the active cache', async () => {
    const { surreal } = makeFakeSurreal();
    const svc = new TenantRegistryService(surreal);
    await svc.register('co_a', { status: 'active' });
    expect(svc.activeCompanyIds()).toEqual(['co_a']);
    await svc.register('co_a', { status: 'suspended' });
    expect(svc.activeCompanyIds()).toEqual([]);
    svc.onModuleDestroy();
  });

  it('register() rejects an invalid companyId', async () => {
    const { surreal } = makeFakeSurreal();
    const svc = new TenantRegistryService(surreal);
    await expect(svc.register('co/../evil')).rejects.toThrow(/Invalid companyId/);
    svc.onModuleDestroy();
  });

  it('touch() on an unknown tenant admits it once the write echoes an active row, and throttles', async () => {
    const { surreal, queries } = makeFakeSurreal();
    const svc = new TenantRegistryService(surreal);
    svc.touch('co_z');
    // Not before the registry has answered: this pod does not know the
    // tenant's status, and a suspended row must never be admitted, even
    // for the length of a round-trip.
    expect(svc.activeCompanyIds()).toEqual([]);
    await flush();
    expect(svc.activeCompanyIds()).toEqual(['co_z']);
    const writes = () => queries.filter((q) => q.sql.includes('UPSERT'));
    expect(writes()).toHaveLength(1);
    expect(writes()[0]!.sql).toContain('RETURN status');
    expect(writes()[0]!.sql).not.toContain('status =');
    expect(writes()[0]!.vars).toMatchObject({ companyId: 'co_z' });
    // Second touch within the throttle window issues no new write — and
    // a tenant this pod knows to be active is visible synchronously.
    svc.touch('co_z');
    expect(svc.activeCompanyIds()).toEqual(['co_z']);
    await flush();
    expect(writes()).toHaveLength(1);
    svc.onModuleDestroy();
  });

  it('touch() never lifts a suspension this pod knows about — not even transiently (F9)', async () => {
    const { surreal, queries } = makeFakeSurreal();
    const svc = new TenantRegistryService(surreal);
    await svc.register('co_a', { status: 'suspended' });
    expect(svc.activeCompanyIds()).toEqual([]);
    svc.touch('co_a');
    // The old code added the tenant right here, before the throttle.
    expect(svc.activeCompanyIds()).toEqual([]);
    await flush();
    expect(svc.activeCompanyIds()).toEqual([]);
    // register() wrote lastSeen just now, so the touch is throttled: the
    // activity is not lost (it was recorded a moment ago), and no write
    // means nothing could have changed the status either.
    expect(queries.filter((q) => q.sql.includes('RETURN status'))).toHaveLength(0);
    svc.onModuleDestroy();
  });

  it('touch() on a tenant suspended in the registry (unknown to this pod) is not admitted (F9)', async () => {
    const { surreal, setStatusInDb } = makeFakeSurreal();
    setStatusInDb('co_s', 'suspended');
    const svc = new TenantRegistryService(surreal);
    svc.touch('co_s');
    expect(svc.activeCompanyIds()).toEqual([]);
    await flush();
    // The write echoed 'suspended' — lastSeen was bumped, membership not.
    expect(svc.activeCompanyIds()).toEqual([]);
    // Known now: a second touch stays out synchronously too.
    svc.touch('co_s');
    expect(svc.activeCompanyIds()).toEqual([]);
    svc.onModuleDestroy();
  });

  it('touch() without an echoed status fails closed on membership', async () => {
    // A write that does not say what the row's status is (a stub, an older
    // server shape) records the activity and admits nothing.
    const svc = new TenantRegistryService({
      withAdminDb: async <T>(fn: (db: unknown) => Promise<T>) => fn({ query: async () => [[]] }),
    } as unknown as SurrealService);
    svc.touch('co_q');
    await flush();
    expect(svc.activeCompanyIds()).toEqual([]);
    svc.onModuleDestroy();
  });

  it('a refresh learns a suspension written by another pod and drops the tenant', async () => {
    const { surreal, setRoster } = makeFakeSurreal();
    const svc = new TenantRegistryService(surreal);
    await svc.register('co_a', { status: 'active' });
    expect(svc.activeCompanyIds()).toEqual(['co_a']);
    setRoster([
      { companyId: 'co_a', status: 'suspended' },
      { companyId: 'co_b', status: 'active' },
      { companyId: 'co_p', status: 'provisioning' },
    ]);
    svc.onModuleInit(); // kicks a refresh
    await flush();
    expect(svc.activeCompanyIds()).toEqual(['co_b']);
    // And the learned status governs the next touch.
    svc.touch('co_a');
    expect(svc.activeCompanyIds()).toEqual(['co_b']);
    svc.onModuleDestroy();
  });

  it('in-memory mode: register(suspended) is remembered, touch() does not lift it', async () => {
    const svc = new TenantRegistryService();
    await svc.register('co_a', { status: 'suspended' });
    expect(svc.activeCompanyIds()).toEqual([]);
    svc.touch('co_a');
    expect(svc.activeCompanyIds()).toEqual([]);
    svc.onModuleDestroy();
  });

  it('touch() ignores a malformed companyId (never throws on the hot path)', async () => {
    const { surreal, queries } = makeFakeSurreal();
    const svc = new TenantRegistryService(surreal);
    expect(() => svc.touch('bad id!')).not.toThrow();
    await flush();
    expect(svc.activeCompanyIds()).toEqual([]);
    expect(queries.filter((q) => q.sql.includes('UPSERT'))).toHaveLength(0);
    svc.onModuleDestroy();
  });

  it('listActive() reads the active roster from the registry', async () => {
    const { surreal, setActive } = makeFakeSurreal();
    setActive(['co_1', 'co_2', 'co_1']); // duplicate collapses
    const svc = new TenantRegistryService(surreal);
    expect((await svc.listActive()).sort()).toEqual(['co_1', 'co_2']);
    svc.onModuleDestroy();
  });

  it('the refresh timer loads the roster into the sync cache on init', async () => {
    const { surreal, setActive } = makeFakeSurreal();
    setActive(['co_r1', 'co_r2']);
    const svc = new TenantRegistryService(surreal);
    svc.onModuleInit(); // kicks a best-effort refresh
    await flush();
    expect(svc.activeCompanyIds().sort()).toEqual(['co_r1', 'co_r2']);
    svc.onModuleDestroy();
  });
});

// ── index state: the roster answer to "who has a ready index" ───────────
describe('TenantRegistryService.recordIndexState() — 0104/0133 columns', () => {
  it('writes the index columns and NOTHING about lifecycle', async () => {
    // The whole reason this is not register(): register() writes `status`,
    // defaulting it to 'active', so recording an observation through it
    // would silently reactivate a suspended tenant and put it back on the
    // fan-out roster. A maintenance sweep looking at a tenant is also not
    // that tenant being seen, so `lastSeen` stays untouched too.
    const { surreal, queries } = makeFakeSurreal();
    const svc = new TenantRegistryService(surreal);
    await svc.recordIndexState('co_1', {
      state: 'partial',
      detail: 'fact_embedding_hnsw=ready,entity_embedding_hnsw=absent',
      embeddingSpace: 'bge:bge-m3:1024:l2',
    });
    const write = queries.find((q) => q.sql.includes('UPSERT'))!;
    expect(write.sql).toContain('indexState = $indexState');
    expect(write.sql).toContain('indexDetail = $indexDetail');
    expect(write.sql).toContain('embeddingSpace = $embeddingSpace');
    expect(write.sql).toContain('indexStateAt = type::datetime($at)');
    expect(write.sql).not.toContain('status');
    expect(write.sql).not.toContain('lastSeen');
    // Point UPSERT by record id — never UPDATE … WHERE over an indexed
    // field (3.2.4's planner silently matches zero rows).
    expect(write.sql).toContain(`UPSERT type::record('tenant_registry', $companyId)`);
    expect(write.vars).toMatchObject({ companyId: 'co_1', indexState: 'partial' });
    svc.onModuleDestroy();
  });

  it('omits the optional columns rather than binding NULL onto an option<>', async () => {
    const { surreal, queries } = makeFakeSurreal();
    const svc = new TenantRegistryService(surreal);
    await svc.recordIndexState('co_1', { state: 'unknown' });
    const write = queries.find((q) => q.sql.includes('UPSERT'))!;
    expect(write.sql).not.toContain('indexDetail');
    expect(write.sql).not.toContain('embeddingSpace');
    svc.onModuleDestroy();
  });

  it('never throws — a sweep must not lose a run to its own bookkeeping', async () => {
    const exploding = {
      withAdminDb: async () => {
        throw new Error('system db unreachable');
      },
    } as unknown as SurrealService;
    const svc = new TenantRegistryService(exploding);
    await expect(svc.recordIndexState('co_1', { state: 'ready' })).resolves.toBeUndefined();
    expect(await svc.listIndexState()).toEqual([]);
    svc.onModuleDestroy();
  });

  it('an unobserved tenant reads as unknown, not as ready', async () => {
    const { surreal, setStateRows } = makeFakeSurreal();
    setStateRows([
      { companyId: 'co_never', status: 'active' },
      {
        companyId: 'co_seen',
        status: 'suspended',
        indexState: 'ready',
        indexDetail: 'fact_embedding_hnsw=ready',
        indexStateAt: '2026-09-08T00:00:00.000Z',
      },
    ]);
    const svc = new TenantRegistryService(surreal);
    const rows = await svc.listIndexState();
    // A row nothing has ever looked at must not read as ready — that
    // assumption is the whole defect. And a suspended tenant stays in the
    // listing: an operator chasing a gap needs to SEE it left the roster.
    expect(rows[0]).toEqual({ companyId: 'co_never', status: 'active', state: 'unknown' });
    expect(rows[1]).toMatchObject({
      companyId: 'co_seen',
      status: 'suspended',
      state: 'ready',
      observedAt: '2026-09-08T00:00:00.000Z',
    });
    svc.onModuleDestroy();
  });
});
