import { BadRequestException, Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import { AuthenticatedRequest } from '../auth/api-key.types';
import { ApiKeyService } from '../auth/api-key.service';
import { AggregateComposerService, AggregateRunResult } from './aggregate-composer.service';
import { ArcComposerService, ArcRunResult } from './arc-composer.service';

/**
 * Explicit triggers for the write-time insight composers (each costs one
 * LLM call per composed entity). Synchronous like the HNSW maintenance
 * trigger: the operator wants the counts before relying on the rows in
 * retrieval. Re-runs replace the previous set wholesale
 * (delete-by-recorder), so both endpoints are idempotent.
 *
 * - maintenance/aggregates — Lane C aspect aggregates (attribute
 *   rollups; enumeration pre-answers).
 * - maintenance/arcs — V9 §3 topic arcs (dated chronological
 *   narratives; the progressive-summary shape the aggregates lack).
 */
@Controller('v1/admin')
@UseGuards(ApiKeyGuard)
export class AdminAggregatesController {
  constructor(
    private readonly composer: AggregateComposerService,
    private readonly arcs: ArcComposerService,
    private readonly apiKeys: ApiKeyService,
  ) {}

  @Post('maintenance/aggregates')
  @RequireScopes('brain:admin')
  async run(
    @Req() req: AuthenticatedRequest,
    @Body()
    body: { tenant?: string; entities?: number; version?: string } = {},
  ): Promise<AggregateRunResult> {
    const { tenant, version } = this.validate(req, body);
    return this.composer.run(tenant, { entities: body.entities, version });
  }

  @Post('maintenance/arcs')
  @RequireScopes('brain:admin')
  async runArcs(
    @Req() req: AuthenticatedRequest,
    @Body()
    body: { tenant?: string; entities?: number; version?: string } = {},
  ): Promise<ArcRunResult> {
    const { tenant, version } = this.validate(req, body);
    return this.arcs.run(tenant, { entities: body.entities, version });
  }

  private validate(
    req: AuthenticatedRequest,
    body: { tenant?: string; version?: string },
  ): { tenant: string; version?: string | undefined } {
    const tenant = body.tenant?.trim() || req.brainAuth.companyId;
    if (tenant !== req.brainAuth.companyId && !this.apiKeys.knownCompanyIds().includes(tenant)) {
      throw new BadRequestException(`Unknown tenant '${tenant}' — not a registered tenant`);
    }
    const version = body.version?.trim() || undefined;
    if (version && !/^[a-z0-9-]{2,32}$/.test(version)) {
      throw new BadRequestException('version must be a short kebab-case tag (e.g. wd-v2)');
    }
    return { tenant, version };
  }
}
