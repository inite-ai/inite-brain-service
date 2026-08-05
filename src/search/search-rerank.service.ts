import { Injectable, Logger, Optional } from '@nestjs/common';
import { Surreal } from 'surrealdb';
import { RerankerService } from '../ai/reranker.service';
import { CrossEncoderService } from '../ai/cross-encoder.service';
import { MetricsService } from '../metrics/metrics.service';
import { withSpan } from '../common/tracing';
import type { EntityBucket } from './internals/types';
import {
  resolveStageBudgets,
  withStageBudget,
  type StageBudgets,
} from './internals/stage-budget';
import { fetchNeighbours } from './internals/neighbours';
import { shouldSkipRerankByMargin } from './internals/rerank-skip';
import { PipelineContext } from './pipeline-context';

/**
 * SearchRerankService — the rerank-side stages of the search pipeline:
 * cross-encoder windowing, the margin-skip heuristic, and the LLM
 * reranker with 1-hop neighbourhood injection. Owns the reranker,
 * cross-encoder, and metrics deps (all rerank metrics live here).
 * SearchService passes the bucketed candidates + scoped `db`; splitting
 * this out keeps every search class ≤3 injected deps.
 */
@Injectable()
export class SearchRerankService {
  private readonly logger = new Logger(SearchRerankService.name);
  private readonly budgets: StageBudgets = resolveStageBudgets();

  constructor(
    private readonly reranker: RerankerService,
    private readonly crossEncoder: CrossEncoderService,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  async runRerankStage({
    db,
    byEntity,
    ctx,
  }: {
    db: Surreal;
    byEntity: Map<string, EntityBucket>;
    ctx: PipelineContext;
  }): Promise<EntityBucket[]> {
    const RERANK_WINDOW = Math.min(ctx.limit * 2, 20);
    // The local cross-encoder scores pairs sequentially on a worker thread —
    // a 50-wide window can't clear the stage budget, so the local path gets a
    // tighter window (SEARCH_CROSS_ENCODER_LOCAL_WINDOW, default 20). Cohere
    // batches server-side and keeps the wider SEARCH_CROSS_ENCODER_WINDOW.
    const configuredWindow = this.crossEncoder.isLocalOnly()
      ? parseInt(process.env.SEARCH_CROSS_ENCODER_LOCAL_WINDOW ?? '20', 10) || 20
      : parseInt(process.env.SEARCH_CROSS_ENCODER_WINDOW ?? '50', 10) || 50;
    const CROSS_ENCODER_WINDOW = this.crossEncoder.isEnabled()
      ? Math.min(configuredWindow, byEntity.size)
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
    // shouldSkipRerankByMargin compares fused rankScore of top-1 vs top-2.
    // After runCrossEncoder, candidatesForRerank is ordered by cross-encoder
    // relevance, NOT by rankScore — so candidatesForRerank[0/1] are no longer
    // the highest-rankScore pair. Compute the margin on a rankScore-sorted
    // copy so the heuristic reads the pair it actually claims to.
    const skipByMargin = shouldSkipRerankByMargin(
      [...candidatesForRerank].sort((a, b) => b.rankScore - a.rankScore),
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

    return this.runLlmRerank({ db, candidatesForRerank, ctx });
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
    // Distinguish a budget-timeout fallback (which returns identityPerm)
    // from the cross-encoder genuinely producing an unchanged order. The
    // old code inferred 'error' from an identity permutation, which
    // mislabelled every legitimate no-op rerank as a failure.
    let timedOut = false;
    const xPerm = await withSpan(
      'search.cross_encoder',
      () =>
        withStageBudget({
          stage: 'crossEncoder',
          budgetMs: this.budgets.crossEncoder,
          fn: () => this.crossEncoder.rerank(query, xInputs),
          fallback: identityPerm,
          logger: this.logger,
          onFallback: () => {
            timedOut = true;
          },
        }),
      { 'cross_encoder.candidates': xInputs.length },
    );
    this.metrics?.countCrossEncoder(timedOut ? 'error' : 'invoked');
    return xPerm.map((i) => wideCandidates[i]).slice(0, rerankWindow);
  }

  private async runLlmRerank({
    db,
    candidatesForRerank,
    ctx,
  }: {
    db: Surreal;
    candidatesForRerank: EntityBucket[];
    ctx: PipelineContext;
  }): Promise<EntityBucket[]> {
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

    const identityPerm = rerankInputs.map((_, i) => i);
    // Distinguish a budget-timeout fallback (returns identityPerm) from the
    // reranker genuinely returning an unchanged order — mirroring the
    // cross-encoder path. The old code inferred the outcome from an
    // identity permutation, mislabelling BOTH a legitimate no-op rerank AND
    // a timeout as 'skipped_disabled', so rerank timeouts were invisible.
    let timedOut = false;
    const permutation = await withSpan(
      'search.rerank',
      () =>
        withStageBudget({
          stage: 'rerank',
          budgetMs: this.budgets.rerank,
          fn: () => this.reranker.rerank(ctx.dto.query, rerankInputs),
          fallback: identityPerm,
          logger: this.logger,
          onFallback: () => {
            timedOut = true;
          },
        }),
      { 'rerank.candidates': rerankInputs.length },
    );
    this.metrics?.countRerank(timedOut ? 'error' : 'invoked');
    return permutation.map((i) => candidatesForRerank[i]);
  }
}
