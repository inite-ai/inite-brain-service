import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MetricsService } from '../metrics/metrics.service';
import { Surreal, StringRecordId } from 'surrealdb';
import {
  SurrealService,
  dbCreate,
  dbMerge,
  isUniqueViolation,
  retryOnUniqueViolation,
  runTransaction,
} from '../db/surreal.service';
import { EmbedderService } from '../ai/embedder.service';
import { ExtractorService } from '../ai/extractor.service';
import { HypeService } from '../ai/hype.service';
import { PredicateRegistryService } from '../ai/predicate-registry.service';
import { IngestFactDto } from './dto/ingest-fact.dto';
import { IngestMentionDto } from './dto/ingest-mention.dto';
import { IngestLinkDto } from './dto/ingest-link.dto';
import { ConflictConfig, SOURCE_TRUST } from './conflict-resolver';
import { traceSpan, traceArtifact } from '../common/debug-trace';
import {
  buildConflictExplanation,
  type ConflictExplanation,
  type ResolverConflictPayload,
} from './conflict-explainer';
import { detectLanguage } from '../ai/locale/language-detector';

export type IngestOutcome =
  | 'INSERTED'
  | 'SUPERSEDED'
  | 'COMPETING'
  | 'REJECTED';

export interface IngestResult {
  factId: string | null;
  outcome: IngestOutcome;
  supersededFactIds?: string[];
  competingFactIds?: string[];
  reason?: string;
  /**
   * Populated only when the IngestFactDto carried `explain: true` AND
   * the outcome is SUPERSEDED or COMPETING. Carries the TruthfulRAG-
   * style slot delta + dominant dimension + score breakdown explaining
   * why the new fact beat (or competes with) the strongest prior.
   *
   * See `conflict-explainer.ts` for the shape and the deterministic
   * narrative template.
   */
  conflictExplanation?: ConflictExplanation;
}

@Injectable()
export class IngestService {
  private readonly logger = new Logger(IngestService.name);
  private readonly conflict: ConflictConfig;

  constructor(
    private readonly surreal: SurrealService,
    private readonly embedder: EmbedderService,
    private readonly extractor: ExtractorService,
    private readonly hype: HypeService,
    private readonly configService: ConfigService,
    private readonly predicateRegistry: PredicateRegistryService,
    @Optional() private readonly metrics?: MetricsService,
  ) {
    this.conflict = {
      similarityThreshold: this.cfgNum('CONFLICT_SIMILARITY_THRESHOLD', 0.85),
      weights: {
        confidence:  this.cfgNum('CONFLICT_WEIGHT_CONFIDENCE',  0.30),
        sourceTrust: this.cfgNum('CONFLICT_WEIGHT_SOURCE_TRUST', 0.40),
        recency:     this.cfgNum('CONFLICT_WEIGHT_RECENCY',     0.20),
        authority:   this.cfgNum('CONFLICT_WEIGHT_AUTHORITY',   0.10),
      },
      marginForSupersede: this.cfgNum('CONFLICT_MARGIN_SUPERSEDE',  0.15),
      rejectThreshold:    this.cfgNum('CONFLICT_REJECT_THRESHOLD', 0.30),
    };
  }

  async ingestFact(companyId: string, dto: IngestFactDto): Promise<IngestResult> {
    return this.surreal.withCompany(companyId, async (db) => {
      // 1. Resolve entity (own atomic step — own tx with unique-retry).
      const entityId = await this.resolveOrCreateEntity(db, dto);

      // 2. Compute embedding (cached LRU per process inside EmbedderService).
      const embeddingText = `${dto.predicate}: ${dto.object}`;
      const embedding = await this.embedder.embed(embeddingText);

      // 3. Read policy from the per-tenant registry. Pre-warm the snapshot
      //    so the cache is populated before the synchronous policyFor()
      //    lookup inside fn::resolve_fact param assembly. Defensive: a
      //    registry bootstrap failure must not 500 the typed-fact ingest
      //    — policyFor falls back to the JS seed.
      try {
        await this.predicateRegistry.getSnapshot(companyId);
      } catch (e) {
        this.logger.warn(
          `ingest: predicate registry getSnapshot failed for ${companyId}: ${(e as Error).message}; using seed policy`,
        );
      }
      const policy = this.predicateRegistry.policyFor(companyId, dto.predicate);
      const sourceTrust = this.sourceTrustFor(dto.source);

      // 4. Object preservation. Schema stores `object` as string for
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

      // 5. One-RTT server-side resolve. `fn::resolve_fact` (migration
      //    0006) does: filter by cosine for bitemporal → score → decide
      //    INSERTED/SUPERSEDED/COMPETING/REJECTED → CREATE + cascade.
      //    The whole pipeline runs inside SurrealDB's single-statement
      //    evaluation context: atomic without our hand-rolled tx.
      //
      //    Wrapped in retryOnUniqueViolation because the new CREATE
      //    can still hit a write-set conflict under heavy concurrency
      //    (multiple FANOUT inserts targeting the same entity+predicate);
      //    retry sees the racing committer's row and either supersedes
      //    or competes correctly on the second attempt.
      const result = await retryOnUniqueViolation(async () => {
        const [r] = await db.query<[any]>(
          `RETURN fn::resolve_fact(
              type::thing('knowledge_entity', $eid),
              $predicate, $object, $object_meta, $embedding,
              $confidence, $valid_from, $valid_until, $source,
              $source_trust, $semantics, $similarity_threshold,
              $w_confidence, $w_source_trust, $w_recency, $w_authority,
              $reject_threshold, $margin_for_supersede
           )`,
          {
            eid: idTailOf(entityId),
            predicate: dto.predicate,
            object: objectStr,
            object_meta: objectMeta,
            embedding,
            confidence: dto.confidence ?? 0.7,
            valid_from: new Date(dto.validFrom),
            valid_until: dto.validUntil ? new Date(dto.validUntil) : undefined,
            source: dto.source,
            source_trust: sourceTrust,
            semantics: policy.semantics,
            similarity_threshold: this.conflict.similarityThreshold,
            w_confidence: this.conflict.weights.confidence,
            w_source_trust: this.conflict.weights.sourceTrust,
            w_recency: this.conflict.weights.recency,
            w_authority: this.conflict.weights.authority,
            reject_threshold: this.conflict.rejectThreshold,
            margin_for_supersede: this.conflict.marginForSupersede,
          },
        );
        return r;
      });

      const factId = result?.factId ? String(result.factId) : null;
      const outcome = result?.outcome as IngestOutcome;

      // Phase 4.A locale tagging. Detect language + script on the
      // object span (the "what is true about the entity" text) and
      // persist alongside the fact. We tag on INSERTED only — for
      // SUPERSEDED/COMPETING the new fact is already in `factId`
      // and the previous tag, if any, stays valid for the loser row.
      if (factId && outcome === 'INSERTED') {
        const detected = detectLanguage(objectStr);
        if (detected.language !== 'und') {
          await db.query(
            `UPDATE type::thing('knowledge_fact', $tail)
                SET lang = $lang, script = $script`,
            {
              tail: idTailOf(factId),
              lang: detected.language,
              script: detected.script,
            },
          );
        }
      }

      // HyPE: generate a hypothetical-question embedding and write
      // it onto the new fact. We do this synchronously inside the
      // ingest flow so the post-condition "fact is searchable with
      // alt-embedding" holds immediately. When SEARCH_HYPE_ENABLED
      // is off, hype.generateAltEmbedding returns null and we skip
      // the UPDATE entirely — no extra latency on ingest.
      if (factId && this.hype.isEnabled() && outcome === 'INSERTED') {
        const altEmbedding = await this.hype.generateAltEmbedding(
          dto.predicate,
          objectStr,
        );
        if (altEmbedding) {
          await db.query(
            `UPDATE type::thing('knowledge_fact', $tail) SET altEmbedding = $emb`,
            { tail: idTailOf(factId), emb: altEmbedding },
          );
        }
      }

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
      this.recordIngestFactMetric(outcome);
      return out;
    });
  }

  /**
   * Resolve an entity by externalRef, creating it if absent. Atomic against
   * concurrent ingests — relies on UNIQUE on entity_external_ref.key. The
   * pattern is: indexed read first (the common path), and on miss enter a
   * transaction that re-reads under tx scope and creates both rows or neither.
   * On a unique violation (another caller created the same ref between our
   * read and write) we retry; the next read finds the row.
   */
  private async resolveOrCreateEntity(db: Surreal, dto: IngestFactDto): Promise<string> {
    if ('entityId' in dto.entityRef && dto.entityRef.entityId) {
      return dto.entityRef.entityId;
    }
    const ref = dto.entityRef as { vertical: string; id: string };
    const refKey = externalRefKey(ref.vertical, ref.id);
    return this.upsertEntityByExternalRef(db, refKey, () => ({
      type: 'other',
      canonicalName: ref.id,
      externalRefs: { [refKey]: ref.id },
    }));
  }

  private async upsertEntityByExternalRef(
    db: Surreal,
    key: string,
    factory: () => Record<string, unknown>,
  ): Promise<string> {
    // SurrealDB v2.2.8 surfaces concurrent UNIQUE-key CREATEs as either
    // a unique-index violation or a commit-time read/write conflict;
    // both are caught by retryOnUniqueViolation. The retry's second
    // SELECT picks up the racing committer's row.
    return retryOnUniqueViolation(async () => {
      const fast = await this.lookupExternalRef(db, key);
      if (fast) return fast;

      const content = factory();
      const result = await runTransaction<{ id: unknown } | null>(db, (tx) => {
        tx.bind('content', content);
        tx.bind('key', key);
        tx.add('LET $new = (CREATE ONLY knowledge_entity CONTENT $content)');
        tx.add('CREATE entity_external_ref CONTENT { key: $key, entity: $new.id }');
        tx.add('RETURN $new');
      });
      return String(result?.id);
    });
  }

  private async lookupExternalRef(db: Surreal, key: string): Promise<string | null> {
    const [rows] = await db.query<[any[]]>(
      `SELECT VALUE entity FROM entity_external_ref WHERE key = $key LIMIT 1`,
      { key },
    );
    const arr = (rows as any[]) ?? [];
    return arr[0] ? String(arr[0]) : null;
  }

  // Extracted to keep `ingestFact`'s cyclomatic complexity under the
  // 25-branch eslint ceiling — the `if (outcome)` branch alone pushed
  // the analyser over.
  private recordIngestFactMetric(outcome: unknown): void {
    if (outcome) this.metrics?.countIngestFact(String(outcome));
  }

  private sourceTrustFor(source: { vertical: string; eventId?: string; messageId?: string }): number {
    // Heuristic: derive a trust label from source shape.
    if (source.eventId?.startsWith('billing.'))   return SOURCE_TRUST.billing_event;
    if (source.eventId?.startsWith('incidents.')) return SOURCE_TRUST.incidents_event;
    if (source.eventId?.startsWith('auth.'))      return SOURCE_TRUST.auth_event;
    if (source.messageId)                         return SOURCE_TRUST.inbox_extraction;
    return SOURCE_TRUST.default;
  }

  // ── ingestMention: free-text → LLM extraction → fact records ─────────
  async ingestMention(companyId: string, dto: IngestMentionDto) {
    try {
      return await this.runIngestMention(companyId, dto);
    } catch (err) {
      // Record the failure on the metric counter before re-throwing so the
      // operator sees mention-ingest-failure spikes without grepping logs.
      this.metrics?.countIngestMention('failed');
      throw err;
    }
  }

  private async runIngestMention(companyId: string, dto: IngestMentionDto) {
    return traceSpan('ingest.mention', async () => {
      const text = redactPii(dto.text);
      traceArtifact('ingest.mention.input', {
        text,
        contextRef: dto.contextRef,
        knownEntities: dto.knownEntities,
      });

      if (!text.trim()) {
        this.metrics?.countIngestMention('skipped');
        return { skipped: true, reason: 'empty', extractedEntityIds: [], extractedFactIds: [] };
      }

      const extraction = await traceSpan('ingest.nlu.extract', () =>
        this.extractor.extract(text, companyId),
      );
      traceArtifact('ingest.nlu.extracted', extraction);

      if (extraction.entities.length === 0) {
        this.metrics?.countIngestMention('skipped');
        return {
          skipped: true,
          reason: 'no_entities',
          extractedEntityIds: [],
          extractedFactIds: [],
        };
      }

      return this.surreal.withCompany(companyId, async (db) => {
        const entityIds: string[] = [];
        const factIds: string[] = [];

        for (let i = 0; i < extraction.entities.length; i++) {
          const e = extraction.entities[i];
          const knownHint = dto.knownEntities?.[i];
          const eid = await traceSpan(
            'ingest.entity.resolve',
            () =>
              this.resolveOrCreateNamedEntity(
                db,
                e,
                knownHint,
                dto.contextRef,
              ),
            { name: e.name, type: e.type },
          );
          entityIds.push(eid);
        }

        for (const f of extraction.facts) {
          const eid = entityIds[f.entityIndex];
          if (!eid) continue;
          const sourceFromContext = {
            vertical: dto.contextRef.vertical,
            eventId: dto.contextRef.eventId,
            conversationId: dto.contextRef.conversationId,
            messageId: dto.contextRef.messageId,
          };
          const result = await traceSpan(
            'ingest.fact.upsert',
            () =>
              this.recordExtractedFact(db, companyId, eid, {
                predicate: f.predicate,
                object: f.object,
                confidence: f.confidence,
                validFrom: new Date(dto.emittedAt),
                source: sourceFromContext,
                extractionEntropy: f.extractionEntropy,
              }),
            { predicate: f.predicate, entityId: eid },
          );
          if (result.factId) factIds.push(result.factId);
        }

        // Edges between extracted entities. Each ExtractedEdge bridges
        // two already-resolved entity IDs; idempotent RELATE handles
        // duplicates from re-ingest. Failure on a single edge does not
        // block the rest of the ingest — operator can re-run.
        const edgeIds: string[] = [];
        for (const e of extraction.edges) {
          const fromEid = entityIds[e.fromEntityIndex];
          const toEid = entityIds[e.toEntityIndex];
          if (!fromEid || !toEid || fromEid === toEid) continue;
          try {
            const edgeId = await traceSpan(
              'ingest.edge.upsert',
              () =>
                this.createEdgeBetween(db, fromEid, toEid, e.kind, {
                  vertical: dto.contextRef.vertical,
                  eventId: dto.contextRef.eventId,
                  conversationId: dto.contextRef.conversationId,
                  messageId: dto.contextRef.messageId,
                  confidence: e.confidence,
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

        traceArtifact('ingest.mention.result', { entityIds, factIds, edgeIds });
        this.metrics?.countIngestMention('extracted');
        return {
          skipped: false,
          extractedEntityIds: entityIds,
          extractedFactIds: factIds,
          extractedEdgeIds: edgeIds,
        };
      });
    });
  }

  /**
   * Create a knowledge_edge between two ALREADY-resolved entity IDs.
   * Used by ingestMention after extraction emits edges[] — we already
   * have the entity IDs from the entity-resolution pass, no need to
   * round-trip through external refs.
   *
   * Idempotent: UNIQUE on (in, out, kind) — concurrent / duplicate
   * RELATEs return the existing edge id.
   */
  private async createEdgeBetween(
    db: Surreal,
    fromEntityId: string,
    toEntityId: string,
    kind: string,
    source: Record<string, unknown>,
  ): Promise<string | null> {
    const fromRid = new StringRecordId(fromEntityId);
    const toRid = new StringRecordId(toEntityId);
    try {
      const [edgeRows] = await db.query<[any[]]>(
        `RELATE $from->knowledge_edge->$to CONTENT { kind: $kind, weight: $weight, source: $source } RETURN AFTER`,
        {
          from: fromRid,
          to: toRid,
          kind,
          weight: 1.0,
          source,
        },
      );
      const edge = ((edgeRows as any[]) ?? [])[0];
      return edge ? String(edge.id) : null;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const [existingRows] = await db.query<[any[]]>(
        `SELECT id FROM knowledge_edge WHERE in = $from AND out = $to AND kind = $kind LIMIT 1`,
        { from: fromRid, to: toRid, kind },
      );
      const existing = ((existingRows as any[]) ?? [])[0];
      return existing ? String(existing.id) : null;
    }
  }

  // ── ingestLink: declare an edge between two entities ─────────────────
  async ingestLink(companyId: string, dto: IngestLinkDto) {
    return this.surreal.withCompany(companyId, async (db) => {
      const fromId = await this.resolveOrCreateBareRef(db, dto.from as any);
      const toId = await this.resolveOrCreateBareRef(db, dto.to as any);

      // Idempotent edge insert. UNIQUE on (in, out, kind) means the second
      // insert of the same conceptual edge raises a unique violation; we
      // catch it and return the existing edge so duplicate webhook replays
      // don't pollute the graph with N copies of the same relationship.
      const fromRid = new StringRecordId(fromId);
      const toRid = new StringRecordId(toId);
      let edgeId: string | null = null;
      try {
        const [edgeRows] = await db.query<[any[]]>(
          `RELATE $from->knowledge_edge->$to CONTENT { kind: $kind, weight: $weight, source: $source } RETURN AFTER`,
          {
            from: fromRid,
            to: toRid,
            kind: dto.kind,
            weight: dto.weight ?? 1.0,
            source: dto.source,
          },
        );
        const edge = ((edgeRows as any[]) ?? [])[0];
        edgeId = edge ? String(edge.id) : null;
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        const [existingRows] = await db.query<[any[]]>(
          `SELECT id FROM knowledge_edge WHERE in = $from AND out = $to AND kind = $kind LIMIT 1`,
          { from: fromRid, to: toRid, kind: dto.kind },
        );
        const existing = ((existingRows as any[]) ?? [])[0];
        edgeId = existing ? String(existing.id) : null;
        this.logger.debug(
          `[knowledge.edge.idempotent] companyId=${companyId} kind=${dto.kind} ${fromId} → ${toId} (already existed)`,
        );
      }

      this.logger.log(
        `[knowledge.edge.created] companyId=${companyId} kind=${dto.kind} ${fromId} → ${toId}`,
      );

      // Optional: identity merge on kind='identity_of'
      if (dto.kind === 'identity_of') {
        await dbMerge(db, toId, {
          mergedAt: new Date(),
          mergedInto: new StringRecordId(fromId),
        });
        this.logger.log(
          `[knowledge.entity.merged] companyId=${companyId} loser=${toId} survivor=${fromId}`,
        );
      }

      return { edgeId, fromEntityId: fromId, toEntityId: toId, kind: dto.kind };
    });
  }

  // ── helpers used by mention + link ───────────────────────────────────

  private async resolveOrCreateNamedEntity(
    db: Surreal,
    e: { name: string; type: string; canonical?: string },
    hint: { vertical: string; id: string; role?: string } | undefined,
    _contextRef: { vertical: string },
  ): Promise<string> {
    // 1. Caller hint wins — same atomic upsert as fact ingest.
    if (hint) {
      const hintKey = externalRefKey(hint.vertical, hint.id);
      return this.upsertEntityByExternalRef(db, hintKey, () => ({
        type: this.normalizeEntityType(e.type),
        canonicalName: e.canonical ?? e.name,
        aliases: [e.name],
        externalRefs: { [hintKey]: hint.id },
      }));
    }

    // 2. Canonical-name match. Hits `entity_canonical_lc_idx` directly
    // via the stored `canonicalNameLc` VALUE field — no per-row
    // `string::lowercase()` evaluation needed. Two concurrent ingests
    // of the same name can still both miss and both create; we accept
    // the rare alias-only dup (same legal entity, two records) since
    // name canonicalisation is heuristic. Identity merge via
    // ingestLink consolidates downstream.
    const target = (e.canonical ?? e.name).toLowerCase();
    const [nRows] = await db.query<any[][]>(
      `SELECT id FROM knowledge_entity
       WHERE canonicalNameLc = $name
          OR aliases CONTAINS $rawName
       LIMIT 1`,
      { name: target, rawName: e.name },
    );
    const nRow = ((nRows as any[]) ?? [])[0];
    if (nRow) return String(nRow.id);

    const created = await dbCreate<any>(db, 'knowledge_entity', {
      type: this.normalizeEntityType(e.type),
      canonicalName: e.canonical ?? e.name,
      aliases: [e.name],
      externalRefs: {},
    });
    return String(created?.id);
  }

  private async resolveOrCreateBareRef(
    db: Surreal,
    ref: { vertical: string; id: string } | { entityId: string },
  ): Promise<string> {
    if ('entityId' in ref && ref.entityId) {
      return ref.entityId.includes(':') ? ref.entityId : `knowledge_entity:${ref.entityId}`;
    }
    const r = ref as { vertical: string; id: string };
    const refKey = externalRefKey(r.vertical, r.id);
    return this.upsertEntityByExternalRef(db, refKey, () => ({
      type: 'other',
      canonicalName: r.id,
      externalRefs: { [refKey]: r.id },
    }));
  }

  /**
   * Insert a fact already extracted from a mention. Skips the full conflict
   * pipeline (which is paid by ingest-fact). Mention extraction is best-effort
   * and noisy, so we let the conflict-resolution pass at search time handle
   * dedup via embeddings + decay rather than blocking ingest.
   */
  private async recordExtractedFact(
    db: Surreal,
    companyId: string,
    entityId: string,
    factPayload: {
      predicate: string;
      object: string;
      confidence: number;
      validFrom: Date;
      source: any;
      extractionEntropy?: number;
    },
  ): Promise<{
    factId: string | null;
    outcome?: IngestOutcome;
    supersededFactIds?: string[];
    competingFactIds?: string[];
  }> {
    const { predicate, object, confidence, validFrom, source } = factPayload;
    const embedding = await this.embedder.embed(`${predicate}: ${object}`);

    // Route through fn::resolve_fact so chat-extracted facts get the
    // same conflict-resolution treatment as directly-ingested ones.
    // Before this fix the mention path did a plain CREATE — every fact
    // landed as active regardless of predicate semantics, so
    // single_active predicates (name / email / address / status / tier)
    // never closed prior values via validUntil chaining. Bitemporal
    // demos through chat consequently couldn't show the "address was
    // Berlin in Feb, became Dublin in July" timeline; both rows just
    // coexisted with validUntil=NONE forever.
    //
    // fn::resolve_fact (migration 0009) handles all three semantics:
    //  - single_active: every prior active is closed (validUntil =
    //    newFact.validFrom, status = superseded) — SQL:2011 sequenced
    //    semantic.
    //  - append_only: no conflict possible, the new fact is inserted.
    //  - bitemporal: Allen's-overlap + cosine-similarity gated supersede
    //    or compete.
    // Pre-warm the per-tenant snapshot before the synchronous policyFor()
    // — covers the early-boot case where the mention path is the first
    // touch on this tenant. Defensive: a registry bootstrap failure (e.g.
    // schema mismatch on a fresh tenant) MUST NOT 500 the ingest path —
    // policyFor falls back to the JS CORE_PREDICATES seed when the cache
    // isn't populated.
    try {
      await this.predicateRegistry.getSnapshot(companyId);
    } catch (e) {
      this.logger.warn(
        `ingest: predicate registry getSnapshot failed for ${companyId}: ${(e as Error).message}; using seed policy`,
      );
    }
    const policy = this.predicateRegistry.policyFor(companyId, predicate);
    const sourceTrust = this.sourceTrustFor(source);
    const result = await retryOnUniqueViolation(async () => {
      const [r] = await db.query<[any]>(
        `RETURN fn::resolve_fact(
            type::thing('knowledge_entity', $eid),
            $predicate, $object, $object_meta, $embedding,
            $confidence, $valid_from, $valid_until, $source,
            $source_trust, $semantics, $similarity_threshold,
            $w_confidence, $w_source_trust, $w_recency, $w_authority,
            $reject_threshold, $margin_for_supersede
         )`,
        {
          eid: idTailOf(entityId),
          predicate,
          object,
          object_meta: undefined,
          embedding,
          confidence,
          valid_from: validFrom,
          valid_until: undefined,
          source,
          source_trust: sourceTrust,
          semantics: policy.semantics,
          similarity_threshold: this.conflict.similarityThreshold,
          w_confidence: this.conflict.weights.confidence,
          w_source_trust: this.conflict.weights.sourceTrust,
          w_recency: this.conflict.weights.recency,
          w_authority: this.conflict.weights.authority,
          reject_threshold: this.conflict.rejectThreshold,
          margin_for_supersede: this.conflict.marginForSupersede,
        },
      );
      return r;
    });

    const factId = result?.factId ? String(result.factId) : null;
    const outcome = result?.outcome as IngestOutcome | undefined;

    // Phase 4.A locale tagging + Phase 1 HyPE alt-embedding — must
    // apply to mention-ingested facts too, not just direct-ingest.
    // Pre-fix only ingestFact() ran these passes, so chat-router /
    // conversational corpora bypassed BOTH:
    //   - lang/script never set → the locale-pinned retrieval pass
    //     (where-builder lang filter) treated mention-ingested facts
    //     as language-agnostic and they only survived via the legacy
    //     `OR lang IS NONE` back-compat branch.
    //   - altEmbedding never written → the question-shaped HyPE max
    //     pool in runVectorLeg saw zero alt vectors for the conversa-
    //     tional half of the corpus.
    // Both passes mirror what ingestFact() does after fn::resolve_fact
    // (same `outcome === INSERTED` gate, same UPDATE shape), so the
    // demo-chat / chat-router path now has parity with the direct
    // ingestion path for both Phase 1 and Phase 4.A/B.
    if (factId && outcome === 'INSERTED') {
      const detected = detectLanguage(object);
      if (detected.language !== 'und') {
        await db.query(
          `UPDATE type::thing('knowledge_fact', $tail)
              SET lang = $lang, script = $script`,
          {
            tail: idTailOf(factId),
            lang: detected.language,
            script: detected.script,
          },
        );
      }
    }

    if (factId && this.hype.isEnabled() && outcome === 'INSERTED') {
      const altEmbedding = await this.hype.generateAltEmbedding(
        predicate,
        object,
      );
      if (altEmbedding) {
        await db.query(
          `UPDATE type::thing('knowledge_fact', $tail) SET altEmbedding = $emb`,
          { tail: idTailOf(factId), emb: altEmbedding },
        );
      }
    }

    // Phase 3.B — persist self-consistency entropy on INSERTED rows.
    // Only fires when EXTRACTOR_SC_PASSES > 1 produced a value;
    // single-pass extractions leave the column NONE.
    if (
      factId &&
      outcome === 'INSERTED' &&
      typeof factPayload.extractionEntropy === 'number'
    ) {
      await db.query(
        `UPDATE type::thing('knowledge_fact', $tail) SET extractionEntropy = $h`,
        { tail: idTailOf(factId), h: factPayload.extractionEntropy },
      );
    }

    // Surface supersede / compete outcomes in the trace so the demo can
    // show "Berlin fact closed at July 1, Dublin became current" —
    // otherwise the chain is invisible to the operator.
    traceArtifact('ingest.fact.outcome', {
      predicate,
      object,
      outcome,
      semantics: policy.semantics,
      ...(result?.supersededFactIds
        ? {
            supersededFactIds: (result.supersededFactIds as unknown[]).map(
              String,
            ),
          }
        : {}),
      ...(result?.competingFactIds
        ? {
            competingFactIds: (result.competingFactIds as unknown[]).map(
              String,
            ),
          }
        : {}),
    });

    return {
      factId,
      outcome,
      ...(result?.supersededFactIds
        ? {
            supersededFactIds: (result.supersededFactIds as unknown[]).map(
              String,
            ),
          }
        : {}),
      ...(result?.competingFactIds
        ? {
            competingFactIds: (result.competingFactIds as unknown[]).map(
              String,
            ),
          }
        : {}),
    };
  }

  private normalizeEntityType(t: string): string {
    const allowed = ['customer', 'staff', 'asset', 'project', 'topic', 'location', 'other'];
    return allowed.includes(t) ? t : 'other';
  }

  private cfgNum(key: string, fallback: number): number {
    const v = this.configService.get<string>(key);
    if (v === undefined) return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }
}

function idTailOf(rid: string): string {
  const i = rid.indexOf(':');
  return i === -1 ? rid : rid.slice(i + 1);
}

/**
 * Build a SurrealDB-safe externalRefs key. SurrealQL CONTENT treats dots
 * inside object keys as nested-path separators, so a key like
 * "rent.cust_42" silently expands into nested fields and is then dropped
 * by the schemafull `externalRefs: object` constraint. Replace dots with
 * a double underscore — the original `vertical.entityId` form is
 * recoverable but stored unambiguously as a single property.
 */
function externalRefKey(vertical: string, id: string): string {
  const safe = (s: string) => s.replace(/\./g, '__');
  return `${safe(vertical)}__${safe(id)}`;
}

/**
 * Naive PII redactor — masks emails, phone-like numbers, and 9+ digit runs.
 * 0.2.0 will replace this with @inite/assistant.piiMask once the package
 * exposes a server-side import path.
 */
function redactPii(text: string): string {
  return text
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[EMAIL]')
    .replace(/\+?\d[\d\s().-]{7,}\d/g, '[PHONE]')
    .replace(/\b\d{9,}\b/g, '[NUM]');
}
