import { Injectable, Logger, Optional } from '@nestjs/common';
import { Surreal } from 'surrealdb';
import { SurrealService } from '../db/surreal.service';
import { EmbedderService } from '../ai/embedder.service';
import { RerankerService } from '../ai/reranker.service';
import { PredicateRouterService } from '../ai/predicate-router.service';
import { CrossEncoderService } from '../ai/cross-encoder.service';
import { SearchDto, SearchMode } from './dto/search.dto';
import { MetricsService } from '../metrics/metrics.service';
import { withSpan } from '../common/tracing';
import { traceArtifact } from '../common/debug-trace';

import type { SearchHit } from './search.types';
import type { EntityBucket, FactRow } from './internals/types';
import {
  resolveStageBudgets,
  withStageBudget,
  type StageBudgets,
} from './internals/stage-budget';
import { buildBaseWhere } from './internals/where-builder';
import { runVectorLeg, runLexicalLeg } from './internals/legs';
import { fuse } from './internals/fusion';
import { hydrateSurvivors, reattributeMerged } from './internals/identity-merge';
import { passesPolicy } from './internals/policy';
import { scoreRows, bucketByEntity } from './internals/scoring';
import {
  fetchNeighbours,
  expandEntityIdsViaEdges as expandEntityIdsViaEdgesDb,
} from './internals/neighbours';
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

export type { SearchHit } from './search.types';
export type { GraphRetrieveHit } from './internals/graph-retrieve';

/**
 * Search orchestrator. The retrieval pipeline lives in stage modules
 * under `./internals/` — this file's only job is to:
 *   1. Translate the public `SearchDto` into a per-request context.
 *   2. Sequence the stages (retrieval → fusion → identity merge →
 *      scoring → bucketing → edge expansion → PPR → cross-encoder →
 *      LLM rerank → backfill → assemble).
 *   3. Wire each stage to its withSpan / withStageBudget / metrics
 *      callsite.
 *
 * Anything heavier than that belongs in a stage module. Adding a new
 * stage means adding a new file under internals/ + one extra line
 * here — not growing this method.
 */
@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);
  private readonly budgets: StageBudgets;

  constructor(
    private readonly surreal: SurrealService,
    private readonly embedder: EmbedderService,
    private readonly reranker: RerankerService,
    private readonly predicateRouter: PredicateRouterService,
    private readonly crossEncoder: CrossEncoderService,
    @Optional() private readonly metrics?: MetricsService,
  ) {
    this.budgets = resolveStageBudgets();
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
   * Graph-first retrieval. Resolves named entities by canonical name,
   * walks their 1-hop neighbourhood over knowledge_edge, and returns
   * facts across (seeds ∪ neighbours) optionally filtered by predicate
   * hints. Replaces the demo controller's inline graphSearch which
   * filtered only the seed's own facts and missed multi-hop answers
   * (asking "who runs engineering at Acme" → the status fact lives on
   * Maria, not Acme).
   *
   *   queryText       — used for substring fallback when entityRefs
   *                     are absent (e.g. chat router didn't lift a
   *                     clean mention).
   *   entityRefs      — canonical names the chat router identified.
   *   predicateHints  — predicates the question targets; controls the
   *                     SQL filter and the assembly-pass score policy.
   *   asOf            — ISO date for bitemporal cut; undefined = "now".
   *   callerScopes    — scope gate (PII fields stripped by surreal
   *                     PERMISSIONS on the scoped connection).
   *
   * Soft-fail across the board: a query error logs and returns the
   * partial result so the caller can fall through to vector.
   */
  async graphRetrieve(
    companyId: string,
    queryText: string,
    entityRefs: string[],
    predicateHints: string[],
    asOf: string | undefined,
    callerScopes: string[],
  ): Promise<{ results: GraphRetrieveHit[] }> {
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

          const factsByEntity = await fetchFactsForEntities(
            db,
            [...entitiesById.keys()],
            predicateHints,
            asOf,
          );

          traceArtifact('graph_retrieve', {
            seeds: seedIds,
            neighbours: neighbourIds,
            factsByEntity: Object.fromEntries(
              [...factsByEntity.entries()].map(([k, v]) => [k, v.length]),
            ),
            predicateHints,
          });

          const results = assembleGraphHits(
            seedIds,
            entitiesById,
            factsByEntity,
            predicateHints,
          );
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
    const baseWhere = buildBaseWhere(
      ctx.dto,
      ctx.asOf,
      ctx.includeRetracted,
      ctx.includeContested,
    );
    traceArtifact('search.query', {
      query: ctx.dto.query,
      mode: ctx.mode,
      candidateK: ctx.candidateK,
      asOf: ctx.dto.asOf,
    });

    // 1. Retrieval legs (parallel) + fusion.
    const fused = await this.runRetrievalStage(db, ctx, baseWhere);

    // 2. Identity-merge re-attribution + scope-policy filter.
    const survivorRecords = await hydrateSurvivors(db, fused);
    const reattributed = reattributeMerged(fused, survivorRecords);
    const filtered = reattributed.filter((row) =>
      passesPolicy(row, ctx.dto, ctx.callerScopes),
    );

    // 3. Predicate / type router (optional LLM call, under budget).
    const routerOut = await this.runRouterStage(ctx.dto.query);
    const predicateDist = routerOut?.predicates ?? null;
    const typeDist = routerOut?.types ?? null;

    // 4. Scoring + per-entity bucketing with diversity-aware degree boost.
    const scored = scoreRows(filtered, predicateDist, Date.now());
    const byEntity = bucketByEntity(scored);

    // 5. Edge expansion (default ON) — graph-walk from top seeds.
    await this.runEdgeExpansionStage(db, byEntity, baseWhere, ctx);

    // 6. PPR (opt-in) — HippoRAG-style cluster lift.
    await this.runPprStage(db, byEntity);

    // 7. Cross-encoder + LLM rerank.
    let topEntities = await this.runRerankStage(db, byEntity, ctx, typeDist);
    topEntities = topEntities.slice(0, ctx.limit);

    // 8. Backfill missing facts for top-K, then assemble.
    const backfillByEntity = await withStageBudget(
      'backfill',
      this.budgets.backfill,
      () =>
        backfillEntityFacts(
          db,
          this.logger,
          topEntities.map((e) => e.entityId),
          baseWhere,
          ctx.dto,
          ctx.callerScopes,
          passesPolicy,
        ),
      new Map<string, FactRow[]>(),
      this.logger,
    );
    const hits = assembleHits(
      topEntities,
      backfillByEntity,
      ctx.dto.entityTypes,
    );
    return { results: applyOutputShaping(hits, ctx.dto) };
  }

  private async runRetrievalStage(
    db: Surreal,
    ctx: PipelineContext,
    baseWhere: { sql: string; params: Record<string, unknown> },
  ) {
    const [vectorRows, lexicalRows] = await Promise.all([
      ctx.mode === 'lexical'
        ? Promise.resolve([] as FactRow[])
        : withSpan(
            'search.vector_leg',
            async (span) => {
              const rows = await runVectorLeg(
                db,
                this.embedder,
                ctx.dto.query,
                ctx.candidateK,
                baseWhere,
              );
              span.setAttribute('candidates', rows.length);
              traceArtifact(
                'search.vector_hits',
                rows.slice(0, 20).map((r) => ({
                  factId: String(r.id),
                  entityId: String(r.entityId),
                  predicate: r.predicate,
                  object: r.object,
                  simScore: r.simScore,
                })),
              );
              return rows;
            },
            { 'search.k': ctx.candidateK },
          ),
      ctx.mode === 'vector'
        ? Promise.resolve([] as FactRow[])
        : withSpan(
            'search.lexical_leg',
            async (span) => {
              const rows = await runLexicalLeg(
                db,
                this.logger,
                ctx.dto.query,
                ctx.candidateK,
                baseWhere,
              );
              span.setAttribute('candidates', rows.length);
              traceArtifact(
                'search.lexical_hits',
                rows.slice(0, 20).map((r) => ({
                  factId: String(r.id),
                  entityId: String(r.entityId),
                  predicate: r.predicate,
                  object: r.object,
                  bm25Score: r.bm25Score,
                })),
              );
              return rows;
            },
            { 'search.k': ctx.candidateK },
          ),
    ]);
    return fuse(vectorRows, lexicalRows, ctx.mode);
  }

  private async runRouterStage(query: string) {
    const out = await withSpan('search.route', async (span) => {
      const r = await withStageBudget(
        'router',
        this.budgets.router,
        () => this.predicateRouter.route(query),
        null,
        this.logger,
      );
      span.setAttribute('router.hit', r !== null);
      return r;
    });
    if (out) traceArtifact('search.router_classification', out);
    return out;
  }

  private async runEdgeExpansionStage(
    db: Surreal,
    byEntity: Map<string, EntityBucket>,
    baseWhere: { sql: string; params: Record<string, unknown> },
    ctx: PipelineContext,
  ): Promise<void> {
    if (process.env.SEARCH_EDGE_EXPANSION_ENABLED === '0') return;
    if (byEntity.size < 1) return;
    await withSpan(
      'search.edge_expansion',
      async (span) => {
        const injected = await expandViaEdges(
          db,
          this.logger,
          byEntity,
          baseWhere,
          ctx.dto,
          ctx.callerScopes,
          passesPolicy,
        );
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

  private async runRerankStage(
    db: Surreal,
    byEntity: Map<string, EntityBucket>,
    ctx: PipelineContext,
    typeDist: { weights: Record<string, number> } | null,
  ): Promise<EntityBucket[]> {
    const RERANK_WINDOW = Math.min(ctx.limit * 2, 20);
    const CROSS_ENCODER_WINDOW = this.crossEncoder.isEnabled()
      ? Math.min(
          parseInt(process.env.SEARCH_CROSS_ENCODER_WINDOW ?? '50', 10) || 50,
          byEntity.size,
        )
      : RERANK_WINDOW;

    const wideCandidates = [...byEntity.values()]
      .sort((a, b) => b.rankScore - a.rankScore)
      .slice(0, CROSS_ENCODER_WINDOW);

    let candidatesForRerank = wideCandidates.slice(0, RERANK_WINDOW);

    if (this.crossEncoder.isEnabled() && wideCandidates.length > 1) {
      candidatesForRerank = await this.runCrossEncoder(
        wideCandidates,
        ctx.dto.query,
        RERANK_WINDOW,
      );
    } else if (!this.crossEncoder.isEnabled()) {
      this.metrics?.countCrossEncoder('skipped_disabled');
    } else {
      this.metrics?.countCrossEncoder('skipped_singleton');
    }

    const rerankSkipMargin = parseFloat(
      process.env.SEARCH_RERANK_SKIP_MARGIN ?? '0',
    );
    const skipByMargin = shouldSkipRerankByMargin(
      candidatesForRerank,
      rerankSkipMargin,
    );

    if (!this.reranker.isEnabled()) {
      this.metrics?.countRerank('skipped_disabled');
      return candidatesForRerank;
    }
    if (candidatesForRerank.length <= 1) {
      this.metrics?.countRerank('skipped_singleton');
      return candidatesForRerank;
    }
    if (skipByMargin) {
      this.metrics?.countRerank('skipped_margin');
      return candidatesForRerank;
    }

    return this.runLlmRerank(db, candidatesForRerank, ctx, typeDist);
  }

  private async runCrossEncoder(
    wideCandidates: EntityBucket[],
    query: string,
    rerankWindow: number,
  ): Promise<EntityBucket[]> {
    // Build inputs once — same shape feeds both cross-encoder and LLM
    // rerank stages. The LLM stage adds neighbours later (per-candidate
    // fetch happens inside its branch); the cross-encoder runs on the
    // lighter "label + top-3 facts" body for speed and cost.
    const xInputs = wideCandidates.map((e) => {
      const ent = e.facts[0]?.row.entity ?? {
        type: 'other',
        canonicalName: e.entityId,
      };
      const topFacts = [...e.facts]
        .sort((a, b) => b.score - a.score)
        .slice(0, 3)
        .map((sf) => `- ${sf.row.predicate}: ${sf.row.object}`)
        .join('\n');
      return { label: `${ent.canonicalName} [${ent.type}]`, body: topFacts };
    });
    const identityPerm = xInputs.map((_, i) => i);
    const xPerm = await withSpan(
      'search.cross_encoder',
      () =>
        withStageBudget(
          'crossEncoder',
          this.budgets.crossEncoder,
          () => this.crossEncoder.rerank(query, xInputs),
          identityPerm,
          this.logger,
        ),
      { 'cross_encoder.candidates': xInputs.length },
    );
    const isIdentity = xPerm.every((idx, i) => idx === i);
    this.metrics?.countCrossEncoder(isIdentity ? 'error' : 'invoked');
    return xPerm.map((i) => wideCandidates[i]).slice(0, rerankWindow);
  }

  private async runLlmRerank(
    db: Surreal,
    candidatesForRerank: EntityBucket[],
    ctx: PipelineContext,
    typeDist: { weights: Record<string, number> } | null,
  ): Promise<EntityBucket[]> {
    // SubgraphRAG-style 1-hop neighbourhood injection. Surfaces graph
    // context as "Connected to: …" lines in the candidate body — lets
    // the reranker disambiguate shared-firstname / same-topic peers by
    // whose neighbours match the query.
    const neighboursByEntity = await withSpan(
      'search.fetch_neighbours',
      () =>
        fetchNeighbours(
          db,
          this.logger,
          candidatesForRerank.map((e) => e.entityId),
        ),
      { 'neighbours.candidates': candidatesForRerank.length },
    );

    const rerankInputs = candidatesForRerank.map((e) => {
      const ent = e.facts[0]?.row.entity ?? {
        type: 'other',
        canonicalName: e.entityId,
      };
      const topFacts = [...e.facts]
        .sort((a, b) => b.score - a.score)
        .slice(0, 3)
        .map((sf) => `- ${sf.row.predicate}: ${sf.row.object}`)
        .join('\n');
      const nbrs = neighboursByEntity.get(e.entityId) ?? [];
      const nbrLine = nbrs.length
        ? `\nConnected to: ${nbrs
            .slice(0, 5)
            .map((n) => `${n.canonicalName} (${n.type}, ${n.kind})`)
            .join('; ')}`
        : '';
      return {
        label: `${ent.canonicalName} [${ent.type}]`,
        body: `${topFacts}${nbrLine}`,
      };
    });

    const hints = typeDist
      ? `Likely target entity types: ${
          Object.entries(typeDist.weights)
            .filter(([, w]) => w >= 0.15)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([t, w]) => `${t}=${w.toFixed(2)}`)
            .join(', ') || 'unspecified'
        }.`
      : undefined;

    const identityPerm = rerankInputs.map((_, i) => i);
    const permutation = await withSpan(
      'search.rerank',
      () =>
        withStageBudget(
          'rerank',
          this.budgets.rerank,
          () => this.reranker.rerank(ctx.dto.query, rerankInputs, hints),
          identityPerm,
          this.logger,
        ),
      { 'rerank.candidates': rerankInputs.length },
    );
    const isIdentity = permutation.every((idx, i) => idx === i);
    this.metrics?.countRerank(isIdentity ? 'skipped_disabled' : 'invoked');
    return permutation.map((i) => candidatesForRerank[i]);
  }
}

interface PipelineContext {
  dto: SearchDto;
  callerScopes: string[];
  limit: number;
  asOf: Date | null;
  includeRetracted: boolean;
  includeContested: boolean;
  mode: SearchMode;
  candidateK: number;
}
