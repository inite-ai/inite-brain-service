import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { Semaphore } from '../common/semaphore';
import { traceArtifact } from '../common/debug-trace';
import {
  PredicateRegistryService,
  CORE_PREDICATES,
  PredicateDefinition,
  PredicateSnapshot,
} from './predicate-registry.service';
import { LocalPredicateSelectorService } from './local-predicate-selector.service';
import { ExtractorCacheService } from './extractor-cache.service';
import { splitClauses } from './clause-splitter';
import { LocalNerService } from './local-ner.service';
import { ExtractionPatternService } from './extraction-pattern.service';

import type {
  ExtractedEntity,
  ExtractedFact,
  ExtractionResult,
} from './extractor-internals/types';
import {
  EXTRACTION_PROMPT_HEADER,
  buildExtractionSchema,
  buildSystemPrompt,
  renderPredicateCard,
} from './extractor-internals/prompts';
import {
  applyGroundingGate,
  parseClauses,
  parseEntities,
  parseRawFacts,
} from './extractor-internals/grounding';
import { validateEdges } from './extractor-internals/edge-validator';
import { attemptLocalSynth } from './extractor-internals/local-synth';
import {
  applyCanonicalizePass,
  applyLocalPredicateOverrides,
} from './extractor-internals/predicate-canonicalize';
import { persistExtractionPatterns } from './extractor-internals/pattern-emitter';

export type {
  ExtractedEntity,
  ExtractedFact,
  ExtractedEdge,
  ExtractionResult,
} from './extractor-internals/types';

/**
 * Closed-vocabulary, span-grounded entity-and-fact extractor.
 *
 * Pipeline stages — each lives in its own module under
 * `./extractor-internals/`:
 *   1. Predicate registry snapshot + system-prompt assembly (`prompts.ts`)
 *   2. Cache lookup (existing ExtractorCacheService)
 *   3. Local pre-pass: clause split (`clause-splitter`), local NER
 *      (`local-ner.service`), skip-LLM gate via cached patterns
 *      (`local-synth.ts`)
 *   4. LLM call — this file (one OpenAI round-trip, json_schema strict)
 *   5. Response parsing + span grounding (`grounding.ts`)
 *   6. Edge validation (`edge-validator.ts`)
 *   7. Local predicate-override + EDC canonicalize
 *      (`predicate-canonicalize.ts`)
 *   8. Cache write + pattern emission (`pattern-emitter.ts`)
 *
 * One LLM call per ingest, json_schema strict, no retry loop in the
 * hot path — server-side validation drops malformed facts and traces
 * them for offline schema iteration (PARSE recommendation).
 */
export const PREDICATE_VOCABULARY = CORE_PREDICATES.map((p) => p.predicateId);

@Injectable()
export class ExtractorService {
  private readonly logger = new Logger(ExtractorService.name);
  private readonly openai: OpenAI;
  private readonly model: string;
  private readonly systemPromptHeader: string;
  private readonly limiter: Semaphore;

  constructor(
    private readonly configService: ConfigService,
    private readonly registry: PredicateRegistryService,
    private readonly localPredicates: LocalPredicateSelectorService,
    private readonly extractionCache: ExtractorCacheService,
    private readonly localNer: LocalNerService,
    private readonly extractionPatterns: ExtractionPatternService,
  ) {
    const timeoutMs = parseInt(
      this.configService.get<string>('OPENAI_TIMEOUT_MS', '30000'),
      10,
    );
    const maxRetries = parseInt(
      this.configService.get<string>('OPENAI_MAX_RETRIES', '3'),
      10,
    );
    this.openai = new OpenAI({
      apiKey: this.configService.getOrThrow<string>('OPENAI_API_KEY'),
      timeout: timeoutMs,
      maxRetries,
    });
    this.model = this.configService.get<string>(
      'OPENAI_CHAT_MODEL',
      'gpt-4o-mini',
    );
    // The static EXTRACTION_SYSTEM_PROMPT override is no longer the
    // source of truth for vocabulary — that's the registry. The env
    // var stays as an escape hatch for operators who want to fully
    // replace the prompt header (everything before the dynamically-
    // rendered predicate cards).
    this.systemPromptHeader =
      this.configService.get<string>('EXTRACTION_SYSTEM_PROMPT') ??
      EXTRACTION_PROMPT_HEADER;
    this.limiter = new Semaphore(
      parseInt(this.configService.get<string>('OPENAI_CONCURRENCY', '8'), 10),
    );
  }

  async extract(
    text: string,
    companyId: string,
  ): Promise<ExtractionResult> {
    const trimmed = text.trim();
    if (!trimmed) return { entities: [], facts: [], edges: [] };

    const snapshot = await this.loadSnapshot(companyId);
    const systemPrompt = this.composeSystemPrompt(snapshot);
    const cacheKey = this.extractionCache.computeKey({
      text: trimmed,
      companyId,
      predicateVocabHash: snapshot.versionHash,
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

    const skipResult = await this.tryLocalSkip(companyId, trimmed, cacheKey);
    if (skipResult) return skipResult;

    traceArtifact('extractor.vocab', {
      versionHash: snapshot.versionHash,
      predicateCount: snapshot.active.length,
      predicateIds: snapshot.active.map((p) => p.predicateId),
    });

    const rawJson = await this.callLlm(trimmed, systemPrompt);
    if (!rawJson) return { entities: [], facts: [], edges: [] };

    return this.assembleResult({
      companyId,
      trimmed,
      cacheKey,
      snapshot,
      rawJson,
    });
  }

  // ── Pre-LLM stages ────────────────────────────────────────────────

  private async loadSnapshot(
    companyId: string,
  ): Promise<{ versionHash: string; active: PredicateDefinition[] }> {
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

  private composeSystemPrompt(snapshot: {
    active: PredicateDefinition[];
  }): string {
    return this.systemPromptHeader === EXTRACTION_PROMPT_HEADER
      ? buildSystemPrompt(snapshot.active)
      : this.systemPromptHeader +
          snapshot.active.map(renderPredicateCard).join('\n');
  }

  private async tryLocalSkip(
    companyId: string,
    trimmed: string,
    cacheKey: string,
  ): Promise<ExtractionResult | null> {
    const localClauses = splitClauses(trimmed);
    traceArtifact('extractor.local_clauses', {
      count: localClauses.length,
      clauses: localClauses,
    });
    let localEntities: Awaited<ReturnType<LocalNerService['extract']>> = [];
    if (this.localNer.isReady()) {
      localEntities = await this.localNer.extract(trimmed);
      if (localEntities.length > 0) {
        traceArtifact('extractor.local_entities', {
          count: localEntities.length,
          entities: localEntities,
        });
      }
    }
    const skipEnabled =
      this.configService.get<string>('EXTRACTOR_SKIP_LLM_ENABLED', 'false') ===
      'true';
    if (!skipEnabled) return null;
    if (localClauses.length === 0) {
      traceArtifact('extractor.skip_decision', {
        skip: false,
        reason: 'no_local_clauses',
      });
      return null;
    }
    if (localEntities.length === 0) {
      traceArtifact('extractor.skip_decision', {
        skip: false,
        reason: 'no_local_entities',
      });
      return null;
    }
    const synthesised = await attemptLocalSynth(
      this.extractionPatterns,
      companyId,
      trimmed,
      localClauses.map((c) => c.text),
      localEntities,
    );
    if (!synthesised) {
      traceArtifact('extractor.skip_decision', {
        skip: false,
        reason: 'partial_coverage',
      });
      return null;
    }
    traceArtifact('extractor.skip_decision', { skip: true, reason: 'all_local' });
    this.extractionCache.set(cacheKey, synthesised);
    return synthesised;
  }

  // ── LLM call + response assembly ──────────────────────────────────

  private async callLlm(trimmed: string, systemPrompt: string): Promise<any> {
    const res = await this.limiter.run(() =>
      this.openai.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: trimmed },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'extraction',
            strict: true,
            schema: buildExtractionSchema(),
          },
        },
        max_completion_tokens: 1500,
        temperature: 0.1,
      }),
    );
    const content = res.choices[0]?.message?.content;
    if (!content) return null;
    try {
      return JSON.parse(content);
    } catch (err) {
      this.logger.warn(
        `Extractor returned non-JSON: ${(err as Error).message}`,
      );
      return null;
    }
  }

  private async assembleResult(args: {
    companyId: string;
    trimmed: string;
    cacheKey: string;
    snapshot: { versionHash: string; active: PredicateDefinition[] };
    rawJson: any;
  }): Promise<ExtractionResult> {
    const { companyId, trimmed, cacheKey, snapshot, rawJson } = args;

    const entities: ExtractedEntity[] = parseEntities(rawJson);
    const clauses = parseClauses(rawJson);
    const rawFacts = parseRawFacts(rawJson, entities.length);
    const { facts, dropped } = applyGroundingGate(trimmed, rawFacts, clauses);

    if (dropped.length > 0) {
      this.logger.warn(
        `extractor dropped ${dropped.length} fact(s) that failed span-grounding: ${dropped
          .map((d) => `${d.predicate}="${d.claimedValueSpan}" (${d.reason})`)
          .join('; ')}`,
      );
      traceArtifact('extractor.invalid_value_span', {
        droppedCount: dropped.length,
        dropped,
        normalizedInputPreview: trimmed.slice(0, 200),
      });
    }
    if (clauses.length > 0) traceArtifact('extractor.clauses', clauses);

    const { edges, dropped: droppedEdges } = validateEdges(
      rawJson,
      entities.length,
      clauses,
    );
    if (edges.length > 0) traceArtifact('extractor.edges', edges);
    if (droppedEdges.length > 0) {
      traceArtifact('extractor.invalid_edges', { dropped: droppedEdges });
    }

    await this.applyPredicateRefinements(facts, snapshot, companyId);

    const result: ExtractionResult = { entities, facts, edges };
    this.extractionCache.set(cacheKey, result);

    void persistExtractionPatterns(
      this.extractionPatterns,
      this.logger,
      companyId,
      clauses,
      rawFacts,
      facts,
      edges,
    );

    return result;
  }

  private async applyPredicateRefinements(
    facts: ExtractedFact[],
    snapshot: { versionHash: string; active: PredicateDefinition[] },
    companyId: string,
  ): Promise<void> {
    const localThreshold = parseFloat(
      this.configService.get<string>(
        'EXTRACTOR_LOCAL_PREDICATE_THRESHOLD',
        '0.45',
      ),
    );
    const localOverrides = await applyLocalPredicateOverrides(
      facts,
      snapshot as PredicateSnapshot,
      this.localPredicates,
      localThreshold,
    );
    if (localOverrides.length > 0) {
      traceArtifact('extractor.local_predicate_override', {
        threshold: localThreshold,
        decisions: localOverrides,
      });
    }
    try {
      if (facts.length === 0) return;
      const decisions = await applyCanonicalizePass(
        facts,
        this.registry,
        companyId,
        this.logger,
      );
      if (decisions.length > 0) {
        traceArtifact('extractor.canonicalize', decisions);
      }
    } catch (e) {
      this.logger.warn(
        `extractor: canonicalize pass failed: ${(e as Error).message}; keeping model-emitted predicates`,
      );
    }
  }
}
