import { envFlagEnabled } from './env-validation';

/**
 * Fovea optics (Optics-1) master flag — FOVEA_FOCUS_CAPTURE.
 *
 * The env read lives here in the common layer, NOT inside the engine dirs
 * (src/synthesize/ takes resolved config only — engine-gates S5.2). It is
 * consumed by the synthesize focus-signal capture path and the admin
 * fit/measure surface. Read at call time so a flip is runtime-mutable (no
 * restart). Default off → serving-neutral: the capture is a guarded no-op
 * and the admin routes 404.
 */
export function focusCaptureEnabled(): boolean {
  return envFlagEnabled(process.env.FOVEA_FOCUS_CAPTURE);
}

/** Default escalate cutoff on calibrated confidence (Optics-2 §4.1). */
const DEFAULT_ADAPTIVE_L3_THRESHOLD = 0.5;

/**
 * Fovea optics (Optics-2) master flag — FOVEA_ADAPTIVE_L3.
 *
 * When on AND a usable per-class calibration model is loaded, the L3
 * escalation trigger + session-count become adaptive to the calibrated
 * focus confidence (docs/roadmap/fovea-optics-2026-08.md §4.1). The env
 * read lives here in the common layer, NOT inside the engine dirs
 * (engine-gates S5.2). Read at call time so a flip is runtime-mutable.
 * Default off, AND with no calibration model present the serving path is
 * byte-identical to the static L3 — the load-bearing safety property.
 */
export function adaptiveL3Enabled(): boolean {
  return envFlagEnabled(process.env.FOVEA_ADAPTIVE_L3);
}

/**
 * Optics-2 escalate threshold (FOVEA_ADAPTIVE_L3_THRESHOLD): escalate to
 * L3 when calibrated confidence < this value, and scale #sessions ∝ the
 * deficit below it. A non-boolean knob resolved here in the common layer
 * so the engine dirs take a resolved number. Must be in (0,1]; unset,
 * blank, or out of range → the 0.5 default.
 */
export function adaptiveL3EscalateThreshold(): number {
  const raw = process.env.FOVEA_ADAPTIVE_L3_THRESHOLD;
  if (raw === undefined || raw.trim() === '') return DEFAULT_ADAPTIVE_L3_THRESHOLD;
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : DEFAULT_ADAPTIVE_L3_THRESHOLD;
}

/** Default abstain cutoff on calibrated (pre-answer) confidence (Optics §4.2). */
const DEFAULT_ADAPTIVE_ABSTAIN_THRESHOLD = 0.5;

/**
 * Fovea optics (Optics §4.2) master flag — FOVEA_ADAPTIVE_ABSTAIN.
 *
 * When on AND a usable per-class PRE-ANSWER calibration model is loaded, the
 * pre-generation memory-coverage abstention decision
 * (verdict.ts:coverageAbstention) becomes adaptive to the calibrated focus
 * confidence — abstain when confidence < threshold — replacing the static
 * coverage floor (docs/roadmap/fovea-optics-2026-08.md §4.2). The env read
 * lives here in the common layer, NOT inside the engine dirs (engine-gates
 * S5.2). Read at call time so a flip is runtime-mutable. Default off, AND
 * with no usable pre-answer model the serving path is byte-identical to the
 * static coverage abstention — the load-bearing safety property.
 */
export function adaptiveAbstainEnabled(): boolean {
  return envFlagEnabled(process.env.FOVEA_ADAPTIVE_ABSTAIN);
}

/**
 * Optics §4.2 abstain threshold (FOVEA_ADAPTIVE_ABSTAIN_THRESHOLD): abstain
 * (return NOT_IN_MEMORY) when the calibrated pre-answer confidence < this
 * value. A non-boolean knob resolved here in the common layer so the engine
 * dirs take a resolved number. Must be in (0,1]; unset, blank, or out of
 * range → the 0.5 default.
 */
export function adaptiveAbstainThreshold(): number {
  const raw = process.env.FOVEA_ADAPTIVE_ABSTAIN_THRESHOLD;
  if (raw === undefined || raw.trim() === '') return DEFAULT_ADAPTIVE_ABSTAIN_THRESHOLD;
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : DEFAULT_ADAPTIVE_ABSTAIN_THRESHOLD;
}

/** Default nearest-centroid cosine floor for lens suppression (Optics §4.3). */
const DEFAULT_LENS_SUPPRESS_MIN_COSINE = 0.5;

/**
 * Fovea optics (Optics §4.3) master flag — FOVEA_LENS_SUPPRESS.
 *
 * When on AND a usable per-class suppression model is loaded, the
 * lens-suppression governor SUBTRACTS off-task / trap-inducing lanes from a
 * query's effective active lane set BEFORE retrieval and before the
 * answer-cache key is computed (docs/roadmap/fovea-optics-2026-08.md §4.3).
 * Subtractive only — it can never add a lane or reorder. The env read lives
 * here in the common layer, NOT inside the engine dirs (engine-gates S5.2).
 * Read at call time so a flip is runtime-mutable. Default off, AND with no
 * usable model — or a low-confidence class match — routing is byte-identical
 * to the static lane set (the load-bearing safety property).
 */
export function lensSuppressEnabled(): boolean {
  return envFlagEnabled(process.env.FOVEA_LENS_SUPPRESS);
}

/**
 * Optics §4.3 confidence floor (FOVEA_LENS_SUPPRESS_MIN_COSINE): suppress
 * lanes only when the nearest class centroid's cosine similarity to the query
 * embedding is ≥ this value; below it the class match is uncertain and the
 * lane set is left unchanged. A non-boolean knob resolved here in the common
 * layer so the engine dirs take a resolved number. Cosine lives in [-1,1], so
 * the full range is accepted; unset, blank, or out of range → the 0.5 default.
 */
export function lensSuppressMinCosine(): number {
  const raw = process.env.FOVEA_LENS_SUPPRESS_MIN_COSINE;
  if (raw === undefined || raw.trim() === '') return DEFAULT_LENS_SUPPRESS_MIN_COSINE;
  const v = Number(raw);
  return Number.isFinite(v) && v >= -1 && v <= 1 ? v : DEFAULT_LENS_SUPPRESS_MIN_COSINE;
}

/**
 * Fovea optics — verifier answer-integrity arm, Part A master flag —
 * FOVEA_PLAUSIBILITY_CHECK.
 *
 * The verifier audits GROUNDING (answer ⊆ cited evidence), never TRUTH. The
 * MemTrapBench trap shakedown's key finding: a cited counterfactual / sandbox
 * premise makes a distorted answer verify as `supported` (belief distortion,
 * docs/roadmap/memtrap-shakedown-2026-08.md class 4). When this flag is on, a
 * `supported` verdict triggers ONE extra LLM plausibility judge over the CITED
 * premises — does the premise contradict general world knowledge, or is it a
 * counterfactual/sandbox premise applied out of its original context — and an
 * implausible verdict DOWNGRADES the answer to an abstain (NOT_IN_MEMORY /
 * low_coverage). The env read lives here in the common layer, NOT inside the
 * engine dirs (engine-gates S5.2). Read at call time so a flip is
 * runtime-mutable. Default off ⇒ NO extra LLM call, serving byte-identical.
 */
export function plausibilityCheckEnabled(): boolean {
  return envFlagEnabled(process.env.FOVEA_PLAUSIBILITY_CHECK);
}

/**
 * Fovea optics — verifier answer-integrity arm, Part C master flag —
 * FOVEA_REQUIRE_CITATIONS.
 *
 * Audit F2(b): the verdict.ts supported branch serves `{answer, citations,
 * results}` with WHATEVER citations were passed, EMPTY INCLUDED, so a
 * `supported` answer with zero citations can serve and break the
 * citation-bearing promise. When this flag is on, a `supported` verdict whose
 * answer carries ZERO citations is treated as low_coverage/abstain instead of
 * emitting an uncited "supported" answer. This is a LIVE-behavior change when
 * enabled — hence default off, so prod answers don't shift until the owner
 * enables + validates. The env read lives here in the common layer, NOT inside
 * the engine dirs (engine-gates S5.2). Read at call time so a flip is
 * runtime-mutable. Default off ⇒ today's behavior byte-identical.
 */
export function requireCitationsEnabled(): boolean {
  return envFlagEnabled(process.env.FOVEA_REQUIRE_CITATIONS);
}

/**
 * Fovea serving-integrity family — L3 evidence citations master flag —
 * FOVEA_L3_EPISODE_CITATIONS.
 *
 * WHAT IT CHANGES: closes the L3 citation exemption ("Claims taken from the
 * raw transcript need no citation", L3_SYSTEM rule 2). When on, the L3
 * escalation transcript renders per-turn `[episode:<id>]` headers, the
 * generator must cite each transcript-grounded claim as an {episodeId, quote}
 * pair (citedEpisodes, added to the strict JSON schema), and the service
 * resolves those into span-verified EvidenceCitations over the STORED turn
 * text (anchorQuote: NFC, code points, fail-safe episodeId-only) — every
 * served claim becomes unrollable to an observation. Only turns actually
 * rendered into the transcript are citable: an unknown episodeId is dropped,
 * so an L3 citation can never name an episode the caller couldn't read.
 *
 * VERDICT INTERACTION: changes the FOVEA_REQUIRE_CITATIONS contract — the
 * zero-citation guard in verdict.ts counts evidence citations too, so an L3
 * answer carrying zero fact citations but ≥1 evidence citation SERVES under
 * require-citations instead of abstaining. The answer cache is deliberately
 * unchanged: an episode-only-cited answer still has citations.length 0 and
 * is never admitted (check-on-read cannot invalidate episode citations yet).
 *
 * SAFETY: the env read lives here in the common layer, NOT inside the engine
 * dirs (engine-gates S5.2). Read at call time so a flip is runtime-mutable.
 * Default off ⇒ the L3 prompt, JSON schema, and transcript lines are
 * byte-identical to before and no evidenceCitations field is ever emitted.
 */
export function l3EpisodeCitationsEnabled(): boolean {
  return envFlagEnabled(process.env.FOVEA_L3_EPISODE_CITATIONS);
}

/**
 * Fovea serving-integrity family — evidence-capability gate master flag —
 * FOVEA_EVIDENCE_CAPABILITY.
 *
 * WHAT IT CHANGES: closes the modality gap in the verifier's supported
 * serve. A predicate can declare (0113 knowledge_predicate column
 * `requiredEvidenceCapability`, threaded through PredicatePolicy) that its
 * claims verify only against non-text evidence — a whiteboard photo, a call
 * recording, a contract region. When on, the finalizeAndAdmit gate-resolution
 * (resolveEvidenceCapability, beside resolveAnswerIntegrity) computes the
 * required capability over a `supported` answer's cited facts (max over
 * citations — any non-text requirement wins) and DOWNGRADES the answer to an
 * abstain (reason 'evidence_capability_unmet') unless cited evidence of that
 * capability exists.
 *
 * HONEST v1 BOUND: no media verifier exists yet — every citation today is
 * text (fact lines + L3 episode spans), so the cited-capability set is
 * always {'text'} and the check can only ABSTAIN (required non-text) or PASS
 * (required text). It is fail-closed plumbing: claims requiring visual/audio
 * evidence can no longer verify on text alone; CONFIRMATION of such claims
 * arrives with the media verifiers (the M-track fragment mapping populates
 * per-citation capabilities and VerifyRequest.capabilityEvidenceLines).
 *
 * SAFETY: the env read lives here in the common layer, NOT inside the engine
 * dirs (engine-gates S5.2). Read at call time so a flip is runtime-mutable.
 * Default off ⇒ the resolver returns {} — no registry lookup, no verdict
 * param — serving byte-identical (the answer-integrity precedent).
 */
export function evidenceCapabilityEnabled(): boolean {
  return envFlagEnabled(process.env.FOVEA_EVIDENCE_CAPABILITY);
}

/**
 * Fovea optics — attention-hints anchor boost master flag —
 * FOVEA_ATTENTION_HINTS.
 *
 * When on, the L3 escalation anchor ranking consults the installed domain
 * packs' memoryModel.attentionHints: when the query contains a hint's
 * literal cue (case-folded), anchors whose originating fact carries one of
 * the hint's preferred predicates get their normalized score multiplied by
 * a boost clamped to [1,2] (resolveAttentionHintBoost → mergeAnchorSources).
 * Ordering-only by construction — density stays the primary rank key, no
 * anchor is ever added or dropped — and the memory-model reader is
 * consulted lazily, only on a fired escalation with fact anchors. The env
 * read lives here in the common layer, NOT inside the engine dirs
 * (engine-gates S5.2). Read at call time so a flip is runtime-mutable.
 * Default off ⇒ the reader is never consulted and anchor ranking is
 * byte-identical to the hint-free path.
 */
export function attentionHintsEnabled(): boolean {
  return envFlagEnabled(process.env.FOVEA_ATTENTION_HINTS);
}

/**
 * Multilingual Tier 5 master flag — MULTILINGUAL_CALIBRATION.
 *
 * When on, the §4.2 per-class focus calibrator (focus-signal.ts) gains a
 * hierarchical LANGUAGE key: it fits + applies (class × language) →
 * (class × script/family) → (class) → 'default' maps, and the focus-signal
 * capture path records the detected query language/script on each sample
 * (migration 0103 columns). The env read lives here in the common layer,
 * NOT inside the engine dirs (engine-gates S5.2), and is read at fit / load
 * time so a flip is runtime-mutable. Default off ⇒ the language dimension is
 * never written or consulted and the global per-class calibration is
 * BYTE-IDENTICAL to pre-Tier-5. Serving-neutral like the rest of the focus
 * surface (nothing on the answer path reads the calibration yet).
 */
export function multilingualCalibrationEnabled(): boolean {
  return envFlagEnabled(process.env.MULTILINGUAL_CALIBRATION);
}
