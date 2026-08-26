import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { SurrealService, queryFirst, queryRows } from '../db/surreal.service';
import { ApiKeyService } from '../auth/api-key.service';
import { JobClaimService } from '../jobs/job-claim.service';
import { WorkerLoopService, JobContext } from '../jobs/worker-loop.service';
import { CandidateStoreService } from './candidate-store.service';
import { markFactsProvenancePurged, purgeDocumentChunks } from './document-purge.util';
import { idTailOf as idTail } from '../ingest/ingest-utils';
import { EvidenceStoreService } from '../evidence/evidence-store.service';

/** count()…GROUP ALL projection — `c` is the group count. */
interface CountRow {
  c?: number;
}

/**
 * Nightly hygiene for the Candidates layer — SurrealDB has no row TTL,
 * so a job owns the lifecycle tails:
 *
 *   * decided candidates (committed/merged/duplicate/rejected/expired)
 *     older than CANDIDATE_RETENTION_DAYS (30) are DELETED — their
 *     outcome lives on the committed fact's provenance;
 *   * pending candidates older than CANDIDATE_PENDING_TTL_DAYS (7) are
 *     marked 'expired' — a run that never got committed (crashed
 *     fan-out, abandoned async) must not look forever-pending;
 *   * documents past retainUntil lose their chunks (header + contentHash
 *     survive — same contract as the explicit purge endpoint).
 */
@Injectable()
export class CandidateSweeperService implements OnModuleInit {
  private readonly logger = new Logger(CandidateSweeperService.name);

  // Nightly job owner in the dreams-service mold: registration, cron-time
  // enqueue, and the sweep itself.
  // eslint-disable-next-line max-params
  constructor(
    private readonly surreal: SurrealService,
    private readonly apiKeys: ApiKeyService,
    private readonly candidates: CandidateStoreService,
    @Optional() private readonly workerLoop?: WorkerLoopService,
    @Optional() private readonly claim?: JobClaimService,
    @Optional() private readonly evidence?: EvidenceStoreService,
  ) {}

  onModuleInit(): void {
    if (!this.workerLoop) return;
    this.workerLoop.register('candidate_sweeper', (ctx) => this.executeFromQueue(ctx), {
      ttlSeconds: 600,
      maxAttempts: 2,
    });
  }

  /** 03:45 UTC — after compaction (03:17), before dreams (04:00). */
  @Cron('45 3 * * *', { timeZone: 'UTC' })
  async runNightly(): Promise<{ enqueued: number }> {
    if (!this.claim) return { enqueued: 0 };
    const tenants = this.apiKeys.knownCompanyIds();
    const today = new Date().toISOString().slice(0, 10);
    let enqueued = 0;
    for (const companyId of tenants) {
      try {
        const { created } = await this.claim.enqueue({
          jobType: 'candidate_sweeper',
          companyId,
          triggeredBy: 'cron',
          dedupKey: `candidate_sweeper_${today}`,
        });
        if (created) enqueued++;
      } catch (e) {
        this.logger.warn(
          `enqueue candidate_sweeper for ${companyId} failed: ${(e as Error).message}`,
        );
      }
    }
    return { enqueued };
  }

  private async executeFromQueue(ctx: JobContext): Promise<Record<string, unknown>> {
    const swept = await this.sweepTenant(ctx.companyId);
    const reconciled = await this.reconcileRuns(ctx.companyId);
    return { ...swept, ...reconciled };
  }

  async sweepTenant(companyId: string): Promise<Record<string, unknown>> {
    const retentionDays = envInt('CANDIDATE_RETENTION_DAYS', 30);
    const pendingTtlDays = envInt('CANDIDATE_PENDING_TTL_DAYS', 7);
    const base = await this.surreal.withCompany(companyId, async (db) => {
      const expired = await this.countThen(db, {
        countWhere: `status = 'pending' AND createdAt < time::now() - duration::from_days($days)`,
        mutation: `UPDATE candidate SET status = 'expired',
             statusReason = 'sweeper_ttl', decidedAt = time::now()
           WHERE status = 'pending'
             AND createdAt < time::now() - duration::from_days($days)
           RETURN NONE`,
        params: { days: pendingTtlDays },
      });
      const deleted = await this.countThen(db, {
        countWhere: `status != 'pending' AND decidedAt != NONE AND decidedAt < time::now() - duration::from_days($days)`,
        mutation: `DELETE candidate
           WHERE status != 'pending'
             AND decidedAt != NONE
             AND decidedAt < time::now() - duration::from_days($days)`,
        params: { days: retentionDays },
      });
      // Document retention leg: expired retainUntil → chunks go, header +
      // contentHash stay (idempotency + committed provenance survive).
      // SELECT VALUE id → a flat array of record ids; String() normalizes
      // each (RecordId or bare string) to its 'source_document:<tail>' form.
      const purgedDocs = await queryRows<unknown>(
        db,
        `SELECT VALUE id FROM source_document
         WHERE retainUntil != NONE AND retainUntil < time::now()
           AND status != 'purged'`,
      );
      const purgeIds = purgedDocs.map(String);
      let factsFlagged = 0;
      for (const docId of purgeIds) {
        const tail = docId.slice(docId.indexOf(':') + 1);
        // Batched two-step chunk purge — shared idiom, see document-purge.util.
        await purgeDocumentChunks(db, docId);
        await db.query(
          `UPDATE type::record('source_document', $doc)
             SET status = 'purged', hasContent = false`,
          { doc: tail },
        );
        factsFlagged += await markFactsProvenancePurged(db, docId);
      }
      this.logger.log(
        `candidate sweep ${companyId}: expired=${expired} deleted=${deleted} purgedDocs=${purgeIds.length} factsFlagged=${factsFlagged}`,
      );
      return { expired, deleted, purgedDocs: purgeIds.length, factsFlagged };
    });
    // Evidence retention leg (0109): assets past retainUntil lose
    // fragments/representations/blob and become 'gone' tombstones, plus
    // the blob-delete reconciliation retry. Owned by the evidence module
    // (the sweeper stays lifecycle-cron glue) and run on its OWN scoped
    // connection (never nested inside the closure above); @Optional so
    // positionally-constructed fixtures stay valid.
    const evidenceCounts = (await this.evidence?.sweepTenantEvidence(companyId)) ?? {};
    return { ...base, ...evidenceCounts };
  }

  /**
   * Reap indexer_runs stuck 'running' (crashed workers), then re-drive the
   * commit of any document left with staged candidates in a pre-commit
   * state. Without this a deploy/crash mid-extraction wedges a document in
   * 'indexing' forever and its pending candidates silently expire. Runs as
   * part of the nightly sweep and is idempotent.
   */
  async reconcileRuns(companyId: string): Promise<Record<string, unknown>> {
    const reapedRuns = await this.candidates.reapStaleRuns(companyId);
    const docs = await this.candidates.findDocsNeedingCommit(companyId);
    let recommitted = 0;
    if (this.claim) {
      const today = new Date().toISOString().slice(0, 10);
      for (const docId of docs) {
        try {
          const { created } = await this.claim.enqueue({
            jobType: 'commit_document',
            companyId,
            triggeredBy: 'cron',
            // Fresh per-day key so the reconciler isn't collapsed by a
            // stale succeeded commit_document row on the ledger.
            dedupKey: `commit_reconcile_${idTail(docId)}_${today}`,
            payload: { docId },
          });
          if (created) recommitted++;
        } catch (e) {
          this.logger.warn(`reconcile commit enqueue for ${docId} failed: ${(e as Error).message}`);
        }
      }
    }
    if (reapedRuns > 0 || recommitted > 0) {
      this.logger.log(
        `run reconcile ${companyId}: reapedRuns=${reapedRuns} recommitted=${recommitted}`,
      );
    }
    return { reapedRuns, recommitted };
  }

  /** Count matching candidates, then run the mutation — honest job stats. */
  private async countThen(
    db: import('surrealdb').Surreal,
    p: {
      countWhere: string;
      mutation: string;
      params: Record<string, unknown>;
    },
  ): Promise<number> {
    const row = await queryFirst<CountRow>(
      db,
      `SELECT count() AS c FROM candidate WHERE ${p.countWhere} GROUP ALL`,
      p.params,
    );
    const count = row?.c ?? 0;
    if (count > 0) {
      await db.query(p.mutation, p.params);
    }
    return Number(count);
  }
}

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
