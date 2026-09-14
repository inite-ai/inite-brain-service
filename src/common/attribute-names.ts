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

/**
 * A Domain Pack namespaces its predicates `<packId>__<name>`, so two
 * unrelated pack predicates share every prefix token. Strip the prefix
 * rather than stoplisting its words, which would blank out a genuine
 * `memory_limit` or `code_owner`.
 */
const PACK_NAMESPACE = /^[a-z0-9]+(?:_[a-z0-9]+)*__/;

/**
 * Lowercase, drop any pack namespace, split on anything that is not a
 * letter or digit, keep tokens of three characters or more — 'id', 'to',
 * 'v2' carry no naming signal and would match far too much.
 *
 * NO STOPLIST either. There was an 18-word English one here, and
 * measuring it against a live 196-predicate registry (19110 pairs)
 * settled it: ELEVEN of the eighteen entries were dead — the length
 * floor already dropped `a an to of in on at by as is be` — and the
 * seven that did anything (`the for with from was new current`)
 * prevented 28 gate passes, 0.15% of the pairs. For that the system
 * carried an English word list it could never apply to a tenant whose
 * fields are named in another language, where `для`/`с`/`от` sail
 * through regardless. The gate is generous by contract, so each of
 * those 28 costs one question the judge answers "no" to.
 *
 * NO STEMMING. An earlier version carried a hand-written English
 * suffix table here (-ing/-ed/-es/-s with invented length cutoffs, and
 * then -ss/-us/-is/-as exceptions bolted on after it turned `status`
 * into `statu` and broke the belief plane's stoplist). That was wrong
 * twice over: it is dead weight on any tenant whose enricher names
 * fields in another language, and it hand-codes morphology inside the
 * one component whose whole premise is that lexical rules cannot settle
 * attribute identity. Tokens stay as written; the two callers below
 * differ in how strictly they compare them, which is the real
 * distinction.
 */
export function contentTokens(name: string): Set<string> {
  const out = new Set<string>();
  const bare = name.toLowerCase().replace(PACK_NAMESPACE, '');
  for (const raw of bare.split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length >= 3) out.add(raw);
  }
  return out;
}

/**
 * Shortest shared prefix that counts as "the same word, inflected".
 * ONE number, and it is deliberately crude: a prefix is the only form
 * of morphological tolerance that costs no language-specific table, so
 * it works the same on `deploy`/`deploys`/`deployed` and on
 * `адрес`/`адреса`. Four, because three matches `car` to `career`.
 */
const SHARED_PREFIX_MIN = 4;

/** Same word up to inflection: equal, or one is a long-enough prefix. */
function tokensAlike(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= SHARED_PREFIX_MIN && long.startsWith(short);
}

/**
 * Could `candidate` be another name for `predicate`? True when the two
 * share a content token up to inflection. A candidate that fails this
 * is not a rename under any reading, so it never reaches the judge.
 *
 * This is a GATE, not a decision — the judge decides. So it compares
 * loosely on purpose: a generous match only costs one question the
 * model will answer "no" to, while a miss silently drops a real rename.
 * `fieldsFold` on the belief plane wants the opposite and compares
 * these same tokens exactly, because there the answer IS the decision.
 */
export function sharesContentToken(predicate: string, candidate: string): boolean {
  const a = contentTokens(predicate);
  if (a.size === 0) return false;
  for (const t of contentTokens(candidate)) {
    for (const u of a) if (tokensAlike(t, u)) return true;
  }
  return false;
}
