import { z } from 'zod';
import { EVIDENCE_CAPABILITIES } from '../../common/evidence-taxonomy';
import { SearchHitSchema, SearchRequestSchema } from '../search/search.schema';

/**
 * Wire contracts for POST /v1/synthesize — corrective-RAG over the
 * retrieved facts, with a verifier gate.
 *
 * Request mirrors SynthesizeDto (which extends SearchDto); response
 * mirrors SynthesizeResult (src/synthesize/synthesize.types.ts). Parity
 * is pinned by test/contracts-synthesize.unit-spec.ts.
 */

export const SYNTHESIS_GUARDRAILS = ['strict', 'lenient', 'off', 'answer'] as const;

export const SynthesizeRequestSchema = SearchRequestSchema.extend({
  /** Override the generator model for this call. */
  synthesisModel: z.string().optional(),
  /**
   * `strict` closes to a null answer on a partial verdict; `lenient`
   * returns the answer with the verdict attached; `off` skips the
   * verifier; `answer` is the answer-shaped router lane.
   */
  synthesisGuardrails: z.enum(SYNTHESIS_GUARDRAILS).optional(),
  /** Emit `decisionLog` — one entry per retrieved fact. */
  explain: z.boolean().optional(),
  /** Preferred answer language (free-text hint; not format-validated). */
  answerLang: z.string().optional(),
});

/** Prompt/completion cost of one LLM call, surfaced for token accounting. */
export const TokenUsageSchema = z.object({
  promptTokens: z.number(),
  completionTokens: z.number(),
});

/** A claim's reference to the fact it rests on. */
export const CitationSchema = z.object({
  factId: z.string(),
  entityId: z.string(),
  canonicalName: z.string(),
  predicate: z.string(),
  object: z.string(),
  /** Write-time sourceKey (trustSnapshot) — absent on pre-0044 facts. */
  sourceKey: z.string().optional(),
});

/** Why the pipeline declined to answer (absent on a served answer). */
export const SynthesisReasonSchema = z.enum([
  'no_results',
  'no_grounded_evidence',
  'low_coverage',
  /** A supported answer cites a predicate needing non-text evidence it lacks (0113). */
  'evidence_capability_unmet',
  /** Every cited fact carries groundingStatus='ungrounded' (0115). */
  'ungrounded_evidence',
  'verifier_failed',
  'verifier_partial',
  'generator_error',
  'verifier_error',
]);

/**
 * Non-fact evidence citation. Four arms behind a ONE-OF invariant —
 * episode (transcript), fragment (media), belief (current state) and
 * scene (episodic gist); exactly one id field is present.
 */
export const EvidenceCitationSchema = z.object({
  episodeId: z.string().optional(),
  conversationId: z.string().optional(),
  occurredAt: z.string().optional(),
  /**
   * W3C-style VERIFIED span over the NFC-normalized stored turn text,
   * in Unicode code points: `start` inclusive, `end` exclusive, `exact`
   * the verbatim quote. Absent = episodeId-only (never a guessed highlight).
   */
  span: z.object({ start: z.number(), end: z.number(), exact: z.string() }).optional(),
  fragmentId: z.string().optional(),
  assetId: z.string().optional(),
  capability: z.enum(EVIDENCE_CAPABILITIES).optional(),
  /** The RENDERED excerpt the generator actually saw — never generator-authored. */
  excerpt: z.string().optional(),
  beliefId: z.string().optional(),
  sceneId: z.string().optional(),
});

/**
 * Per-fact retrieval + verdict trace. Deliberately NOT field-level
 * contracted (the `breakdown` / `conflictExplanation` rule): an
 * `explain`-mode DEBUG payload over pipeline internals
 * (src/synthesize/decision-log.ts).
 */
export const DecisionLogEntrySchema = z.record(z.string(), z.unknown());

export const SynthesizeResponseSchema = z.object({
  /** null when the pipeline abstained — `reason` says why. */
  answer: z.string().nullable(),
  reason: SynthesisReasonSchema.optional(),
  citations: z.array(CitationSchema),
  results: z.array(SearchHitSchema),
  /** Episode/fragment/belief/scene refs for an L3-escalated answer. */
  evidenceCitations: z.array(EvidenceCitationSchema).optional(),
  decisionLog: z.array(DecisionLogEntrySchema).optional(),
  tokenUsage: TokenUsageSchema.optional(),
  /**
   * Served from the fact-lifecycle-gated answer cache
   * (SYNTHESIZE_ANSWER_CACHE): citations were re-validated against the
   * live rows, and `results` is empty because retrieval never ran.
   */
  cached: z.boolean().optional(),
});

export type SynthesizeRequest = z.infer<typeof SynthesizeRequestSchema>;
export type SynthesizeResponse = z.infer<typeof SynthesizeResponseSchema>;
