import { Injectable } from '@nestjs/common';
import {
  MultiHopPlan,
  MultiHopPlannerService,
} from './multi-hop-planner.service';
import { MultiHopChainService } from './multi-hop-chain.service';
import { withSpan } from '../common/tracing';
import { NOOP_REPORTER } from '../mcp/progress-reporter';
import { MultiHopResult, MultiHopRunOptions } from './multi-hop.types';

export type { HopOutcome, MultiHopResult, MultiHopRunOptions } from './multi-hop.types';

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
 *
 * This class is the planning half — it produces the plan and delegates
 * the whole execution (hops, combination, synthesis, metrics) to
 * MultiHopChainService.
 */
@Injectable()
export class MultiHopService {
  constructor(
    private readonly planner: MultiHopPlannerService,
    private readonly chain: MultiHopChainService,
  ) {}

  async run({
    companyId,
    dto,
    callerScopes,
    onProgress = NOOP_REPORTER,
  }: MultiHopRunOptions): Promise<MultiHopResult> {
    const maxHops = Math.min(dto.maxHops ?? 3, 5);

    onProgress({ stage: 'planning', message: 'planner-LLM decomposing query' });
    const plan: MultiHopPlan | null = await withSpan(
      'multi_hop.plan',
      () => this.planner.plan(dto.query, maxHops),
      { 'multi_hop.maxHops': maxHops },
    );

    return this.chain.execute({ companyId, dto, callerScopes, onProgress, plan });
  }
}
