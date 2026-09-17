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
 * Q-GRAM BLOCKING — the textbook scheme, not a hand-rolled rule.
 *
 * "Which pairs are worth comparing expensively" is a surveyed problem in
 * entity resolution (Papadakis et al., *A Survey of Blocking and
 * Filtering Techniques for Entity Resolution*), and q-gram blocking is
 * its standard answer to inflection: no morphology table, no language
 * assumption, one similarity over character n-grams.
 *
 * IT REPLACED A SHARED-PREFIX RULE, on measurement. That rule read
 * PC 1.000 against the judge's own decision list — but that list happened
 * to contain no pair of two INFLECTIONS of one stem, and `deploys` and
 * `deployed` are each an extension of `deploy` while neither is a prefix
 * of the other. Adding four such pairs (and `запущен`/`запущена`) drops
 * the prefix rule to PC 0.870, and it also leaks `port_status` onto
 * `portfolio_value`.
 *
 * Swept over q ∈ {2,3,4}, threshold ∈ [0.40, 0.70] and three paddings —
 * 65 configurations, scored on a live 196-predicate registry (19110
 * pairs) for pairs completeness, reduction ratio, non-match leaks and
 * three Russian inflection pairs. TWELVE get everything right, and they
 * form a connected region rather than a lucky point:
 *
 *   3-gram J>=0.45 unpadded (this)  PC 1.000  RR 0.9893  0 leaks  3/3
 *   3-gram J>=0.60 left-padded      PC 1.000  RR 0.9900  0 leaks  3/3
 *   prefix k=4 (what this replaced) PC 0.870  RR 0.9905  1 leak   3/3
 *   exact token (no morphology)     PC 0.826  RR 0.9919  0 leaks  1/3
 *
 * Unpadded trigrams at 0.45 sit in the middle of the WIDEST contiguous
 * plateau (0.40/0.45/0.50 all perfect), so the choice does not balance on
 * a threshold cliff — and it is the simplest form of the three. The
 * 0.0007 of reduction ratio it gives up against the left-padded variant
 * is twelve candidate pairs out of 19110.
 */
const QGRAM_SIZE = 3;
const QGRAM_JACCARD_MIN = 0.45;

/** Character n-grams of one token, memoized across a pass's comparisons. */
const gramCache = new Map<string, ReadonlySet<string>>();
function grams(token: string): ReadonlySet<string> {
  const hit = gramCache.get(token);
  if (hit) return hit;
  const out = new Set<string>();
  for (let i = 0; i + QGRAM_SIZE <= token.length; i++) {
    out.add(token.slice(i, i + QGRAM_SIZE));
  }
  // A token shorter than q has no n-grams; compare it whole.
  if (out.size === 0) out.add(token);
  if (gramCache.size > 4096) gramCache.clear();
  gramCache.set(token, out);
  return out;
}

/** Same word up to inflection: Jaccard over character n-grams. */
function tokensAlike(a: string, b: string): boolean {
  if (a === b) return true;
  const ga = grams(a);
  const gb = grams(b);
  let intersection = 0;
  for (const g of ga) if (gb.has(g)) intersection += 1;
  if (intersection === 0) return false;
  return intersection / (ga.size + gb.size - intersection) >= QGRAM_JACCARD_MIN;
}

/**
 * Could `candidate` be another name for `predicate`? True when the two
 * share a content token up to inflection. A candidate that fails this
 * is not a rename under any reading, so it never reaches the judge.
 *
 * This is a GATE, not a decision — the judge decides. So it compares
 * loosely on purpose: a generous match only costs one question the
 * model will answer "no" to, while a miss silently drops a real rename.
 */
export function sharesContentToken(predicate: string, candidate: string): boolean {
  const a = contentTokens(predicate);
  if (a.size === 0) return false;
  for (const t of contentTokens(candidate)) {
    for (const u of a) if (tokensAlike(t, u)) return true;
  }
  return false;
}

/**
 * Free-text attribute name → predicate id, so a belief field enters the
 * SAME registry a fact predicate does.
 *
 * The two planes used to name attributes in two different languages: the
 * fact plane in registry ids (`deploy_target`), the belief plane in
 * whatever the scene enricher wrote (`deployment target`, `HTTP service
 * port`). Measured on a live tenant, ZERO of 12 beliefs matched any of
 * 163 distinct fact (subject, predicate) keys, which is why the
 * belief-aware damping pass could not fire once.
 *
 * This is presentation-to-identity, not morphology: lowercase, drop the
 * dotted path segments the enricher sometimes emits (`home.city`), and
 * join the content tokens with `_`. It deliberately shares
 * `contentTokens` with everything else here, so the three-character
 * floor and the pack-namespace rule apply identically on both planes.
 *
 * Token ORDER is the written order, not sorted: `launch_date` and
 * `date_launch` are different coinages, and deciding they are the same
 * attribute is the registry's job (cosine, then the pass), not a
 * normalizer's. Returns '' when nothing survives the floor — the caller
 * then keeps the raw field and simply does not join across planes,
 * which is the behaviour every pre-0147 row already has.
 */
export function predicateIdFromFieldName(field: string): string {
  const bare = field.toLowerCase().replace(/^[a-z0-9]+(?:_[a-z0-9]+)*__/, '');
  const tokens: string[] = [];
  for (const raw of bare.split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length >= 3) tokens.push(raw);
  }
  return tokens.join('_');
}
