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
  let activeRows: Array<{ companyId: string }> = [];
  const surreal = {
    async withAdminDb<T>(fn: (db: unknown) => Promise<T>): Promise<T> {
      const db = {
        async query<R>(sql: string, vars?: Record<string, unknown>): Promise<R> {
          queries.push({ sql, vars });
          if (sql.includes('SELECT companyId FROM tenant_registry')) {
            return [activeRows] as unknown as R;
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
      activeRows = rows.map((companyId) => ({ companyId }));
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

  it('touch() adds to the cache synchronously and writes lastSeen once (throttled)', async () => {
    const { surreal, queries } = makeFakeSurreal();
    const svc = new TenantRegistryService(surreal);
    svc.touch('co_z');
    // Synchronous cache update — visible immediately, before any DB round-trip.
    expect(svc.activeCompanyIds()).toEqual(['co_z']);
    await flush();
    const writes = () => queries.filter((q) => q.sql.includes('UPSERT'));
    expect(writes()).toHaveLength(1);
    expect(writes()[0]!.vars).toMatchObject({ companyId: 'co_z' });
    // Second touch within the throttle window issues no new write.
    svc.touch('co_z');
    await flush();
    expect(writes()).toHaveLength(1);
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
