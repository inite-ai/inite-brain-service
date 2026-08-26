/**
 * Shared compaction types + DI token. Lives in its own module so the
 * runner, queue, and orchestrator services can all import them without a
 * circular dependency (compaction.service.ts re-exports the public ones
 * for backward compatibility).
 */

export const SUMMARY_GENERATOR = Symbol('SUMMARY_GENERATOR');

export interface CompactionStats {
  companyId: string;
  factsCompacted: number;
  summariesCreated: number;
  bytesFreed: number;
  /** Episodic→semantic promotion leg (COMPACTION_PROMOTION_ENABLED). */
  factsPromoted?: number;
  groupsPromoted?: number;
}

export interface CandidateFactRow {
  id: unknown;
  entityId: unknown;
  predicate: string;
  object: string;
  validFrom: string;
  validUntil?: string | null;
  confidence: number;
  /** Per-user scope (0055); NONE/undefined = tenant-global. */
  userId?: string | null;
  /** `source.episodeIds AS eps` — grounding stamp of the member (FLEXIBLE). */
  eps?: unknown;
}
