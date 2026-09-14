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
  'code',
  'memory',
]);

/**
 * Lowercase, split on anything that is not a letter or digit, drop stop
 * tokens, and strip one plural/participle ending. Tokens shorter than
 * three characters after stemming are dropped — 'id', 'to', 'v2' carry
 * no naming signal and would match far too much.
 */
export function contentTokens(name: string): Set<string> {
  const out = new Set<string>();
  for (const raw of name.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw === '' || STOP_TOKENS.has(raw)) continue;
    const stem = stemOne(raw);
    if (stem.length >= 3 && !STOP_TOKENS.has(stem)) out.add(stem);
  }
  return out;
}

/** One pass of plural/participle stripping; never shortens below 3. */
function stemOne(token: string): string {
  for (const suffix of ['ing', 'ed', 'es', 's']) {
    if (token.endsWith(suffix) && token.length - suffix.length >= 3) {
      return token.slice(0, -suffix.length);
    }
  }
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
