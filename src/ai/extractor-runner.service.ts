import { Injectable, Logger, Optional } from '@nestjs/common';
import { traceArtifact } from '../common/debug-trace';
import { PredicateDefinition } from './predicate-registry.service';
import type { PackExtractionProfile } from './predicate-registry-internals/types';
import { ExtractorLlmService } from './extractor-llm.service';
import { ExtractorLocalService } from './extractor-local.service';
import { ExtractorRefineService } from './extractor-refine.service';
import { mergeExtractions } from './extractor-internals/merge';
import { checkExtraction } from './extractor-internals/fact-check';
import { DecisionService } from './decisions/decision.service';
import type { ExtractedEntity, ExtractionResult } from './extractor-internals/types';
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
import type { ServiceTier } from './openai-client';
import { resolveExtractionProfile } from './extraction-profile';
import { buildConversationContext, type ConversationContext } from './extractor-internals/prompts';
import { providerSideFailure } from './openai-client';

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
  /** Background extraction (nobody is waiting on it): the offline processing tier. */
  tier?: ServiceTier | undefined;
}

/**
 * ExtractorRunnerService — the extraction engine. Sequences the local
 * skip → LLM call (single or N-pass self-consistency) → response parsing
 * + span grounding + edge validation → predicate refinement → pattern
 * emission. Delegates each concern to ExtractorLlmService /
 * ExtractorLocalService / ExtractorRefineService. The predicate snapshot
 * is supplied by the caller (ExtractorService, which owns the cache);
 * this class holds no cache/registry dep — its 3 required deps stay the
 * pipeline stages, plus an OPTIONAL DecisionService for the document check.
 */
@Injectable()
export class ExtractorRunnerService {
  private readonly logger = new Logger(ExtractorRunnerService.name);

  // eslint-disable-next-line max-params -- Nest DI constructor; each param is an injection token and cannot be folded into an options object without breaking DI
  constructor(
    private readonly llm: ExtractorLlmService,
    private readonly local: ExtractorLocalService,
    private readonly refine: ExtractorRefineService,
    @Optional() private readonly decisions?: DecisionService,
  ) {}

  modelId(): string {
    return this.llm.modelId();
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

    const rawJson = await this.llm.callLlm({
      trimmed,
      systemPrompt,
      contextPrefix,
      temperature: 0.1,
      model: overrides?.model,
      tier: overrides?.tier,
    });
    if (!rawJson) return null;
    const single = await this.assembleResult({ companyId, trimmed, snapshot, rawJson, context });
    // One sample is checked against the text like the samples' union is.
    return (await this.checkRead(single, trimmed, contextPrefix)).result;
  }

  /**
   * The document check (fact-check.ts): every fact and relation of a read
   * put back to the decision plane against the text it was read from;
   * what the text confidently does not state is dropped. The lane off →
   * the read unchanged.
   */
  private async checkRead(
    result: ExtractionResult,
    text: string,
    contextPrefix: string | undefined,
  ): Promise<Awaited<ReturnType<typeof checkExtraction>>> {
    const checked = await checkExtraction({
      result,
      text,
      context: contextPrefix,
      decisions: this.decisions,
    });
    if (checked.rejected > 0) {
      this.logger.log(
        `extraction check: dropped ${checked.rejected} of ${result.facts.length} facts the document does not state (${checked.asked} asked)`,
      );
    }
    return checked;
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

    const failures: unknown[] = [];
    const rawJsons = await Promise.all(
      temperatures.map((t) =>
        this.llm
          .callLlm({
            trimmed: args.trimmed,
            systemPrompt: args.systemPrompt,
            contextPrefix: args.contextPrefix,
            temperature: t,
            model: args.overrides?.model,
            tier: args.overrides?.tier,
          })
          .catch((e) => {
            this.logger.warn(`sc-pass T=${t.toFixed(2)} failed: ${(e as Error).message}`);
            failures.push(e);
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
    // Every pass failed because the provider refused (no credit, a revoked
    // key, an outage): rethrow the refusal itself, status intact. Folded
    // into a null it reached the batch reader as a status-less "transient
    // failure", which the halving retry read as "too long" and split down
    // to single turns — 1238 refused passes in one local run on a dry key
    // (2026-10-29). ExtractorService keeps the request path's null contract.
    if (surviving.length === 0) {
      const refusal = failures.find(providerSideFailure);
      if (refusal) throw refusal;
    }
    // Every pass failed → transient LLM trouble, not an empty text. Null
    // tells the caller to skip the cache (see run()'s contract).
    if (surviving.length === 0) return null;

    const { clusterCount, ...union } = mergeExtractions(surviving, {
      selfConsistency: true,
    });
    const checked = await this.checkRead(union, args.trimmed, args.contextPrefix);

    traceArtifact('extractor.sc_passes', {
      passes: surviving.length,
      temperatures,
      clusterCount,
      clusterEntropy: union.facts[0]?.extractionEntropy ?? 0,
      // The document check (fact-check.ts): facts put to the decision
      // plane, and facts it confidently found the document does not state.
      factsChecked: checked.asked,
      factsRejected: checked.rejected,
      droppedFacts: checked.droppedFacts ?? [],
    });

    return checked.result;
  }

  private async assembleResult(args: {
    companyId: string;
    trimmed: string;
    snapshot: Snapshot;
    rawJson: unknown;
    context?: ConversationContext | undefined;
  }): Promise<ExtractionResult> {
    const { companyId, trimmed, snapshot, rawJson, context } = args;

    const parsedEntities: ExtractedEntity[] = parseEntities(rawJson, context?.memory);
    const clauses = parseClauses(rawJson);
    const rawFacts = parseRawFacts(rawJson, parsedEntities.length, context?.memory);
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
    const allowedNames = [
      context?.speakerName,
      context?.addresseeName,
      ...(context?.turns ?? []).flatMap((t) => [t.speakerName, t.addresseeName]),
    ].filter((n): n is string => !!n);
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

    const result: ExtractionResult = { entities, facts: denoised, edges };
    this.local.persistPatterns({
      companyId,
      clauses,
      rawFacts,
      facts: denoised,
      edges,
    });
    return result;
  }
}
