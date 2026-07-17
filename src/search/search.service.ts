import { Injectable, Logger, Optional } from '@nestjs/common';
import { Surreal } from 'surrealdb';
import { SurrealService } from '../db/surreal.service';
import { PredicateRegistryService } from '../ai/predicate-registry.service';
import { detectLanguage } from '../ai/locale/language-detector';
import { SearchDto, SearchMode } from './dto/search.dto';
import { withSpan } from '../common/tracing';
import { clampLlmInputText } from '../common/input-limits';
import { traceArtifact } from '../common/debug-trace';

import type { SearchHit } from './search.types';
import type { EntityBucket, FactRow } from './internals/types';
import {
  resolveStageBudgets,
  withStageBudget,
  type StageBudgets,
} from './internals/stage-budget';
import { buildBaseWhere } from './internals/where-builder';
import { hydrateSurvivors, reattributeMerged } from './internals/identity-merge';
import {
  makeRowPolicyFilter,
  type PredicatePolicyLookup,
} from '../policy/row-filter';
import { applyMetaUnion } from '../policy/meta-union';
import { getPolicyContext } from '../common/request-context';
import { pinUserScope } from '../auth/user-scope';
import { expandEntityIdsViaEdges as expandEntityIdsViaEdgesDb } from './internals/neighbours';
import { expandViaEdges } from './internals/edge-expansion';
import { applyPprPrior } from './internals/ppr';
import { shouldSkipRerankByMargin } from './internals/rerank-skip';
import { backfillEntityFacts } from './internals/backfill';
import { enrichWithUsage, recordFactUsage } from './internals/usage';
import { assembleHits, applyOutputShaping } from './internals/response-builder';
import {
  assembleGraphHits,
  type GraphRetrieveHit,
} from './internals/graph-retrieve';
import {
  fetchEntitiesByIds,
  fetchFactsForEntities,
  fetchOneHopNeighbourIds,
  resolveSeedEntities,
} from './internals/graph-retrieve-db';
import { SearchRetrievalService } from './search-retrieval.service';
import { SearchRerankService } from './search-rerank.service';
import {
  DomainRoutingService,
  type DomainSignal,
} from '../ai/domain-routing.service';
import { PipelineContext } from './pipeline-context';
import { envFlagEnabled } from '../common/env-validation';
import { JobWorkerPool } from '../jobs/job-worker-pool.service';

export type { SearchHit } from './search.types';
export type { GraphRetrieveHit } from './internals/graph-retrieve';

/**
 * Search orchestrator. The retrieval pipeline lives in stage modules
 * under `./internals/` (pure functions) and the two stage services
 * SearchRetrievalService (retrieval legs / router / scoring) +
 * SearchRerankService (cross-encoder / LLM rerank). This file's only job
 * is to:
 *   1. Translate the public `SearchDto` into a per-request context.
 *   2. Open the scoped DB connection and sequence the stages (retrieval
 *      → fusion → identity merge → scoring → bucketing → edge expansion
 *      → PPR → rerank → backfill → assemble).
 *   3. Own the db-threading stages that need no AI service (identity
 *      merge, edge expansion, PPR, backfill, graph retrieval).
 *
 * Anything heavier than that belongs in a stage module or stage service.
 */
@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);
  private readonly budgets: StageBudgets = resolveStageBudgets();

  // Fourth dep is the tenant predicate registry — the row fence must see
  // operator-authored requiresScope predicates, not only the code seed.
  // Fifth is the shared job worker pool: tokenBudget shaping batches its
  // tiktoken counting there (short acquire timeout, sync fallback), so
  // both stay optional for positionally-constructed unit tests.
  // eslint-disable-next-line max-params
  constructor(
    private readonly surreal: SurrealService,
    private readonly retrieval: SearchRetrievalService,
    private readonly rerank: SearchRerankService,
    @Optional() private readonly predicateRegistry?: PredicateRegistryService,
    @Optional() private readonly workerPool?: JobWorkerPool,
    @Optional() private readonly domainRouting?: DomainRoutingService,
  ) {}

  /**
   * Registry-backed predicate-policy lookup for the row fence; falls
   * back to the static seed when the registry isn't wired (unit tests
   * construct SearchService positionally).
   */
  private async policyLookupFor(
    companyId: string,
  ): Promise<PredicatePolicyLookup | undefined> {
    return this.predicateRegistry
      ? this.predicateRegistry.rowPolicyLookup(companyId)
      : undefined;
  }

  /** Pure helper — kept exposed for unit testing. Delegates to the
   *  rerank-skip module so the orchestrator owns no math. */
  static shouldSkipRerankByMargin(
    candidates: Array<{ rankScore: number }>,
    marginThreshold: number,
  ): boolean {
    return shouldSkipRerankByMargin(candidates, marginThreshold);
  }

  /**
   * Pure helper (exposed for unit testing): the filter-mode narrowing
   * decision. Returns the predicate allow-list to narrow the retrieval
   * legs to, or undefined when narrowing must NOT apply — boost mode, no
   * domain signal, or a signal with no matched domain (narrowTo null).
   * Core predicates are always inside `narrowTo`, so filtering never
   * excludes identity/contact facts.
   */
  static resolveDomainNarrowing(
    mode: 'boost' | 'filter',
    domainSignal: DomainSignal | null | undefined,
  ): string[] | undefined {
    if (mode !== 'filter') return undefined;
    return domainSignal?.narrowTo ?? undefined;
  }

  /**
   * Resolve the lang code to push into the WHERE builder. Honour an
   * explicit dto.queryLang first; otherwise run the pure detector on
   * the query text. Returns undefined when detection is `und` or the
   * caller opted out via dto.disableLangFilter, so callers downstream
   * fall back to the single-pass behaviour.
   */
  private resolveLangFilter(dto: SearchDto): string | undefined {
    if (dto.disableLangFilter) return undefined;
    if (dto.queryLang) return dto.queryLang;
    const detected = detectLanguage(dto.query);
    return detected.language === 'und' ? undefined : detected.language;
  }

  /**
   * Graph-first retrieval. Resolves named entities by canonical name,
   * walks their 1-hop neighbourhood over knowledge_edge, and returns
   * facts across (seeds ∪ neighbours) optionally filtered by predicate
   * hints.
   *
   * Soft-fail across the board: a query error logs and returns the
   * partial result so the caller can fall through to vector.
   */
  async graphRetrieve({
    companyId,
    queryText,
    entityRefs,
    predicateHints,
    asOf,
    callerScopes,
  }: GraphRetrieveOptions): Promise<{ results: GraphRetrieveHit[] }> {
    return this.surreal.withScopedCompany(
      companyId,
      callerScopes,
      async (db) => {
        try {
          const seeds = await resolveSeedEntities(db, queryText, entityRefs);
          if (seeds.length === 0) return { results: [] };
          const seedIds = seeds.map((s) => s.entityId);

          const neighbourIds = await fetchOneHopNeighbourIds(db, seedIds);
          // Neighbour hydration and the facts fetch are independent once
          // the neighbour ids are known — run them in one round-trip
          // window instead of serially.
          const allIds = [...new Set([...seedIds, ...neighbourIds])];
          const [neighbours, factsByEntity] = await Promise.all([
            neighbourIds.length > 0
              ? fetchEntitiesByIds(db, neighbourIds)
              : Promise.resolve([] as Awaited<ReturnType<typeof fetchEntitiesByIds>>),
            fetchFactsForEntities({
              db,
              entityIds: allIds,
              predicateHints,
              asOf,
            }),
          ]);

          const entitiesById = new Map<string, (typeof seeds)[number]>();
          for (const e of seeds) entitiesById.set(e.entityId, e);
          for (const e of neighbours) entitiesById.set(e.entityId, e);

          // Scope + ABAC row filter. Also closes the pre-ABAC gap where
          // graph_retrieve skipped the requiresScope predicate gate that
          // search applied — PII-scoped facts no longer surface here
          // without brain:read_pii.
          const rowPolicy = makeRowPolicyFilter({
            callerScopes,
            surface: 'graph_retrieve',
            policyLookup: await this.policyLookupFor(companyId),
          });
          for (const [entityId, facts] of factsByEntity) {
            factsByEntity.set(
              entityId,
              facts.filter((f) => rowPolicy.filter(f)),
            );
          }
          rowPolicy.finish();
          const policyCtx = getPolicyContext();
          if (policyCtx) {
            // ONE applyMetaUnion over all facts instead of one per
            // entity — the per-entity loop paid a cold-cache origin-meta
            // fetch (its own withCompany round-trip) per entity, up to
            // ×N for seeds ∪ neighbours. applyMetaUnion filters without
            // cloning, so identity-based regrouping is safe.
            const flatRows = [...factsByEntity.values()].flat();
            const kept = new Set(
              await applyMetaUnion({
                surreal: this.surreal,
                companyId,
                ctx: policyCtx,
                rows: flatRows,
              }),
            );
            for (const [entityId, facts] of factsByEntity) {
              factsByEntity.set(
                entityId,
                facts.filter((f) => kept.has(f)),
              );
            }
          }

          traceArtifact('graph_retrieve', {
            seeds: seedIds,
            neighbours: neighbourIds,
            factsByEntity: Object.fromEntries(
              [...factsByEntity.entries()].map(([k, v]) => [k, v.length]),
            ),
            predicateHints,
          });

          const results = assembleGraphHits({
            seedIds,
            entitiesById,
            factsByEntity,
            predicateHints,
          });
          return { results };
        } catch (err) {
          this.logger.warn(
            `graphRetrieve failed for ${companyId}: ${(err as Error).message}`,
          );
          return { results: [] };
        }
      },
    );
  }

  /** Public re-export for the multi-hop executor. Opens a scoped
   *  connection, then delegates to the neighbour-fetch module. */
  async expandEntityIdsViaEdges(
    companyId: string,
    entityIds: string[],
    callerScopes: string[],
  ): Promise<string[]> {
    if (entityIds.length === 0) return entityIds;
    return this.surreal.withScopedCompany(companyId, callerScopes, (db) =>
      expandEntityIdsViaEdgesDb(db, this.logger, entityIds),
    );
  }

  async search(
    companyId: string,
    dto: SearchDto,
    callerScopes: string[],
  ): Promise<{ results: SearchHit[] }> {
    // Defence-in-depth clamp. SearchDto.@MaxLength catches caller-direct
    // requests, but multi-hop / synthesize / admin-demo / mcp call this
    // method with raw shapes that may bypass class-validator. Clamping
    // here keeps the embedding + LLM-rerank + synthesize prompt sizes
    // bounded regardless of caller.
    const clamped = clampLlmInputText(dto.query ?? '', 'query');
    if (clamped.truncated) {
      this.logger.warn(
        `search: query truncated to ${clamped.value.length} chars (companyId=${companyId})`,
      );
    }
    // A user-bound token operates on global + own memory only — the
    // caller-asserted userId is pinned to the token's end-user (403 on
    // mismatch). M2M credentials pass through unchanged.
    dto = { ...dto, query: clamped.value, userId: pinUserScope(dto.userId) };
    // Empty/whitespace query → empty result, before any DB or embedding
    // work. Without this the full pipeline ran on '' — a zero-vector
    // cosine scan plus BM25 over an empty string, all guaranteed noise.
    if (dto.query.trim().length === 0) {
      return { results: [] };
    }
    const limit = dto.limit ?? 10;
    const asOf = dto.asOf ? new Date(dto.asOf) : null;
    const includeRetracted = dto.includeRetracted ?? false;
    const includeContested = dto.includeContested ?? true;
    const mode: SearchMode = dto.searchMode ?? 'hybrid';
    // 5× headroom over `limit` keeps the rerank/fusion windows from
    // starving the top-K. Capped at 200 — beyond that we shovel
    // embeddings across the wire for nothing.
    const candidateK = Math.min(limit * 5, 200);

    // Warm the query-embedding cache BEFORE acquiring a scoped pool
    // connection. The scoped pool is small (SURREALDB_SCOPED_POOL_SIZE,
    // default 8) and the embed call is an external API round-trip —
    // holding a connection through it stretched every search's hold
    // time by the embedding latency. The vector leg's embed(query)
    // inside the pipeline becomes an LRU hit on the same text.
    if (mode !== 'lexical') {
      await this.retrieval.prewarmQueryEmbedding(dto.query);
    }

    // Domain-routed retrieval (opt-in): compute the tenant's domain
    // signal BEFORE the scoped-pool section — it reads the registry
    // snapshot (root pool, 60s TTL cache) and the already-prewarmed
    // query embedding, so it adds no scoped-connection hold time. A
    // caller-supplied predicate filter wins: the explicit `dto.predicates`
    // contract must not be second-guessed by the router.
    let domainSignal: DomainSignal | null = null;
    if (
      mode !== 'lexical' &&
      this.domainRouting?.isEnabled() &&
      !(dto.predicates && dto.predicates.length > 0)
    ) {
      domainSignal = await this.domainRouting.getDomainSignal(
        companyId,
        dto.query,
      );
    }

    const out = await this.surreal.withScopedCompany(
      companyId,
      callerScopes,
      (db) =>
        this.runPipeline(db, {
          dto,
          callerScopes,
          companyId,
          limit,
          asOf,
          includeRetracted,
          includeContested,
          mode,
          candidateK,
          domainSignal,
        }),
    );
    // Usage reinforcement, write side (opt-in): stamp the facts this
    // search actually surfaced. Fire-and-forget on the root pool — the
    // response never waits on it, and multi-hop / synthesize get it for
    // free since they route through this method.
    if (envFlagEnabled(process.env.SEARCH_USAGE_RECORDING_ENABLED)) {
      recordFactUsage({
        surreal: this.surreal,
        logger: this.logger,
        companyId,
        factIds: out.results.flatMap((h) =>
          (h.facts ?? []).map((f) => f.factId),
        ),
      });
    }
    return out;
  }

  private async runPipeline(
    db: Surreal,
    ctx: PipelineContext,
  ): Promise<{ results: SearchHit[] }> {
    // Phase 4.B locale-aware retrieval. Detect the query language
    // (or honour the explicit dto.queryLang) and apply a two-pass
    // filter → cross-lingual backoff strategy. `und` or disabled →
    // single-pass exactly as before.
    const langFilter = this.resolveLangFilter(ctx.dto);
    // Un-narrowed WHERE — reused by edge expansion and backfill. Narrowing
    // it there would starve entity-card backfill and edge walks of the
    // very facts the domain filter excluded from the seed legs.
    const baseWhere = buildBaseWhere({
      dto: ctx.dto,
      asOf: ctx.asOf,
      includeRetracted: ctx.includeRetracted,
      includeContested: ctx.includeContested,
      opts: { langFilter },
    });
    // Filter-mode domain narrowing (SEARCH_DOMAIN_ROUTING_MODE=filter):
    // applied ONLY to the retrieval legs. Core is never excluded, so a
    // query with no matched domain (narrowTo null) uses baseWhere as-is.
    const domainPredicates = SearchService.resolveDomainNarrowing(
      this.domainRouting?.mode() ?? 'boost',
      ctx.domainSignal,
    );
    const domainNarrowed = !!domainPredicates;
    const legsWhere = domainNarrowed
      ? buildBaseWhere({
          dto: ctx.dto,
          asOf: ctx.asOf,
          includeRetracted: ctx.includeRetracted,
          includeContested: ctx.includeContested,
          opts: { langFilter, domainPredicates },
        })
      : baseWhere;
    traceArtifact('search.query', {
      query: ctx.dto.query,
      mode: ctx.mode,
      candidateK: ctx.candidateK,
      asOf: ctx.dto.asOf,
      langFilter,
      domainNarrowed,
    });

    // Router LLM (optional, budgeted) depends ONLY on the query text —
    // kick it off alongside retrieval instead of awaiting it serially
    // after merge/meta-union (a cache-miss added its full round-trip to
    // the critical path). Awaited at stage 3 where its output is first
    // consumed; .catch keeps a router failure from becoming an
    // unhandled rejection while retrieval is still in flight (the
    // router stage degrades to null on its own errors anyway).
    const routerPromise = this.retrieval
      .runRouterStage(ctx.dto.query, ctx.domainSignal?.vocab)
      .catch(() => null);
    if (ctx.domainSignal) {
      traceArtifact('search.domain_routing', {
        mode: this.domainRouting?.mode() ?? 'boost',
        version: ctx.domainSignal.version,
        affinities: ctx.domainSignal.affinities.map((a) => ({
          domain: a.domain,
          sim: Number(a.sim.toFixed(4)),
        })),
        matched: ctx.domainSignal.matched.map((m) => m.domain),
        vocabEntries: ctx.domainSignal.vocab.entries.length,
      });
    }

    // 1. Retrieval legs (parallel) + fusion, with cross-lingual /
    //    domain-narrowing backoff. The legs run against legsWhere (==
    //    baseWhere unless filter mode narrowed it); a thin first pass
    //    re-runs unfiltered (no langFilter, no domainPredicates) and
    //    merges, so neither filter can strand recall.
    const fused = await this.retrieval.runRetrievalStage(db, ctx, legsWhere);
    if ((langFilter || domainNarrowed) && fused.length < ctx.candidateK / 2) {
      // Capture the first-pass size BEFORE the merge loop mutates `fused`.
      const firstPassCount = fused.length;
      const fallbackWhere = buildBaseWhere({
        dto: ctx.dto,
        asOf: ctx.asOf,
        includeRetracted: ctx.includeRetracted,
        includeContested: ctx.includeContested,
      });
      const fallback = await this.retrieval.runRetrievalStage(
        db,
        ctx,
        fallbackWhere,
      );
      const seen = new Set(fused.map((r) => String(r.id)));
      for (const r of fallback) {
        if (!seen.has(String(r.id))) {
          fused.push(r);
          seen.add(String(r.id));
        }
      }
      traceArtifact('search.retrieval_backoff', {
        firstPass: firstPassCount,
        fallback: fallback.length,
        merged: fused.length - firstPassCount,
        langFilter,
        domainNarrowed,
      });
    }

    // 2. Identity-merge re-attribution + scope/ABAC row filter. One
    // filter instance covers the whole pipeline (fusion + edge
    // expansion + backfill) so the decision summary aggregates once.
    const rowPolicy = makeRowPolicyFilter({
      callerScopes: ctx.callerScopes,
      surface: 'search',
      policyLookup: await this.policyLookupFor(ctx.companyId),
    });
    const rowFilterFn = (row: FactRow) => rowPolicy.filter(row);
    const survivorRecords = await hydrateSurvivors(db, fused);
    const reattributed = reattributeMerged(fused, survivorRecords);
    let filtered = reattributed.filter(rowFilterFn);

    // 2a. Effective-meta union (POLICY_META_UNION_ENABLED, default off):
    // a corroborated fact inherits its confirming documents' metadata
    // for deny evaluation — union = most restrictive.
    const policyCtx = getPolicyContext();
    if (policyCtx) {
      filtered = await applyMetaUnion({
        surreal: this.surreal,
        companyId: ctx.companyId,
        ctx: policyCtx,
        rows: filtered,
      });
    }

    // 2b. Usage enrichment (opt-in) — attach lastReadAt so decay counts
    // from the most recent retrieval instead of only recordedAt. Soft-
    // fails inside; rows injected later (edge expansion / backfill) stay
    // unenriched — supplementary context, not primary relevance.
    if (envFlagEnabled(process.env.SEARCH_USAGE_DECAY_ENABLED)) {
      await enrichWithUsage(db, this.logger, filtered);
    }

    // 3. Predicate / type router — launched in parallel with retrieval
    // above; first consumed here.
    const routerOut = await routerPromise;
    const predicateDist = routerOut?.predicates ?? null;
    const typeDist = routerOut?.types ?? null;

    // 4. Scoring + per-entity bucketing with diversity-aware degree boost.
    const byEntity = this.retrieval.scoreAndBucket(
      filtered,
      predicateDist,
      ctx.domainSignal?.boost ?? null,
    );

    // 5. Edge expansion (default ON) — graph-walk from top seeds.
    await this.runEdgeExpansionStage({ db, byEntity, baseWhere, ctx, rowFilterFn });

    // 6. PPR (opt-in) — HippoRAG-style cluster lift.
    await this.runPprStage(db, byEntity);

    // 7. Cross-encoder + LLM rerank.
    let topEntities = await this.rerank.runRerankStage({
      db,
      byEntity,
      ctx,
      typeDist,
    });
    // The rerank stage only ranks a bounded window (≤20 buckets). When the
    // caller asked for more (limit up to the DTO's @Max(100)), the reranked
    // head is correct but the tail beyond the window was dropped — a silent
    // cap at 20. Refill from the remaining buckets in rankScore order so the
    // response honors `limit`; the reranker legitimately only reorders its
    // own window, so rankScore is the right ordering past it.
    if (topEntities.length < ctx.limit && byEntity.size > topEntities.length) {
      const present = new Set(topEntities.map((b) => b.entityId));
      const tail = [...byEntity.values()]
        .filter((b) => !present.has(b.entityId))
        .sort((a, b) => b.rankScore - a.rankScore);
      topEntities = topEntities.concat(tail);
    }
    topEntities = topEntities.slice(0, ctx.limit);

    // 8. Backfill missing facts for top-K, then assemble.
    const backfillByEntity = await withStageBudget({
      stage: 'backfill',
      budgetMs: this.budgets.backfill,
      fn: () =>
        backfillEntityFacts({
          db,
          logger: this.logger,
          entityIds: topEntities.map((e) => e.entityId),
          baseWhere,
          dto: ctx.dto,
          callerScopes: ctx.callerScopes,
          passesPolicy: (row) => rowFilterFn(row),
        }),
      fallback: new Map<string, FactRow[]>(),
      logger: this.logger,
    });
    const hits = assembleHits({
      topEntities,
      backfillByEntity,
      entityTypes: ctx.dto.entityTypes,
      requireProvenance: ctx.dto.requireProvenance === true,
    });
    rowPolicy.finish();
    return {
      results: await applyOutputShaping(hits, ctx.dto, this.workerPool),
    };
  }

  private async runEdgeExpansionStage({
    db,
    byEntity,
    baseWhere,
    ctx,
    rowFilterFn,
  }: {
    db: Surreal;
    byEntity: Map<string, EntityBucket>;
    baseWhere: { sql: string; params: Record<string, unknown> };
    ctx: PipelineContext;
    rowFilterFn: (row: FactRow) => boolean;
  }): Promise<void> {
    if (process.env.SEARCH_EDGE_EXPANSION_ENABLED === '0') return;
    if (byEntity.size < 1) return;
    await withSpan(
      'search.edge_expansion',
      async (span) => {
        const injected = await expandViaEdges({
          db,
          logger: this.logger,
          byEntity,
          baseWhere,
          dto: ctx.dto,
          callerScopes: ctx.callerScopes,
          passesPolicy: (row) => rowFilterFn(row),
        });
        span.setAttribute('edge_expansion.injected', injected);
        if (injected > 0) {
          traceArtifact('search.edge_expansion', {
            seedCount: Math.min(byEntity.size, 3),
            injected,
          });
        }
      },
      { 'edge_expansion.seeds': Math.min(byEntity.size, 3) },
    );
  }

  private async runPprStage(
    db: Surreal,
    byEntity: Map<string, EntityBucket>,
  ): Promise<void> {
    const pprForced = envFlagEnabled(process.env.SEARCH_PPR_ENABLED);
    const pprAutoThreshold = parseInt(
      process.env.SEARCH_PPR_AUTO_THRESHOLD ?? '0',
      10,
    );
    const pprAuto = pprAutoThreshold > 0 && byEntity.size >= pprAutoThreshold;
    if (!(pprForced || pprAuto) || byEntity.size <= 1) return;
    await withSpan(
      'search.ppr',
      () => applyPprPrior(db, byEntity),
      { 'ppr.entities': byEntity.size },
    );
  }
}

export interface GraphRetrieveOptions {
  companyId: string;
  queryText: string;
  entityRefs: string[];
  predicateHints: string[];
  asOf: string | undefined;
  callerScopes: string[];
}
