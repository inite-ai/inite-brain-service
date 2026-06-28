import { Injectable, Logger } from '@nestjs/common';
import type { BrainScope } from '../auth/api-key.types';
import { traceArtifact, traceSpan } from '../common/debug-trace';
import { IngestService } from '../ingest/ingest.service';
import { SearchService } from '../search/search.service';
import { DreamsService } from '../dreams/dreams.service';
import type { ChatRoute } from './chat-router.service';

/**
 * DemoPipelineService — the brain-pipeline operations behind the live-demo
 * sandbox: ingest a mention, run a search, run a dreams pass, and the
 * chat tell/ask flows. Owns ingest, search, and dreams; the chat routing
 * lives in DemoChatService and the DB-state reads in DemoStateService, so
 * each demo class keeps ≤3 injected deps. Methods return raw results —
 * the controller owns debug-trace capture + response shaping.
 */
@Injectable()
export class DemoPipelineService {
  private readonly logger = new Logger(DemoPipelineService.name);

  constructor(
    private readonly ingest: IngestService,
    private readonly search: SearchService,
    private readonly dreams: DreamsService,
  ) {}

  async ingestMention(
    tenant: string,
    body: { text: string; vertical?: string },
  ) {
    return this.ingest.ingestMention(tenant, {
      text: body.text,
      contextRef: { vertical: body.vertical ?? 'shop' },
      emittedAt: new Date().toISOString(),
    } as any);
  }

  async runSearch(
    tenant: string,
    body: { query: string; limit?: number; asOf?: string },
    scopes: readonly BrainScope[],
  ) {
    return this.search.search(
      tenant,
      { query: body.query, limit: body.limit ?? 5, asOf: body.asOf } as any,
      scopes as any,
    );
  }

  async runDreams(tenant: string, operations: string[]) {
    return this.dreams.runForTenant(tenant, operations as any);
  }

  /** Tell flow: ingest the mention, then best-effort inline dedup. */
  async runTell(route: ChatRoute, tenant: string) {
    const emittedAt = route.validFrom?.iso ?? new Date().toISOString();
    const ingest = await this.ingest.ingestMention(tenant, {
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
      const r = await this.dreams.runForTenant(tenant, ['dedup']);
      autoDedup = r.dedup
        ? { identityLinksCreated: r.dedup.identityLinksCreated }
        : undefined;
    } catch (e) {
      // Auto-dedup is best-effort; an error here MUST NOT fail the
      // ingest. The deep sweep button will still pick it up later.
      this.logger.debug(`demo auto-dedup skipped: ${(e as Error).message ?? e}`);
      autoDedup = undefined;
    }
    return { route, ingest, autoDedup };
  }

  /** Ask flow: graph-first retrieval, falling back to vector+lexical. */
  async runAsk({
    route,
    message,
    tenant,
    scopes,
  }: {
    route: ChatRoute;
    message: string;
    tenant: string;
    scopes: readonly BrainScope[];
  }) {
    const queryText = route.cleanedQuery ?? message;
    const entityRefs = route.mentions.map((m) => m.canonical);
    const predicateHints = route.predicateHints.map((h) => h.predicateId);
    const asOf = route.asOf?.iso;

    // Graph-first: resolve named entities, walk their 1-hop
    // neighbourhood, and fetch facts across (seeds ∪ neighbours)
    // optionally filtered by predicate hints.
    const graph = await traceSpan('demo.graph_first', () =>
      this.search.graphRetrieve({
        companyId: tenant,
        queryText,
        entityRefs,
        predicateHints,
        asOf,
        callerScopes: scopes as string[],
      }),
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
      tenant,
      { query: queryText, limit: 5, asOf } as any,
      scopes as any,
    );
    return {
      route,
      strategy: 'graph→vector' as const,
      search: { results: search.results },
    };
  }
}
