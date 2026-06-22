import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { LRUCache } from '../common/lru-cache';
import type { ExtractionResult } from './extractor.service';

/**
 * Exact-key extraction cache for ExtractorService.
 *
 * The extractor's input → output mapping is deterministic in
 * (text, tenant, predicate-registry version). When all three are
 * identical the OpenAI round-trip is wasted work — the result is
 * literally the same bytes. Cache it.
 *
 * Key composition:
 *   • NFC(text)              — same words, same extraction
 *   • companyId              — tenants don't share vocab
 *   • predicateVocabHash     — derived from snapshot.versionHash;
 *                              changes when predicates are added /
 *                              aliased / deprecated, invalidating any
 *                              cached extractions that depended on
 *                              the prior vocab.
 *
 * Cached value is the post-validation, post-local-override,
 * post-canonicalize ExtractionResult — fully finalised. Spans are
 * character offsets into the input message, so on byte-identical
 * input they remain valid without re-validation.
 *
 * This is the foundation layer for the extractor hybrid pipeline
 * (symmetric with ChatRouterCacheService, Sprint 1). Subsequent
 * sprints add local NER, clause splitting, predicate selection,
 * pattern caches, and the skip-LLM gate that lets the extraction run
 * without the OpenAI call at all.
 */
@Injectable()
export class ExtractorCacheService {
  private readonly logger = new Logger(ExtractorCacheService.name);
  private readonly cache: LRUCache<string, ExtractionResult>;
  private readonly enabled: boolean;
  private hits = 0;
  private misses = 0;

  constructor(private readonly config: ConfigService) {
    const size = parseInt(
      this.config.get<string>('EXTRACTOR_CACHE_SIZE', '500'),
      10,
    );
    this.enabled =
      this.config.get<string>('EXTRACTOR_CACHE_ENABLED', 'true') !== 'false';
    this.cache = new LRUCache<string, ExtractionResult>(size);
  }

  computeKey(input: {
    text: string;
    companyId: string;
    predicateVocabHash: string;
    scPasses?: number;
  }): string {
    // scPasses is part of the key: a single-pass cached result lacks the
    // semantic-entropy fields a >1-pass run produces, so serving it after
    // EXTRACTOR_SC_PASSES is raised would return a stale-shaped extraction.
    // Default to 1 so callers that don't pass it (and pre-existing keys)
    // map to the historical single-pass bucket.
    const parts = [
      'v2',
      input.companyId,
      input.predicateVocabHash,
      `sc=${input.scPasses ?? 1}`,
      nfc(input.text),
    ].join('\x1f');
    return createHash('sha256').update(parts).digest('hex');
  }

  get(key: string): ExtractionResult | undefined {
    if (!this.enabled) return undefined;
    const hit = this.cache.get(key);
    if (hit) this.hits++;
    else this.misses++;
    return hit;
  }

  set(key: string, result: ExtractionResult): void {
    if (!this.enabled) return;
    this.cache.set(key, result);
  }

  stats(): {
    size: number;
    hits: number;
    misses: number;
    hitRate: number;
    enabled: boolean;
  } {
    const total = this.hits + this.misses;
    return {
      size: this.cache.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total === 0 ? 0 : this.hits / total,
      enabled: this.enabled,
    };
  }

  resetStats(): void {
    this.hits = 0;
    this.misses = 0;
  }
}

function nfc(s: string): string {
  return s.normalize('NFC');
}
