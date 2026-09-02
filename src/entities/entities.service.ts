import { Injectable, NotFoundException, Optional } from '@nestjs/common';
import { SurrealService, queryRows, queryFirst } from '../db/surreal.service';
import { MetricsService } from '../metrics/metrics.service';
import { PredicateRegistryService } from '../ai/predicate-registry.service';
import { ForgetEntityDto } from './dto/forget.dto';
import { BrainScope } from '../auth/api-key.types';
import { EntityForgetService } from './entity-forget.service';
import { normalizeEntityId, blockedPredicates, activeFactWhere } from './entity-read.helpers';
import { makeRowPolicyFilter, PolicyFilterableRow } from '../policy/row-filter';
import { readSurfaceUserScopeEnabled } from '../common/read-scope-flags';
import { pinUserScope } from '../auth/user-scope';

// Centralised SELECT-clause field lists. Adding a new field to a table
// touches one place here, not every read site. The strings below are
// pasted into queries as-is, so they must NEVER carry user input —
// these are static identifiers only.
const ENTITY_PROFILE_FIELDS = 'id, type, canonicalName, externalRefs, mergedAt, mergedInto';

// source/trustSnapshot/corroboration ride along for the ABAC row filter
// (policy/row-filter.ts); the response mappers never surface them unless
// the field was already part of the wire shape (timeline's `source`).
const FACT_PROFILE_FIELDS =
  'id, predicate, object, confidence, validFrom, validUntil, ' +
  'recordedAt, retractedAt, status, source, trustSnapshot, corroboration';

const FACT_TIMELINE_FIELDS =
  'id, predicate, object, confidence, validFrom, validUntil, ' +
  'recordedAt, retractedAt, retractedBy, retractionReason, ' +
  'supersededBy, source, status, trustSnapshot, corroboration';

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
  mergedAt?: string | undefined;
  mergedInto?: string | undefined;
  facts: Array<{
    factId: string;
    predicate: string;
    object: string;
    confidence: number;
    validFrom: string;
    validUntil?: string | undefined;
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
  /**
   * L0 grounding turns erased with the entity (audit W1): without this the
   * verbatim episodes stayed readable through the episodic/segment lanes
   * and a re-derive resurrected the deleted facts.
   */
  episodesDeleted: number;
  /** Rebuildable segment projection rows quoting those turns. */
  segmentsDeleted: number;
  /**
   * Semantic beliefs (0120) grounded in scenes dying with those turns —
   * erased scene-mediated (a belief's sourceSceneIds are the linkage).
   */
  beliefsDeleted: number;
  forgottenAt: string;
}

export interface GetProfileOptions {
  companyId: string;
  entityIdRaw: string;
  asOfRaw: string | undefined;
  /** Transaction-time cutoff — replay what the graph believed at T. */
  recordedAtRaw?: string | undefined;
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
  /**
   * Transaction-time cutoff — only events the graph knew by T: recorded
   * events with recordedAt <= T, retraction events with retractedAt <= T.
   * Distinct from `until`, which is an audit paging window over rows.
   */
  recordedAtRaw?: string | undefined;
  /**
   * Per-user memory scope (0055), READ_SURFACE_USER_SCOPE gated.
   * Caller-asserted; pinned to a user-bound token's end-user via
   * pinUserScope. Flag on + userId → events over tenant-global facts
   * PLUS this user's personal ones; otherwise the historical
   * tenant-global-only fence, byte-identical.
   */
  userId?: string | undefined;
  scopes: BrainScope[];
}

export interface GetConnectionsOptions {
  companyId: string;
  entityIdRaw: string;
  kind: string | undefined;
  scopes?: BrainScope[];
  asOf?: string | undefined;
}

export interface ForgetOptions {
  companyId: string;
  entityIdRaw: string;
  dto: ForgetEntityDto;
  actorKeyHash?: string;
}

export interface AutocompleteOptions {
  companyId: string;
  q: string;
  limit?: number | undefined;
  scopes: BrainScope[];
}

export interface AutocompleteSuggestion {
  entityId: string;
  canonicalName: string;
  type: string;
  score: number;
}

/** edgengram(2,15) — a query shorter than 2 chars yields no tokens. */
const AUTOCOMPLETE_MIN_CHARS = 2;
const AUTOCOMPLETE_DEFAULT_LIMIT = 10;
const AUTOCOMPLETE_MAX_LIMIT = 25;

// --- Local DB row shapes: only the columns each SELECT actually returns.
// Date-typed columns are `string | Date` (the JS SDK hands back a Date for
// native datetime, a string for ISO literals) so they funnel through
// `new Date(...)`; opaque passthrough columns are `unknown`. Fact rows
// extend PolicyFilterableRow so they drop straight into rowPolicy.filter().

interface EntityProfileRow {
  id: unknown;
  type: string;
  canonicalName: string;
  externalRefs?: Record<string, string>;
  mergedAt?: string | Date;
  mergedInto?: unknown;
}

interface FactProfileRow extends PolicyFilterableRow {
  id: unknown;
  object: string;
  confidence: number;
  validFrom: string | Date;
  validUntil?: string | Date;
  status: string;
}

interface FactTimelineRow extends PolicyFilterableRow {
  id: unknown;
  object: string;
  confidence: number;
  recordedAt: string | Date;
  retractedAt?: string | Date | null;
  retractedBy?: unknown;
  retractionReason?: unknown;
  supersededBy?: unknown;
}

interface EdgeEntityProjection {
  id: unknown;
  type: string;
  canonicalName: string;
}

interface EdgeRow {
  id: unknown;
  in: unknown;
  out: unknown;
  kind: string;
  weight: number;
  source: unknown;
  createdAt: string | Date;
  invalidatedAt?: unknown;
  toEntity?: EdgeEntityProjection | null;
  fromEntity?: EdgeEntityProjection | null;
}

export interface TimelineRecordedEvent {
  type: 'fact.recorded';
  at: string;
  factId: string;
  predicate: string;
  object: string;
  source: unknown;
  confidence: number;
}

export interface TimelineRetractedEvent {
  type: 'fact.retracted';
  at: string;
  factId: string;
  retractedBy: unknown;
  reason: unknown;
  supersededBy?: string | undefined;
}

export type TimelineEvent = TimelineRecordedEvent | TimelineRetractedEvent;

export interface ConnectionNeighbour {
  id: string;
  type: string;
  canonicalName: string;
}

export interface ConnectionEdge {
  edgeId: string;
  from: string;
  to: string;
  kind: string;
  weight: number;
  source: unknown;
  createdAt: string;
  neighbour?: ConnectionNeighbour | undefined;
  direction: 'outbound' | 'inbound';
}

@Injectable()
export class EntitiesService {
  // Fourth dep is the tenant predicate registry — the row fence must see
  // operator-authored requiresScope predicates, not only the code seed.
  // eslint-disable-next-line max-params
  constructor(
    private readonly surreal: SurrealService,
    private readonly forgetService: EntityForgetService,
    @Optional() private readonly metrics?: MetricsService,
    @Optional()
    private readonly predicateRegistry?: PredicateRegistryService,
  ) {}

  async getProfile({
    companyId,
    entityIdRaw,
    asOfRaw,
    recordedAtRaw,
    scopes,
  }: GetProfileOptions): Promise<EntityProfile> {
    const ref = normalizeEntityId(entityIdRaw);
    const asOf = asOfRaw ? new Date(asOfRaw) : null;
    const txAt = recordedAtRaw ? new Date(recordedAtRaw) : null;

    return this.surreal.withScopedCompany(companyId, scopes, async (db) => {
      const entity = await queryFirst<EntityProfileRow>(
        db,
        `SELECT ${ENTITY_PROFILE_FIELDS}
         FROM type::record('knowledge_entity', $rid) LIMIT 1`,
        { rid: ref.id },
      );
      if (!entity) {
        throw new NotFoundException(`Entity ${entityIdRaw} not found`);
      }

      // Bitemporal predicates pushed into WHERE so the composite
      // (entityId, status, recordedAt) index does the work; we no
      // longer pull retracted/future-dated rows just to drop them
      // in JS. With a long-lived entity (~thousands of facts), this
      // collapses bytes-scanned by an order of magnitude for the
      // common case `asOf = now`.
      const { clauses: asOfClauses, params: asOfParams } = activeFactWhere(asOf, txAt);
      const baseClauses = [
        `entityId = type::record('knowledge_entity', $rid)`,
        // User scope (0055): entity reads are tenant-global v1 — a
        // personal fact never leaks into profile/timeline surfaces.
        `userId IS NONE`,
        ...asOfClauses,
      ];
      const params: Record<string, unknown> = { rid: ref.id, ...asOfParams };
      const factRows = await queryRows<FactProfileRow>(
        db,
        `SELECT ${FACT_PROFILE_FIELDS}
         FROM knowledge_fact
         WHERE ${baseClauses.join(' AND ')}
         ORDER BY recordedAt DESC
         LIMIT 100`,
        params,
      );
      // PII scope gate + ABAC row filter — per-row policy lookup in JS.
      const rowPolicy = makeRowPolicyFilter({
        callerScopes: scopes,
        surface: 'entity_profile',
        policyLookup: await this.predicateRegistry?.rowPolicyLookup(companyId),
      });
      const facts = factRows.filter((f) => rowPolicy.filter(f));
      rowPolicy.finish();

      return {
        entityId: String(entity.id),
        type: entity.type,
        canonicalName: entity.canonicalName,
        externalRefs: entity.externalRefs ?? {},
        mergedAt: entity.mergedAt ? new Date(entity.mergedAt).toISOString() : undefined,
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
    const entityId = await this.surreal.withScopedCompany(companyId, scopes, async (db) => {
      const rows = await queryRows<unknown>(
        db,
        `SELECT VALUE entity FROM entity_external_ref WHERE key = $key LIMIT 1`,
        { key },
      );
      return rows[0] ? String(rows[0]) : null;
    });
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
  }: FreshnessWatermarkOptions): Promise<{
    maxRecordedAt: string | null;
    maxValidFrom: string | null;
  }> {
    const ref = normalizeEntityId(entityIdRaw);
    const asOf = asOfRaw ? new Date(asOfRaw) : null;
    return this.surreal.withScopedCompany(companyId, scopes, async (db) => {
      const { clauses: asOfClauses, params: asOfParams } = activeFactWhere(asOf);
      const baseClauses = [
        `entityId = type::record('knowledge_entity', $rid)`,
        // User scope (0055): entity reads are tenant-global v1 — a
        // personal fact never leaks into profile/timeline surfaces.
        `userId IS NONE`,
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
      const [recRows, valRows] = await db.query<
        [Array<{ recordedAt: unknown }>, Array<{ validFrom: unknown }>]
      >(
        `SELECT recordedAt FROM knowledge_fact WHERE ${where}
           ORDER BY recordedAt DESC LIMIT 1;
         SELECT validFrom FROM knowledge_fact WHERE ${where}
           ORDER BY validFrom DESC LIMIT 1`,
        params,
      );
      const toIso = (v: unknown): string | null =>
        v == null ? null : v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();
      return {
        maxRecordedAt: toIso(recRows[0]?.recordedAt),
        maxValidFrom: toIso(valRows[0]?.validFrom),
      };
    });
  }

  async getTimeline({
    companyId,
    entityIdRaw,
    sinceRaw,
    untilRaw,
    recordedAtRaw,
    userId,
    scopes,
  }: GetTimelineOptions): Promise<{ entityId: string; events: TimelineEvent[] }> {
    const ref = normalizeEntityId(entityIdRaw);
    const since = sinceRaw ? new Date(sinceRaw) : null;
    const until = untilRaw ? new Date(untilRaw) : null;
    const txAt = recordedAtRaw ? new Date(recordedAtRaw) : null;
    // READ_SURFACE_USER_SCOPE (default off): this surface predates the
    // 0055 per-user scope and pinned `userId IS NONE`, so a personal
    // fact never produced a timeline event. Flag on → the
    // caller-asserted userId is pinned to a user-bound token's end-user
    // (the ingestFact idiom — 403 on mismatch, defaulted when omitted)
    // and the fence widens to the search-lane union below. Off — or on
    // with no userId in play — keeps the exact historical clause.
    const scopeUserId = readSurfaceUserScopeEnabled() ? pinUserScope(userId) : undefined;

    return this.surreal.withScopedCompany(companyId, scopes, async (db) => {
      // Range pushdown — recordedAt window is part of the WHERE so
      // long-lived entities don't pay for full timeline materialisation
      // on every query. The composite (entityId, status, recordedAt)
      // index covers the entityId+range combination directly.
      const clauses = [`entityId = type::record('knowledge_entity', $rid)`];
      const params: Record<string, unknown> = { rid: ref.id };
      if (scopeUserId !== undefined) {
        clauses.push(`(userId IS NONE OR userId = $scopeUserId)`);
        params.scopeUserId = scopeUserId;
      } else {
        clauses.push(`userId IS NONE`);
      }
      if (since) {
        clauses.push(`recordedAt >= $since`);
        params.since = since;
      }
      if (until) {
        clauses.push(`recordedAt <= $until`);
        params.until = until;
      }
      // Transaction-time cutoff: events the graph knew by T. Row-level
      // recordedAt <= T here; the retraction-event cut is applied in the
      // event builder below (a retraction after T must not surface, while
      // the fact's recorded event still shows as it was believed then).
      if (txAt) {
        clauses.push(`recordedAt <= $txAt`);
        params.txAt = txAt;
      }
      // LIMIT 1000: the timeline is the audit surface, but without a cap
      // a long-lived entity ships its entire history per request. Callers
      // page with since/until (the window params above); 1000 rows is
      // ~an order of magnitude beyond what any UI renders at once.
      const factRows = await queryRows<FactTimelineRow>(
        db,
        `SELECT ${FACT_TIMELINE_FIELDS}
         FROM knowledge_fact
         WHERE ${clauses.join(' AND ')}
         ORDER BY recordedAt ASC
         LIMIT 1000`,
        params,
      );
      const rowPolicy = makeRowPolicyFilter({
        callerScopes: scopes,
        surface: 'entity_timeline',
        policyLookup: await this.predicateRegistry?.rowPolicyLookup(companyId),
      });
      const rows = factRows.filter((f) => rowPolicy.filter(f));
      rowPolicy.finish();

      const events: TimelineEvent[] = [];
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
        if (f.retractedAt && (!txAt || new Date(f.retractedAt).getTime() <= txAt.getTime())) {
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
  }: GetConnectionsOptions): Promise<{ entityId: string; edges: ConnectionEdge[] }> {
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
      const [outRows, inRows] = await Promise.all([
        queryRows<EdgeRow>(db, outSql, { rid: ref.id, kind, asOf }),
        queryRows<EdgeRow>(db, inSql, { rid: ref.id, kind, asOf }),
      ]);
      const edges: ConnectionEdge[] = [
        ...outRows.map((e) => ({
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
        ...inRows.map((e) => ({
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
      // PII/row gate for relations. The app-layer filter is the effective
      // PII barrier on knowledge_fact.object (the DB-level PERMISSIONS fence
      // of migration 0005 is inert for the system brain_caller user); edges
      // have no field-level fence at all, so a scoped caller could otherwise
      // read a PII-classed relation (edge.kind maps to a predicate). Mirror
      // the timeline scope gate, then the ABAC row verdict — edges evaluate
      // with predicate = kind, so predicate/source rules apply to relations
      // too.
      const rowPolicy = makeRowPolicyFilter({
        callerScopes: scopes,
        surface: 'entity_connections',
        policyLookup: await this.predicateRegistry?.rowPolicyLookup(companyId),
      });
      const visibleEdges = edges.filter((edge) =>
        rowPolicy.filter({
          id: edge.edgeId,
          predicate: edge.kind,
          source: edge.source,
        }),
      );
      rowPolicy.finish();
      return { entityId: ref.full, edges: visibleEdges };
    });
  }

  async forget(opts: ForgetOptions): Promise<ForgetResult> {
    const result = await this.forgetService.forget(opts);
    this.metrics?.countForget();
    return result;
  }

  /**
   * Entity-name typeahead. Routes through the edge-ngram `prefix` fulltext
   * index on canonicalNameLc (migration 0070) so matching is word-start
   * prefix, ranked by BM25 `search::score` — no LIMIT-scan + JS substring
   * filter. Returns only live, tenant-global entities (mergedInto IS NONE
   * so identity-merged redirects don't resurface; userId IS NONE so a
   * personal-scoped entity never leaks into the shared surface), mirroring
   * the graph-retrieve name-resolution query.
   *
   * A query shorter than the analyzer's min n-gram (2 chars) produces no
   * tokens — short-circuit to empty rather than issue a match that behaves
   * undefined.
   */
  async autocomplete({
    companyId,
    q,
    limit,
    scopes,
  }: AutocompleteOptions): Promise<{ suggestions: AutocompleteSuggestion[] }> {
    const term = (q ?? '').trim().toLowerCase();
    if (term.length < AUTOCOMPLETE_MIN_CHARS) return { suggestions: [] };
    const lim = Math.min(
      Math.max(Math.trunc(limit ?? AUTOCOMPLETE_DEFAULT_LIMIT), 1),
      AUTOCOMPLETE_MAX_LIMIT,
    );
    return this.surreal.withScopedCompany(companyId, scopes, async (db) => {
      const [rows] = await db.query<
        [Array<{ id: unknown; type: string; canonicalName: string; score: number }>]
      >(
        `SELECT id, type, canonicalName, search::score(1) AS score
           FROM knowledge_entity
          WHERE mergedInto IS NONE
            AND userId IS NONE
            AND canonicalNameLc @1@ $q
          ORDER BY score DESC
          LIMIT $lim`,
        { q: term, lim },
      );
      return {
        suggestions: (
          (rows as Array<{
            id: unknown;
            type: string;
            canonicalName: string;
            score: number;
          }>) ?? []
        ).map((r) => ({
          entityId: String(r.id),
          canonicalName: r.canonicalName,
          type: r.type,
          score: r.score,
        })),
      };
    });
  }
}
