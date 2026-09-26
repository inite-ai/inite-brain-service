import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { JobClaimService } from '../jobs/job-claim.service';
import { WorkerLoopService, JobContext } from '../jobs/worker-loop.service';
import { DocumentStoreService } from './document-store.service';
import { IndexerDispatchService } from './indexer-dispatch.service';
import { CandidateCommitService } from './candidate-commit.service';
import { SurrealService } from '../db/surreal.service';
import { GENERAL_INDEXER_ID, GENERAL_INDEXER_VERSION } from '../indexers/candidate.types';

/**
 * Re-index/backfill: run ONE pack's extraction over the tenant's stored
 * documents — the payoff of the Source layer. Installing a new pack (or
 * upgrading one) makes past documents eligible again; the indexer_run
 * UNIQUE (docId, packId, packVersion) ledger skips everything already
 * processed at that version, so the job is idempotent and resumable.
 *
 * Budgeted self-chaining instead of an in-row cursor: each job processes
 * up to REINDEX_MAX_DOCS_PER_RUN documents and, if more remain,
 * re-enqueues itself with the last document id as the cursor. Every
 * batch is bounded; a crash loses at most one batch of skips.
 */
@Injectable()
export class DocumentReindexService implements OnModuleInit {
  private readonly logger = new Logger(DocumentReindexService.name);

  // Backfill job owner in the dreams-service mold: registration, enqueue,
  // and the pipeline stages it drives per document.
  // eslint-disable-next-line max-params
  constructor(
    private readonly store: DocumentStoreService,
    private readonly dispatch: IndexerDispatchService,
    private readonly commit: CandidateCommitService,
    @Optional() private readonly workerLoop?: WorkerLoopService,
    @Optional() private readonly claim?: JobClaimService,
    @Optional() private readonly surreal?: SurrealService,
  ) {}

  onModuleInit(): void {
    // A new extraction contract re-reads the memory it was written by:
    // each tenant's stored documents are read again by the generalist
    // pass at GENERAL_INDEXER_VERSION (the run ledger skips a document
    // already read at that version, so a restart mid-pass resumes rather
    // than repeats, and a failed one is reopened).
    // Without it a contract change (edges gaining the period they held,
    // 0164) reached only what was written after the deploy, and every
    // earlier document kept the timeless reading.
    this.surreal?.onTenantSchemaReady((companyId) => {
      void this.enqueueReindex(companyId, {
        packId: GENERAL_INDEXER_ID,
        packVersion: GENERAL_INDEXER_VERSION,
        // Once per day, not once ever: a pass whose documents failed (a
        // provider outage) is walked again on the next boot of a new day
        // — the ledger skips what succeeded, so the walk is reads only.
        nonce: new Date().toISOString().slice(0, 10),
      }).catch((e: Error) =>
        this.logger.warn(`[reindex] ${companyId}: general pass not enqueued: ${e.message}`),
      );
    });
    if (!this.workerLoop) return;
    this.workerLoop.register(
      'reindex_documents',
      (ctx) => this.executeFromQueue(ctx),
      // A batch is up to 500 documents × per-chunk LLM calls, though the
      // extraction cache eats unchanged text. 20-minute lease, like dreams.
      { ttlSeconds: 1200, maxAttempts: 3 },
    );
  }

  /**
   * Admin-endpoint entry: resolve the pack's installed version, then
   * enqueue. Returns null when the pack is unknown for this tenant.
   */
  async enqueueForPack(
    companyId: string,
    packId: string,
  ): Promise<{ enqueued: boolean; packVersion: string } | null> {
    if (packId === GENERAL_INDEXER_ID) {
      const { enqueued } = await this.enqueueReindex(companyId, {
        packId,
        packVersion: GENERAL_INDEXER_VERSION,
        nonce: new Date().toISOString().slice(0, 13),
      });
      return { enqueued, packVersion: GENERAL_INDEXER_VERSION };
    }
    const binding = await this.dispatch.bindingFor(companyId, packId);
    if (!binding) return null;
    const { enqueued } = await this.enqueueReindex(companyId, {
      packId,
      packVersion: binding.packVersion,
      // Admin is an explicit re-run request — a fresh nonce so a completed
      // backfill's succeeded job_run row doesn't dedup it away forever
      // (the install hook keeps the stable 'start' key = install-idempotent).
      nonce: new Date().toISOString().slice(0, 13), // hour-granularity
    });
    return { enqueued, packVersion: binding.packVersion };
  }

  /** Enqueue a backfill for one pack (install hook + admin endpoint). */
  async enqueueReindex(
    companyId: string,
    p: {
      packId: string;
      packVersion: string;
      cursor?: string;
      nonce?: string;
      /** Which retry pass this is (0 = the first pass). */
      retry?: number;
      visibleAfter?: Date;
    },
  ): Promise<{ enqueued: boolean }> {
    if (!this.claim) return { enqueued: false };
    const retry = p.retry ?? 0;
    const pass = retry > 0 ? `retry${retry}_` : '';
    const suffix = p.cursor ?? (p.nonce ? `start_${p.nonce}` : 'start');
    const { created } = await this.claim.enqueue({
      jobType: 'reindex_documents',
      companyId,
      triggeredBy: 'manual',
      dedupKey: `reindex_${p.packId}_${p.packVersion}_${pass}${suffix}`,
      payload: { packId: p.packId, packVersion: p.packVersion, cursor: p.cursor, retry },
      ...(p.visibleAfter ? { visibleAfter: p.visibleAfter } : {}),
    });
    return { enqueued: created };
  }

  private async executeFromQueue(ctx: JobContext): Promise<Record<string, unknown>> {
    const packId = String(ctx.payload?.packId ?? '');
    const packVersion = String(ctx.payload?.packVersion ?? '');
    const cursor = ctx.payload?.cursor ? String(ctx.payload.cursor) : undefined;
    const retry = Number(ctx.payload?.retry ?? 0) || 0;
    if (!packId) return { skipped: 'missing_packId' };

    const budget = envInt('REINDEX_MAX_DOCS_PER_RUN', 500);
    const docs = await this.store.listReindexable(ctx.companyId, {
      afterId: cursor,
      limit: budget,
    });

    let processed = 0;
    let skipped = 0;
    let failed = 0;
    let lastDocId = cursor;
    for (const doc of docs) {
      if (ctx.abortSignal.aborted) {
        // A deploy mid-backfill must not look like "exhausted". Throw so the
        // job requeues and resumes from its original cursor (already-committed
        // docs skip via the run ledger) instead of silently truncating.
        throw new Error('aborted');
      }
      lastDocId = doc.id;
      const chunks = await this.store.getChunks(ctx.companyId, doc.id);
      if (chunks.length === 0) {
        skipped++;
        continue;
      }
      // One document's failure is that document's: the run row is left
      // 'failed' (the ledger reopens it on the next pass) and the walk
      // goes on. It used to throw out of the whole job, whose three
      // attempts then burned inside the same outage — on 2026-09-25 a
      // provider credit outage failed every document of a contract
      // re-read, the job gave up, and its stable dedup key kept it from
      // ever running again.
      let run: Awaited<ReturnType<IndexerDispatchService['runOne']>>;
      try {
        run = await this.dispatch.runOne({ companyId: ctx.companyId, doc, chunks, packId });
      } catch (e) {
        failed++;
        this.logger.warn(`[reindex] ${packId}@${packVersion} ${doc.id}: ${(e as Error).message}`);
        continue;
      }
      if (run.status === 'skipped') {
        skipped++;
        continue;
      }
      processed++;
      // Commit merges the new pack's candidates against the document's
      // already-committed memory via fn::resolve_fact; originKey (0050)
      // keeps the same document from corroborating itself.
      await this.commit.commitIfRunsSettled(ctx.companyId, doc);
    }

    // Abort throws above, so reaching here means a clean pass: exhausted iff
    // this batch didn't fill the budget (no more documents to walk).
    const exhausted = docs.length < budget;
    if (!exhausted && lastDocId) {
      await this.enqueueReindex(ctx.companyId, {
        packId,
        packVersion,
        cursor: lastDocId,
      });
    }
    const retryAt =
      failed > 0 ? await this.scheduleRetry(ctx.companyId, { packId, packVersion, retry }) : null;
    this.logger.log(
      `reindex ${packId}@${packVersion} for ${ctx.companyId}: processed=${processed} skipped=${skipped} failed=${failed} requeued=${!exhausted}` +
        (retryAt ? ` retry=${retry + 1} at ${retryAt.toISOString()}` : ''),
    );
    return { processed, skipped, failed, requeued: !exhausted, cursor: lastDocId };
  }

  /**
   * A later pass over the whole set for the documents that failed: the
   * ledger skips what succeeded and reopens what failed. Backed off
   * (15 min, doubling) so it lands after an outage rather than inside it,
   * and bounded — a document that fails every time is a defect to read in
   * the logs, not a loop. Every batch of a failed pass asks for the SAME
   * retry key, so one retry pass runs however many batches failed.
   */
  private async scheduleRetry(
    companyId: string,
    pass: { packId: string; packVersion: string; retry: number },
  ): Promise<Date | null> {
    const { packId, packVersion, retry } = pass;
    if (retry >= REINDEX_MAX_RETRIES) return null;
    const visibleAfter = new Date(Date.now() + REINDEX_RETRY_BASE_MS * 2 ** retry);
    await this.enqueueReindex(companyId, { packId, packVersion, retry: retry + 1, visibleAfter });
    return visibleAfter;
  }
}

/** Retry passes after a pass with failed documents, and the first backoff. */
const REINDEX_MAX_RETRIES = 5;
const REINDEX_RETRY_BASE_MS = 15 * 60_000;

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
