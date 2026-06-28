import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpException,
  Logger,
  Post,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import type { AuthenticatedRequest, BrainScope } from '../auth/api-key.types';
import { DemoChatDto } from './dto/demo-chat.dto';
import { DemoDreamsDto } from './dto/demo-dreams.dto';
import { DemoIngestMentionDto } from './dto/demo-ingest-mention.dto';
import { DemoSearchDto } from './dto/demo-search.dto';
import { runWithDebugTrace } from '../common/debug-trace';
import { DemoPipelineService } from './demo-pipeline.service';
import { DemoStateService } from './demo-state.service';
import { DemoChatService } from './demo-chat.service';
import { policyFor } from '../ingest/conflict-resolver';

/**
 * Default demo tenant — used when the admin overview / router-stats
 * code paths in admin.controller.ts ask for the demo tenant id but
 * don't have an authenticated request handy. Per-caller demo tenants
 * are derived from the bearer at request time via demoTenantFor()
 * inside the controller, so two admins on different parent companies
 * no longer share the same accumulated demo state.
 */
export const DEMO_LIVE_COMPANY = 'demo_live';

/**
 * Demo state is scoped to the caller's owning tenant so two admins
 * from different companies don't see + reset each other's
 * accumulated facts. The pattern `demo_${parentCompanyId}` is the
 * convention; falls back to the legacy shared tenant when the
 * request has no auth (defensive — should not happen since the
 * controller is brain:admin-gated).
 */
function demoTenantFor(req: AuthenticatedRequest | undefined): string {
  const parent = req?.brainAuth?.companyId;
  if (!parent) return DEMO_LIVE_COMPANY;
  return `demo_${parent}`;
}

/**
 * PII scope verification for the `includePii: true` body field on
 * /demo/search and /demo/chat. Pre-fix the controller granted itself
 * `brain:read_pii` based on the caller-supplied body flag alone — a
 * brain:admin token without read_pii could thus elevate. Now we
 * insist the caller already holds read_pii; otherwise we 403 instead
 * of silently downgrading.
 */
function assertPiiScope(
  req: AuthenticatedRequest,
  wantsPii: boolean | undefined,
): readonly BrainScope[] {
  if (!wantsPii) return ['brain:read'];
  const callerScopes = req.brainAuth?.scopes ?? [];
  if (!callerScopes.includes('brain:read_pii')) {
    throw new ForbiddenException(
      `includePii=true requires brain:read_pii scope`,
    );
  }
  return ['brain:read', 'brain:read_pii'];
}

/**
 * Live-demo sandbox endpoints (companyId=demo_live). Unlike the
 * scenario runner, the demo tenant accumulates state across mentions
 * so the operator can show "tell brain X, ask brain X" interactively.
 *
 * Split out of AdminController because the demo surface owns its own
 * pipeline (chat-router → ingest or graph-first → vector-fallback)
 * that has nothing to do with the operator-facing /predicates,
 * /scenarios, /traces consoles.
 */
@Controller('v1/admin/demo')
@UseGuards(ApiKeyGuard)
export class AdminDemoController {
  private readonly logger = new Logger(AdminDemoController.name);

  constructor(
    private readonly pipeline: DemoPipelineService,
    private readonly state: DemoStateService,
    private readonly chatService: DemoChatService,
  ) {}

  @Post('ingest-mention')
  @RequireScopes('brain:admin')
  // Runs the LLM extractor end-to-end on demo state; cap aggressively.
  @Throttle({ expensive: { limit: 10, ttl: 60_000 } })
  async ingestMention(
    @Req() req: AuthenticatedRequest,
    @Body() body: DemoIngestMentionDto,
  ) {
    if (!body?.text?.trim()) {
      throw new BadRequestException('text is required');
    }
    const tenant = demoTenantFor(req);
    const captured = await runWithDebugTrace(() =>
      this.pipeline.ingestMention(tenant, {
        text: body.text,
        vertical: body.vertical,
      }),
    );
    return {
      ...captured.result,
      trace: {
        requestId: captured.trace.requestId,
        totalMs: captured.trace.totalMs,
        spans: captured.trace.spans,
        artifacts: captured.trace.artifacts,
      },
    };
  }

  // Fans out to embedding + cross-encoder/reranker like /v1/search.
  @Throttle({ expensive: { limit: 10, ttl: 60_000 } })
  @Post('search')
  @RequireScopes('brain:admin')
  async demoSearch(
    @Req() req: AuthenticatedRequest,
    @Body() body: DemoSearchDto,
  ) {
    if (!body?.query?.trim()) {
      throw new BadRequestException('query is required');
    }
    const tenant = demoTenantFor(req);
    const scopes = assertPiiScope(req, body.includePii);
    const captured = await runWithDebugTrace(() =>
      this.pipeline.runSearch(
        tenant,
        { query: body.query, limit: body.limit, asOf: body.asOf },
        scopes,
      ),
    );
    return {
      results: enrichResults(
        captured.result.results,
        captured.trace.artifacts,
      ),
      trace: {
        requestId: captured.trace.requestId,
        totalMs: captured.trace.totalMs,
        spans: captured.trace.spans,
      },
    };
  }

  /**
   * Chat-shaped one-shot endpoint. The operator types a free-form
   * line, the router decides ingest-vs-search and pulls any natural
   * temporal anchor ("yesterday", "вчера", "в марте"...) out of it,
   * and the right brain pipeline runs.
   */
  @Post('chat')
  @RequireScopes('brain:admin')
  // Router-LLM + extractor (tell) OR router-LLM + synthesize (ask).
  @Throttle({ expensive: { limit: 10, ttl: 60_000 } })
  async demoChat(
    @Req() req: AuthenticatedRequest,
    @Body() body: DemoChatDto,
  ) {
    if (!body?.message?.trim()) {
      throw new BadRequestException('message is required');
    }
    const tenant = demoTenantFor(req);
    // PII gate runs here so a missing read_pii scope 403s before any
    // LLM call burns tokens / leaves a tenant in a partial state.
    const askScopes = assertPiiScope(req, body.includePii);
    try {
      const captured = await runWithDebugTrace(() =>
        this.chatService.chat({
          message: body.message,
          tenant,
          scopes: askScopes,
        }),
      );
      const result = captured.result as any;
      if (result.search) {
        result.search = {
          results: enrichResults(
            result.search.results,
            captured.trace.artifacts,
            result.strategy,
          ),
        };
      }
      return {
        ...result,
        trace: {
          requestId: captured.trace.requestId,
          totalMs: captured.trace.totalMs,
          spans: captured.trace.spans,
          artifacts: captured.trace.artifacts,
        },
      };
    } catch (err) {
      // Preserve typed Nest exceptions (BadRequest, Forbidden, ...);
      // they're semantically meaningful and the client routes on them.
      if (err instanceof HttpException) throw err;
      // Classify transient upstream LLM failures (OpenAI premature
      // close / connection drops after the SDK's own retries). These
      // are NOT bugs in our pipeline — they're an external dependency
      // outage. Surface as 503 with a retry hint so the chat UI can
      // back off and replay instead of showing the operator a
      // generic 500.
      const e = err as Error & { code?: string };
      const isUpstream =
        e.code === 'ERR_STREAM_PREMATURE_CLOSE' ||
        /api\.openai\.com|Premature close|ECONNRESET|ETIMEDOUT|fetch failed/i.test(
          e.message ?? '',
        );
      if (isUpstream) {
        this.logger.warn(
          `/v1/admin/demo/chat upstream LLM unavailable: ${e.message}`,
        );
        throw new ServiceUnavailableException({
          reason: 'upstream_llm_unavailable',
          detail: e.message,
          retryAfterMs: 2000,
        });
      }
      throw err;
    }
  }

  // Dreams orchestration fans out to OpenAI (summaries/dedup).
  @Throttle({ expensive: { limit: 3, ttl: 60_000 } })
  @Post('dreams')
  @RequireScopes('brain:admin')
  async demoDreams(
    @Req() req: AuthenticatedRequest,
    @Body() body: DemoDreamsDto,
  ) {
    const tenant = demoTenantFor(req);
    const captured = await runWithDebugTrace(() =>
      this.pipeline.runDreams(tenant, body?.operations ?? ['dedup', 'resolve']),
    );
    return {
      ...captured.result,
      trace: {
        requestId: captured.trace.requestId,
        totalMs: captured.trace.totalMs,
        spans: captured.trace.spans,
      },
    };
  }

  @Get('state')
  @RequireScopes('brain:admin')
  async demoState(@Req() req: AuthenticatedRequest) {
    return this.state.state(demoTenantFor(req));
  }

  @Post('reset')
  @RequireScopes('brain:admin')
  async demoReset(@Req() req: AuthenticatedRequest) {
    return this.state.reset(demoTenantFor(req));
  }
}

/**
 * Enrich every fact on a brain search-hit with predicate policy AND a
 * match explainer — which retrieval leg surfaced this fact and at
 * what score, or 'backfill' if it rode along via the bitemporal
 * closure because its entity was already in the top-K from another
 * fact.
 */
function enrichResults(
  results: any[],
  artifacts: Array<{ name: string; value: unknown }> = [],
  strategy: 'graph' | 'graph→vector' = 'graph→vector',
): any[] {
  const vec = new Map<string, number>();
  const lex = new Map<string, number>();
  for (const a of artifacts) {
    if (a.name === 'search.vector_hits' && Array.isArray(a.value)) {
      for (const row of a.value as Array<Record<string, unknown>>) {
        const id = String(row.factId ?? '');
        const s = typeof row.simScore === 'number' ? row.simScore : null;
        if (id && s !== null) vec.set(id, s);
      }
    } else if (a.name === 'search.lexical_hits' && Array.isArray(a.value)) {
      for (const row of a.value as Array<Record<string, unknown>>) {
        const id = String(row.factId ?? '');
        const s = typeof row.bm25Score === 'number' ? row.bm25Score : null;
        if (id && s !== null) lex.set(id, s);
      }
    }
  }
  return results.map((r) => ({
    ...r,
    facts: r.facts.map((f: any) => {
      const policy = policyFor(f.predicate);
      const factId = String(f.factId);
      const vScore = vec.get(factId) ?? null;
      const lScore = lex.get(factId) ?? null;
      let match: {
        vector: number | null;
        lexical: number | null;
        backfill: boolean;
        subject?: boolean;
      };
      if (strategy === 'graph') {
        match = {
          vector: null,
          lexical: null,
          backfill: false,
          subject: true,
        };
      } else if (vScore !== null || lScore !== null) {
        match = { vector: vScore, lexical: lScore, backfill: false };
      } else {
        match = { vector: null, lexical: null, backfill: true };
      }
      return {
        ...f,
        policy: {
          piiClass: policy.piiClass,
          semantics: policy.semantics,
          decayHalfLifeDays: policy.decayHalfLifeDays,
          requiresScope: policy.requiresScope ?? null,
        },
        match,
      };
    }),
  }));
}
