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

function makeController(): AdminInfraController {
  const surreal = {
    migrator: {
      loadManifest: async () => [
        { id: '0001', name: 'init' },
        { id: '0002', name: 'add-leases' },
      ],
    },
    withCompany: async (
      _companyId: string,
      fn: (db: { query: <T>(sql: string) => Promise<T> }) => Promise<unknown>,
    ) => {
      const db = {
        query: async <T>(_sql: string): Promise<T> => [[{ migrationId: '0001' }]] as unknown as T,
      };
      return fn(db);
    },
  } as unknown as SurrealService;
  const apiKeys = {
    knownCompanyIds: () => ['tenant-a', 'tenant-b'],
  } as unknown as ApiKeyService;
  const adminInfra = new AdminInfraService(surreal, apiKeys);
  return makeAdminInfraController({ adminInfra });
}

const OLD_GATE = process.env.BRAIN_TENANT_OVERRIDE_ENABLED;
afterEach(() => {
  if (OLD_GATE === undefined) delete process.env.BRAIN_TENANT_OVERRIDE_ENABLED;
  else process.env.BRAIN_TENANT_OVERRIDE_ENABLED = OLD_GATE;
});

describe('AdminInfraController.migrations() — wire contract', () => {
  it('matches MigrationsResponseSchema', async () => {
    const parsed = MigrationsResponseSchema.safeParse(
      await makeController().migrations(adminReq()),
    );
    if (!parsed.success) {
      throw new Error(`migrations drifted: ${JSON.stringify(parsed.error.issues, null, 2)}`);
    }
  });
});

describe('AdminInfraController.migrations() — tenant isolation (P0)', () => {
  it('plain brain:admin → own tenant only (roster not enumerated)', async () => {
    const res = await makeController().migrations(adminReq(undefined, 'tenant-a'));
    expect(res.perTenant.map((t) => t.companyId)).toEqual(['tenant-a']);
  });

  it('platform scope + gate → cross-tenant drift audit', async () => {
    process.env.BRAIN_TENANT_OVERRIDE_ENABLED = '1';
    const res = await makeController().migrations(adminReq(PLATFORM_SCOPES, 'tenant-a'));
    expect(res.perTenant.map((t) => t.companyId)).toEqual(['tenant-a', 'tenant-b']);
  });
});
