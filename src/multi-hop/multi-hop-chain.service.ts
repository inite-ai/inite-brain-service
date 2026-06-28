import { Injectable, Logger, Optional } from '@nestjs/common';
import { SearchService, SearchHit } from '../search/search.service';
import { HopPlan, MultiHopPlan } from './multi-hop-planner.service';
import { MultiHopDto } from './dto/multi-hop.dto';
import { SynthesizeService } from '../synthesize/synthesize.service';
import { withSpan } from '../common/tracing';
import { MetricsService } from '../metrics/metrics.service';
import { NOOP_REPORTER } from '../mcp/progress-reporter';
import {
  HopOutcome,
  MultiHopResult,
  MultiHopRunOptions,
  collectFactIds,
} from './multi-hop.types';

export interface MultiHopExecuteOptions extends MultiHopRunOptions {
  /** The planner's decomposition, or null on planner outage (→ fallback). */
  plan: MultiHopPlan | null;
}

/**
 * MultiHopChainService — executes a planned multi-hop chain.
 *
 * Owns everything downstream of planning: the single-hop short-circuit,
 * the sequential hop loop with per-hop combination, the planner-outage
 * fallback to a single full-query search, the optional grounded
 * synthesis, and all multi-hop metrics. MultiHopService produces the
 * plan and delegates here. Splitting plan-vs-execute keeps both classes'
 * injected-dep lists ≤3.
 */
@Injectable()
export class MultiHopChainService {
  private readonly logger = new Logger(MultiHopChainService.name);

  constructor(
    private readonly search: SearchService,
    @Optional() private readonly synthesizer?: SynthesizeService,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  async execute({
    companyId,
    dto,
    callerScopes,
    onProgress = NOOP_REPORTER,
    plan,
  }: MultiHopExecuteOptions): Promise<MultiHopResult> {
    if (!plan) {
      // Planner outage — fall back to the single-hop pipeline so the
      // request still gets an answer. Metric tags this so we can
      // alarm if planner errors spike.
      this.metrics?.countMultiHop('planner_error');
      const single = await this.search.search(companyId, dto, callerScopes);
      const ids = single.results.map((r) => r.entityId);
      return {
        isMultiHop: false,
        hops: [],
        finalEntityIds: ids,
        finalHits: single.results,
        supportingFactIds: collectFactIds(single.results),
      };
    }

    if (!plan.isMultiHop || plan.hops.length === 1) {
      // Single hop — the planner could have just returned the
      // original query unchanged, but it might have refined it
      // (clearer subQuery, predicate filter). Run hop[0] and exit.
      const hop = plan.hops[0] ?? {
        subQuery: dto.query,
        combination: 'seed' as const,
      };
      const hopRes = await this.runHop({
        companyId,
        dto,
        callerScopes,
        hop,
        priorEntityIds: [],
      });
      this.metrics?.countMultiHop('single_hop');
      const factIds = collectFactIds(hopRes.hits);
      return {
        isMultiHop: false,
        hops: [
          {
            hop,
            hopEntityIds: hopRes.hits.map((h) => h.entityId),
            runningEntityIds: hopRes.hits.map((h) => h.entityId),
            hits: hopRes.hits,
            supportingFactIds: factIds,
          },
        ],
        finalEntityIds: hopRes.hits.map((h) => h.entityId),
        finalHits: hopRes.hits,
        supportingFactIds: factIds,
      };
    }

    // Multi-hop chain. Track per-hop outcomes + running entity set.
    const outcomes: HopOutcome[] = [];
    let runningIds: string[] = [];
    let runningHitsByEntity = new Map<string, SearchHit>();

    for (let i = 0; i < plan.hops.length; i++) {
      const hop = plan.hops[i];
      onProgress({
        stage: 'hop',
        index: i + 1,
        total: plan.hops.length,
        message: hop.subQuery,
      });
      try {
        const hopRes = await withSpan(
          'multi_hop.hop',
          () =>
            this.runHop({
              companyId,
              dto,
              callerScopes,
              hop,
              priorEntityIds: i === 0 ? [] : runningIds,
            }),
          { 'multi_hop.hop_index': i, 'multi_hop.combination': hop.combination },
        );

        const hopIds = hopRes.hits.map((h) => h.entityId);
        const next = this.combine({
          combination: hop.combination,
          priorIds: runningIds,
          hopIds,
          priorByEntity: runningHitsByEntity,
          hopHits: hopRes.hits,
        });

        outcomes.push({
          hop,
          hopEntityIds: hopIds,
          runningEntityIds: next.ids,
          hits: hopRes.hits,
          supportingFactIds: collectFactIds(hopRes.hits),
        });
        runningIds = next.ids;
        runningHitsByEntity = next.byEntity;

        // Early termination: if the running set is empty after a
        // hop, no later hop can recover. Save the LLM round-trips.
        if (runningIds.length === 0 && hop.combination !== 'union') {
          this.metrics?.countMultiHop('chain_empty');
          break;
        }
      } catch (err) {
        this.logger.warn(
          `Multi-hop hop ${i} failed: ${(err as Error).message}`,
        );
        this.metrics?.countMultiHop('hop_error');
        break;
      }
    }

    if (outcomes.length === plan.hops.length && runningIds.length > 0) {
      this.metrics?.countMultiHop('ok');
    } else if (outcomes.length === 0) {
      this.metrics?.countMultiHop('no_results');
    }

    const finalHits = runningIds
      .map((id) => runningHitsByEntity.get(id))
      .filter((h): h is SearchHit => !!h);

    // Aggregate supporting evidence across all hops, in execution
    // order, deduped. This is the "reasoning chain" — what a
    // HotpotQA-style Joint-F1 scorer compares against the gold
    // supporting set, and what a synthesizer would cite from when
    // grounding the chained-search answer.
    const aggregatedSupport: string[] = [];
    const seenSupport = new Set<string>();
    for (const o of outcomes) {
      for (const fid of o.supportingFactIds) {
        if (!seenSupport.has(fid)) {
          seenSupport.add(fid);
          aggregatedSupport.push(fid);
        }
      }
    }

    const result: MultiHopResult = {
      isMultiHop: true,
      hops: outcomes,
      finalEntityIds: runningIds,
      finalHits,
      supportingFactIds: aggregatedSupport,
    };

    if (dto.synthesize && this.synthesizer && finalHits.length > 0) {
      onProgress({ stage: 'synthesize', message: 'grounding answer' });
      const synth = await withSpan(
        'multi_hop.synthesize',
        () =>
          this.synthesizer!.synthesize({
            companyId,
            dto: {
              ...dto,
              entityIds: runningIds,
              synthesize: undefined,
            } as never,
            callerScopes,
            onProgress,
          }),
        { 'multi_hop.final_set': finalHits.length },
      );
      result.synthesis = {
        answer: synth.answer,
        reason: synth.reason,
        citations: synth.citations,
      };
    }

    onProgress({ stage: 'done' });
    return result;
  }

  /**
   * Run one hop. Honours the hop's local predicate / asOf overrides
   * and, when combination=subset_of_previous, anchors to the running
   * entity set via SearchDto.entityIds (pushed into WHERE).
   */
  private async runHop({
    companyId,
    dto,
    callerScopes,
    hop,
    priorEntityIds,
  }: {
    companyId: string;
    dto: MultiHopDto;
    callerScopes: string[];
    hop: HopPlan;
    priorEntityIds: string[];
  }): Promise<{ hits: SearchHit[] }> {
    // Build a per-hop SearchDto that inherits the caller's broad
    // intent (limit, mode, includeContested, ...) and overlays the
    // hop's local refinements.
    //
    // Edge-aware subset_of_previous: when MULTI_HOP_EDGE_EXPANSION_ENABLED
    // is set, expand priorEntityIds by their 1-hop neighbourhood over
    // knowledge_edge before anchoring. This turns "FROM the previous
    // result, KEEP those that ALSO …" into "FROM the previous result
    // OR THEIR DIRECT NEIGHBOURS, KEEP those that ALSO …" — letting
    // the chain reach an entity whose own facts don't repeat the
    // anchor's terms but which is graph-linked (e.g. an asset linked
    // to a complaining customer's project). Default OFF so the
    // existing eval baseline doesn't shift; operator-tunable.
    let anchorIds: string[] | undefined;
    if (
      hop.combination === 'subset_of_previous' &&
      priorEntityIds.length > 0
    ) {
      anchorIds = priorEntityIds;
      if (process.env.MULTI_HOP_EDGE_EXPANSION_ENABLED === '1') {
        try {
          anchorIds = await this.search.expandEntityIdsViaEdges(
            companyId,
            priorEntityIds,
            callerScopes,
          );
        } catch (err) {
          this.logger.warn(
            `multi-hop edge-expansion failed, anchoring to bare prior set: ${(err as Error).message}`,
          );
        }
      }
    }
    const hopDto = {
      ...dto,
      query: hop.subQuery,
      // The planner emits an empty/null predicates list when it
      // can't disambiguate; honour that as "no filter" rather than
      // an empty INSIDE clause that would match nothing.
      predicates: hop.predicates && hop.predicates.length > 0
        ? hop.predicates
        : dto.predicates,
      asOf: hop.asOf ?? dto.asOf,
      // Anchor only when explicitly requested — for 'intersect' /
      // 'union' the search runs unconstrained and combination
      // happens after the fact.
      entityIds: anchorIds,
      // Drop multi-hop-specific keys so they don't accidentally trip
      // the SearchDto whitelist when re-validated downstream.
      maxHops: undefined,
      synthesize: undefined,
      synthesisGuardrails: undefined,
      synthesisModel: undefined,
    };
    const out = await this.search.search(companyId, hopDto, callerScopes);
    return { hits: out.results };
  }

  /**
   * Combine the prior running entity-set with the current hop's hits
   * according to the hop's combination semantics. Returns the new
   * running id list AND a map from entityId → the SearchHit we
   * should keep (preferring the most recent hop's hit so the response
   * shows the freshest fact ranking for each entity).
   *
   * subset_of_previous: same as intersect for the post-search step
   * because the search itself was already anchored on prior ids.
   * Listing it explicitly so adding a new combination later doesn't
   * silently fall through to a default.
   */
  private combine({
    combination,
    priorIds,
    hopIds,
    priorByEntity,
    hopHits,
  }: {
    combination: HopPlan['combination'];
    priorIds: string[];
    hopIds: string[];
    priorByEntity: Map<string, SearchHit>;
    hopHits: SearchHit[];
  }): { ids: string[]; byEntity: Map<string, SearchHit> } {
    const hopByEntity = new Map<string, SearchHit>();
    for (const h of hopHits) hopByEntity.set(h.entityId, h);

    if (combination === 'seed') {
      return { ids: hopIds, byEntity: hopByEntity };
    }

    if (combination === 'union') {
      const out = new Map<string, SearchHit>();
      for (const [id, h] of priorByEntity) out.set(id, h);
      for (const [id, h] of hopByEntity) out.set(id, h);
      return { ids: [...out.keys()], byEntity: out };
    }

    if (combination === 'subset_of_previous') {
      // SQL anchored the search already (entityIds INSIDE anchor set),
      // so hopHits ⊆ anchor set by construction. With pure
      // set-membership chaining (no edge expansion) anchor == priorIds,
      // and the JS-side intersect with priorIds is a no-op. With edge
      // expansion ON, anchor == priorIds ∪ 1-hop neighbours — applying
      // intersect(hopIds, priorIds) here would clip the result back to
      // the bare prior set and silently undo the expansion. Skip the
      // JS-side intersect: trust the SQL anchor.
      return { ids: hopIds, byEntity: hopByEntity };
    }

    // intersect (post-hoc, search ran unconstrained)
    const priorSet = new Set(priorIds);
    const ids = hopIds.filter((id) => priorSet.has(id));
    const byEntity = new Map<string, SearchHit>();
    for (const id of ids) {
      // Prefer the hop's hit (newer scoring context) but fall back
      // to the prior-bucket hit if the hop somehow returned null
      // facts — keeps the response shape stable for tracing.
      byEntity.set(id, hopByEntity.get(id) ?? priorByEntity.get(id)!);
    }
    return { ids, byEntity };
  }
}
