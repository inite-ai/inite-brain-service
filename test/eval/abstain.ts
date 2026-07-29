/**
 * Shared decline-detection for abstention subsets (LongMemEval `_abs`,
 * BEAM `abstention`): correct behavior is refusing to invent an answer.
 * Kept as one regex so both axes score abstention identically.
 */
export const ABSTAIN_RE =
  /no (information|memory|data|record)|not (mentioned|available|enough)|(do not|don't) know|cannot (determine|find|answer)|unable to/i;
