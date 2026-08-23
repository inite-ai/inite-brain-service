import { Injectable, Logger } from '@nestjs/common';
import { Surreal } from 'surrealdb';
import { EmbedderService } from '../ai/embedder.service';
import { CalibrationService } from '../ai/calibration/calibration.service';
import { withSpan } from '../common/tracing';
import { traceArtifact } from '../common/debug-trace';
import type { EntityBucket, FactRow } from './internals/types';
import { runVectorLeg, runLexicalLeg } from './internals/legs';
import { buildEdgeFence } from './internals/edge-fence';
import { fuse } from './internals/fusion';
import { scoreRows, bucketByEntity } from './internals/scoring';
import type { QueryTimeRange } from './internals/scoring';
import { runSegmentLegs } from './internals/segment-leg';
import { PipelineContext } from './pipeline-context';
import { resolveSearchTuning, type SearchTuning } from './retrieval-profile';

/**
 * SearchRetrievalService — the retrieval-side stages of the search
 * pipeline: parallel vector + lexical legs with fusion, and
 * confidence-calibrated scoring + per-entity bucketing. Owns the
 * embedder (vector leg) and calibration deps. SearchService threads the
 * scoped `db` handle through these methods and sequences them with the
 * rerank stage; splitting them out keeps every search class ≤3 injected
 * deps.
 */
@Injectable()
export class SearchRetrievalService {
  private readonly logger = new Logger(SearchRetrievalService.name);

  constructor(
    private readonly embedder: EmbedderService,
    private readonly calibration: CalibrationService,
  ) {}

  /**
   * Warm the embedder's LRU for a query text WITHOUT holding a scoped
   * pool connection. Called by SearchService before withScopedCompany so
   * the vector leg's embed(query) inside the pipeline is a cache hit —
   * the external embedding round-trip must not extend connection hold
   * time on the 8-slot scoped pool. Failures are swallowed: the leg's
   * own embed call is the one whose error handling counts.
   */
  async prewarmQueryEmbedding(query: string): Promise<void> {
    try {
      await this.embedder.embed(query);
    } catch {
      /* the vector leg retries and reports */
    }
  }

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
                logger: this.logger,
                tuning: ctx.tuning,
                edgeFence: buildEdgeFence(ctx.dto.userId),
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
                tuning: ctx.tuning,
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
   * Verbatim fusion leg (audit W4 #18, profile verbatimEvidence =
   * 'fused'): episode segments retrieved as first-class candidates —
   * dense + BM25 through the SAME convex fuse() as the fact legs, then
   * the same scoring — returned as their own entity buckets for the
   * rerank / fact-centric stages to arbitrate against facts. Failures
   * degrade to an empty map: verbatim is additive evidence, never a
   * reason to fail the search.
   */
  async runSegmentLegStage(db: Surreal, ctx: PipelineContext): Promise<Map<string, EntityBucket>> {
    try {
      return await withSpan('search.segment_leg', async (span) => {
        const queryVector =
          ctx.mode !== 'lexical' ? await this.embedder.embed(ctx.dto.query) : null;
        const { vectorRows, lexicalRows } = await runSegmentLegs({
          db,
          queryText: ctx.dto.query,
          queryVector,
          fetchK: Math.max(ctx.profile.segmentTopK * 3, 12),
          callerScopes: ctx.callerScopes,
          userId: ctx.dto.userId,
          mode: ctx.mode,
        });
        const fused = fuse(vectorRows, lexicalRows, ctx.mode);
        for (const r of fused) {
          if (!r.stages?.includes('segment')) {
            r.stages = [...(r.stages ?? []), 'segment'];
          }
        }
        span.setAttribute('candidates', fused.length);
        traceArtifact(
          'search.segment_hits',
          fused.slice(0, 10).map((r) => ({
            segmentId: String(r.id),
            fusedScore: r.fusedScore,
            object: r.object.slice(0, 120),
          })),
        );
        const buckets = this.scoreAndBucket(fused, {
          temporalAnchor: ctx.profile.temporalMode === 'overlap_boost' ? ctx.asOf : null,
          tuning: ctx.tuning,
          salienceScoring: ctx.profile.salienceScoring,
          queryRange: ctx.queryRange ?? null,
        });
        // profile.segmentTopK means "segments per prompt" — the appendix
        // lane honoured it, the first fused cut did not (every fetchK
        // candidate became a bucket; measured 2.3× prompt bloat on LME
        // SSA). Keep only the top-K segment buckets by score; the fetch
        // overshoot still feeds the fusion/scoring stages their pool.
        if (buckets.size > ctx.profile.segmentTopK) {
          const keep = [...buckets.values()]
            .sort((a, b) => b.bestScore - a.bestScore)
            .slice(0, ctx.profile.segmentTopK);
          buckets.clear();
          for (const b of keep) buckets.set(b.entityId, b);
        }
        return buckets;
      });
    } catch (e) {
      this.logger.warn(
        `segment fusion leg failed (companyId=${ctx.companyId}): ${(e as Error).message}`,
      );
      return new Map();
    }
  }

  /**
   * Score + per-entity bucket with diversity-aware degree boost. The
   * calibrator rewrites raw confidence via the Phase 3 isotonic map
   * before it folds into the final score.
   */
  scoreAndBucket(
    rows: Parameters<typeof scoreRows>[0]['rows'],
    opts?: {
      /**
       * asOf anchor for the interval-overlap decay (profile
       * temporalMode = 'overlap_boost'). Null/omitted → factor 1.0.
       */
      temporalAnchor?: Date | null;
      /**
       * Deployment tuning (trust/corroboration/authority/chatter
       * knobs). Omitted → resolved fresh from the bootstrap, so a live
       * env flip lands on the next call (no constructor capture —
       * audit W6 #28).
       */
      tuning?: SearchTuning;
      /**
       * V8 §4: profile salienceScoring — folds the deriver-stamped
       * source.salience into ranking. Omitted/false → byte-identical.
       */
      salienceScoring?: boolean;
      /**
       * V13: query-named period for the time filter (profile
       * timeFilter). Null/omitted → factor 1.0, byte-identical.
       */
      queryRange?: QueryTimeRange | null;
    },
  ): Map<string, EntityBucket> {
    const tuning = opts?.tuning ?? resolveSearchTuning();
    const scored = scoreRows({
      rows,
      now: Date.now(),
      calibrator: {
        calibrate: (raw: number) => this.calibration.calibrate(raw),
      },
      trustBeta: tuning.trustBeta,
      corroborationGamma: tuning.corroborationGamma,
      authorityDelta: tuning.authorityDelta,
      chatterPenalty: tuning.chatterPenalty,
      temporalAnchor: opts?.temporalAnchor ?? null,
      queryRange: opts?.queryRange ?? null,
      salienceScoring: opts?.salienceScoring ?? false,
      // G8 usage factor: the flag gates the feature (also whether
      // readCount was attached at all), β its strength. Ranking off →
      // β 0 → factor 1.0 → byte-identical, belt-and-suspenders with the
      // unattached readCount.
      usageBeta: tuning.usageRanking ? tuning.usageBeta : 0,
      usageSaturation: tuning.usageSaturation,
    });
    return bucketByEntity(scored);
  }
}
