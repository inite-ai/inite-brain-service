import type { SearchHit } from '../search/search.service';
import type { DecisionLogEntry } from './decision-log';
import type { Citation } from './fact-index';

/**
 * Public result/IO types of the synthesize pipeline. Split out of
 * synthesize.service.ts so that pure helper modules
 * (synthesize.helpers.ts) depend on a types module instead of
 * type-importing back into the service they serve — the service
 * re-exports these for its existing consumers (multi-hop, MCP), so no
 * call site changes.
 */

export type SynthesisReason =
  | 'no_results'
  | 'no_grounded_evidence'
  /** V9 §4: the memory-coverage abstention path fired. */
  | 'low_coverage'
  | 'verifier_failed'
  | 'verifier_partial'
  | 'generator_error'
  | 'verifier_error';

/** Prompt/completion cost of one LLM call, surfaced for token accounting. */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface SynthesizeResult {
  answer: string | null;
  reason?: SynthesisReason;
  citations: Citation[];
  results: SearchHit[];
  /**
   * Populated only when the request was made with `explain: true`. One
   * entry per retrieved fact, with score breakdown, retrieval-stage
   * provenance, and a picked/rejected verdict with a deterministic
   * rejection reason. See `decision-log.ts`.
   */
  decisionLog?: DecisionLogEntry[];
  /**
   * Generator-call token cost. The context-minimization axis is only
   * manageable if every leg reports it — evidence budgets that grow
   * silently (facts, segments, unions) show up here first.
   */
  tokenUsage?: TokenUsage;
  /**
   * G1 answer cache: true when this result was served from the
   * fact-lifecycle-gated answer cache (SYNTHESIZE_ANSWER_CACHE) —
   * citations were re-validated against the live fact rows at serve
   * time; `results` is empty because retrieval never ran. Absent on
   * every freshly synthesized answer.
   */
  cached?: boolean;
}

/** The generator call's parsed output (strict-JSON schema shape). */
export interface GeneratorOutput {
  answer: string;
  citedFactIds: string[];
  /**
   * V13 constrained search loop (profile.searchLoop): the generator's
   * one refine request — a better retrieval query when the evidence
   * does not contain the asked detail. Only present when the call was
   * made with the refine affordance; null/absent = no request.
   */
  refineQuery?: string | null;
  /** Generator-call usage, when the provider reported it. */
  usage?: TokenUsage;
}
