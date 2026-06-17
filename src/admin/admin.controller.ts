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
  ) {}

  @Get('overview')
  @RequireScopes('brain:admin')
  async overview() {
    return this.admin.buildOverview();
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
