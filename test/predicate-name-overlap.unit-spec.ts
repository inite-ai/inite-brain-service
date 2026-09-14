import {
  contentTokens,
  sharesContentToken,
} from '../src/ai/predicate-registry-internals/predicate-name-overlap';

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

  it('stems plurals and participles, which is what carries deploy ~ deployed', () => {
    expect(sharesContentToken('deploy_target', 'deployed_to')).toBe(true);
    expect(sharesContentToken('deploys', 'deploying_to')).toBe(true);
  });

  it('does NOT stem derivations — the documented field-fold limitation', () => {
    // 'deployment' is not reachable from 'deploy' by stripping a
    // plural/participle ending, and inventing a stemmer that does would
    // start matching things that merely rhyme.
    expect(sharesContentToken('deploy_target', 'deployment_home')).toBe(false);
  });

  it('never matches on structural words alone', () => {
    expect(sharesContentToken('reports_to', 'belongs_to')).toBe(false);
    expect(sharesContentToken('is_a_thing', 'is_the_other')).toBe(false);
  });

  it('never matches on a namespace prefix alone', () => {
    // `code_memory__owns` ~ `code_memory__gotcha` share the pack
    // namespace and nothing else; that must not read as a rename.
    expect(sharesContentToken('code_memory__owns', 'code_memory__gotcha')).toBe(false);
    expect(sharesContentToken('code_memory__owns', 'owns')).toBe(true);
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
