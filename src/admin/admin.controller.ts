import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Logger,
  NotFoundException,
  Param,
  Patch,
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
import {
  runWithDebugTrace,
  TraceBufferService,
  traceArtifact,
  traceSpan,
} from '../common/debug-trace';
import { SurrealService } from '../db/surreal.service';
import { IngestService } from '../ingest/ingest.service';
import { SearchService } from '../search/search.service';
import { ChatRouterService, ChatRoute } from './chat-router.service';
import {
  PredicateRegistryService,
  PredicateDefinition,
} from '../ai/predicate-registry.service';
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
  private readonly logger = new Logger(AdminController.name);
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
    private readonly predicateRegistry: PredicateRegistryService,
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

  // ── Predicate ontology registry ─────────────────────────────────────
  // Operator-facing CRUD for the per-tenant predicate vocabulary. Adding a
  // predicate here makes the extractor admit it on the next call (60s TTL
  // on the snapshot cache, invalidated on every write below). This is how
  // a new vertical onboards without code changes — see the EDC
  // auto-classification path inside the extractor for the LLM-driven side.

  @Get('predicates')
  @RequireScopes('brain:admin')
  async listPredicates(@Req() req: AuthenticatedRequest) {
    const predicates = await this.predicateRegistry.listAll(
      req.brainAuth.companyId,
    );
    return { predicates };
  }

  @Post('predicates')
  @RequireScopes('brain:admin')
  async createPredicate(
    @Req() req: AuthenticatedRequest,
    @Body()
    body: Partial<PredicateDefinition> & {
      predicateId: string;
      semantics: 'append_only' | 'single_active' | 'bitemporal';
      piiClass: 'none' | 'identifier' | 'behavioral' | 'text' | 'sensitive';
    },
  ) {
    if (!body?.predicateId?.trim()) {
      throw new BadRequestException('predicateId is required');
    }
    if (!/^[a-z][a-z0-9_]*$/.test(body.predicateId)) {
      throw new BadRequestException(
        'predicateId must be lowercase snake_case (e.g. medical_diagnosis)',
      );
    }
    const created = await this.predicateRegistry.create(
      req.brainAuth.companyId,
      body,
    );
    return { predicate: created };
  }

  @Patch('predicates/:predicateId')
  @RequireScopes('brain:admin')
  async updatePredicate(
    @Req() req: AuthenticatedRequest,
    @Param('predicateId') predicateId: string,
    @Body()
    patch: Partial<Omit<PredicateDefinition, 'predicateId' | 'createdBy'>>,
  ) {
    const updated = await this.predicateRegistry.update(
      req.brainAuth.companyId,
      predicateId,
      patch,
    );
    if (!updated) {
      throw new NotFoundException(`Predicate ${predicateId} not found`);
    }
    return { predicate: updated };
  }

  @Delete('predicates/:predicateId')
  @RequireScopes('brain:admin')
  async deprecatePredicate(
    @Req() req: AuthenticatedRequest,
    @Param('predicateId') predicateId: string,
  ) {
    const ok = await this.predicateRegistry.deprecate(
      req.brainAuth.companyId,
      predicateId,
    );
    if (!ok) {
      throw new NotFoundException(`Predicate ${predicateId} not found`);
    }
    return { deprecated: predicateId };
  }

  @Post('predicates/:predicateId/promote')
  @RequireScopes('brain:admin')
  async promotePredicate(
    @Req() req: AuthenticatedRequest,
    @Param('predicateId') predicateId: string,
  ) {
    const result = await this.predicateRegistry.promote(
      req.brainAuth.companyId,
      predicateId,
    );
    if (!result) {
      throw new NotFoundException(`Predicate ${predicateId} not found`);
    }
    return { predicate: result };
  }

  @Post('predicates/:predicateId/alias')
  @RequireScopes('brain:admin')
  async aliasPredicate(
    @Req() req: AuthenticatedRequest,
    @Param('predicateId') predicateId: string,
    @Body() body: { canonicalId: string },
  ) {
    if (!body?.canonicalId?.trim()) {
      throw new BadRequestException('canonicalId is required');
    }
    const result = await this.predicateRegistry.alias(
      req.brainAuth.companyId,
      predicateId,
      body.canonicalId,
    );
    if (!result) {
      throw new NotFoundException(`Predicate ${predicateId} not found`);
    }
    return { predicate: result };
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
    },
  ) {
    if (!body?.message?.trim()) {
      throw new BadRequestException('message is required');
    }
    const captured = await runWithDebugTrace(async () => {
      // Pull current canonical names so the router can rewrite short
      // references ("Maria") into their canonical form ("Maria Petrov")
      // before NLU runs. This is the cheap fix for cross-message identity
      // drift — the long-term answer is fuzzy entity resolution at ingest,
      // but for the demo a router-side rewrite is enough.
      const knownNames = await this.fetchKnownEntityNames();
      const route: ChatRoute = await this.chatRouter.route(body.message, {
        knownNames,
        companyId: DEMO_LIVE_COMPANY,
      });
      const ingestText = route.normalizedMessage;
      if (route.intent === 'tell') {
        // When the router extracted a grounded validFrom anchor
        // ("last month", "in March"), pass its ISO as emittedAt so
        // brain's mention pipeline lands each fact with validFrom =
        // that anchor instead of "now". The grounding guarantee means
        // we never use an LLM-defaulted timestamp.
        const emittedAt = route.validFrom?.iso ?? new Date().toISOString();
        const ingest = await this.ingest.ingestMention(DEMO_LIVE_COMPANY, {
          text: ingestText,
          contextRef: { vertical: 'shop' },
          emittedAt,
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
      // Materialize the grounded slots into the shape graphSearch expects.
      // entityRefs = canonical names from validated mentions; hints = ids
      // from validated predicateHints; asOf = the grounded ISO or undefined.
      const entityRefs = route.mentions.map((m) => m.canonical);
      const predicateHints = route.predicateHints.map((h) => h.predicateId);
      const asOf = route.asOf?.iso;

      // Graph-first: try to resolve a named entity and fetch its facts
      // straight from SurrealDB. Cheap, deterministic, no embeddings.
      // This is the point of running brain on SurrealDB at all — vector
      // and lexical are fallback signals for queries where the subject
      // isn't explicit, not the primary retrieval.
      const graph = await traceSpan('demo.graph_first', () =>
        this.graphSearch(queryText, asOf, scopes, entityRefs, predicateHints),
      );
      const graphHasFacts = graph.results.some(
        (r: any) => Array.isArray(r.facts) && r.facts.length > 0,
      );

      if (graphHasFacts) {
        traceArtifact('demo.strategy', {
          picked: 'graph',
          graphHits: graph.results.length,
          entityRefs,
          predicateHints,
        });
        return {
          route,
          strategy: 'graph' as const,
          search: { results: graph.results },
        };
      }

      // Graph couldn't pin the subject — semantic / free-text query.
      // Run vector + lexical fusion. Mark the response so the speaker
      // can point at it: 'brain falls back to embeddings only when no
      // subject is named.'
      traceArtifact('demo.strategy', {
        picked: 'graph→vector',
        graphHits: 0,
        entityRefs,
        predicateHints,
        reason: entityRefs.length
          ? 'named subject(s) had no matching facts in window'
          : 'no named subject — topical query',
      });
      const search = await this.search.search(
        DEMO_LIVE_COMPANY,
        {
          query: queryText,
          limit: 5,
          asOf,
        } as any,
        scopes as any,
      );
      return {
        route,
        strategy: 'graph→vector' as const,
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
          captured.result.strategy,
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
        // Match shape encodes WHY this fact made it into the result set.
        //  - graph strategy: subject was pinned by canonical-name match,
        //    every fact on the entity rides along. That's a 'subject' match —
        //    NOT backfill (backfill = pulled in by bitemporal closure of a
        //    DIFFERENT entity that hit vector/lexical, which only happens on
        //    the vector path).
        //  - graph→vector: facts either hit a retrieval leg directly
        //    (vector / lexical scores) or are backfill from the
        //    bitemporal closure on the hit entity.
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
          match = {
            vector: vScore,
            lexical: lScore,
            backfill: false,
          };
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
    entityRefs?: string[],
    predicateHints?: string[],
  ): Promise<{ results: any[] }> {
    return this.surreal.withScopedCompany(
      DEMO_LIVE_COMPANY,
      callerScopes,
      async (db) => {
        const targetLc = queryText.trim().toLowerCase();
        if (!targetLc && (!entityRefs || entityRefs.length === 0)) {
          return { results: [] };
        }
        // Resolve entities by (a) explicit names the router identified as
        // subjects, then (b) substring fallback where any known canonical
        // name appears INSIDE the question text. (Sprint 1 #1 one-query
        // collapse + fuzzy `@@` fallback were reverted while triaging a
        // 500; reintroduce after the chat path is verified green.)
        let entities: any[] = [];
        if (entityRefs && entityRefs.length > 0) {
          const refsLc = entityRefs.map((n) => n.toLowerCase());
          const [eRows] = await db.query<any[][]>(
            `SELECT id, type, canonicalName, externalRefs, aliases
               FROM knowledge_entity
              WHERE mergedInto IS NONE
                AND canonicalNameLc IN $refs
              LIMIT 10`,
            { refs: refsLc },
          );
          entities = (eRows as any[]) ?? [];
        }
        if (entities.length === 0 && targetLc) {
          const [allRows] = await db.query<any[][]>(
            `SELECT id, type, canonicalName, canonicalNameLc, externalRefs, aliases
               FROM knowledge_entity
              WHERE mergedInto IS NONE AND canonicalNameLc IS NOT NONE
              LIMIT 200`,
          );
          const candidates = (allRows as any[]) ?? [];
          entities = candidates
            .filter((c: any) => {
              const nameLc = c.canonicalNameLc;
              if (typeof nameLc !== 'string' || nameLc.length < 2) return false;
              return targetLc.includes(nameLc);
            })
            .sort(
              (a: any, b: any) =>
                String(b.canonicalNameLc).length -
                String(a.canonicalNameLc).length,
            )
            .slice(0, 5);
        }
        if (entities.length === 0) return { results: [] };

        // Active-now bitemporal closure mirrors search.service.ts's
        // default 'present truth' shape. asOf swaps it for a historical
        // slice. Per-entity loop — pre-Sprint-1 shape.
        const hasHints = !!(predicateHints && predicateHints.length > 0);
        const predicateClause = hasHints ? ' AND predicate IN $hints' : '';
        const factsByEntity = new Map<string, any[]>();
        const preFilterCounts = new Map<string, number>();
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
          const params: Record<string, unknown> = {
            eid: ent.id,
            ...(asOf ? { asOf: new Date(asOf) } : {}),
            ...(hasHints ? { hints: predicateHints } : {}),
          };
          const [fRows] = await db.query<any[][]>(
            `SELECT id, predicate, object, confidence, validFrom, validUntil,
                    recordedAt, retractedAt, status, source
               FROM knowledge_fact
              WHERE ${where}${predicateClause}
              ORDER BY recordedAt DESC
              LIMIT 8`,
            params,
          );
          const rows = (fRows as any[]) ?? [];
          factsByEntity.set(String(ent.id), rows);
          preFilterCounts.set(String(ent.id), rows.length);
        }
        const results = entities;
        traceArtifact('demo.predicate_filter', {
          hints: predicateHints ?? [],
          mode: hasHints ? 'and_filter' : 'recency_topN_fallback',
          factsByEntity: Object.fromEntries(
            Array.from(preFilterCounts.entries()),
          ),
        });
        return {
          results: results.map((ent: any) => {
            const raw: any[] = factsByEntity.get(String(ent.id)) ?? [];
            // Collapse identical-shape active facts (same predicate+object).
            // Fact-level dedup is a runtime concern of dreams.dedup but the
            // demo can't wait for the sweep — for an entity that's been
            // mentioned N times the graph holds N copies of (subject, name,
            // canonical-name). Keep the most-recently-recorded representative.
            const byKey = new Map<string, any>();
            for (const f of raw) {
              const key = `${f.predicate}::${typeof f.object === 'string' ? f.object : JSON.stringify(f.object)}`;
              const prev = byKey.get(key);
              if (
                !prev ||
                new Date(f.recordedAt ?? 0).getTime() >
                  new Date(prev.recordedAt ?? 0).getTime()
              ) {
                byKey.set(key, f);
              }
            }
            const deduped = Array.from(byKey.values()).sort(
              (a: any, b: any) =>
                new Date(b.recordedAt ?? 0).getTime() -
                new Date(a.recordedAt ?? 0).getTime(),
            );
            return {
              entityId: String(ent.id),
              canonicalName: ent.canonicalName,
              entityType: ent.type,
              externalRefs: ent.externalRefs ?? {},
              score: 1,
              facts: deduped.map((f: any) => ({
                factId: String(f.id),
                predicate: f.predicate,
                object: f.object,
                confidence: f.confidence,
                status: f.status,
                validFrom: f.validFrom,
                ...(f.validUntil ? { validUntil: f.validUntil } : {}),
              })),
            };
          }),
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
