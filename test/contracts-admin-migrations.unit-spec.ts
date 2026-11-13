/**
 * Wire-contract drift guard for GET /v1/admin/migrations.
 *
 * Also pins tenant isolation (P0): a plain brain:admin audits only its own
 * tenant's schema state (never enumerates the roster); a platform operator
 * (brain:platform_admin + gate) keeps the cross-tenant drift audit.
 */
import { MigrationsResponseSchema } from '../src/contracts/admin/migrations.schema';
import { makeAdminInfraController, adminReq, PLATFORM_SCOPES } from './helpers/admin-controllers';
import type { AdminInfraController } from '../src/admin/admin-infra.controller';
import { AdminInfraService } from '../src/admin/admin-infra.service';
import type { SurrealService } from '../src/db/surreal.service';
import type { ApiKeyService } from '../src/auth/api-key.service';

function makeController(ledgers: Record<string, string[] | Error> = {}): {
  controller: AdminInfraController;
  withCompany: jest.Mock;
} {
  // withCompany migrates before it runs anything — the audit must never
  // reach for it, or "pending" could never be observed.
  const withCompany = jest.fn(async () => {
    throw new Error('the audit must not migrate the tenant it reads');
  });
  const surreal = {
    migrator: {
      loadManifest: async () => [
        { id: '0001', name: 'init' },
        { id: '0002', name: 'add-leases' },
      ],
    },
    withCompany,
    readMigrationLedger: async (companyId: string) => {
      const ledger = ledgers[companyId] ?? ['0001'];
      if (ledger instanceof Error) throw ledger;
      return ledger;
    },
  } as unknown as SurrealService;
  const apiKeys = {
    knownCompanyIds: () => ['tenant-a', 'tenant-b'],
    fanOutRoster: () => ['tenant-a', 'tenant-b'],
  } as unknown as ApiKeyService;
  const adminInfra = new AdminInfraService(surreal, apiKeys);
  return { controller: makeAdminInfraController({ adminInfra }), withCompany };
}

const OLD_GATE = process.env.BRAIN_TENANT_OVERRIDE_ENABLED;
afterEach(() => {
  if (OLD_GATE === undefined) delete process.env.BRAIN_TENANT_OVERRIDE_ENABLED;
  else process.env.BRAIN_TENANT_OVERRIDE_ENABLED = OLD_GATE;
});

describe('AdminInfraController.migrations() — wire contract', () => {
  it('matches MigrationsResponseSchema', async () => {
    const parsed = MigrationsResponseSchema.safeParse(
      await makeController().controller.migrations(adminReq()),
    );
    if (!parsed.success) {
      throw new Error(`migrations drifted: ${JSON.stringify(parsed.error.issues, null, 2)}`);
    }
  });
});

describe('AdminInfraController.migrations() — tenant isolation (P0)', () => {
  it('plain brain:admin → own tenant only (roster not enumerated)', async () => {
    const res = await makeController().controller.migrations(adminReq(undefined, 'tenant-a'));
    expect(res.perTenant.map((t) => t.companyId)).toEqual(['tenant-a']);
  });

  it('platform scope + gate → cross-tenant drift audit', async () => {
    process.env.BRAIN_TENANT_OVERRIDE_ENABLED = '1';
    const res = await makeController().controller.migrations(adminReq(PLATFORM_SCOPES, 'tenant-a'));
    expect(res.perTenant.map((t) => t.companyId)).toEqual(['tenant-a', 'tenant-b']);
  });
});

describe('AdminInfraController.migrations() — reads the ledger as it is', () => {
  beforeEach(() => {
    process.env.BRAIN_TENANT_OVERRIDE_ENABLED = '1';
  });

  it('reports pending files without migrating the tenant', async () => {
    const { controller, withCompany } = makeController({
      'tenant-a': ['0001', '0002'],
      'tenant-b': ['0001'],
    });
    const res = await controller.migrations(adminReq(PLATFORM_SCOPES, 'tenant-a'));
    expect(res.perTenant).toEqual([
      { companyId: 'tenant-a', applied: ['0001', '0002'], pending: [] },
      { companyId: 'tenant-b', applied: ['0001'], pending: ['0002'] },
    ]);
    expect(res.driftDetected).toBe(true);
    expect(withCompany).not.toHaveBeenCalled();
  });

  it('reports an unreadable ledger as an error state, not as "all pending"', async () => {
    const { controller } = makeController({
      'tenant-a': ['0001', '0002'],
      'tenant-b': new Error('connection reset (secret detail)'),
    });
    const res = await controller.migrations(adminReq(PLATFORM_SCOPES, 'tenant-a'));
    expect(MigrationsResponseSchema.safeParse(res).success).toBe(true);
    const b = res.perTenant.find((t) => t.companyId === 'tenant-b')!;
    expect(b).toEqual({
      companyId: 'tenant-b',
      applied: [],
      pending: [],
      error: 'ledger read failed',
    });
    expect(res.driftDetected).toBe(true);
  });
});
