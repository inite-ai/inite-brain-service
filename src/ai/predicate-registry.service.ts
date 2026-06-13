import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { SurrealService } from '../db/surreal.service';

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
}

const SNAPSHOT_TTL_MS = 60_000;
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

  constructor(private readonly surreal: SurrealService) {}

  /**
   * Idempotently INSERT every CORE_PREDICATE that isn't already in the
   * tenant's knowledge_predicate table. Pre-existing rows are NOT touched
   * (operator overrides + admin-added predicates survive bootstrap).
   * Called lazily on first registry read per tenant per process.
   */
  private async ensureBootstrap(companyId: string): Promise<void> {
    if (this.bootstrapped.has(companyId)) return;
    await this.surreal.withCompany(companyId, async (db) => {
      const [existingRows] = await db.query<[Array<{ predicateId: string }>]>(
        `SELECT predicateId FROM knowledge_predicate`,
      );
      const existing = new Set(
        ((existingRows as Array<{ predicateId: string }>) ?? []).map(
          (r) => r.predicateId,
        ),
      );
      const missing = CORE_PREDICATES.filter(
        (p) => !existing.has(p.predicateId),
      );
      if (missing.length === 0) return;
      this.logger.log(
        `Seeding ${missing.length} core predicate(s) into ${companyId}: ` +
          missing.map((p) => p.predicateId).join(', '),
      );
      for (const p of missing) {
        await db.query(
          `CREATE knowledge_predicate CONTENT $content`,
          { content: serializeForInsert(p) },
        );
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

  private async loadFresh(
    companyId: string,
  ): Promise<PredicateSnapshot> {
    return this.surreal.withCompany(companyId, async (db) => {
      const [rows] = await db.query<[Array<Record<string, unknown>>]>(
        `SELECT * FROM knowledge_predicate WHERE status = 'active'`,
      );
      const active = ((rows as Array<Record<string, unknown>>) ?? []).map(
        (r) => deserializeFromRow(r),
      );
      const byId = new Map(active.map((p) => [p.predicateId, p]));
      const versionHash = computeHash(active);
      return { versionHash, active, byId };
    });
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
