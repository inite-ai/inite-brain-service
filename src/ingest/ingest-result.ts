import type { ConflictExplanation } from './conflict-explainer';

export type IngestOutcome =
  | 'INSERTED'
  /**
   * Backdated single_active insert: an active fact with a NEWER validFrom
   * already existed, so the incoming fact was recorded as an
   * already-superseded historical row (slotted before the next-newer
   * decision) and displaced nothing. See migration 0043.
   */
  | 'INSERTED_HISTORICAL'
  | 'SUPERSEDED'
  | 'COMPETING'
  | 'REJECTED';

export interface IngestResult {
  factId: string | null;
  outcome: IngestOutcome;
  supersededFactIds?: string[];
  competingFactIds?: string[];
  /**
   * INSERTED_HISTORICAL only: the already-standing newer fact that the
   * backdated insert was slotted behind (its validFrom closed the new
   * row's interval).
   */
  supersededByFactId?: string;
  reason?: string;
  /**
   * Populated only when the IngestFactDto carried `explain: true` AND
   * the outcome is SUPERSEDED or COMPETING. Carries the TruthfulRAG-
   * style slot delta + dominant dimension + score breakdown explaining
   * why the new fact beat (or competes with) the strongest prior.
   *
   * See `conflict-explainer.ts` for the shape and the deterministic
   * narrative template.
   */
  conflictExplanation?: ConflictExplanation;
}
