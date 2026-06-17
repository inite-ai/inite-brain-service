import { Injectable, Logger, Optional } from '@nestjs/common';
import { SearchService, SearchHit } from '../search/search.service';
import {
  HopPlan,
  MultiHopPlan,
  MultiHopPlannerService,
} from './multi-hop-planner.service';
import { MultiHopDto } from './dto/multi-hop.dto';
import { SynthesizeService } from '../synthesize/synthesize.service';
import type {
  Citation,
  SynthesisReason,
} from '../synthesize/synthesize.service';
import { withSpan } from '../common/tracing';
import { MetricsService } from '../metrics/metrics.service';

export interface HopOutcome {
  hop: HopPlan;
  /** Result IDs from this hop alone (pre-combination). */
  hopEntityIds: string[];
  /** Running entity set AFTER applying combination with the prior hop. */
  runningEntityIds: string[];
  hits: SearchHit[];
  /**
   * factIds the hop pulled (top facts from each hop hit). Aggregated
   * here so a downstream scorer (HotpotQA-style Joint F1) doesn't
   * need to walk hits[].facts[]. Includes only the SCORED facts the
   * hop returned — same shape the response body carries.
   */
  supportingFactIds: string[];
}

export interface MultiHopResult {
  isMultiHop: boolean;
  hops: HopOutcome[];
  finalEntityIds: string[];
  finalHits: SearchHit[];
  /**
   * Union of supportingFactIds across all hops in execution order,
   * de-duplicated. This is the "evidence chain" — what we'd compare
   * against gold supporting facts in a HotpotQA-style Joint F1
   * evaluation, and what a synthesizer would cite from when grounding
   * the chained-search answer.
   */
  supportingFactIds: string[];
  /** Set when synthesize=true was requested. */
  synthesis?: {
    answer: string | null;
    reason?: SynthesisReason;
    citations: Citation[];
  };
}

/**
 * MultiHopService — chained search across hop-decomposed sub-queries.
 *
 * Flow:
 *   1. Planner LLM splits the free-text query into ≤ maxHops sub-queries
 *      with combination semantics (seed | subset_of_previous | intersect
 *      | union) and optional predicate / asOf filters.
 *   2. Executor runs hops sequentially. Hop N>1 with
 *      combination=subset_of_previous restricts its `entityIds` to the
 *      running set so the search engine sees only candidates that
 *      already passed prior hops — this is where compute is saved.
 *   3. Final entity set passes optionally through the synthesizer for
 *      a grounded answer with citations.
 *
 * Single-hop short-circuit: when the planner reports isMultiHop=false,
 * we still run hop[0] but skip the chaining ceremony — the response
 * carries one HopOutcome and the final set is identical to the seed.
 *
 * Failure modes are explicit and per-hop. Planner-LLM outage → fall
 * back to a single full-query search, mark isMultiHop=false, surface
 * outcome=planner_error in the metric. Hop-search exception → stop
 * the chain, return what we have, mark outcome=hop_error.
 */
/**
 * De-duped union of factIds across a hop's hits, preserving
 * original order so a downstream scorer can reason about ranking
 * if it cares to. Pure helper — extracted so single-hop and multi-
 * hop branches share the same shape.
 */
function collectFactIds(hits: SearchHit[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const h of hits) {
    for (const f of h.facts) {
      if (!seen.has(f.factId)) {
        seen.add(f.factId);
        out.push(f.factId);
      }
    }
  }
  return out;
}

@Injectable()
export class MultiHopService {
  private readonly logger = new Logger(MultiHopService.name);

  constructor(
    private readonly search: SearchService,
    private readonly planner: MultiHopPlannerService,
    @Optional() private readonly synthesizer?: SynthesizeService,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  async run(
    companyId: string,
    dto: MultiHopDto,
    callerScopes: string[],
  ): Promise<MultiHopResult> {
    const maxHops = Math.min(dto.maxHops ?? 3, 5);

    let plan: MultiHopPlan | null = null;
    plan = await withSpan(
      'multi_hop.plan',
      () => this.planner.plan(dto.query, maxHops),
      { 'multi_hop.maxHops': maxHops },
    );

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
      const hopRes = await this.runHop(companyId, dto, callerScopes, hop, []);
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
      try {
        const hopRes = await withSpan(
          'multi_hop.hop',
          () =>
            this.runHop(
              companyId,
              dto,
              callerScopes,
              hop,
              i === 0 ? [] : runningIds,
            ),
          { 'multi_hop.hop_index': i, 'multi_hop.combination': hop.combination },
        );

        const hopIds = hopRes.hits.map((h) => h.entityId);
        const next = this.combine(
          hop.combination,
          runningIds,
          hopIds,
          runningHitsByEntity,
          hopRes.hits,
        );

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
      const synth = await withSpan(
        'multi_hop.synthesize',
        () =>
          this.synthesizer!.synthesize(
            companyId,
            {
              ...dto,
              entityIds: runningIds,
              synthesize: undefined,
            } as never,
            callerScopes,
          ),
        { 'multi_hop.final_set': finalHits.length },
      );
      result.synthesis = {
        answer: synth.answer,
        reason: synth.reason,
        citations: synth.citations,
      };
    }

    return result;
  }

  /**
   * Run one hop. Honours the hop's local predicate / asOf overrides
   * and, when combination=subset_of_previous, anchors to the running
   * entity set via SearchDto.entityIds (pushed into WHERE).
   */
  private async runHop(
    companyId: string,
    dto: MultiHopDto,
    callerScopes: string[],
    hop: HopPlan,
    priorEntityIds: string[],
  ): Promise<{ hits: SearchHit[] }> {
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
  private combine(
    combination: HopPlan['combination'],
    priorIds: string[],
    hopIds: string[],
    priorByEntity: Map<string, SearchHit>,
    hopHits: SearchHit[],
  ): { ids: string[]; byEntity: Map<string, SearchHit> } {
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
