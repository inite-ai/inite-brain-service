import { BadRequestException, Injectable } from '@nestjs/common';
import { SurrealService } from '../db/surreal.service';
import { IngestFactDto } from './dto/ingest-fact.dto';
import { IngestOutcome, IngestResult } from './ingest-result';
import {
  buildConflictExplanation,
  type ResolverConflictPayload,
} from './conflict-explainer';
import { EntityUpsertService } from './entity-upsert.service';
import { FactResolverService } from './fact-resolver.service';

/**
 * The typed direct-ingest path (`ingestFact`): a single fully-specified fact
 * with an explicit entity reference, run through the full conflict-resolution
 * pipeline. Resolves the entity, then defers the embed + fn::resolve_fact +
 * HyPE to FactResolverService, and shapes the IngestResult (+ optional
 * conflict explanation).
 */
@Injectable()
export class FactIngestService {
  constructor(
    private readonly surreal: SurrealService,
    private readonly entities: EntityUpsertService,
    private readonly factResolver: FactResolverService,
  ) {}

  async ingestFact(companyId: string, dto: IngestFactDto): Promise<IngestResult> {
    // Reject an inverted or zero-width validity interval up front. Both are
    // nonsensical bitemporally — a fact valid until before (or exactly at)
    // it became valid covers no instant — and would otherwise corrupt
    // asOf-query selection inside fn::resolve_fact. class-validator can't
    // express this cross-field constraint, so it lives here.
    if (dto.validUntil !== undefined) {
      const from = Date.parse(dto.validFrom);
      const until = Date.parse(dto.validUntil);
      if (Number.isFinite(from) && Number.isFinite(until) && until <= from) {
        throw new BadRequestException(
          'validUntil must be strictly after validFrom',
        );
      }
    }
    return this.surreal.withCompany(companyId, async (db) => {
      // 1. Resolve entity (own atomic step — own tx with unique-retry).
      const entityId = await this.entities.resolveOrCreateEntity(db, dto);

      // 2. Object preservation. Schema stores `object` as string for
      //    indexing; for non-string DTO objects we additionally keep
      //    the structured form in `objectMeta`.
      const objectIsString = typeof dto.object === 'string';
      const objectStr = objectIsString
        ? (dto.object as string)
        : JSON.stringify(dto.object);
      // SurrealDB option<...> rejects NULL. JS `null` serialises as NULL,
      // `undefined` is dropped from the payload and treated as NONE — which
      // is what we want for an optional field.
      const objectMeta = objectIsString ? undefined : (dto.object as unknown as object);

      // 3. One-RTT server-side resolve (embed + policy + fn::resolve_fact +
      //    HyPE alt-embedding) behind FactResolverService. Direct ingest
      //    carries no extraction entropy. The embedding text preserves the
      //    historical `${predicate}: ${dto.object}` form (not objectStr).
      const { result } = await this.factResolver.resolve(db, {
        companyId,
        entityId,
        predicate: dto.predicate,
        object: objectStr,
        objectMeta,
        embeddingText: `${dto.predicate}: ${dto.object}`,
        confidence: dto.confidence ?? 0.7,
        validFrom: new Date(dto.validFrom),
        validUntil: dto.validUntil ? new Date(dto.validUntil) : undefined,
        source: dto.source,
        entropy: undefined,
        recordOutcomeMetric: true,
      });

      const factId = result?.factId ? String(result.factId) : null;
      const outcome = result?.outcome as IngestOutcome;

      const out: IngestResult = { factId, outcome };
      if (result?.reason) out.reason = String(result.reason);
      if (result?.supersededFactIds) {
        out.supersededFactIds = (result.supersededFactIds as unknown[]).map(String);
      }
      if (result?.competingFactIds) {
        out.competingFactIds = (result.competingFactIds as unknown[]).map(String);
      }
      if (dto.explain === true && factId && result?.bestOpponentId) {
        out.conflictExplanation = buildConflictExplanation({
          outcome: outcome as 'SUPERSEDED' | 'COMPETING',
          factId,
          bestOpponentId: String(result.bestOpponentId),
          supersededFactIds: out.supersededFactIds,
          competingFactIds: out.competingFactIds,
          scoreBreakdown: result.scoreBreakdown as ResolverConflictPayload['scoreBreakdown'],
          dominantDimension: result.dominantDimension as ResolverConflictPayload['dominantDimension'],
          slotDelta: result.slotDelta as ResolverConflictPayload['slotDelta'],
        });
      }
      return out;
    });
  }
}
