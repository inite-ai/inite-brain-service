import { Injectable } from '@nestjs/common';
import { IngestService } from '../ingest/ingest.service';
import type {
  SetupFactStep,
  SetupMentionStep,
  SetupLinkStep,
} from '../eval/types';

/**
 * Write phase of a scenario run: the three additive ingest steps
 * (fact / mention / link). Owns only the IngestService dep so the orchestrator
 * stays at ≤3. Destructive steps (retract / forget) live in
 * ScenarioLifecycleService.
 */
@Injectable()
export class ScenarioWriteService {
  constructor(private readonly ingest: IngestService) {}

  /** Returns the new fact id (when the resolver minted one) so the caller can
   * register it under the step's tag for a later retract. */
  async applyFact(companyId: string, step: SetupFactStep): Promise<string | null> {
    const res = await this.ingest.ingestFact(companyId, {
      entityRef: step.entityRef,
      predicate: step.predicate,
      object: step.object,
      validFrom: step.validFrom,
      validUntil: step.validUntil,
      confidence: step.confidence,
      source: step.source,
    });
    return res.factId ?? null;
  }

  async applyMention(companyId: string, step: SetupMentionStep): Promise<void> {
    await this.ingest.ingestMention(companyId, {
      text: step.text,
      contextRef: step.contextRef,
      knownEntities: step.knownEntities,
      emittedAt: step.emittedAt,
    });
  }

  async applyLink(companyId: string, step: SetupLinkStep): Promise<void> {
    await this.ingest.ingestLink(companyId, {
      from: step.from,
      to: step.to,
      kind: step.linkKind,
      source: step.source,
    });
  }
}
