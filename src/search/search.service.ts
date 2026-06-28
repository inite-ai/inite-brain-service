import { Injectable, Logger } from '@nestjs/common';
import { Surreal } from 'surrealdb';
import { SurrealService } from '../db/surreal.service';
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
import { passesPolicy } from './internals/policy';
import { expandEntityIdsViaEdges as expandEntityIdsViaEdgesDb } from './internals/neighbours';
import { expandViaEdges } from './internals/edge-expansion';
import { applyPprPrior } from './internals/ppr';
import { shouldSkipRerankByMargin } from './internals/rerank-skip';
import { backfillEntityFacts } from './internals/backfill';
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
import { PipelineContext } from './pipeline-context';

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

  constructor(
    private readonly surreal: SurrealService,
    private readonly retrieval: SearchRetrievalService,
    private readonly rerank: SearchRerankService,
  ) {}

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
          const neighbours =
            neighbourIds.length > 0
              ? await fetchEntitiesByIds(db, neighbourIds)
              : [];

          const entitiesById = new Map<string, (typeof seeds)[number]>();
          for (const e of seeds) entitiesById.set(e.entityId, e);
          for (const e of neighbours) entitiesById.set(e.entityId, e);

          const factsByEntity = await fetchFactsForEntities({
            db,
            entityIds: [...entitiesById.keys()],
            predicateHints,
            asOf,
          });

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
    dto = { ...dto, query: clamped.value };
    const limit = dto.limit ?? 10;
    const asOf = dto.asOf ? new Date(dto.asOf) : null;
    const includeRetracted = dto.includeRetracted ?? false;
    const includeContested = dto.includeContested ?? true;
    const mode: SearchMode = dto.searchMode ?? 'hybrid';
    // 5× headroom over `limit` keeps the rerank/fusion windows from
    // starving the top-K. Capped at 200 — beyond that we shovel
    // embeddings across the wire for nothing.
    const candidateK = Math.min(limit * 5, 200);

    return this.surreal.withScopedCompany(companyId, callerScopes, (db) =>
      this.runPipeline(db, {
        dto,
        callerScopes,
        limit,
        asOf,
        includeRetracted,
        includeContested,
        mode,
        candidateK,
      }),
    );
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
    const baseWhere = buildBaseWhere({
      dto: ctx.dto,
      asOf: ctx.asOf,
      includeRetracted: ctx.includeRetracted,
      includeContested: ctx.includeContested,
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

    // 2. Identity-merge re-attribution + scope-policy filter.
    const survivorRecords = await hydrateSurvivors(db, fused);
    const reattributed = reattributeMerged(fused, survivorRecords);
    const filtered = reattributed.filter((row) =>
      passesPolicy(row, ctx.dto, ctx.callerScopes),
    );

    // 3. Predicate / type router (optional LLM call, under budget).
    const routerOut = await this.retrieval.runRouterStage(ctx.dto.query);
    const predicateDist = routerOut?.predicates ?? null;
    const typeDist = routerOut?.types ?? null;

    // 4. Scoring + per-entity bucketing with diversity-aware degree boost.
    const byEntity = this.retrieval.scoreAndBucket(filtered, predicateDist);

    // 5. Edge expansion (default ON) — graph-walk from top seeds.
    await this.runEdgeExpansionStage({ db, byEntity, baseWhere, ctx });

    // 6. PPR (opt-in) — HippoRAG-style cluster lift.
    await this.runPprStage(db, byEntity);

    // 7. Cross-encoder + LLM rerank.
    let topEntities = await this.rerank.runRerankStage({
      db,
      byEntity,
      ctx,
      typeDist,
    });
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
          passesPolicy,
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
    return { results: applyOutputShaping(hits, ctx.dto) };
  }

  private async runEdgeExpansionStage({
    db,
    byEntity,
    baseWhere,
    ctx,
  }: {
    db: Surreal;
    byEntity: Map<string, EntityBucket>;
    baseWhere: { sql: string; params: Record<string, unknown> };
    ctx: PipelineContext;
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
          passesPolicy,
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
    const pprForced = process.env.SEARCH_PPR_ENABLED === '1';
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
