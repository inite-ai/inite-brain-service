import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Surreal, StringRecordId } from 'surrealdb';
import { SurrealService, dbCreate, dbMerge } from '../db/surreal.service';
import { EmbedderService } from '../ai/embedder.service';
import { ExtractorService } from '../ai/extractor.service';
import { IngestFactDto } from './dto/ingest-fact.dto';
import { IngestMentionDto } from './dto/ingest-mention.dto';
import { IngestLinkDto } from './dto/ingest-link.dto';
import {
  ConflictConfig,
  policyFor,
  scoreFact,
  SOURCE_TRUST,
} from './conflict-resolver';

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
}

@Injectable()
export class IngestService {
  private readonly logger = new Logger(IngestService.name);
  private readonly conflict: ConflictConfig;

  constructor(
    private readonly surreal: SurrealService,
    private readonly embedder: EmbedderService,
    private readonly extractor: ExtractorService,
    private readonly configService: ConfigService,
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
      // 1. Resolve entity (create if needed)
      const entityId = await this.resolveOrCreateEntity(db, dto);

      // 2. Compute embedding from object representation
      const embeddingText = `${dto.predicate}: ${dto.object}`;
      const embedding = await this.embedder.embed(embeddingText);

      // 3. Predicate policy
      const policy = policyFor(dto.predicate);

      // 4. Score the new fact
      const newScore = scoreFact(
        {
          confidence: dto.confidence ?? 0.7,
          sourceTrust: this.sourceTrustFor(dto.source),
          recordedAt: new Date(),
          authority: 0,
        },
        this.conflict,
      );

      // Reject below threshold (only matters for bitemporal — append-only never rejects)
      if (policy.semantics === 'bitemporal' && newScore < this.conflict.rejectThreshold) {
        await dbCreate(db, 'ingest_dead_letter', {
          payload: dto as any,
          reason: `score ${newScore.toFixed(3)} below reject threshold ${this.conflict.rejectThreshold}`,
        });
        return { factId: null, outcome: 'REJECTED', reason: 'low_score' };
      }

      // 5. Find contradicting active facts (same entity + same predicate)
      const eIdTail = idTailOf(entityId);
      const contradictsQuery = `
        SELECT id, predicate, object, confidence, recordedAt, source, embedding
        FROM knowledge_fact
        WHERE entityId = type::thing('knowledge_entity', $eid)
          AND predicate = $predicate
          AND status = 'active'
          AND retractedAt IS NONE
      `;
      const [existing] = await db.query<[any[]]>(contradictsQuery, {
        eid: eIdTail,
        predicate: dto.predicate,
      });
      const candidates: any[] = (existing as any[]) ?? [];

      // For append_only — never compete, just insert.
      // For single_active — every existing wins-or-loses without similarity check.
      // For bitemporal — only compete when semantically similar.
      let competing: any[];
      if (policy.semantics === 'append_only') {
        competing = [];
      } else if (policy.semantics === 'single_active') {
        competing = candidates;
      } else {
        // bitemporal — compare via embedding cosine
        competing = candidates.filter(c => {
          if (!c.embedding) return false;
          return cosine(c.embedding, embedding) >= this.conflict.similarityThreshold;
        });
      }

      // 6. Insert the new fact. entityId is wrapped in StringRecordId so
      // SurrealDB binds it as a record link (record<knowledge_entity>),
      // not as a plain string — the schema constraint requires this.
      const factPayload = {
        entityId: new StringRecordId(entityId),
        predicate: dto.predicate,
        object: typeof dto.object === 'string' ? dto.object : JSON.stringify(dto.object),
        confidence: dto.confidence ?? 0.7,
        validFrom: new Date(dto.validFrom),
        validUntil: dto.validUntil ? new Date(dto.validUntil) : undefined,
        source: dto.source,
        embedding,
        status: 'active',
      };
      const created = await dbCreate<any>(db, 'knowledge_fact', factPayload);
      const newFactId = String(created?.id);

      if (competing.length === 0) {
        return { factId: newFactId, outcome: 'INSERTED' };
      }

      // 7. Score the competition
      const competingScored = competing.map(c => ({
        id: String(c.id),
        score: scoreFact(
          {
            confidence: c.confidence,
            sourceTrust: this.sourceTrustFor(c.source),
            recordedAt: new Date(c.recordedAt),
            authority: 0,
          },
          this.conflict,
        ),
      }));
      const bestOpponent = competingScored.reduce((a, b) => (a.score > b.score ? a : b));

      // 8. Decide outcome
      if (
        policy.semantics === 'single_active' ||
        newScore >= bestOpponent.score + this.conflict.marginForSupersede
      ) {
        // SUPERSEDED — retract all competing
        for (const c of competingScored) {
          await dbMerge(db, c.id, {
            status: 'superseded',
            retractedAt: new Date(),
            retractionReason: 'superseded',
            retractedBy: 'system',
            supersededBy: new StringRecordId(newFactId),
            validUntil: factPayload.validFrom,
          });
        }
        return {
          factId: newFactId,
          outcome: 'SUPERSEDED',
          supersededFactIds: competingScored.map(c => c.id),
        };
      }

      // COMPETING — both stay active, mark status
      await dbMerge(db, newFactId, { status: 'competing' });
      for (const c of competingScored) {
        await dbMerge(db, c.id, { status: 'competing' });
      }
      return {
        factId: String(newFactId),
        outcome: 'COMPETING',
        competingFactIds: competingScored.map(c => c.id),
      };
    });
  }

  private async resolveOrCreateEntity(db: Surreal, dto: IngestFactDto): Promise<string> {
    if ('entityId' in dto.entityRef && dto.entityRef.entityId) {
      return dto.entityRef.entityId;
    }
    const ref = dto.entityRef as { vertical: string; id: string };
    const refKey = externalRefKey(ref.vertical, ref.id);
    const found = await lookupByExternalRef(db, refKey, ref.id);
    if (found) return found;
    // Create stub entity — canonicalName defaulted to ref id; LLM extractor
    // will refine in a future PR.
    const created = await dbCreate<any>(db, 'knowledge_entity', {
      type: 'other',
      canonicalName: ref.id,
      externalRefs: { [refKey]: ref.id },
    });
    return String(created?.id);
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
    const text = redactPii(dto.text);

    if (!text.trim()) {
      return { skipped: true, reason: 'empty', extractedEntityIds: [], extractedFactIds: [] };
    }

    const extraction = await this.extractor.extract(text);
    if (extraction.entities.length === 0) {
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

      // 1. Resolve / create entities
      for (let i = 0; i < extraction.entities.length; i++) {
        const e = extraction.entities[i];
        const knownHint = dto.knownEntities?.[i];
        const eid = await this.resolveOrCreateNamedEntity(db, e, knownHint, dto.contextRef);
        entityIds.push(eid);
      }

      // 2. Add mention edges (entity --mentioned_in--> contextRef topic-entity).
      //    For 0.1.0 we skip edge creation; we still record source on the facts.

      // 3. Record extracted facts via the same conflict-resolution pipeline
      //    used by ingest-fact. Reuse ingestFact under the hood.
      for (const f of extraction.facts) {
        const eid = entityIds[f.entityIndex];
        if (!eid) continue;
        const sourceFromContext = {
          vertical: dto.contextRef.vertical,
          eventId: dto.contextRef.eventId,
          conversationId: dto.contextRef.conversationId,
          messageId: dto.contextRef.messageId,
        };
        // Inline ingest — we're already inside withCompany.
        const result = await this.recordExtractedFact(
          db,
          eid,
          f.predicate,
          f.object,
          f.confidence,
          new Date(dto.emittedAt),
          sourceFromContext,
        );
        if (result.factId) factIds.push(result.factId);
      }

      return {
        skipped: false,
        extractedEntityIds: entityIds,
        extractedFactIds: factIds,
      };
    });
  }

  // ── ingestLink: declare an edge between two entities ─────────────────
  async ingestLink(companyId: string, dto: IngestLinkDto) {
    return this.surreal.withCompany(companyId, async (db) => {
      const fromId = await this.resolveOrCreateBareRef(db, dto.from as any);
      const toId = await this.resolveOrCreateBareRef(db, dto.to as any);

      // RELATE in SurrealDB graph table
      const [edgeRows] = await db.query<any[][]>(
        `RELATE type::thing('knowledge_entity', $f)->knowledge_edge->type::thing('knowledge_entity', $t)
         CONTENT { kind: $kind, weight: $weight, source: $source }
         RETURN AFTER`,
        {
          f: this.idTail(fromId),
          t: this.idTail(toId),
          kind: dto.kind,
          weight: dto.weight ?? 1.0,
          source: dto.source,
        },
      );
      const edge = ((edgeRows as any[]) ?? [])[0];
      const edgeId = edge ? String(edge.id) : null;

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
    contextRef: { vertical: string },
  ): Promise<string> {
    // 1. If caller provided an explicit hint, prefer that as the externalRef.
    if (hint) {
      const hintKey = externalRefKey(hint.vertical, hint.id);
      const found = await lookupByExternalRef(db, hintKey, hint.id);
      if (found) return found;
      const created = await dbCreate<any>(db, 'knowledge_entity', {
        type: this.normalizeEntityType(e.type),
        canonicalName: e.canonical ?? e.name,
        aliases: [e.name],
        externalRefs: { [hintKey]: hint.id },
      });
      return String(created?.id);
    }

    // 2. Try canonical-name match.
    const target = (e.canonical ?? e.name).toLowerCase();
    const [nRows] = await db.query<any[][]>(
      `SELECT id, canonicalName, aliases FROM knowledge_entity
       WHERE string::lowercase(canonicalName) = $name
          OR aliases CONTAINS $rawName
       LIMIT 1`,
      { name: target, rawName: e.name },
    );
    const nRow = ((nRows as any[]) ?? [])[0];
    if (nRow) return String(nRow.id);

    // 3. Create new.
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
      // Accept either short id or full record path.
      return ref.entityId.includes(':') ? ref.entityId : `knowledge_entity:${ref.entityId}`;
    }
    const r = ref as { vertical: string; id: string };
    const refKey = externalRefKey(r.vertical, r.id);
    const found = await lookupByExternalRef(db, refKey, r.id);
    if (found) return found;
    const created = await dbCreate<any>(db, 'knowledge_entity', {
      type: 'other',
      canonicalName: r.id,
      externalRefs: { [refKey]: r.id },
    });
    return String(created?.id);
  }

  /**
   * Insert a fact already extracted from a mention. Skips the full conflict
   * pipeline (which is paid by ingest-fact). Mention extraction is best-effort
   * and noisy, so we let the conflict-resolution pass at search time handle
   * dedup via embeddings + decay rather than blocking ingest.
   */
  private async recordExtractedFact(
    db: Surreal,
    entityId: string,
    predicate: string,
    object: string,
    confidence: number,
    validFrom: Date,
    source: any,
  ) {
    const embedding = await this.embedder.embed(`${predicate}: ${object}`);
    const created = await dbCreate<any>(db, 'knowledge_fact', {
      entityId: new StringRecordId(entityId),
      predicate,
      object,
      confidence,
      validFrom,
      source,
      embedding,
      status: 'active',
    });
    const id = created?.id;
    return { factId: id ? String(id) : null };
  }

  private normalizeEntityType(t: string): string {
    const allowed = ['customer', 'staff', 'asset', 'project', 'topic', 'location', 'other'];
    return allowed.includes(t) ? t : 'other';
  }

  private idTail(full: string): string {
    return full.startsWith('knowledge_entity:') ? full.slice('knowledge_entity:'.length) : full;
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
 * Lookup an entity by an externalRefs key. Object-property access with a
 * parameterized key is awkward in SurrealDB; we read all candidates with
 * the right value present and filter by exact key in JS. Walking-skeleton
 * scale is fine; for large tenants we'll add a normalized lookup table.
 */
async function lookupByExternalRef(
  db: Surreal,
  key: string,
  val: string,
): Promise<string | null> {
  const [rows] = await db.query<[any[]]>(
    `SELECT id, externalRefs FROM knowledge_entity LIMIT 5000`,
  );
  const arr = (rows as any[]) ?? [];
  const hit = arr.find((e) => e?.externalRefs && e.externalRefs[key] === val);
  return hit ? String(hit.id) : null;
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

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}
