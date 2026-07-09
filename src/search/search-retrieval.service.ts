import { Injectable, Logger } from '@nestjs/common';
import { Surreal } from 'surrealdb';
import { EmbedderService } from '../ai/embedder.service';
import { PredicateRouterService } from '../ai/predicate-router.service';
import { QueryExpansionService } from '../ai/query-expansion.service';
import { CalibrationService } from '../ai/calibration/calibration.service';
import { withSpan } from '../common/tracing';
import { traceArtifact } from '../common/debug-trace';
import type { EntityBucket, FactRow } from './internals/types';
import {
  resolveStageBudgets,
  withStageBudget,
  type StageBudgets,
} from './internals/stage-budget';
import { runVectorLeg, runLexicalLeg, mergeVectorRows } from './internals/legs';
import { fuse } from './internals/fusion';
import {
  scoreRows,
  bucketByEntity,
  type PredicateDistribution,
} from './internals/scoring';
import { PipelineContext } from './pipeline-context';

/**
 * SearchRetrievalService — the retrieval-side stages of the search
 * pipeline: parallel vector + lexical legs with fusion, the optional
 * predicate/type router LLM call, and confidence-calibrated scoring +
 * per-entity bucketing. Owns the embedder (vector leg), predicate
 * router, and calibration deps. SearchService threads the scoped `db`
 * handle through these methods and sequences them with the rerank
 * stage; splitting them out keeps every search class ≤3 injected deps.
 */
@Injectable()
export class SearchRetrievalService {
  private readonly logger = new Logger(SearchRetrievalService.name);
  private readonly budgets: StageBudgets = resolveStageBudgets();
  // Source-reputation Phase 5 — all default 0 so ranking stays
  // byte-identical until an operator opts in. Validated at boot
  // (env-validation); the local guard covers post-boot env drift.
  private readonly trustBeta = nonNegativeFloatEnv('SEARCH_TRUST_BETA');
  private readonly corroborationGamma = nonNegativeFloatEnv(
    'SEARCH_CORROBORATION_GAMMA',
  );
  private readonly authorityDelta = nonNegativeFloatEnv(
    'SEARCH_AUTHORITY_DELTA',
  );

  // Fourth dep is the read-side query expansion (Wave 2) — a fire-and-
  // degrade LLM sidecar to the vector leg, not a new pipeline stage, so
  // it lives here with the legs it feeds rather than in a fourth class.
  // eslint-disable-next-line max-params
  constructor(
    private readonly embedder: EmbedderService,
    private readonly predicateRouter: PredicateRouterService,
    private readonly calibration: CalibrationService,
    private readonly queryExpansion: QueryExpansionService,
  ) {}

  /** Retrieval legs (parallel) + fusion. */
  async runRetrievalStage(
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
              const [primary, altRows] = await Promise.all([
                runVectorLeg({
                  db,
                  embedder: this.embedder,
                  query: ctx.dto.query,
                  k: ctx.candidateK,
                  baseWhere,
                }),
                this.runExpansionLegs(db, ctx, baseWhere),
              ]);
              const rows = altRows.length
                ? mergeVectorRows(primary, altRows)
                : primary;
              span.setAttribute('candidates', rows.length);
              span.setAttribute('expansion_candidates', altRows.length);
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
              const rows = await runLexicalLeg({
                db,
                logger: this.logger,
                query: ctx.dto.query,
                k: ctx.candidateK,
                baseWhere,
              });
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

  /**
   * Query-expansion vector legs (opt-in). One LLM reformulation call
   * (cached, under budget) fans out into one vector leg per alternative
   * phrasing; the caller merges them into the primary leg by max cosine.
   * Every failure path returns [] — the original query always serves.
   */
  private async runExpansionLegs(
    db: Surreal,
    ctx: PipelineContext,
    baseWhere: { sql: string; params: Record<string, unknown> },
  ): Promise<FactRow[]> {
    if (!this.queryExpansion.isEnabled()) return [];
    const alts = await withStageBudget({
      stage: 'queryExpansion',
      budgetMs: this.budgets.queryExpansion,
      fn: () => this.queryExpansion.expand(ctx.dto.query),
      fallback: [] as string[],
      logger: this.logger,
    });
    if (alts.length === 0) return [];
    traceArtifact('search.query_expansion', { query: ctx.dto.query, alts });
    const legs = await Promise.all(
      alts.map((alt) =>
        runVectorLeg({
          db,
          embedder: this.embedder,
          query: alt,
          k: ctx.candidateK,
          baseWhere,
        }).catch((e: Error) => {
          this.logger.warn(`expansion leg failed: ${e.message}`);
          return [] as FactRow[];
        }),
      ),
    );
    return legs.flat();
  }

  /** Predicate / type router (optional LLM call, under budget). */
  async runRouterStage(query: string) {
    const out = await withSpan('search.route', async (span) => {
      const r = await withStageBudget({
        stage: 'router',
        budgetMs: this.budgets.router,
        fn: () => this.predicateRouter.route(query),
        fallback: null,
        logger: this.logger,
      });
      span.setAttribute('router.hit', r !== null);
      return r;
    });
    if (out) traceArtifact('search.router_classification', out);
    return out;
  }

  /**
   * Score + per-entity bucket with diversity-aware degree boost. The
   * calibrator rewrites raw confidence via the Phase 3 isotonic map
   * before it folds into the final score.
   */
  scoreAndBucket(
    rows: Parameters<typeof scoreRows>[0]['rows'],
    predicateDist: PredicateDistribution | null,
  ): Map<string, EntityBucket> {
    const scored = scoreRows({
      rows,
      predicateDist,
      now: Date.now(),
      calibrator: {
        calibrate: (raw: number) => this.calibration.calibrate(raw),
      },
      trustBeta: this.trustBeta,
      corroborationGamma: this.corroborationGamma,
      authorityDelta: this.authorityDelta,
    });
    return bucketByEntity(scored);
  }
}

/** Optional non-negative float env knob; unset/invalid → 0 (feature off). */
function nonNegativeFloatEnv(name: string): number {
  const v = Number(process.env[name] ?? 0);
  return Number.isFinite(v) && v > 0 ? v : 0;
}
