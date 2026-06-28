import { Injectable, NotFoundException, Optional } from '@nestjs/common';
import { SurrealService } from '../db/surreal.service';
import { MetricsService } from '../metrics/metrics.service';
import { ForgetEntityDto } from './dto/forget.dto';
import { BrainScope } from '../auth/api-key.types';
import { EntityForgetService } from './entity-forget.service';
import {
  normalizeEntityId,
  factVisibleToScopes,
  blockedPredicates,
  activeFactWhere,
} from './entity-read.helpers';

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
  /**
   * Materialised audit_event rows (changefeed mirror) carrying the
   * forgotten entity's post-images — purged as part of the erasure.
   */
  auditEventsDeleted: number;
  forgottenAt: string;
}

export interface GetProfileOptions {
  companyId: string;
  entityIdRaw: string;
  asOfRaw: string | undefined;
  scopes: BrainScope[];
}

export interface FreshnessWatermarkOptions {
  companyId: string;
  entityIdRaw: string;
  asOfRaw: string | undefined;
  scopes: BrainScope[];
}

export interface GetTimelineOptions {
  companyId: string;
  entityIdRaw: string;
  sinceRaw: string | undefined;
  untilRaw: string | undefined;
  scopes: BrainScope[];
}

export interface GetConnectionsOptions {
  companyId: string;
  entityIdRaw: string;
  kind: string | undefined;
  scopes?: BrainScope[];
  asOf?: string;
}

export interface ForgetOptions {
  companyId: string;
  entityIdRaw: string;
  dto: ForgetEntityDto;
  actorKeyHash?: string;
}

@Injectable()
export class EntitiesService {
  constructor(
    private readonly surreal: SurrealService,
    private readonly forgetService: EntityForgetService,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  async getProfile({
    companyId,
    entityIdRaw,
    asOfRaw,
    scopes,
  }: GetProfileOptions): Promise<EntityProfile> {
    const ref = normalizeEntityId(entityIdRaw);
    const asOf = asOfRaw ? new Date(asOfRaw) : null;

    return this.surreal.withScopedCompany(companyId, scopes, async (db) => {
      const [entRows] = await db.query<any[][]>(
        `SELECT ${ENTITY_PROFILE_FIELDS}
         FROM type::record('knowledge_entity', $rid) LIMIT 1`,
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
      const { clauses: asOfClauses, params: asOfParams } = activeFactWhere(asOf);
      const baseClauses = [
        `entityId = type::record('knowledge_entity', $rid)`,
        ...asOfClauses,
      ];
      const params: Record<string, unknown> = { rid: ref.id, ...asOfParams };
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
      const facts = ((factRows as any[]) ?? []).filter((f) =>
        factVisibleToScopes(f.predicate, scopes),
      );

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

  /**
   * Resolve an entity by its external reference (vertical + id) and return
   * its full profile, or null when no entity carries that ref. Used by the
   * code-memory `why` tool, which addresses a code anchor by its SCIP-style
   * symbol string rather than the internal knowledge_entity id.
   */
  async getProfileByExternalRef({
    companyId,
    vertical,
    id,
    asOfRaw,
    scopes,
  }: {
    companyId: string;
    vertical: string;
    id: string;
    asOfRaw: string | undefined;
    scopes: BrainScope[];
  }): Promise<EntityProfile | null> {
    // externalRef key format mirrors externalRefKey() in
    // src/ingest/ingest-utils.ts (the write side) — dots become "__". Kept
    // inline to avoid an entities→ingest module dependency; the format is a
    // stable storage contract.
    const safe = (s: string) => s.replace(/\./g, '__');
    const key = `${safe(vertical)}__${safe(id)}`;
    const entityId = await this.surreal.withScopedCompany(
      companyId,
      scopes,
      async (db) => {
        const [rows] = await db.query<[any[]]>(
          `SELECT VALUE entity FROM entity_external_ref WHERE key = $key LIMIT 1`,
          { key },
        );
        const arr = (rows as any[]) ?? [];
        return arr[0] ? String(arr[0]) : null;
      },
    );
    if (!entityId) return null;
    return this.getProfile({ companyId, entityIdRaw: entityId, asOfRaw, scopes });
  }

  /**
   * Cheap freshness probe for an entity's active fact set, used by the
   * summarize_entity watermark cache (graphiti-style dual watermark):
   *   - maxRecordedAt — wall-clock: the newest moment brain learned
   *     anything about this entity. A cached summary is stale the instant
   *     a fact with a newer recordedAt lands (even a BACKFILLED one whose
   *     validFrom is in the past — the bug an asOf-keyed cache misses).
   *   - maxValidFrom  — event-time: the newest real-world moment the
   *     summary reflects ("as of"), surfaced to the caller.
   *
   * One indexed aggregate over (entityId, status, recordedAt) — far
   * cheaper than rebuilding the full profile, so it's safe to run on
   * every cache hit. Returns nulls when the entity has no qualifying
   * facts.
   */
  async freshnessWatermark({
    companyId,
    entityIdRaw,
    asOfRaw,
    scopes,
  }: FreshnessWatermarkOptions): Promise<{ maxRecordedAt: string | null; maxValidFrom: string | null }> {
    const ref = normalizeEntityId(entityIdRaw);
    const asOf = asOfRaw ? new Date(asOfRaw) : null;
    return this.surreal.withScopedCompany(companyId, scopes, async (db) => {
      const { clauses: asOfClauses, params: asOfParams } = activeFactWhere(asOf);
      const baseClauses = [
        `entityId = type::record('knowledge_entity', $rid)`,
        ...asOfClauses,
      ];
      const params: Record<string, unknown> = { rid: ref.id, ...asOfParams };
      // Mirror getProfile's PII gate: a fact the caller can't see must
      // not move the watermark, else a low-scope caller's cache gets
      // invalidated exactly when a restricted fact lands (a timing oracle
      // + needless rebuilds). DB-side here since we don't fetch the rows.
      const blocked = blockedPredicates(scopes);
      if (blocked.length) {
        baseClauses.push(`predicate NOT IN $blocked`);
        params.blocked = blocked;
      }
      // Two cheap ORDER BY … LIMIT 1 probes (recordedAt is indexed),
      // sent as ONE round-trip (two statements) so a cache-hit freshness
      // check stays a single network hop. Avoids math::max aggregation,
      // which returns NONE over datetimes on this SurrealDB build.
      const where = baseClauses.join(' AND ');
      const [recRows, valRows] = await db.query<[any[], any[]]>(
        `SELECT recordedAt FROM knowledge_fact WHERE ${where}
           ORDER BY recordedAt DESC LIMIT 1;
         SELECT validFrom FROM knowledge_fact WHERE ${where}
           ORDER BY validFrom DESC LIMIT 1`,
        params,
      );
      const toIso = (v: unknown): string | null =>
        v == null
          ? null
          : v instanceof Date
            ? v.toISOString()
            : new Date(String(v)).toISOString();
      return {
        maxRecordedAt: toIso((recRows as any[])?.[0]?.recordedAt),
        maxValidFrom: toIso((valRows as any[])?.[0]?.validFrom),
      };
    });
  }

  async getTimeline({
    companyId,
    entityIdRaw,
    sinceRaw,
    untilRaw,
    scopes,
  }: GetTimelineOptions): Promise<{ entityId: string; events: any[] }> {
    const ref = normalizeEntityId(entityIdRaw);
    const since = sinceRaw ? new Date(sinceRaw) : null;
    const until = untilRaw ? new Date(untilRaw) : null;

    return this.surreal.withScopedCompany(companyId, scopes, async (db) => {
      // Range pushdown — recordedAt window is part of the WHERE so
      // long-lived entities don't pay for full timeline materialisation
      // on every query. The composite (entityId, status, recordedAt)
      // index covers the entityId+range combination directly.
      const clauses = [`entityId = type::record('knowledge_entity', $rid)`];
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
      const rows = ((factRows as any[]) ?? []).filter((f) =>
        factVisibleToScopes(f.predicate, scopes),
      );

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

  async getConnections({
    companyId,
    entityIdRaw,
    kind,
    scopes = [],
    asOf,
  }: GetConnectionsOptions): Promise<{ entityId: string; edges: any[] }> {
    const ref = normalizeEntityId(entityIdRaw);

    return this.surreal.withScopedCompany(companyId, scopes, async (db) => {
      // Native graph traversal via SurrealDB's `->` / `<-` operators
      // applied to an inline `type::record(...)` expression. The graph
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
        FROM type::record('knowledge_entity', $rid)->knowledge_edge
        WHERE 1=1${asOfParam}${kindParam}
      `;
      const inSql = `
        SELECT id, kind, weight, source, createdAt, invalidatedAt, in, out,
               in.{id, type, canonicalName} AS fromEntity
        FROM type::record('knowledge_entity', $rid)<-knowledge_edge
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
      ].filter((edge) =>
        // Defense-in-depth: the DB-level PERMISSIONS fence (migration 0005)
        // gates knowledge_fact.object, but knowledge_edge has no such fence,
        // so a scoped caller could otherwise read a PII-classed relation
        // (edge.kind maps to a predicate). Mirror the timeline scope gate:
        // drop edges whose kind requires a scope the caller lacks.
        factVisibleToScopes(edge.kind, scopes),
      );
      return { entityId: ref.full, edges };
    });
  }

  async forget(opts: ForgetOptions): Promise<ForgetResult> {
    const result = await this.forgetService.forget(opts);
    this.metrics?.countForget();
    return result;
  }
}
