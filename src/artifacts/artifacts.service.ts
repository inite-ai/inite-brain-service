import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { Surreal, StringRecordId } from 'surrealdb';
import { SurrealService } from '../db/surreal.service';
import { policyFor } from '../ingest/conflict-resolver';
import { BrainScope } from '../auth/api-key.types';
import {
  TEMPLATES,
  ARTIFACT_FIELD_TO_PREDICATE,
  type FactRow as TemplateFactRow,
  type CompiledArtifact,
  type Citation,
} from './templates';

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

@Injectable()
export class ArtifactsService {
  private readonly logger = new Logger(ArtifactsService.name);

  constructor(private readonly surreal: SurrealService) {}

  async getArtifact(
    companyId: string,
    entityIdRaw: string,
    artifactType: ArtifactType,
    scopes: BrainScope[],
  ): Promise<KnowledgeArtifact> {
    const ref = this.normalizeEntityId(entityIdRaw);
    return this.surreal.withScopedCompany(companyId, scopes, async (db) => {
      // 1. Verify entity exists.
      const [entRows] = await db.query<any[][]>(
        `SELECT id FROM type::thing('knowledge_entity', $rid) LIMIT 1`,
        { rid: ref.id },
      );
      if (!(entRows as any[])?.[0]) {
        throw new NotFoundException(`Entity ${entityIdRaw} not found`);
      }

      // 2. Try cache lookup.
      const cached = await this.fetchCached(db, ref.id, artifactType);
      const now = Date.now();
      if (cached && !cached.dirty) {
        const ageMs = now - new Date(cached.builtAt).getTime();
        if (ageMs < cached.staleAfterMs) {
          return this.shapeForReturn(cached, ref.full, scopes, ageMs);
        }
      }

      // 3. Recompile from current facts.
      const facts = await this.fetchActiveFacts(db, ref.id, scopes);
      const compiled = this.compile(artifactType, facts);

      // 4. UPSERT into knowledge_artifact. Two-statement tx semantics
      // are unnecessary here because the unique index on (entityId,
      // artifactType) lets us either CREATE or UPDATE in one go.
      // We use UPDATE...UPSERT-style: update if exists, else create.
      const stored = await this.upsertArtifact(
        db,
        ref.id,
        artifactType,
        compiled.payload,
        compiled.citations,
        compiled.sourceFactIds,
      );
      const ageMs = now - new Date(stored.builtAt).getTime();
      return this.shapeForReturn(stored, ref.full, scopes, ageMs);
    });
  }

  /** Force-recompile and return — bypasses cache freshness check. */
  async recompileArtifact(
    companyId: string,
    entityIdRaw: string,
    artifactType: ArtifactType,
    scopes: BrainScope[],
  ): Promise<KnowledgeArtifact> {
    const ref = this.normalizeEntityId(entityIdRaw);
    return this.surreal.withScopedCompany(companyId, scopes, async (db) => {
      const [entRows] = await db.query<any[][]>(
        `SELECT id FROM type::thing('knowledge_entity', $rid) LIMIT 1`,
        { rid: ref.id },
      );
      if (!(entRows as any[])?.[0]) {
        throw new NotFoundException(`Entity ${entityIdRaw} not found`);
      }
      const facts = await this.fetchActiveFacts(db, ref.id, scopes);
      const compiled = this.compile(artifactType, facts);
      const stored = await this.upsertArtifact(
        db,
        ref.id,
        artifactType,
        compiled.payload,
        compiled.citations,
        compiled.sourceFactIds,
      );
      return this.shapeForReturn(stored, ref.full, scopes, 0);
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
    const template = TEMPLATES[type];
    if (!template) {
      throw new BadRequestException(
        `Unknown artifactType '${type}'. Known: ${Object.keys(TEMPLATES).join(', ')}`,
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
  ): Promise<{
    payload: Record<string, unknown>;
    citations: KnowledgeArtifact['citations'];
    sourceFactIds: string[];
    builtAt: string;
    staleAfterMs: number;
    dirty: boolean;
  } | null> {
    const [rows] = await db.query<any[][]>(
      `SELECT payload, sourceFactIds, builtAt, staleAfterMs, dirty
       FROM knowledge_artifact
       WHERE entityId = type::thing('knowledge_entity', $rid)
         AND artifactType = $type
       LIMIT 1`,
      { rid, type: artifactType },
    );
    const row = ((rows as any[]) ?? [])[0];
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
    };
  }

  private async fetchActiveFacts(
    db: Surreal,
    rid: string,
    scopes: BrainScope[],
  ): Promise<FactRow[]> {
    // Use the centralised server-side function from migration 0003.
    const [rows] = await db.query<[any[]]>(
      `RETURN fn::active_facts_for(type::thing('knowledge_entity', $rid), NONE)`,
      { rid },
    );
    return ((rows as any[]) ?? [])
      .filter((f: any) => {
        const policy = policyFor(f.predicate);
        if (policy.requiresScope && !scopes.includes(policy.requiresScope)) {
          return false;
        }
        return true;
      })
      .map((f: any) => ({
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

  private async upsertArtifact(
    db: Surreal,
    rid: string,
    artifactType: ArtifactType,
    payload: Record<string, unknown>,
    citations: KnowledgeArtifact['citations'],
    sourceFactIds: string[],
  ) {
    // Wrap payload + citations together so they round-trip as a single
    // FLEXIBLE object — schema has one `payload` field, no need for
    // a separate citations column.
    const wrapped = { payload, _citations: citations };
    const factRecords = sourceFactIds.map((id) => new StringRecordId(id));

    // SurrealDB UPSERT semantics: try UPDATE first; if no rows
    // matched the predicate, fall through to CREATE. This is the
    // documented v2 idiom in lieu of a true UPSERT keyword on a
    // composite-key uniqueness pattern.
    const [updRows] = await db.query<any[][]>(
      `UPDATE knowledge_artifact
       SET payload = $wrapped,
           sourceFactIds = $facts,
           builtAt = time::now(),
           dirty = false
       WHERE entityId = type::thing('knowledge_entity', $rid)
         AND artifactType = $type
       RETURN AFTER`,
      {
        rid,
        type: artifactType,
        wrapped,
        facts: factRecords,
      },
    );
    let row = ((updRows as any[]) ?? [])[0];
    if (!row) {
      const [creRows] = await db.query<any[][]>(
        `CREATE knowledge_artifact CONTENT {
            entityId: type::thing('knowledge_entity', $rid),
            artifactType: $type,
            payload: $wrapped,
            sourceFactIds: $facts,
            dirty: false
         } RETURN AFTER`,
        {
          rid,
          type: artifactType,
          wrapped,
          facts: factRecords,
        },
      );
      row = ((creRows as any[]) ?? [])[0];
    }
    return {
      payload,
      citations,
      sourceFactIds,
      builtAt: row.builtAt,
      staleAfterMs: row.staleAfterMs ?? 300_000,
      dirty: false,
    };
  }

  private shapeForReturn(
    cached: {
      payload: Record<string, unknown>;
      citations: KnowledgeArtifact['citations'];
      sourceFactIds: string[];
      builtAt: string;
      staleAfterMs: number;
    },
    fullSelf: string,
    scopes: BrainScope[],
    ageMs: number,
  ): KnowledgeArtifact {
    // PII filter on the COMPILED payload — drop fields whose source
    // predicates require a scope the caller doesn't carry. The
    // citations array also gets pruned so we don't leak factIds for
    // gated material.
    const filteredPayload: Record<string, unknown> = {};
    const filteredCitations: KnowledgeArtifact['citations'] = {};
    for (const [field, value] of Object.entries(cached.payload)) {
      const cites = cached.citations[field];
      if (cites && cites.length > 0) {
        // Look up source predicate via citation; if any citation has a
        // restricted predicate and caller lacks scope, hide the field.
        // This is a defence-in-depth: fetchActiveFacts already filters
        // by scope before compile, so a fresh-built artifact is already
        // clean. Cached artifacts, however, may have been built with a
        // higher-scope caller — re-check on every read.
        const restricted = cites.some((c) => {
          const factId = c.factId;
          // Citations carry only id/conf/source — not the predicate
          // directly. Field name === predicate for canonical templates,
          // so we use the field name as the policy key. For composed
          // fields (recentInteractions, complaints) the field name
          // matches the source predicate's category.
          // Map field → underlying predicate:
          const predicate = ARTIFACT_FIELD_TO_PREDICATE[field] ?? field;
          const policy = policyFor(predicate);
          return policy.requiresScope && !scopes.includes(policy.requiresScope);
        });
        if (restricted) continue;
        filteredCitations[field] = cites;
      }
      filteredPayload[field] = value;
    }
    return {
      artifactId: `knowledge_artifact:${fullSelf.replace('knowledge_entity:', '')}::${cached.sourceFactIds.length}`,
      entityId: fullSelf,
      artifactType: 'customer_profile' as ArtifactType,
      payload: filteredPayload,
      citations: filteredCitations,
      builtAt: new Date(cached.builtAt).toISOString(),
      freshFor: Math.max(0, cached.staleAfterMs - ageMs),
      sourceFactIds: cached.sourceFactIds,
    };
  }

  private normalizeEntityId(raw: string): { id: string; full: string } {
    const id = raw.startsWith('knowledge_entity:')
      ? raw.slice('knowledge_entity:'.length)
      : raw;
    return { id, full: `knowledge_entity:${id}` };
  }
}

