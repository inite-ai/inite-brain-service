import { Injectable, Logger } from '@nestjs/common';
import { Surreal, StringRecordId } from 'surrealdb';
import { SurrealService } from '../db/surreal.service';
import { IngestMentionDto } from './dto/ingest-mention.dto';
import { traceArtifact, traceSpan } from '../common/debug-trace';
import { redactPii } from './ingest-utils';
import { EntityUpsertService } from './entity-upsert.service';
import { FactResolverService } from './fact-resolver.service';
import { createEdgeBetween } from './edge-writer';
import { MentionSource } from './mention-extraction.service';
import {
  isFirstPersonSelfReference,
  isSecondPersonReference,
  matchesParticipantName,
} from '../common/coreference';
import type { KnownEntity } from './dto/ingest-mention.dto';
import { envFlagEnabled } from '../common/env-validation';
import { resolveEventTime } from './event-time';

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

  /**
   * Decide which known participant (if any) an extracted entity corefers
   * to, so resolveOrCreateNamedEntity can anchor it to that participant's
   * externalRef instead of minting a pronoun/duplicate node:
   *   - first-person singular ("I", "me", "my") or the speaker's own name
   *     → the speaker;
   *   - second-person ("you", "your") or the addressee's own name
   *     → the addressee;
   *   - anything else → no hint (normal name/embedding resolution).
   * Returns undefined when no participant matches, preserving the prior
   * behaviour for third-party named entities.
   */
  private hintFor(
    e: { name: string },
    speaker: KnownEntity | undefined,
    addressee: KnownEntity | undefined,
  ): KnownEntity | undefined {
    if (
      speaker &&
      (isFirstPersonSelfReference(e.name) ||
        matchesParticipantName(e.name, speaker.name))
    ) {
      return speaker;
    }
    if (
      addressee &&
      (isSecondPersonReference(e.name) ||
        matchesParticipantName(e.name, addressee.name))
    ) {
      return addressee;
    }
    return undefined;
  }

  private async persistEntities(
    db: Surreal,
    p: { extraction: any; dto: IngestMentionDto },
  ): Promise<string[]> {
    const { extraction, dto } = p;
    // Speaker/addressee anchors for coreference. The OLD code paired
    // knownEntities to entities BY POSITION (knownEntities[i]), which only
    // ever hinted extraction.entities[0] and never the pronoun entity the
    // extractor actually emitted for a first-person statement — so "I decided
    // to transition" minted a junk "I" node instead of attaching to the
    // speaker. Resolve by ROLE instead, then hint each extracted entity by
    // coreference (see hintFor).
    const speakerHint = dto.knownEntities?.find((k) => k.role === 'speaker');
    const addresseeHint = dto.knownEntities?.find((k) => k.role === 'addressee');
    const entityIds: string[] = [];
    for (let i = 0; i < extraction.entities.length; i++) {
      const e = extraction.entities[i];
      const knownHint = this.hintFor(e, speakerHint, addresseeHint);
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
    const eventTimeOn = envFlagEnabled(
      process.env.INGEST_EVENT_TIME_EXTRACTION,
    );
    for (let i = 0; i < extraction.facts.length; i++) {
      const f = extraction.facts[i];
      const eid = entityIds[f.entityIndex];
      if (!eid) continue;
      // validFrom is the fact's occurrence time. A conversational clause often
      // refers to when something HAPPENED, in the past ("went yesterday",
      // "painted last year") — so when INGEST_EVENT_TIME_EXTRACTION is on and
      // the clause carries a resolvable relative expression, use the resolved
      // event date; otherwise fall back to the message time (prior behaviour).
      //
      // PROD CAVEAT (see docs/operations.md): a backdated validFrom on a
      // BITEMPORAL supersede can stamp the incumbent's validUntil earlier than
      // its own validFrom (inverted interval, fact hidden from asOf). single_active
      // is guarded (INSERTED_HISTORICAL); bitemporal is not. Keep the flag off in
      // prod until the supersede clamps validUntil ≥ validFrom.
      const event = eventTimeOn
        ? resolveEventTime(f.clause, dto.emittedAt)
        : null;
      const validFrom = event ? event.date : new Date(dto.emittedAt);
      if (event) {
        traceArtifact('ingest.fact.event_time', {
          predicate: f.predicate,
          expr: event.expr,
          resolved: event.date.toISOString().slice(0, 10),
          emittedAt: String(dto.emittedAt).slice(0, 10),
        });
      }
      const factId = await traceSpan(
        'ingest.fact.upsert',
        () =>
          this.persistFact(db, {
            companyId,
            entityId: eid,
            f,
            source,
            validFrom,
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
    if (envFlagEnabled(process.env.INGEST_BATCH_EDGES)) {
      return this.persistEdgesBatched(db, extraction, entityIds, dto);
    }
    const edgeIds: string[] = [];
    for (const e of extraction.edges) {
      const fromEid = entityIds[e.fromEntityIndex];
      const toEid = entityIds[e.toEntityIndex];
      if (!fromEid || !toEid || fromEid === toEid) continue;
      try {
        const edgeId = await traceSpan(
          'ingest.edge.upsert',
          () =>
            createEdgeBetween(db, {
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
   * Batched edge persistence (flag INGEST_BATCH_EDGES). Collapses the N
   * per-edge RELATE round-trips into TWO queries: one multi-statement
   * existence check, then one multi-statement RELATE for only the edges
   * that don't already exist. On re-ingest (all edges present) it's a
   * SINGLE round-trip. Same observable outcome as the per-edge loop —
   * idempotent RELATE keyed on UNIQUE(in,out,kind).
   *
   * The existence check makes the RELATE batch collision-free in the
   * common case, so a multi-statement RELATE (which throws atomically if
   * ANY statement trips the unique index) is safe. A concurrent writer
   * creating one of the missing edges between our check and RELATE is the
   * one residual race — we catch the throw and redo the missing set
   * through the per-edge idempotent primitive.
   */
  private async persistEdgesBatched(
    db: Surreal,
    extraction: any,
    entityIds: string[],
    dto: IngestMentionDto,
  ): Promise<string[]> {
    // Deduplicate candidates within the batch: the extraction can emit the
    // same (from,to,kind) twice, which the per-edge loop would resolve to
    // the same id twice. One entry keeps the RELATE batch collision-free.
    const seen = new Set<string>();
    const cands: Array<{ from: string; to: string; kind: string; confidence: number }> =
      [];
    for (const e of extraction.edges) {
      const from = entityIds[e.fromEntityIndex];
      const to = entityIds[e.toEntityIndex];
      if (!from || !to || from === to) continue;
      const key = `${from} ${to} ${e.kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      cands.push({ from, to, kind: e.kind, confidence: e.confidence });
    }
    if (cands.length === 0) return [];

    const sourceOf = (c: { confidence: number }) => ({
      vertical: dto.contextRef.vertical,
      eventId: dto.contextRef.eventId,
      conversationId: dto.contextRef.conversationId,
      messageId: dto.contextRef.messageId,
      confidence: c.confidence,
    });

    return traceSpan(
      'ingest.edge.batch',
      async () => {
        // 1. One round-trip existence check (N SELECTs, one query).
        const existParams: Record<string, unknown> = {};
        const existStmts = cands
          .map((c, i) => {
            existParams[`f${i}`] = new StringRecordId(c.from);
            existParams[`t${i}`] = new StringRecordId(c.to);
            existParams[`k${i}`] = c.kind;
            return `SELECT id FROM knowledge_edge WHERE in=$f${i} AND out=$t${i} AND kind=$k${i} LIMIT 1;`;
          })
          .join('\n');
        const existResults = await db.query<unknown[]>(existStmts, existParams);

        const edgeIds: string[] = [];
        const missing: typeof cands = [];
        cands.forEach((c, i) => {
          const row = ((existResults[i] as Array<{ id: unknown }>) ?? [])[0];
          if (row?.id) edgeIds.push(String(row.id));
          else missing.push(c);
        });
        if (missing.length === 0) return edgeIds;

        // 2. One round-trip RELATE for the missing edges.
        try {
          const relParams: Record<string, unknown> = {};
          const relStmts = missing
            .map((c, i) => {
              relParams[`f${i}`] = new StringRecordId(c.from);
              relParams[`t${i}`] = new StringRecordId(c.to);
              relParams[`k${i}`] = c.kind;
              relParams[`s${i}`] = sourceOf(c);
              return `RELATE $f${i}->knowledge_edge->$t${i} CONTENT { kind: $k${i}, weight: 1.0, source: $s${i} } RETURN AFTER;`;
            })
            .join('\n');
          const relResults = await db.query<unknown[]>(relStmts, relParams);
          missing.forEach((_c, i) => {
            const edge = ((relResults[i] as Array<{ id: unknown }>) ?? [])[0];
            if (edge?.id) edgeIds.push(String(edge.id));
          });
        } catch (err) {
          // Residual race: a concurrent writer created one of these between
          // the check and the RELATE, tripping UNIQUE(in,out,kind) and
          // failing the whole multi-statement query. Redo the missing set
          // through the per-edge idempotent primitive (each resolves its own
          // violation to the existing id).
          this.logger.warn(
            `[ingest.edge] batch RELATE fell back to per-edge: ${(err as Error).message}`,
          );
          for (const c of missing) {
            try {
              const id = await createEdgeBetween(db, {
                fromEntityId: c.from,
                toEntityId: c.to,
                kind: c.kind,
                source: sourceOf(c),
              });
              if (id) edgeIds.push(id);
            } catch (e2) {
              this.logger.warn(
                `[ingest.edge] kind=${c.kind} from=${c.from} to=${c.to} failed: ${(e2 as Error).message}`,
              );
            }
          }
        }
        return edgeIds;
      },
      { edges: cands.length },
    );
  }
}
