import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import { AuthenticatedRequest } from '../auth/api-key.types';
import { AdminService } from './admin.service';
import { DreamsService } from '../dreams/dreams.service';
import { RunDreamsDto } from '../dreams/dto/run-dreams.dto';
import {
  ScenarioRunnerService,
  ScenarioRunOutcome,
} from './scenario-runner.service';
import { BaselineService } from './baseline.service';
import { runWithDebugTrace, TraceBufferService } from '../common/debug-trace';
import { SurrealService } from '../db/surreal.service';
import { IngestService } from '../ingest/ingest.service';
import { SearchService } from '../search/search.service';
import { ChatRouterService, ChatRoute } from './chat-router.service';
import { policyFor } from '../ingest/conflict-resolver';

/**
 * Shared tenant for the live demo slide. Single shared key so any admin
 * walking up to the deck sees the same accumulated state — the demo is
 * meant to be a sandbox an operator can wipe at will via the reset
 * endpoint. Per-user demo tenants would require a session store; not
 * worth it for a stage demo.
 */
const DEMO_LIVE_COMPANY = 'demo_live';

@Controller('v1/admin')
@UseGuards(ApiKeyGuard)
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly dreams: DreamsService,
    private readonly scenarios: ScenarioRunnerService,
    private readonly baselines: BaselineService,
    private readonly traces: TraceBufferService,
    private readonly surreal: SurrealService,
    private readonly ingest: IngestService,
    private readonly search: SearchService,
    private readonly chatRouter: ChatRouterService,
  ) {}

  @Get('overview')
  @RequireScopes('brain:admin')
  async overview() {
    return this.admin.buildOverview();
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

  // ── Scenarios ──────────────────────────────────────────────────────

  @Get('scenarios')
  @RequireScopes('brain:admin')
  listScenarios(@Query('vertical') vertical?: string) {
    const all = this.scenarios.list();
    return {
      scenarios: vertical ? all.filter((s) => s.vertical === vertical) : all,
    };
  }

  @Get('scenarios/:id')
  @RequireScopes('brain:admin')
  getScenario(@Param('id') id: string) {
    return this.scenarios.getById(id);
  }

  @Post('scenarios/:id/run')
  @RequireScopes('brain:admin')
  async runScenario(
    @Param('id') id: string,
    @Body() body: { keepTenant?: boolean },
  ) {
    return this.scenarios.runOne(id, {
      keepTenant: body?.keepTenant === true,
    });
  }

  /**
   * Synchronous batch — capped at BATCH_CAP scenarios per request so a long
   * tail of LLM-bound scenarios can't outrun Traefik / Node respond timeouts.
   * For full-suite runs the operator iterates from the UI; SSE / async-job
   * paths are tracked for a follow-up.
   */
  @Post('scenarios/run-batch')
  @RequireScopes('brain:admin')
  async runBatch(
    @Body() body: { ids?: string[]; vertical?: string; keepTenant?: boolean },
  ) {
    const BATCH_CAP = 10;
    const all = this.scenarios.list();
    const candidate = body.ids?.length
      ? body.ids
      : body.vertical
        ? all.filter((s) => s.vertical === body.vertical).map((s) => s.id)
        : all.map((s) => s.id);
    if (candidate.length > BATCH_CAP) {
      throw new BadRequestException(
        `Too many scenarios (${candidate.length}). Cap is ${BATCH_CAP} per call — split into multiple requests.`,
      );
    }
    const outcomes: ScenarioRunOutcome[] = [];
    for (const id of candidate) {
      try {
        outcomes.push(
          await this.scenarios.runOne(id, {
            keepTenant: body?.keepTenant === true,
          }),
        );
      } catch (e) {
        outcomes.push({
          scenarioId: id,
          vertical: 'cross',
          companyId: '-',
          startedAt: new Date().toISOString(),
          durationMs: 0,
          passed: false,
          setupSummary: {
            facts: 0,
            mentions: 0,
            links: 0,
            retracts: 0,
            forgets: 0,
            errors: [{ step: -1, kind: 'runtime', error: (e as Error).message }],
          },
          queryResults: [],
          memoryAssertionResults: [],
          metrics: {
            recallAt1: 0,
            recallAt5: 0,
            queries: 0,
            passes: 0,
            memoryAssertionsPassed: 0,
            memoryAssertionsTotal: 0,
            piiGatingPassed: 0,
            piiGatingTotal: 0,
          },
        });
      }
    }
    return { outcomes };
  }

  // ── Baselines ──────────────────────────────────────────────────────

  @Get('baselines')
  @RequireScopes('brain:admin')
  listBaselines() {
    return this.baselines.list();
  }

  @Post('baselines/:name')
  @RequireScopes('brain:admin')
  async saveBaseline(
    @Param('name') name: string,
    @Body() body: { outcomes: ScenarioRunOutcome[] },
  ) {
    if (!body?.outcomes?.length) {
      throw new BadRequestException('outcomes[] required and must be non-empty');
    }
    return this.baselines.save(name, body.outcomes);
  }

  @Post('baselines/:name/diff')
  @RequireScopes('brain:admin')
  async diffBaseline(
    @Param('name') name: string,
    @Body() body: { outcomes: ScenarioRunOutcome[] },
  ) {
    return this.baselines.diff(name, body?.outcomes ?? []);
  }

  // ── Traces ─────────────────────────────────────────────────────────
  //
  // Trace records are scoped to the caller's companyId. The interceptor
  // refuses to write snapshots for non-admin callers in the first place,
  // and the buffer filter here keeps one admin from reading another
  // tenant's artifacts. There is intentionally no super-admin global view.

  @Get('traces')
  @RequireScopes('brain:admin')
  listTraces(@Req() req: AuthenticatedRequest) {
    return { traces: this.traces.list(req.brainAuth.companyId) };
  }

  @Get('traces/:requestId')
  @RequireScopes('brain:admin')
  getTrace(
    @Req() req: AuthenticatedRequest,
    @Param('requestId') requestId: string,
  ) {
    const t = this.traces.get(requestId, req.brainAuth.companyId);
    if (!t) throw new NotFoundException(`Trace ${requestId} not found`);
    return t;
  }

  // ── Tenants ────────────────────────────────────────────────────────

  @Delete('tenants/:companyId')
  @RequireScopes('brain:admin')
  async dropTenant(@Param('companyId') companyId: string) {
    // Only ephemeral eval tenants can be dropped via the admin API.
    // This is the safe-by-default rule — operator can never accidentally
    // drop a real `co_<companyId>` database through this surface.
    if (!companyId.startsWith('eval_')) {
      throw new ForbiddenException(
        `Only ephemeral eval_* tenants can be dropped via admin API`,
      );
    }
    await this.surreal.dropCompanyDatabase(companyId);
    return { dropped: companyId };
  }

  // ── Live demo sandbox ──────────────────────────────────────────────
  // Persistent demo tenant (companyId=demo_live) the presenter writes to
  // from a chat-shaped slide. Unlike scenarios — which are ephemeral —
  // this tenant accumulates state across mentions so the operator can
  // show "tell brain X, ask brain X" interactively. Reset endpoint
  // wipes the tenant between runs.

  @Post('demo/ingest-mention')
  @RequireScopes('brain:admin')
  async demoIngestMention(@Body() body: { text: string; vertical?: string }) {
    if (!body?.text?.trim()) {
      throw new BadRequestException('text is required');
    }
    const captured = await runWithDebugTrace(() =>
      this.ingest.ingestMention(DEMO_LIVE_COMPANY, {
        text: body.text,
        contextRef: { vertical: body.vertical ?? 'shop' },
        emittedAt: new Date().toISOString(),
      } as any),
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

  @Post('demo/search')
  @RequireScopes('brain:admin')
  async demoSearch(
    @Body()
    body: { query: string; limit?: number; asOf?: string; includePii?: boolean },
  ) {
    if (!body?.query?.trim()) {
      throw new BadRequestException('query is required');
    }
    const scopes = body.includePii
      ? ['brain:read', 'brain:read_pii']
      : ['brain:read'];
    const captured = await runWithDebugTrace(() =>
      this.search.search(
        DEMO_LIVE_COMPANY,
        {
          query: body.query,
          limit: body.limit ?? 5,
          asOf: body.asOf,
        } as any,
        scopes as any,
      ),
    );
    return {
      results: this.enrichResults(
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
   * Chat-shaped one-shot endpoint. The operator types a free-form line, the
   * router decides ingest-vs-search and pulls any natural temporal anchor
   * ("yesterday", "вчера", "в марте"...) out of it, and the right brain
   * pipeline runs. Returned to the UI as a single timeline turn so the
   * audience sees the route the LLM picked.
   */
  @Post('demo/chat')
  @RequireScopes('brain:admin')
  async demoChat(
    @Body()
    body: {
      message: string;
      includePii?: boolean;
      /** 'vector' = current pipeline (vector/lexical fusion + rerank).
       *  'graph'  = resolve entity by name and fetch its facts directly.
       *             Best when the query names a subject. */
      mode?: 'vector' | 'graph';
    },
  ) {
    if (!body?.message?.trim()) {
      throw new BadRequestException('message is required');
    }
    const mode = body.mode ?? 'vector';
    const captured = await runWithDebugTrace(async () => {
      // Pull current canonical names so the router can rewrite short
      // references ("Maria") into their canonical form ("Maria Petrov")
      // before NLU runs. This is the cheap fix for cross-message identity
      // drift — the long-term answer is fuzzy entity resolution at ingest,
      // but for the demo a router-side rewrite is enough.
      const knownNames = await this.fetchKnownEntityNames();
      const route: ChatRoute = await this.chatRouter.route(body.message, {
        knownNames,
      });
      const ingestText = route.normalizedMessage ?? body.message;
      if (route.intent === 'tell') {
        const ingest = await this.ingest.ingestMention(DEMO_LIVE_COMPANY, {
          text: ingestText,
          contextRef: { vertical: 'shop' },
          emittedAt: new Date().toISOString(),
        } as any);
        // Lazy fast-path identity resolution. Mirrors how a brain SHOULD
        // behave in production: cheap inline dedup runs in the moment so
        // an obvious dupe (typo, alias) gets stitched immediately and the
        // next query sees the merged shape. Heavy semantic resolution still
        // belongs to the background dream sweep that the operator can fire
        // manually from the UI (or schedule nightly out-of-band).
        let autoDedup: { identityLinksCreated?: number } | undefined;
        try {
          const r = await this.dreams.runForTenant(DEMO_LIVE_COMPANY, [
            'dedup',
          ]);
          autoDedup = r.dedup
            ? { identityLinksCreated: r.dedup.identityLinksCreated }
            : undefined;
        } catch (e) {
          // Auto-dedup is best-effort; an error here MUST NOT fail the
          // ingest. The deep sweep button will still pick it up later.
          autoDedup = undefined;
        }
        return { route, ingest, autoDedup };
      }
      const scopes = body.includePii
        ? ['brain:read', 'brain:read_pii']
        : ['brain:read'];
      const queryText = route.cleanedQuery ?? body.message;
      const search =
        mode === 'graph'
          ? await this.graphSearch(queryText, route.asOf, scopes)
          : await this.search.search(
              DEMO_LIVE_COMPANY,
              {
                query: queryText,
                limit: 5,
                asOf: route.asOf,
              } as any,
              scopes as any,
            );
      return {
        route,
        mode,
        search: { results: search.results },
      };
    });
    // enrichResults needs the trace artifacts; do it on the way out so
    // the explainer can read what the search legs returned.
    if (captured.result.search) {
      captured.result.search = {
        results: this.enrichResults(
          captured.result.search.results,
          captured.trace.artifacts,
        ),
      };
    }
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

  @Post('demo/dreams')
  @RequireScopes('brain:admin')
  async demoDreams(@Body() body: { operations?: ('dedup' | 'resolve')[] }) {
    const captured = await runWithDebugTrace(() =>
      this.dreams.runForTenant(
        DEMO_LIVE_COMPANY,
        body?.operations ?? ['dedup', 'resolve'],
      ),
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

  /**
   * Enrich every fact on a brain search-hit with predicate policy AND a
   * match explainer — which retrieval leg surfaced this fact and at what
   * score, or 'backfill' if it rode along via the bitemporal closure
   * because its entity was already in the top-K from another fact.
   *
   * The vector_hits / lexical_hits artifacts come straight from the
   * search.service.ts traceArtifact calls — factId is the join key.
   */
  private enrichResults(
    results: any[],
    artifacts: Array<{ name: string; value: unknown }> = [],
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
        const match =
          vScore !== null || lScore !== null
            ? {
                vector: vScore,
                lexical: lScore,
                backfill: false,
              }
            : { vector: null, lexical: null, backfill: true };
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

  /**
   * Graph-first retrieval for the demo. Resolves the query to an entity
   * by canonical name / alias, then SELECTs the entity's facts under the
   * same bitemporal + scope policy the search service uses. No vector
   * leg, no lexical leg — pure governed-graph lookup. This is what brain
   * SHOULD do when the agent already named the subject; vector/lexical
   * are only valuable when the subject is implicit.
   *
   * Returns the same shape as SearchService.search so the demo UI can
   * render either response with one component.
   */
  private async graphSearch(
    queryText: string,
    asOf: string | undefined,
    callerScopes: string[],
  ): Promise<{ results: any[] }> {
    return this.surreal.withScopedCompany(
      DEMO_LIVE_COMPANY,
      callerScopes,
      async (db) => {
        const target = queryText.trim().toLowerCase();
        if (!target) return { results: [] };
        // Resolve entity by canonicalNameLc / aliases / substring on
        // canonicalName so 'maria diet' still finds 'Maria Petrov'.
        const [eRows] = await db.query<any[][]>(
          `SELECT id, type, canonicalName, externalRefs, aliases
             FROM knowledge_entity
            WHERE mergedInto IS NONE
              AND (canonicalNameLc CONTAINS $target
                   OR canonicalNameLc = $target
                   OR aliases CONTAINSANY [$target])
            LIMIT 5`,
          { target },
        );
        const entities = (eRows as any[]) ?? [];
        if (entities.length === 0) return { results: [] };
        // Active-now bitemporal closure mirrors search.service.ts's
        // default 'present truth' shape. asOf swaps it for a historical
        // slice.
        const factsByEntity = new Map<string, any[]>();
        for (const ent of entities) {
          const where = asOf
            ? `entityId = $eid
               AND (retractedAt IS NONE OR retractedAt > $asOf)
               AND validFrom <= $asOf
               AND (validUntil IS NONE OR validUntil > $asOf)
               AND status != 'compacted'`
            : `entityId = $eid
               AND retractedAt IS NONE
               AND validFrom <= time::now()
               AND (validUntil IS NONE OR validUntil > time::now())
               AND status NOT IN ['superseded', 'compacted']`;
          const [fRows] = await db.query<any[][]>(
            `SELECT id, predicate, object, confidence, validFrom, validUntil,
                    recordedAt, retractedAt, status, source
               FROM knowledge_fact
              WHERE ${where}
              ORDER BY recordedAt DESC
              LIMIT 10`,
            { eid: ent.id, ...(asOf ? { asOf: new Date(asOf) } : {}) },
          );
          factsByEntity.set(String(ent.id), (fRows as any[]) ?? []);
        }
        return {
          results: entities.map((ent: any) => ({
            entityId: String(ent.id),
            canonicalName: ent.canonicalName,
            entityType: ent.type,
            externalRefs: ent.externalRefs ?? {},
            score: 1,
            facts: (factsByEntity.get(String(ent.id)) ?? []).map((f: any) => ({
              factId: String(f.id),
              predicate: f.predicate,
              object: f.object,
              confidence: f.confidence,
              status: f.status,
              validFrom: f.validFrom,
              ...(f.validUntil ? { validUntil: f.validUntil } : {}),
            })),
          })),
        };
      },
    );
  }

  private async fetchKnownEntityNames(): Promise<string[]> {
    // Top 25 canonical names from the demo tenant — bounded so the router
    // prompt doesn't bloat. Best-effort: if the tenant is empty / the read
    // fails, return [] and the router just won't canonicalise this turn.
    try {
      return await this.surreal.withCompany(
        DEMO_LIVE_COMPANY,
        async (db) => {
          const [rows] = await db.query<[Array<{ canonicalName: string }>]>(
            `SELECT canonicalName FROM knowledge_entity ` +
              `WHERE mergedInto IS NONE AND canonicalName IS NOT NONE ` +
              `LIMIT 25`,
          );
          return ((rows as Array<{ canonicalName: string }>) ?? [])
            .map((r) => r.canonicalName)
            .filter(Boolean);
        },
      );
    } catch {
      return [];
    }
  }

  @Get('demo/state')
  @RequireScopes('brain:admin')
  async demoState() {
    try {
      const counts = await this.surreal.withCompany(
        DEMO_LIVE_COMPANY,
        async (db) => {
          const [eRows, fRows, lastRows] = (await db.query<
            [
              Array<{ c: number }>,
              Array<{ c: number }>,
              Array<{ recordedAt?: string }>,
            ]
          >(
            `SELECT count() AS c FROM knowledge_entity WHERE mergedInto IS NONE GROUP ALL;
             SELECT count() AS c FROM knowledge_fact WHERE retractedAt IS NONE GROUP ALL;
             SELECT recordedAt FROM knowledge_fact ORDER BY recordedAt DESC LIMIT 1;`,
          )) as any;
          const entities = (eRows as Array<{ c: number }>)?.[0]?.c ?? 0;
          const facts = (fRows as Array<{ c: number }>)?.[0]?.c ?? 0;
          const lastAt =
            (lastRows as Array<{ recordedAt?: string }>)?.[0]?.recordedAt;
          return { entities, facts, lastIngestAt: lastAt ?? null };
        },
      );
      return counts;
    } catch {
      // Tenant doesn't exist yet — that's a clean state, not an error.
      return { entities: 0, facts: 0, lastIngestAt: null };
    }
  }

  @Post('demo/reset')
  @RequireScopes('brain:admin')
  async demoReset() {
    try {
      await this.surreal.dropCompanyDatabase(DEMO_LIVE_COMPANY);
    } catch (e) {
      // Reset is idempotent — a missing DB is a success state, not an error.
      return { dropped: false, reason: (e as Error).message };
    }
    return { dropped: true };
  }
}
