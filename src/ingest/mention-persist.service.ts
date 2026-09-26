import { Injectable, Logger } from '@nestjs/common';
import { Surreal, StringRecordId } from 'surrealdb';
import { SurrealService } from '../db/surreal.service';
import { IngestMentionDto } from './dto/ingest-mention.dto';
import { traceArtifact, traceSpan } from '../common/debug-trace';
import { redactPii } from './ingest-utils';
import { EntityUpsertService } from './entity-upsert.service';
import { FactResolverService } from './fact-resolver.service';
import {
  createEdgeBetween,
  edgeScopeKey,
  edgeTimeContent,
  edgeTimingWidens,
  edgeWidenStatements,
} from './edge-writer';
import { MentionSource } from './mention-extraction.service';
import type { ExtractionResult } from '../ai/extractor.service';
import type { ResolveOutcome } from './conflict-resolver';
import { coreferentParticipant, participantHint, participantsOf } from './participants';
import { relativeHint } from './relative-role';
import { envFlagEnabled } from '../common/env-validation';
import {
  edgeTiming,
  factExpectation,
  factTiming,
  resolveEventTimeOpts,
  type EdgeTiming,
  type EventTimeResolveOpts,
} from './event-time';

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
    extraction: ExtractionResult;
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
    p: { extraction: ExtractionResult; dto: IngestMentionDto },
  ): Promise<string[]> {
    const { extraction, dto } = p;
    // Speaker/addressee anchors for coreference. The OLD code paired
    // knownEntities to entities BY POSITION (knownEntities[i]), which only
    // ever hinted extraction.entities[0] and never the pronoun entity the
    // extractor actually emitted for a first-person statement — so "I decided
    // to transition" minted a junk "I" node instead of attaching to the
    // speaker. Resolve by ROLE instead, then hint each extracted entity by
    // coreference (participants.ts).
    const participants = participantsOf(dto);
    const entityIds: string[] = [];
    for (let i = 0; i < extraction.entities.length; i++) {
      const e = extraction.entities[i]!;
      // A relative named by role ("Father", "my mom") is the speaker's own
      // and anchors personal under the user's scope (relative-role.ts).
      const knownHint =
        participantHint(coreferentParticipant(e.name, participants), dto.userId) ??
        relativeHint(e, dto.userId);
      // The entity's freshly-extracted facts feed the inline-resolution judge
      // (the "new" side — these aren't written yet). Its EDGES go too, as
      // `kind: <other entity's name>` lines: the extractor files "works at
      // Orbital Dynamics" as an edge in one language and as a fact in
      // another, and a judge that only saw facts was comparing a full
      // profile against an empty one — measured: "Семён Белов" arrived with
      // a role and nothing else while "Semyon Belov" carried the employer
      // as a fact, and the judge, seeing no common ground, said different.
      const incomingFacts = extraction.facts
        .filter((f: { entityIndex: number }) => f.entityIndex === i)
        .map((f: { predicate: string; object: string }) => `${f.predicate}: ${f.object}`);
      for (const edge of extraction.edges) {
        if (edge.fromEntityIndex !== i) continue;
        const other = extraction.entities[edge.toEntityIndex];
        if (other) incomingFacts.push(`${edge.kind}: ${other.name}`);
      }
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
      extraction: ExtractionResult;
      source: MentionSource;
      factEmbeddings: number[][];
      entityIds: string[];
    },
  ): Promise<string[]> {
    const { companyId, dto, extraction, source, factEmbeddings, entityIds } = p;
    const factIds: string[] = [];
    const timeOpts = resolveEventTimeOpts(dto.timezone);
    if (envFlagEnabled(process.env.INGEST_BATCH_FACTS)) {
      return this.persistFactsBatched(db, p, timeOpts);
    }
    for (let i = 0; i < extraction.facts.length; i++) {
      const f = extraction.facts[i]!;
      const eid = entityIds[f.entityIndex];
      if (!eid) continue;
      const { validFrom, validUntil, objectMeta } = factTiming(f, dto.emittedAt, timeOpts);
      // A value with a stated end carries no expectation (0166).
      const expectedUntil = validUntil
        ? undefined
        : factExpectation(f.expectedEnd, dto.emittedAt, validFrom);
      const factId = await traceSpan(
        'ingest.fact.upsert',
        () =>
          this.persistFact(db, {
            companyId,
            entityId: eid,
            f,
            source,
            validFrom,
            validUntil,
            expectedUntil,
            objectMeta,
            precomputedEmbedding: factEmbeddings[i],
            userId: dto.userId,
            // Subject entity's extraction type — read only by the
            // slot-canonicalization non-person guard (canonicalSlotFor).
            entityType: extraction.entities[f.entityIndex]?.type,
          }),
        { predicate: f.predicate, entityId: eid },
      );
      if (factId) factIds.push(factId);
    }
    return factIds;
  }

  /**
   * Batched fact persistence (flag INGEST_BATCH_FACTS): resolve all of a
   * mention's facts through FactResolverService.resolveMany — append_only facts
   * (the bulk) collapse into ONE fn::resolve_facts round-trip, single_active /
   * bitemporal keep the per-fact + lock path. Same observable outcome as the
   * per-fact loop; the trace tail is shared (emitFactOutcome).
   */
  private async persistFactsBatched(
    db: Surreal,
    p: {
      companyId: string;
      dto: IngestMentionDto;
      extraction: ExtractionResult;
      source: MentionSource;
      factEmbeddings: number[][];
      entityIds: string[];
    },
    timeOpts: EventTimeResolveOpts,
  ): Promise<string[]> {
    const { companyId, dto, extraction, source, factEmbeddings, entityIds } = p;
    const specs: Array<{
      f: { predicate: string; object: string };
      input: Parameters<FactResolverService['resolve']>[1];
    }> = [];
    for (let i = 0; i < extraction.facts.length; i++) {
      const f = extraction.facts[i]!;
      const eid = entityIds[f.entityIndex];
      if (!eid) continue;
      const { validFrom, validUntil, objectMeta } = factTiming(f, dto.emittedAt, timeOpts);
      // A value with a stated end carries no expectation (0166).
      const expectedUntil = validUntil
        ? undefined
        : factExpectation(f.expectedEnd, dto.emittedAt, validFrom);
      specs.push({
        f,
        input: {
          companyId,
          entityId: eid,
          predicate: f.predicate,
          predicateAlias: f.predicateAlias,
          object: f.object,
          confidence: f.confidence,
          validFrom,
          validUntil,
          expectedUntil,
          objectMeta,
          supersedes: f.supersedes,
          source,
          entropy: typeof f.extractionEntropy === 'number' ? f.extractionEntropy : undefined,
          precomputedEmbedding: factEmbeddings[i],
          // Audit 2026-08-21 P0: the per-user scope stamps every
          // extracted fact on the batched path too.
          userId: dto.userId,
          // Subject entity's extraction type — read only by the
          // slot-canonicalization non-person guard (canonicalSlotFor).
          entityType: extraction.entities[f.entityIndex]?.type,
        },
      });
    }
    if (specs.length === 0) return [];

    const resolved = await traceSpan(
      'ingest.facts.batch',
      () =>
        this.factResolver.resolveMany(
          db,
          specs.map((s) => s.input),
        ),
      { facts: specs.length },
    );
    const factIds: string[] = [];
    resolved.forEach((r, k) => {
      // resolved is 1:1 with specs (resolveMany preserves order) ⇒ in-bounds.
      const factId = this.emitFactOutcome(specs[k]!.f, r.result, r.semantics);
      if (factId) factIds.push(factId);
    });
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
        predicateAlias?: string | undefined;
        object: string;
        confidence: number;
        extractionEntropy?: number | undefined;
        supersedes?: string[] | undefined;
      };
      source: MentionSource;
      validFrom: Date;
      validUntil?: Date | undefined;
      /** When a temporary state is expected to be over (0166). */
      expectedUntil?: Date | undefined;
      objectMeta?: { date: string } | undefined;
      precomputedEmbedding: number[] | undefined;
      /** Per-user scope (audit 2026-08-21 P0) — stamps the fact row. */
      userId?: string | undefined;
      /** Subject entity's extraction type (slot-canonicalization guard). */
      entityType?: string | undefined;
    },
  ): Promise<string | null> {
    const { f } = p;
    const entropy = typeof f.extractionEntropy === 'number' ? f.extractionEntropy : undefined;
    const { result, semantics } = await this.factResolver.resolve(db, {
      companyId: p.companyId,
      entityId: p.entityId,
      predicate: f.predicate,
      predicateAlias: f.predicateAlias,
      object: f.object,
      confidence: f.confidence,
      validFrom: p.validFrom,
      validUntil: p.validUntil,
      expectedUntil: p.expectedUntil,
      objectMeta: p.objectMeta,
      supersedes: f.supersedes,
      source: p.source,
      entropy,
      precomputedEmbedding: p.precomputedEmbedding,
      userId: p.userId,
      entityType: p.entityType,
    });
    return this.emitFactOutcome(f, result, semantics);
  }

  /**
   * Surface supersede / compete outcomes in the trace so the demo can show
   * "Berlin fact closed at July 1, Dublin became current" — otherwise the
   * chain is invisible to the operator. Returns the resolved factId. Shared
   * by the per-fact and batched (resolveMany) persist paths.
   */
  private emitFactOutcome(
    f: { predicate: string; object: string },
    result: ResolveOutcome,
    semantics: string,
  ): string | null {
    const factId = result?.factId ? String(result.factId) : null;
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
    p: { extraction: ExtractionResult; entityIds: string[]; dto: IngestMentionDto },
  ): Promise<string[]> {
    const { extraction, entityIds, dto } = p;
    if (envFlagEnabled(process.env.INGEST_BATCH_EDGES)) {
      return this.persistEdgesBatched(db, { extraction, entityIds, dto });
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
              // The relation is as personal as the facts of the same turn.
              userId: dto.userId,
              // Valid time from the days the extractor resolved (0164).
              ...edgeTiming(e, dto.emittedAt),
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
    p: { extraction: ExtractionResult; entityIds: string[]; dto: IngestMentionDto },
  ): Promise<string[]> {
    const { extraction, entityIds, dto } = p;
    // Deduplicate candidates within the batch: the extraction can emit the
    // same (from,to,kind) twice, which the per-edge loop would resolve to
    // the same id twice. One entry keeps the RELATE batch collision-free.
    const seen = new Set<string>();
    const cands: Array<
      { from: string; to: string; kind: string; confidence: number } & EdgeTiming
    > = [];
    for (const e of extraction.edges) {
      const from = entityIds[e.fromEntityIndex];
      const to = entityIds[e.toEntityIndex];
      if (!from || !to || from === to) continue;
      const key = `${from} ${to} ${e.kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      cands.push({
        from,
        to,
        kind: e.kind,
        confidence: e.confidence,
        ...edgeTiming(e, dto.emittedAt),
      });
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
        // 1. One round-trip existence check (N SELECTs, one query), within
        //    the turn's scope: a personal edge never stands in for the
        //    tenant-global one, nor the other way round.
        const existParams: Record<string, unknown> = { scopeKey: edgeScopeKey(dto.userId) };
        const existStmts = cands
          .map((c, i) => {
            existParams[`f${i}`] = new StringRecordId(c.from);
            existParams[`t${i}`] = new StringRecordId(c.to);
            existParams[`k${i}`] = c.kind;
            return `SELECT id, validFrom, validUntil FROM knowledge_edge WHERE in=$f${i} AND out=$t${i} AND kind=$k${i} AND scopeKey=$scopeKey LIMIT 1;`;
          })
          .join('\n');
        const existResults = await db.query<unknown[]>(existStmts, existParams);

        const edgeIds: string[] = [];
        const missing: typeof cands = [];
        const widen: Array<{ id: string; c: (typeof cands)[number] }> = [];
        cands.forEach((c, i) => {
          const row = ((existResults[i] as ExistingEdgeRow[]) ?? [])[0];
          if (!row?.id) {
            missing.push(c);
            return;
          }
          edgeIds.push(String(row.id));
          // A restated period the row already holds costs no write.
          if (edgeTimingWidens(row, c)) widen.push({ id: String(row.id), c });
        });
        // Best-effort: the edges exist either way; a failed fold leaves
        // their period as it was, never loses the link.
        await widenExisting(db, widen).catch((err: unknown) =>
          this.logger.warn(`[ingest.edge] period fold failed: ${(err as Error).message}`),
        );
        if (missing.length === 0) return edgeIds;

        // 2. One round-trip RELATE for the missing edges.
        try {
          const relParams: Record<string, unknown> = { userId: dto.userId };
          const relStmts = missing
            .map((c, i) => {
              relParams[`f${i}`] = new StringRecordId(c.from);
              relParams[`t${i}`] = new StringRecordId(c.to);
              relParams[`k${i}`] = c.kind;
              relParams[`s${i}`] = sourceOf(c);
              const time = edgeTimeContent(c, String(i));
              Object.assign(relParams, time.params);
              return `RELATE $f${i}->knowledge_edge->$t${i} CONTENT { kind: $k${i}, weight: 1.0, source: $s${i}, userId: $userId${time.fields} } RETURN AFTER;`;
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
                userId: dto.userId,
                validFrom: c.validFrom,
                validUntil: c.validUntil,
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

/** An existing edge as the batched existence check projects it. */
interface ExistingEdgeRow {
  id: unknown;
  validFrom?: unknown;
  validUntil?: unknown;
}

/**
 * A re-stated relation may bound the period its row holds — the same
 * fold the per-edge primitive applies on its UNIQUE hit, for every
 * existing edge of the batch in one round-trip.
 */
async function widenExisting(
  db: Surreal,
  existing: Array<{ id: string; c: EdgeTiming }>,
): Promise<void> {
  const stmts: string[] = [];
  const params: Record<string, unknown> = {};
  existing.forEach(({ id, c }, i) => {
    const w = edgeWidenStatements(id, c, { suffix: String(i) });
    stmts.push(...w.stmts);
    Object.assign(params, w.params);
  });
  if (stmts.length > 0) await db.query(stmts.join('\n'), params);
}
