import { BadRequestException, Injectable, Logger, Optional } from '@nestjs/common';
import { traceSpan } from '../common/debug-trace';
import { DocumentStoreService } from './document-store.service';
import { IndexerDispatchService } from './indexer-dispatch.service';
import type { IndexerRunResult } from './indexer-run.service';
import { CandidateCommitService, CommitResult } from './candidate-commit.service';
import { IngestDocumentDto } from './dto/ingest-document.dto';
import { internalDocumentMeta, type InternalDocumentMeta } from './document-meta';
import { ToolObservationService } from '../outcomes/tool-observation.service';
import { pinUserScope } from '../auth/user-scope';

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

  // eslint-disable-next-line max-params -- Nest DI constructor; each param is an injection token and cannot be folded into an options object without breaking DI
  constructor(
    private readonly store: DocumentStoreService,
    private readonly dispatch: IndexerDispatchService,
    private readonly commit: CandidateCommitService,
    // @Optional so positionally-constructed unit fixtures stay valid
    // (the OutcomesModule injection discipline).
    @Optional() private readonly toolObservations?: ToolObservationService,
  ) {}

  /**
   * `internalMeta` carries brain-synthesised document-header provenance
   * from an in-process caller (the mention-via-document wrapper). It is
   * NOT reachable from the wire — the HTTP/MCP surfaces only ever pass a
   * validated IngestDocumentDto — so it never widens what a client can
   * assert. See document-meta.ts.
   */
  async ingestDocument(
    companyId: string,
    dto: IngestDocumentDto,
    internalMeta?: InternalDocumentMeta | undefined,
  ): Promise<DocumentIngestResponse> {
    // Per-user scope pin at the service entry (0128; the audit 2026-08-21
    // P0 seam, same as fact-ingest / mention-ingest): a user-bound token
    // writes ONLY its own user's slice (mismatch 403, omitted → the
    // token's user); M2M assertions pass through. The pinned value rides
    // the stored document row into fact commit + scene projection.
    dto = { ...dto, userId: pinUserScope(dto.userId) };
    return traceSpan('ingest.document', async () => {
      const toolObservation = await this.threadToolObservation(companyId, dto);
      // internalDocumentMeta() collapses an all-absent bag back to
      // undefined, so a document with neither hop keeps the pre-fix row
      // (no `meta` key at all) byte-identical.
      const internal = internalDocumentMeta({ ...internalMeta, ...toolObservation });
      const { doc, chunks, deduplicated } = await this.store.createOrGet(companyId, dto, internal);

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
        this.logger.warn(`document ingest failed doc=${doc.id}: ${(err as Error).message}`);
        await this.store
          .setStatus({ companyId, docId: doc.id, status: 'failed' })
          .catch(() => undefined);
        throw err;
      }
    });
  }

  /**
   * Thread a `tool_observation:<id>` provenance ref (0111) onto the
   * document header. Under TOOL_OBSERVATIONS_ENABLED the ref is
   * validated against the tenant's own rows (unknown/foreign/malformed
   * ⇒ 400 — a provenance claim must not be storable unverified) and
   * stored in doc meta (FLEXIBLE) together with a content-free note
   * ('<tool> @ <iso>') the commit-writer folds into every committed
   * fact's source.evidence[]. Flag off ⇒ the ref is ignored and the
   * write path is byte-identical.
   *
   * These two keys are BRAIN's, not the caller's — `toolObservationNote`
   * is synthesised outright from the verified row, and the ref is only
   * trustworthy because it was just verified. They therefore ride the
   * internal document-meta channel (document-meta.ts) instead of being
   * folded into `dto.meta`, where SOURCE_META_STRICT would reject their
   * camelCase against a rule written for operator vocabulary.
   */
  private async threadToolObservation(
    companyId: string,
    dto: IngestDocumentDto,
  ): Promise<InternalDocumentMeta | undefined> {
    const ref = dto.toolObservationRef;
    if (ref === undefined || !this.toolObservations?.enabled()) return undefined;
    const verified = await this.toolObservations.verifyRef(companyId, ref);
    if (!verified) {
      throw new BadRequestException(
        'toolObservationRef does not resolve to a tool_observation row in this tenant',
      );
    }
    return internalDocumentMeta({
      toolObservationRef: ref,
      toolObservationNote: `${verified.tool} @ ${verified.createdAt}`,
    });
  }

  /** Manual (re)commit of whatever is pending — the admin endpoint. */
  async commitPending(companyId: string, docId: string): Promise<CommitResult | null> {
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
