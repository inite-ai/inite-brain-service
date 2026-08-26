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

  /**
   * Canonical id of the embedding space that would serve RIGHT NOW
   * (`provider:model:dim:norm`, the 0101 idiom) — passthrough to
   * EmbedderService.activeSpaceId so consumers of THIS facade (the scene
   * version fingerprint) can name the space their embedMany calls land in
   * without a second embedder dependency.
   */
  activeSpaceId(): string {
    return this.embedder.activeSpaceId();
  }
}
