import { Injectable } from '@nestjs/common';
import { Surreal } from 'surrealdb';
import { EmbedderService } from '../ai/embedder.service';
import { HypeService } from '../ai/hype.service';
import { idTailOf, shouldWriteHypeAltEmbedding } from './ingest-utils';

/**
 * Embedding-vector concerns for the ingest pipeline, on both ends of a fact
 * write:
 *  - input: embed / embedMany for the fact's `${predicate}: ${object}` text
 *    (the EmbedderService LRU caches per process, so re-ingest of identical
 *    clauses pays zero API calls);
 *  - output: HyPE post-INSERT alt-embedding (a hypothetical-question
 *    embedding) written onto the freshly-created fact.
 *
 * Grouped because both are vector operations and packaging hype here keeps
 * FactResolverService at ≤3 injected deps.
 */
@Injectable()
export class FactEmbeddingService {
  constructor(
    private readonly embedder: EmbedderService,
    private readonly hype: HypeService,
  ) {}

  embed(text: string): Promise<number[]> {
    return this.embedder.embed(text);
  }

  embedMany(texts: string[]): Promise<number[][]> {
    return this.embedder.embedMany(texts);
  }

  /**
   * HyPE post-INSERT alt-embedding write, shared by both ingest paths
   * (typed ingestFact + mention-extracted facts). We do this synchronously
   * inside the ingest flow so the post-condition "fact is searchable with
   * alt-embedding" holds immediately. Gated on shouldWriteHypeAltEmbedding
   * (INSERTED only, HyPE enabled, concrete factId); when HyPE is off
   * generateAltEmbedding returns null and we skip the UPDATE — no extra
   * ingest latency.
   */
  async writeAltEmbeddingIfHype({
    db,
    factId,
    outcome,
    predicate,
    object,
  }: {
    db: Surreal;
    factId: string | null;
    outcome: unknown;
    predicate: string;
    object: string;
  }): Promise<void> {
    if (!shouldWriteHypeAltEmbedding(outcome, this.hype.isEnabled(), factId)) {
      return;
    }
    const altEmbedding = await this.hype.generateAltEmbedding(predicate, object);
    if (!altEmbedding) return;
    await db.query(
      `UPDATE type::record('knowledge_fact', $tail) SET altEmbedding = $emb`,
      { tail: idTailOf(factId as string), emb: altEmbedding },
    );
  }
}
