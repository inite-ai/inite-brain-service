import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { SurrealService, dbCreate } from '../db/surreal.service';
import { ForgetEntityDto } from './dto/forget.dto';
import { policyFor, PREDICATE_POLICIES } from '../ingest/conflict-resolver';
import { BrainScope } from '../auth/api-key.types';

// Centralised SELECT-clause field lists. Adding a new field to a table
// touches one place here, not every read site. The strings below are
// pasted into queries as-is, so they must NEVER carry user input —
// these are static identifiers only.
const ENTITY_PROFILE_FIELDS =
  'id, type, canonicalName, externalRefs, mergedAt, mergedInto';

const FACT_PROFILE_FIELDS =
  'id, predicate, object, confidence, validFrom, validUntil, ' +
  'recordedAt, retractedAt, status';

const FACT_TIMELINE_FIELDS =
  'id, predicate, object, confidence, validFrom, validUntil, ' +
  'recordedAt, retractedAt, retractedBy, retractionReason, ' +
  'supersededBy, source, status';

export interface EntityProfile {
  entityId: string;
  type: string;
  canonicalName: string;
  externalRefs: Record<string, string>;
  /**
   * Set when this entity was merged into another (identity_of cascade).
   * Callers should treat the entity as a redirect — fetch `mergedInto`
   * to get the survivor's profile. Both fields are absent on live entities.
   */
  mergedAt?: string;
  mergedInto?: string;
  facts: Array<{
    factId: string;
    predicate: string;
    object: string;
    confidence: number;
    validFrom: string;
    validUntil?: string;
    status: string;
  }>;
}

export interface ForgetResult {
  entityIdHash: string;
  factsDeleted: number;
  edgesDeleted: number;
  forgottenAt: string;
}

@Injectable()
export class EntitiesService {
  private readonly logger = new Logger(EntitiesService.name);
  private readonly forgetHmacKey: string;

  constructor(
    private readonly surreal: SurrealService,
    private readonly configService: ConfigService,
  ) {
    // Used to hash forgotten entity ids in the tombstone. If unset, derive
    // a per-process default — safe enough for 0.1.0 walking skeleton, but
    // production deployments MUST set this so tombstones survive restart.
    this.forgetHmacKey =
      this.configService.get<string>('FORGET_HMAC_KEY') ?? 'inite-brain-default';
  }

  async getProfile(
    companyId: string,
    entityIdRaw: string,
    asOfRaw: string | undefined,
    scopes: BrainScope[],
  ): Promise<EntityProfile> {
    const ref = this.normalizeEntityId(entityIdRaw);
    const asOf = asOfRaw ? new Date(asOfRaw) : null;

    return this.surreal.withScopedCompany(companyId, scopes, async (db) => {
      const [entRows] = await db.query<any[][]>(
        `SELECT ${ENTITY_PROFILE_FIELDS}
         FROM type::thing('knowledge_entity', $rid) LIMIT 1`,
        { rid: ref.id },
      );
      const entity = (entRows as any[])?.[0];
      if (!entity) {
        throw new NotFoundException(`Entity ${entityIdRaw} not found`);
      }

      // Bitemporal predicates pushed into WHERE so the composite
      // (entityId, status, recordedAt) index does the work; we no
      // longer pull retracted/future-dated rows just to drop them
      // in JS. With a long-lived entity (~thousands of facts), this
      // collapses bytes-scanned by an order of magnitude for the
      // common case `asOf = now`.
      const baseClauses = [`entityId = type::thing('knowledge_entity', $rid)`];
      const params: Record<string, unknown> = { rid: ref.id };
      if (asOf) {
        baseClauses.push(
          `recordedAt <= $asOf`,
          `(retractedAt IS NONE OR retractedAt > $asOf)`,
          `validFrom <= $asOf`,
          `(validUntil IS NONE OR validUntil > $asOf)`,
        );
        params.asOf = asOf;
      } else {
        baseClauses.push(`retractedAt IS NONE`);
      }
      const [factRows] = await db.query<any[][]>(
        `SELECT ${FACT_PROFILE_FIELDS}
         FROM knowledge_fact
         WHERE ${baseClauses.join(' AND ')}
         ORDER BY recordedAt DESC
         LIMIT 100`,
        params,
      );
      // PII scope gate — keep this in JS (per-row policy lookup).
      // Move to DB-side PERMISSIONS once we switch to JWT-per-conn.
      const facts = ((factRows as any[]) ?? []).filter((f) => {
        const policy = policyFor(f.predicate);
        if (policy.requiresScope && !scopes.includes(policy.requiresScope)) {
          return false;
        }
        return true;
      });

      return {
        entityId: String(entity.id),
        type: entity.type,
        canonicalName: entity.canonicalName,
        externalRefs: entity.externalRefs ?? {},
        mergedAt: entity.mergedAt
          ? new Date(entity.mergedAt).toISOString()
          : undefined,
        mergedInto: entity.mergedInto ? String(entity.mergedInto) : undefined,
        facts: facts.map((f) => ({
          factId: String(f.id),
          predicate: f.predicate,
          object: f.object,
          confidence: f.confidence,
          validFrom: new Date(f.validFrom).toISOString(),
          validUntil: f.validUntil ? new Date(f.validUntil).toISOString() : undefined,
          status: f.status,
        })),
      };
    });
  }

  async getTimeline(
    companyId: string,
    entityIdRaw: string,
    sinceRaw: string | undefined,
    untilRaw: string | undefined,
    scopes: BrainScope[],
  ): Promise<{ entityId: string; events: any[] }> {
    const ref = this.normalizeEntityId(entityIdRaw);
    const since = sinceRaw ? new Date(sinceRaw) : null;
    const until = untilRaw ? new Date(untilRaw) : null;

    return this.surreal.withScopedCompany(companyId, scopes, async (db) => {
      // Range pushdown — recordedAt window is part of the WHERE so
      // long-lived entities don't pay for full timeline materialisation
      // on every query. The composite (entityId, status, recordedAt)
      // index covers the entityId+range combination directly.
      const clauses = [`entityId = type::thing('knowledge_entity', $rid)`];
      const params: Record<string, unknown> = { rid: ref.id };
      if (since) { clauses.push(`recordedAt >= $since`); params.since = since; }
      if (until) { clauses.push(`recordedAt <= $until`); params.until = until; }
      const [factRows] = await db.query<any[][]>(
        `SELECT ${FACT_TIMELINE_FIELDS}
         FROM knowledge_fact
         WHERE ${clauses.join(' AND ')}
         ORDER BY recordedAt ASC`,
        params,
      );
      const rows = ((factRows as any[]) ?? []).filter((f) => {
        const policy = policyFor(f.predicate);
        if (policy.requiresScope && !scopes.includes(policy.requiresScope)) {
          return false;
        }
        return true;
      });

      const events: any[] = [];
      for (const f of rows) {
        events.push({
          type: 'fact.recorded',
          at: new Date(f.recordedAt).toISOString(),
          factId: String(f.id),
          predicate: f.predicate,
          object: f.object,
          source: f.source,
          confidence: f.confidence,
        });
        if (f.retractedAt) {
          events.push({
            type: 'fact.retracted',
            at: new Date(f.retractedAt).toISOString(),
            factId: String(f.id),
            retractedBy: f.retractedBy,
            reason: f.retractionReason,
            supersededBy: f.supersededBy ? String(f.supersededBy) : undefined,
          });
        }
      }
      events.sort((a, b) => a.at.localeCompare(b.at));

      return { entityId: ref.full, events };
    });
  }

  async getConnections(
    companyId: string,
    entityIdRaw: string,
    kind: string | undefined,
    scopes: BrainScope[] = [],
    asOf?: string,
  ): Promise<{ entityId: string; edges: any[] }> {
    const ref = this.normalizeEntityId(entityIdRaw);

    return this.surreal.withScopedCompany(companyId, scopes, async (db) => {
      // Native graph traversal via SurrealDB's `->` / `<-` operators
      // applied to an inline `type::thing(...)` expression. The graph
      // operators walk the adjacency list directly — O(degree) — and
      // the inline `out.{...}` / `in.{...}` projections hydrate the
      // far entity in the same query. Two parallel reads (outbound +
      // inbound) hit the dedicated `edge_in_idx` / `edge_out_idx`.
      //
      // Earlier attempt used `LET $entity = ...; SELECT FROM $entity->...`
      // in a multi-statement query and returned 0 rows on the JS SDK
      // 2.0.x — the multi-statement chain confused the result mapper.
      // The inline form (no LET) executes cleanly.
      const kindParam = kind ? ' AND kind = $kind' : '';
      // Bitemporal cutoff on the transaction-time axis. Without asOf,
      // active = invalidatedAt IS NONE (i.e. believed now). With asOf,
      // active = createdAt <= asOf AND (invalidatedAt IS NONE OR
      // invalidatedAt > asOf) — "what brain knew on that moment".
      const asOfParam = asOf
        ? ' AND createdAt <= type::datetime($asOf) AND (invalidatedAt IS NONE OR invalidatedAt > type::datetime($asOf))'
        : ' AND invalidatedAt IS NONE';
      const outSql = `
        SELECT id, kind, weight, source, createdAt, invalidatedAt, in, out,
               out.{id, type, canonicalName} AS toEntity
        FROM type::thing('knowledge_entity', $rid)->knowledge_edge
        WHERE 1=1${asOfParam}${kindParam}
      `;
      const inSql = `
        SELECT id, kind, weight, source, createdAt, invalidatedAt, in, out,
               in.{id, type, canonicalName} AS fromEntity
        FROM type::thing('knowledge_entity', $rid)<-knowledge_edge
        WHERE 1=1${asOfParam}${kindParam}
      `;
      const [outRowsResult, inRowsResult] = await Promise.all([
        db.query<any[][]>(outSql, { rid: ref.id, kind, asOf }),
        db.query<any[][]>(inSql, { rid: ref.id, kind, asOf }),
      ]);
      const outRows = ((outRowsResult[0] as any[]) ?? []) as any[];
      const inRows = ((inRowsResult[0] as any[]) ?? []) as any[];
      const edges = [
        ...outRows.map((e: any) => ({
          edgeId: String(e.id),
          from: String(e.in),
          to: String(e.out),
          kind: e.kind,
          weight: e.weight,
          source: e.source,
          createdAt: new Date(e.createdAt).toISOString(),
          neighbour: e.toEntity
            ? {
                id: String(e.toEntity.id),
                type: e.toEntity.type,
                canonicalName: e.toEntity.canonicalName,
              }
            : undefined,
          direction: 'outbound' as const,
        })),
        ...inRows.map((e: any) => ({
          edgeId: String(e.id),
          from: String(e.in),
          to: String(e.out),
          kind: e.kind,
          weight: e.weight,
          source: e.source,
          createdAt: new Date(e.createdAt).toISOString(),
          neighbour: e.fromEntity
            ? {
                id: String(e.fromEntity.id),
                type: e.fromEntity.type,
                canonicalName: e.fromEntity.canonicalName,
              }
            : undefined,
          direction: 'inbound' as const,
        })),
      ];
      return { entityId: ref.full, edges };
    });
  }

  async forget(
    companyId: string,
    entityIdRaw: string,
    dto: ForgetEntityDto,
  ): Promise<ForgetResult> {
    const ref = this.normalizeEntityId(entityIdRaw);

    return this.surreal.withCompany(companyId, async (db) => {
      // Verify exists
      const [entRows] = await db.query<any[][]>(
        `SELECT id FROM type::thing('knowledge_entity', $rid) LIMIT 1`,
        { rid: ref.id },
      );
      const entity = (entRows as any[])?.[0];
      if (!entity) {
        throw new NotFoundException(`Entity ${entityIdRaw} not found`);
      }

      // Count facts + edges before deletion (for the audit tombstone).
      const [[factCount]] = await db.query<any[]>(
        `SELECT count() AS c FROM knowledge_fact
         WHERE entityId = type::thing('knowledge_entity', $rid) GROUP ALL`,
        { rid: ref.id },
      );
      const [[edgeCount]] = await db.query<any[]>(
        `SELECT count() AS c FROM knowledge_edge
         WHERE in = type::thing('knowledge_entity', $rid) OR out = type::thing('knowledge_entity', $rid)
         GROUP ALL`,
        { rid: ref.id },
      );
      const factsDeleted = (factCount as any)?.c ?? 0;
      const edgesDeleted = (edgeCount as any)?.c ?? 0;

      // Cascade hard-delete. Embedding columns die with the rows.
      await db.query(
        `DELETE knowledge_fact
         WHERE entityId = type::thing('knowledge_entity', $rid)`,
        { rid: ref.id },
      );
      await db.query(
        `DELETE knowledge_edge
         WHERE in = type::thing('knowledge_entity', $rid) OR out = type::thing('knowledge_entity', $rid)`,
        { rid: ref.id },
      );
      await db.query(
        `DELETE type::thing('knowledge_entity', $rid)`,
        { rid: ref.id },
      );

      const entityIdHash =
        'hmac:' +
        createHmac('sha256', this.forgetHmacKey)
          .update(`${companyId}/${ref.full}`)
          .digest('hex');

      const forgottenAt = new Date();
      await dbCreate(db, 'forgotten_entity', {
        entityIdHash,
        reason: dto.reason,
        requestId: dto.requestId,
        factsDeleted,
        edgesDeleted,
        forgottenAt,
      });

      this.logger.warn(
        `[knowledge.entity.forgotten] companyId=${companyId} hash=${entityIdHash} ` +
        `factsDeleted=${factsDeleted} edgesDeleted=${edgesDeleted} reason=${dto.reason}`,
      );

      return {
        entityIdHash,
        factsDeleted,
        edgesDeleted,
        forgottenAt: forgottenAt.toISOString(),
      };
    });
  }

  private normalizeEntityId(raw: string): { id: string; full: string } {
    const id = raw.startsWith('knowledge_entity:')
      ? raw.slice('knowledge_entity:'.length)
      : raw;
    return { id, full: `knowledge_entity:${id}` };
  }
}

// Keep import-side alive: re-export to avoid tree-shake stripping the policies
// when search/forget paths are the only call sites.
export { PREDICATE_POLICIES };
