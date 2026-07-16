import type {
  ExtractionProfile,
  PredicateDefinition,
} from '../predicate-registry-internals/types';

export type { ExtractionProfile, ExtractionExample } from '../predicate-registry-internals/types';

/**
 * Domain Pack standard (docs/domain-packs.md).
 *
 * A DomainPack is a versioned, pluggable bundle of ontology that extends the
 * brain predicate registry without forking core. The community authors packs;
 * brain merges their predicates (namespaced) into every tenant's registry on
 * bootstrap. This file is the manifest CONTRACT — the schema third parties
 * conform to.
 *
 * Namespacing: every pack predicate is stored as `<packId>__<localId>` (double
 * underscore = the reserved separator). This keeps ids inside the existing
 * `^[a-z][a-z0-9_]*$` predicate-id charset (so admin CRUD + routing keep
 * working) and guarantees community packs can't collide with core or each
 * other. Core predicates are the reserved UNPREFIXED namespace and are never
 * renamed (that would orphan existing facts).
 */

/** Reserved namespace separator between packId and a predicate's localId. */
export const PACK_NAMESPACE_SEP = '__';

/** Per-document cap on a seed document's text. */
export const SEED_DOC_MAX_CHARS = 65_536;
/** Cap on all of a pack's seed documents' text combined. */
export const SEED_TOTAL_MAX_CHARS = 262_144;
/** Cap on how many seed documents a pack may ship. */
export const SEED_MAX_DOCS = 32;

/** Pre-populated knowledge shipped with a pack — ingested through the
 *  NORMAL document pipeline on install (kind='pack_seed'). Covered by
 *  checksum + signature like every other manifest section. */
export interface PackSeedDocument {
  localId: string;      // snake_case, unique within the pack
  title: string;
  text: string;         // <= SEED_DOC_MAX_CHARS; all docs together <= SEED_TOTAL_MAX_CHARS
  vertical: string;     // contextRef.vertical at ingest — author-declared, required
  originUri?: string;
  occurredAt?: string;  // ISO datetime -> derived facts' validFrom; default: ingest time
  meta?: Record<string, string | number | boolean>; // flat scalars only
}

/** A predicate as declared INSIDE a pack — a core PredicateDefinition minus the
 *  fully-qualified id (the loader composes it) and the provenance tag (the
 *  loader stamps it). The pack author supplies a `localId` instead. */
export type PackPredicate = Omit<
  PredicateDefinition,
  'predicateId' | 'createdBy'
> & { localId: string };

/** The versioned, self-describing pack manifest — the community standard.
 *  OpenAPI mirror: src/contracts/registry/registry.schema.ts
 *  (DomainPackManifestSchema) — keep in lockstep. */
export interface DomainPackManifest {
  /** snake_case pack id, no `__`. The predicate namespace. */
  id: string;
  /** semver MAJOR.MINOR.PATCH. Bump to ship an updated ontology. */
  version: string;
  /** One-line human description. */
  description: string;
  /** The ontology this pack contributes. */
  predicates: PackPredicate[];
  /**
   * Domain-specific extractor tuning (guidance + few-shot). CONSUMED at extract
   * time: a pack's profile is merged onto the tenant snapshot and injected into
   * the extractor system prompt (src/ai/predicate-registry.service loadFresh →
   * ExtractorLlmService.composeSystemPrompt). Advisory — never overrides the
   * verbatim rule or the strict output schema.
   */
  extractionProfile?: ExtractionProfile;
  /**
   * Domain eval fixtures (docs/domain-packs.md). CONSUMED at runtime: an
   * operator runs `POST /v1/admin/packs/:packId/eval` to score the live
   * extractor against these cases for a tenant. Typed as EvalFixture[].
   */
  evalFixtures?: import('./eval-fixture').EvalFixture[];
  /**
   * Pre-populated domain knowledge (see PackSeedDocument above). CONSUMED
   * on install: each document is fed through the normal document pipeline
   * (PACK_SEED_INGEST_ENABLED, via the pack_seed_ingest job), so seed
   * facts get the same provenance/dedup/conflict machinery as any ingest.
   */
  seedDocuments?: PackSeedDocument[];
  /** ed25519 signature (base64) over the canonical manifest sans this field. */
  signature?: string;
  /** Publisher id — the key in the tenant's trust store used to verify. */
  publisher?: string;
  /**
   * Indexer-layer execution descriptor (see IndexerDescriptor below).
   * Absent = 'virtual' — the pack rides the union extraction call.
   */
  indexer?: IndexerDescriptor;
  /**
   * MCP tools this pack contributes to the tenant's MCP surface (see
   * PackToolSpec below and docs/mcp-pack-tools.md). Max 8. Deliberately
   * NOT executable code: 'query' tools are declarative reads over the
   * pack's own predicates; 'external' tools are HMAC-signed HTTPS
   * proxies to the publisher's endpoint. Requires explicit operator
   * consent at install time (`acceptMcpTools`).
   */
  mcpTools?: PackToolSpec[];
}

/** Compose the stored, namespaced predicate id for a pack-local predicate. */
export function composePredicateId(packId: string, localId: string): string {
  return `${packId}${PACK_NAMESPACE_SEP}${localId}`;
}

/**
 * How a pack participates in document indexing (the Indexer layer).
 * Absent descriptor = 'virtual': the pack rides the single union
 * extraction call and its facts are attributed post-hoc by predicate
 * namespace — today's behavior, zero extra LLM cost. 'dedicated' opts the
 * pack into its OWN extraction run (own prompt budget / model /
 * self-consistency passes), gated per document by the relevance router.
 * 'external' declares a remote indexer that stages candidates via the
 * API instead of running in-process (the seam; enforcement server-side).
 *
 * The descriptor lives INSIDE the signed/checksummed manifest — signature
 * and version-immutability guarantees cover it with zero new machinery.
 */
export interface IndexerRelevance {
  /** Cheap substring triggers over the document head. */
  keywords?: string[];
  /** Subscribe to contextRef.vertical values ('meetings', 'crm', …). */
  verticals?: string[];
  /** Embedded and compared against the document head (router L2). */
  description?: string;
  /** Cosine gate for L2; default 0.30. */
  threshold?: number;
  /** Config-based subscription: bypass the router entirely. */
  alwaysRun?: boolean;
}

export interface IndexerDescriptor {
  mode?: 'virtual' | 'dedicated' | 'external';
  /** Routing triggers — consulted for dedicated/external modes only. */
  relevance?: IndexerRelevance;
  dedicated?: {
    /** Entity typing needs the core cards; default true. */
    includeCorePredicates?: boolean;
    /** Override OPENAI_CHAT_MODEL for this indexer's runs. */
    model?: string;
    /** Per-indexer self-consistency pass count. */
    scPasses?: number;
  };
  external?: {
    /** Trust-store key — reuses the existing ed25519 machinery. */
    publisher?: string;
    /** Optional push-notification target (HMAC-signed, later phase). */
    callbackUrl?: string;
  };
}

/**
 * Pack-declared MCP tools (docs/mcp-pack-tools.md). The specs live INSIDE
 * the signed/checksummed manifest, so signature and version-immutability
 * cover them with zero new machinery. Registered tool names are
 * namespaced `<packId>__<name>` — same separator discipline as
 * predicates, so packs can't collide with core tools or each other.
 *
 * Settled product decision: NO in-process third-party code. A pack tool
 * is either a declarative query over tenant knowledge ('query') or an
 * HMAC-signed HTTPS proxy to the publisher's own endpoint ('external').
 */

/** One declared parameter of an external pack tool. */
export interface PackToolParam {
  /** snake_case name, `^[a-z][a-z0-9_]{0,30}$`, no `__`. */
  name: string;
  type: 'string' | 'number' | 'boolean';
  /** Shown to the calling agent — sanitized + capped at 200 chars. */
  description?: string;
  required?: boolean;
  /** string type only; ≤ 20 items, each ≤ 60 chars. */
  enum?: string[];
  /** string type only; 1..2000. */
  maxLength?: number;
}

/** Declarative read over the tenant's knowledge, scoped to the pack's
 *  own (namespaced) predicates. The server computes the predicate set —
 *  a pack can never widen a tool onto core or another pack's vocabulary. */
export interface PackQueryToolSpec {
  kind: 'query';
  /** `^[a-z][a-z0-9_]{1,40}$`, no `__`; registered as `<packId>__<name>`. */
  name: string;
  /** ≤ 80 chars (sanitized). */
  title?: string;
  /** ≤ 500 chars (sanitized, server preamble prepended). */
  description: string;
  query: {
    surface: 'search' | 'facts_by_predicate';
    /** localIds — MUST exist in pack.predicates. REQUIRED for
     *  facts_by_predicate; absent on search = ALL pack predicates. */
    predicates?: string[];
    /** 1..20. */
    defaultLimit?: number;
    /** 0..1, search surface only. */
    minConfidence?: number;
  };
}

/** HTTPS-proxied tool: Brain POSTs the call (HMAC-signed with the pack's
 *  install webhook secret) to the publisher-operated endpoint. The tenant
 *  is identified by the opaque per-install `installId`, never companyId. */
export interface PackExternalToolSpec {
  kind: 'external';
  name: string;
  title?: string;
  description: string;
  /** ≤ 8 params. */
  params?: PackToolParam[];
  /** https URL (egress-guarded at install AND per call). */
  endpoint: string;
  /** default 10_000, range [1_000, 30_000]. */
  timeoutMs?: number;
}

export type PackToolSpec = PackQueryToolSpec | PackExternalToolSpec;
