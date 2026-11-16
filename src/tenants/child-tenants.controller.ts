import { Controller, Delete, Param, Req, UseGuards } from '@nestjs/common';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import { PolicyAction } from '../policy/action-registry';
import type { AuthenticatedRequest } from '../auth/api-key.types';
import { ChildTenantsService, type ChildTenantEraseResult } from './child-tenants.service';

/**
 * A product's child tenants (ADR docs/adr/0001-child-tenants.md). Reading
 * and writing a child needs no route of its own: every route takes the
 * X-Brain-Child-Tenant header. Erasing one does.
 */
@Controller('v1/tenants/children')
@UseGuards(ApiKeyGuard)
export class ChildTenantsController {
  constructor(private readonly children: ChildTenantsService) {}

  /**
   * Drop a child tenant whole (company offboarding). brain:tenants is the
   * authority over this credential's children, so it is what this needs;
   * brain:erase stays the narrow "one end-user" scope it is documented as
   * (test/brain-erase-scope.unit-spec.ts). The parent is the credential's
   * own tenant, so only its own children are reachable. Must be called WITHOUT the child header: the
   * request runs as the parent.
   */
  @Delete(':childId')
  @RequireScopes('brain:tenants')
  @PolicyAction('rest.tenants.child.erase')
  erase(
    @Req() req: AuthenticatedRequest,
    @Param('childId') childId: string,
  ): Promise<ChildTenantEraseResult> {
    return this.children.erase(req.brainAuth.companyId, childId);
  }
}
