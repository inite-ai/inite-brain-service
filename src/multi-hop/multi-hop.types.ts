import { SearchHit } from '../search/search.service';
import { HopPlan } from './multi-hop-planner.service';
import { MultiHopDto } from './dto/multi-hop.dto';
import type { Citation, SynthesisReason } from '../synthesize/synthesize.service';
import type { ProgressReporter } from '../mcp/progress-reporter';

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

export interface MultiHopRunOptions {
  companyId: string;
  dto: MultiHopDto;
  callerScopes: string[];
  onProgress?: ProgressReporter;
}

/**
 * De-duped union of factIds across a hop's hits, preserving
 * original order so a downstream scorer can reason about ranking
 * if it cares to. Pure helper — shared by the single-hop and multi-
 * hop branches.
 */
export function collectFactIds(hits: SearchHit[]): string[] {
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
