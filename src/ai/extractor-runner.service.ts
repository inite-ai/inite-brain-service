import { Injectable, Logger } from '@nestjs/common';
import { traceArtifact } from '../common/debug-trace';
import { PredicateDefinition } from './predicate-registry.service';
import type { PackExtractionProfile } from './predicate-registry-internals/types';
import { ExtractorLlmService } from './extractor-llm.service';
import { ExtractorLocalService } from './extractor-local.service';
import { ExtractorRefineService } from './extractor-refine.service';
import {
  clusterKey,
  selfConsistencyByFact,
} from './extractor-internals/semantic-entropy';
import type {
  ExtractedEntity,
  ExtractionResult,
} from './extractor-internals/types';
import {
  applyGroundingGate,
  groundEntities,
  parseClauses,
  parseEntities,
  parseRawFacts,
} from './extractor-internals/grounding';
import { validateEdges } from './extractor-internals/edge-validator';

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
 * this class holds no cache/registry dep, keeping it at ≤3.
 */
@Injectable()
export class ExtractorRunnerService {
  private readonly logger = new Logger(ExtractorRunnerService.name);

  constructor(
    private readonly llm: ExtractorLlmService,
    private readonly local: ExtractorLocalService,
    private readonly refine: ExtractorRefineService,
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
    overrides?: RunOverrides;
  }): Promise<ExtractionResult | null> {
    const { trimmed, companyId, snapshot, overrides } = args;
    const systemPrompt = this.llm.composeSystemPrompt(snapshot);

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
        overrides: { ...overrides, scPasses },
      });
    }

    const rawJson = await this.llm.callLlm({
      trimmed,
      systemPrompt,
      temperature: 0.1,
      model: overrides?.model,
    });
    if (!rawJson) return null;
    return this.assembleResult({ companyId, trimmed, snapshot, rawJson });
  }

  private async runMultiPassExtract(args: {
    companyId: string;
    trimmed: string;
    snapshot: Snapshot;
    systemPrompt: string;
    overrides?: RunOverrides;
  }): Promise<ExtractionResult | null> {
    const N = args.overrides?.scPasses ?? this.llm.scPasses;
    // Even temperature spread across [0.1, 0.7].
    const temperatures = Array.from(
      { length: N },
      (_, i) => 0.1 + (i * 0.6) / Math.max(N - 1, 1),
    );

    const rawJsons = await Promise.all(
      temperatures.map((t) =>
        this.llm
          .callLlm({
            trimmed: args.trimmed,
            systemPrompt: args.systemPrompt,
            temperature: t,
            model: args.overrides?.model,
          })
          .catch((e) => {
            this.logger.warn(
              `sc-pass T=${t.toFixed(2)} failed: ${(e as Error).message}`,
            );
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
              snapshot: args.snapshot,
              rawJson: rj,
            })
          : null,
      ),
    );
    const surviving = results.filter((r): r is ExtractionResult => !!r);
    // Every pass failed → transient LLM trouble, not an empty text. Null
    // tells the caller to skip the cache (see run()'s contract).
    if (surviving.length === 0) return null;

    const passFacts = surviving.map((r) =>
      r.facts.map((f) => ({ predicate: f.predicate, object: f.object })),
    );
    const sc = selfConsistencyByFact(passFacts);

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

  private async assembleResult(args: {
    companyId: string;
    trimmed: string;
    snapshot: Snapshot;
    rawJson: any;
  }): Promise<ExtractionResult> {
    const { companyId, trimmed, snapshot, rawJson } = args;

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
    // entity array.
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
      .filter((e) => remap.has(e.fromEntityIndex) && remap.has(e.toEntityIndex))
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

    await this.refine.applyPredicateRefinements(facts, snapshot as never, companyId);

    const result: ExtractionResult = { entities, facts, edges };
    this.local.persistPatterns({ companyId, clauses, rawFacts, facts, edges });
    return result;
  }
}
