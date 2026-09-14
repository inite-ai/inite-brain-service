/**
 * Shared-content-token guard for the identity judge's shortlist.
 *
 * WHY. Cosine retrieves well but knows nothing about naming, so the
 * shortlist regularly contains a predicate that merely talks about the
 * same SUBJECT MATTER. Measured on a live tenant, the judge — reading
 * the coinage's example use — merged `decided` into `fixed_retry_policy`
 * and `replaces` into `superseded_by`: two pairs with no word in common,
 * where one name is a bare verb and the merge would pour every
 * "X decided Y" fact into a retry-policy slot whose `single_active`
 * semantics then supersedes them against each other.
 *
 * THE RULE. A rename shares a word with what it renames. Every merge
 * worth having on that same tenant does —
 *   deploys_to / deploy_target / deploys      → deploy
 *   queue_backend / job_queue_backend         → queue, backend
 *   changed_launch_date / pilot_launch_date   → launch, date
 *   retry_policy / fixed_retry_policy         → retry, policy
 *   payout_cutoff / payout_cutoff_time        → payout, cutoff
 *   owns / code_memory__owns                  → owns
 * — and neither bad merge does. So a candidate that shares no content
 * token with the coinage is dropped BEFORE the judge sees it: the judge
 * decides whether two names for the same kind of thing are the same
 * attribute, and never gets to decide that two unrelated names are.
 *
 * Deliberately crude and deterministic — no embeddings, no LLM. The
 * stemmer strips only plural/participle endings, which is what carries
 * `deploy_target` ~ `deployed_to` (deploy ~ deploy) and is NOT enough
 * for `deploy` ~ `deployment`: the same accepted limitation the belief
 * field-fold rule already documents.
 */

/** Structural words that carry no attribute meaning on their own. */
const STOP_TOKENS: ReadonlySet<string> = new Set([
  'a',
  'an',
  'the',
  'to',
  'of',
  'in',
  'on',
  'at',
  'by',
  'for',
  'with',
  'from',
  'as',
  'is',
  'was',
  'be',
  'new',
  'current',
]);

/**
 * A Domain Pack namespaces its predicates `<packId>__<name>`, so two
 * unrelated pack predicates share every prefix token. Strip the prefix
 * rather than stoplisting its words, which would blank out a genuine
 * `memory_limit` or `code_owner`.
 */
const PACK_NAMESPACE = /^[a-z0-9]+(?:_[a-z0-9]+)*__/;

/**
 * Lowercase, drop any pack namespace, split on anything that is not a
 * letter or digit, drop stop tokens, and strip one plural/participle
 * ending. Tokens shorter than three characters after stemming are
 * dropped — 'id', 'to', 'v2' carry no naming signal and would match far
 * too much.
 */
export function contentTokens(name: string): Set<string> {
  const out = new Set<string>();
  const bare = name.toLowerCase().replace(PACK_NAMESPACE, '');
  for (const raw of bare.split(/[^\p{L}\p{N}]+/u)) {
    if (raw === '' || STOP_TOKENS.has(raw)) continue;
    const stem = stemOne(raw);
    if (stem.length >= 3 && !STOP_TOKENS.has(stem)) out.add(stem);
  }
  return out;
}

/**
 * One pass of plural/participle stripping. Deliberately narrow: this
 * produces a token that is COMPARED FOR EQUALITY, so an over-eager strip
 * invents a match. A naive "drop a trailing s" turns `status` into
 * `statu` and `address` into `addres` — the first of which silently
 * broke the belief plane's generic-modifier rule, since its stoplist
 * says `status`.
 *
 * What it must carry: deploy ~ deploys ~ deployed, inform ~ informed.
 * What it must not touch: -ss / -us / -is / -as endings, and anything
 * short enough that a suffix is probably part of the word.
 */
function stemOne(token: string): string {
  if (token.length <= 3) return token;
  if (/(?:ss|us|is|as)$/.test(token)) return token;
  if (token.endsWith('ing') && token.length >= 6) return token.slice(0, -3);
  if (token.endsWith('ed') && token.length >= 5) return token.slice(0, -2);
  // `-es` only where English actually adds it (boxes, dishes, matches);
  // elsewhere the plural is a bare `-s` (notes → note, not `not`).
  if (/(?:s|x|z|ch|sh)es$/.test(token)) return token.slice(0, -2);
  if (token.endsWith('s')) return token.slice(0, -1);
  return token;
}

/**
 * Could `candidate` be another name for `predicate`? True only when the
 * two share at least one content token. A candidate that fails this is
 * not a rename under any reading, so it never reaches the judge.
 */
export function sharesContentToken(predicate: string, candidate: string): boolean {
  const a = contentTokens(predicate);
  if (a.size === 0) return false;
  for (const t of contentTokens(candidate)) if (a.has(t)) return true;
  return false;
}
