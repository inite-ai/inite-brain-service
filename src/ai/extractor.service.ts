import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { Semaphore } from '../common/semaphore';
import { clampLlmInputText } from '../common/input-limits';
import { traceArtifact } from '../common/debug-trace';
import { withGenAiCall } from '../common/gen-ai-observability';
import { getAbortSignal } from '../common/request-context';
import { MetricsService } from '../metrics/metrics.service';
import {
  clusterKey,
  selfConsistencyByFact,
} from './extractor-internals/semantic-entropy';
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
  groundEntities,
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
  private readonly scPasses: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly registry: PredicateRegistryService,
    private readonly localPredicates: LocalPredicateSelectorService,
    private readonly extractionCache: ExtractorCacheService,
    private readonly localNer: LocalNerService,
    private readonly extractionPatterns: ExtractionPatternService,
    @Optional() private readonly metrics?: MetricsService,
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
    // Self-consistency / N-pass driver. Default 1 = single-pass (the
    // historical single LLM call). When EXTRACTOR_SC_PASSES > 1 the
    // extractor fans N stochastic re-rolls in parallel and emits the
    // dominant-cluster facts annotated with semantic entropy + cluster
    // agreement (Farquhar Nature 2024, Nikitin NeurIPS 2024). Cost
    // scales linearly with N — kept opt-in for that reason.
    this.scPasses = Math.max(
      1,
      parseInt(this.configService.get<string>('EXTRACTOR_SC_PASSES', '1'), 10),
    );
  }

  /**
   * Identity of the extraction model — used as the default `source.recorder`
   * for mention-extracted facts so source-trust can score them per model.
   */
  modelId(): string {
    return this.model;
  }

  async extract(
    text: string,
    companyId: string,
  ): Promise<ExtractionResult> {
    // Defence in depth — DTOs already cap at 16K, but MCP and the
    // admin-demo inline body shapes don't pass through class-validator.
    // The cap MUST hold here too, otherwise a single rogue ingest can
    // burn the shared OpenAI budget. See common/input-limits.ts.
    const { value: trimmed, truncated } = clampLlmInputText(
      text,
      'mentionText',
    );
    if (!trimmed) return { entities: [], facts: [], edges: [] };
    if (truncated) {
      this.logger.warn(
        `extractor: input truncated to ${trimmed.length} chars (companyId=${companyId})`,
      );
      traceArtifact('extractor.input_truncated', {
        finalLength: trimmed.length,
      });
    }

    const snapshot = await this.loadSnapshot(companyId);
    const systemPrompt = this.composeSystemPrompt(snapshot);
    const cacheKey = this.extractionCache.computeKey({
      text: trimmed,
      companyId,
      predicateVocabHash: snapshot.versionHash,
      scPasses: this.scPasses,
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

    // N-pass self-consistency driver. When EXTRACTOR_SC_PASSES > 1 we
    // run the same prompt N times with varied temperature (stochastic
    // re-rolls), assemble per-pass extractions, then cluster facts
    // across passes by canonical predicate + normalised object span
    // (semantic-entropy.ts). The returned facts come from the dominant
    // cluster of each canonical (predicate, object) tuple and carry
    // per-fact `extractionEntropy` + `extractionAgreement` — a hallu-
    // cinated low-agreement fact lands in a singleton cluster and
    // gets a high-entropy tag so downstream confidence calibration
    // can discount it.
    if (this.scPasses > 1) {
      return this.runMultiPassExtract({
        companyId,
        trimmed,
        cacheKey,
        snapshot,
        systemPrompt,
      });
    }

    const rawJson = await this.callLlm(trimmed, systemPrompt, 0.1);
    if (!rawJson) return { entities: [], facts: [], edges: [] };

    return this.assembleResult({
      companyId,
      trimmed,
      cacheKey,
      snapshot,
      rawJson,
    });
  }

  /**
   * Run the extraction prompt N times in parallel with stepped
   * temperatures (more variance at higher T to seed cluster spread),
   * cluster the resulting facts, and emit a merged ExtractionResult
   * with each surviving fact tagged by its cluster's semantic entropy
   * + agreement rate.
   *
   * Entities and edges: merged across passes by dedupe-on-content (no
   * cluster math — they're far less prone to LLM variance than the
   * predicate/value pair, and the ingest side resolves entity
   * identity downstream anyway via externalRefs + identity links).
   */
  private async runMultiPassExtract(args: {
    companyId: string;
    trimmed: string;
    cacheKey: string;
    snapshot: { versionHash: string; active: PredicateDefinition[] };
    systemPrompt: string;
  }): Promise<ExtractionResult> {
    const N = this.scPasses;
    // Even temperature spread across [0.1, 0.7]. T=0.1 is the existing
    // single-pass setting (reproducibility anchor); the spread above it
    // produces the variance that surfaces a hallucination as a singleton
    // cluster. Bounded above at 0.7 — past that the LLM emits genuine
    // schema violations the grounding gate then has to drop anyway.
    const temperatures = Array.from(
      { length: N },
      (_, i) => 0.1 + (i * 0.6) / Math.max(N - 1, 1),
    );

    const rawJsons = await Promise.all(
      temperatures.map((t) =>
        this.callLlm(args.trimmed, args.systemPrompt, t).catch((e) => {
          this.logger.warn(`sc-pass T=${t.toFixed(2)} failed: ${(e as Error).message}`);
          return null;
        }),
      ),
    );
    const results = await Promise.all(
      rawJsons.map((rj) =>
        rj
          ? this.assembleResult({
              companyId: args.companyId,
              trimmed: args.trimmed,
              cacheKey: args.cacheKey,
              snapshot: args.snapshot,
              rawJson: rj,
            })
          : null,
      ),
    );
    const surviving = results.filter((r): r is ExtractionResult => !!r);
    if (surviving.length === 0) return { entities: [], facts: [], edges: [] };

    // Cluster facts across passes.
    const passFacts = surviving.map((r) =>
      r.facts.map((f) => ({ predicate: f.predicate, object: f.object })),
    );
    const sc = selfConsistencyByFact(passFacts);

    // Dedupe entities by canonical-or-name; merge edges by triple.
    const entityKey = (e: { name: string; type: string }) =>
      `${e.type}:${e.name.toLowerCase().trim()}`;
    const entityMap = new Map<string, ExtractionResult['entities'][number]>();
    for (const r of surviving) {
      for (const e of r.entities) {
        const k = entityKey(e);
        if (!entityMap.has(k)) entityMap.set(k, e);
      }
    }
    const entities = [...entityMap.values()];

    const edgeMap = new Map<string, ExtractionResult['edges'][number]>();
    for (const r of surviving) {
      for (const ed of r.edges) {
        const k = `${ed.fromEntityIndex}-${ed.kind}-${ed.toEntityIndex}`;
        if (!edgeMap.has(k)) edgeMap.set(k, ed);
      }
    }
    const edges = [...edgeMap.values()];

    // Dedupe facts: one entry per (predicate, normalisedObject) cluster.
    // Pick the first pass's variant as the exemplar so the verbatim
    // span survives. Attach entropy + agreement.
    const seenClusters = new Set<string>();
    const facts: ExtractionResult['facts'] = [];
    for (const r of surviving) {
      for (const f of r.facts) {
        const k = clusterKey({ predicate: f.predicate, object: f.object });
        if (seenClusters.has(k)) continue;
        seenClusters.add(k);
        const stats = sc.get(k);
        facts.push({
          ...f,
          ...(stats
            ? {
                extractionEntropy: stats.entropy,
                extractionAgreement: stats.agreement,
              }
            : {}),
        });
      }
    }

    traceArtifact('extractor.sc_passes', {
      passes: surviving.length,
      temperatures,
      clusterCount: sc.size,
      clusterEntropy: facts[0]?.extractionEntropy ?? 0,
    });

    return { entities, facts, edges };
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

  private async callLlm(
    trimmed: string,
    systemPrompt: string,
    temperature = 0.1,
  ): Promise<any> {
    const res = await this.limiter.run(() =>
      withGenAiCall(
        {
          kind: 'chat',
          spanName: 'gen_ai.chat.extractor',
          system: 'openai',
          model: this.model,
          attrs: { 'gen_ai.request.temperature': temperature },
        },
        this.metrics,
        () =>
          this.openai.chat.completions.create(
            {
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
              temperature,
            },
            { signal: getAbortSignal() },
          ),
      ),
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

    const parsedEntities: ExtractedEntity[] = parseEntities(rawJson);
    const clauses = parseClauses(rawJson);
    const rawFacts = parseRawFacts(rawJson, parsedEntities.length);
    const { facts: valueGroundedFacts, dropped } = applyGroundingGate(
      trimmed,
      rawFacts,
      clauses,
    );

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

    const { edges: parsedEdges, dropped: droppedEdges } = validateEdges(
      rawJson,
      parsedEntities.length,
      clauses,
    );
    if (droppedEdges.length > 0) {
      traceArtifact('extractor.invalid_edges', { dropped: droppedEdges });
    }

    // Entity span-grounding: drop entities whose name never appears in the
    // source, then re-index the surviving facts/edges onto the compacted
    // entity array. Ingest creates EVERY returned entity (not only those a
    // fact references), so an ungrounded name would otherwise materialise a
    // hallucinated entity record.
    const groundedMask = groundEntities(trimmed, parsedEntities);
    const remap = new Map<number, number>();
    const entities: ExtractedEntity[] = [];
    parsedEntities.forEach((e, i) => {
      if (groundedMask[i]) {
        remap.set(i, entities.length);
        entities.push(e);
      }
    });
    const facts = valueGroundedFacts
      .filter((f) => remap.has(f.entityIndex))
      .map((f) => ({ ...f, entityIndex: remap.get(f.entityIndex) as number }));
    const edges = parsedEdges
      .filter(
        (e) => remap.has(e.fromEntityIndex) && remap.has(e.toEntityIndex),
      )
      .map((e) => ({
        ...e,
        fromEntityIndex: remap.get(e.fromEntityIndex) as number,
        toEntityIndex: remap.get(e.toEntityIndex) as number,
      }));
    if (entities.length < parsedEntities.length) {
      const droppedNames = parsedEntities
        .filter((_, i) => !groundedMask[i])
        .map((e) => e.name);
      this.logger.warn(
        `extractor dropped ${droppedNames.length} entity(ies) that failed span-grounding: ${droppedNames.join('; ')}`,
      );
      traceArtifact('extractor.ungrounded_entities', {
        droppedCount: droppedNames.length,
        names: droppedNames,
      });
    }
    if (edges.length > 0) traceArtifact('extractor.edges', edges);

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
