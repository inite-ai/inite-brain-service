/**
 * Wire-contract drift guard for GET /v1/admin/code-memory/anchors.
 */
import { AnchorsListResponseSchema } from '../src/contracts/admin/code-memory.schema';
import { AdminCodeMemoryController } from '../src/admin/admin-code-memory.controller';
import type { CodeMemoryAnchorService } from '../src/code-memory/code-memory-anchor.service';
import type { AuthenticatedRequest } from '../src/auth/api-key.types';

function makeController(): AdminCodeMemoryController {
  const svc = {
    listAnchors: () =>
      Promise.resolve([
        {
          anchor: 'src/x.ts#Foo.bar',
          entityId: 'knowledge_entity:abc',
          factIds: ['knowledge_fact:1', 'knowledge_fact:2'],
        },
      ]),
  } as unknown as CodeMemoryAnchorService;
  return new AdminCodeMemoryController(svc);
}

describe('AdminCodeMemoryController.list() — wire contract', () => {
  it('matches AnchorsListResponseSchema', async () => {
    const req = {
      brainAuth: { companyId: 'co_test', scopes: ['brain:admin'] },
    } as AuthenticatedRequest;
    const parsed = AnchorsListResponseSchema.safeParse(
      await makeController().list(req),
    );
    if (!parsed.success) {
      throw new Error(
        `anchors list drifted: ${JSON.stringify(parsed.error.issues, null, 2)}`,
      );
    }
  });
});
