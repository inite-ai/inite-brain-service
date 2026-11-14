import {
  BadRequestException,
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
import { TenantRegistryService } from '../auth/tenant-registry.service';
import {
  observedRefusals,
  platformGateMode,
  resolveModelSource,
  TENANT_MODEL_SETTINGS,
  tenantModelState,
  type TenantModelSetting,
} from '../common/model-source';
import type { ModelSourceResponse } from '../contracts/admin/model-source.schema';

/**
 * Who pays for a tenant's server-side chat calls (#945 phase 2). A tenant
 * admin reads its own and picks `auto` or `harness`; `platform` (models
 * whatever the plan — for server-to-server tenants with no agent) and any
 * other tenant are the platform operator's.
 */
@Controller('v1/admin/model-source')
@UseGuards(ApiKeyGuard)
export class AdminModelSourceController {
  constructor(private readonly registry: TenantRegistryService) {}

  @Get(':companyId')
  @RequireScopes('brain:admin')
  @PolicyAction('rest.admin.model_source.get')
  get(
    @Req() req: AuthenticatedRequest,
    @Param('companyId') companyId: string,
  ): ModelSourceResponse {
    this.assertReach(req, companyId);
    return describe(companyId);
  }

  @Put(':companyId')
  @RequireScopes('brain:admin')
  @PolicyAction('rest.admin.model_source.set')
  async set(
    @Req() req: AuthenticatedRequest,
    @Param('companyId') companyId: string,
    @Body() body: { modelSource?: string },
  ): Promise<ModelSourceResponse> {
    this.assertReach(req, companyId);
    const setting = body?.modelSource as TenantModelSetting | undefined;
    if (!setting || !TENANT_MODEL_SETTINGS.includes(setting)) {
      throw new BadRequestException(
        `modelSource must be one of ${TENANT_MODEL_SETTINGS.join(', ')}`,
      );
    }
    if (setting === 'platform' && !platformTenantCapable(req.brainAuth.scopes)) {
      throw new ForbiddenException('granting platform models is the platform operator’s');
    }
    await this.registry.setModelSource(companyId, setting);
    return describe(companyId);
  }

  private assertReach(req: AuthenticatedRequest, companyId: string): void {
    if (companyId !== req.brainAuth.companyId && !platformTenantCapable(req.brainAuth.scopes)) {
      throw new ForbiddenException('another workspace’s model source is the platform operator’s');
    }
  }
}

function describe(companyId: string): ModelSourceResponse {
  const state = tenantModelState(companyId);
  const resolved = resolveModelSource(companyId);
  return {
    companyId,
    modelSource: state?.setting ?? 'auto',
    source: resolved.source,
    reason: resolved.reason,
    gate: platformGateMode(),
    entitlementsSeen: state?.entitlements !== undefined,
    observedRefusals: observedRefusals(companyId),
  };
}
