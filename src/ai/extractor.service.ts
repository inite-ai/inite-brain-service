import { Injectable, Logger } from '@nestjs/common';
import { clampLlmInputText } from '../common/input-limits';
import { traceArtifact } from '../common/debug-trace';
import {
  PredicateRegistryService,
  CORE_PREDICATES,
  PredicateDefinition,
} from './predicate-registry.service';
import type { PackExtractionProfile } from './predicate-registry-internals/types';
import { ExtractorCacheService } from './extractor-cache.service';
import { ExtractorRunnerService } from './extractor-runner.service';
import type { ExtractionResult } from './extractor-internals/types';

export type {
  ExtractedEntity,
  ExtractedFact,
  ExtractedEdge,
  ExtractionResult,
} from './extractor-internals/types';

/**
 * Closed-vocabulary, span-grounded entity-and-fact extractor.
 *
 * This class is the thin entry point: input clamp, predicate-registry
 * snapshot, extraction-cache memoisation, and delegation to
 * ExtractorRunnerService (which sequences the local-skip / LLM /
 * grounding / refinement / pattern-emission stages across
 * ExtractorLlmService, ExtractorLocalService, ExtractorRefineService).
 * Each extractor class keeps ≤3 injected deps.
 *
 * One LLM call per ingest (json_schema strict, no hot-path retry);
 * server-side validation drops malformed facts and traces them.
 */
export const PREDICATE_VOCABULARY = CORE_PREDICATES.map((p) => p.predicateId);

@Injectable()
export class ExtractorService {
  private readonly logger = new Logger(ExtractorService.name);

  constructor(
    private readonly extractionCache: ExtractorCacheService,
    private readonly registry: PredicateRegistryService,
    private readonly runner: ExtractorRunnerService,
  ) {}

  /** Identity of the extraction model — default source.recorder. */
  modelId(): string {
    return this.runner.modelId();
  }

  /**
   * The tenant's predicate-vocabulary version hash — the extraction-cache
   * identity. Recorded on indexer_run rows so a run is attributable to
   * the exact vocabulary it extracted with; undefined when the registry
   * is unreachable (the run still proceeds on the seed vocabulary).
   */
  async vocabularyVersionHash(companyId: string): Promise<string | undefined> {
    try {
      return (await this.registry.getSnapshot(companyId)).versionHash;
    } catch {
      return undefined;
    }
  }

  async extract(text: string, companyId: string): Promise<ExtractionResult> {
    // Defence in depth — DTOs already cap at 16K, but MCP and the
    // admin-demo inline body shapes don't pass through class-validator.
    const { value: trimmed, truncated } = clampLlmInputText(text, 'mentionText');
    if (!trimmed) return { entities: [], facts: [], edges: [] };
    if (truncated) {
      this.logger.warn(
        `extractor: input truncated to ${trimmed.length} chars (companyId=${companyId})`,
      );
      traceArtifact('extractor.input_truncated', { finalLength: trimmed.length });
    }

    const snapshot = await this.loadSnapshot(companyId);
    const cacheKey = this.extractionCache.computeKey({
      text: trimmed,
      companyId,
      predicateVocabHash: snapshot.versionHash,
      scPasses: this.runner.scPasses,
    });
    const cached = this.extractionCache.get(cacheKey);
    if (cached) {
      traceArtifact('extractor.cache_decision', {
        hit: true,
        key: cacheKey,
        registryVersionHash: snapshot.versionHash,
      });
      return cached;
    }
    traceArtifact('extractor.cache_decision', {
      hit: false,
      key: cacheKey,
      registryVersionHash: snapshot.versionHash,
    });

    const result = await this.runner.run({ trimmed, companyId, snapshot });
    if (!result) {
      // Transient LLM failure (null JSON / all SC passes failed). Return
      // empty WITHOUT caching — the no-TTL LRU would otherwise pin this
      // negative result for the (text, tenant, vocab) key and every
      // identical re-ingest would silently extract nothing (restores the
      // pre-#64 "failed extractions are never memoised" behaviour).
      traceArtifact('extractor.llm_failure_uncached', { key: cacheKey });
      return { entities: [], facts: [], edges: [] };
    }
    this.extractionCache.set(cacheKey, result);
    return result;
  }

  private async loadSnapshot(
    companyId: string,
  ): Promise<{
    versionHash: string;
    active: PredicateDefinition[];
    extractionProfiles?: PackExtractionProfile[];
  }> {
    try {
      return await this.registry.getSnapshot(companyId);
    } catch (e) {
      this.logger.warn(
        `extractor: registry getSnapshot failed for ${companyId}: ${(e as Error).message}; falling back to CORE_PREDICATES seed`,
      );
      return {
        versionHash: 'fallback-seed',
        active: CORE_PREDICATES.filter((p) => p.status === 'active'),
      };
    }
  }
}
