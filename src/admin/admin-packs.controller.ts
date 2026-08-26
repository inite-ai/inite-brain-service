import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import type { AuthenticatedRequest } from '../auth/api-key.types';
import { DomainPackInstallService } from './domain-pack-install.service';
import { PackRegistryService } from '../registry/pack-registry.service';
import { PackEvalService } from './pack-eval.service';
import type { DomainPackManifest, PackEvalReport } from '../ai/domain-packs';
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
  constructor(
    private readonly packs: DomainPackInstallService,
    private readonly registry: PackRegistryService,
    private readonly packEval: PackEvalService,
  ) {}

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
    @Body()
    body: {
      manifest: DomainPackManifest;
      expectedChecksum?: string;
      /** Consent to the manifest's mcpTools section (docs/mcp-pack-tools.md). */
      acceptMcpTools?: boolean;
      /** Consent to declared non-text modalities (docs/mcp-pack-tools.md). */
      acceptModalities?: boolean;
    },
  ): Promise<InstallPackResponse> {
    return this.packs.install(req.brainAuth.companyId, body?.manifest, {
      expectedChecksum: body?.expectedChecksum,
      acceptMcpTools: body?.acceptMcpTools,
      acceptModalities: body?.acceptModalities,
    });
  }

  /** Install a pack from the GLOBAL registry into this tenant. Resolves the
   *  manifest (latest non-yanked, or a pinned version) and installs it through
   *  the same path as a direct install, pinning the registry checksum so the
   *  content that gets installed is exactly what the registry served. */
  @Post('from-registry')
  @RequireScopes('brain:admin')
  async installFromRegistry(
    @Req() req: AuthenticatedRequest,
    @Body()
    body: {
      packId: string;
      version?: string;
      acceptMcpTools?: boolean;
      acceptModalities?: boolean;
    },
  ): Promise<InstallPackResponse> {
    const { manifest, checksum } = await this.registry.resolveForInstall({
      packId: body?.packId,
      version: body?.version,
      companyId: req.brainAuth.companyId,
    });
    return this.packs.install(req.brainAuth.companyId, manifest, {
      expectedChecksum: checksum,
      acceptMcpTools: body?.acceptMcpTools,
      acceptModalities: body?.acceptModalities,
    });
  }

  /** Run a pack's eval fixtures against the live extractor for this tenant —
   *  scores whether extraction (with the pack's predicates + extractionProfile
   *  active) still meets the pack's own expectations. `?mode=dedicated` runs
   *  the pack-scoped dedicated prompt instead of the union prompt; the delta
   *  between the two reports is the pack author's dedicated-mode decision. */
  @Post(':packId/eval')
  // Heaviest admin route: up to MAX_EVAL_FIXTURES live extractor (LLM) calls
  // per request. Tightest expensive bucket so it can't be looped into a cost
  // spike even by an authorized admin.
  @Throttle({ expensive: { limit: 3, ttl: 60_000 } })
  @RequireScopes('brain:admin')
  async eval(
    @Req() req: AuthenticatedRequest,
    @Param('packId') packId: string,
    @Query('mode') mode?: string,
  ): Promise<PackEvalReport> {
    if (mode !== undefined && mode !== 'union' && mode !== 'dedicated') {
      throw new BadRequestException(`mode must be 'union' or 'dedicated'`);
    }
    return this.packEval.run(req.brainAuth.companyId, packId, mode ?? 'union');
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
