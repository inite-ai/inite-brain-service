import { Injectable, Logger } from '@nestjs/common';
import { clampLlmInputText } from '../common/input-limits';
import { traceArtifact } from '../common/debug-trace';
import { PredicateRegistryService } from '../ai/predicate-registry.service';
import { ExtractorRunnerService } from '../ai/extractor-runner.service';
import { ExtractorCacheService } from '../ai/extractor-cache.service';
import type { ExtractionResult } from '../ai/extractor-internals/types';
import { filterSnapshotForPack } from './snapshot-filter';

export interface DedicatedRunOptions {
  includeCorePredicates?: boolean;
  model?: string;
  scPasses?: number;
}

/**
 * Pack-scoped extraction run — a DEDICATED indexer. Same engine as the
 * union extractor (ExtractorRunnerService: local-skip, LLM call,
 * span-grounding, refinement), but the system prompt carries ONLY this
 * pack's predicate cards + profile (plus core, by default), and the pack
 * may pin its own model / self-consistency budget
 * (IndexerDescriptor.dedicated).
 *
 * What this buys over virtual composition: a whole prompt budget for one
 * domain, per-domain model choice, independent failure, and a distinct
 * cache/calibration identity (the filtered versionHash + model ride the
 * cache key).
 */
@Injectable()
export class DedicatedExtractorService {
  private readonly logger = new Logger(DedicatedExtractorService.name);

  constructor(
    private readonly registry: PredicateRegistryService,
    private readonly runner: ExtractorRunnerService,
    private readonly cache: ExtractorCacheService,
  ) {}

  /** The default extraction model — run rows record it when no override. */
  modelId(): string {
    return this.runner.modelId();
  }

  async extract(p: {
    text: string;
    companyId: string;
    packId: string;
    options?: DedicatedRunOptions | undefined;
  }): Promise<ExtractionResult> {
    const { value: trimmed } = clampLlmInputText(p.text, 'mentionText');
    if (!trimmed) return { entities: [], facts: [], edges: [] };

    let full;
    try {
      full = await this.registry.getSnapshot(p.companyId);
    } catch (e) {
      // Without the registry there is no pack vocabulary to extract with —
      // an empty result (not the core seed) keeps the run honest.
      this.logger.warn(
        `dedicated extract: registry snapshot failed for ${p.companyId}: ${(e as Error).message}`,
      );
      return { entities: [], facts: [], edges: [] };
    }

    const snapshot = filterSnapshotForPack(full, {
      packId: p.packId,
      includeCorePredicates: p.options?.includeCorePredicates,
    });
    const scPasses = p.options?.scPasses ?? this.runner.scPasses;
    const cacheKey = this.cache.computeKey({
      text: trimmed,
      companyId: p.companyId,
      // Model rides the vocab-hash slot: a per-pack model override must
      // not serve another model's cached extraction.
      predicateVocabHash: `${snapshot.versionHash}:m=${p.options?.model ?? '_'}`,
      scPasses,
    });
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const result = await this.runner.run({
      trimmed,
      companyId: p.companyId,
      snapshot,
      overrides: {
        ...(p.options?.model !== undefined ? { model: p.options.model } : {}),
        scPasses,
      },
    });
    if (!result) {
      // Transient LLM failure — same no-cache contract as the union path.
      traceArtifact('indexer.dedicated.llm_failure_uncached', {
        packId: p.packId,
        key: cacheKey,
      });
      return { entities: [], facts: [], edges: [] };
    }
    this.cache.set(cacheKey, result);
    return result;
  }
}
