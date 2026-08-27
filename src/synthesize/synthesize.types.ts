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
  /**
   * Evidence-capability gate (FOVEA_EVIDENCE_CAPABILITY, 0113): a
   * `supported` answer cites a fact whose predicate REQUIRES a non-text
   * evidence capability, and no cited evidence of that capability
   * exists. A DISTINCT reason from 'low_coverage' on purpose: the
   * caller's remedy is different — "attach/verify the picture", not
   * "the memory doesn't know".
   */
  | 'evidence_capability_unmet'
  /**
   * Ungrounded-support gate (EVIDENCE_UNGROUNDED_SERVING_GATE, 0115): a
   * `supported` answer whose EVERY cited fact carries
   * groundingStatus='ungrounded' — the answer rests exclusively on claims
   * with no recorded observation behind them. A DISTINCT reason (the
   * evidence_capability_unmet idiom): the caller's remedy is "ground the
   * claims", not "the memory doesn't know". Mixed or legacy (absent
   * status) support serves.
   */
  | 'ungrounded_evidence'
  | 'verifier_failed'
  | 'verifier_partial'
  | 'generator_error'
  | 'verifier_error';

/**
 * Evidence-capability axis (0113): what KIND of evidence a claim can be
 * verified against. Per-predicate requirement source:
 * PredicatePolicy.requiredEvidenceCapability (absent = 'text' =
 * unconstrained). The verdict-side gate (FOVEA_EVIDENCE_CAPABILITY)
 * compares a supported answer's required capability — max over its cited
 * facts — against the capabilities its cited evidence actually carries.
 * Today every citation is text (facts + episode spans), so the check can
 * only abstain or pass — no media verifier exists yet (honest v1 bound;
 * the M-track fragment mapping adds non-text cited capabilities).
 */
export type EvidenceCapability = 'text' | 'visual' | 'audio' | 'document_region';

/** Prompt/completion cost of one LLM call, surfaced for token accounting. */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

/**
 * L3 evidence citation (FOVEA_L3_EPISODE_CITATIONS): a transcript-grounded
 * claim's reference to the stored episode turn it came from. `span`, when
 * present, is a W3C-style VERIFIED span over the NFC-normalized STORED turn
 * text, measured in Unicode code points — the span-anchor contract
 * (src/admin/span-anchor.ts): `start` inclusive, `end` exclusive, `exact`
 * the verified verbatim quote. An absent span = episodeId-only citation
 * (the quote was missing, absent from the turn, or ambiguous — fail-safe,
 * never a guessed highlight).
 */
export interface EvidenceCitation {
  episodeId: string;
  conversationId?: string;
  occurredAt?: string;
  span?: { start: number; end: number; exact: string };
}

export interface SynthesizeResult {
  answer: string | null;
  reason?: SynthesisReason;
  citations: Citation[];
  results: SearchHit[];
  /**
   * L3 evidence citations (FOVEA_L3_EPISODE_CITATIONS): episode-level
   * references for the transcript-grounded claims of an L3-escalated
   * answer. A SEPARATE array from `citations` — consumers of fact
   * citations (answer-cache admit, multi-hop, agent-qa) read `c.factId`
   * and must never see episode refs there. Present ONLY on a served L3
   * answer that resolved ≥1 evidence citation; absent otherwise (and
   * always absent when the flag is off).
   */
  evidenceCitations?: EvidenceCitation[];
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
