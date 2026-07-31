/**
 * Shared decline-detection for abstention subsets (LongMemEval `_abs`,
 * BEAM `abstention`): correct behavior is refusing to invent an answer.
 * Kept as one regex so both axes score abstention identically.
 *
 * MUST cover the brain's own guardrail sentinel ("I don't have grounded
 * evidence for that") — its omission undercounted LME abstention as
 * 2/18 when the true rate was 17/18 (live-data finding, 2026-07-31).
 * Mirrors the LoCoMo isAbstention() coverage.
 */
export const ABSTAIN_RE =
  /no (information|memory|data|record)|not (mentioned|available|enough)|(do not|don't) (know|have)|cannot (determine|find|answer)|unable to|grounded evidence/i;
