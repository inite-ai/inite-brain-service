import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { JobClaimService } from '../jobs/job-claim.service';
import { WorkerLoopService, JobContext } from '../jobs/worker-loop.service';
import { GENERAL_INDEXER_ID } from '../indexers/candidate.types';
import { DocumentStoreService, StoredDocument } from './document-store.service';
import { IndexerDispatchService } from './indexer-dispatch.service';
import { CandidateCommitService } from './candidate-commit.service';
import { IngestDocumentDto } from './dto/ingest-document.dto';

export interface DocumentAsyncResponse {
  documentId: string;
  deduplicated: boolean;
  chunkCount: number;
  mode: 'async';
  runs: Array<{ packId: string; status: 'enqueued' | 'already_processed' }>;
}

/**
 * Queue-driven document ingest: one `index_document` job per selected
 * indexer, each finishing job enqueues a `commit_document` that DEFERS
 * until every run for the document is terminal — the last one commits the
 * full candidate set in one merge. dedupKeys make the whole fan-out
 * idempotent across retries and duplicate POSTs.
 *
 * A failed indexer run (after maxAttempts) is terminal `failed`: commit
 * proceeds over the successful runs — one broken pack must not hold a
 * document's memory hostage.
 *
 * Async requires stored content (jobs re-read chunks from the DB), which
 * the controller enforces.
 */
@Injectable()
export class DocumentAsyncService implements OnModuleInit {
  private readonly logger = new Logger(DocumentAsyncService.name);

  // Queue orchestrator in the dreams-service mold: registration (worker
  // loop), enqueue (claim), and the three pipeline stages it dispatches
  // to. Splitting further would only add pass-through classes.
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
      'index_document',
      (ctx) => this.handleIndexJob(ctx),
      // A run is per-chunk LLM calls; 32-chunk documents with sc-passes
      // can take minutes. 10-minute lease, 3 attempts.
      { ttlSeconds: 600, maxAttempts: 3 },
    );
    this.workerLoop.register(
      'commit_document',
      (ctx) => this.handleCommitJob(ctx),
      { ttlSeconds: 600, maxAttempts: 3 },
    );
  }

  /** Create the document, then fan indexer runs out onto the queue. */
  async ingestAsync(
    companyId: string,
    dto: IngestDocumentDto,
  ): Promise<DocumentAsyncResponse> {
    if (!this.claim) {
      throw new Error('async ingest unavailable: job queue not wired');
    }
    const { doc, chunks, deduplicated } = await this.store.createOrGet(
      companyId,
      dto,
    );
    const dedicated = await this.dispatch.selectDedicated({
      companyId,
      doc,
      chunks,
      indexers: dto.indexers,
    });
    const specs = [
      { packId: GENERAL_INDEXER_ID, packVersion: '0' },
      ...dedicated.map((b) => ({ packId: b.indexerId, packVersion: b.packVersion })),
    ];

    await this.store.setStatus({ companyId, docId: doc.id, status: 'indexing' });
    const runs: DocumentAsyncResponse['runs'] = [];
    for (const spec of specs) {
      // Version-aware dedupKey mirrors the indexer_run UNIQUE triple: a
      // re-POST of the same content collapses; a pack upgrade re-opens
      // the slot.
      const { created } = await this.claim.enqueue({
        jobType: 'index_document',
        companyId,
        triggeredBy: 'manual',
        dedupKey: `idx_${doc.contentHash.slice(0, 24)}_${spec.packId}_${spec.packVersion}`,
        payload: { docId: doc.id, packId: spec.packId },
      });
      runs.push({
        packId: spec.packId,
        status: created ? 'enqueued' : 'already_processed',
      });
    }
    return {
      documentId: doc.id,
      deduplicated,
      chunkCount: doc.chunkCount,
      mode: 'async',
      runs,
    };
  }

  private async handleIndexJob(
    ctx: JobContext,
  ): Promise<Record<string, unknown>> {
    const docId = String(ctx.payload?.docId ?? '');
    const packId = String(ctx.payload?.packId ?? '');
    const doc = await this.store.getById(ctx.companyId, docId);
    if (!doc) return { skipped: 'missing_document' };
    const chunks = await this.store.getChunks(ctx.companyId, docId);
    if (chunks.length === 0) return { skipped: 'no_stored_content' };

    let status: string;
    try {
      const run = await this.dispatch.runOne({
        companyId: ctx.companyId,
        doc,
        chunks,
        packId,
        abortSignal: ctx.abortSignal,
      });
      status = run.status;
    } finally {
      // Win or lose, this run is now terminal (failed runs finalize inside
      // runIndexer; a thrown error here after maxAttempts is also terminal)
      // — give commit its chance. The commit job defers while other runs
      // are still open.
      await this.enqueueCommit(ctx.companyId, { docId, packId });
    }
    return { packId, status };
  }

  private async handleCommitJob(
    ctx: JobContext,
  ): Promise<Record<string, unknown>> {
    const docId = String(ctx.payload?.docId ?? '');
    const doc = await this.store.getById(ctx.companyId, docId);
    if (!doc) return { skipped: 'missing_document' };
    const result = await this.commit.commitIfRunsSettled(ctx.companyId, doc);
    if (result.deferred) return { deferred: true };
    if (result.committed) {
      await this.setStatusSafe(ctx.companyId, doc, 'committed');
    }
    return {
      deferred: false,
      committed: result.committed,
      counts: result.counts,
    };
  }

  private async enqueueCommit(
    companyId: string,
    p: { docId: string; packId: string },
  ): Promise<void> {
    if (!this.claim) return;
    try {
      // dedupKey is per finishing RUN, not per document: a constant key
      // would collapse the re-enqueue that the deferral protocol needs.
      await this.claim.enqueue({
        jobType: 'commit_document',
        companyId,
        triggeredBy: 'manual',
        dedupKey: `commit_${p.docId}_${p.packId}`,
        payload: { docId: p.docId },
      });
    } catch (e) {
      this.logger.warn(
        `enqueue commit_document failed for ${p.docId}: ${(e as Error).message}`,
      );
    }
  }

  private async setStatusSafe(
    companyId: string,
    doc: StoredDocument,
    status: string,
  ): Promise<void> {
    await this.store
      .setStatus({ companyId, docId: doc.id, status })
      .catch(() => undefined);
  }
}
