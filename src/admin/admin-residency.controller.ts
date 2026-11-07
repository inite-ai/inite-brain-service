import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import { PolicyAction } from '../policy/action-registry';
import type { AuthenticatedRequest } from '../auth/api-key.types';
import { platformTenantCapable } from '../auth/tenant-scope';
import { ResidencyAdminService } from './residency-admin.service';

/**
 * Data residency directory (#916 step 3, src/db/residency.ts). Reading a
 * tenant's region: its own admin, or a platform operator. Pinning: the
 * platform operator only (brain:platform_admin + the cross-tenant gate),
 * on each deployment that must know — the tenant's own region's cell and
 * the default deployment that must refuse it. A pin never moves data: a
 * tenant that already has a database here cannot be pinned elsewhere
 * (409) — moving a tenant is an explicit export and import.
 */
@Controller('v1/admin/residency')
@UseGuards(ApiKeyGuard)
export class AdminResidencyController {
  constructor(private readonly residency: ResidencyAdminService) {}

  @Get(':companyId')
  @RequireScopes('brain:admin')
  @PolicyAction('rest.admin.residency.get')
  async get(
    @Req() req: AuthenticatedRequest,
    @Param('companyId') companyId: string,
  ): Promise<{ companyId: string; region: string | null; deploymentRegion: string }> {
    if (companyId !== req.brainAuth.companyId && !platformTenantCapable(req.brainAuth.scopes)) {
      throw new ForbiddenException('another workspace’s residency is the platform operator’s');
    }
    return {
      companyId,
      region: await this.residency.pinOf(companyId),
      deploymentRegion: this.residency.deploymentRegion,
    };
  }

  @Put(':companyId')
  @RequireScopes('brain:admin')
  @PolicyAction('rest.admin.residency.pin')
  async pin(
    @Req() req: AuthenticatedRequest,
    @Param('companyId') companyId: string,
    @Body() body: { region?: string },
  ): Promise<{ companyId: string; region: string; deploymentRegion: string }> {
    if (!platformTenantCapable(req.brainAuth.scopes)) {
      throw new ForbiddenException('pinning residency is the platform operator’s');
    }
    const region = await this.residency.pin(
      companyId,
      body?.region ?? '',
      req.brainAuth.actorId ?? req.brainAuth.keyHash,
    );
    return { companyId, region, deploymentRegion: this.residency.deploymentRegion };
  }
}
