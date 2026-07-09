import { Injectable, Optional } from '@nestjs/common';
import { ExtractorService } from '../ai/extractor.service';
import { MetricsService } from '../metrics/metrics.service';
import { traceSpan } from '../common/debug-trace';
import {
  CandidateBatch,
  GENERAL_INDEXER_ID,
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

/**
 * The Indexer layer, wave 1: run the pack-less generalist ('_general')
 * pass over a document's chunks and stage the output as candidates.
 *
 * '_general' IS today's union extractor — one LLM call per chunk with the
 * tenant's full predicate vocabulary. Virtual composition happens at the
 * candidate level: each fact row attributes its owning pack by predicate
 * namespace (CandidateStoreService), so "one document, N indexers" is
 * true without a single extra LLM call. Dedicated per-pack runs plug in
 * beside this service later without touching it.
 */
@Injectable()
export class IndexerRunService {
  constructor(
    private readonly extractor: ExtractorService,
    private readonly candidates: CandidateStoreService,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  /**
   * Idempotent per (doc, '_general', '0'): a re-POST of an already-indexed
   * document skips instead of re-extracting (the indexer_run UNIQUE index
   * is the ledger). Chunks arrive from the caller — for storeContent=false
   * documents they exist only in this request's memory.
   */
  async runGeneral(p: {
    companyId: string;
    doc: StoredDocument;
    chunks: DocumentChunk[];
  }): Promise<IndexerRunResult> {
    const startedAt = Date.now();
    const versionHash = await this.extractor.vocabularyVersionHash(p.companyId);
    const run = await this.candidates.createRun(p.companyId, {
      docId: p.doc.id,
      packId: GENERAL_INDEXER_ID,
      packVersion: '0',
      model: this.extractor.modelId(),
      registryVersionHash: versionHash,
    });
    if (!run.created) {
      this.metrics?.countIndexerRun('skipped_duplicate');
      return { runId: run.runId, packId: GENERAL_INDEXER_ID, status: 'skipped' };
    }

    const stats = { chunks: 0, entities: 0, facts: 0, relations: 0, durationMs: 0 };
    try {
      for (const chunk of p.chunks) {
        const extraction = await traceSpan(
          'indexer.run.extract',
          () => this.extractor.extract(chunk.text, p.companyId),
          { packId: GENERAL_INDEXER_ID, chunkSeq: chunk.seq },
        );
        const batch: CandidateBatch = {
          provenance: {
            indexerId: GENERAL_INDEXER_ID,
            packVersion: '0',
            executionMode: 'virtual',
            model: this.extractor.modelId(),
          },
          entities: extraction.entities.map((e, i) => ({ ...e, entityIndex: i })),
          facts: extraction.facts,
          relations: extraction.edges,
        };
        const counts = await this.candidates.insertBatch(p.companyId, {
          docId: p.doc.id,
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
      await this.candidates.finalizeRun(p.companyId, {
        runId: run.runId,
        status: 'succeeded',
        stats,
      });
      this.metrics?.countIndexerRun('succeeded');
      return { runId: run.runId, packId: GENERAL_INDEXER_ID, status: 'succeeded', stats };
    } catch (err) {
      await this.candidates
        .finalizeRun(p.companyId, {
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
