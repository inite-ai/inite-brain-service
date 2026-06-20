import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import type { AuthenticatedRequest } from '../auth/api-key.types';
import { AdminService } from './admin.service';
import { DreamsService } from '../dreams/dreams.service';
import { RunDreamsDto } from '../dreams/dto/run-dreams.dto';
import { SurrealService } from '../db/surreal.service';
import { ChatRouterCacheService } from './chat-router-cache.service';
import { CollapsePatternService } from './collapse-pattern.service';
import { IntentClassifierService } from './intent-classifier.service';
import { EmbedderService } from '../ai/embedder.service';
import { ReindexEmbeddingsService } from '../ai/embedder/reindex-embeddings.service';
import { DEMO_LIVE_COMPANY } from './admin-demo.controller';

/**
 * Operator-facing core admin endpoints — overview, hybrid-router
 * observability, dreams trigger, eval-tenant cleanup.
 *
 * The fan-out controller this used to be has been split along
 * operator-workflow boundaries:
 *   - /v1/admin/predicates/*    → AdminPredicatesController
 *   - /v1/admin/scenarios/*     → AdminEvalController
 *   - /v1/admin/baselines/*     → AdminEvalController
 *   - /v1/admin/traces/*        → AdminEvalController
 *   - /v1/admin/demo/*          → AdminDemoController
 * Anything that survives here is "global operator console" — small
 * deps, no demo-pipeline coupling.
 */
@Controller('v1/admin')
@UseGuards(ApiKeyGuard)
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly dreams: DreamsService,
    private readonly surreal: SurrealService,
    private readonly routeCache: ChatRouterCacheService,
    private readonly collapsePatterns: CollapsePatternService,
    private readonly intentClassifier: IntentClassifierService,
    private readonly embedder: EmbedderService,
    private readonly reindex: ReindexEmbeddingsService,
  ) {}

  @Get('overview')
  @RequireScopes('brain:admin')
  async overview() {
    return this.admin.buildOverview();
  }

  /**
   * Read-side of the `audit_event` table (migration 0023). Operator
   * view of the CHANGEFEED tail — who created / updated / deleted /
   * defined what, when, with before/after payloads.
   *
   * Filters: companyId, source, op, since (ISO), before (ISO), limit
   * (capped at 500). Returns aggregate totals and hourly buckets so
   * the UI can render charts without a second round-trip.
   */
  @Get('audit')
  @RequireScopes('brain:admin')
  async audit(
    @Query('companyId') companyId?: string,
    @Query('source') source?: string,
    @Query('op') op?: string,
    @Query('since') since?: string,
    @Query('before') before?: string,
    @Query('limit') limit?: string,
  ) {
    const parsedLimit = limit ? parseInt(limit, 10) : undefined;
    return this.admin.listAuditEvents({
      companyId: companyId?.trim() || undefined,
      source: source?.trim() || undefined,
      op: op?.trim() || undefined,
      since: since?.trim() || undefined,
      before: before?.trim() || undefined,
      limit:
        parsedLimit !== undefined && Number.isFinite(parsedLimit)
          ? parsedLimit
          : undefined,
    });
  }

  /**
   * Hybrid chat-router observability — surfaces the local-pre-pass
   * cache and gate state so an operator can chart the LLM-skip rate
   * and warmup status without scraping trace artifacts.
   *
   *   GET /v1/admin/router/stats?companyId=<tenant>
   *
   * companyId defaults to the live-demo tenant. Per-tenant figure
   * for the collapse-pattern pool size (the only stat that's
   * tenant-scoped); everything else is process-wide.
   */
  @Get('router/stats')
  @RequireScopes('brain:admin')
  async routerStats(
    @Query('companyId') companyId?: string,
  ): Promise<{
    tenant: string;
    routeCache: ReturnType<ChatRouterCacheService['stats']>;
    embedderCache: ReturnType<EmbedderService['cacheStats']>;
    intentClassifier: ReturnType<IntentClassifierService['stats']>;
    collapsePatternPoolSize: number;
  }> {
    const tenant = companyId?.trim() || DEMO_LIVE_COMPANY;
    return {
      tenant,
      routeCache: this.routeCache.stats(),
      embedderCache: this.embedder.cacheStats(),
      intentClassifier: this.intentClassifier.stats(),
      collapsePatternPoolSize: await this.collapsePatterns.poolSize(tenant),
    };
  }

  @Post('dreams/run')
  @RequireScopes('brain:admin')
  async runDreams(
    @Req() req: AuthenticatedRequest,
    @Body() body: RunDreamsDto,
  ) {
    return this.dreams.runForTenant(
      req.brainAuth.companyId,
      body.operations ?? ['dedup', 'resolve'],
    );
  }

  /**
   * Only ephemeral eval tenants can be dropped via the admin API.
   * This is the safe-by-default rule — operator can never accidentally
   * drop a real `co_<companyId>` database through this surface.
   */
  /**
   * Re-embed existing knowledge_fact rows with the active
   * EmbedderService provider. Operator-triggered after flipping
   * `EMBEDDER_PROVIDER=bge-m3` so historical facts (still carrying
   * the OpenAI vector) move into the new vector space.
   *
   *   POST /v1/admin/reindex/embeddings?dryRun=true
   *
   * Query params:
   *   tenant   — limit to a single companyId (default: every known)
   *   dryRun   — when "true" count rows but write nothing
   *   maxFacts — hard cap on facts processed across all tenants
   */
  @Post('reindex/embeddings')
  @RequireScopes('brain:admin')
  async reindexEmbeddings(
    @Query('tenant') tenant?: string,
    @Query('dryRun') dryRun?: string,
    @Query('maxFacts') maxFacts?: string,
  ) {
    const parsedMaxFacts = maxFacts ? parseInt(maxFacts, 10) : undefined;
    return this.reindex.run({
      tenant: tenant?.trim() || undefined,
      dryRun: dryRun === 'true',
      maxFacts:
        parsedMaxFacts !== undefined && Number.isFinite(parsedMaxFacts)
          ? parsedMaxFacts
          : undefined,
    });
  }

  @Delete('tenants/:companyId')
  @RequireScopes('brain:admin')
  async dropTenant(@Param('companyId') companyId: string) {
    if (!companyId.startsWith('eval_')) {
      throw new ForbiddenException(
        `Only ephemeral eval_* tenants can be dropped via admin API`,
      );
    }
    await this.surreal.dropCompanyDatabase(companyId);
    return { dropped: companyId };
  }
}
