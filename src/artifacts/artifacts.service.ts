import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  Optional,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Surreal, StringRecordId } from 'surrealdb';
import {
  SurrealService,
  retryOnUniqueViolation,
  queryRows,
  queryFirst,
} from '../db/surreal.service';
import { policyFor } from '../ingest/conflict-resolver';
import type { FactSource } from '../ingest/dto/ingest-fact.dto';
import { BrainScope } from '../auth/api-key.types';
import { scopeFenceSql } from '../auth/scope-visibility';
import { actingCircleTags } from '../auth/circle-scope';
import { getPolicyContext, getRequestContext } from '../common/request-context';
import { makeRowPolicyFilter, type PredicatePolicyLookup } from '../policy/row-filter';
import { PredicateRegistryService } from '../ai/predicate-registry.service';
import {
  TEMPLATES,
  ARTIFACT_FIELD_TO_PREDICATE,
  type FactRow as TemplateFactRow,
  type CompiledArtifact,
  type Citation,
} from './templates';

// Own-key Map view of the template registry for request-derived lookups.
const TEMPLATE_MAP = new Map(Object.entries(TEMPLATES));

/**
 * ArtifactsService — compilation-stage knowledge layer.
 *
 * Pinecone Nexus framing: agentic callers consume pre-built, typed,
 * task-shaped bundles instead of raw fact arrays. Each bundle ("artifact")
 * is composed at compile time from the active fact set for an entity,
 * stamped with citations + freshness, and persisted in
 * `knowledge_artifact` for one-trip serving on subsequent reads.
 *
 * Lifecycle:
 *   1. Caller hits getArtifact(entity, type)
 *   2. Service looks up cached row in `knowledge_artifact`
 *   3. If absent OR dirty (CHANGEFEED-driven event) OR stale (older
 *      than `staleAfterMs`), recompile from current facts
 *   4. UPSERT and return
 *
 * The compile step is deterministic per fact set: same facts → same
 * artifact, plus the citation chain in `_citations` lets a downstream
 * model surface "this came from fact X recorded at T" inline.
 */

/**
 * ArtifactType is now a string keyed against the TEMPLATES registry
 * (see ./templates.ts). The schema field on knowledge_artifact is
 * free-form (migration 0004.1 removed the ASSERT enum) so adding a
 * vertical-specific template is a one-file change in TS — no DB
 * migration. Known types as of 0.2.0:
 *   generic:     customer_profile | support_context | risk_snapshot | identity_dossier
 *   rent:        tenant_dossier
 *   estate:      listing_card | prospect_summary
 *   events:      attendee_history
 *   health:      patient_summary
 *   shop:        order_history
 *   club:        member_profile
 *   education:   learner_progress
 *   sport:       athlete_card
 *   travel:      traveler_history
 *   food:        diner_preferences
 *   studio:      studio_bookings
 *   ai:          ai_user_context
 */
export type ArtifactType = keyof typeof TEMPLATES | string;

export interface KnowledgeArtifact {
  artifactId: string;
  entityId: string;
  artifactType: ArtifactType;
  payload: Record<string, unknown>;
  /** Per-field provenance — `<fieldName>` → list of source factIds + confidence */
  citations: Record<string, Citation[]>;
  builtAt: string;
  freshFor: number; // remaining ms before becoming stale
  sourceFactIds: string[];
}

type FactRow = TemplateFactRow;

/** knowledge_entity existence probe. */
interface EntityIdRow {
  id: unknown;
}

/** The wrapped `payload` column: `{ payload, _citations, _visibility }` (see upsertArtifact). */
interface WrappedPayload {
  payload?: Record<string, unknown>;
  _citations?: KnowledgeArtifact['citations'];
  /** Visibility key of the caller the artifact was compiled for. */
  _visibility?: string;
}

/** A cached knowledge_artifact row as read by fetchCached. */
interface CachedArtifactRow {
  payload?: WrappedPayload;
  sourceFactIds?: unknown[];
  builtAt: string;
  staleAfterMs?: number;
  dirty?: unknown;
}

/** A knowledge_artifact row after an UPSERT's `RETURN AFTER`. */
interface StoredArtifactRow {
  builtAt: string;
  staleAfterMs?: number;
  dirty?: unknown;
}

/** A knowledge_fact row as read by fetchActiveFacts (columns it SELECTs). */
interface ActiveFactRow {
  id: unknown;
  predicate: string;
  object: string;
  confidence: number;
  validFrom: string;
  recordedAt: string;
  source: FactSource;
  status: string;
  trustSnapshot?: { authority?: number; declaredTrust?: number; learnedTrust?: number } | null;
  corroboration?: { count?: number } | null;
  userId?: string | null;
}

/** A cached or freshly stored artifact, before shaping for the caller. */
interface ArtifactRecord {
  payload: Record<string, unknown>;
  citations: KnowledgeArtifact['citations'];
  sourceFactIds: string[];
  builtAt: string;
  staleAfterMs: number;
  dirty: boolean;
  visibility?: string | undefined;
}

/**
 * The caller's VISIBILITY — what the compiled facts depended on: the
 * scope set (the predicate gate, brain:read_pii), the ABAC policy (its
 * key identity), the user a user-bound token is (the scope-tag fence)
 * and the circle it acts in. The cache has one slot per (entity, type)
 * (a UNIQUE index), so the key rides in the payload and a cached
 * artifact is served only to a caller with the same key; anyone else
 * recompiles from what they may see. Before, an artifact compiled for a
 * read_pii caller was served to a brain:read one until it went stale.
 */
function visibilityKey(scopes: readonly BrainScope[]): string {
  const raw = [
    [...scopes].sort().join(','),
    getPolicyContext()?.keyHash ?? 'no-policy',
    getRequestContext()?.authUserId ?? '',
    [...actingCircleTags()].sort().join(','),
  ].join('::');
  return createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

export interface GetArtifactOptions {
  companyId: string;
  entityIdRaw: string;
  artifactType: ArtifactType;
  scopes: BrainScope[];
}

export interface RecompileArtifactOptions {
  companyId: string;
  entityIdRaw: string;
  artifactType: ArtifactType;
  scopes: BrainScope[];
}

@Injectable()
export class ArtifactsService {
  private readonly logger = new Logger(ArtifactsService.name);

  constructor(
    private readonly surreal: SurrealService,
    @Optional() private readonly predicateRegistry?: PredicateRegistryService,
  ) {}

  /** Registry-backed predicate policy (tenant predicates), seed fallback. */
  private async policyLookup(companyId: string): Promise<PredicatePolicyLookup> {
    return (await this.predicateRegistry?.rowPolicyLookup(companyId)) ?? policyFor;
  }

  async getArtifact({
    companyId,
    entityIdRaw,
    artifactType,
    scopes,
  }: GetArtifactOptions): Promise<KnowledgeArtifact> {
    const ref = this.normalizeEntityId(entityIdRaw);
    const lookup = await this.policyLookup(companyId);
    const visibility = visibilityKey(scopes);
    return this.surreal.withScopedCompany(companyId, scopes, async (db) => {
      // 1. Verify entity exists.
      const ent = await queryFirst<EntityIdRow>(
        db,
        `SELECT id FROM type::record('knowledge_entity', $rid) LIMIT 1`,
        { rid: ref.id },
      );
      if (!ent) {
        throw new NotFoundException(`Entity ${entityIdRaw} not found`);
      }

      // 2. Try cache lookup.
      const cached = await this.fetchCached(db, ref.id, artifactType);
      const now = Date.now();
      if (cached && !cached.dirty && cached.visibility === visibility) {
        const ageMs = now - new Date(cached.builtAt).getTime();
        if (ageMs < cached.staleAfterMs) {
          return this.shapeForReturn({
            cached,
            fullSelf: ref.full,
            scopes,
            lookup,
            ageMs,
            artifactType,
          });
        }
      }

      // 3. Recompile from the facts this caller may see.
      const facts = await this.fetchActiveFacts({ db, rid: ref.id, scopes, lookup });
      const compiled = this.compile(artifactType, facts);

      // 4. UPSERT into knowledge_artifact. Two-statement tx semantics
      // are unnecessary here because the unique index on (entityId,
      // artifactType) lets us either CREATE or UPDATE in one go.
      // We use UPDATE...UPSERT-style: update if exists, else create.
      const stored = await this.upsertArtifact({
        db,
        rid: ref.id,
        artifactType,
        payload: compiled.payload,
        citations: compiled.citations,
        sourceFactIds: compiled.sourceFactIds,
        visibility,
        // dirty as observed before we read facts; the CAS clears it only if
        // unchanged since (no fact-change event fired during compile).
        expectedDirty: cached?.dirty ?? false,
      });
      const ageMs = now - new Date(stored.builtAt).getTime();
      return this.shapeForReturn({
        cached: stored,
        fullSelf: ref.full,
        scopes,
        lookup,
        ageMs,
        artifactType,
      });
    });
  }

  /** Force-recompile and return — bypasses cache freshness check. */
  async recompileArtifact({
    companyId,
    entityIdRaw,
    artifactType,
    scopes,
  }: RecompileArtifactOptions): Promise<KnowledgeArtifact> {
    const ref = this.normalizeEntityId(entityIdRaw);
    const lookup = await this.policyLookup(companyId);
    return this.surreal.withScopedCompany(companyId, scopes, async (db) => {
      const ent = await queryFirst<EntityIdRow>(
        db,
        `SELECT id FROM type::record('knowledge_entity', $rid) LIMIT 1`,
        { rid: ref.id },
      );
      if (!ent) {
        throw new NotFoundException(`Entity ${entityIdRaw} not found`);
      }
      // Observe dirty BEFORE reading facts so the CAS in upsertArtifact can
      // tell whether a fact-change event fired mid-compile and preserve it.
      const before = await this.fetchCached(db, ref.id, artifactType);
      const facts = await this.fetchActiveFacts({ db, rid: ref.id, scopes, lookup });
      const compiled = this.compile(artifactType, facts);
      const stored = await this.upsertArtifact({
        db,
        rid: ref.id,
        artifactType,
        payload: compiled.payload,
        citations: compiled.citations,
        sourceFactIds: compiled.sourceFactIds,
        visibility: visibilityKey(scopes),
        expectedDirty: before?.dirty ?? false,
      });
      return this.shapeForReturn({
        cached: stored,
        fullSelf: ref.full,
        scopes,
        lookup,
        ageMs: 0,
        artifactType,
      });
    });
  }

  // ─── compilation templates ────────────────────────────────────────

  /**
   * Dispatch to the template registry in ./templates.ts. Each template
   * is a pure function (FactRow[]) → CompiledArtifact, so adding a new
   * artifact type is a single-file change with no schema migration.
   * Unknown types throw 400 — surfaces upstream typos cleanly instead
   * of returning an empty bundle.
   */
  private compile(type: ArtifactType, facts: FactRow[]): CompiledArtifact {
    // `type` is request-derived: a Map lookup can't resolve inherited
    // Object members ('constructor'/'toString') the way obj[type] can,
    // so an unknown or hostile value dead-ends at undefined.
    const template = TEMPLATE_MAP.get(type);
    if (typeof template !== 'function') {
      throw new BadRequestException(
        `Unknown artifactType '${type}'. Known: ${[...TEMPLATE_MAP.keys()].join(', ')}`,
      );
    }
    const out = template(facts);
    // De-duplicate sourceFactIds — multiple template fields commonly cite
    // the same fact (e.g. customer_profile.name + identity_dossier.name).
    out.sourceFactIds = [...new Set(out.sourceFactIds)];
    return out;
  }

  // ─── persistence helpers ──────────────────────────────────────────

  private async fetchCached(
    db: Surreal,
    rid: string,
    artifactType: ArtifactType,
  ): Promise<ArtifactRecord | null> {
    const row = await queryFirst<CachedArtifactRow>(
      db,
      `SELECT payload, sourceFactIds, builtAt, staleAfterMs, dirty
       FROM knowledge_artifact
       WHERE entityId = type::record('knowledge_entity', $rid)
         AND artifactType = $type
       LIMIT 1`,
      { rid, type: artifactType },
    );
    if (!row) return null;
    const payload = (row.payload?.payload ?? row.payload) as Record<string, unknown>;
    const citations = (row.payload?._citations ?? {}) as KnowledgeArtifact['citations'];
    return {
      payload,
      citations,
      sourceFactIds: (row.sourceFactIds ?? []).map((id: unknown) => String(id)),
      builtAt: row.builtAt,
      staleAfterMs: row.staleAfterMs ?? 300_000,
      dirty: !!row.dirty,
      visibility: row.payload?._visibility,
    };
  }

  private async fetchActiveFacts({
    db,
    rid,
    scopes,
    lookup,
  }: {
    db: Surreal;
    rid: string;
    scopes: BrainScope[];
    lookup: PredicatePolicyLookup;
  }): Promise<FactRow[]> {
    // Mirrors fn::active_facts_for (migration 0003; removed as dead in
    // 0090 — this inline query is the live implementation) but pins the
    // tenant-GLOBAL scope: artifacts are a tenant-wide surface with no
    // per-user concept (like graph_retrieve), so a per-user fact
    // (userId != NONE, migration 0055) must never be compiled into a
    // dossier served to the whole tenant. The stored fn predated 0055 and
    // had no scope arg, so we queried inline instead of extending it.
    // LIMIT: compile() consumes a bounded slice of the newest facts, but
    // this ran unbounded on the artifact read path — a long-lived entity
    // shipped its entire fact history per cache miss. 500 newest is far
    // beyond what any template renders.
    //
    // The scope-tag fence rides along (a circle's or a group's rows only
    // for that circle or group), and every row passes the registry row
    // filter: a tenant-authored predicate's requiresScope and the ABAC
    // verdict, not only the static seed policy.
    const tags = scopeFenceSql(undefined, 'artifactScopeTag');
    const rows = await queryRows<ActiveFactRow>(
      db,
      `SELECT id, predicate, object, confidence, validFrom, validUntil,
              recordedAt, source, status, trustSnapshot, corroboration, userId
         FROM knowledge_fact
         WHERE entityId = type::record('knowledge_entity', $rid)
           AND retractedAt IS NONE
           AND userId IS NONE
           ${tags.clause}
         ORDER BY recordedAt DESC
         LIMIT 500`,
      { rid, ...tags.params },
    );
    const rowFilter = makeRowPolicyFilter({
      callerScopes: scopes,
      surface: 'artifacts',
      policyLookup: lookup,
    });
    const visible = rows.filter((f) => rowFilter.filter(f));
    rowFilter.finish();
    return visible.map((f) => ({
      id: f.id,
      predicate: f.predicate,
      object: f.object,
      confidence: f.confidence,
      validFrom: f.validFrom,
      recordedAt: f.recordedAt,
      source: f.source,
      status: f.status,
    }));
  }

  private async upsertArtifact({
    db,
    rid,
    artifactType,
    payload,
    citations,
    sourceFactIds,
    visibility,
    expectedDirty,
  }: {
    db: Surreal;
    rid: string;
    artifactType: ArtifactType;
    payload: Record<string, unknown>;
    citations: KnowledgeArtifact['citations'];
    sourceFactIds: string[];
    visibility: string;
    expectedDirty: boolean;
  }): Promise<ArtifactRecord> {
    // Wrap payload + citations together so they round-trip as a single
    // FLEXIBLE object — schema has one `payload` field, no need for
    // a separate citations column. The visibility key rides along.
    const wrapped = { payload, _citations: citations, _visibility: visibility };
    const factRecords = sourceFactIds.map((id) => new StringRecordId(id));

    // SurrealDB UPSERT semantics: try UPDATE first; if no rows
    // matched the predicate, fall through to CREATE. This is the
    // documented v2 idiom in lieu of a true UPSERT keyword on a
    // composite-key uniqueness pattern.
    // Wrap in retryOnUniqueViolation: two concurrent cold reads both miss
    // the UPDATE and both CREATE → one hits the (entityId, artifactType)
    // UNIQUE index. On retry the UPDATE now finds the winner's row.
    const row = await retryOnUniqueViolation(async () => {
      const updated = await queryFirst<StoredArtifactRow>(
        db,
        // CAS on dirty: clear it only if the flag still matches what we
        // observed before reading facts. migration 0004 defines a DB EVENT
        // that flips dirty=true whenever a relevant fact changes, so a fact
        // landing DURING our compile would otherwise be clobbered back to
        // dirty=false — serving a stale artifact marked clean. When the
        // current dirty differs from $expectedDirty, the event fired mid-
        // compile, so we leave dirty=true and the next read recompiles.
        `UPDATE knowledge_artifact
         SET payload = $wrapped,
             sourceFactIds = $facts,
             builtAt = time::now(),
             dirty = IF dirty = $expectedDirty THEN false ELSE dirty END
         WHERE entityId = type::record('knowledge_entity', $rid)
           AND artifactType = $type
         RETURN AFTER`,
        {
          rid,
          type: artifactType,
          wrapped,
          facts: factRecords,
          expectedDirty,
        },
      );
      if (updated) return updated;
      const created = await queryFirst<StoredArtifactRow>(
        db,
        `CREATE knowledge_artifact CONTENT {
            entityId: type::record('knowledge_entity', $rid),
            artifactType: $type,
            payload: $wrapped,
            sourceFactIds: $facts,
            dirty: false
         } RETURN AFTER`,
        { rid, type: artifactType, wrapped, facts: factRecords },
      );
      if (!created) {
        throw new Error('upsertArtifact: CREATE returned no row');
      }
      return created;
    });
    return {
      payload,
      citations,
      sourceFactIds,
      builtAt: row.builtAt,
      staleAfterMs: row.staleAfterMs ?? 300_000,
      // Reflect the persisted flag: the CAS above may have left dirty=true
      // if a fact-change event fired during compile (CREATE always clean).
      dirty: !!row.dirty,
      visibility,
    };
  }

  /**
   * PII filter on the COMPILED payload, defence in depth behind the
   * visibility-keyed cache: a field whose source predicate needs a scope
   * the caller lacks is dropped. A list field whose items carry their own
   * predicate (risk_snapshot's competingFacts / lowConfidenceFacts list
   * facts of ANY predicate) is filtered item by item, its citations with
   * it. sourceFactIds keeps only ids still cited, so no gated factId
   * leaks through the id list either.
   */
  private shapeForReturn({
    cached,
    fullSelf,
    scopes,
    lookup,
    ageMs,
    artifactType,
  }: {
    cached: ArtifactRecord;
    fullSelf: string;
    scopes: BrainScope[];
    lookup: PredicatePolicyLookup;
    ageMs: number;
    artifactType: ArtifactType;
  }): KnowledgeArtifact {
    const gated = (predicate: string): boolean => {
      const policy = lookup(predicate);
      return (
        !!policy.requiresScope && !(scopes as readonly string[]).includes(policy.requiresScope)
      );
    };
    const filteredPayload: Record<string, unknown> = {};
    const filteredCitations: KnowledgeArtifact['citations'] = {};
    for (const [field, value] of Object.entries(cached.payload)) {
      const cites = cached.citations[field];
      if (Array.isArray(value) && value.some(itemPredicate)) {
        const keep = value.map((item) => {
          const p = itemPredicate(item);
          return p === undefined ? !gated(ARTIFACT_FIELD_TO_PREDICATE[field] ?? field) : !gated(p);
        });
        filteredPayload[field] = value.filter((_v, i) => keep[i]);
        if (cites) filteredCitations[field] = cites.filter((_c, i) => keep[i]);
        continue;
      }
      if (cites && cites.length > 0) {
        // Field name === predicate for canonical templates; composed
        // fields map to their source predicate.
        if (gated(ARTIFACT_FIELD_TO_PREDICATE[field] ?? field)) continue;
        filteredCitations[field] = cites;
      }
      filteredPayload[field] = value;
    }
    const cited = new Set(
      Object.values(filteredCitations).flatMap((cs) => cs.map((c) => String(c.factId))),
    );
    const sourceFactIds = cached.sourceFactIds.filter((id) => cited.has(id));
    return {
      artifactId: `knowledge_artifact:${fullSelf.replace('knowledge_entity:', '')}::${sourceFactIds.length}`,
      entityId: fullSelf,
      artifactType,
      payload: filteredPayload,
      citations: filteredCitations,
      builtAt: new Date(cached.builtAt).toISOString(),
      freshFor: Math.max(0, cached.staleAfterMs - ageMs),
      sourceFactIds,
    };
  }

  private normalizeEntityId(raw: string): { id: string; full: string } {
    const id = raw.startsWith('knowledge_entity:') ? raw.slice('knowledge_entity:'.length) : raw;
    return { id, full: `knowledge_entity:${id}` };
  }
}

/** The predicate a list item carries (risk_snapshot's fact items), if any. */
function itemPredicate(item: unknown): string | undefined {
  if (item === null || typeof item !== 'object') return undefined;
  const p = (item as { predicate?: unknown }).predicate;
  return typeof p === 'string' ? p : undefined;
}
