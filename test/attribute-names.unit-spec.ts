import { contentTokens, sharesContentToken } from '../src/common/attribute-names';

/**
 * The shared-content-token guard, pinned against what the identity judge
 * ACTUALLY decided on a live memory-fitness tenant.
 *
 * With the judge shortlisting purely on cosine, one battery run produced
 * 21 merges. Nineteen were renames of one attribute. Two were not:
 * `decided` → `fixed_retry_policy` and `replaces` → `superseded_by` —
 * pairs sharing no word at all, where the judge had read the coinage's
 * example use and answered about the STATEMENT rather than the NAME.
 * The first is the dangerous one: `fixed_retry_policy` is single_active,
 * so every subsequent "X decided Y" fact would land in that slot and
 * supersede the one before it.
 *
 * The rule this file encodes is that a rename shares a word with what it
 * renames. The fixtures below are that run's own decision list, so the
 * guard is measured against real behaviour rather than invented cases.
 */

/** Merges from the live run that the guard must let through. */
const REAL_RENAMES: Array<[string, string]> = [
  ['deploy_target', 'deploys'],
  ['deploys_to', 'deploys'],
  ['queue_backend', 'job_queue_backend'],
  ['uses_backend', 'job_queue_backend'],
  ['changed_launch_date', 'pilot_launch_date'],
  ['launch_date', 'pilot_launch_date'],
  ['retry_policy', 'fixed_retry_policy'],
  ['fixed_retry_change', 'fixed_retry_policy'],
  ['replaced_policy', 'fixed_retry_policy'],
  ['payout_cutoff', 'payout_cutoff_time'],
  ['cutoff_time', 'payout_cutoff_time'],
  ['clarified_duplicate_payout', 'duplicate_payout'],
  ['identified_bug', 'has_bug'],
  ['informed_by', 'informed_about'],
  ['listens_on_port', 'listens_on'],
  ['owns', 'code_memory__owns'],
  ['shipped_fix', 'shipped'],
  ['tripped_rate_limit', 'rate_limit'],
  ['writes_new_decision_with_date', 'records_decision_as'],
];

/** Merges from the same run that the guard must cut off. */
const REAL_BAD_MERGES: Array<[string, string]> = [
  ['decided', 'fixed_retry_policy'],
  ['replaces', 'superseded_by'],
];

describe('sharesContentToken — the live decision list', () => {
  it.each(REAL_RENAMES)('keeps %s ~ %s', (a, b) => {
    expect(sharesContentToken(a, b)).toBe(true);
  });

  it.each(REAL_BAD_MERGES)('CUTS %s ~ %s', (a, b) => {
    expect(sharesContentToken(a, b)).toBe(false);
  });
});

describe('sharesContentToken — the rule itself', () => {
  it('is symmetric', () => {
    expect(sharesContentToken('deploys_to', 'deploy_target')).toBe(
      sharesContentToken('deploy_target', 'deploys_to'),
    );
  });

  it('reaches a derivation too — the gate is allowed to be generous', () => {
    // `deploy` ~ `deployment` share a 6-char prefix. Under the old
    // suffix table this was a documented MISS; as a gate it should be a
    // hit, because the only cost is one question the judge answers.
    expect(sharesContentToken('deploy_target', 'deployment_home')).toBe(true);
  });

  // No stemming, in either direction: tokens are kept as written, and
  // the GATE tolerates inflection by shared prefix instead. A hand-
  // written English suffix table used to live here; it mangled `status`
  // into `statu`, and it did nothing at all for a tenant whose enricher
  // names fields in another language.
  it.each([
    ['status', ['status']],
    ['address', ['address']],
    ['deploys_to', ['deploys']],
    ['payout_cutoff_time', ['payout', 'cutoff', 'time']],
    ['адрес_офиса', ['адрес', 'офиса']],
  ])('tokenizes %p to %p, unstemmed', (input, tokens) => {
    expect([...contentTokens(input as string)]).toEqual(tokens);
  });

  it('matches across inflection by shared prefix, in any language', () => {
    expect(sharesContentToken('deploy_target', 'deploys')).toBe(true);
    expect(sharesContentToken('deploy_target', 'deployed_to')).toBe(true);
    expect(sharesContentToken('deploy_target', 'deploying_to')).toBe(true);
    expect(sharesContentToken('адрес_офиса', 'адреса_компании')).toBe(true);
  });

  it('a three-letter prefix is NOT enough — car must not reach career', () => {
    expect(sharesContentToken('car_owner', 'career_path')).toBe(false);
  });

  it('never matches on structural words alone', () => {
    expect(sharesContentToken('reports_to', 'belongs_to')).toBe(false);
    expect(sharesContentToken('is_a_thing', 'is_the_other')).toBe(false);
  });

  it('never matches on a pack namespace alone', () => {
    // `code_memory__owns` ~ `code_memory__gotcha` share the pack
    // namespace and nothing else; that must not read as a rename.
    expect(sharesContentToken('code_memory__owns', 'code_memory__gotcha')).toBe(false);
    expect(sharesContentToken('code_memory__owns', 'owns')).toBe(true);
  });

  it('strips the namespace without blanking its words elsewhere', () => {
    // The prefix is dropped as a PREFIX, not stoplisted — a predicate
    // that genuinely talks about memory or code keeps that word.
    expect(sharesContentToken('memory_limit', 'memory_budget')).toBe(true);
    expect(sharesContentToken('code_owner', 'code_reviewer')).toBe(true);
    expect(sharesContentToken('code_memory__decided', 'memory_limit')).toBe(false);
  });

  it('drops tokens under three characters', () => {
    expect(contentTokens('v2_id_ok')).toEqual(new Set());
    expect(sharesContentToken('port_id', 'queue_id')).toBe(false);
  });

  it('an empty or punctuation-only name shares nothing', () => {
    expect(sharesContentToken('', 'queue_backend')).toBe(false);
    expect(sharesContentToken('__', 'queue_backend')).toBe(false);
  });
});

/**
 * The gate is BLOCKING, and it is measured the way blocking is measured.
 *
 * Naming it matters: "which pairs are worth comparing expensively" is a
 * surveyed problem in entity resolution (Papadakis et al., *A Survey of
 * Blocking and Filtering Techniques for Entity Resolution*), and this
 * rule is one of its standard schemes — token blocking with a
 * prefix-match predicate — not an invention. Its metrics are the
 * standard ones:
 *
 *   PC (pairs completeness) = known matches kept / known matches
 *   RR (reduction ratio)    = 1 − candidates / all pairs
 *
 * Measured over a live 196-predicate registry (19110 pairs) against the
 * judge's own decision list, alongside the textbook alternative:
 *
 *   exact token (no morphology)   PC 0.947   RR 0.9919   RU 1/2
 *   prefix k=4 (this rule)        PC 1.000   RR 0.9905   RU 2/2
 *   trigram Jaccard >= 0.7        PC 1.000   RR 0.9904   RU 2/2
 *   trigram Jaccard >= 0.6        PC 1.000   RR 0.9900   RU 2/2
 *
 * q-gram blocking — the standard language-agnostic answer to inflection
 * — ties on this data and costs a SECOND parameter (q and a threshold)
 * for no measured gain, so the one-parameter form stays. Dropping
 * morphology altogether does not: exact token loses a real rename and
 * half the Russian cases.
 *
 * LIMITATION, stated so nobody reads PC 1.000 as more than it is: the
 * 19 known matches are pairs a cosine shortlist already surfaced and
 * the judge accepted. Pairs cosine never surfaced cannot appear in this
 * ground truth, so PC here measures the gate GIVEN retrieval, not
 * end-to-end recall.
 */
describe('sharesContentToken — blocking metrics', () => {
  const TRUE_MATCH = REAL_RENAMES;
  const TRUE_NON_MATCH = REAL_BAD_MERGES;

  it('keeps every known match (PC = 1.0)', () => {
    const kept = TRUE_MATCH.filter(([a, b]) => sharesContentToken(a, b)).length;
    expect(kept / TRUE_MATCH.length).toBe(1);
  });

  it('cuts every known non-match', () => {
    expect(TRUE_NON_MATCH.filter(([a, b]) => sharesContentToken(a, b))).toEqual([]);
  });

  it('tolerates inflection in a language no suffix table covers', () => {
    // The reason the rule is a prefix and not a stemmer: it is the same
    // rule in every language, including the ones the enricher will name
    // belief fields in.
    expect(sharesContentToken('адрес_офиса', 'адреса_компании')).toBe(true);
    expect(sharesContentToken('очередь_задач', 'очереди_задач')).toBe(true);
  });

  it('a shorter prefix would collapse unrelated words — why k is 4', () => {
    // k=3 lets `car` reach `career`, which is the failure the constant
    // exists to prevent; k=4 is the smallest value that does not.
    expect(sharesContentToken('car_owner', 'career_path')).toBe(false);
    expect(sharesContentToken('deploy_target', 'deploys')).toBe(true);
  });
});
