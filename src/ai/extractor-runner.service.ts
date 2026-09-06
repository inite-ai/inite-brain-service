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
    if (skip) {
      // Replay-starvation fix: the local-replay path used to return
      // BEFORE the harvest seam, yet replay patterns deliberately carry
      // the LLM facts only (persistPatterns excludes harvested rows on
      // the promise that the deterministic lanes re-derive them "on
      // every ingest") — so a replayed turn silently lost every
      // harvested fact. Run the same seam over the replayed result.
      // All lanes off → the exact trySkip object, byte-identical.
      const { facts: replayHarvested, entities: replayEntities } = await this.runHarvestLanes({
        trimmed,
        entities: skip.entities,
        existingFacts: skip.facts,
        context,
      });
      if (replayHarvested.length === 0) return skip;
      traceArtifact('extractor.replay_skip_harvest', {
        count: replayHarvested.length,
        facts: replayHarvested.map((f) => ({ predicate: f.predicate, object: f.object })),
      });
      return {
        entities: replayEntities,
        facts: [...skip.facts, ...replayHarvested],
        edges: skip.edges,
      };
    }

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

    // Deterministic harvest lanes (all default off) — see runHarvestLanes.
    // Runs AFTER denoise so the denoiser cannot eat harvested rows; every
    // harvested valueSpan is an exact substring of the input by
    // construction, so the grounding invariant the gate above enforces
    // holds for these rows too.
    const { facts: harvestedFacts, entities: finalEntities } = await this.runHarvestLanes({
      trimmed,
      entities,
      existingFacts: denoised,
      context,
    });

    const finalFacts = harvestedFacts.length > 0 ? [...denoised, ...harvestedFacts] : denoised;

    const result: ExtractionResult = { entities: finalEntities, facts: finalFacts, edges };
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

  /**
   * The deterministic harvest seam, shared by BOTH producers of an
   * extraction result — assembleResult (the LLM path) and the trySkip
   * local-replay path in run(). Sequences the three flag-gated lanes:
   *
   *  - Literal harvest (EXTRACTOR_LITERAL_HARVEST): the regex lane for
   *    technical literals the closed-vocab prompt drops (ports, rate
   *    limits, HTTP statuses, identifiers, naming prefixes). Dedup
   *    against the existing set keeps the union additive-only.
   *  - State-verb harvest (EXTRACTOR_STATE_VERB_HARVEST): the past-
   *    tense transition lexicon (bought/joined/quit/returned/…)
   *    harvesting completed acquire/dispose/change events as span-
   *    grounded `state_change` facts, with pre-verb guards so
   *    intentions ("thinking about selling") never flip state. Dedups
   *    against BOTH the existing set and the literal harvest.
   *  - Transition classifier (EXTRACTOR_TRANSITION_CLASSIFIER): the
   *    semantic generalization — morphology candidates + the BGE-M3
   *    prototype classifier — landing the SAME state_change shape with
   *    the SAME holder binding. Runs LAST and receives every prior
   *    fact, so a sentence the lexicon lane already harvested is
   *    deferred whole (no double emission). A lane failure (embedder
   *    down mid-request) costs only its extra recall.
   *
   * No-entity starvation fix: when the extraction produced ZERO grounded
   * entities (the `no_entities` skip shape at the ingest boundary), the
   * lanes used to be starved — nothing to bind a fact to. Here the seam
   * mints instead: the speaker entity is minted from the caller-supplied
   * context (the caller asserted that identity; typed `staff`, the same
   * type the local NER path assigns a PERSON), and the literal lane may
   * mint identifier-shaped subject entities per its extractionProfile
   * doctrine (mintSubjects). The state lanes keep bindStateHolder
   * semantics untouched: no person entity and no speaker → their
   * matches skip honestly (debug log below), never mis-bind to a minted
   * identifier. Minted entities that end up referenced by no harvested
   * fact are pruned, so a turn that harvests nothing yields the input
   * entity list unchanged — the `no_entities` skip fires exactly as
   * before. Minting NEVER runs when the extraction has entities, so
   * previously-working lanes-on paths are untouched.
   *
   * Returns the harvested facts ONLY (for the caller to union) and the
   * final entity list — the input array itself unless minting added a
   * referenced entity.
   */
  private async runHarvestLanes(args: {
    trimmed: string;
    entities: ExtractedEntity[];
    existingFacts: ExtractedFact[];
    context?: ConversationContext | undefined;
  }): Promise<{ facts: ExtractedFact[]; entities: ExtractedEntity[] }> {
    const { trimmed, entities, existingFacts, context } = args;
    const profile = resolveExtractionProfile();
    const anyLane =
      profile.literalHarvest || profile.stateVerbHarvest || profile.transitionClassifier;
    if (!anyLane) return { facts: [], entities };

    // Working list the lanes bind against. Minting (no-entity turns
    // only) appends to it; the referenced tail is folded back below.
    const working = [...entities];
    const mint = entities.length === 0;
    if (mint && context?.speakerName) {
      working.push({ name: context.speakerName, type: 'staff' });
    }
    if (
      mint &&
      !context?.speakerName &&
      (profile.stateVerbHarvest || profile.transitionClassifier)
    ) {
      this.logger.debug(
        'harvest lanes: no entities and no speaker — state-verb/transition matches have no bindable holder and are skipped',
      );
    }
    const speakerEntityIndex = resolveSpeakerEntityIndex(working, context?.speakerName);

    const harvested = profile.literalHarvest
      ? harvestLiterals({
          trimmed,
          entities: working,
          speakerEntityIndex,
          existingFacts,
          mintSubjects: mint,
        })
      : [];
    if (harvested.length > 0) {
      traceArtifact('extractor.literal_harvest', {
        count: harvested.length,
        facts: harvested.map((f) => ({ predicate: f.predicate, object: f.object })),
      });
    }

    const stateHarvested = profile.stateVerbHarvest
      ? harvestStateVerbs({
          trimmed,
          entities: working,
          speakerEntityIndex,
          existingFacts: harvested.length > 0 ? [...existingFacts, ...harvested] : existingFacts,
        })
      : [];
    if (stateHarvested.length > 0) {
      traceArtifact('extractor.state_verb_harvest', {
        count: stateHarvested.length,
        facts: stateHarvested.map((f) => ({ predicate: f.predicate, object: f.object })),
      });
    }

    let transitionHarvested: ExtractedFact[] = [];
    if (profile.transitionClassifier) {
      const classifier = this.transitionClassifier();
      if (classifier) {
        try {
          transitionHarvested = await harvestTransitions({
            trimmed,
            entities: working,
            speakerEntityIndex,
            existingFacts: [...existingFacts, ...harvested, ...stateHarvested],
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

    const facts = [...harvested, ...stateHarvested, ...transitionHarvested];
    if (working.length === entities.length) return { facts, entities };

    // Fold the minted tail back in: keep only minted entities some
    // harvested fact references (an unreferenced minted speaker must
    // not turn a no_entities skip into a facts-less persisted mention)
    // and remap the harvested facts onto the compacted list. Existing
    // facts only reference the pre-mint range, which never moves.
    const referenced = new Set(facts.map((f) => f.entityIndex));
    const finalEntities = [...entities];
    const remap = new Map<number, number>();
    working.forEach((e, i) => {
      if (i < entities.length || !referenced.has(i)) return;
      remap.set(i, finalEntities.length);
      finalEntities.push(e);
    });
    if (finalEntities.length > entities.length) {
      traceArtifact('extractor.harvest_minted_entities', {
        count: finalEntities.length - entities.length,
        names: finalEntities.slice(entities.length).map((e) => e.name),
      });
    }
    return {
      facts: facts.map((f) =>
        remap.has(f.entityIndex) ? { ...f, entityIndex: remap.get(f.entityIndex) as number } : f,
      ),
      entities: finalEntities.length === entities.length ? entities : finalEntities,
    };
  }
}
