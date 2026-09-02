import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { SurrealService } from '../db/surreal.service';
import { ApiKeyService } from '../auth/api-key.service';
import {
  outcomeDecisionCaptureEnabled,
  outcomeDecisionRetentionDays,
  outcomeEventRetentionDays,
  outcomeTelemetryEnabled,
} from '../common/outcome-flags';
import {
  toolObservationRetentionDays,
  toolObservationsEnabled,
} from '../common/tool-observation-flags';

/**
 * One bounded prune batch: delete the oldest raw rows past the cutoff,
 * ≤ 5000 per round so a long-unpruned tenant never builds one huge
 * write transaction. RETURN BEFORE hands back the deleted rows, so the
 * loop can tell a full batch (go again) from the final partial one.
 * Exported for the query-shape unit spec.
 */
export const OUTCOME_PRUNE_BATCH_QUERY = `DELETE (SELECT id FROM memory_outcome WHERE createdAt < $cutoff LIMIT 5000) RETURN BEFORE`;

/**
 * Same bounded SELECT-ids → DELETE shape for the tool_observation raw
 * log (migration 0111) — its own retention window
 * (TOOL_OBSERVATION_RETENTION_DAYS), same 03:41 cron, shared in-flight
 * guard. Exported for the query-shape unit spec.
 */
export const TOOL_OBSERVATION_PRUNE_BATCH_QUERY = `DELETE (SELECT id FROM tool_observation WHERE createdAt < $cutoff LIMIT 5000) RETURN BEFORE`;

/**
 * Same bounded SELECT-ids → DELETE shape for the memory_decision rows
 * (migration 0119) — its own retention window
 * (OUTCOME_DECISION_RETENTION_DAYS), same 03:41 cron, shared in-flight
 * guard, gated on OUTCOME_DECISION_CAPTURE. Exported for the
 * query-shape unit spec.
 */
export const DECISION_PRUNE_BATCH_QUERY = `DELETE (SELECT id FROM memory_decision WHERE createdAt < $cutoff LIMIT 5000) RETURN BEFORE`;

/**
 * OutcomePruneService — retention for the RAW outcome event log
 * (memory_outcome, migration 0107). The rollup (memory_outcome_stat) is
 * deliberately never pruned: it is the compact per-subject currency that
 * SURVIVES raw retention — that asymmetry is why the rollup is a
 * write-path table and not a 0088 computed view (see the 0107 header).
 *
 * Nightly at 03:41 UTC — offset from the 03:xx cron neighbourhood
 * (compaction 03:17, memory-quality 03:35, calibration refit 03:42) —
 * gated on the master flag, with an in-flight guard so an overlapping
 * tick never doubles the work. Tenant roster comes from
 * ApiKeyService.knownCompanyIds(), the same way the compaction cron
 * enumerates tenants.
 */
@Injectable()
export class OutcomePruneService {
  private readonly logger = new Logger(OutcomePruneService.name);
  private running = false;

  constructor(
    private readonly surreal: SurrealService,
    private readonly apiKeys: ApiKeyService,
  ) {}

  @Cron('41 3 * * *', { timeZone: 'UTC' })
  async runNightly(): Promise<{ tenants: number; pruned: number }> {
    // Three independently-flagged legs share the tick + in-flight guard:
    // memory_outcome (0107, OUTCOME_TELEMETRY_ENABLED), tool_observation
    // (0111, TOOL_OBSERVATIONS_ENABLED) and memory_decision (0119,
    // OUTCOME_DECISION_CAPTURE).
    const outcomeLeg = outcomeTelemetryEnabled();
    const observationLeg = toolObservationsEnabled();
    const decisionLeg = outcomeDecisionCaptureEnabled();
    if (!outcomeLeg && !observationLeg && !decisionLeg) return { tenants: 0, pruned: 0 };
    if (this.running) {
      this.logger.warn('outcome prune still running — skipping this tick');
      return { tenants: 0, pruned: 0 };
    }
    this.running = true;
    try {
      const tenants = this.apiKeys.knownCompanyIds();
      let pruned = 0;
      for (const companyId of tenants) {
        try {
          if (outcomeLeg) pruned += await this.pruneTenant(companyId);
          if (observationLeg) pruned += await this.pruneToolObservations(companyId);
          if (decisionLeg) pruned += await this.pruneDecisions(companyId);
        } catch (e) {
          this.logger.warn(`outcome prune for ${companyId} failed: ${(e as Error).message}`);
        }
      }
      this.logger.log(`outcome prune: ${pruned} row(s) across ${tenants.length} tenant(s)`);
      return { tenants: tenants.length, pruned };
    } finally {
      this.running = false;
    }
  }

  /** Batched delete-until-empty of raw rows older than the retention window. */
  async pruneTenant(companyId: string): Promise<number> {
    const cutoff = new Date(Date.now() - outcomeEventRetentionDays() * 86_400_000);
    return this.drain(companyId, OUTCOME_PRUNE_BATCH_QUERY, cutoff);
  }

  /** Same drain for the tool_observation raw log (0111). */
  async pruneToolObservations(companyId: string): Promise<number> {
    const cutoff = new Date(Date.now() - toolObservationRetentionDays() * 86_400_000);
    return this.drain(companyId, TOOL_OBSERVATION_PRUNE_BATCH_QUERY, cutoff);
  }

  /** Same drain for the memory_decision rows (0119). */
  async pruneDecisions(companyId: string): Promise<number> {
    const cutoff = new Date(Date.now() - outcomeDecisionRetentionDays() * 86_400_000);
    return this.drain(companyId, DECISION_PRUNE_BATCH_QUERY, cutoff);
  }

  private async drain(companyId: string, query: string, cutoff: Date): Promise<number> {
    return this.surreal.withCompany(companyId, async (db) => {
      let total = 0;
      for (;;) {
        const [batch] = await db.query<[unknown[]]>(query, { cutoff });
        const n = ((batch as unknown[]) ?? []).length;
        total += n;
        // A partial batch means the cutoff range is drained.
        if (n < 5000) break;
      }
      return total;
    });
  }
}
