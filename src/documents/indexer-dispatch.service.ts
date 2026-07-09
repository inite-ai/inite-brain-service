import { Injectable, Logger } from '@nestjs/common';
import { envFlagEnabled } from '../common/env-validation';
import { IndexerRouterService } from '../indexers/indexer-router.service';
import { DedicatedExtractorService } from '../indexers/dedicated-extractor.service';
import type { IndexerBinding } from '../indexers/routing';
import { GENERAL_INDEXER_ID } from '../indexers/candidate.types';
import { IndexerRunService, IndexerRunResult } from './indexer-run.service';
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

  constructor(
    private readonly router: IndexerRouterService,
    private readonly runs: IndexerRunService,
    private readonly dedicated: DedicatedExtractorService,
  ) {}

  async dispatchSync(p: {
    companyId: string;
    doc: StoredDocument;
    chunks: DocumentChunk[];
    indexers?: IndexerSelection;
  }): Promise<IndexerRunResult[]> {
    const results: IndexerRunResult[] = [
      await this.runs.runGeneral(p),
    ];
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
  async bindingFor(
    companyId: string,
    packId: string,
  ): Promise<IndexerBinding | null> {
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
  }): Promise<IndexerRunResult> {
    if (p.packId === GENERAL_INDEXER_ID) {
      return this.runs.runGeneral(p);
    }
    const binding = await this.bindingFor(p.companyId, p.packId);
    if (!binding) {
      throw new Error(`unknown indexer pack "${p.packId}"`);
    }
    return this.runBinding({ ...p, binding });
  }

  /** Dedicated bindings this document should get, honoring flag + selection. */
  async selectDedicated(p: {
    companyId: string;
    doc: StoredDocument;
    chunks: DocumentChunk[];
    indexers?: IndexerSelection;
  }): Promise<IndexerBinding[]> {
    const selection = p.indexers ?? 'general';
    if (selection === 'general') return [];
    if (!envFlagEnabled(process.env.DOCUMENT_MULTI_INDEXER_ENABLED)) return [];
    const head = p.chunks[0]?.text ?? '';
    return this.router.route(p.companyId, {
      vertical: p.doc.vertical,
      head,
      requested: Array.isArray(selection) ? selection : undefined,
    });
  }

  private async runBinding(p: {
    companyId: string;
    doc: StoredDocument;
    chunks: DocumentChunk[];
    binding: IndexerBinding;
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
    });
  }
}
