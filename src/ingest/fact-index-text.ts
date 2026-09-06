import { envFlagEnabled } from '../common/env-validation';
import { PACK_NAMESPACE_SEP } from '../ai/domain-packs/manifest';

/**
 * Fact index-text composition (INGEST_PREDICATE_INDEX_TEXT, default off).
 *
 * The measured miss (code-memory battery k07): a query "acme-api webhooks
 * rate limit" never surfaces the harvested fact predicate=`rate_limit`,
 * object="120 requests per minute" — the words "rate limit" exist ONLY in
 * the predicate name, and the embedding basis is the raw
 * `rate_limit: 120 requests per minute`, so the vector never matches the
 * natural-language phrasing. Harvested literal facts (rate_limit /
 * service_port / http_status / duration_limit / naming_prefix / identifier)
 * are the worst hit: their objects are bare values.
 *
 * The lexical leg already has the humanized form — migration 0007's
 * `searchHaystack` VALUE clause (`string::replace(predicate, '_', ' ')`)
 * computes it DB-side on every write. This builder closes the same gap on
 * the EMBEDDING side, so the two legs carry the same natural-words
 * predicate surface.
 *
 * Composition follows the scene-trace precedent (DERIVER_SCENE_TRACE,
 * window-deriver: `${proposition} — ${scene}`): the humanized predicate is
 * APPENDED after an ` — ` separator, bare words, no label. The stored
 * object/predicate/haystack are untouched — only the embedding basis
 * changes, write-time only (no re-embedding or backfill of existing rows).
 *
 * Off (default) → the historical `${predicate}: ${object}` form,
 * byte-identical.
 */

/**
 * Deterministic natural-words form of a predicate id: strip the
 * `<packId>__` namespace prefix (packIds contain no `__`, manifest
 * contract — the first separator always splits off the pack), then
 * underscores → spaces, collapsed and trimmed. `rate_limit` → "rate
 * limit"; `acme_pack__rate_limit` → "rate limit"; `identifier` →
 * "identifier".
 */
export function humanizePredicate(predicate: string): string {
  const sep = predicate.indexOf(PACK_NAMESPACE_SEP);
  const local = sep > 0 ? predicate.slice(sep + PACK_NAMESPACE_SEP.length) : predicate;
  const words = local.replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
  // Defensive: a pathological id like `pack__` humanizes to '' — fall back
  // to the whole predicate so the caller never appends an empty part.
  return words || predicate.replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Tokens for the dedup check: whitespace-split, lowercased, edge
 * punctuation stripped ("rate_limit:" → "rate_limit"), underscores KEPT
 * inside tokens — `rate_limit` must NOT count as already containing the
 * words "rate" + "limit"; producing those as separate tokens is the whole
 * point of the flag.
 */
function tokensOf(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/^[^a-z0-9_]+|[^a-z0-9_]+$/g, ''))
    .filter(Boolean);
}

/**
 * The fact's index text — the basis for the stored embedding vector.
 *
 * Flag off (default): the historical `${predicate}: ${object}` form,
 * byte-identical. Flag on: ` — <humanized predicate>` is appended UNLESS
 * every humanized word is already a token of the base text (dedup guard:
 * `identifier: LSYNC_REPLAY_ENABLED` must not grow a silly
 * " — identifier" tail, and single-word predicates like `preference` are
 * already natural words).
 */
export function factIndexText(predicate: string, object: string): string {
  const base = `${predicate}: ${object}`;
  if (!envFlagEnabled(process.env.INGEST_PREDICATE_INDEX_TEXT)) return base;
  const human = humanizePredicate(predicate);
  if (!human) return base;
  const baseTokens = new Set(tokensOf(base));
  const humanTokens = tokensOf(human);
  if (humanTokens.every((t) => baseTokens.has(t))) return base;
  return `${base} — ${human}`;
}
