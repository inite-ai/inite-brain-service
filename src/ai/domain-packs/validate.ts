import type { PredicateDefinition } from '../predicate-registry-internals/types';
import {
  composePredicateId,
  PACK_NAMESPACE_SEP,
  SEED_DOC_MAX_CHARS,
  SEED_MAX_DOCS,
  SEED_TOTAL_MAX_CHARS,
  type DomainPackManifest,
  type PackToolParam,
} from './manifest';

/**
 * Validation + assembly for the Domain Pack standard. `validatePack` is what a
 * community author runs (also exposed via `pnpm pack:validate`); `assembleSeed`
 * is what the predicate registry runs to merge packs into the bootstrap seed,
 * failing loudly on any id collision rather than silently shadowing.
 */

const SNAKE = /^[a-z][a-z0-9_]*$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
// Mirror the DB-level ASSERTs (0011_predicate_registry). validatePack runs
// BEFORE the domain_pack row is written and predicates are seeded, so an
// invalid enum here would otherwise surface as a raw Surreal ASSERT error
// (HTTP 500 + a half-installed pack) rather than a clean 400.
const SEMANTICS = new Set(['append_only', 'single_active', 'bitemporal']);
const PII_CLASSES = new Set([
  'none',
  'identifier',
  'behavioral',
  'text',
  'sensitive',
]);
const DATATYPES = new Set([
  'string',
  'number',
  'date',
  'datetime',
  'enum',
  'json',
]);

export class DomainPackError extends Error {}

export function validatePack(pack: DomainPackManifest): void {
  if (!SNAKE.test(pack.id) || pack.id.includes(PACK_NAMESPACE_SEP)) {
    throw new DomainPackError(
      `pack id "${pack.id}" must be snake_case and must not contain "${PACK_NAMESPACE_SEP}"`,
    );
  }
  // A trailing underscore lets `foo_`'s composed prefix (`foo___`) collide
  // with `foo`'s uninstall prefix (`foo__`) — reject it up front.
  if (pack.id.endsWith('_')) {
    throw new DomainPackError(
      `pack id "${pack.id}" must not end with an underscore`,
    );
  }
  if (!SEMVER.test(pack.version)) {
    throw new DomainPackError(
      `pack "${pack.id}" version "${pack.version}" must be semver MAJOR.MINOR.PATCH`,
    );
  }
  if (!Array.isArray(pack.predicates)) {
    throw new DomainPackError(`pack "${pack.id}" predicates must be an array`);
  }
  if (pack.predicates.length === 0) {
    throw new DomainPackError(`pack "${pack.id}" declares no predicates`);
  }
  const seen = new Set<string>();
  for (const p of pack.predicates) {
    if (p === null || typeof p !== 'object') {
      throw new DomainPackError(`pack "${pack.id}" predicate entries must be objects`);
    }
    if (!SNAKE.test(p.localId) || p.localId.includes(PACK_NAMESPACE_SEP)) {
      throw new DomainPackError(
        `pack "${pack.id}" localId "${p.localId}" must be snake_case and must not contain "${PACK_NAMESPACE_SEP}"`,
      );
    }
    if (seen.has(p.localId)) {
      throw new DomainPackError(
        `pack "${pack.id}" declares duplicate localId "${p.localId}"`,
      );
    }
    seen.add(p.localId);
    if (!SEMANTICS.has(p.semantics as string)) {
      throw new DomainPackError(
        `pack "${pack.id}" predicate "${p.localId}" semantics "${p.semantics}" must be one of ${[...SEMANTICS].join('|')}`,
      );
    }
    if (!PII_CLASSES.has(p.piiClass as string)) {
      throw new DomainPackError(
        `pack "${pack.id}" predicate "${p.localId}" piiClass "${p.piiClass}" must be one of ${[...PII_CLASSES].join('|')}`,
      );
    }
    if (p.datatype !== undefined && !DATATYPES.has(p.datatype as string)) {
      throw new DomainPackError(
        `pack "${pack.id}" predicate "${p.localId}" datatype "${p.datatype}" must be one of ${[...DATATYPES].join('|')}`,
      );
    }
  }
  if (pack.extractionProfile !== undefined) {
    validateExtractionProfile(pack.id, pack.extractionProfile);
  }
  if (pack.evalFixtures !== undefined) {
    validateEvalFixtures(pack.id, pack.evalFixtures);
  }
  if (pack.seedDocuments !== undefined) {
    validateSeedDocuments(pack.id, pack.seedDocuments);
  }
  if (pack.indexer !== undefined) {
    validateIndexerDescriptor(pack.id, pack.indexer);
  }
  if (pack.mcpTools !== undefined) {
    validateMcpTools(pack, pack.mcpTools);
  }
}

const INDEXER_MODES = new Set(['virtual', 'dedicated', 'external']);

/**
 * Validate the indexer-layer descriptor (see IndexerDescriptor in
 * manifest.ts). Structural only — the descriptor rides inside the signed
 * manifest, so a malformed one must be a clean 400 at author/install
 * time, not a routing-time surprise.
 */
function validateIndexerDescriptor(packId: string, indexer: unknown): void {
  if (typeof indexer !== 'object' || indexer === null || Array.isArray(indexer)) {
    throw new DomainPackError(`pack "${packId}" indexer must be an object`);
  }
  const d = indexer as { mode?: unknown; relevance?: unknown; dedicated?: unknown };
  if (d.mode !== undefined && !INDEXER_MODES.has(d.mode as string)) {
    throw new DomainPackError(
      `pack "${packId}" indexer.mode "${d.mode}" must be one of ${[...INDEXER_MODES].join('|')}`,
    );
  }
  if (d.relevance !== undefined) validateRelevance(packId, d.relevance);
  if (d.dedicated !== undefined) validateDedicated(packId, d.dedicated);
}

function validateRelevance(packId: string, relevance: unknown): void {
  if (typeof relevance !== 'object' || relevance === null || Array.isArray(relevance)) {
    throw new DomainPackError(`pack "${packId}" indexer.relevance must be an object`);
  }
  const r = relevance as {
    keywords?: unknown;
    verticals?: unknown;
    description?: unknown;
    threshold?: unknown;
    alwaysRun?: unknown;
  };
  for (const field of ['keywords', 'verticals'] as const) {
    const v = r[field];
    if (
      v !== undefined &&
      (!Array.isArray(v) || v.some((s) => typeof s !== 'string' || !s))
    ) {
      throw new DomainPackError(
        `pack "${packId}" indexer.relevance.${field} must be an array of non-empty strings`,
      );
    }
  }
  // Keywords are whole-token matched against the document head (L1). A 1-char
  // keyword matches nearly every document, defeating the relevance gate and
  // inflating LLM-call fan-out — require at least 2 chars.
  if (Array.isArray(r.keywords) && r.keywords.some((s) => String(s).trim().length < 2)) {
    throw new DomainPackError(
      `pack "${packId}" indexer.relevance.keywords must each be at least 2 characters`,
    );
  }
  if (r.description !== undefined && typeof r.description !== 'string') {
    throw new DomainPackError(
      `pack "${packId}" indexer.relevance.description must be a string`,
    );
  }
  // Floor the L2 cosine threshold: 0 means "match every document", which
  // turns the embedding gate into an unconditional run.
  if (
    r.threshold !== undefined &&
    (typeof r.threshold !== 'number' || r.threshold < 0.05 || r.threshold > 1)
  ) {
    throw new DomainPackError(
      `pack "${packId}" indexer.relevance.threshold must be a number in [0.05, 1]`,
    );
  }
  if (r.alwaysRun !== undefined && typeof r.alwaysRun !== 'boolean') {
    throw new DomainPackError(
      `pack "${packId}" indexer.relevance.alwaysRun must be a boolean`,
    );
  }
}

function validateDedicated(packId: string, dedicated: unknown): void {
  if (typeof dedicated !== 'object' || dedicated === null || Array.isArray(dedicated)) {
    throw new DomainPackError(`pack "${packId}" indexer.dedicated must be an object`);
  }
  const ded = dedicated as {
    includeCorePredicates?: unknown;
    model?: unknown;
    scPasses?: unknown;
  };
  if (
    ded.includeCorePredicates !== undefined &&
    typeof ded.includeCorePredicates !== 'boolean'
  ) {
    throw new DomainPackError(
      `pack "${packId}" indexer.dedicated.includeCorePredicates must be a boolean`,
    );
  }
  if (ded.model !== undefined && typeof ded.model !== 'string') {
    throw new DomainPackError(
      `pack "${packId}" indexer.dedicated.model must be a string`,
    );
  }
  if (
    ded.scPasses !== undefined &&
    (typeof ded.scPasses !== 'number' ||
      !Number.isInteger(ded.scPasses) ||
      ded.scPasses < 1 ||
      ded.scPasses > 9)
  ) {
    throw new DomainPackError(
      `pack "${packId}" indexer.dedicated.scPasses must be an integer in [1, 9]`,
    );
  }
}

/** Validate a pack's eval fixtures (consumed by the eval runner, so a malformed
 *  one is a boot/install-time error). Structural only. */
function validateEvalFixtures(packId: string, fixtures: unknown): void {
  if (!Array.isArray(fixtures)) {
    throw new DomainPackError(`pack "${packId}" evalFixtures must be an array`);
  }
  const ids = new Set<string>();
  for (const f of fixtures) {
    const fx = f as { id?: unknown; text?: unknown; expect?: unknown };
    if (typeof fx.id !== 'string' || !fx.id) {
      throw new DomainPackError(
        `pack "${packId}" evalFixtures entries need a non-empty string id`,
      );
    }
    if (ids.has(fx.id)) {
      throw new DomainPackError(
        `pack "${packId}" evalFixtures has duplicate id "${fx.id}"`,
      );
    }
    ids.add(fx.id);
    if (typeof fx.text !== 'string' || !fx.text) {
      throw new DomainPackError(
        `pack "${packId}" evalFixture "${fx.id}" needs a non-empty text`,
      );
    }
    if (
      typeof fx.expect !== 'object' ||
      fx.expect === null ||
      Array.isArray(fx.expect)
    ) {
      throw new DomainPackError(
        `pack "${packId}" evalFixture "${fx.id}" needs an expect object`,
      );
    }
    const facts = (fx.expect as { facts?: unknown }).facts;
    if (facts !== undefined) {
      if (!Array.isArray(facts)) {
        throw new DomainPackError(
          `pack "${packId}" evalFixture "${fx.id}" expect.facts must be an array`,
        );
      }
      for (const want of facts) {
        if (
          typeof (want as { predicate?: unknown })?.predicate !== 'string'
        ) {
          throw new DomainPackError(
            `pack "${packId}" evalFixture "${fx.id}" expect.facts entries need a string predicate`,
          );
        }
      }
    }
  }
}

// Local mirror of the source-meta constraints (src/policy/source-meta.ts:
// META_KEY + SOURCE_META_MAX_VALUE_CHARS). Duplicated on purpose — this pure
// validator is what `pnpm pack:validate` runs and must stay dependency-free.
const SEED_META_KEY = /^[a-z][a-z0-9_]{0,63}$/;
const SEED_META_MAX_VALUE_CHARS = 256;

/**
 * Validate a pack's seed documents (consumed by the pack_seed_ingest job —
 * each entry becomes a normal document-pipeline ingest on install, so a
 * malformed one must be a clean 400 at author/install time). The text caps
 * bound the install-time LLM fan-out a single manifest can trigger.
 */
interface SeedShape {
  localId?: unknown;
  title?: unknown;
  text?: unknown;
  vertical?: unknown;
  originUri?: unknown;
  occurredAt?: unknown;
  meta?: unknown;
}

function validateSeedDocuments(packId: string, seeds: unknown): void {
  if (!Array.isArray(seeds)) {
    throw new DomainPackError(`pack "${packId}" seedDocuments must be an array`);
  }
  if (seeds.length > SEED_MAX_DOCS) {
    throw new DomainPackError(
      `pack "${packId}" ships ${seeds.length} seed documents — the cap is ${SEED_MAX_DOCS}`,
    );
  }
  const ids = new Set<string>();
  let totalChars = 0;
  for (const s of seeds) {
    if (typeof s !== 'object' || s === null || Array.isArray(s)) {
      throw new DomainPackError(
        `pack "${packId}" seedDocuments entries must be objects`,
      );
    }
    const seed = s as SeedShape;
    if (
      typeof seed.localId !== 'string' ||
      !SNAKE.test(seed.localId) ||
      seed.localId.includes(PACK_NAMESPACE_SEP)
    ) {
      throw new DomainPackError(
        `pack "${packId}" seed document localId "${String(seed.localId)}" must be snake_case and must not contain "${PACK_NAMESPACE_SEP}"`,
      );
    }
    if (ids.has(seed.localId)) {
      throw new DomainPackError(
        `pack "${packId}" declares duplicate seed document localId "${seed.localId}"`,
      );
    }
    ids.add(seed.localId);
    validateSeedFields(packId, seed.localId, seed);
    totalChars += (seed.text as string).length;
    if (totalChars > SEED_TOTAL_MAX_CHARS) {
      throw new DomainPackError(
        `pack "${packId}" seed documents exceed ${SEED_TOTAL_MAX_CHARS} chars of text combined`,
      );
    }
  }
}

/** Per-document field checks (localId already vetted by the caller). */
function validateSeedFields(
  packId: string,
  localId: string,
  seed: SeedShape,
): void {
  if (typeof seed.title !== 'string' || !seed.title || seed.title.length > 512) {
    throw new DomainPackError(
      `pack "${packId}" seed document "${localId}" needs a non-empty title of at most 512 chars`,
    );
  }
  if (typeof seed.text !== 'string' || !seed.text) {
    throw new DomainPackError(
      `pack "${packId}" seed document "${localId}" needs a non-empty text`,
    );
  }
  if (seed.text.length > SEED_DOC_MAX_CHARS) {
    throw new DomainPackError(
      `pack "${packId}" seed document "${localId}" text is ${seed.text.length} chars — the per-document cap is ${SEED_DOC_MAX_CHARS}`,
    );
  }
  if (
    typeof seed.vertical !== 'string' ||
    !seed.vertical ||
    seed.vertical.length > 64
  ) {
    throw new DomainPackError(
      `pack "${packId}" seed document "${localId}" needs a non-empty vertical of at most 64 chars`,
    );
  }
  if (
    seed.originUri !== undefined &&
    (typeof seed.originUri !== 'string' || seed.originUri.length > 512)
  ) {
    throw new DomainPackError(
      `pack "${packId}" seed document "${localId}" originUri must be a string of at most 512 chars`,
    );
  }
  if (
    seed.occurredAt !== undefined &&
    (typeof seed.occurredAt !== 'string' ||
      !Number.isFinite(Date.parse(seed.occurredAt)))
  ) {
    throw new DomainPackError(
      `pack "${packId}" seed document "${localId}" occurredAt must be an ISO datetime`,
    );
  }
  if (seed.meta !== undefined) validateSeedMeta(packId, localId, seed.meta);
}

/** Seed meta must survive sanitizeSourceMeta verbatim (flat scalar bag) —
 *  a key the sanitizer would drop is an authoring error, not a runtime one. */
function validateSeedMeta(packId: string, localId: string, meta: unknown): void {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
    throw new DomainPackError(
      `pack "${packId}" seed document "${localId}" meta must be an object of scalar values`,
    );
  }
  for (const [key, value] of Object.entries(meta as Record<string, unknown>)) {
    if (!SEED_META_KEY.test(key)) {
      throw new DomainPackError(
        `pack "${packId}" seed document "${localId}" meta key "${key}" is not snake_case (${SEED_META_KEY})`,
      );
    }
    const ok =
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value)) ||
      (typeof value === 'string' && value.length <= SEED_META_MAX_VALUE_CHARS);
    if (!ok) {
      throw new DomainPackError(
        `pack "${packId}" seed document "${localId}" meta value of "${key}" must be a boolean, finite number, or string of at most ${SEED_META_MAX_VALUE_CHARS} chars`,
      );
    }
  }
}

/**
 * Validate a pack's extraction profile shape (it's consumed into the extractor
 * prompt, so a malformed one is a boot/install-time error, not silent). Kept
 * permissive — only structural shape is enforced.
 */
function validateExtractionProfile(packId: string, profile: unknown): void {
  if (typeof profile !== 'object' || profile === null || Array.isArray(profile)) {
    throw new DomainPackError(
      `pack "${packId}" extractionProfile must be an object`,
    );
  }
  const { guidance, fewShot } = profile as {
    guidance?: unknown;
    fewShot?: unknown;
  };
  if (guidance !== undefined && typeof guidance !== 'string') {
    throw new DomainPackError(
      `pack "${packId}" extractionProfile.guidance must be a string`,
    );
  }
  if (fewShot !== undefined) {
    if (!Array.isArray(fewShot)) {
      throw new DomainPackError(
        `pack "${packId}" extractionProfile.fewShot must be an array`,
      );
    }
    for (const ex of fewShot) {
      if (
        typeof ex !== 'object' ||
        ex === null ||
        typeof (ex as { text?: unknown }).text !== 'string' ||
        typeof (ex as { note?: unknown }).note !== 'string'
      ) {
        throw new DomainPackError(
          `pack "${packId}" extractionProfile.fewShot entries must be { text: string, note: string }`,
        );
      }
    }
  }
}

// ── MCP pack tools (docs/mcp-pack-tools.md) ──────────────────────────

const TOOL_NAME = /^[a-z][a-z0-9_]{1,40}$/;
const PARAM_NAME = /^[a-z][a-z0-9_]{0,30}$/;
const TOOL_KINDS = new Set(['query', 'external']);
const QUERY_SURFACES = new Set(['search', 'facts_by_predicate']);
const MAX_TOOLS = 8;
const MAX_TOOL_PARAMS = 8;

/**
 * Validate the pack's declared MCP tools (PackToolSpec[] in manifest.ts).
 * Structural + referential only (predicates must be the pack's OWN
 * localIds) and deliberately env-free: the https-only rule for external
 * endpoints is enforced at install/call time by the egress guard, so a
 * pure `pnpm pack:validate` run gives an author the same verdict a
 * server would. Exported: the MCP reader re-runs it defensively against
 * stored manifests before registering anything.
 */
export function validateMcpTools(pack: DomainPackManifest, tools: unknown): void {
  if (!Array.isArray(tools) || tools.length === 0) {
    throw new DomainPackError(
      `pack "${pack.id}" mcpTools must be a non-empty array`,
    );
  }
  if (tools.length > MAX_TOOLS) {
    throw new DomainPackError(
      `pack "${pack.id}" declares ${tools.length} mcpTools — max is ${MAX_TOOLS}`,
    );
  }
  const localIds = new Set(pack.predicates.map((p) => p.localId));
  const seen = new Set<string>();
  for (const t of tools) {
    if (t === null || typeof t !== 'object' || Array.isArray(t)) {
      throw new DomainPackError(`pack "${pack.id}" mcpTools entries must be objects`);
    }
    const tool = t as {
      kind?: unknown;
      name?: unknown;
      title?: unknown;
      description?: unknown;
    };
    if (!TOOL_KINDS.has(tool.kind as string)) {
      throw new DomainPackError(
        `pack "${pack.id}" mcpTool kind "${tool.kind}" must be one of ${[...TOOL_KINDS].join('|')}`,
      );
    }
    const name = tool.name as string;
    if (
      typeof name !== 'string' ||
      !TOOL_NAME.test(name) ||
      name.includes(PACK_NAMESPACE_SEP)
    ) {
      throw new DomainPackError(
        `pack "${pack.id}" mcpTool name "${name}" must match ${TOOL_NAME} and must not contain "${PACK_NAMESPACE_SEP}"`,
      );
    }
    if (seen.has(name)) {
      throw new DomainPackError(
        `pack "${pack.id}" declares duplicate mcpTool name "${name}"`,
      );
    }
    seen.add(name);
    if (tool.title !== undefined && (typeof tool.title !== 'string' || tool.title.length > 80)) {
      throw new DomainPackError(
        `pack "${pack.id}" mcpTool "${name}" title must be a string of at most 80 characters`,
      );
    }
    if (
      typeof tool.description !== 'string' ||
      tool.description.length === 0 ||
      tool.description.length > 500
    ) {
      throw new DomainPackError(
        `pack "${pack.id}" mcpTool "${name}" description must be a non-empty string of at most 500 characters`,
      );
    }
    if (tool.kind === 'query') {
      validateQueryTool({ packId: pack.id, name, tool: t, localIds });
    } else {
      validateExternalTool(pack.id, name, t);
    }
  }
}

function validateQueryTool({
  packId,
  name,
  tool,
  localIds,
}: {
  packId: string;
  name: string;
  tool: unknown;
  localIds: Set<string>;
}): void {
  const { query } = tool as { query?: unknown };
  if (typeof query !== 'object' || query === null || Array.isArray(query)) {
    throw new DomainPackError(
      `pack "${packId}" mcpTool "${name}" needs a query object`,
    );
  }
  const q = query as {
    surface?: unknown;
    predicates?: unknown;
    defaultLimit?: unknown;
    minConfidence?: unknown;
  };
  if (!QUERY_SURFACES.has(q.surface as string)) {
    throw new DomainPackError(
      `pack "${packId}" mcpTool "${name}" query.surface "${q.surface}" must be one of ${[...QUERY_SURFACES].join('|')}`,
    );
  }
  if (q.predicates !== undefined) {
    if (
      !Array.isArray(q.predicates) ||
      q.predicates.length === 0 ||
      q.predicates.some((p) => typeof p !== 'string')
    ) {
      throw new DomainPackError(
        `pack "${packId}" mcpTool "${name}" query.predicates must be a non-empty array of localIds`,
      );
    }
    for (const p of q.predicates) {
      if (!localIds.has(p as string)) {
        throw new DomainPackError(
          `pack "${packId}" mcpTool "${name}" query.predicates references "${p}", which is not a predicate of this pack`,
        );
      }
    }
  } else if (q.surface === 'facts_by_predicate') {
    throw new DomainPackError(
      `pack "${packId}" mcpTool "${name}" surface facts_by_predicate requires query.predicates`,
    );
  }
  if (
    q.defaultLimit !== undefined &&
    (typeof q.defaultLimit !== 'number' ||
      !Number.isInteger(q.defaultLimit) ||
      q.defaultLimit < 1 ||
      q.defaultLimit > 20)
  ) {
    throw new DomainPackError(
      `pack "${packId}" mcpTool "${name}" query.defaultLimit must be an integer in [1, 20]`,
    );
  }
  if (q.minConfidence !== undefined) {
    if (q.surface !== 'search') {
      throw new DomainPackError(
        `pack "${packId}" mcpTool "${name}" query.minConfidence applies to the search surface only`,
      );
    }
    if (
      typeof q.minConfidence !== 'number' ||
      q.minConfidence < 0 ||
      q.minConfidence > 1
    ) {
      throw new DomainPackError(
        `pack "${packId}" mcpTool "${name}" query.minConfidence must be a number in [0, 1]`,
      );
    }
  }
}

function validateExternalTool(packId: string, name: string, tool: unknown): void {
  const t = tool as { endpoint?: unknown; timeoutMs?: unknown; params?: unknown };
  // Pure structural URL check — http accepted here so the validator stays
  // env-free; https-only (and the private-address fence) is enforced by
  // the egress guard at install time and again on every call.
  let parsed: URL | null = null;
  try {
    parsed = new URL(t.endpoint as string);
  } catch {
    parsed = null;
  }
  if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
    throw new DomainPackError(
      `pack "${packId}" mcpTool "${name}" endpoint must be a valid http(s) URL`,
    );
  }
  if (
    t.timeoutMs !== undefined &&
    (typeof t.timeoutMs !== 'number' ||
      !Number.isInteger(t.timeoutMs) ||
      t.timeoutMs < 1_000 ||
      t.timeoutMs > 30_000)
  ) {
    throw new DomainPackError(
      `pack "${packId}" mcpTool "${name}" timeoutMs must be an integer in [1000, 30000]`,
    );
  }
  if (t.params === undefined) return;
  if (!Array.isArray(t.params) || t.params.length > MAX_TOOL_PARAMS) {
    throw new DomainPackError(
      `pack "${packId}" mcpTool "${name}" params must be an array of at most ${MAX_TOOL_PARAMS}`,
    );
  }
  const seen = new Set<string>();
  for (const p of t.params) {
    validateToolParam(packId, name, p);
    const pname = (p as PackToolParam).name;
    if (seen.has(pname)) {
      throw new DomainPackError(
        `pack "${packId}" mcpTool "${name}" declares duplicate param "${pname}"`,
      );
    }
    seen.add(pname);
  }
}

const TOOL_PARAM_TYPES = new Set(['string', 'number', 'boolean']);

function validateToolParam(packId: string, name: string, param: unknown): void {
  if (param === null || typeof param !== 'object' || Array.isArray(param)) {
    throw new DomainPackError(
      `pack "${packId}" mcpTool "${name}" params entries must be objects`,
    );
  }
  const p = param as Partial<PackToolParam>;
  if (
    typeof p.name !== 'string' ||
    !PARAM_NAME.test(p.name) ||
    p.name.includes(PACK_NAMESPACE_SEP)
  ) {
    throw new DomainPackError(
      `pack "${packId}" mcpTool "${name}" param name "${p.name}" must match ${PARAM_NAME} and must not contain "${PACK_NAMESPACE_SEP}"`,
    );
  }
  if (!TOOL_PARAM_TYPES.has(p.type as string)) {
    throw new DomainPackError(
      `pack "${packId}" mcpTool "${name}" param "${p.name}" type must be one of ${[...TOOL_PARAM_TYPES].join('|')}`,
    );
  }
  if (
    p.description !== undefined &&
    (typeof p.description !== 'string' || p.description.length > 200)
  ) {
    throw new DomainPackError(
      `pack "${packId}" mcpTool "${name}" param "${p.name}" description must be a string of at most 200 characters`,
    );
  }
  if (p.required !== undefined && typeof p.required !== 'boolean') {
    throw new DomainPackError(
      `pack "${packId}" mcpTool "${name}" param "${p.name}" required must be a boolean`,
    );
  }
  if (p.enum !== undefined) {
    if (p.type !== 'string') {
      throw new DomainPackError(
        `pack "${packId}" mcpTool "${name}" param "${p.name}" enum applies to string params only`,
      );
    }
    if (
      !Array.isArray(p.enum) ||
      p.enum.length === 0 ||
      p.enum.length > 20 ||
      p.enum.some((v) => typeof v !== 'string' || v.length === 0 || v.length > 60)
    ) {
      throw new DomainPackError(
        `pack "${packId}" mcpTool "${name}" param "${p.name}" enum must be 1..20 non-empty strings of at most 60 characters`,
      );
    }
  }
  if (p.maxLength !== undefined) {
    if (p.type !== 'string') {
      throw new DomainPackError(
        `pack "${packId}" mcpTool "${name}" param "${p.name}" maxLength applies to string params only`,
      );
    }
    if (
      typeof p.maxLength !== 'number' ||
      !Number.isInteger(p.maxLength) ||
      p.maxLength < 1 ||
      p.maxLength > 2_000
    ) {
      throw new DomainPackError(
        `pack "${packId}" mcpTool "${name}" param "${p.name}" maxLength must be an integer in [1, 2000]`,
      );
    }
  }
}

/**
 * Merge the core seed with installed packs into one PredicateDefinition[] for
 * the registry to bootstrap. Each pack is validated; pack predicates are
 * namespaced (`<packId>__<localId>`) and stamped `createdBy:'system'`. Throws
 * on ANY id collision (pack-vs-core or pack-vs-pack) — no silent shadowing.
 */
export function assembleSeed(
  core: PredicateDefinition[],
  packs: DomainPackManifest[],
): PredicateDefinition[] {
  const byId = new Map<string, string>(); // predicateId -> origin (for errors)
  for (const c of core) byId.set(c.predicateId, 'core');

  const composed: PredicateDefinition[] = [];
  for (const pack of packs) {
    validatePack(pack);
    for (const p of pack.predicates) {
      const predicateId = composePredicateId(pack.id, p.localId);
      const prior = byId.get(predicateId);
      if (prior) {
        throw new DomainPackError(
          `predicate id collision "${predicateId}": pack "${pack.id}" vs ${prior}`,
        );
      }
      byId.set(predicateId, `pack "${pack.id}"`);
      const { localId: _localId, ...rest } = p;
      composed.push({ ...rest, predicateId, createdBy: 'system' });
    }
  }
  return [...core, ...composed];
}
