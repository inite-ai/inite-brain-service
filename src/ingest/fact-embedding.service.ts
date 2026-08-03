import { Injectable } from '@nestjs/common';
import { EmbedderService } from '../ai/embedder.service';

/**
 * Embedding-vector concerns for the ingest pipeline: embed / embedMany
 * for the fact's `${predicate}: ${object}` text (the EmbedderService LRU
 * caches per process, so re-ingest of identical clauses pays zero API
 * calls). Kept as its own service so FactResolverService stays at ≤3
 * injected deps.
 */
@Injectable()
export class FactEmbeddingService {
  constructor(private readonly embedder: EmbedderService) {}

  embed(text: string): Promise<number[]> {
    return this.embedder.embed(text);
  }

  embedMany(texts: string[]): Promise<number[][]> {
    return this.embedder.embedMany(texts);
  }
}
