import { Injectable, Logger } from '@nestjs/common';
import { envFlagEnabled } from '../common/env-validation';
import { IndexerRouterService } from '../indexers/indexer-router.service';
import { DedicatedExtractorService } from '../indexers/dedicated-extractor.service';
import type { IndexerBinding } from '../indexers/routing';
import { GENERAL_INDEXER_ID } from '../indexers/candidate.types';
import { IndexerRunService, IndexerRunResult } from './indexer-run.service';
import { IndexerWebhookService } from './indexer-webhook.service';
import type { DocumentChunk } from './chunker';
import type { StoredDocument } from './document-store.service';

export type IndexerSelection = string[] | 'auto' | 'general';

/**
 * Which indexers read this document, and run them. The generalist
 * ('_general') pass ALWAYS runs — it is the document's core reader and
 * carries virtual composition for every installed pack. Dedicated runs
 * are additive on top, gated by DOCUMENT_MULTI_INDEXER_ENABLED and the
 * relevance router:
 *
 *   'general' (default)  → union pass only (wave-1 behavior)
 *   'auto'               → union + router-selected dedicated packs
 *   string[]             → union + those packs as dedicated (router L0)
 *
 * One failed dedicated run must not hold the document's memory hostage:
 * failures are recorded on the run row and the remaining indexers
 * proceed (partial commit is correct).
 */
@Injectable()
export class IndexerDispatchService {
  private readonly logger = new Logger(IndexerDispatchService.name);

  // The 4th dep is the fire-and-forget webhook hint for external packs —
  // a notification side-channel, not a pipeline stage.
  // eslint-disable-next-line max-params
  constructor(
    private readonly router: IndexerRouterService,
    private readonly runs: IndexerRunService,
    private readonly dedicated: DedicatedExtractorService,
    private readonly webhook: IndexerWebhookService,
  ) {}

  async dispatchSync(p: {
    companyId: string;
    doc: StoredDocument;
    chunks: DocumentChunk[];
    indexers?: IndexerSelection | undefined;
  }): Promise<IndexerRunResult[]> {
    const results: IndexerRunResult[] = [await this.runs.runGeneral(p)];
    for (const binding of await this.selectDedicated(p)) {
      try {
        results.push(await this.runBinding({ ...p, binding }));
      } catch (err) {
        this.logger.warn(
          `dedicated indexer ${binding.indexerId} failed on ${p.doc.id}: ${(err as Error).message}`,
        );
        results.push({
          runId: '',
          packId: binding.indexerId,
          status: 'failed',
        });
      }
    }
    return results;
  }

  /** Resolve one pack's binding (installed or builtin), or null. */
  async bindingFor(companyId: string, packId: string): Promise<IndexerBinding | null> {
    const bindings = await this.router.bindingsFor(companyId);
    return bindings.find((b) => b.indexerId === packId) ?? null;
  }

  /**
   * Run ONE indexer by pack id — the async job + re-index path. Any pack
   * (virtual included) runs as a pack-scoped extraction here: for
   * backfill, "read old documents with THIS pack's vocabulary" is
   * exactly the dedicated machinery, whatever the pack's live-ingest
   * mode is.
   */
  async runOne(p: {
    companyId: string;
    doc: StoredDocument;
    chunks: DocumentChunk[];
    packId: string;
    abortSignal?: AbortSignal;
  }): Promise<IndexerRunResult> {
    if (p.packId === GENERAL_INDEXER_ID) {
      return this.runs.runGeneral(p);
    }
    const binding = await this.bindingFor(p.companyId, p.packId);
    if (!binding) {
      throw new Error(`unknown indexer pack "${p.packId}"`);
    }
    if (binding.mode === 'external') {
      // Backfill for an external pack: don't burn LLM calls extracting
      // with its vocabulary in-process — register the work item and let
      // the remote indexer pull it. Reindex is thereby the backfill
      // trigger for external indexers too.
      const planned = await this.runs.planExternal({
        companyId: p.companyId,
        docId: p.doc.id,
        packId: binding.indexerId,
        packVersion: binding.packVersion,
      });
      this.pushHint(p.companyId, p.doc.id, binding);
      return planned;
    }
    return this.runBinding({ ...p, binding });
  }

  /** Dedicated bindings this document should get, honoring flag + selection. */
  async selectDedicated(p: {
    companyId: string;
    doc: StoredDocument;
    chunks: DocumentChunk[];
    indexers?: IndexerSelection | undefined;
  }): Promise<IndexerBinding[]> {
    return this.selectRouted(p, 'dedicated');
  }

  /** External bindings this document should get — same routing layers. */
  async selectExternal(p: {
    companyId: string;
    doc: StoredDocument;
    chunks: DocumentChunk[];
    indexers?: IndexerSelection | undefined;
  }): Promise<IndexerBinding[]> {
    return this.selectRouted(p, 'external');
  }

  /**
   * Register work items for the routed EXTERNAL packs: one 'pending'
   * external indexer_run each, served by the pull API. Skipped entirely
   * for content-less documents (nothing for a remote indexer to read)
   * unless the operator allows ungrounded external candidates.
   */
  async planExternal(p: {
    companyId: string;
    doc: StoredDocument;
    chunks: DocumentChunk[];
    indexers?: IndexerSelection | undefined;
  }): Promise<IndexerRunResult[]> {
    if (!p.doc.hasContent && !envFlagEnabled(process.env.DOCUMENT_ALLOW_UNGROUNDED_EXTERNAL)) {
      return [];
    }
    const results: IndexerRunResult[] = [];
    for (const binding of await this.selectExternal(p)) {
      results.push(
        await this.runs.planExternal({
          companyId: p.companyId,
          docId: p.doc.id,
          packId: binding.indexerId,
          packVersion: binding.packVersion,
        }),
      );
      this.pushHint(p.companyId, p.doc.id, binding);
    }
    return results;
  }

  /**
   * Fire-and-forget work_available hint for packs that declared a
   * callbackUrl. Push is a latency optimization over polling — the
   * webhook service owns retries/breaker and never throws.
   */
  private pushHint(companyId: string, documentId: string, binding: IndexerBinding): void {
    const callbackUrl = binding.external?.callbackUrl;
    if (!callbackUrl) return;
    void this.webhook.notifyWorkAvailable({
      companyId,
      documentId,
      packId: binding.indexerId,
      packVersion: binding.packVersion,
      callbackUrl,
    });
  }

  private async selectRouted(
    p: {
      companyId: string;
      doc: StoredDocument;
      chunks: DocumentChunk[];
      indexers?: IndexerSelection | undefined;
    },
    mode: 'dedicated' | 'external',
  ): Promise<IndexerBinding[]> {
    const selection = p.indexers ?? 'general';
    if (selection === 'general') return [];
    if (!envFlagEnabled(process.env.DOCUMENT_MULTI_INDEXER_ENABLED)) return [];
    const head = p.chunks[0]?.text ?? '';
    return this.router.route(
      p.companyId,
      {
        vertical: p.doc.vertical,
        head,
        requested: Array.isArray(selection) ? selection : undefined,
      },
      mode,
    );
  }

  private async runBinding(p: {
    companyId: string;
    doc: StoredDocument;
    chunks: DocumentChunk[];
    binding: IndexerBinding;
    abortSignal?: AbortSignal;
  }): Promise<IndexerRunResult> {
    const { binding } = p;
    return this.runs.runIndexer({
      companyId: p.companyId,
      doc: p.doc,
      chunks: p.chunks,
      packId: binding.indexerId,
      packVersion: binding.packVersion,
      executionMode: 'dedicated',
      model: binding.dedicated?.model ?? this.dedicated.modelId(),
      extract: (chunkText) =>
        this.dedicated.extract({
          text: chunkText,
          companyId: p.companyId,
          packId: binding.indexerId,
          options: binding.dedicated,
        }),
      abortSignal: p.abortSignal,
    });
  }
}
