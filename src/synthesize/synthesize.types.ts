import type { SearchHit } from '../search/search.service';
import type { EvidenceCapability } from '../common/evidence-taxonomy';
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
 * Fact citations and episode spans are text; a FRAGMENT citation
 * (EVIDENCE_FRAGMENT_CITATIONS, MM-zoom PR2) carries the capability of
 * its asset's modality (capabilityForModality), so a non-text
 * requirement can now be satisfied by a matching-modality fragment.
 * Canonical union: src/common/evidence-taxonomy.ts (re-exported here so
 * the existing verdict-gate consumers keep their import path).
 */
export type { EvidenceCapability } from '../common/evidence-taxonomy';

/** Prompt/completion cost of one LLM call, surfaced for token accounting. */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

/**
 * Non-fact evidence citation — a claim's reference to the stored
 * observation it came from. TWO arms behind a ONE-OF invariant
 * (exactly one of `episodeId` / `fragmentId` is present; resolvers
 * construct only well-formed arms, never both, never neither):
 *
 *  - EPISODE arm (FOVEA_L3_EPISODE_CITATIONS): a transcript-grounded
 *    claim's reference to the stored episode turn. `span`, when present,
 *    is a W3C-style VERIFIED span over the NFC-normalized STORED turn
 *    text, measured in Unicode code points — the span-anchor contract
 *    (src/admin/span-anchor.ts): `start` inclusive, `end` exclusive,
 *    `exact` the verified verbatim quote. An absent span = episodeId-only
 *    citation (fail-safe, never a guessed highlight).
 *
 *  - FRAGMENT arm (EVIDENCE_FRAGMENT_CITATIONS, MM-zoom PR2): a
 *    media-grounded claim's reference to an evidence_fragment (0109).
 *    `assetId` is the fragment's parent asset; `capability` the kind of
 *    evidence the citation carries (capabilityForModality over the
 *    asset's modality — how the 0113 verdict gate can be SATISFIED for
 *    non-text); `excerpt` is the RENDERED derived-representation excerpt
 *    the generator actually saw (the rendered-set fence of
 *    resolveFragmentCitations — never generator-authored text).
 *
 * Widened ADDITIVELY from the episode-only shape: every pre-existing
 * consumer reads `episodeId?`/`span?` and is untouched by absent
 * fragment fields.
 */
export interface EvidenceCitation {
  episodeId?: string;
  conversationId?: string;
  occurredAt?: string;
  span?: { start: number; end: number; exact: string };
  fragmentId?: string;
  assetId?: string;
  capability?: EvidenceCapability;
  excerpt?: string;
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
  /**
   * Fragment citations (EVIDENCE_FRAGMENT_CITATIONS, MM-zoom PR2): the
   * fragment ids the generator grounds media-derived claims on, echoed
   * from the rendered `[evidence_fragment:...]` headers. Only present
   * when the call was made with the fragment-citation affordance;
   * resolved defensively via resolveFragmentCitations — never trusted.
   */
  citedFragmentIds?: string[];
  /** Generator-call usage, when the provider reported it. */
  usage?: TokenUsage;
}
