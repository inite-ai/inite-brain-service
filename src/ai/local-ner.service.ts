import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LRUCache } from '../common/lru-cache';

/**
 * Local multilingual NER via @xenova/transformers token-classification.
 *
 * Architecture mirrors IntentClassifierService (Sprint 4.5 in the
 * chat router):
 *   • Lazy-load the ONNX model on module init in the background
 *     (never blocks boot). Default disabled (EXTRACTOR_LOCAL_NER_ENABLED=
 *     "false") so deployments that don't opt in pay no runtime cost.
 *   • Until ready, extract() returns [] and the caller treats that as
 *     "no local entities" — the LLM extraction still runs.
 *   • Once ready, extract() runs the model and returns the entity
 *     spans + types + scores. The extractor emits this as a trace
 *     artifact today; subsequent sprints (E7 skip gate) will consume
 *     it as a fast-path local entity source.
 *
 * Default model: Xenova/bert-base-multilingual-cased-ner-hrl
 * (~135MB ONNX). Multilingual (EN/RU/many more), CONLL-2003-style
 * tags (PER, ORG, LOC, MISC). Override with EXTRACTOR_LOCAL_NER_MODEL
 * when a vertical needs custom labels (gliner-style zero-shot would
 * fit that case; this service would change the pipeline type).
 *
 * No hardcoded entity vocabulary — labels come from the model.
 */

type TokenClassificationPipeline = (
  text: string,
  options?: { aggregation_strategy?: string },
) => Promise<
  Array<{
    entity_group?: string;
    entity?: string;
    word: string;
    start: number;
    end: number;
    score: number;
  }>
>;

export interface LocalEntity {
  text: string;
  type: string;
  start: number;
  end: number;
  score: number;
}

const CACHE_SIZE = 1000;
const DEFAULT_MODEL = 'Xenova/bert-base-multilingual-cased-ner-hrl';

@Injectable()
export class LocalNerService implements OnModuleInit {
  private readonly logger = new Logger(LocalNerService.name);
  private readonly modelId: string;
  private readonly enabled: boolean;
  private readonly minScore: number;
  private classifier: TokenClassificationPipeline | null = null;
  private readonly cache = new LRUCache<string, LocalEntity[]>(CACHE_SIZE);

  constructor(private readonly config: ConfigService) {
    this.enabled =
      this.config.get<string>('EXTRACTOR_LOCAL_NER_ENABLED', 'false') ===
      'true';
    this.modelId = this.config.get<string>(
      'EXTRACTOR_LOCAL_NER_MODEL',
      DEFAULT_MODEL,
    );
    this.minScore = parseFloat(
      this.config.get<string>('EXTRACTOR_LOCAL_NER_MIN_SCORE', '0.7'),
    );
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.log(
        'Local NER disabled (EXTRACTOR_LOCAL_NER_ENABLED=false). Set to "true" to enable background warmup.',
      );
      return;
    }
    void this.warmup();
  }

  isReady(): boolean {
    return this.classifier !== null;
  }

  /** Test seam — drive the NER code path without loading the real model. */
  setClassifierForTesting(p: TokenClassificationPipeline | null): void {
    this.classifier = p;
    this.cache.clear();
  }

  private async warmup(): Promise<void> {
    const start = Date.now();
    try {
      const transformers = await import('@xenova/transformers');
      this.classifier = (await transformers.pipeline(
        'token-classification',
        this.modelId,
      )) as unknown as TokenClassificationPipeline;
      this.logger.log(
        `Local NER ready (${this.modelId}) — warmup ${Date.now() - start}ms`,
      );
    } catch (e) {
      this.logger.warn(
        `Local NER warmup failed for ${this.modelId}: ${(e as Error).message}; extractor stays LLM-only for NER`,
      );
      this.classifier = null;
    }
  }

  async extract(text: string): Promise<LocalEntity[]> {
    if (!this.classifier) return [];
    const trimmed = text.trim();
    if (trimmed.length === 0) return [];
    const cached = this.cache.get(trimmed);
    if (cached) return cached;
    try {
      const raw = await this.classifier(trimmed, {
        aggregation_strategy: 'simple',
      });
      const entities: LocalEntity[] = [];
      for (const r of raw) {
        if (r.score < this.minScore) continue;
        entities.push({
          text: r.word,
          type: (r.entity_group ?? r.entity ?? 'MISC').toUpperCase(),
          start: r.start,
          end: r.end,
          score: r.score,
        });
      }
      this.cache.set(trimmed, entities);
      return entities;
    } catch (e) {
      this.logger.warn(
        `Local NER extract failed for "${trimmed.slice(0, 60)}": ${(e as Error).message}; returning []`,
      );
      return [];
    }
  }

  stats(): {
    enabled: boolean;
    ready: boolean;
    model: string;
    minScore: number;
    cacheSize: number;
  } {
    return {
      enabled: this.enabled,
      ready: this.classifier !== null,
      model: this.modelId,
      minScore: this.minScore,
      cacheSize: this.cache.size,
    };
  }
}
