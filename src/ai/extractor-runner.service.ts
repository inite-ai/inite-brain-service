import { Injectable, Logger } from '@nestjs/common';
import { traceArtifact } from '../common/debug-trace';
import { PredicateDefinition } from './predicate-registry.service';
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

type Snapshot = { versionHash: string; active: PredicateDefinition[] };

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

  /** Run the extraction for an already-clamped input + loaded snapshot. */
  async run(
    trimmed: string,
    companyId: string,
    snapshot: Snapshot,
  ): Promise<ExtractionResult> {
    const systemPrompt = this.llm.composeSystemPrompt(snapshot);

    const skip = await this.local.trySkip(companyId, trimmed);
    if (skip) return skip;

    traceArtifact('extractor.vocab', {
      versionHash: snapshot.versionHash,
      predicateCount: snapshot.active.length,
      predicateIds: snapshot.active.map((p) => p.predicateId),
    });

    if (this.llm.scPasses > 1) {
      return this.runMultiPassExtract({ companyId, trimmed, snapshot, systemPrompt });
    }

    const rawJson = await this.llm.callLlm(trimmed, systemPrompt, 0.1);
    if (!rawJson) return { entities: [], facts: [], edges: [] };
    return this.assembleResult({ companyId, trimmed, snapshot, rawJson });
  }

  private async runMultiPassExtract(args: {
    companyId: string;
    trimmed: string;
    snapshot: Snapshot;
    systemPrompt: string;
  }): Promise<ExtractionResult> {
    const N = this.llm.scPasses;
    // Even temperature spread across [0.1, 0.7].
    const temperatures = Array.from(
      { length: N },
      (_, i) => 0.1 + (i * 0.6) / Math.max(N - 1, 1),
    );

    const rawJsons = await Promise.all(
      temperatures.map((t) =>
        this.llm.callLlm(args.trimmed, args.systemPrompt, t).catch((e) => {
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
    if (surviving.length === 0) return { entities: [], facts: [], edges: [] };

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
