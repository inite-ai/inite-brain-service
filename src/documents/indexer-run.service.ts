import { Injectable, Optional } from '@nestjs/common';
import { ExtractorService } from '../ai/extractor.service';
import type { ExtractionResult } from '../ai/extractor-internals/types';
import { MetricsService } from '../metrics/metrics.service';
import { traceSpan } from '../common/debug-trace';
import {
  CandidateBatch,
  GENERAL_INDEXER_ID,
  IndexerExecutionMode,
} from '../indexers/candidate.types';
import { CandidateStoreService } from './candidate-store.service';
import type { DocumentChunk } from './chunker';
import type { StoredDocument } from './document-store.service';

export interface IndexerRunResult {
  runId: string;
  packId: string;
  status: 'succeeded' | 'skipped' | 'failed';
  stats?: {
    chunks: number;
    entities: number;
    facts: number;
    relations: number;
    durationMs: number;
  };
}

/** One indexer execution over a document, supplied by the dispatcher. */
export interface IndexerRunSpec {
  companyId: string;
  doc: StoredDocument;
  chunks: DocumentChunk[];
  packId: string;
  packVersion: string;
  executionMode: IndexerExecutionMode;
  model: string;
  registryVersionHash?: string;
  /** The actual extraction — union or pack-scoped dedicated. */
  extract: (chunkText: string) => Promise<ExtractionResult>;
}

/**
 * The Indexer layer's staging engine: run ONE indexer (any execution
 * mode) over a document's chunks and stage the output as candidates.
 * Which indexers run — and with what extraction — is the dispatcher's
 * decision; this service owns the run ledger + candidate staging only.
 *
 * Idempotent per (doc, packId, packVersion): the indexer_run UNIQUE
 * index makes a re-run a skip, which is what re-POSTs and re-index
 * backfills lean on.
 */
@Injectable()
export class IndexerRunService {
  constructor(
    private readonly extractor: ExtractorService,
    private readonly candidates: CandidateStoreService,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  /**
   * The pack-less generalist ('_general') pass — today's union extractor
   * as an indexer. Virtual composition happens at the candidate level:
   * fact rows attribute their owning pack by predicate namespace, so
   * "one document, N indexers" is true with zero extra LLM calls.
   */
  async runGeneral(p: {
    companyId: string;
    doc: StoredDocument;
    chunks: DocumentChunk[];
  }): Promise<IndexerRunResult> {
    return this.runIndexer({
      companyId: p.companyId,
      doc: p.doc,
      chunks: p.chunks,
      packId: GENERAL_INDEXER_ID,
      packVersion: '0',
      executionMode: 'virtual',
      model: this.extractor.modelId(),
      registryVersionHash: await this.extractor.vocabularyVersionHash(p.companyId),
      extract: (chunkText) => this.extractor.extract(chunkText, p.companyId),
    });
  }

  async runIndexer(spec: IndexerRunSpec): Promise<IndexerRunResult> {
    const startedAt = Date.now();
    const run = await this.candidates.createRun(spec.companyId, {
      docId: spec.doc.id,
      packId: spec.packId,
      packVersion: spec.packVersion,
      model: spec.model,
      registryVersionHash: spec.registryVersionHash,
    });
    if (!run.created) {
      this.metrics?.countIndexerRun('skipped_duplicate');
      return { runId: run.runId, packId: spec.packId, status: 'skipped' };
    }

    const stats = { chunks: 0, entities: 0, facts: 0, relations: 0, durationMs: 0 };
    try {
      for (const chunk of spec.chunks) {
        const extraction = await traceSpan(
          'indexer.run.extract',
          () => spec.extract(chunk.text),
          { packId: spec.packId, chunkSeq: chunk.seq },
        );
        const batch: CandidateBatch = {
          provenance: {
            indexerId: spec.packId,
            packVersion: spec.packVersion,
            executionMode: spec.executionMode,
            model: spec.model,
          },
          entities: extraction.entities.map((e, i) => ({ ...e, entityIndex: i })),
          facts: extraction.facts,
          relations: extraction.edges,
        };
        const counts = await this.candidates.insertBatch(spec.companyId, {
          docId: spec.doc.id,
          runId: run.runId,
          chunkSeq: chunk.seq,
          batch,
        });
        stats.chunks += 1;
        stats.entities += counts.entities;
        stats.facts += counts.facts;
        stats.relations += counts.relations;
      }
      stats.durationMs = Date.now() - startedAt;
      await this.candidates.finalizeRun(spec.companyId, {
        runId: run.runId,
        status: 'succeeded',
        stats,
      });
      this.metrics?.countIndexerRun('succeeded');
      return { runId: run.runId, packId: spec.packId, status: 'succeeded', stats };
    } catch (err) {
      await this.candidates
        .finalizeRun(spec.companyId, {
          runId: run.runId,
          status: 'failed',
          error: { message: (err as Error).message },
        })
        .catch(() => undefined);
      this.metrics?.countIndexerRun('failed');
      throw err;
    }
  }
}
