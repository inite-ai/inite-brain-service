import {
  Body,
  Controller,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import type { AuthenticatedRequest } from '../auth/api-key.types';
import { PackRegistryService } from './pack-registry.service';
import type { DomainPackManifest } from '../ai/domain-packs';
import type {
  PublishPackResponse,
  YankPackResponse,
} from '../contracts/registry/registry.schema';

/**
 * Publisher-facing writes to the GLOBAL Domain Pack registry
 * (docs/domain-packs.md). Publish a version (immutable once published) and
 * yank / unyank a bad version. Guarded by registry:publish — distinct from
 * brain:admin because it mutates the catalogue shared across ALL tenants.
 */
@Controller('v1/admin/registry')
@UseGuards(ApiKeyGuard)
export class AdminRegistryController {
  constructor(private readonly registry: PackRegistryService) {}

  @Post('packs')
  @RequireScopes('registry:publish')
  async publish(
    @Req() req: AuthenticatedRequest,
    @Body()
    body: {
      manifest: DomainPackManifest;
      keywords?: string[];
      expectedChecksum?: string;
    },
  ): Promise<PublishPackResponse> {
    return this.registry.publish({
      manifest: body?.manifest,
      keywords: body?.keywords,
      expectedChecksum: body?.expectedChecksum,
      publishedBy: req.brainAuth.companyId,
    });
  }

  @Post('packs/:packId/:version/yank')
  @RequireScopes('registry:publish')
  async yank(
    @Param('packId') packId: string,
    @Param('version') version: string,
    @Body() body?: { reason?: string },
  ): Promise<YankPackResponse> {
    return this.registry.yank(packId, version, body?.reason);
  }

  @Post('packs/:packId/:version/unyank')
  @RequireScopes('registry:publish')
  async unyank(
    @Param('packId') packId: string,
    @Param('version') version: string,
  ): Promise<YankPackResponse> {
    return this.registry.unyank(packId, version);
  }
}
