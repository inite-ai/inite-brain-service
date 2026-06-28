import type { ConflictExplanation } from './conflict-explainer';

export type IngestOutcome =
  | 'INSERTED'
  | 'SUPERSEDED'
  | 'COMPETING'
  | 'REJECTED';

export interface IngestResult {
  factId: string | null;
  outcome: IngestOutcome;
  supersededFactIds?: string[];
  competingFactIds?: string[];
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
