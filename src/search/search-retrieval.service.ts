import { Injectable, Logger } from '@nestjs/common';
import { Surreal } from 'surrealdb';
import { EmbedderService } from '../ai/embedder.service';
import { PredicateRouterService } from '../ai/predicate-router.service';
import { CalibrationService } from '../ai/calibration/calibration.service';
import { withSpan } from '../common/tracing';
import { traceArtifact } from '../common/debug-trace';
import type { EntityBucket, FactRow } from './internals/types';
import {
  resolveStageBudgets,
  withStageBudget,
  type StageBudgets,
} from './internals/stage-budget';
import { runVectorLeg, runLexicalLeg } from './internals/legs';
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

  constructor(
    private readonly embedder: EmbedderService,
    private readonly predicateRouter: PredicateRouterService,
    private readonly calibration: CalibrationService,
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
              const rows = await runVectorLeg({
                db,
                embedder: this.embedder,
                query: ctx.dto.query,
                k: ctx.candidateK,
                baseWhere,
              });
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
    });
    return bucketByEntity(scored);
  }
}
