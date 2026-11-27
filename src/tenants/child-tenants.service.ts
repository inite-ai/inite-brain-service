import { Injectable, Logger } from '@nestjs/common';
import { SurrealService } from '../db/surreal.service';
import { TenantRegistryService } from '../auth/tenant-registry.service';
import { childTenantId } from '../auth/child-tenant';

export interface ChildTenantEraseResult {
  childId: string;
  erased: true;
}

/**
 * Whole-child erase: a product offboarding one of its client companies
 * (ADR docs/adr/0001-child-tenants.md). The child's database is dropped,
 * every row with it, and its registry row removed so background loops
 * stop walking it. Synchronous and complete, like any forget; the id can
 * be used again later and starts empty.
 */
@Injectable()
export class ChildTenantsService {
  private readonly logger = new Logger(ChildTenantsService.name);

  constructor(
    private readonly surreal: SurrealService,
    private readonly registry: TenantRegistryService,
  ) {}

  async erase(parent: string, child: string): Promise<ChildTenantEraseResult> {
    const childId = childTenantId(parent, child);
    await this.surreal.dropCompanyDatabase(childId);
    await this.registry.forget(childId);
    this.logger.warn(`child tenant erased by its parent: ${childId}`);
    return { childId, erased: true };
  }
}
