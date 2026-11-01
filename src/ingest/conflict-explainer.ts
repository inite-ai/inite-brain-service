/**
 * Conflict explainer — turns a `fn::resolve_fact` SUPERSEDED/COMPETING
 * outcome into a deterministic one-line narrative of the rule that
 * decided it.
 *
 * Since #830 (migration 0177) write time decides only by valid time: a
 * value that starts later closes the earlier values of its slot
 * (`valid_time`), and a `bitemporal_event` value on the same day as
 * another is kept as a dispute (`event_day`). There is no weighted score,
 * so there is no breakdown or dominant dimension to report. What two
 * values of one slot at the same moment are to each other is decided
 * later by fact resolution (#828), not here.
 *
 * Pure module — no DI, no IO. The ingest service calls
 * `buildConflictExplanation()` after the resolver returns and attaches
 * the result to `IngestResult.conflictExplanation` when the caller
 * requested `explain: true`.
 */

export type ConflictOutcome = 'SUPERSEDED' | 'COMPETING';

/** The deterministic rule that decided the write (0177 conflictTrace.decidedBy). */
export type ConflictRule = 'valid_time' | 'event_day';

export interface ConflictExplanation {
  outcome: ConflictOutcome;
  winnerFactId: string;
  bestOpponentFactId: string;
  /** All other facts closed (SUPERSEDED) or disputed (COMPETING) by the write. */
  otherLoserFactIds: string[];
  decidedBy: ConflictRule;
  /** Single-sentence template explanation suitable for surfacing to a user. */
  narrativeBullet: string;
}

/** The fields of fn::resolve_fact's result (0177) this module reads. */
export interface ResolverConflictPayload {
  outcome: ConflictOutcome;
  factId: string;
  bestOpponentId: string;
  supersededFactIds?: string[] | undefined;
  competingFactIds?: string[] | undefined;
}

export function buildConflictExplanation(payload: ResolverConflictPayload): ConflictExplanation {
  const all =
    payload.outcome === 'SUPERSEDED'
      ? (payload.supersededFactIds ?? [])
      : (payload.competingFactIds ?? []);
  const decidedBy: ConflictRule = payload.outcome === 'SUPERSEDED' ? 'valid_time' : 'event_day';
  const n = Math.max(all.length, 1);
  const values = n === 1 ? 'the value' : `${n} values`;
  return {
    outcome: payload.outcome,
    winnerFactId: payload.factId,
    bestOpponentFactId: payload.bestOpponentId,
    otherLoserFactIds: all.filter((id) => id !== payload.bestOpponentId),
    decidedBy,
    narrativeBullet:
      decidedBy === 'valid_time'
        ? `New fact starts after ${values} of this slot it overlaps; ${n === 1 ? 'it ends' : 'they end'} where the new one begins.`
        : `New fact holds on the same day as ${values} of this slot; both are kept as a dispute.`,
  };
}
