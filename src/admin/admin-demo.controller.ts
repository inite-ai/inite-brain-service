import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import {
  runWithDebugTrace,
  traceArtifact,
  traceSpan,
} from '../common/debug-trace';
import { SurrealService } from '../db/surreal.service';
import { IngestService } from '../ingest/ingest.service';
import { SearchService } from '../search/search.service';
import { DreamsService } from '../dreams/dreams.service';
import { ChatRouterService, ChatRoute } from './chat-router.service';
import { policyFor } from '../ingest/conflict-resolver';

/**
 * Shared tenant for the live demo slide. Single shared key so any admin
 * walking up to the deck sees the same accumulated state — the demo is
 * meant to be a sandbox an operator can wipe at will via the reset
 * endpoint. Per-user demo tenants would require a session store; not
 * worth it for a stage demo.
 */
export const DEMO_LIVE_COMPANY = 'demo_live';

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
  constructor(
    private readonly surreal: SurrealService,
    private readonly ingest: IngestService,
    private readonly search: SearchService,
    private readonly dreams: DreamsService,
    private readonly chatRouter: ChatRouterService,
  ) {}

  @Post('ingest-mention')
  @RequireScopes('brain:admin')
  async ingestMention(@Body() body: { text: string; vertical?: string }) {
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

  @Post('search')
  @RequireScopes('brain:admin')
  async demoSearch(
    @Body()
    body: {
      query: string;
      limit?: number;
      asOf?: string;
      includePii?: boolean;
    },
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
      const knownNames = await this.fetchKnownEntityNames();
      const route: ChatRoute = await this.chatRouter.route(body.message, {
        knownNames,
        companyId: DEMO_LIVE_COMPANY,
      });
      if (route.intent === 'tell') {
        return this.runTellChat(route);
      }
      return this.runAskChat(route, body);
    });
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
  }

  private async runTellChat(route: ChatRoute) {
    const emittedAt = route.validFrom?.iso ?? new Date().toISOString();
    const ingest = await this.ingest.ingestMention(DEMO_LIVE_COMPANY, {
      text: route.normalizedMessage,
      contextRef: { vertical: 'shop' },
      emittedAt,
    } as any);
    // Lazy fast-path identity resolution. Mirrors how a brain SHOULD
    // behave in production: cheap inline dedup runs in the moment so an
    // obvious dupe (typo, alias) gets stitched immediately and the next
    // query sees the merged shape.
    let autoDedup: { identityLinksCreated?: number } | undefined;
    try {
      const r = await this.dreams.runForTenant(DEMO_LIVE_COMPANY, ['dedup']);
      autoDedup = r.dedup
        ? { identityLinksCreated: r.dedup.identityLinksCreated }
        : undefined;
    } catch {
      // Auto-dedup is best-effort; an error here MUST NOT fail the
      // ingest. The deep sweep button will still pick it up later.
      autoDedup = undefined;
    }
    return { route, ingest, autoDedup };
  }

  private async runAskChat(
    route: ChatRoute,
    body: { message: string; includePii?: boolean },
  ) {
    const scopes = body.includePii
      ? ['brain:read', 'brain:read_pii']
      : ['brain:read'];
    const queryText = route.cleanedQuery ?? body.message;
    const entityRefs = route.mentions.map((m) => m.canonical);
    const predicateHints = route.predicateHints.map((h) => h.predicateId);
    const asOf = route.asOf?.iso;

    // Graph-first: resolve named entities, walk their 1-hop
    // neighbourhood, and fetch facts across (seeds ∪ neighbours)
    // optionally filtered by predicate hints. The neighbour walk is
    // what lets "who runs engineering at Acme" find Maria's status
    // fact even though Acme itself has no status fact — the answer
    // is one edge away.
    const graph = await traceSpan('demo.graph_first', () =>
      this.search.graphRetrieve(
        DEMO_LIVE_COMPANY,
        queryText,
        entityRefs,
        predicateHints,
        asOf,
        scopes,
      ),
    );
    const graphHasFacts = graph.results.some(
      (r) => Array.isArray(r.facts) && r.facts.length > 0,
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
    // Graph couldn't pin the subject — fall back to vector+lexical.
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
      { query: queryText, limit: 5, asOf } as any,
      scopes as any,
    );
    return {
      route,
      strategy: 'graph→vector' as const,
      search: { results: search.results },
    };
  }

  @Post('dreams')
  @RequireScopes('brain:admin')
  async demoDreams(
    @Body() body: { operations?: ('dedup' | 'resolve')[] },
  ) {
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

  @Get('state')
  @RequireScopes('brain:admin')
  async demoState() {
    try {
      return await this.surreal.withCompany(
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
          const entities =
            (eRows as Array<{ c: number }>)?.[0]?.c ?? 0;
          const facts = (fRows as Array<{ c: number }>)?.[0]?.c ?? 0;
          const lastAt =
            (lastRows as Array<{ recordedAt?: string }>)?.[0]?.recordedAt;
          return { entities, facts, lastIngestAt: lastAt ?? null };
        },
      );
    } catch {
      // Tenant doesn't exist yet — that's a clean state, not an error.
      return { entities: 0, facts: 0, lastIngestAt: null };
    }
  }

  @Post('reset')
  @RequireScopes('brain:admin')
  async demoReset() {
    try {
      await this.surreal.dropCompanyDatabase(DEMO_LIVE_COMPANY);
    } catch (e) {
      // Reset is idempotent — a missing DB is a success state.
      return { dropped: false, reason: (e as Error).message };
    }
    return { dropped: true };
  }

  private async fetchKnownEntityNames(): Promise<string[]> {
    // Top 25 canonical names from the demo tenant — bounded so the
    // router prompt doesn't bloat. Best-effort: if the tenant is empty
    // / the read fails, return [] and the router just won't
    // canonicalise this turn.
    try {
      return await this.surreal.withCompany(
        DEMO_LIVE_COMPANY,
        async (db) => {
          const [rows] = await db.query<
            [Array<{ canonicalName: string }>]
          >(
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
