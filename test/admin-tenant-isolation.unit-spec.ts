/**
 * Release blocker (P0 tenant-isolation bypass): admin controllers used to
 * resolve the target tenant from the request body/query and accept ANY
 * registered tenant, so a `brain:admin` key scoped to tenant A could pass
 * `tenant = B` and run privileged ops (derive/GC, drop HNSW, mutate
 * strategies, compaction, reindex) on tenant B. The fix centralizes tenant
 * resolution in resolvePlatformTenant(): a foreign tenant is a 403 unless
 * the caller holds the dedicated brain:platform_admin scope AND
 * BRAIN_TENANT_OVERRIDE_ENABLED is on. This pins the default-deny and the
 * sanctioned platform path for every affected endpoint.
 */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { AuthenticatedRequest, BrainScope } from '../src/auth/api-key.types';
import {
  resolvePlatformTenant,
  resolvePlatformTenantScope,
  platformTenantCapable,
  PLATFORM_TENANT_SCOPE,
} from '../src/auth/tenant-scope';
import { AdminDeriveController } from '../src/admin/admin-derive.controller';
import { AdminHnswController } from '../src/admin/admin-hnsw.controller';
import { AdminSegmentsController } from '../src/admin/admin-segments.controller';
import { AdminAggregatesController } from '../src/admin/admin-aggregates.controller';
import { StrategyAdminController } from '../src/strategy/strategy-admin.controller';
import { AdminJobsController } from '../src/admin/admin-jobs.controller';

const KNOWN = ['tenant-a', 'tenant-b'];
const apiKeys = { knownCompanyIds: () => KNOWN } as never;
const ADMIN: BrainScope[] = ['brain:admin'];
const PLATFORM: BrainScope[] = ['brain:admin', PLATFORM_TENANT_SCOPE];

function req(scopes: BrainScope[], companyId = 'tenant-a'): AuthenticatedRequest {
  return { brainAuth: { companyId, scopes, keyHash: 'h' } } as unknown as AuthenticatedRequest;
}

function gateOn(): void {
  process.env.BRAIN_TENANT_OVERRIDE_ENABLED = '1';
}

const OLD_GATE = process.env.BRAIN_TENANT_OVERRIDE_ENABLED;
afterEach(() => {
  if (OLD_GATE === undefined) delete process.env.BRAIN_TENANT_OVERRIDE_ENABLED;
  else process.env.BRAIN_TENANT_OVERRIDE_ENABLED = OLD_GATE;
});

describe('resolvePlatformTenant — cross-tenant is default-deny (P0)', () => {
  const opts = { knownTenants: () => KNOWN };

  it('no tenant requested → own tenant', () => {
    expect(resolvePlatformTenant(req(ADMIN), undefined, opts)).toBe('tenant-a');
  });
  it('own tenant echoed back → own tenant', () => {
    expect(resolvePlatformTenant(req(ADMIN), 'tenant-a', opts)).toBe('tenant-a');
  });
  it('whitespace-only tenant → own tenant', () => {
    expect(resolvePlatformTenant(req(ADMIN), '   ', opts)).toBe('tenant-a');
  });
  it('foreign tenant, plain brain:admin, gate off → 403', () => {
    expect(() => resolvePlatformTenant(req(ADMIN), 'tenant-b', opts)).toThrow(ForbiddenException);
  });
  it('foreign tenant, platform scope, gate OFF → 403 (gate required)', () => {
    expect(() => resolvePlatformTenant(req(PLATFORM), 'tenant-b', opts)).toThrow(
      ForbiddenException,
    );
  });
  it('foreign tenant, plain brain:admin, gate ON → 403 (scope required)', () => {
    gateOn();
    expect(() => resolvePlatformTenant(req(ADMIN), 'tenant-b', opts)).toThrow(ForbiddenException);
  });
  it('foreign KNOWN tenant, platform scope + gate ON → allowed', () => {
    gateOn();
    expect(resolvePlatformTenant(req(PLATFORM), 'tenant-b', opts)).toBe('tenant-b');
  });
  it('foreign UNKNOWN tenant, platform scope + gate ON → 400', () => {
    gateOn();
    expect(() => resolvePlatformTenant(req(PLATFORM), 'ghost', opts)).toThrow(BadRequestException);
  });
});

describe('resolvePlatformTenantScope — aggregate reads default to own tenant (P0)', () => {
  const opts = { knownTenants: () => KNOWN };

  it('no tenant requested, plain brain:admin → own tenant only', () => {
    expect(resolvePlatformTenantScope(req(ADMIN), undefined, opts)).toEqual(['tenant-a']);
  });
  it('no tenant requested, platform scope but gate OFF → own tenant only', () => {
    expect(resolvePlatformTenantScope(req(PLATFORM), undefined, opts)).toEqual(['tenant-a']);
  });
  it('no tenant requested, platform scope + gate ON → all registered tenants', () => {
    gateOn();
    expect(resolvePlatformTenantScope(req(PLATFORM), undefined, opts)).toEqual(KNOWN);
  });
  it('own tenant requested → own tenant only', () => {
    expect(resolvePlatformTenantScope(req(ADMIN), 'tenant-a', opts)).toEqual(['tenant-a']);
  });
  it('foreign tenant requested, plain brain:admin → 403', () => {
    expect(() => resolvePlatformTenantScope(req(ADMIN), 'tenant-b', opts)).toThrow(
      ForbiddenException,
    );
  });
  it('foreign tenant requested, platform scope + gate ON → that tenant', () => {
    gateOn();
    expect(resolvePlatformTenantScope(req(PLATFORM), 'tenant-b', opts)).toEqual(['tenant-b']);
  });
});

describe('platformTenantCapable', () => {
  it('false when gate off (even with the scope)', () => {
    expect(platformTenantCapable(PLATFORM)).toBe(false);
  });
  it('false when gate on but scope missing', () => {
    gateOn();
    expect(platformTenantCapable(ADMIN)).toBe(false);
  });
  it('true only with scope AND gate', () => {
    gateOn();
    expect(platformTenantCapable(PLATFORM)).toBe(true);
  });
});

describe('AdminDeriveController — tenant isolation (P0)', () => {
  function make() {
    const seen: string[] = [];
    const deriver = {
      run: async (t: string) => {
        seen.push(t);
        return { status: 'ok', failed: 0, skipped: [] };
      },
      gc: async (t: string) => {
        seen.push(t);
        return { deleted: {}, kept: [] };
      },
    };
    return { ctrl: new AdminDeriveController(deriver as never, apiKeys), seen };
  }

  it('brain:admin + foreign tenant → 403 (derive run)', async () => {
    await expect(make().ctrl.run(req(ADMIN), { tenant: 'tenant-b' })).rejects.toThrow(
      ForbiddenException,
    );
  });
  it('brain:admin + foreign tenant → 403 (derive gc)', async () => {
    await expect(make().ctrl.gc(req(ADMIN), { tenant: 'tenant-b' })).rejects.toThrow(
      ForbiddenException,
    );
  });
  it('own tenant (omitted) → operates on own', async () => {
    const { ctrl, seen } = make();
    await ctrl.run(req(ADMIN), {});
    expect(seen).toEqual(['tenant-a']);
  });
  it('platform scope + gate → sanctioned cross-tenant reach', async () => {
    gateOn();
    const { ctrl, seen } = make();
    await ctrl.run(req(PLATFORM), { tenant: 'tenant-b' });
    expect(seen).toEqual(['tenant-b']);
  });
});

describe('AdminHnswController — tenant isolation (P0)', () => {
  function make() {
    const seen: string[] = [];
    const hnsw = {
      apply: async (t: string) => {
        seen.push(t);
        return {};
      },
    };
    return { ctrl: new AdminHnswController(hnsw as never, apiKeys), seen };
  }

  it('brain:admin + foreign tenant → 403', async () => {
    await expect(
      make().ctrl.apply(req(ADMIN), { action: 'create', tenant: 'tenant-b' }),
    ).rejects.toThrow(ForbiddenException);
  });
  it('own tenant → operates on own', async () => {
    const { ctrl, seen } = make();
    await ctrl.apply(req(ADMIN), { action: 'create' });
    expect(seen).toEqual(['tenant-a']);
  });
  it('platform scope + gate → sanctioned cross-tenant reach', async () => {
    gateOn();
    const { ctrl, seen } = make();
    await ctrl.apply(req(PLATFORM), { action: 'drop', tenant: 'tenant-b' });
    expect(seen).toEqual(['tenant-b']);
  });
});

describe('AdminSegmentsController — tenant isolation (P0)', () => {
  function make() {
    const seen: string[] = [];
    const composer = {
      run: async (t: string) => {
        seen.push(t);
        return {};
      },
    };
    return { ctrl: new AdminSegmentsController(composer as never, apiKeys), seen };
  }

  it('brain:admin + foreign tenant → 403', async () => {
    await expect(make().ctrl.run(req(ADMIN), { tenant: 'tenant-b' })).rejects.toThrow(
      ForbiddenException,
    );
  });
  it('own tenant → operates on own', async () => {
    const { ctrl, seen } = make();
    await ctrl.run(req(ADMIN), {});
    expect(seen).toEqual(['tenant-a']);
  });
});

describe('AdminAggregatesController — tenant isolation (P0)', () => {
  function make() {
    const seen: string[] = [];
    const composer = {
      run: async (t: string) => {
        seen.push(t);
        return {};
      },
    };
    const arcs = {
      run: async (t: string) => {
        seen.push(t);
        return {};
      },
    };
    return { ctrl: new AdminAggregatesController(composer as never, arcs as never, apiKeys), seen };
  }

  it('brain:admin + foreign tenant → 403 (aggregates)', async () => {
    await expect(make().ctrl.run(req(ADMIN), { tenant: 'tenant-b' })).rejects.toThrow(
      ForbiddenException,
    );
  });
  it('brain:admin + foreign tenant → 403 (arcs)', async () => {
    await expect(make().ctrl.runArcs(req(ADMIN), { tenant: 'tenant-b' })).rejects.toThrow(
      ForbiddenException,
    );
  });
  it('own tenant → operates on own', async () => {
    const { ctrl, seen } = make();
    await ctrl.run(req(ADMIN), {});
    expect(seen).toEqual(['tenant-a']);
  });
});

describe('StrategyAdminController — tenant isolation (P0)', () => {
  function make() {
    const seen: string[] = [];
    const strategies = {
      isEnabled: () => true,
      isTrajectoriesEnabled: () => true,
      list: async (t: string) => {
        seen.push(t);
        return [];
      },
    };
    const distiller = {
      distillFromPostMortems: async (t: string) => {
        seen.push(t);
        return {};
      },
    };
    return {
      ctrl: new StrategyAdminController(strategies as never, distiller as never, apiKeys),
      seen,
    };
  }

  it('brain:admin + foreign tenant → 403 (list)', async () => {
    await expect(make().ctrl.list(req(ADMIN), { tenant: 'tenant-b' })).rejects.toThrow(
      ForbiddenException,
    );
  });
  it('brain:admin + foreign tenant → 403 (distill, before body validation)', async () => {
    await expect(make().ctrl.distill(req(ADMIN), { tenant: 'tenant-b' })).rejects.toThrow(
      ForbiddenException,
    );
  });
  it('own tenant → operates on own', async () => {
    const { ctrl, seen } = make();
    await ctrl.list(req(ADMIN), {});
    expect(seen).toEqual(['tenant-a']);
  });
  it('platform scope + gate → sanctioned cross-tenant reach', async () => {
    gateOn();
    const { ctrl, seen } = make();
    await ctrl.list(req(PLATFORM), { tenant: 'tenant-b' });
    expect(seen).toEqual(['tenant-b']);
  });
});

describe('AdminJobsController — tenant isolation (P0)', () => {
  function make() {
    const seen = {
      compacted: [] as string[],
      reindexHost: undefined as string | undefined,
      tenantFilter: undefined as unknown,
      emitTenants: [] as string[],
    };
    const jobs = {
      start: async (o: { companyId: string; initialProgress: { tenantFilter: unknown } }) => {
        seen.reindexHost = o.companyId;
        seen.tenantFilter = o.initialProgress.tenantFilter;
        return { runId: 'r1' };
      },
      finish: async () => {},
    };
    const dreams = {
      emitsForRun: async (companyId: string) => {
        seen.emitTenants.push(companyId);
        return [];
      },
    };
    const compaction = {
      compactCompany: async (c: string) => {
        seen.compacted.push(c);
      },
    };
    const reindex = { run: async () => ({}) };
    const scenarios = { list: () => [], runOne: async () => ({}) };
    const u = undefined as never;
    const ctrl = new AdminJobsController(
      jobs as never, // 0 jobs
      dreams as never, // 1 dreams
      u, // 2 calibrationRefit
      u, // 3 changefeed
      u, // 4 scheduler
      apiKeys, // 5 apiKeys
      reindex as never, // 6 reindex
      scenarios as never, // 7 scenarios
      u, // 8 claim
      u, // 9 leaderLease
      u, // 10 workerLoop
      u, // 11 workerPool
      compaction as never, // 12 compaction
      u, // 13 config
    );
    return { ctrl, seen };
  }

  it('compaction: brain:admin + foreign companyId → 403', () => {
    expect(() => make().ctrl.triggerCompaction(req(ADMIN), { companyId: 'tenant-b' })).toThrow(
      ForbiddenException,
    );
  });
  it('compaction: plain brain:admin omitted → own tenant only (no all-tenant fan-out)', () => {
    const r = make().ctrl.triggerCompaction(req(ADMIN), {});
    expect(r.tenants).toEqual(['tenant-a']);
  });
  it('compaction: platform scope + gate omitted → fans out over all tenants', () => {
    gateOn();
    const r = make().ctrl.triggerCompaction(req(PLATFORM), {});
    expect(r.tenants).toEqual(KNOWN);
  });
  it('compaction: platform scope + gate + foreign → that tenant', () => {
    gateOn();
    const r = make().ctrl.triggerCompaction(req(PLATFORM), { companyId: 'tenant-b' });
    expect(r.tenants).toEqual(['tenant-b']);
  });

  it('reindex: brain:admin + foreign tenant → 403', async () => {
    await expect(make().ctrl.triggerReindex(req(ADMIN), { tenant: 'tenant-b' })).rejects.toThrow(
      ForbiddenException,
    );
  });
  it('reindex: plain brain:admin omitted → own tenant only', async () => {
    const { ctrl, seen } = make();
    await ctrl.triggerReindex(req(ADMIN), {});
    expect(seen.tenantFilter).toBe('tenant-a');
    expect(seen.reindexHost).toBe('tenant-a');
  });
  it('reindex: platform scope + gate omitted → all tenants (no filter)', async () => {
    gateOn();
    const { ctrl, seen } = make();
    await ctrl.triggerReindex(req(PLATFORM), {});
    expect(seen.tenantFilter).toBeNull();
  });

  it('dreamEmits: brain:admin + foreign companyId → 403', async () => {
    await expect(make().ctrl.dreamEmits(req(ADMIN), 'run-1', 'tenant-b')).rejects.toThrow(
      ForbiddenException,
    );
  });
  it('dreamEmits: plain brain:admin omitted → own tenant only', async () => {
    const { ctrl, seen } = make();
    await ctrl.dreamEmits(req(ADMIN), 'run-1');
    expect(seen.emitTenants).toEqual(['tenant-a']);
  });
  it('dreamEmits: platform scope + gate omitted → scans all tenants', async () => {
    gateOn();
    const { ctrl, seen } = make();
    await ctrl.dreamEmits(req(PLATFORM), 'run-1');
    expect(seen.emitTenants).toEqual(KNOWN);
  });

  it('scenariosBatch: plain brain:admin books the job under its own tenant', async () => {
    const { ctrl, seen } = make();
    await ctrl.triggerScenariosBatch(req(ADMIN, 'tenant-b'), {});
    expect(seen.reindexHost).toBe('tenant-b');
  });
  it('scenariosBatch: platform scope + gate hosts on the first tenant', async () => {
    gateOn();
    const { ctrl, seen } = make();
    await ctrl.triggerScenariosBatch(req(PLATFORM, 'tenant-b'), {});
    expect(seen.reindexHost).toBe(KNOWN[0]);
  });
});
