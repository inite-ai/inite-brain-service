import { Injectable, Logger, Optional } from '@nestjs/common';
import { traceArtifact } from '../common/debug-trace';
import { PredicateDefinition } from './predicate-registry.service';
import type { PackExtractionProfile } from './predicate-registry-internals/types';
import { ExtractorLlmService } from './extractor-llm.service';
import { ExtractorLocalService } from './extractor-local.service';
import { ExtractorRefineService } from './extractor-refine.service';
import { mergeExtractions } from './extractor-internals/merge';
import { detectFacets, type Facet } from './extractor-internals/facet-router';
import type { ExtractedEntity, ExtractedFact, ExtractionResult } from './extractor-internals/types';
import {
  applyGroundingGate,
  groundEntities,
  objectNormalizationEnabled,
  parseClauses,
  parseEntities,
  parseRawFacts,
} from './extractor-internals/grounding';
import { validateEdges } from './extractor-internals/edge-validator';
import { denoiseFacts } from './extractor-internals/denoise';
import { harvestLiterals, resolveSpeakerEntityIndex } from './extractor-internals/literal-harvest';
import { harvestStateVerbs } from './extractor-internals/state-verb-harvest';
import { harvestTransitions } from './extractor-internals/transition-harvest';
import {
  createTransitionClassifier,
  type TransitionClassifier,
} from './extractor-internals/transition-classifier';
import { EmbedderService } from './embedder.service';
import { resolveExtractionProfile } from './extraction-profile';
import {
  buildConversationContext,
  buildFacetSystemPrompt,
  type ConversationContext,
} from './extractor-internals/prompts';

export type { ConversationContext } from './extractor-internals/prompts';

type Snapshot = {
  versionHash: string;
  active: PredicateDefinition[];
  extractionProfiles?: PackExtractionProfile[];
};

/**
 * Per-run knobs for dedicated indexer runs (IndexerDescriptor.dedicated).
 * Absent = the process-global model / EXTRACTOR_SC_PASSES — the union
 * path's behavior, byte-identical.
 */
export interface RunOverrides {
  model?: string;
  scPasses?: number;
}

/**
 * ExtractorRunnerService — the extraction engine. Sequences the local
 * skip → LLM call (single or N-pass self-consistency) → response parsing
 * + span grounding + edge validation → predicate refinement → pattern
 * emission. Delegates each concern to ExtractorLlmService /
 * ExtractorLocalService / ExtractorRefineService. The predicate snapshot
 * is supplied by the caller (ExtractorService, which owns the cache);
 * this class holds no cache/registry dep — its 3 required deps stay the
 * pipeline stages, plus an OPTIONAL EmbedderService used only by the
 * flag-gated transition-classifier lane (absent embedder → lane skipped,
 * never a boot failure).
 */
@Injectable()
export class ExtractorRunnerService {
  private readonly logger = new Logger(ExtractorRunnerService.name);

  /**
   * Lazily-built prototype classifier for the transition lane
   * (EXTRACTOR_TRANSITION_CLASSIFIER). Cached on the service so the
   * EN+RU prototype bank is embedded ONCE per process (the classifier
   * closure caches the bank vectors; EmbedderService's LRU additionally
   * caches per-text). Never constructed while the flag is off.
   */
  private transitionClf: TransitionClassifier | null = null;

  // eslint-disable-next-line max-params -- Nest DI constructor; each param is an injection token and cannot be folded into an options object without breaking DI
  constructor(
    private readonly llm: ExtractorLlmService,
    private readonly local: ExtractorLocalService,
    private readonly refine: ExtractorRefineService,
    @Optional() private readonly embedder?: EmbedderService,
  ) {}

  modelId(): string {
    return this.llm.modelId();
  }

  /**
   * The transition-lane classifier, built on first use. Null when no
   * embedder was injected (direct-construction unit tests, stripped-down
   * module contexts) — the lane then no-ops even with the flag on.
   */
  private transitionClassifier(): TransitionClassifier | null {
    if (!this.embedder) return null;
    this.transitionClf ??= createTransitionClassifier((texts) =>
      (this.embedder as EmbedderService).embedMany(texts),
    );
    return this.transitionClf;
  }

  get scPasses(): number {
    return this.llm.scPasses;
  }

  /**
   * Run the extraction for an already-clamped input + loaded snapshot.
   *
   * Returns null when the LLM produced nothing usable (null/non-JSON
   * response, or every self-consistency pass failed) — a TRANSIENT
   * failure, not "this text contains no facts". The caller must not
   * cache a null: memoising it would pin an empty extraction for the
   * (text, tenant, vocab) key until LRU eviction, silently dropping
   * facts on every identical re-ingest (pre-#64 behaviour was exactly
   * "don't cache these paths").
   */
  async run(args: {
    trimmed: string;
    companyId: string;
    snapshot: Snapshot;
    overrides?: RunOverrides | undefined;
    context?: ConversationContext | undefined;
  }): Promise<ExtractionResult | null> {
    const { trimmed, companyId, snapshot, overrides, context } = args;
    const systemPrompt = this.llm.composeSystemPrompt(snapshot);
    const contextPrefix = buildConversationContext(context ?? {});

    const skip = await this.local.trySkip(companyId, trimmed);
    if (skip) return skip;

    traceArtifact('extractor.vocab', {
      versionHash: snapshot.versionHash,
      predicateCount: snapshot.active.length,
      predicateIds: snapshot.active.map((p) => p.predicateId),
    });

    const scPasses = overrides?.scPasses ?? this.llm.scPasses;
    if (scPasses > 1) {
      return this.runMultiPassExtract({
        companyId,
        trimmed,
        snapshot,
        systemPrompt,
        contextPrefix,
        context,
        overrides: { ...overrides, scPasses },
      });
    }

    // Facet routing — specialist passes ON TOP of the general one, only for
    // the turns whose shape warrants them (a list, a proper name). The router
    // is a local heuristic: paying an LLM call to decide whether to pay more
    // LLM calls is the wrong shape. Off / no facet detected → single pass,
    // byte-identical.
    // Audit W3 #6: routing is a DIALOGUE-PROFILE feature — the facet
    // prompt always emits the dialogue header (normalized, non-verbatim
    // values), while the grounding gate only tolerates those under
    // EXTRACTOR_DIALOGUE_PROFILE. With routing on and the profile off we
    // paid 2-3x the LLM calls and then dropped every fact they produced.
    // The doc comment claimed "dialogue profile only"; now the code does.
    const profile = resolveExtractionProfile();
    const facets = profile.facetRouting ? detectFacets(trimmed) : [];
    if (facets.length > 0) {
      return this.runFacetExtract({
        companyId,
        trimmed,
        snapshot,
        systemPrompt,
        facets,
        contextPrefix,
        context,
        overrides,
      });
    }

    const rawJson = await this.llm.callLlm({
      trimmed,
      systemPrompt,
      contextPrefix,
      temperature: 0.1,
      model: overrides?.model,
    });
    if (!rawJson) return null;
    return this.assembleResult({ companyId, trimmed, snapshot, rawJson, context });
  }

  private async runMultiPassExtract(args: {
    companyId: string;
    trimmed: string;
    snapshot: Snapshot;
    systemPrompt: string;
    contextPrefix?: string | undefined;
    context?: ConversationContext | undefined;
    overrides?: RunOverrides | undefined;
  }): Promise<ExtractionResult | null> {
    const N = args.overrides?.scPasses ?? this.llm.scPasses;
    // Even temperature spread across [0.1, 0.7].
    const temperatures = Array.from({ length: N }, (_, i) => 0.1 + (i * 0.6) / Math.max(N - 1, 1));

    const rawJsons = await Promise.all(
      temperatures.map((t) =>
        this.llm
          .callLlm({
            trimmed: args.trimmed,
            systemPrompt: args.systemPrompt,
            contextPrefix: args.contextPrefix,
            temperature: t,
            model: args.overrides?.model,
          })
          .catch((e) => {
            this.logger.warn(`sc-pass T=${t.toFixed(2)} failed: ${(e as Error).message}`);
            return null;
          }),
      ),
    );
    const results = await Promise.all(
      // async wrapper: every slot resolves to a Promise (the failed-pass
      // slots to a resolved null) so Promise.all receives an all-thenable
      // iterable — same result array, positions preserved.
      rawJsons.map(async (rj) =>
        rj
          ? this.assembleResult({
              companyId: args.companyId,
              trimmed: args.trimmed,
              snapshot: args.snapshot,
              rawJson: rj,
              context: args.context,
            })
          : null,
      ),
    );
    const surviving = results.filter((r): r is ExtractionResult => !!r);
    // Every pass failed → transient LLM trouble, not an empty text. Null
    // tells the caller to skip the cache (see run()'s contract).
    if (surviving.length === 0) return null;

    const { clusterCount, ...merged } = mergeExtractions(surviving, {
      selfConsistency: true,
    });

    traceArtifact('extractor.sc_passes', {
      passes: surviving.length,
      temperatures,
      clusterCount,
      clusterEntropy: merged.facts[0]?.extractionEntropy ?? 0,
    });

    return merged;
  }

  /**
   * Facet routing (`EXTRACTOR_ROUTING_ENABLED`, dialogue profile only): run the
   * general pass PLUS one specialist pass per facet the turn warrants, then
   * union them.
   *
   * The specialists are strictly ADDITIVE — the general pass still runs, and
   * the union deduplicates by semantic cluster, so a facet can only add recall.
   * That is deliberate: the measured failures are things the general pass
   * DROPPED (a list item, a brand name), not things it got wrong, and a
   * replace-the-general-pass design would trade one recall hole for another.
   */
  private async runFacetExtract(args: {
    companyId: string;
    trimmed: string;
    snapshot: Snapshot;
    systemPrompt: string;
    facets: Facet[];
    contextPrefix?: string | undefined;
    context?: ConversationContext | undefined;
    overrides?: RunOverrides | undefined;
  }): Promise<ExtractionResult | null> {
    const prompts = [args.systemPrompt, ...args.facets.map((f) => buildFacetSystemPrompt(f))];
    const rawJsons = await Promise.all(
      prompts.map((systemPrompt, i) =>
        this.llm
          .callLlm({
            trimmed: args.trimmed,
            systemPrompt,
            contextPrefix: args.contextPrefix,
            temperature: 0.1,
            model: args.overrides?.model,
          })
          .catch((e) => {
            // A specialist failing costs its extra recall, nothing else — the
            // general pass (index 0) still carries the turn.
            this.logger.warn(
              `facet pass ${i === 0 ? 'general' : args.facets[i - 1]} failed: ${(e as Error).message}`,
            );
            return null;
          }),
      ),
    );
    const results = await Promise.all(
      // async wrapper: every slot resolves to a Promise (the failed-pass
      // slots to a resolved null) so Promise.all receives an all-thenable
      // iterable — same result array, positions preserved.
      rawJsons.map(async (rj) =>
        rj
          ? this.assembleResult({
              companyId: args.companyId,
              trimmed: args.trimmed,
              snapshot: args.snapshot,
              rawJson: rj,
              context: args.context,
            })
          : null,
      ),
    );
    const surviving = results.filter((r): r is ExtractionResult => !!r);
    if (surviving.length === 0) return null;

    const { clusterCount: _c, ...merged } = mergeExtractions(surviving);
    traceArtifact('extractor.facets', {
      facets: args.facets,
      passes: surviving.length,
      generalFacts: results[0]?.facts.length ?? 0,
      mergedFacts: merged.facts.length,
    });
    return merged;
  }

  private async assembleResult(args: {
    companyId: string;
    trimmed: string;
    snapshot: Snapshot;
    rawJson: unknown;
    context?: ConversationContext | undefined;
  }): Promise<ExtractionResult> {
    const { companyId, trimmed, snapshot, rawJson, context } = args;

    const parsedEntities: ExtractedEntity[] = parseEntities(rawJson);
    const clauses = parseClauses(rawJson);
    const rawFacts = parseRawFacts(rawJson, parsedEntities.length);
    // Dialogue profile (Phase 4): values are normalized, not verbatim spans, so
    // the substring-drop gate would delete every normalized fact. Keep them.
    const {
      facts: valueGroundedFacts,
      dropped,
      ungroundedObjects,
    } = applyGroundingGate(trimmed, rawFacts, {
      clauses,
      allowUngrounded: resolveExtractionProfile().vocabulary === 'open',
      normalizeObjects: objectNormalizationEnabled(resolveExtractionProfile()),
    });

    if (ungroundedObjects.length > 0) {
      traceArtifact('extractor.ungrounded_object_proposals', {
        count: ungroundedObjects.length,
        ungroundedObjects,
      });
    }
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
    // entity array. Known participants (speaker/addressee) are allow-listed:
    // a coreference-resolved speaker name is legitimately absent from a
    // first-person-only turn ("I decided …") yet must survive.
    const allowedNames = [context?.speakerName, context?.addresseeName].filter(
      (n): n is string => !!n,
    );
    const groundedMask = groundEntities(trimmed, parsedEntities, allowedNames);
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
      .filter((e) => remap.has(e.fromEntityIndex) && remap.has(e.toEntityIndex))
      .map((e) => ({
        ...e,
        fromEntityIndex: remap.get(e.fromEntityIndex) as number,
        toEntityIndex: remap.get(e.toEntityIndex) as number,
      }));
    if (entities.length < parsedEntities.length) {
      const droppedNames = parsedEntities.filter((_, i) => !groundedMask[i]).map((e) => e.name);
      this.logger.warn(
        `extractor dropped ${droppedNames.length} entity(ies) that failed span-grounding: ${droppedNames.join('; ')}`,
      );
      traceArtifact('extractor.ungrounded_entities', {
        droppedCount: droppedNames.length,
        names: droppedNames,
      });
    }
    if (edges.length > 0) traceArtifact('extractor.edges', edges);

    await this.refine.applyPredicateRefinements(facts, snapshot as never, companyId);

    // Denoise (flag-gated, default off → identity): drop generic `said`
    // small-talk the LLM over-emits, which otherwise dilutes retrieval and
    // crowds real facts out of the synthesis window.
    const denoised = denoiseFacts(facts, resolveExtractionProfile().dropSaid);
    if (denoised.length < facts.length) {
      traceArtifact('extractor.denoise', {
        dropped: facts.length - denoised.length,
        kept: denoised.length,
      });
    }

    // Literal harvest (EXTRACTOR_LITERAL_HARVEST, default off): the
    // deterministic regex lane for technical literals the closed-vocab
    // prompt drops (ports, rate limits, HTTP statuses, identifiers,
    // naming prefixes). Runs AFTER denoise so the denoiser cannot eat
    // harvested rows; every harvested valueSpan is an exact substring
    // of the input by construction, so the grounding invariant the gate
    // above enforces holds for these rows too. Dedup against the
    // denoised LLM set keeps the union additive-only.
    const harvested = resolveExtractionProfile().literalHarvest
      ? harvestLiterals({
          trimmed,
          entities,
          speakerEntityIndex: resolveSpeakerEntityIndex(entities, context?.speakerName),
          existingFacts: denoised,
        })
      : [];
    if (harvested.length > 0) {
      traceArtifact('extractor.literal_harvest', {
        count: harvested.length,
        facts: harvested.map((f) => ({ predicate: f.predicate, object: f.object })),
      });
    }

    // State-verb harvest (EXTRACTOR_STATE_VERB_HARVEST, default off):
    // the deterministic transition lane — a past-tense lexicon
    // (bought/joined/quit/returned/…) harvests completed acquire/
    // dispose/change events as span-grounded `state_change` facts, with
    // pre-verb guards so intentions ("thinking about selling") never
    // flip state. Same seam and invariants as the literal lane; it
    // dedups against BOTH the denoised LLM set and the literal harvest,
    // so the two lanes compose additively when enabled together.
    const stateHarvested = resolveExtractionProfile().stateVerbHarvest
      ? harvestStateVerbs({
          trimmed,
          entities,
          speakerEntityIndex: resolveSpeakerEntityIndex(entities, context?.speakerName),
          existingFacts: harvested.length > 0 ? [...denoised, ...harvested] : denoised,
        })
      : [];
    if (stateHarvested.length > 0) {
      traceArtifact('extractor.state_verb_harvest', {
        count: stateHarvested.length,
        facts: stateHarvested.map((f) => ({ predicate: f.predicate, object: f.object })),
      });
    }

    // Transition-classifier harvest (EXTRACTOR_TRANSITION_CLASSIFIER,
    // default off): the semantic generalization of the state-verb
    // lexicon lane — compromise morphology (EN) + a bounded RU matcher
    // propose candidate clauses, the BGE-M3 prototype classifier
    // accepts completed transitions above the calibrated floor/margin,
    // and each acceptance lands as the SAME span-grounded state_change
    // shape with the SAME holder binding. Runs LAST and receives every
    // prior fact, so a sentence the lexicon lane already harvested is
    // deferred whole (no double emission) and triples dedup across all
    // lanes. A lane failure (embedder down mid-request) costs only its
    // extra recall — the LLM facts and sibling lanes still carry the
    // turn.
    let transitionHarvested: ExtractedFact[] = [];
    if (resolveExtractionProfile().transitionClassifier) {
      const classifier = this.transitionClassifier();
      if (classifier) {
        try {
          transitionHarvested = await harvestTransitions({
            trimmed,
            entities,
            speakerEntityIndex: resolveSpeakerEntityIndex(entities, context?.speakerName),
            existingFacts: [...denoised, ...harvested, ...stateHarvested],
            classifier,
          });
        } catch (e) {
          this.logger.warn(
            `transition-classifier lane failed (facts from other lanes kept): ${(e as Error).message}`,
          );
        }
      }
    }
    if (transitionHarvested.length > 0) {
      traceArtifact('extractor.transition_classifier', {
        count: transitionHarvested.length,
        facts: transitionHarvested.map((f) => ({ predicate: f.predicate, object: f.object })),
      });
    }

    const finalFacts =
      harvested.length > 0 || stateHarvested.length > 0 || transitionHarvested.length > 0
        ? [...denoised, ...harvested, ...stateHarvested, ...transitionHarvested]
        : denoised;

    const result: ExtractionResult = { entities, facts: finalFacts, edges };
    this.local.persistPatterns({
      companyId,
      clauses,
      rawFacts,
      // Deliberately the LLM facts only: harvested rows are re-derived
      // deterministically on every ingest, so caching them as replay
      // patterns would leak flag-on behavior into flag-off replays.
      facts: denoised,
      edges,
    });
    return result;
  }
}
