import { Injectable, Logger } from '@nestjs/common';
import { traceSpan } from '../common/debug-trace';
import { DocumentStoreService } from './document-store.service';
import { IndexerRunService, IndexerRunResult } from './indexer-run.service';
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
 * Top-level document ingest orchestration: Source (store + chunk) →
 * Indexer ('_general' union pass, virtual composition) → Brain
 * (CommitMemory over the staged candidates). Wave 1 is synchronous —
 * the async multi-indexer fan-out plugs in behind
 * DOCUMENT_MULTI_INDEXER_ENABLED without changing this flow.
 */
@Injectable()
export class DocumentIngestService {
  private readonly logger = new Logger(DocumentIngestService.name);

  constructor(
    private readonly store: DocumentStoreService,
    private readonly indexer: IndexerRunService,
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
        const run = await this.indexer.runGeneral({ companyId, doc, chunks });
        await this.store.setStatus({ companyId, docId: doc.id, status: 'indexed' });

        const commit = await this.commit.commitDocument(companyId, doc);
        if (commit.committed) {
          await this.store.setStatus({
            companyId,
            docId: doc.id,
            status: 'committed',
          });
        }
        return this.shapeResponse({ doc, chunks, deduplicated, run, commit });
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

  private shapeResponse(p: {
    doc: { id: string };
    chunks: unknown[];
    deduplicated: boolean;
    run: IndexerRunResult;
    commit: CommitResult;
  }): DocumentIngestResponse {
    return {
      documentId: p.doc.id,
      deduplicated: p.deduplicated,
      chunkCount: p.chunks.length,
      mode: 'sync',
      runs: [{ runId: p.run.runId, packId: p.run.packId, status: p.run.status }],
      committed: {
        entityIds: p.commit.entityIds,
        factIds: p.commit.factIds,
        edgeIds: p.commit.edgeIds,
      },
      counts: p.commit.counts,
    };
  }
}
