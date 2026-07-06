import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import type { AuthenticatedRequest } from '../auth/api-key.types';
import { DomainPackInstallService } from './domain-pack-install.service';
import type { DomainPackManifest } from '../ai/domain-packs';
import type {
  InstallPackResponse,
  PacksListResponse,
  UninstallPackResponse,
} from '../contracts/admin/packs.schema';

/**
 * Operator-facing runtime Domain Pack management (docs/domain-packs.md). Install
 * a community / custom pack manifest into this tenant, list what's available +
 * installed, or uninstall (deprecates the pack's predicates; facts survive).
 * Builtin packs are globally available and cannot be installed/uninstalled here.
 * All routes require brain:admin.
 */
@Controller('v1/admin/packs')
@UseGuards(ApiKeyGuard)
export class AdminPacksController {
  constructor(private readonly packs: DomainPackInstallService) {}

  @Get()
  @RequireScopes('brain:admin')
  async list(@Req() req: AuthenticatedRequest): Promise<PacksListResponse> {
    const [available, installed] = await Promise.all([
      Promise.resolve(this.packs.listAvailable()),
      this.packs.listInstalled(req.brainAuth.companyId),
    ]);
    return { available, installed } satisfies PacksListResponse;
  }

  @Post()
  @RequireScopes('brain:admin')
  async install(
    @Req() req: AuthenticatedRequest,
    @Body() body: { manifest: DomainPackManifest; expectedChecksum?: string },
  ): Promise<InstallPackResponse> {
    return this.packs.install(req.brainAuth.companyId, body?.manifest, {
      expectedChecksum: body?.expectedChecksum,
    });
  }

  @Delete(':packId')
  @RequireScopes('brain:admin')
  async uninstall(
    @Req() req: AuthenticatedRequest,
    @Param('packId') packId: string,
  ): Promise<UninstallPackResponse> {
    return this.packs.uninstall(req.brainAuth.companyId, packId);
  }
}
