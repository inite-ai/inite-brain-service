/**
 * Wire-contract drift guard for GET /v1/admin/migrations.
 */
import { MigrationsResponseSchema } from '../src/contracts/admin/migrations.schema';
import { AdminInfraController } from '../src/admin/admin-infra.controller';
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
        query: async <T>(_sql: string): Promise<T> =>
          [[{ migrationId: '0001' }]] as unknown as T,
      };
      return fn(db);
    },
  } as unknown as SurrealService;
  const apiKeys = {
    knownCompanyIds: () => ['tenant-a'],
  } as unknown as ApiKeyService;
  const adminInfra = new AdminInfraService(surreal, apiKeys);
  const undef = undefined as unknown as never;
  return new AdminInfraController(
    adminInfra,
    undef,
    undef,
    undef,
    undef,
    undef,
    undef,
  );
}

describe('AdminInfraController.migrations() — wire contract', () => {
  it('matches MigrationsResponseSchema', async () => {
    const parsed = MigrationsResponseSchema.safeParse(
      await makeController().migrations(),
    );
    if (!parsed.success) {
      throw new Error(
        `migrations drifted: ${JSON.stringify(parsed.error.issues, null, 2)}`,
      );
    }
  });
});
