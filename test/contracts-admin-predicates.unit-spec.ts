/**
 * Wire-contract drift guard for GET /v1/admin/predicates.
 */
import { PredicatesListResponseSchema } from '../src/contracts/admin/predicates.schema';
import { AdminPredicatesController } from '../src/admin/admin-predicates.controller';
import type { PredicateRegistryService } from '../src/ai/predicate-registry.service';
import type { AuthenticatedRequest } from '../src/auth/api-key.types';

function makeController(): AdminPredicatesController {
  const registry = {
    listAll: async () => [
      {
        predicateId: 'has_email',
        displayLabel: 'Has email',
        description: 'Subject\'s primary email address.',
        datatype: 'string' as const,
        semantics: 'single_active' as const,
        decayHalfLifeDays: null,
        piiClass: 'identifier' as const,
        requiresScope: 'brain:read_pii',
        status: 'active' as const,
        createdBy: 'system' as const,
      },
    ],
  } as unknown as PredicateRegistryService;
  return new AdminPredicatesController(registry);
}

describe('AdminPredicatesController.list() — wire contract', () => {
  it('matches PredicatesListResponseSchema', async () => {
    const req = {
      brainAuth: { companyId: 'tenant-a' },
    } as unknown as AuthenticatedRequest;
    const parsed = PredicatesListResponseSchema.safeParse(
      await makeController().list(req),
    );
    if (!parsed.success) {
      throw new Error(
        `predicates drifted: ${JSON.stringify(
          parsed.error.issues,
          null,
          2,
        )}`,
      );
    }
  });
});
