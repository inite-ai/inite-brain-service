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

  /**
   * Both methods route to the WRITE-guarded embedder entrypoints: every
   * consumer of this facade (fact resolution, the scene / arc / segment /
   * aggregate composers, the window deriver, scene gist backfill)
   * persists the vector it gets back. During the bge-m3 warmup window the
   * embedder would otherwise hand back a 1536-wide OpenAI vector, which
   * lands unvalidated in a 1024-wide corpus and durably breaks cosine
   * search for the whole table.
   *
   * Resolution-only comparisons inside an ingest go through here too, and
   * that is intended: the comparison exists to decide a write in the same
   * request, so failing the request beats resolving against a
   * cross-space score and then persisting the result.
   */
  embed(text: string): Promise<number[]> {
    return this.embedder.embedForWrite(text);
  }

  embedMany(texts: string[]): Promise<number[][]> {
    return this.embedder.embedManyForWrite(texts);
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
