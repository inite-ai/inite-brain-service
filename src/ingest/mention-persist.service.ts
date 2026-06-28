import { Injectable, Logger } from '@nestjs/common';
import { Surreal, StringRecordId } from 'surrealdb';
import { SurrealService, isUniqueViolation } from '../db/surreal.service';
import { IngestMentionDto } from './dto/ingest-mention.dto';
import { traceArtifact, traceSpan } from '../common/debug-trace';
import { redactPii } from './ingest-utils';
import { EntityUpsertService } from './entity-upsert.service';
import { FactResolverService } from './fact-resolver.service';
import { MentionSource } from './mention-extraction.service';

export interface MentionPersistResult {
  extractedEntityIds: string[];
  extractedFactIds: string[];
  extractedEdgeIds: string[];
}

/**
 * Persistence stage of mention ingest, run INSIDE the db session: resolve each
 * extracted entity, write each extracted fact through FactResolverService
 * (best-effort — mention extraction is noisy, conflict resolution at search
 * time handles dedup), and RELATE the extracted edges. Failure on a single
 * edge does not block the rest of the ingest.
 */
@Injectable()
export class MentionPersistService {
  private readonly logger = new Logger(MentionPersistService.name);

  constructor(
    private readonly surreal: SurrealService,
    private readonly entities: EntityUpsertService,
    private readonly factResolver: FactResolverService,
  ) {}

  async persistAll(p: {
    companyId: string;
    dto: IngestMentionDto;
    extraction: any;
    source: MentionSource;
    factEmbeddings: number[][];
  }): Promise<MentionPersistResult> {
    const { companyId, dto, extraction, source, factEmbeddings } = p;
    return this.surreal.withCompany(companyId, async (db) => {
      const entityIds = await this.persistEntities(db, { extraction, dto });
      const factIds = await this.persistFacts(db, {
        companyId,
        dto,
        extraction,
        source,
        factEmbeddings,
        entityIds,
      });
      const edgeIds = await this.persistEdges(db, { extraction, entityIds, dto });

      traceArtifact('ingest.mention.result', { entityIds, factIds, edgeIds });
      return {
        extractedEntityIds: entityIds,
        extractedFactIds: factIds,
        extractedEdgeIds: edgeIds,
      };
    });
  }

  private async persistEntities(
    db: Surreal,
    p: { extraction: any; dto: IngestMentionDto },
  ): Promise<string[]> {
    const { extraction, dto } = p;
    const entityIds: string[] = [];
    for (let i = 0; i < extraction.entities.length; i++) {
      const e = extraction.entities[i];
      const knownHint = dto.knownEntities?.[i];
      // The entity's freshly-extracted facts feed the inline-resolution judge
      // (the "new" side — these aren't written yet).
      const incomingFacts = extraction.facts
        .filter((f: { entityIndex: number }) => f.entityIndex === i)
        .map((f: { predicate: string; object: string }) => `${f.predicate}: ${f.object}`);
      const eid = await traceSpan(
        'ingest.entity.resolve',
        () =>
          this.entities.resolveOrCreateNamedEntity({
            db,
            e,
            hint: knownHint,
            _contextRef: dto.contextRef,
            incomingFacts,
          }),
        { name: e.name, type: e.type },
      );
      entityIds.push(eid);
    }
    return entityIds;
  }

  private async persistFacts(
    db: Surreal,
    p: {
      companyId: string;
      dto: IngestMentionDto;
      extraction: any;
      source: MentionSource;
      factEmbeddings: number[][];
      entityIds: string[];
    },
  ): Promise<string[]> {
    const { companyId, dto, extraction, source, factEmbeddings, entityIds } = p;
    const factIds: string[] = [];
    for (let i = 0; i < extraction.facts.length; i++) {
      const f = extraction.facts[i];
      const eid = entityIds[f.entityIndex];
      if (!eid) continue;
      const factId = await traceSpan(
        'ingest.fact.upsert',
        () =>
          this.persistFact(db, {
            companyId,
            entityId: eid,
            f,
            source,
            validFrom: new Date(dto.emittedAt),
            precomputedEmbedding: factEmbeddings[i],
          }),
        { predicate: f.predicate, entityId: eid },
      );
      if (factId) factIds.push(factId);
    }
    return factIds;
  }

  /**
   * Insert a single fact extracted from a mention. Routes through
   * fn::resolve_fact (via FactResolverService) so chat-extracted facts get the
   * same conflict-resolution treatment as directly-ingested ones — single_active
   * predicates close prior values via validUntil chaining, append_only inserts,
   * bitemporal supersedes/competes. Locale + entropy ride into the function as
   * params (migration 0039), INSERTED-only.
   */
  private async persistFact(
    db: Surreal,
    p: {
      companyId: string;
      entityId: string;
      f: {
        predicate: string;
        object: string;
        confidence: number;
        extractionEntropy?: number;
      };
      source: MentionSource;
      validFrom: Date;
      precomputedEmbedding: number[] | undefined;
    },
  ): Promise<string | null> {
    const { f } = p;
    const entropy =
      typeof f.extractionEntropy === 'number' ? f.extractionEntropy : undefined;
    const { result, semantics } = await this.factResolver.resolve(db, {
      companyId: p.companyId,
      entityId: p.entityId,
      predicate: f.predicate,
      object: f.object,
      confidence: f.confidence,
      validFrom: p.validFrom,
      source: p.source,
      entropy,
      precomputedEmbedding: p.precomputedEmbedding,
    });

    const factId = result?.factId ? String(result.factId) : null;

    // Surface supersede / compete outcomes in the trace so the demo can show
    // "Berlin fact closed at July 1, Dublin became current" — otherwise the
    // chain is invisible to the operator.
    traceArtifact('ingest.fact.outcome', {
      predicate: f.predicate,
      // Symmetric with the redacted ingest.mention.input trace: mask any
      // email/phone/long-digit PII in the value before it lands in a debug
      // artifact. Non-PII values (city, tier, name) pass through unchanged.
      object: redactPii(f.object),
      outcome: result?.outcome,
      semantics,
      ...(result?.supersededFactIds
        ? { supersededFactIds: (result.supersededFactIds as unknown[]).map(String) }
        : {}),
      ...(result?.competingFactIds
        ? { competingFactIds: (result.competingFactIds as unknown[]).map(String) }
        : {}),
    });

    return factId;
  }

  /**
   * RELATE edges between already-resolved extracted entities. Each ExtractedEdge
   * bridges two entity IDs from the resolution pass; idempotent RELATE handles
   * duplicates from re-ingest.
   */
  private async persistEdges(
    db: Surreal,
    p: { extraction: any; entityIds: string[]; dto: IngestMentionDto },
  ): Promise<string[]> {
    const { extraction, entityIds, dto } = p;
    const edgeIds: string[] = [];
    for (const e of extraction.edges) {
      const fromEid = entityIds[e.fromEntityIndex];
      const toEid = entityIds[e.toEntityIndex];
      if (!fromEid || !toEid || fromEid === toEid) continue;
      try {
        const edgeId = await traceSpan(
          'ingest.edge.upsert',
          () =>
            this.createEdgeBetween(db, {
              fromEntityId: fromEid,
              toEntityId: toEid,
              kind: e.kind,
              source: {
                vertical: dto.contextRef.vertical,
                eventId: dto.contextRef.eventId,
                conversationId: dto.contextRef.conversationId,
                messageId: dto.contextRef.messageId,
                confidence: e.confidence,
              },
            }),
          { kind: e.kind, from: fromEid, to: toEid },
        );
        if (edgeId) edgeIds.push(edgeId);
      } catch (err) {
        this.logger.warn(
          `[ingest.edge] kind=${e.kind} from=${fromEid} to=${toEid} failed: ${(err as Error).message}`,
        );
      }
    }
    return edgeIds;
  }

  /**
   * Create a knowledge_edge between two ALREADY-resolved entity IDs.
   * Idempotent: UNIQUE on (in, out, kind) — concurrent / duplicate RELATEs
   * return the existing edge id.
   */
  private async createEdgeBetween(
    db: Surreal,
    p: {
      fromEntityId: string;
      toEntityId: string;
      kind: string;
      source: Record<string, unknown>;
    },
  ): Promise<string | null> {
    const fromRid = new StringRecordId(p.fromEntityId);
    const toRid = new StringRecordId(p.toEntityId);
    try {
      const [edgeRows] = await db.query<[any[]]>(
        `RELATE $from->knowledge_edge->$to CONTENT { kind: $kind, weight: $weight, source: $source } RETURN AFTER`,
        {
          from: fromRid,
          to: toRid,
          kind: p.kind,
          weight: 1.0,
          source: p.source,
        },
      );
      const edge = ((edgeRows as any[]) ?? [])[0];
      return edge ? String(edge.id) : null;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const [existingRows] = await db.query<[any[]]>(
        `SELECT id FROM knowledge_edge WHERE in = $from AND out = $to AND kind = $kind LIMIT 1`,
        { from: fromRid, to: toRid, kind: p.kind },
      );
      const existing = ((existingRows as any[]) ?? [])[0];
      return existing ? String(existing.id) : null;
    }
  }
}
