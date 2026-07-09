import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { JobClaimService } from '../jobs/job-claim.service';
import { WorkerLoopService, JobContext } from '../jobs/worker-loop.service';
import { DocumentStoreService } from './document-store.service';
import { IndexerDispatchService } from './indexer-dispatch.service';
import { CandidateCommitService } from './candidate-commit.service';

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
  ) {}

  onModuleInit(): void {
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
    const binding = await this.dispatch.bindingFor(companyId, packId);
    if (!binding) return null;
    const { enqueued } = await this.enqueueReindex(companyId, {
      packId,
      packVersion: binding.packVersion,
    });
    return { enqueued, packVersion: binding.packVersion };
  }

  /** Enqueue a backfill for one pack (install hook + admin endpoint). */
  async enqueueReindex(
    companyId: string,
    p: { packId: string; packVersion: string; cursor?: string },
  ): Promise<{ enqueued: boolean }> {
    if (!this.claim) return { enqueued: false };
    const { created } = await this.claim.enqueue({
      jobType: 'reindex_documents',
      companyId,
      triggeredBy: 'manual',
      dedupKey: `reindex_${p.packId}_${p.packVersion}_${p.cursor ?? 'start'}`,
      payload: { packId: p.packId, packVersion: p.packVersion, cursor: p.cursor },
    });
    return { enqueued: created };
  }

  private async executeFromQueue(
    ctx: JobContext,
  ): Promise<Record<string, unknown>> {
    const packId = String(ctx.payload?.packId ?? '');
    const packVersion = String(ctx.payload?.packVersion ?? '');
    const cursor = ctx.payload?.cursor ? String(ctx.payload.cursor) : undefined;
    if (!packId) return { skipped: 'missing_packId' };

    const budget = envInt('REINDEX_MAX_DOCS_PER_RUN', 500);
    const docs = await this.store.listReindexable(ctx.companyId, {
      afterId: cursor,
      limit: budget,
    });

    let processed = 0;
    let skipped = 0;
    let lastDocId = cursor;
    for (const doc of docs) {
      if (ctx.abortSignal.aborted) break;
      lastDocId = doc.id;
      const chunks = await this.store.getChunks(ctx.companyId, doc.id);
      if (chunks.length === 0) {
        skipped++;
        continue;
      }
      const run = await this.dispatch.runOne({
        companyId: ctx.companyId,
        doc,
        chunks,
        packId,
      });
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

    const exhausted = docs.length < budget || ctx.abortSignal.aborted;
    if (!exhausted && lastDocId) {
      await this.enqueueReindex(ctx.companyId, {
        packId,
        packVersion,
        cursor: lastDocId,
      });
    }
    this.logger.log(
      `reindex ${packId}@${packVersion} for ${ctx.companyId}: processed=${processed} skipped=${skipped} requeued=${!exhausted}`,
    );
    return { processed, skipped, requeued: !exhausted, cursor: lastDocId };
  }
}

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
