/**
 * The mark a transcript line carries when its turn is remembered but not
 * yet read by the extraction (episode-lane.service.ts pendingTurns). The
 * generator and the verifier both read it: such a line is newer than
 * every fact in the prompt.
 */
export const PENDING_MARK = 'just said, not yet filed';
