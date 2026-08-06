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
import type { EntityBucket, FactRow, NeighbourEdge } from './internals/types';
import { buildBaseWhere } from './internals/where-builder';
import {
  hydrateSurvivors,
  reattributeMerged,
} from './internals/identity-merge';
import {
  makeRowPolicyFilter,
  type PredicatePolicyLookup,
} from '../policy/row-filter';
import { applyMetaUnion } from '../policy/meta-union';
import { getPolicyContext } from '../common/request-context';
import { pinUserScope } from '../auth/user-scope';
import {
  expandEntityIdsViaEdges as expandEntityIdsViaEdgesDb,
  type Neighbour,
} from './internals/neighbours';
import { expandViaEdges, buildNeighbourMap } from './internals/edge-expansion';
import { buildEntityExpansionQuery } from './internals/query-expansion';
import { applyPprPrior } from './internals/ppr';
import { shouldSkipRerankByMargin } from './internals/rerank-skip';
import { selectFactCentric } from './internals/fact-centric';
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
import { resolveVerbatimMode } from './verbatim-routing';
import { PipelineContext } from './pipeline-context';
import { ReadPinService } from '../episodes/read-pin.service';
import {
  getActiveRetrievalProfile,
  resolveSearchTuning,
} from './retrieval-profile';
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
 *      → PPR → rerank → fact-centric selection → assemble).
 *   3. Own the db-threading stages that need no AI service (identity
 *      merge, edge expansion, PPR, graph retrieval).
 *
 * Anything heavier than that belongs in a stage module or stage service.
 */

/**
 * Hand-off between the DB-scoped stages and the connectionless rank
 * tail (audit W4 #20): everything the rerank/assembly stages need,
 * prefetched so the scoped pool slot is released before the pipeline's
 * slowest awaits (cross-encoder pass, external LLM rerank).
 */
interface StagedPipeline {
  byEntity: Map<string, import('./internals/types').EntityBucket>;
  rowPolicy: ReturnType<typeof makeRowPolicyFilter>;
  neighboursByEntity: Map<string, Neighbour[]>;
}

@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);

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
    // Sixth: the per-tenant derived-world pin (audit W2). Optional so
    // positionally-constructed unit tests fall back to the env default.
    @Optional() private readonly readPin?: ReadPinService,
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
    // Defense-in-depth: an Invalid Date param is rejected by the
    // Surreal SDK at serialization time (SurrealSqonError → 500), so
    // an unparseable asOf from ANY caller degrades to no time filter.
    const asOfMs = dto.asOf ? Date.parse(dto.asOf) : NaN;
    const asOf = Number.isNaN(asOfMs) ? null : new Date(asOfMs);
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

    // Which derived world this tenant reads — registry first, env
    // bootstrap as the fallback (audit W2 #9). Resolved BEFORE the
    // scoped connection so the registry lookup never holds a pool slot.
    const derivedVersion =
      (await this.readPin?.resolve(companyId)) ??
      ReadPinService.bootstrapDefault();

    const profile = getActiveRetrievalProfile();
    const tuning = resolveSearchTuning();
    const ctx: PipelineContext = {
      dto,
      callerScopes,
      companyId,
      limit,
      asOf,
      includeRetracted,
      includeContested,
      mode,
      candidateK,
      derivedVersion,
      profile,
      tuning,
    };
    // Audit W4 #20: only the DB-touching stages run inside the scoped
    // connection; the cross-encoder pass and the external LLM rerank —
    // the pipeline's slowest awaits — run AFTER the 8-slot pool
    // connection is released (their one DB need, the 1-hop rerank
    // neighbourhoods, is prefetched inside the scope).
    const staged = await this.surreal.withScopedCompany(
      companyId,
      callerScopes,
      (db) => this.runDbStages(db, ctx),
    );
    const out = await this.rankAndAssemble(staged, ctx);
    // Usage reinforcement, write side (opt-in): stamp the facts this
    // search actually surfaced. Fire-and-forget on the root pool — the
    // response never waits on it, and multi-hop / synthesize get it for
    // free since they route through this method.
    if (tuning.usageRecording) {
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

  private async runDbStages(
    db: Surreal,
    ctx: PipelineContext,
  ): Promise<StagedPipeline> {
    // Phase 4.B locale-aware retrieval. Detect the query language
    // (or honour the explicit dto.queryLang) and apply a two-pass
    // filter → cross-lingual backoff strategy. `und` or disabled →
    // single-pass exactly as before.
    const langFilter = this.resolveLangFilter(ctx.dto);
    const baseWhere = buildBaseWhere({
      dto: ctx.dto,
      asOf: ctx.asOf,
      includeRetracted: ctx.includeRetracted,
      includeContested: ctx.includeContested,
      derivedVersion: ctx.derivedVersion,
      temporalMode: ctx.profile.temporalMode,
      opts: { langFilter },
    });
    traceArtifact('search.query', {
      query: ctx.dto.query,
      mode: ctx.mode,
      candidateK: ctx.candidateK,
      asOf: ctx.dto.asOf,
      langFilter,
    });

    // 1. Retrieval legs (parallel) + fusion, with cross-lingual backoff.
    const fused = await this.retrieval.runRetrievalStage(db, ctx, baseWhere);
    if (langFilter && fused.length < ctx.candidateK / 2) {
      // Capture the first-pass size BEFORE the merge loop mutates `fused`.
      const firstPassCount = fused.length;
      const fallbackWhere = buildBaseWhere({
        dto: ctx.dto,
        asOf: ctx.asOf,
        includeRetracted: ctx.includeRetracted,
        includeContested: ctx.includeContested,
        derivedVersion: ctx.derivedVersion,
        temporalMode: ctx.profile.temporalMode,
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
      traceArtifact('search.langfilter_backoff', {
        firstPass: firstPassCount,
        fallback: fallback.length,
        merged: fused.length - firstPassCount,
        langFilter,
      });
    }

    // 1c. Entity-expansion second retrieval (audit W4 #19, profile
    // entityExpansion): the first pass DISCOVERED entities the query
    // never named; a second legs+fusion pass anchored on the top
    // discovered names pulls the facts a single-shot query misses.
    // Runs BEFORE scoring so expansion rows go through identity-merge,
    // ABAC, scoring, and rerank exactly like first-pass rows.
    if (ctx.profile.entityExpansion && fused.length > 0) {
      const expansionQuery = buildEntityExpansionQuery(ctx.dto.query, fused);
      if (expansionQuery) {
        const extra = await this.retrieval.runRetrievalStage(
          db,
          { ...ctx, dto: { ...ctx.dto, query: expansionQuery } },
          baseWhere,
        );
        const seen = new Set(fused.map((r) => String(r.id)));
        let added = 0;
        for (const r of extra) {
          if (!seen.has(String(r.id))) {
            fused.push(r);
            seen.add(String(r.id));
            added += 1;
          }
        }
        traceArtifact('search.entity_expansion', {
          expansionQuery,
          added,
        });
      }
    }

    // 2. Identity-merge re-attribution + scope/ABAC row filter. One
    // filter instance covers the whole pipeline (fusion + edge
    // expansion) so the decision summary aggregates once.
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
    // fails inside; rows injected later (edge expansion) stay
    // unenriched — supplementary context, not primary relevance.
    if (ctx.tuning.usageDecay) {
      await enrichWithUsage(db, this.logger, filtered);
    }

    // 4. Scoring + per-entity bucketing with diversity-aware degree boost.
    // Under temporalMode='overlap_boost' the asOf anchor feeds the
    // interval-overlap decay; in 'filter' mode every surviving row
    // already contains the anchor, so passing it is a no-op there.
    const byEntity = this.retrieval.scoreAndBucket(filtered, {
      temporalAnchor:
        ctx.profile.temporalMode === 'overlap_boost' ? ctx.asOf : null,
      tuning: ctx.tuning,
    });

    // 5. Edge expansion (default ON) — graph-walk from top seeds. When the
    // combined vector+graph leg ran, the vector-matched facts already carry
    // their entity's neighbourhood (fetched in the same KNN query), so hand it
    // over to skip re-querying those seeds.
    const prefetchedNeighbours = buildNeighbourMap(filtered);
    await this.runEdgeExpansionStage({
      db,
      byEntity,
      baseWhere,
      ctx,
      rowFilterFn,
      prefetchedNeighbours,
    });

    // 6. PPR (opt-in) — HippoRAG-style cluster lift.
    await this.runPprStage(db, byEntity, ctx);

    // 6b. Verbatim fusion leg (audit W4 #18): under the 'fused' profile,
    // segments arrive as their own scored buckets and compete with fact
    // buckets in the rerank + fact-centric stages — citable next to
    // facts instead of an unscored prompt appendix. 'routed' resolves
    // per query: only verbatim-shaped asks run the leg — the V6
    // three-block pairs measured fused at SSA +7.1pp vs SSU −10.0pp /
    // TR −8.3pp (pooled −5.0pp at n=239).
    if (
      resolveVerbatimMode(ctx.profile.verbatimEvidence, ctx.dto.query) ===
      'fused'
    ) {
      const segBuckets = await this.retrieval.runSegmentLegStage(db, ctx);
      for (const [k, v] of segBuckets) {
        if (!byEntity.has(k)) byEntity.set(k, v);
      }
    }

    // Last DB touch: prefetch the 1-hop neighbourhoods the LLM rerank
    // body wants, so the rerank stage needs no connection at all.
    const neighboursByEntity = await this.rerank.prefetchNeighbours(
      db,
      byEntity,
      ctx,
    );
    return { byEntity, rowPolicy, neighboursByEntity };
  }

  /**
   * Post-connection stages (audit W4 #20): cross-encoder + LLM rerank,
   * tail refill, fact-centric selection, assembly, output shaping. No
   * DB handle in scope — everything here runs on prefetched state.
   */
  private async rankAndAssemble(
    staged: StagedPipeline,
    ctx: PipelineContext,
  ): Promise<{ results: SearchHit[] }> {
    const { byEntity, rowPolicy, neighboursByEntity } = staged;
    // 7. Cross-encoder + LLM rerank.
    let topEntities = await this.rerank.runRerankStage({
      byEntity,
      ctx,
      neighboursByEntity,
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

    // 8. Fact-centric selection (Phase A of the typed-memory roadmap):
    // facts compete globally for the window instead of entities — the
    // top-`limit` entity gate made a gold fact unreachable whenever its
    // entity missed the entity ranking. Draws from ALL buckets
    // (pre-slice); the global score cut replaces per-entity backfill.
    const factCentricBudget = ctx.profile.factBudget;
    topEntities = selectFactCentric([...byEntity.values()], factCentricBudget, {
      // Keep the reranked order for the buckets the reranker judged
      // (audit W4 #15 — its output used to be computed and thrown
      // away), and honour the caller's limit.
      priority: topEntities.map((b) => b.entityId),
      limit: ctx.limit,
    });
    traceArtifact('search.fact_centric', {
      entities: topEntities.length,
      facts: topEntities.reduce((a, b) => a + b.facts.length, 0),
      limit: ctx.limit,
    });

    const hits = assembleHits({
      topEntities,
      entityTypes: ctx.dto.entityTypes,
      requireProvenance: ctx.dto.requireProvenance === true,
      factsPerEntity: factCentricBudget,
    });
    rowPolicy.finish();
    return {
      results: await applyOutputShaping(
        hits,
        ctx.dto,
        this.workerPool,
        ctx.tuning,
      ),
    };
  }

  private async runEdgeExpansionStage({
    db,
    byEntity,
    baseWhere,
    ctx,
    rowFilterFn,
    prefetchedNeighbours,
  }: {
    db: Surreal;
    byEntity: Map<string, EntityBucket>;
    baseWhere: { sql: string; params: Record<string, unknown> };
    ctx: PipelineContext;
    rowFilterFn: (row: FactRow) => boolean;
    prefetchedNeighbours?: Map<
      string,
      { outNeighbours: NeighbourEdge[] | null; inNeighbours: NeighbourEdge[] | null }
    >;
  }): Promise<void> {
    if (byEntity.size < 1) return;
    await withSpan(
      'search.edge_expansion',
      async (span) => {
        const injected = await expandViaEdges({
          db,
          logger: this.logger,
          byEntity,
          baseWhere,
          config: ctx.tuning.edgeExpansion,
          dto: ctx.dto,
          callerScopes: ctx.callerScopes,
          passesPolicy: (row) => rowFilterFn(row),
          prefetchedNeighbours,
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
    ctx: PipelineContext,
  ): Promise<void> {
    const pprForced = ctx.tuning.pprEnabled;
    const pprAutoThreshold = ctx.tuning.pprAutoThreshold;
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
