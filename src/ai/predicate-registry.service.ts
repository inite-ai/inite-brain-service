import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { SurrealService } from '../db/surreal.service';
import { EmbedderService } from './embedder.service';

/**
 * Per-tenant predicate ontology registry.
 *
 * What used to be a hardcoded PREDICATE_VOCABULARY + PREDICATE_POLICIES table
 * in TypeScript is now a SurrealDB row-set, scoped per tenant. The TS-side
 * CORE_PREDICATES below is the BOOTSTRAP source — it seeds each tenant DB on
 * first read (idempotent INSERT-if-absent), so adding a new core predicate
 * via code change still flows in. Operators can introduce tenant-specific
 * predicates directly via the registry without touching code.
 *
 * The runtime read path uses a per-tenant TTL cache with a versionHash
 * computed from the active row-set. Extractor / chat-router pin the
 * versionHash into the trace so the JSON-schema enum they generated is
 * traceable to a known registry state.
 *
 * References:
 *   - Zep `set_ontology` per-graph API
 *   - mem0 `custom_categories` project-level override
 *   - Wikidata property catalog (properties are entities with constraint
 *     statements; SHACL-validated)
 *   - Cognee RDF/OWL ontology files
 *   - EDC (Extract-Define-Canonicalise, arXiv:2404.03868) for the
 *     LLM-auto-classify path (Phase 2 — not implemented in this MVP).
 *
 * Phase 2 (deferred): tenant overlay-on-core, admin CRUD UI, LLM
 * auto-classification of novel predicates with embedding similarity merge,
 * aliasing of equivalent predicates.
 */

export type Semantics = 'append_only' | 'single_active' | 'bitemporal';
export type PiiClass =
  | 'none'
  | 'identifier'
  | 'behavioral'
  | 'text'
  | 'sensitive';
export type PredicateStatus = 'active' | 'proposed' | 'aliased' | 'deprecated';

export interface PredicateDefinition {
  predicateId: string;
  displayLabel: string;
  /**
   * Multi-line description fed to the extractor's system prompt as a
   * predicate "card". Should encode TYPE / ADMIT / NOT FOR / VALUE
   * (see DEFAULT_EXTRACTION_PROMPT header) — operators editing this
   * field directly tune extractor behaviour without code changes.
   */
  description: string;
  /** Storage datatype the value should conform to (string default). */
  datatype: 'string' | 'number' | 'date' | 'datetime' | 'enum' | 'json';
  semantics: Semantics;
  decayHalfLifeDays: number | null;
  piiClass: PiiClass;
  requiresScope?: string;
  parentPredicateId?: string;
  subjectClasses?: string[];
  allowedValues?: string[];
  status: PredicateStatus;
  aliasedTo?: string;
  createdBy: 'system' | 'admin' | 'llm_auto' | 'migration';
}

export interface PredicateSnapshot {
  /** Stable hash of the active-row-set; pinned to extractor traces. */
  versionHash: string;
  /** All predicates with status='active'. */
  active: PredicateDefinition[];
  /** Quick lookup by predicateId (active only). */
  byId: Map<string, PredicateDefinition>;
  /** Resolved aliases. Maps any (aliased / active / proposed) predicate
   *  id to its CANONICAL active predicate id by following aliasedTo
   *  chains. Drives canonicalize() and read-time predicate normalization. */
  aliasMap: Map<string, string>;
  /** Embedding lookup for active predicates — drives EDC similarity search
   *  on canonicalize(). Predicates without an embedding are skipped during
   *  similarity scoring (older rows from before 0012 migration). */
  embeddings: Map<string, number[]>;
}

export type CanonicalizeDecision =
  | { kind: 'matched'; canonicalId: string }
  | {
      kind: 'aliased';
      canonicalId: string;
      similarity: number;
      novelPredicateId: string;
    }
  | {
      kind: 'proposed';
      canonicalId: string;
      novelPredicateId: string;
      bestMatch?: { predicateId: string; similarity: number };
    };

const SNAPSHOT_TTL_MS = 60_000;
/** EDC similarity threshold for auto-alias. Above → alias the novel
 *  predicate to the existing canonical id. Below → INSERT as proposed
 *  for human/agent review. Threshold chosen per Mem0g / EDC paper
 *  recommendations (0.85 is conservative; rare false-merges). */
const CANONICALIZE_AUTO_ALIAS_THRESHOLD = 0.85;
/** Floor for "any meaningful match" — used purely to report bestMatch on
 *  the proposed outcome so an operator reviewing the queue sees what the
 *  closest existing predicate was. */
const CANONICALIZE_REPORT_FLOOR = 0.6;
const DEFAULT_FALLBACK: PredicateDefinition = {
  predicateId: '__default__',
  displayLabel: 'default',
  description: 'Synthesised fallback when a predicate is not in the registry.',
  datatype: 'string',
  semantics: 'bitemporal',
  decayHalfLifeDays: 60,
  piiClass: 'none',
  status: 'active',
  createdBy: 'system',
};

/**
 * Bootstrap seed — the canonical set of predicates inserted into a tenant
 * on first access. Treat as the equivalent of an OWL ontology file: shape +
 * policy + description live together, version-controlled with the code.
 *
 * Adding a new core predicate:
 *   1. Append an entry below.
 *   2. Redeploy. On next ingest in any tenant, the new row is INSERTed by
 *      ensureBootstrap. Existing predicates are NOT touched (so admin
 *      overrides survive redeploys).
 *
 * The description field is the system-prompt card for the extractor —
 * it's how the LLM knows when to admit this predicate.
 */
export const CORE_PREDICATES: PredicateDefinition[] = [
  // ── EVENT / utterance ────────────────────────────────────────────────
  {
    predicateId: 'said',
    displayLabel: 'said',
    description: `TYPE   subject is anyone; value is an attributed utterance
ADMIT  text directly attributes an utterance to the subject AND no more
       specific predicate (intent / complained_about / preference) admits
       the clause. Fallback predicate — prefer specifics.
VALUE  the utterance span (may be a quoted string)`,
    datatype: 'string',
    semantics: 'append_only',
    decayHalfLifeDays: 30,
    piiClass: 'text',
    status: 'active',
    createdBy: 'system',
  },

  // ── IDENTITY (functional, lifetime-stable) ───────────────────────────
  {
    predicateId: 'name',
    displayLabel: 'name',
    description: `TYPE   subject is any entity; value is the proper noun naming it
ADMIT  text introduces or names the entity (proper noun, not pronoun)
NOT FOR a pronoun reference alone — skip the fact
VALUE  the proper-noun span from the input`,
    datatype: 'string',
    semantics: 'single_active',
    decayHalfLifeDays: null,
    piiClass: 'identifier',
    status: 'active',
    createdBy: 'system',
  },
  {
    predicateId: 'email',
    displayLabel: 'email',
    description: `TYPE   subject is a person/org; value is an email address
ADMIT  a literal email address appears, attributed to this subject
VALUE  the literal email-address span`,
    datatype: 'string',
    semantics: 'single_active',
    decayHalfLifeDays: null,
    piiClass: 'identifier',
    status: 'active',
    createdBy: 'system',
  },
  {
    predicateId: 'phone',
    displayLabel: 'phone',
    description: `TYPE   subject is a person/org; value is a phone number
ADMIT  a literal phone-number span appears, attributed to this subject
VALUE  the literal phone-number span`,
    datatype: 'string',
    semantics: 'single_active',
    decayHalfLifeDays: null,
    piiClass: 'identifier',
    status: 'active',
    createdBy: 'system',
  },
  {
    predicateId: 'dob',
    displayLabel: 'date of birth',
    description: `TYPE   subject is a person; value is a date of birth
ADMIT  text states when the subject was born
VALUE  the date span from the input`,
    datatype: 'date',
    semantics: 'single_active',
    decayHalfLifeDays: null,
    piiClass: 'sensitive',
    requiresScope: 'brain:read_pii',
    status: 'active',
    createdBy: 'system',
  },

  // ── SINGLE-STATE (functional, time-varying) ──────────────────────────
  {
    predicateId: 'status',
    displayLabel: 'status',
    description: `TYPE   subject is any entity; value is a current role / lifecycle stage / membership label
ADMIT  text asserts a current role or lifecycle state
NOT FOR a future plan to acquire a role → intent
       a one-off action → interacted_with
VALUE  the noun naming the role/state — VERBATIM from input, never substituted`,
    datatype: 'string',
    semantics: 'single_active',
    decayHalfLifeDays: 7,
    piiClass: 'none',
    status: 'active',
    createdBy: 'system',
  },
  {
    predicateId: 'tier',
    displayLabel: 'tier',
    description: `TYPE   subject is a customer/account; value is a segmentation tier label
ADMIT  text assigns a segmentation tier
NOT FOR a generic state → status
VALUE  the tier-label span from input`,
    datatype: 'string',
    semantics: 'single_active',
    decayHalfLifeDays: 30,
    piiClass: 'none',
    status: 'active',
    createdBy: 'system',
  },
  {
    predicateId: 'address',
    displayLabel: 'address',
    description: `TYPE   subject is a person/org; value is a physical location
ADMIT  text states where the subject is, lives, is based, is located,
       or moved from/to as a place of residence/operation
NOT FOR a one-off visit → interacted_with
       a brand's target market → target_audience_segment
VALUE  the place-name or address span from the input`,
    datatype: 'string',
    semantics: 'single_active',
    decayHalfLifeDays: 90,
    piiClass: 'sensitive',
    requiresScope: 'brain:read_pii',
    status: 'active',
    createdBy: 'system',
  },

  // ── BEHAVIORAL history (append-only, decay-weighted) ─────────────────
  {
    predicateId: 'preference',
    displayLabel: 'preference',
    description: `TYPE   subject is a person/customer; value is a thing/style/category preferred or disliked
ADMIT  text asserts a STABLE like / dislike / favourite (ongoing taste)
NOT FOR a forward-looking plan → intent
       a one-off action → interacted_with
       a complaint → complained_about
VALUE  ONLY the noun phrase naming the preferred thing — strip the verb`,
    datatype: 'string',
    semantics: 'append_only',
    decayHalfLifeDays: 90,
    piiClass: 'behavioral',
    status: 'active',
    createdBy: 'system',
  },
  {
    predicateId: 'intent',
    displayLabel: 'intent',
    description: `TYPE   subject is a person/customer; value is a forward-looking plan, wish, or need
ADMIT  text asserts a future-tense plan, wish, or stated need
NOT FOR a stable taste → preference
       a completed action → interacted_with
       a current role → status
VALUE  the noun phrase or verb-phrase naming the planned thing or goal`,
    datatype: 'string',
    semantics: 'append_only',
    decayHalfLifeDays: 60,
    piiClass: 'behavioral',
    status: 'active',
    createdBy: 'system',
  },
  {
    predicateId: 'complained_about',
    displayLabel: 'complained about',
    description: `TYPE   subject is a person/customer; value is the subject of a complaint
ADMIT  text reports a complaint, dissatisfaction, or problem report
NOT FOR a generic mention without negative sentiment → interacted_with
VALUE  the noun phrase naming the thing/topic complained about`,
    datatype: 'string',
    semantics: 'append_only',
    decayHalfLifeDays: 90,
    piiClass: 'text',
    status: 'active',
    createdBy: 'system',
  },
  {
    predicateId: 'interacted_with',
    displayLabel: 'interacted with',
    description: `TYPE   subject is a person/customer; value is a thing they touched
ADMIT  text states a one-off generic interaction (booked, viewed,
       contacted, attended, purchased, downloaded) without complaint,
       not as a long-term preference, not as a future plan
VALUE  the noun phrase naming the thing interacted with`,
    datatype: 'string',
    semantics: 'append_only',
    decayHalfLifeDays: 30,
    piiClass: 'behavioral',
    status: 'active',
    createdBy: 'system',
  },

  // ── CONTENT-DOMAIN (singleton brand voice + multi-valued editorial) ──
  {
    predicateId: 'brand_voice',
    displayLabel: 'brand voice',
    description: `TYPE   subject is a brand; value is how it sounds (≤500 chars)
ADMIT  text describes the brand's voice style holistically
VALUE  the full style description as one fact (singleton — most recent wins)`,
    datatype: 'string',
    semantics: 'single_active',
    decayHalfLifeDays: 180,
    piiClass: 'none',
    status: 'active',
    createdBy: 'system',
  },
  {
    predicateId: 'brand_archetype',
    displayLabel: 'brand archetype',
    description: `TYPE   subject is a brand; value is a Jungian archetype label
ADMIT  text labels the brand with an archetype (Hero/Sage/Outlaw/Explorer/
       Magician/Lover/Jester/Caregiver/Creator/Ruler/Innocent/Everyman)
VALUE  the archetype label span`,
    datatype: 'enum',
    semantics: 'single_active',
    decayHalfLifeDays: null,
    piiClass: 'none',
    allowedValues: [
      'Hero',
      'Sage',
      'Outlaw',
      'Explorer',
      'Magician',
      'Lover',
      'Jester',
      'Caregiver',
      'Creator',
      'Ruler',
      'Innocent',
      'Everyman',
    ],
    status: 'active',
    createdBy: 'system',
  },
  {
    predicateId: 'tone_of_voice',
    displayLabel: 'tone of voice',
    description: `TYPE   subject is a brand; value is style attributes (≤500 chars)
ADMIT  text describes tonality / style descriptors
VALUE  the descriptor span (singleton — most recent wins)`,
    datatype: 'string',
    semantics: 'single_active',
    decayHalfLifeDays: 180,
    piiClass: 'none',
    status: 'active',
    createdBy: 'system',
  },
  {
    predicateId: 'product_description',
    displayLabel: 'product description',
    description: `TYPE   subject is a product/brand; value is a short product summary (≤1000 chars)
ADMIT  text describes what the product IS
VALUE  the description span (singleton — most recent wins)`,
    datatype: 'string',
    semantics: 'single_active',
    decayHalfLifeDays: 180,
    piiClass: 'none',
    status: 'active',
    createdBy: 'system',
  },
  {
    predicateId: 'target_audience_segment',
    displayLabel: 'target audience segment',
    description: `TYPE   subject is a brand; value is one segment description
ADMIT  text identifies an audience segment the brand targets
VALUE  one segment per fact (multi-valued — each distinct segment is its own fact)`,
    datatype: 'string',
    semantics: 'append_only',
    decayHalfLifeDays: 90,
    piiClass: 'none',
    status: 'active',
    createdBy: 'system',
  },
  {
    predicateId: 'content_guideline',
    displayLabel: 'content guideline',
    description: `TYPE   subject is a brand; value is one editorial rule
ADMIT  text states an editorial guideline
VALUE  one rule per fact (multi-valued)`,
    datatype: 'string',
    semantics: 'append_only',
    decayHalfLifeDays: 365,
    piiClass: 'none',
    status: 'active',
    createdBy: 'system',
  },
  {
    predicateId: 'tension_point',
    displayLabel: 'tension point',
    description: `TYPE   subject is a brand; value is one customer pain or contradiction
ADMIT  text identifies an audience pain the content addresses
VALUE  one tension per fact (multi-valued)`,
    datatype: 'string',
    semantics: 'append_only',
    decayHalfLifeDays: 90,
    piiClass: 'none',
    status: 'active',
    createdBy: 'system',
  },
  {
    predicateId: 'reference_example',
    displayLabel: 'reference example',
    description: `TYPE   subject is a brand; value is one URL or exemplar quote
ADMIT  text references a piece of content as an exemplar
VALUE  one URL/quote per fact (multi-valued)`,
    datatype: 'string',
    semantics: 'append_only',
    decayHalfLifeDays: null,
    piiClass: 'none',
    status: 'active',
    createdBy: 'system',
  },
  {
    predicateId: 'narrative_pillar',
    displayLabel: 'narrative pillar',
    description: `TYPE   subject is a brand; value is one recurring theme
ADMIT  text identifies a theme the brand returns to
VALUE  one theme per fact (multi-valued)`,
    datatype: 'string',
    semantics: 'append_only',
    decayHalfLifeDays: 365,
    piiClass: 'none',
    status: 'active',
    createdBy: 'system',
  },
  {
    predicateId: 'forbidden_pattern',
    displayLabel: 'forbidden pattern',
    description: `TYPE   subject is a brand; value is one anti-pattern
ADMIT  text states something the brand must NOT do/say
VALUE  one anti-pattern per fact (multi-valued)`,
    datatype: 'string',
    semantics: 'append_only',
    decayHalfLifeDays: null,
    piiClass: 'none',
    status: 'active',
    createdBy: 'system',
  },
];

@Injectable()
export class PredicateRegistryService {
  private readonly logger = new Logger(PredicateRegistryService.name);
  /** Per-tenant snapshot cache. Keyed by companyId. */
  private readonly cache = new Map<
    string,
    { snapshot: PredicateSnapshot; loadedAt: number }
  >();
  /** Per-tenant bootstrap flag — ensureBootstrap runs once per process per tenant. */
  private readonly bootstrapped = new Set<string>();

  constructor(
    private readonly surreal: SurrealService,
    private readonly embedder: EmbedderService,
  ) {}

  /**
   * Idempotently INSERT every CORE_PREDICATE that isn't already in the
   * tenant's knowledge_predicate table. Pre-existing rows are NOT touched
   * (operator overrides + admin-added predicates survive bootstrap).
   * Called lazily on first registry read per tenant per process.
   */
  private async ensureBootstrap(companyId: string): Promise<void> {
    if (this.bootstrapped.has(companyId)) return;
    await this.surreal.withCompany(companyId, async (db) => {
      const [existingRows] = await db.query<
        [Array<{ predicateId: string; embedding?: number[] | null }>]
      >(`SELECT predicateId, embedding FROM knowledge_predicate`);
      const existing = (existingRows as Array<{
        predicateId: string;
        embedding?: number[] | null;
      }>) ?? [];
      const existingIds = new Set(existing.map((r) => r.predicateId));
      const missing = CORE_PREDICATES.filter(
        (p) => !existingIds.has(p.predicateId),
      );
      if (missing.length > 0) {
        this.logger.log(
          `Seeding ${missing.length} core predicate(s) into ${companyId}: ` +
            missing.map((p) => p.predicateId).join(', '),
        );
        // Embed the predicate "card" (id + description) so EDC similarity
        // search has something to match against. Done at bootstrap so
        // first-extraction latency stays predictable.
        const embeddings = await Promise.all(
          missing.map((p) =>
            this.embedder.embed(embeddingTextFor(p)).catch((e) => {
              this.logger.warn(
                `Failed to embed predicate ${p.predicateId}: ${(e as Error).message}`,
              );
              return null;
            }),
          ),
        );
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
        for (const row of needBackfill) {
          const seed = CORE_PREDICATES.find(
            (p) => p.predicateId === row.predicateId,
          );
          // Use seed description when available; otherwise fall back to the
          // bare predicateId so similarity at least lands on the lexical
          // surface form.
          const text = seed
            ? embeddingTextFor(seed)
            : row.predicateId.replace(/_/g, ' ');
          try {
            const emb = await this.embedder.embed(text);
            await db.query(
              `UPDATE knowledge_predicate
                 SET embedding = $emb, updatedAt = time::now()
               WHERE predicateId = $pid`,
              { emb, pid: row.predicateId },
            );
          } catch (e) {
            this.logger.warn(
              `Skipped embedding backfill for ${row.predicateId}: ${(e as Error).message}`,
            );
          }
        }
      }
    });
    this.bootstrapped.add(companyId);
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
    const seed = CORE_PREDICATES.find((p) => p.predicateId === predicate);
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
      if (patch.displayLabel !== undefined)
        addSet('displayLabel', next.displayLabel, 'displayLabel');
      if (patch.description !== undefined)
        addSet('description', next.description, 'description');
      if (patch.datatype !== undefined)
        addSet('datatype', next.datatype, 'datatype');
      if (patch.semantics !== undefined)
        addSet('semantics', next.semantics, 'semantics');
      if (patch.decayHalfLifeDays !== undefined)
        addSet(
          'decayHalfLifeDays',
          next.decayHalfLifeDays,
          'decayHalfLifeDays',
        );
      if (patch.piiClass !== undefined)
        addSet('piiClass', next.piiClass, 'piiClass');
      if (patch.requiresScope !== undefined)
        addSet(
          'requiresScope',
          next.requiresScope ?? null,
          'requiresScope',
        );
      if (patch.status !== undefined)
        addSet('status', next.status, 'status');
      if (patch.aliasedTo !== undefined)
        addSet('aliasedTo', next.aliasedTo ?? null, 'aliasedTo');
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

    if (best && best.similarity >= CANONICALIZE_AUTO_ALIAS_THRESHOLD) {
      // Insert as aliased — next time the same novel predicate appears,
      // the snapshot's aliasMap returns the canonical without an LLM
      // round-trip.
      await this.surreal.withCompany(companyId, async (db) => {
        await db.query(`CREATE knowledge_predicate CONTENT $content`, {
          content: {
            predicateId: predicate,
            displayLabel: predicate.replace(/_/g, ' '),
            description: `(auto-aliased to ${best!.predicateId} at cosine ${best!.similarity.toFixed(3)})`,
            datatype: 'string',
            semantics: snapshot.byId.get(best!.predicateId)!.semantics,
            decayHalfLifeDays:
              snapshot.byId.get(best!.predicateId)!.decayHalfLifeDays,
            piiClass: snapshot.byId.get(best!.predicateId)!.piiClass,
            ...(queryEmb ? { embedding: queryEmb } : {}),
            status: 'aliased',
            aliasedTo: best!.predicateId,
            createdBy: 'llm_auto',
          },
        });
      });
      this.invalidate(companyId);
      return {
        kind: 'aliased',
        canonicalId: best.predicateId,
        similarity: best.similarity,
        novelPredicateId: predicate,
      };
    }

    // Below threshold — propose. Inherits DEFAULT policy until an
    // operator (or a future LLM-classify pass) sets the proper one.
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
          decayHalfLifeDays: DEFAULT_FALLBACK.decayHalfLifeDays,
          piiClass: DEFAULT_FALLBACK.piiClass,
          ...(queryEmb ? { embedding: queryEmb } : {}),
          status: 'proposed',
          createdBy: 'llm_auto',
        },
      });
    });
    this.invalidate(companyId);
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

function serializeForInsert(
  p: PredicateDefinition,
): Record<string, unknown> {
  return {
    predicateId: p.predicateId,
    displayLabel: p.displayLabel,
    description: p.description,
    datatype: p.datatype,
    semantics: p.semantics,
    decayHalfLifeDays: p.decayHalfLifeDays,
    piiClass: p.piiClass,
    ...(p.requiresScope ? { requiresScope: p.requiresScope } : {}),
    ...(p.parentPredicateId
      ? { parentPredicateId: p.parentPredicateId }
      : {}),
    ...(p.subjectClasses ? { subjectClasses: p.subjectClasses } : {}),
    ...(p.allowedValues ? { allowedValues: p.allowedValues } : {}),
    status: p.status,
    ...(p.aliasedTo ? { aliasedTo: p.aliasedTo } : {}),
    createdBy: p.createdBy,
  };
}

function deserializeFromRow(row: Record<string, unknown>): PredicateDefinition {
  return {
    predicateId: String(row.predicateId),
    displayLabel: String(row.displayLabel ?? row.predicateId),
    description: String(row.description ?? ''),
    datatype: (row.datatype as PredicateDefinition['datatype']) ?? 'string',
    semantics: row.semantics as Semantics,
    decayHalfLifeDays:
      typeof row.decayHalfLifeDays === 'number'
        ? row.decayHalfLifeDays
        : null,
    piiClass: row.piiClass as PiiClass,
    ...(row.requiresScope
      ? { requiresScope: String(row.requiresScope) }
      : {}),
    ...(row.parentPredicateId
      ? { parentPredicateId: String(row.parentPredicateId) }
      : {}),
    ...(Array.isArray(row.subjectClasses)
      ? { subjectClasses: row.subjectClasses as string[] }
      : {}),
    ...(Array.isArray(row.allowedValues)
      ? { allowedValues: row.allowedValues as string[] }
      : {}),
    status: (row.status as PredicateStatus) ?? 'active',
    ...(row.aliasedTo ? { aliasedTo: String(row.aliasedTo) } : {}),
    createdBy:
      (row.createdBy as PredicateDefinition['createdBy']) ?? 'system',
  };
}

function embeddingTextFor(p: PredicateDefinition): string {
  // What we embed for similarity search. predicate id (lexical surface)
  // plus the description (semantic content). Description carries the
  // bulk of the signal — "preference: TYPE behavioral... ADMIT stable
  // taste..." matches "hobby: enjoys photography" much better than the
  // bare id "preference" alone.
  return `${p.predicateId.replace(/_/g, ' ')}: ${p.description}`;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

function computeHash(rows: PredicateDefinition[]): string {
  const sorted = [...rows].sort((a, b) =>
    a.predicateId.localeCompare(b.predicateId),
  );
  const payload = sorted
    .map(
      (p) =>
        `${p.predicateId}|${p.semantics}|${p.decayHalfLifeDays}|${p.piiClass}|${p.requiresScope ?? ''}|${p.status}`,
    )
    .join('\n');
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}
