/**
 * Multilingual Tier 2 — canonical embedding-space descriptors.
 *
 * An "embedding space" is the (model, dimensionality, normalization) triple
 * a dense vector was produced under. Two vectors are only comparable
 * (cosine / dot) when they live in the SAME space; a cross-space compare is
 * numerically meaningless even when the dimensions happen to match. This
 * module is the single source of truth for naming a space and testing two
 * spaces for compatibility. It is PURE (no I/O, no NestJS) so it can be
 * shared by the embedder service, the reindex engine, the per-tenant
 * active-space resolver, and the tests without pulling in the DI graph.
 *
 * Canonical id shape: `${provider}:${model}:${dim}:${norm}`
 *   e.g. `openai:text-embedding-3-small:1536:l2`
 *        `bge-m3:Xenova/bge-m3:1024:l2`
 *
 * The id is stamped on rows behind EMBEDDING_SPACE_TRACKING (default off);
 * a NONE column is interpreted as "the current provider's space" (the
 * legacy / implicit space), which keeps serving byte-identical when the
 * flag is off.
 */

/** How a provider normalizes its output vectors. Both shipped providers
 *  emit unit vectors (OpenAI by API contract; bge-m3 via `normalize:true`),
 *  so `l2` is the only value in play today — but the descriptor records it
 *  explicitly so a future non-normalized provider is a DIFFERENT space
 *  rather than a silent cross-space compare. */
export type EmbeddingNorm = 'l2' | 'none';

export interface EmbeddingSpaceConfig {
  /** Provider vendor, e.g. `openai` | `bge-m3`. */
  provider: string;
  /** Model id, e.g. `text-embedding-3-small` | `Xenova/bge-m3`. */
  model: string;
  /** Vector dimensionality, e.g. 1536 | 1024. */
  dim: number;
  /** Output normalization. */
  norm: EmbeddingNorm;
}

/**
 * THE declaration of every embedding space this build can produce. One
 * entry per shipped provider; model identity and width live TOGETHER here
 * and nowhere else.
 *
 * This exists because the width used to be restated in five places that
 * could disagree — the provider constructors, two env defaults
 * (`OPENAI_EMBEDDING_DIMENSIONS` / `BGE_M3_DIMENSIONS`), the HNSW
 * `DIMENSION` DDL, and the commented-out DDL in the migrations. A
 * mismatch between any two of them was expressible, and one of them
 * (fallback width vs corpus width) silently corrupted the vector store.
 * Deriving every consumer from this table makes the mismatch
 * unrepresentable rather than merely detected at runtime.
 *
 * `test/embedding-space-truth.unit-spec.ts` is the gate that keeps it
 * that way: it fails if a provider is added without an entry here, if a
 * vector column or vector index appears whose width is not derived from
 * here, or if any width literal is restated elsewhere in `src/`.
 *
 * Widths are NOT operator-tunable. They are a property of the model, not
 * of a deployment — an operator who "configures" a width does not change
 * what the model emits, they only desynchronise the store from it.
 * `EMBEDDER_PROVIDER` selects WHICH of these spaces is active; nothing
 * edits one.
 */
export const EMBEDDING_SPACES = {
  openai: { provider: 'openai', model: 'text-embedding-3-small', dim: 1536, norm: 'l2' },
  'bge-m3': { provider: 'bge-m3', model: 'Xenova/bge-m3', dim: 1024, norm: 'l2' },
} as const satisfies Record<string, EmbeddingSpaceConfig>;

/** The provider names `EMBEDDER_PROVIDER` may select — derived from the
 *  declaration, so a new space is selectable the moment it is declared
 *  and cannot be selected before. */
export type EmbedderProviderName = keyof typeof EMBEDDING_SPACES;

/** Back-compat default: the OpenAI space, as before this table existed. */
export const DEFAULT_EMBEDDER_PROVIDER: EmbedderProviderName = 'openai';

export const EMBEDDER_PROVIDER_NAMES = Object.keys(EMBEDDING_SPACES) as EmbedderProviderName[];

export function isEmbedderProviderName(value: string): value is EmbedderProviderName {
  return Object.prototype.hasOwnProperty.call(EMBEDDING_SPACES, value);
}

/** The declared space for a provider name. The ONLY way to learn a
 *  provider's model or width. */
export function declaredSpace(name: EmbedderProviderName): EmbeddingSpaceConfig {
  return EMBEDDING_SPACES[name];
}

/**
 * The `vendor:model:dim` id a provider reports as `providerId` (the cache
 * key prefix and the gen_ai span's system/model source). Derived here so a
 * provider cannot spell its own vendor prefix or width by hand — that is
 * how `openai:` and the width came to be restated inside the provider
 * classes in the first place.
 */
export function providerIdOf(space: EmbeddingSpaceConfig): string {
  return `${space.provider}:${space.model}:${space.dim}`;
}

export interface ParsedEmbeddingSpace {
  provider: string;
  model: string;
  dim: number;
  norm: string;
}

/**
 * The canonical, stable id for an embedding space. Pure function of its
 * config — identical config ⇒ identical id, byte-for-byte. Callers MUST go
 * through this rather than hand-assembling the string, so the format has
 * exactly one definition.
 */
export function embeddingSpaceId(cfg: EmbeddingSpaceConfig): string {
  return `${cfg.provider}:${cfg.model}:${cfg.dim}:${cfg.norm}`;
}

/**
 * Build a space id from a provider's `providerId` (`vendor:model:dim`, as
 * produced by OpenAIEmbedderProvider / BgeM3EmbedderProvider) plus its
 * normalization. Splits on the FIRST and LAST colon so a model id that
 * itself contains a colon still parses (vendor = head, dim = tail, model =
 * everything between). Returns null when the providerId is not the expected
 * three-part shape.
 */
export function embeddingSpaceIdFromProviderId(
  providerId: string,
  norm: EmbeddingNorm,
): string | null {
  const firstColon = providerId.indexOf(':');
  const lastColon = providerId.lastIndexOf(':');
  if (firstColon === -1 || lastColon === firstColon) return null;
  const provider = providerId.slice(0, firstColon);
  const model = providerId.slice(firstColon + 1, lastColon);
  const dimRaw = providerId.slice(lastColon + 1);
  const dim = Number.parseInt(dimRaw, 10);
  if (!provider || !model || !Number.isInteger(dim) || String(dim) !== dimRaw) return null;
  return embeddingSpaceId({ provider, model, dim, norm });
}

/** Parse a canonical id back into its parts. Returns null on a malformed id
 *  (used by the compatibility test to reason about dim / model / norm). */
export function parseEmbeddingSpaceId(id: string): ParsedEmbeddingSpace | null {
  const parts = id.split(':');
  // provider : model : dim : norm — but the model may contain colons, so
  // pin provider (head), norm (tail), dim (second from tail) and rejoin the
  // middle as the model.
  if (parts.length < 4) return null;
  const provider = parts[0]!;
  const norm = parts[parts.length - 1]!;
  const dimRaw = parts[parts.length - 2]!;
  const model = parts.slice(1, parts.length - 2).join(':');
  const dim = Number.parseInt(dimRaw, 10);
  if (!provider || !model || !norm || !Number.isInteger(dim) || String(dim) !== dimRaw) {
    return null;
  }
  return { provider, model, dim, norm };
}

/**
 * Are two spaces compatible for a cosine / dot compare? Explicit test: the
 * spaces must agree on dim, model, provider AND norm. Identical ids are
 * trivially compatible; otherwise we parse and compare the load-bearing
 * fields. A malformed (unparseable) id is compatible ONLY with a
 * byte-identical id — we never guess a comparison is safe.
 */
export function spacesCompatible(a: string, b: string): boolean {
  if (a === b) return true;
  const pa = parseEmbeddingSpaceId(a);
  const pb = parseEmbeddingSpaceId(b);
  if (!pa || !pb) return false;
  return (
    pa.provider === pb.provider && pa.model === pb.model && pa.dim === pb.dim && pa.norm === pb.norm
  );
}

/** Human-readable reason two spaces are incompatible — for guard errors.
 *  Returns null when they ARE compatible. */
export function describeSpaceIncompatibility(a: string, b: string): string | null {
  if (spacesCompatible(a, b)) return null;
  const pa = parseEmbeddingSpaceId(a);
  const pb = parseEmbeddingSpaceId(b);
  if (!pa || !pb) return `unparseable space id(s): '${a}' vs '${b}'`;
  const diffs: string[] = [];
  if (pa.dim !== pb.dim) diffs.push(`dim ${pa.dim}≠${pb.dim}`);
  if (pa.model !== pb.model) diffs.push(`model ${pa.model}≠${pb.model}`);
  if (pa.provider !== pb.provider) diffs.push(`provider ${pa.provider}≠${pb.provider}`);
  if (pa.norm !== pb.norm) diffs.push(`norm ${pa.norm}≠${pb.norm}`);
  return diffs.join(', ');
}

/** The column name carrying a row's space descriptor across every
 *  embedding-bearing table (migration 0101). One name everywhere so the
 *  stamping SET clauses and read filters stay in lockstep. */
export const EMBEDDING_SPACE_FIELD = 'embeddingSpaceId';

/**
 * EVERY column in the schema that holds a vector in an embedding space —
 * i.e. one that may be cosine-compared against a query vector, and is
 * therefore only meaningful at the declared width.
 *
 * This is the schema-side half of the single declaration. It exists so a
 * new vector column cannot be added without being classified: the truth
 * gate parses `DEFINE FIELD … TYPE option<array<float>>` out of the
 * migrations and requires every one to appear either here or in
 * {@link NON_EMBEDDING_FLOAT_COLUMNS}. A column that is in neither fails
 * the build.
 */
export const VECTOR_COLUMNS = [
  { table: 'community_node', field: 'summaryEmbedding' },
  { table: 'derived_representation', field: 'embedding' },
  { table: 'episode', field: 'embedding' },
  { table: 'episode_segment', field: 'embedding' },
  { table: 'knowledge_entity', field: 'embedding' },
  { table: 'knowledge_fact', field: 'altEmbedding' },
  { table: 'knowledge_fact', field: 'embedding' },
  { table: 'knowledge_predicate', field: 'embedding' },
  { table: 'lens_suppression', field: 'centroid' },
  { table: 'memory_episode', field: 'gistEmbedding' },
  { table: 'procedural_memory', field: 'triggerEmbedding' },
  { table: 'semantic_belief', field: 'embedding' },
  { table: 'strategy_memory', field: 'embedding' },
] as const;

/**
 * `array<float>` columns that are NOT embeddings — calibration curves and
 * threshold ladders. They are width-agnostic and never cosine-compared,
 * so they are exempt from the space rules. Listed explicitly rather than
 * pattern-matched so adding one is a deliberate act.
 */
export const NON_EMBEDDING_FLOAT_COLUMNS = [
  { table: 'calibration_table', field: 'thresholds' },
  { table: 'calibration_table', field: 'values' },
  { table: 'focus_calibration', field: 'thresholds' },
  { table: 'focus_calibration', field: 'values' },
] as const;

/**
 * The subset of {@link VECTOR_COLUMNS} the reindex-all sweep rewrites by
 * re-embedding stored text, with the vector column(s) whose space
 * `embeddingSpaceId` describes. Community / procedural vectors are
 * derived by their own passes and are stamped there.
 *
 * Strictly a subset — the truth gate enforces that, so a table can never
 * be swept for a column the schema does not declare.
 */
export const EMBEDDING_TABLES = [
  { table: 'knowledge_fact', vectorFields: ['embedding', 'altEmbedding'] },
  { table: 'knowledge_entity', vectorFields: ['embedding'] },
  { table: 'knowledge_predicate', vectorFields: ['embedding'] },
  { table: 'episode', vectorFields: ['embedding'] },
  { table: 'episode_segment', vectorFields: ['embedding'] },
  // 0106 landed after 0101 — without this entry the reindex-all sweep
  // silently skipped scene gist vectors (space column added in 0109).
  { table: 'memory_episode', vectorFields: ['gistEmbedding'] },
  { table: 'strategy_memory', vectorFields: ['embedding'] },
  { table: 'community_node', vectorFields: ['summaryEmbedding'] },
  { table: 'procedural_memory', vectorFields: ['triggerEmbedding'] },
] as const;
