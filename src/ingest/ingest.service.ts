import {
  BadRequestException,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MetricsService } from '../metrics/metrics.service';
import { Surreal, StringRecordId } from 'surrealdb';
import {
  SurrealService,
  dbCreate,
  isUniqueViolation,
  retryOnUniqueViolation,
  runTransaction,
} from '../db/surreal.service';
import { EmbedderService } from '../ai/embedder.service';
import { ExtractorService } from '../ai/extractor.service';
import { HypeService } from '../ai/hype.service';
import { PredicateRegistryService } from '../ai/predicate-registry.service';
import { EntityResolverService } from './entity-resolver.service';
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
import { KeyedMutex } from '../common/keyed-mutex';

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
  // Serializes concurrent fn::resolve_fact calls on the same
  // (company, entity, predicate) so at most one row ends up active —
  // SurrealDB 3.x no longer raises the OCC conflict the retry loop
  // relied on for this case. See KeyedMutex.
  private readonly resolveLock = new KeyedMutex();
  private readonly conflict: ConflictConfig;

  constructor(
    private readonly surreal: SurrealService,
    private readonly embedder: EmbedderService,
    private readonly extractor: ExtractorService,
    private readonly hype: HypeService,
    private readonly configService: ConfigService,
    private readonly predicateRegistry: PredicateRegistryService,
    @Optional() private readonly metrics?: MetricsService,
    // @Optional: when the resolver isn't wired (or its flag is off), the
    // mention path simply skips inline resolution and creates new as before.
    @Optional() private readonly entityResolver?: EntityResolverService,
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

      // Detect locale up front so it rides into fn::resolve_fact as a param
      // (folded, INSERTED-only write — migration 0039) rather than a
      // follow-up UPDATE. detectLanguage is pure TS and never needed the
      // returned factId. 'und' → leave the fields unset (NONE), matching the
      // old `language !== 'und'` guard.
      const detLang = detectLanguage(objectStr);
      const detectedLang =
        detLang.language !== 'und'
          ? { lang: detLang.language, script: detLang.script }
          : { lang: undefined, script: undefined };

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
      // Phase 4.A locale tag (detectedLang) folded into fn::resolve_fact
      // (migration 0039) — set on INSERTED only, server-side, no follow-up RTT.
      // Direct ingest carries no extraction entropy.
      const result = await this.resolveFactCall(db, {
        companyId,
        entityId,
        predicate: dto.predicate,
        object: objectStr,
        objectMeta,
        embedding,
        confidence: dto.confidence ?? 0.7,
        validFrom: new Date(dto.validFrom),
        validUntil: dto.validUntil ? new Date(dto.validUntil) : undefined,
        source: dto.source,
        sourceTrust,
        semantics: policy.semantics,
        lang: detectedLang.lang,
        script: detectedLang.script,
        entropy: undefined,
      });

      const factId = result?.factId ? String(result.factId) : null;
      const outcome = result?.outcome as IngestOutcome;

      // Phase 4.A locale tagging now happens inside fn::resolve_fact via the
      // $lang/$script params above (migration 0039) — no follow-up UPDATE.

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
            `UPDATE type::record('knowledge_fact', $tail) SET altEmbedding = $emb`,
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
          // The entity's freshly-extracted facts feed the inline-resolution
          // judge (the "new" side — these aren't written yet).
          const incomingFacts = extraction.facts
            .filter((f) => f.entityIndex === i)
            .map((f) => `${f.predicate}: ${f.object}`);
          const eid = await traceSpan(
            'ingest.entity.resolve',
            () =>
              this.resolveOrCreateNamedEntity(
                db,
                e,
                knownHint,
                dto.contextRef,
                incomingFacts,
              ),
            { name: e.name, type: e.type },
          );
          entityIds.push(eid);
        }

        // Batched embed of every fact's `${predicate}: ${object}`
        // string in ONE call. Pre-batch each fact did its own embed
        // round-trip inside recordExtractedFact — N facts = N
        // sequential OpenAI calls before the loop could even start
        // the first fn::resolve_fact. embedMany hits the LRU first,
        // so re-ingest of identical clauses pays zero API calls.
        const sourceFromContext = {
          vertical: dto.contextRef.vertical,
          eventId: dto.contextRef.eventId,
          conversationId: dto.contextRef.conversationId,
          messageId: dto.contextRef.messageId,
          // Populate source.recorder so fn::source_key_of yields a
          // discriminating `vertical:recorder` key instead of `vertical:_`.
          // Caller-provided recorder wins; otherwise the extraction model id,
          // so source-trust scores LLM-extracted facts per model.
          recorder: dto.contextRef.recorder ?? this.extractor.modelId(),
        };
        const factTexts = extraction.facts.map(
          (f) => `${f.predicate}: ${f.object}`,
        );
        let factEmbeddings: number[][];
        try {
          factEmbeddings = await this.embedder.embedMany(factTexts);
        } catch (e) {
          // Fallback: let recordExtractedFact's per-row embed() handle
          // it. We'd rather pay the round-trips than fail the whole
          // mention on an embedder hiccup.
          this.logger.warn(
            `mention batched embed failed (${(e as Error).message}); ` +
              `falling back to per-fact embed`,
          );
          factEmbeddings = [];
        }

        for (let i = 0; i < extraction.facts.length; i++) {
          const f = extraction.facts[i];
          const eid = entityIds[f.entityIndex];
          if (!eid) continue;
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
                precomputedEmbedding: factEmbeddings[i],
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

      // identity_of merge. The merge sets toId.mergedInto = fromId.
      // If fromId already resolves (transitively) back to toId, both ends end
      // up mergedInto-set and BOTH vanish from retrieval (`WHERE mergedInto IS
      // NONE`), since survivor resolution is single-hop.
      //
      // fn::merge_identity (migration 0037) runs the multi-hop cycle guard
      // AND the mergedInto write as a single atomic statement, so the
      // read-decide-write can't be interleaved the way the old separate
      // TS-walk + standalone UPDATE could. A sorted-pair lock row inside the
      // function makes concurrent reverse merges (A→B racing B→A) collide on
      // one record write; retryOnUniqueViolation re-runs the loser, whose
      // second attempt sees the committed merge and trips the cycle guard.
      //
      // Called BEFORE the RELATE so the "reject before any write" contract
      // holds: a cycle / self-merge returns merged=false having written
      // nothing, and we throw before creating the edge.
      if (dto.kind === 'identity_of') {
        if (fromId === toId) {
          throw new BadRequestException(
            'identity_of cannot merge an entity into itself',
          );
        }
        const merge = await retryOnUniqueViolation(async () => {
          const [r] = await db.query<
            [{ merged: boolean; reason: string | null }]
          >(
            `RETURN fn::merge_identity(
                type::record('knowledge_entity', $loser),
                type::record('knowledge_entity', $survivor))`,
            { loser: idTailOf(toId), survivor: idTailOf(fromId) },
          );
          return r;
        });
        if (!merge?.merged) {
          if (merge?.reason === 'cycle') {
            throw new BadRequestException(
              'identity_of would create a merge cycle (survivor already resolves to the loser)',
            );
          }
          if (merge?.reason === 'self_merge') {
            // Defensive: the fromId===toId fast-path above already covers
            // this, so the function's own self-merge branch is normally dead.
            throw new BadRequestException(
              'identity_of cannot merge an entity into itself',
            );
          }
          // merged=false with no recognised reason (or a null/unexpected
          // result shape) is NOT a client input error — surface it as such
          // instead of mislabelling it a self-merge 400, so a driver/infra
          // failure is debuggable rather than masked.
          throw new Error(
            `identity_of merge failed unexpectedly (reason=${merge?.reason ?? 'none'})`,
          );
        }
        this.logger.log(
          `[knowledge.entity.merged] companyId=${companyId} loser=${toId} survivor=${fromId}`,
        );
      }

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

      // identity merge (mergedInto write) already happened atomically in
      // fn::merge_identity above, before the RELATE.

      return { edgeId, fromEntityId: fromId, toEntityId: toId, kind: dto.kind };
    });
  }

  // ── helpers used by mention + link ───────────────────────────────────

  /**
   * Single entry point for fn::resolve_fact (migration 0039). Both ingest
   * paths — typed ingestFact and mention-extracted recordExtractedFact — call
   * this so the 21-positional-arg invocation lives in ONE place: a future
   * signature change can't drift the two call sites out of sync (which would
   * silently bind a value to the wrong slot, e.g. entropy into script). The
   * caller supplies the per-fact values; the conflict weights/thresholds come
   * from this.conflict. Wrapped in retryOnUniqueViolation because the CREATE
   * inside the function can hit a write-set conflict under FANOUT against the
   * same entity+predicate — retry sees the racing committer's row and
   * supersedes/competes on the second attempt.
   */
  private resolveFactCall(
    db: Surreal,
    p: {
      companyId: string;
      entityId: string;
      predicate: string;
      object: string;
      objectMeta?: object;
      embedding: number[];
      confidence: number;
      validFrom: Date;
      validUntil?: Date;
      source: unknown;
      sourceTrust: number;
      semantics: string;
      lang?: string;
      script?: string;
      entropy?: number;
    },
  ): Promise<any> {
    // Serialize resolves on the same (company, entity, predicate). Under
    // SurrealDB 3.x the OCC read-conflict that let racing single_active
    // resolves retry-and-supersede no longer fires for the function's
    // SELECT-then-write, so without this two concurrent ingests could
    // each leave an `active` row. Space-joined — neither an entity record
    // tail nor a predicate slug contains a space, so the key can't collide.
    const lockKey = `${p.companyId} ${p.entityId} ${p.predicate}`;
    return this.resolveLock.run(lockKey, () =>
      retryOnUniqueViolation(async () => {
      const [r] = await db.query<[any]>(
        `RETURN fn::resolve_fact(
            type::record('knowledge_entity', $eid),
            $predicate, $object, $object_meta, $embedding,
            $confidence, $valid_from, $valid_until, $source,
            $source_trust, $semantics, $similarity_threshold,
            $w_confidence, $w_source_trust, $w_recency, $w_authority,
            $reject_threshold, $margin_for_supersede,
            $lang, $script, $entropy
         )`,
        {
          eid: idTailOf(p.entityId),
          predicate: p.predicate,
          object: p.object,
          object_meta: p.objectMeta,
          embedding: p.embedding,
          confidence: p.confidence,
          valid_from: p.validFrom,
          valid_until: p.validUntil,
          source: p.source,
          source_trust: p.sourceTrust,
          semantics: p.semantics,
          similarity_threshold: this.conflict.similarityThreshold,
          w_confidence: this.conflict.weights.confidence,
          w_source_trust: this.conflict.weights.sourceTrust,
          w_recency: this.conflict.weights.recency,
          w_authority: this.conflict.weights.authority,
          reject_threshold: this.conflict.rejectThreshold,
          margin_for_supersede: this.conflict.marginForSupersede,
          lang: p.lang,
          script: p.script,
          entropy: p.entropy,
        },
      );
      return r;
      }),
    );
  }

  private async resolveOrCreateNamedEntity(
    db: Surreal,
    e: { name: string; type: string; canonical?: string },
    hint: { vertical: string; id: string; role?: string } | undefined,
    _contextRef: { vertical: string },
    incomingFacts: string[] = [],
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

    // 3. Inline entity resolution (graphiti-style, opt-in). Before minting
    // a new entity, look for a near-duplicate that already exists and let
    // an LLM judge confirm same-as using the incoming facts. A confirmed
    // match reuses the existing entity, so the duplicate is never created.
    // Falls through to create-new when disabled, no match, or any error.
    if (this.entityResolver?.isEnabled()) {
      const resolved = await this.entityResolver.resolveByName(
        db,
        e.name,
        this.normalizeEntityType(e.type),
        incomingFacts,
      );
      if (resolved) return resolved;
    }

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
      /**
       * When supplied, skips the per-row embed() round-trip — used by
       * ingestMention which batch-embeds the entire fact list before
       * the loop starts. Empty / missing means "compute it here" (the
       * legacy path).
       */
      precomputedEmbedding?: number[];
    },
  ): Promise<{
    factId: string | null;
    outcome?: IngestOutcome;
    supersededFactIds?: string[];
    competingFactIds?: string[];
  }> {
    const { predicate, object, confidence, validFrom, source } = factPayload;
    // Prefer the caller-supplied embedding (batched path) over a fresh
    // round-trip. Falls back to the per-row embed() when the caller is
    // the legacy single-fact flow (direct ingest, scenario runner).
    const embedding =
      factPayload.precomputedEmbedding ??
      (await this.embedder.embed(`${predicate}: ${object}`));

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
    // Locale + entropy ride into fn::resolve_fact as params (migration 0039),
    // folded INSERTED-only writes instead of follow-up UPDATEs. detectLanguage
    // is pure TS; 'und' → leave unset (NONE), matching the old guard.
    const detLang = detectLanguage(object);
    const langTag = detLang.language !== 'und' ? detLang.language : undefined;
    const scriptTag = detLang.language !== 'und' ? detLang.script : undefined;
    const entropyTag =
      typeof factPayload.extractionEntropy === 'number'
        ? factPayload.extractionEntropy
        : undefined;
    const result = await this.resolveFactCall(db, {
      companyId,
      entityId,
      predicate,
      object,
      objectMeta: undefined,
      embedding,
      confidence,
      validFrom,
      validUntil: undefined,
      source,
      sourceTrust,
      semantics: policy.semantics,
      lang: langTag,
      script: scriptTag,
      entropy: entropyTag,
    });

    const factId = result?.factId ? String(result.factId) : null;
    const outcome = result?.outcome as IngestOutcome | undefined;

    // Phase 4.A locale tag + Phase 3.B entropy now ride into fn::resolve_fact
    // via the $lang/$script/$entropy params (migration 0039) — set on
    // INSERTED only, server-side, with no follow-up round-trips. HyPE stays a
    // post-call UPDATE below: it's an LLM call, gated on isEnabled() AND
    // INSERTED, so pre-computing it would burn the model on non-INSERTED
    // outcomes.
    if (factId && this.hype.isEnabled() && outcome === 'INSERTED') {
      const altEmbedding = await this.hype.generateAltEmbedding(
        predicate,
        object,
      );
      if (altEmbedding) {
        await db.query(
          `UPDATE type::record('knowledge_fact', $tail) SET altEmbedding = $emb`,
          { tail: idTailOf(factId), emb: altEmbedding },
        );
      }
    }


    // Surface supersede / compete outcomes in the trace so the demo can
    // show "Berlin fact closed at July 1, Dublin became current" —
    // otherwise the chain is invisible to the operator.
    traceArtifact('ingest.fact.outcome', {
      predicate,
      // Symmetric with the redacted ingest.mention.input trace: mask any
      // email/phone/long-digit PII in the value before it lands in a debug
      // artifact. Non-PII values (city, tier, name) pass through unchanged.
      object: redactPii(object),
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
