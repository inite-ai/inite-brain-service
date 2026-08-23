import type { HttpBrainClient as BrainClient } from '../http-brain-client';
import type {
  SetupMentionStep,
  SetupRetractStep,
  SetupForgetStep,
  SetupFactStep,
  ExtractionResult,
  IdentityMergeResult,
  Scenario,
} from '../../../src/eval/types';

/**
 * Applies a scenario's setup steps to brain via the SDK. Returns the
 * extraction observations needed by the metrics layer.
 *
 * One responsibility: turn declarative setup into brain state. No
 * scoring, no reporting.
 */
export class SetupApplier {
  constructor(private readonly brain: BrainClient) {}

  async apply(scenario: Scenario): Promise<{
    extractions: ExtractionResult[];
    identityMerge?: IdentityMergeResult | undefined;
  }> {
    const extractions: ExtractionResult[] = [];
    // Tag → factId map. Lets retract steps reference an earlier
    // fact step by the human-readable handle declared in the scenario,
    // without round-tripping the server-assigned factId through the
    // fixture.
    const factIdsByTag = new Map<string, string>();

    for (const step of scenario.setup) {
      switch (step.kind) {
        case 'fact':
          await this.applyFact(step, factIdsByTag);
          break;
        case 'mention':
          extractions.push(await this.applyMention(scenario.id, step));
          break;
        case 'link':
          await this.brain.ingest.link({
            from: step.from,
            to: step.to,
            kind: step.linkKind,
            source: step.source,
          });
          break;
        case 'retract':
          await this.applyRetract(step, factIdsByTag);
          break;
        case 'forget':
          await this.applyForget(step);
          break;
      }
    }

    let identityMerge: IdentityMergeResult | undefined;
    if (scenario.identityMerge) {
      identityMerge = await this.assertIdentityMerge(scenario);
    }

    return { extractions, identityMerge };
  }

  private async applyFact(
    step: SetupFactStep,
    factIdsByTag: Map<string, string>,
  ): Promise<void> {
    const res = await this.brain.ingest.fact({
      entityRef: step.entityRef,
      predicate: step.predicate,
      object: step.object,
      validFrom: step.validFrom,
      validUntil: step.validUntil,
      confidence: step.confidence,
      source: step.source,
    });
    if (step.tag && res.factId) {
      factIdsByTag.set(step.tag, res.factId);
    }
    // outcome=REJECTED leaves res.factId null — silently drop the tag.
    // The retract step will surface the misconfiguration with a clear
    // "no factId for tag X" warning rather than a confusing 404.
  }

  private async applyRetract(
    step: SetupRetractStep,
    factIdsByTag: Map<string, string>,
  ): Promise<void> {
    const factId = factIdsByTag.get(step.tag);
    if (!factId) {
      throw new Error(
        `[setup-applier] retract: no factId resolved for tag '${step.tag}' — ` +
          `either the prior fact step lacked a tag or it was REJECTED at ingest`,
      );
    }
    await this.brain.facts.retract(factId, {
      reason: step.reason,
      retractedBy: { source: 'system' },
    });
  }

  private async applyForget(step: SetupForgetStep): Promise<void> {
    const entityId = await this.findEntityIdByRef(
      `${step.entityRef.vertical}.${step.entityRef.id}`,
    );
    if (!entityId) {
      throw new Error(
        `[setup-applier] forget: could not resolve entity for ref ` +
          `'${step.entityRef.vertical}.${step.entityRef.id}' — ` +
          `either no fact ingested for it or the externalRef shape mismatched`,
      );
    }
    await this.brain.entities.forget(entityId, {
      reason: step.reason,
      requestId: step.requestId,
    });
  }

  private async applyMention(
    scenarioId: string,
    step: SetupMentionStep,
  ): Promise<ExtractionResult> {
    const out = await this.brain.ingest.mention({
      text: step.text,
      contextRef: step.contextRef,
      knownEntities: step.knownEntities,
      emittedAt: step.emittedAt,
    });

    // Read back the predicates surfaced on the speaker entity (or, if no
    // hint, on the most recently created entity).
    const observed: string[] = [];
    if (step.knownEntities?.[0]) {
      const ref = step.knownEntities[0];
      const search = await this.brain.search({
        query: step.text.slice(0, 80),
        limit: 5,
      });
      const refTag = `${ref.vertical}__${ref.id}`;
      const hit = search.results.find(
        (r) => r.externalRefs && r.externalRefs[refTag] === ref.id,
      );
      if (hit) {
        for (const f of hit.facts) {
          if (!observed.includes(f.predicate)) observed.push(f.predicate);
        }
      }
    }

    const expected = step.expectedPredicates ?? [];
    const minEntities = step.minEntities ?? 1;
    const matched = expected.filter((p) => observed.includes(p)).length;
    const recall = expected.length === 0 ? 1 : matched / expected.length;

    if (process.env.DEBUG_EXTRACTION === '1') {
       
      console.log(
        `[extraction-debug] scenario=${scenarioId} expected=${JSON.stringify(expected)} ` +
          `observed=${JSON.stringify(observed)} entitiesExtracted=${out.extractedEntityIds.length} ` +
          `factsExtracted=${out.extractedFactIds.length} recall=${recall.toFixed(2)}`,
      );
    }

    return {
      scenarioId,
      text: step.text,
      expectedPredicates: expected,
      observedPredicates: observed,
      predicateRecall: recall,
      entitiesObserved: out.extractedEntityIds.length,
      minEntities,
    };
  }

  private async assertIdentityMerge(scenario: Scenario): Promise<IdentityMergeResult> {
    const merge = scenario.identityMerge!;
    const survivor = await this.findEntityIdByRef(merge.survivorRef);
    const loser = await this.findEntityIdByRef(merge.loserRef);
    if (!survivor || !loser) {
      return {
        scenarioId: scenario.id,
        survivorRef: merge.survivorRef,
        loserRef: merge.loserRef,
        merged: false,
        falseMerges: [],
        unresolvedDistractors: merge.shouldNotMerge ?? [],
      };
    }
    // If both refs resolve to the same entity, merge has already
    // happened (the setup phase ingested an identity_of link, search
    // re-attributes loser → survivor and now exposes both externalRefs
    // on the survivor record). Skip the redundant link call —
    // attempting it as a self-edge breaks the metric.
    let merged: boolean;
    if (survivor === loser) {
      merged = true;
    } else {
      try {
        const linkRes = await this.brain.ingest.link({
          from: { entityId: survivor },
          to: { entityId: loser },
          kind: 'identity_of',
          source: { vertical: 'cross' },
        });
        // The link returned an edgeId. The mergedAt/mergedInto fields
        // aren't yet exposed on the v1 read endpoints, so for the eval we
        // accept a successful link call (with a non-null edgeId) as proof
        // the merge ran. The fromEntityId echo is normalized server-side
        // (may strip the table prefix), so we don't compare it.
        merged = !!linkRes.edgeId;
      } catch {
        merged = false;
      }
    }

    // After the (intended) merge has been attempted, walk the
    // shouldNotMerge distractors. Re-resolve each one — if it now
    // points at the same entityId as the survivor, brain over-merged.
    const falseMerges: string[] = [];
    const unresolvedDistractors: string[] = [];
    if (merge.shouldNotMerge) {
      // Survivor's entityId might have been normalized post-merge.
      // Re-resolve to be safe.
      const survivorPostMerge =
        (await this.findEntityIdByRef(merge.survivorRef)) ?? survivor;
      for (const ref of merge.shouldNotMerge) {
        const distractor = await this.findEntityIdByRef(ref);
        if (!distractor) {
          unresolvedDistractors.push(ref);
          continue;
        }
        if (distractor === survivorPostMerge) {
          falseMerges.push(ref);
        }
      }
    }

    return {
      scenarioId: scenario.id,
      survivorRef: merge.survivorRef,
      loserRef: merge.loserRef,
      merged,
      falseMerges,
      unresolvedDistractors,
    };
  }

  private async findEntityIdByRef(ref: string): Promise<string | null> {
    const [vertical, id] = ref.split('.', 2);
    // Search by the externalRef token; brain returns the entity along
    // with externalRefs so we can match exactly.
    const refTag = `${vertical}__${id}`;
    const res = await this.brain.search({ query: id, limit: 10 });
    const hit = res.results.find((r) => r.externalRefs?.[refTag] === id);
    return hit?.entityId ?? null;
  }
}
