/**
 * Wire-contract drift guard for GET /v1/admin/packs.
 */
import { PacksListResponseSchema } from '../src/contracts/admin/packs.schema';
import { AdminPacksController } from '../src/admin/admin-packs.controller';
import type { DomainPackInstallService } from '../src/admin/domain-pack-install.service';
import type { PackRegistryService } from '../src/registry/pack-registry.service';
import type { AuthenticatedRequest } from '../src/auth/api-key.types';

function makeController(): AdminPacksController {
  const svc = {
    listAvailable: () => [
      {
        id: 'code_memory',
        version: '0.1.0',
        description: 'code memory',
        predicateCount: 4,
        builtin: true,
      },
    ],
    listInstalled: () =>
      Promise.resolve([
        {
          packId: 'medical',
          version: '1.0.0',
          installedAt: '2026-07-07T00:00:00.000Z',
          predicateCount: 1,
          checksum: 'abc123',
        },
      ]),
  } as unknown as DomainPackInstallService;
  const registry = {} as unknown as PackRegistryService;
  const packEval = {} as unknown as import('../src/admin/pack-eval.service').PackEvalService;
  return new AdminPacksController(svc, registry, packEval);
}

describe('AdminPacksController.list() — wire contract', () => {
  it('matches PacksListResponseSchema', async () => {
    const req = {
      brainAuth: { companyId: 'co_test' },
    } as AuthenticatedRequest;
    const parsed = PacksListResponseSchema.safeParse(
      await makeController().list(req),
    );
    if (!parsed.success) {
      throw new Error(
        `packs list drifted: ${JSON.stringify(parsed.error.issues, null, 2)}`,
      );
    }
  });
});
