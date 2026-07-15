import { Injectable, Logger } from '@nestjs/common';
import { traceSpan } from '../common/debug-trace';
import { DocumentStoreService } from './document-store.service';
import { IndexerDispatchService } from './indexer-dispatch.service';
import type { IndexerRunResult } from './indexer-run.service';
import { CandidateCommitService, CommitResult } from './candidate-commit.service';
import { IngestDocumentDto } from './dto/ingest-document.dto';

export interface DocumentIngestResponse {
  documentId: string;
  deduplicated: boolean;
  chunkCount: number;
  mode: 'sync';
  runs: Array<{ runId: string; packId: string; status: string }>;
  committed: {
    entityIds: string[];
    factIds: string[];
    edgeIds: string[];
  };
  counts: CommitResult['counts'];
}

/**
 * Synchronous document ingest orchestration: Source (store + chunk) →
 * Indexer (generalist union pass + router-selected dedicated packs, via
 * IndexerDispatchService) → Brain (CommitMemory over the staged
 * candidates). The async fan-out lives in DocumentAsyncService — same
 * stages, queue-driven.
 */
@Injectable()
export class DocumentIngestService {
  private readonly logger = new Logger(DocumentIngestService.name);

  constructor(
    private readonly store: DocumentStoreService,
    private readonly dispatch: IndexerDispatchService,
    private readonly commit: CandidateCommitService,
  ) {}

  async ingestDocument(
    companyId: string,
    dto: IngestDocumentDto,
  ): Promise<DocumentIngestResponse> {
    return traceSpan('ingest.document', async () => {
      const { doc, chunks, deduplicated } = await this.store.createOrGet(
        companyId,
        dto,
      );

      try {
        await this.store.setStatus({ companyId, docId: doc.id, status: 'indexing' });
        const runs = await this.dispatch.dispatchSync({
          companyId,
          doc,
          chunks,
          indexers: dto.indexers,
        });
        // External packs get pull-API work items instead of in-process
        // runs; they never defer this commit (external runs are excluded
        // from the settle count) — a late submission re-commits.
        runs.push(
          ...(await this.dispatch.planExternal({
            companyId,
            doc,
            chunks,
            indexers: dto.indexers,
          })),
        );
        await this.store.setStatus({ companyId, docId: doc.id, status: 'indexed' });

        const commit = await this.commit.commitDocument(companyId, doc);
        if (commit.committed) {
          await this.store.setStatus({
            companyId,
            docId: doc.id,
            status: 'committed',
          });
        }
        return this.shapeResponse({ doc, chunks, deduplicated, runs, commit });
      } catch (err) {
        this.logger.warn(
          `document ingest failed doc=${doc.id}: ${(err as Error).message}`,
        );
        await this.store
          .setStatus({ companyId, docId: doc.id, status: 'failed' })
          .catch(() => undefined);
        throw err;
      }
    });
  }

  /** Manual (re)commit of whatever is pending — the admin endpoint. */
  async commitPending(
    companyId: string,
    docId: string,
  ): Promise<CommitResult | null> {
    const doc = await this.store.getById(companyId, docId);
    if (!doc) return null;
    const commit = await this.commit.commitDocument(companyId, doc);
    if (commit.committed) {
      await this.store.setStatus({ companyId, docId: doc.id, status: 'committed' });
    }
    return commit;
  }

  /**
   * Commit ONLY when every run for the document is terminal — the
   * external-candidates path shares the async queue's deferral rule so a
   * remote submission doesn't slice a half-finished fan-out's merge.
   */
  async commitIfSettled(
    companyId: string,
    docId: string,
  ): Promise<(CommitResult & { deferred: boolean }) | null> {
    const doc = await this.store.getById(companyId, docId);
    if (!doc) return null;
    const commit = await this.commit.commitIfRunsSettled(companyId, doc);
    if (commit.committed) {
      await this.store.setStatus({ companyId, docId: doc.id, status: 'committed' });
    }
    return commit;
  }

  private shapeResponse(p: {
    doc: { id: string };
    chunks: unknown[];
    deduplicated: boolean;
    runs: IndexerRunResult[];
    commit: CommitResult;
  }): DocumentIngestResponse {
    return {
      documentId: p.doc.id,
      deduplicated: p.deduplicated,
      chunkCount: p.chunks.length,
      mode: 'sync',
      runs: p.runs.map((r) => ({
        runId: r.runId,
        packId: r.packId,
        status: r.status,
      })),
      committed: {
        entityIds: p.commit.entityIds,
        factIds: p.commit.factIds,
        edgeIds: p.commit.edgeIds,
      },
      counts: p.commit.counts,
    };
  }
}
