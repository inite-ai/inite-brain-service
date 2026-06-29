import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SurrealService } from '../db/surreal.service';
import { EmbedderService } from './embedder.service';
import { cosineSimilarity } from '../common/vector-math';
import { LRUCache } from '../common/lru-cache';

import {
  type CanonicalizeDecision,
  CANONICALIZE_REPORT_FLOOR,
  DEFAULT_CANONICALIZE_AUTO_ALIAS_THRESHOLD,
  DEFAULT_FALLBACK,
  type PiiClass,
  type PredicateDefinition,
  type PredicateSnapshot,
  type Semantics,
  SNAPSHOT_TTL_MS,
} from './predicate-registry-internals/types';
// Core + installed Domain Packs (namespaced predicates), assembled + collision-
// checked at load. The registry seeds / falls back on the MERGED set so a pack's
// predicates are bootstrapped into every tenant. See src/ai/domain-packs.
import { SEED_PREDICATES } from './domain-packs';
import {
  computeHash,
  deserializeFromRow,
  embeddingTextFor,
  serializeForInsert,
} from './predicate-registry-internals/db-mapping';

export {
  type CanonicalizeDecision,
  type PiiClass,
  type PredicateDefinition,
  type PredicateSnapshot,
  type PredicateStatus,
  type Semantics,
  DEFAULT_FALLBACK,
} from './predicate-registry-internals/types';
export { CORE_PREDICATES } from './predicate-registry-internals/core-seed';

/**
 * Per-tenant predicate ontology registry.
 *
 * Bootstrap seed (CORE_PREDICATES) and DB row mapping live in
 * `./predicate-registry-internals/`. This file owns the runtime
 * lifecycle: snapshot cache, bootstrap, CRUD writes, and the EDC
 * canonicalize loop.
 */

@Injectable()
export class PredicateRegistryService {
  private readonly logger = new Logger(PredicateRegistryService.name);
  /**
   * Per-tenant snapshot cache. Keyed by companyId. Bounded by an LRU to
   * cap memory in fleets that touch many tenants per process — each
   * snapshot carries up to ~25 predicate embeddings (~300 KB/tenant
   * at 1536 dims), so 1000+ tenants on an unbounded Map starves the
   * heap. Default capacity is conservative (200); operators can lift
   * via PREDICATE_REGISTRY_CACHE_CAP when running fewer, hotter
   * tenants.
   */
  private readonly cache: LRUCache<
    string,
    { snapshot: PredicateSnapshot; loadedAt: number }
  >;
  /**
   * Per-tenant bootstrap flag — ensureBootstrap runs once per process
   * per tenant. Bounded so a fleet rotating through thousands of
   * tenants doesn't grow this set unboundedly either. Eviction is
   * harmless: ensureBootstrap is idempotent (SELECT + INSERT-IF-MISSING
   * pattern); an evicted tenant just re-checks the predicate table the
   * next time it touches the registry.
   */
  private readonly bootstrapped: LRUCache<string, true>;
  // In-flight bootstrap per tenant — dedupes concurrent first-requests so
  // two cold reads don't both run the seed (which would CREATE duplicate
  // knowledge_predicate rows; no unique constraint protects against it).
  private readonly bootstrapInFlight = new Map<string, Promise<void>>();

  private readonly canonicalizeThreshold: number;

  constructor(
    private readonly surreal: SurrealService,
    private readonly embedder: EmbedderService,
    private readonly config: ConfigService,
  ) {
    const parsedThreshold = parseFloat(
      this.config.get<string>(
        'PREDICATE_CANONICALIZE_THRESHOLD',
        String(DEFAULT_CANONICALIZE_AUTO_ALIAS_THRESHOLD),
      ),
    );
    // Guard against a malformed env value: a bare parseFloat yields NaN,
    // and `similarity >= NaN` is always false, which silently disables
    // auto-aliasing entirely. Fall back to the default instead.
    this.canonicalizeThreshold = Number.isFinite(parsedThreshold)
      ? parsedThreshold
      : DEFAULT_CANONICALIZE_AUTO_ALIAS_THRESHOLD;
    const cap = parseInt(
      this.config.get<string>('PREDICATE_REGISTRY_CACHE_CAP', '200'),
      10,
    );
    this.cache = new LRUCache(cap);
    this.bootstrapped = new LRUCache(cap);
  }

  /**
   * Idempotently INSERT every CORE_PREDICATE that isn't already in the
   * tenant's knowledge_predicate table. Pre-existing rows are NOT touched
   * (operator overrides + admin-added predicates survive bootstrap).
   * Called lazily on first registry read per tenant per process.
   */
  private async ensureBootstrap(companyId: string): Promise<void> {
    if (this.bootstrapped.has(companyId)) return;
    let p = this.bootstrapInFlight.get(companyId);
    if (!p) {
      p = this.doBootstrap(companyId).finally(() =>
        this.bootstrapInFlight.delete(companyId),
      );
      this.bootstrapInFlight.set(companyId, p);
    }
    return p;
  }

  private async doBootstrap(companyId: string): Promise<void> {
    await this.surreal.withCompany(companyId, async (db) => {
      const [existingRows] = await db.query<
        [Array<{ predicateId: string; embedding?: number[] | null }>]
      >(`SELECT predicateId, embedding FROM knowledge_predicate`);
      const existing = (existingRows as Array<{
        predicateId: string;
        embedding?: number[] | null;
      }>) ?? [];
      const existingIds = new Set(existing.map((r) => r.predicateId));
      const missing = SEED_PREDICATES.filter(
        (p) => !existingIds.has(p.predicateId),
      );
      if (missing.length > 0) {
        this.logger.log(
          `Seeding ${missing.length} core predicate(s) into ${companyId}: ` +
            missing.map((p) => p.predicateId).join(', '),
        );
        // Embed the predicate "cards" in ONE batched call (OpenAI
        // /embeddings accepts arrays). Pre-batch this was N sequential
        // round-trips before the first request landed; the audit
        // flagged it as fresh-tenant cold-start tax. embedMany also
        // hits the per-text LRU cache so a second bootstrap on the
        // same process pays no API calls.
        let embeddings: Array<number[] | null>;
        try {
          embeddings = await this.embedder.embedMany(
            missing.map((p) => embeddingTextFor(p)),
          );
        } catch (e) {
          this.logger.warn(
            `Batched predicate embed failed (${(e as Error).message}); ` +
              `falling back to per-row inserts without embedding`,
          );
          embeddings = missing.map(() => null);
        }
        for (let i = 0; i < missing.length; i++) {
          await db.query(`CREATE knowledge_predicate CONTENT $content`, {
            content: {
              ...serializeForInsert(missing[i]),
              ...(embeddings[i] ? { embedding: embeddings[i] } : {}),
            },
          });
        }
      }

      // Backfill embeddings for any pre-existing row that's missing one
      // (rows seeded before migration 0012 landed).
      const needBackfill = existing.filter(
        (r) =>
          !Array.isArray(r.embedding) || (r.embedding as number[]).length === 0,
      );
      if (needBackfill.length > 0) {
        this.logger.log(
          `Backfilling embeddings for ${needBackfill.length} predicate(s) in ${companyId}`,
        );
        const texts = needBackfill.map((row) => {
          const seed = SEED_PREDICATES.find(
            (p) => p.predicateId === row.predicateId,
          );
          return seed
            ? embeddingTextFor(seed)
            : row.predicateId.replace(/_/g, ' ');
        });
        let embs: Array<number[] | null>;
        try {
          embs = await this.embedder.embedMany(texts);
        } catch (e) {
          this.logger.warn(
            `Batched backfill embed failed (${(e as Error).message}); ` +
              `leaving the rows un-embedded for the next run`,
          );
          embs = needBackfill.map(() => null);
        }
        for (let i = 0; i < needBackfill.length; i++) {
          const emb = embs[i];
          if (!emb) continue;
          try {
            await db.query(
              `UPDATE knowledge_predicate
                 SET embedding = $emb, updatedAt = time::now()
               WHERE predicateId = $pid`,
              { emb, pid: needBackfill[i].predicateId },
            );
          } catch (e) {
            this.logger.warn(
              `Backfill UPDATE failed for ${needBackfill[i].predicateId}: ${(e as Error).message}`,
            );
          }
        }
      }
    });
    this.bootstrapped.set(companyId, true);
  }

  /**
   * Per-tenant active-predicate snapshot, TTL-cached. The versionHash is a
   * stable digest of the active rows — extractor / chat-router pin it in
   * the trace so a downstream audit can correlate an extraction with the
   * exact registry state it was made against.
   */
  async getSnapshot(companyId: string): Promise<PredicateSnapshot> {
    await this.ensureBootstrap(companyId);
    const cached = this.cache.get(companyId);
    if (cached && Date.now() - cached.loadedAt < SNAPSHOT_TTL_MS) {
      return cached.snapshot;
    }
    const snapshot = await this.loadFresh(companyId);
    this.cache.set(companyId, { snapshot, loadedAt: Date.now() });
    return snapshot;
  }

  /**
   * Read the cached snapshot synchronously when one exists. Used by code
   * paths that are already inside an async chain where a previous
   * getSnapshot call has populated the cache for this tenant — avoids
   * threading async through every consumer (e.g. policyFor in tight
   * loops). Falls back to a sensible DEFAULT when the cache is cold.
   */
  policyFor(
    companyId: string,
    predicate: string,
  ): PredicateDefinition {
    const cached = this.cache.get(companyId);
    if (cached) {
      const hit = cached.snapshot.byId.get(predicate);
      if (hit) return hit;
    }
    // Fallback: CORE seed table by predicate id. Covers the case where the
    // tenant snapshot wasn't preloaded yet (early-boot search path) — the
    // policy reflects the code-side defaults until the cache populates.
    const seed = SEED_PREDICATES.find((p) => p.predicateId === predicate);
    return seed ?? DEFAULT_FALLBACK;
  }

  /** Invalidate cache for a tenant (called after admin edits). */
  invalidate(companyId: string): void {
    this.cache.delete(companyId);
  }

  // ── Admin CRUD ────────────────────────────────────────────────────────

  /**
   * List ALL predicates for a tenant — active + proposed + aliased +
   * deprecated. Operators reviewing the queue need the full picture.
   * Phase 2 of the registry; see Phase 2 in the file header.
   */
  async listAll(companyId: string): Promise<PredicateDefinition[]> {
    await this.ensureBootstrap(companyId);
    return this.surreal.withCompany(companyId, async (db) => {
      const [rows] = await db.query<[Array<Record<string, unknown>>]>(
        `SELECT * FROM knowledge_predicate ORDER BY status, predicateId`,
      );
      return ((rows as Array<Record<string, unknown>>) ?? []).map(
        (r) => deserializeFromRow(r),
      );
    });
  }

  async create(
    companyId: string,
    input: Partial<PredicateDefinition> & {
      predicateId: string;
      semantics: Semantics;
      piiClass: PiiClass;
    },
  ): Promise<PredicateDefinition> {
    await this.ensureBootstrap(companyId);
    const def: PredicateDefinition = {
      predicateId: input.predicateId,
      displayLabel:
        input.displayLabel ?? input.predicateId.replace(/_/g, ' '),
      description: input.description ?? '',
      datatype: input.datatype ?? 'string',
      semantics: input.semantics,
      decayHalfLifeDays: input.decayHalfLifeDays ?? null,
      piiClass: input.piiClass,
      ...(input.requiresScope ? { requiresScope: input.requiresScope } : {}),
      ...(input.parentPredicateId
        ? { parentPredicateId: input.parentPredicateId }
        : {}),
      ...(input.subjectClasses ? { subjectClasses: input.subjectClasses } : {}),
      ...(input.allowedValues ? { allowedValues: input.allowedValues } : {}),
      status: input.status ?? 'active',
      ...(input.aliasedTo ? { aliasedTo: input.aliasedTo } : {}),
      createdBy: input.createdBy ?? 'admin',
    };
    let embedding: number[] | null = null;
    try {
      embedding = await this.embedder.embed(embeddingTextFor(def));
    } catch (e) {
      this.logger.warn(
        `Failed to embed new predicate ${def.predicateId}: ${(e as Error).message}`,
      );
    }
    await this.surreal.withCompany(companyId, async (db) => {
      await db.query(`CREATE knowledge_predicate CONTENT $content`, {
        content: {
          ...serializeForInsert(def),
          ...(embedding ? { embedding } : {}),
        },
      });
    });
    this.invalidate(companyId);
    return def;
  }

  async update(
    companyId: string,
    predicateId: string,
    patch: Partial<
      Omit<PredicateDefinition, 'predicateId' | 'createdBy'>
    >,
  ): Promise<PredicateDefinition | null> {
    await this.ensureBootstrap(companyId);
    return this.surreal.withCompany(companyId, async (db) => {
      const [existingRows] = await db.query<[Array<Record<string, unknown>>]>(
        `SELECT * FROM knowledge_predicate WHERE predicateId = $pid LIMIT 1`,
        { pid: predicateId },
      );
      const existing = (existingRows as Array<Record<string, unknown>>) ?? [];
      if (existing.length === 0) return null;
      const current = deserializeFromRow(existing[0]);
      const next: PredicateDefinition = { ...current, ...patch };
      // Re-embed when text fields changed — keeps similarity search aligned
      // with operator-authored descriptions.
      let embedding: number[] | null = null;
      const textChanged =
        patch.description !== undefined ||
        patch.displayLabel !== undefined;
      if (textChanged) {
        try {
          embedding = await this.embedder.embed(embeddingTextFor(next));
        } catch (e) {
          this.logger.warn(
            `Failed to re-embed ${predicateId}: ${(e as Error).message}`,
          );
        }
      }
      const setFields: string[] = [];
      const params: Record<string, unknown> = { pid: predicateId };
      const addSet = (col: string, val: unknown, paramKey: string) => {
        setFields.push(`${col} = $${paramKey}`);
        params[paramKey] = val;
      };
      // For `option<...>` fields, JS null is rejected by SCHEMAFULL with
      // "Found NULL, expected option<...>" — the wire representation of
      // an unset option<> is NONE. Emit the literal NONE in the SET
      // clause instead of binding via parameter when the value is null.
      const addNullableSet = (col: string, val: unknown, paramKey: string) => {
        if (val === null || val === undefined) {
          setFields.push(`${col} = NONE`);
        } else {
          setFields.push(`${col} = $${paramKey}`);
          params[paramKey] = val;
        }
      };
      if (patch.displayLabel !== undefined)
        addSet('displayLabel', next.displayLabel, 'displayLabel');
      if (patch.description !== undefined)
        addSet('description', next.description, 'description');
      if (patch.datatype !== undefined)
        addSet('datatype', next.datatype, 'datatype');
      if (patch.semantics !== undefined)
        addSet('semantics', next.semantics, 'semantics');
      if (patch.decayHalfLifeDays !== undefined)
        addNullableSet(
          'decayHalfLifeDays',
          next.decayHalfLifeDays,
          'decayHalfLifeDays',
        );
      if (patch.piiClass !== undefined)
        addSet('piiClass', next.piiClass, 'piiClass');
      if (patch.requiresScope !== undefined)
        addNullableSet(
          'requiresScope',
          next.requiresScope,
          'requiresScope',
        );
      if (patch.status !== undefined)
        addSet('status', next.status, 'status');
      if (patch.aliasedTo !== undefined)
        addNullableSet('aliasedTo', next.aliasedTo, 'aliasedTo');
      if (embedding) addSet('embedding', embedding, 'embedding');
      if (setFields.length === 0) return current;
      setFields.push(`updatedAt = time::now()`);
      setFields.push(`version = version + 1`);
      await db.query(
        `UPDATE knowledge_predicate SET ${setFields.join(', ')} WHERE predicateId = $pid`,
        params,
      );
      this.invalidate(companyId);
      return next;
    });
  }

  /** Soft-delete — sets status='deprecated'. Existing facts retain the
   *  predicate id; new ingests no longer admit it (active set drops it). */
  async deprecate(
    companyId: string,
    predicateId: string,
  ): Promise<boolean> {
    const result = await this.update(companyId, predicateId, {
      status: 'deprecated',
    });
    return result !== null;
  }

  async promote(
    companyId: string,
    predicateId: string,
  ): Promise<PredicateDefinition | null> {
    return this.update(companyId, predicateId, { status: 'active' });
  }

  async alias(
    companyId: string,
    predicateId: string,
    canonicalId: string,
  ): Promise<PredicateDefinition | null> {
    return this.update(companyId, predicateId, {
      status: 'aliased',
      aliasedTo: canonicalId,
    });
  }

  private async loadFresh(
    companyId: string,
  ): Promise<PredicateSnapshot> {
    return this.surreal.withCompany(companyId, async (db) => {
      // We need ALL rows (not just active) so we can chain through
      // 'aliased' rows to their canonical id when a fact's predicate
      // points at an alias.
      const [rows] = await db.query<[Array<Record<string, unknown>>]>(
        `SELECT * FROM knowledge_predicate`,
      );
      const all = ((rows as Array<Record<string, unknown>>) ?? []).map(
        (r) => ({
          row: r,
          def: deserializeFromRow(r),
        }),
      );
      const active = all
        .filter(({ def }) => def.status === 'active')
        .map(({ def }) => def);
      const byId = new Map(active.map((p) => [p.predicateId, p]));

      // Build aliasMap: for each row, follow aliasedTo chains until we
      // land on an active predicate (or give up). Length-capped to defend
      // against accidental loops in the registry data.
      const aliasMap = new Map<string, string>();
      const allById = new Map(all.map(({ def }) => [def.predicateId, def]));
      const MAX_CHAIN = 8;
      for (const { def } of all) {
        let cursor: PredicateDefinition | undefined = def;
        let hops = 0;
        while (
          cursor &&
          cursor.status === 'aliased' &&
          cursor.aliasedTo &&
          hops < MAX_CHAIN
        ) {
          cursor = allById.get(cursor.aliasedTo);
          hops++;
        }
        if (cursor && cursor.status === 'active') {
          aliasMap.set(def.predicateId, cursor.predicateId);
        }
      }

      // Embedding lookup for active predicates only (no point matching
      // against deprecated rows). Skip any active row whose embedding
      // never got populated — they're harmless but invisible to
      // similarity search.
      const embeddings = new Map<string, number[]>();
      for (const { row, def } of all) {
        if (def.status !== 'active') continue;
        const emb = row.embedding;
        if (Array.isArray(emb) && emb.length > 0) {
          embeddings.set(def.predicateId, emb as number[]);
        }
      }

      const versionHash = computeHash(active);
      return { versionHash, active, byId, aliasMap, embeddings };
    });
  }

  /**
   * EDC canonicalization. Given a predicate the extractor emitted, return
   * the canonical predicateId the fact should be stored under, plus the
   * decision shape for the trace.
   *
   *   - 'matched'  — predicate is already active (or chains through an
   *                  alias to an active predicate). No write.
   *   - 'aliased'  — predicate is novel but similar enough to an existing
   *                  active predicate (cosine ≥ 0.85). Auto-INSERT a new
   *                  row with status='aliased', aliasedTo=canonical, so a
   *                  future occurrence skips the LLM and resolves
   *                  in-cache. Fact lands under the canonical id.
   *   - 'proposed' — predicate is novel and dissimilar from anything
   *                  active. INSERT as status='proposed' inheriting the
   *                  DEFAULT policy. Fact lands under the novel id. An
   *                  operator review queue can later promote / alias /
   *                  deprecate.
   *
   * The contextText is what we embed for similarity scoring — predicate
   * id + the clause / valueSpan that warranted this fact. That carries
   * far more signal than the predicate id alone ("hobby" alone is
   * ambiguous; "hobby: photography" is clearly preference-shaped).
   */
  async canonicalize(
    companyId: string,
    predicate: string,
    contextText: string,
  ): Promise<CanonicalizeDecision> {
    const snapshot = await this.getSnapshot(companyId);

    // Direct hit on an active predicate or a known alias chain.
    const aliasResolved = snapshot.aliasMap.get(predicate);
    if (aliasResolved && snapshot.byId.has(aliasResolved)) {
      return { kind: 'matched', canonicalId: aliasResolved };
    }
    if (snapshot.byId.has(predicate)) {
      return { kind: 'matched', canonicalId: predicate };
    }

    // EDC similarity search over active predicates' embeddings.
    let queryEmb: number[] | null = null;
    try {
      queryEmb = await this.embedder.embed(contextText);
    } catch (e) {
      this.logger.warn(
        `canonicalize: failed to embed novel predicate '${predicate}': ${(e as Error).message}`,
      );
    }

    let best: { predicateId: string; similarity: number } | undefined;
    if (queryEmb) {
      for (const [pid, emb] of snapshot.embeddings) {
        const sim = cosineSimilarity(queryEmb, emb);
        if (!best || sim > best.similarity) {
          best = { predicateId: pid, similarity: sim };
        }
      }
    }

    if (best && best.similarity >= this.canonicalizeThreshold) {
      // Insert as aliased — next time the same novel predicate appears,
      // the snapshot's aliasMap returns the canonical without an LLM
      // round-trip. Defensive: a concurrent canonicalize on the same
      // novel predicate races on UNIQUE(predicateId); the loser logs +
      // returns matched (next read will see the canonical anyway).
      try {
        const canonical = snapshot.byId.get(best!.predicateId)!;
        await this.surreal.withCompany(companyId, async (db) => {
          await db.query(`CREATE knowledge_predicate CONTENT $content`, {
            content: {
              predicateId: predicate,
              displayLabel: predicate.replace(/_/g, ' '),
              description: `(auto-aliased to ${best!.predicateId} at cosine ${best!.similarity.toFixed(3)})`,
              datatype: 'string',
              semantics: canonical.semantics,
              // option<int> — omit when null so SurrealDB stores NONE
              ...(canonical.decayHalfLifeDays !== null
                ? { decayHalfLifeDays: canonical.decayHalfLifeDays }
                : {}),
              piiClass: canonical.piiClass,
              ...(queryEmb ? { embedding: queryEmb } : {}),
              status: 'aliased',
              aliasedTo: best!.predicateId,
              createdBy: 'llm_auto',
            },
          });
        });
        this.invalidate(companyId);
      } catch (e) {
        this.logger.warn(
          `canonicalize: auto-alias insert failed for '${predicate}' → '${best!.predicateId}': ${(e as Error).message}`,
        );
      }
      return {
        kind: 'aliased',
        canonicalId: best.predicateId,
        similarity: best.similarity,
        novelPredicateId: predicate,
      };
    }

    // Below threshold — propose. Inherits DEFAULT policy until an
    // operator (or a future LLM-classify pass) sets the proper one.
    try {
      await this.surreal.withCompany(companyId, async (db) => {
        await db.query(`CREATE knowledge_predicate CONTENT $content`, {
          content: {
            predicateId: predicate,
            displayLabel: predicate.replace(/_/g, ' '),
            description: `(auto-proposed; awaiting review. Closest existing: ${
              best
                ? `${best.predicateId} @ cosine ${best.similarity.toFixed(3)}`
                : 'none'
            })`,
            datatype: 'string',
            semantics: DEFAULT_FALLBACK.semantics,
            // option<int> — omit when null so SurrealDB stores NONE
            ...(DEFAULT_FALLBACK.decayHalfLifeDays !== null
              ? { decayHalfLifeDays: DEFAULT_FALLBACK.decayHalfLifeDays }
              : {}),
            piiClass: DEFAULT_FALLBACK.piiClass,
            ...(queryEmb ? { embedding: queryEmb } : {}),
            status: 'proposed',
            createdBy: 'llm_auto',
          },
        });
      });
      this.invalidate(companyId);
    } catch (e) {
      this.logger.warn(
        `canonicalize: proposed insert failed for '${predicate}': ${(e as Error).message}`,
      );
    }
    return {
      kind: 'proposed',
      canonicalId: predicate,
      novelPredicateId: predicate,
      ...(best && best.similarity >= CANONICALIZE_REPORT_FLOOR
        ? { bestMatch: best }
        : {}),
    };
  }
}

