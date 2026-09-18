import { Injectable, Logger, Optional } from '@nestjs/common';
import { Surreal } from 'surrealdb';
import { RerankerService } from '../ai/reranker.service';
import { CrossEncoderService } from '../ai/cross-encoder.service';
import { MetricsService } from '../metrics/metrics.service';
import { withSpan } from '../common/tracing';
import type { EntityBucket } from './internals/types';
import { withStageBudget, type StageBudgets } from './internals/stage-budget';
import { resolveSearchTuning } from './retrieval-profile';
import { fetchNeighbours, type Neighbour } from './internals/neighbours';
import { shouldSkipRerankByMargin } from './internals/rerank-skip';
import { collectFactWindow, remapWindowScores, type WindowedFact } from './internals/fact-rerank';
import { PipelineContext } from './pipeline-context';

/**
 * Stage budgets from the request's tuning snapshot; partial-cast test
 * contexts fall back to a fresh bootstrap resolution.
 */
function budgetsOf(ctx: PipelineContext): StageBudgets {
  return ctx.tuning?.stageBudgets ?? resolveSearchTuning().stageBudgets;
}

/**
 * SearchRerankService — the rerank-side stages of the search pipeline:
 * cross-encoder windowing, the margin-skip heuristic, and the LLM
 * reranker with 1-hop neighbourhood injection. Owns the reranker,
 * cross-encoder, and metrics deps (all rerank metrics live here).
 *
 * Audit W4 #20: the stage runs WITHOUT a DB handle — its only DB need
 * (1-hop neighbours for the LLM rerank body) is prefetched by
 * SearchService via prefetchNeighbours() while it still holds the
 * scoped connection, so the 8-slot scoped pool is never parked behind a
 * cross-encoder pass or an external LLM round-trip.
 */
@Injectable()
export class SearchRerankService {
  private readonly logger = new Logger(SearchRerankService.name);

  constructor(
    private readonly reranker: RerankerService,
    private readonly crossEncoder: CrossEncoderService,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  /**
   * The cross-encoder-window candidate slice, sorted by rankScore —
   * shared by the rerank stage and the neighbour prefetch so the
   * prefetch covers a superset of whatever the LLM rerank will see.
   */
  private wideCandidates(
    byEntity: Map<string, EntityBucket>,
    ctx: PipelineContext,
  ): { wideCandidates: EntityBucket[]; rerankWindow: number } {
    const rerankWindow = Math.min(ctx.limit * 2, 20);
    // The local cross-encoder scores pairs sequentially on a worker thread —
    // a 50-wide window can't clear the stage budget, so the local path gets a
    // tighter window (SEARCH_CROSS_ENCODER_LOCAL_WINDOW, default 20). Cohere
    // batches server-side and keeps the wider SEARCH_CROSS_ENCODER_WINDOW.
    const configuredWindow = this.crossEncoder.isLocalOnly()
      ? (ctx.tuning?.crossEncoderLocalWindow ?? 20)
      : (ctx.tuning?.crossEncoderWindow ?? 50);
    const crossEncoderWindow = this.crossEncoder.isEnabled()
      ? Math.min(configuredWindow, byEntity.size)
      : rerankWindow;
    return {
      wideCandidates: [...byEntity.values()]
        .sort((a, b) => b.rankScore - a.rankScore)
        .slice(0, crossEncoderWindow),
      rerankWindow,
    };
  }

  /**
   * Prefetch the 1-hop neighbourhoods the LLM rerank body will want,
   * over the cross-encoder window (a superset of the final rerank
   * window). Called by SearchService INSIDE the scoped connection;
   * returns an empty map when the LLM reranker cannot run at all, so a
   * disabled reranker costs no query.
   */
  async prefetchNeighbours(
    db: Surreal,
    byEntity: Map<string, EntityBucket>,
    ctx: PipelineContext,
  ): Promise<Map<string, Neighbour[]>> {
    // Not gated on the reranker any more: the neighbourhoods ride onto
    // the hits as `relations` and from there into the answer plane's
    // evidence, so they are wanted whether or not a reranker reads them.
    // One batched query for the wide candidate set, same as before.
    if (byEntity.size === 0) return new Map();
    const { wideCandidates } = this.wideCandidates(byEntity, ctx);
    return withSpan(
      'search.fetch_neighbours',
      () =>
        fetchNeighbours({
          db,
          logger: this.logger,
          entityIds: wideCandidates.map((e) => e.entityId),
          userId: ctx.dto.userId,
        }),
      { 'neighbours.candidates': wideCandidates.length },
    );
  }

  async runRerankStage({
    byEntity,
    ctx,
    neighboursByEntity,
  }: {
    byEntity: Map<string, EntityBucket>;
    ctx: PipelineContext;
    /** Prefetched by prefetchNeighbours(); missing entries → no graph line. */
    neighboursByEntity?: Map<string, Neighbour[]>;
  }): Promise<EntityBucket[]> {
    const { wideCandidates, rerankWindow: RERANK_WINDOW } = this.wideCandidates(byEntity, ctx);

    let candidatesForRerank = wideCandidates.slice(0, RERANK_WINDOW);

    if (this.crossEncoder.isEnabled() && wideCandidates.length > 1) {
      candidatesForRerank = await this.runCrossEncoder(
        wideCandidates,
        ctx.dto.query,
        RERANK_WINDOW,
        budgetsOf(ctx),
      );
    } else if (!this.crossEncoder.isEnabled()) {
      this.metrics?.countCrossEncoder('skipped_disabled');
    } else {
      this.metrics?.countCrossEncoder('skipped_singleton');
    }

    // The fact-level cross-encoder pass starts HERE, not after the LLM
    // rerank: the entity pass above has just released the (single,
    // serial) local worker, and the LLM rerank below is a network wait
    // the fact pass hides under. Its window is collected now — before
    // anything downstream reads scores — and its remap is applied after
    // the LLM rerank returns, so the scores every stage in between reads
    // are the fused ones, exactly as when the pass ran last.
    const factPass = this.startFactRerank({ byEntity, ctx });
    const ordered = await this.orderWithinBand({ candidatesForRerank, ctx, neighboursByEntity });
    const fact = await factPass;
    if (fact) remapWindowScores(fact.rows, fact.perm);
    return ordered;
  }

  /**
   * The band contract, the margin skip and the LLM rerank over the
   * cross-encoder's window — the part of the stage that waits on the
   * network, split out so the fact pass can run beside it.
   */
  private async orderWithinBand({
    candidatesForRerank: crossEncoded,
    ctx,
    neighboursByEntity,
  }: {
    candidatesForRerank: EntityBucket[];
    ctx: PipelineContext;
    neighboursByEntity: Map<string, Neighbour[]> | undefined;
  }): Promise<EntityBucket[]> {
    // Release blocker (audit 2026-08-21 P1): the cross-encoder's
    // permutation used to override fused-score ORDER unconditionally,
    // erasing every score-side prior — trust (SEARCH_TRUST_BETA) above
    // all: the beta moved the score but could never move the ranking.
    // Contract: rerankers refine order only WITHIN a fused-score band;
    // a gap wider than the band survives every rerank stage.
    const candidatesForRerank = this.applyScoreBandOrder(
      crossEncoded,
      ctx.tuning?.rerankTrustBand ?? 0,
    );

    const rerankSkipMargin = ctx.tuning?.rerankSkipMargin ?? 0;
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
    // Every candidate is returned when there are no more of them than
    // the caller asked for: the reranker could only permute a set the
    // generator reads whole. Three reranker calls per search for that
    // was the largest fixed cost of a small tenant's answer (measured
    // 2026-09-18: 1.2–1.8 s of a 4.5 s synthesize).
    if (candidatesForRerank.length <= ctx.limit) {
      this.metrics?.countRerank('skipped_all_fit');
      return candidatesForRerank;
    }
    if (skipByMargin) {
      this.metrics?.countRerank('skipped_margin');
      return candidatesForRerank;
    }

    const llmOrdered = await this.runLlmRerank({
      candidatesForRerank,
      ctx,
      neighboursByEntity: neighboursByEntity ?? new Map(),
    });
    // Same band contract over the LLM reranker's output — no rerank
    // stage may invert a fused-score gap wider than the band.
    return this.applyScoreBandOrder(llmOrdered, ctx.tuning?.rerankTrustBand ?? 0);
  }

  /**
   * Fact-level cross-encoder pass (July A3, profile.factRerank):
   * rescore the top-`factRerankWindow` facts of the fused pool so the
   * fact-centric budget cut selects by joint-encoder relevance instead
   * of fused score alone. Resolves to the window and the permutation
   * for the caller to apply via the rank-preserving remap (see
   * internals/fact-rerank.ts) — bucket order, the window/tail boundary
   * and the top-1 score value are all unchanged by it. Null when the
   * pass is off, has nothing to rank, or timed out (identity — same
   * contract as every rerank stage).
   */
  private async startFactRerank({
    byEntity,
    ctx,
  }: {
    byEntity: Map<string, EntityBucket>;
    ctx: PipelineContext;
  }): Promise<{ rows: WindowedFact[]; perm: number[] } | null> {
    // profile is optional-chained for the same reason budgetsOf() tolerates
    // a partial ctx: unit specs cast a bare context into the stage.
    if (!ctx.profile?.factRerank || !this.crossEncoder.isEnabled()) return null;
    const window = ctx.tuning?.factRerankWindow ?? 64;
    const rows = collectFactWindow([...byEntity.values()], window);
    if (rows.length <= 1) return null;
    const inputs = rows.map(({ row }) => {
      const ent = row.row.entity ?? {
        type: 'other',
        canonicalName: 'unknown',
      };
      return {
        label: `${ent.canonicalName} — ${row.row.predicate}`,
        body: String(row.row.object ?? ''),
      };
    });
    const identityPerm = inputs.map((_, i) => i);
    let timedOut = false;
    const perm = await withSpan(
      'search.fact_rerank',
      () =>
        withStageBudget({
          stage: 'crossEncoder',
          budgetMs: budgetsOf(ctx).crossEncoder,
          fn: () => this.crossEncoder.rerank(ctx.dto.query, inputs),
          fallback: identityPerm,
          logger: this.logger,
          onFallback: () => {
            timedOut = true;
          },
        }),
      { 'fact_rerank.candidates': inputs.length },
    );
    this.metrics?.countCrossEncoder(timedOut ? 'fact_error' : 'fact_invoked');
    return timedOut ? null : { rows, perm };
  }

  /**
   * The band contract (audit 2026-08-21 P1): reranker output may only
   * reorder buckets whose fused rankScore falls in the same band —
   * sort key (band desc, reranker position asc). Deterministic and
   * transitive (unlike a pairwise margin comparator). Band 0 → no-op.
   */
  private applyScoreBandOrder(buckets: EntityBucket[], band: number): EntityBucket[] {
    if (!(band > 0) || buckets.length <= 1) return buckets;
    const pos = new Map(buckets.map((b, i) => [b.entityId, i] as const));
    return [...buckets].sort((a, b) => {
      const bandA = Math.floor(a.rankScore / band);
      const bandB = Math.floor(b.rankScore / band);
      if (bandA !== bandB) return bandB - bandA;
      return (pos.get(a.entityId) ?? 0) - (pos.get(b.entityId) ?? 0);
    });
  }

  // eslint-disable-next-line max-params
  private async runCrossEncoder(
    wideCandidates: EntityBucket[],
    query: string,
    rerankWindow: number,
    budgets: StageBudgets,
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
          budgetMs: budgets.crossEncoder,
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
    return xPerm
      .map((i) => wideCandidates[i])
      .filter((c): c is EntityBucket => c !== undefined)
      .slice(0, rerankWindow);
  }

  private async runLlmRerank({
    candidatesForRerank,
    ctx,
    neighboursByEntity,
  }: {
    candidatesForRerank: EntityBucket[];
    ctx: PipelineContext;
    neighboursByEntity: Map<string, Neighbour[]>;
  }): Promise<EntityBucket[]> {
    // SubgraphRAG-style 1-hop neighbourhood injection. Surfaces graph
    // context as "Connected to: …" lines in the candidate body — lets
    // the reranker disambiguate shared-firstname / same-topic peers by
    // whose neighbours match the query. The map arrives prefetched
    // (audit W4 #20) — no DB work happens on this side of the seam.
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
          budgetMs: budgetsOf(ctx).rerank,
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
    return permutation
      .map((i) => candidatesForRerank[i])
      .filter((c): c is EntityBucket => c !== undefined);
  }
}
