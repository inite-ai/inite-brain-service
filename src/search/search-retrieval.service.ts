import { Injectable, Logger } from '@nestjs/common';
import { Surreal } from 'surrealdb';
import { EmbedderService } from '../ai/embedder.service';
import { CalibrationService } from '../ai/calibration/calibration.service';
import { withSpan } from '../common/tracing';
import { traceArtifact } from '../common/debug-trace';
import type { EntityBucket, FactRow } from './internals/types';
import { runVectorLeg, runLexicalLeg } from './internals/legs';
import { fuse } from './internals/fusion';
import { scoreRows, bucketByEntity } from './internals/scoring';
import { PipelineContext } from './pipeline-context';

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
  // Chatter demotion — a sub-1.0 multiplier on `said` facts. Unlike the
  // trust knobs, the OFF value is 1.0 (not 0), so a dedicated reader with a
  // (0,1] clamp; unset/invalid/≥1 → 1.0 → byte-identical ranking.
  private readonly chatterPenalty = unitPenaltyEnv('SEARCH_CHATTER_PENALTY');

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

  /**
   * Score + per-entity bucket with diversity-aware degree boost. The
   * calibrator rewrites raw confidence via the Phase 3 isotonic map
   * before it folds into the final score.
   */
  scoreAndBucket(
    rows: Parameters<typeof scoreRows>[0]['rows'],
  ): Map<string, EntityBucket> {
    const scored = scoreRows({
      rows,
      now: Date.now(),
      calibrator: {
        calibrate: (raw: number) => this.calibration.calibrate(raw),
      },
      trustBeta: this.trustBeta,
      corroborationGamma: this.corroborationGamma,
      authorityDelta: this.authorityDelta,
      chatterPenalty: this.chatterPenalty,
    });
    return bucketByEntity(scored);
  }
}

/** Optional non-negative float env knob; unset/invalid → 0 (feature off). */
function nonNegativeFloatEnv(name: string): number {
  const v = Number(process.env[name] ?? 0);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * Penalty multiplier env knob; OFF is 1.0. Returns the value only when it's
 * a real demotion in (0,1); unset / invalid / ≥1 → 1.0 (no penalty).
 */
function unitPenaltyEnv(name: string): number {
  const raw = process.env[name];
  if (raw === undefined) return 1;
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 && v < 1 ? v : 1;
}
