import { buildLexMatchLeg } from '../src/synthesize/lex-leg';
import {
  resolveRetrievalProfile,
  resolveRetrievalProfileFor,
} from '../src/search/retrieval-profile';

/**
 * V11 audit A2 — the lexical-leg OR-rewrite. The matches operator is
 * AND-semantics over analyzed tokens (every query token must appear in
 * the row), so multi-word topics under the legacy phrase shape rarely
 * fire. 'or_terms' turns the leg into a bounded disjunction of
 * per-term matchers with UNIQUE refs (a duplicated ref binds scoring
 * to the last matcher — stand-verified), scored as the sum over terms
 * of the best per-field BM25.
 */

describe('buildLexMatchLeg — phrase (legacy shape)', () => {
  it('single field: one matcher, one score ref', () => {
    const leg = buildLexMatchLeg({
      fields: ['text'],
      topic: 'parser project',
      mode: 'phrase',
    });
    expect(leg.where).toBe('(text @1@ $topic)');
    expect(leg.score).toBe('search::score(1)');
    expect(leg.params).toEqual({ topic: 'parser project' });
  });

  it('two fields: per-field matchers combined with max', () => {
    const leg = buildLexMatchLeg({
      fields: ['searchHaystack', 'object'],
      topic: 'parser project',
      mode: 'phrase',
    });
    expect(leg.where).toBe('(searchHaystack @1@ $topic OR object @2@ $topic)');
    expect(leg.score).toBe('math::max([search::score(1), search::score(2)])');
    expect(leg.params).toEqual({ topic: 'parser project' });
  });
});

describe('buildLexMatchLeg — or_terms', () => {
  it('single field: one matcher per term, unique refs, summed scores', () => {
    const leg = buildLexMatchLeg({
      fields: ['text'],
      topic: 'the parser project',
      mode: 'or_terms',
    });
    expect(leg.where).toBe('(text @1@ $t0 OR text @2@ $t1)');
    expect(leg.score).toBe('math::sum([search::score(1), search::score(2)])');
    expect(leg.params).toEqual({ t0: 'parser', t1: 'project' });
  });

  it('two fields: per-term best-field max inside the sum', () => {
    const leg = buildLexMatchLeg({
      fields: ['searchHaystack', 'object'],
      topic: 'parser project',
      mode: 'or_terms',
    });
    expect(leg.where).toBe(
      '(searchHaystack @1@ $t0 OR object @2@ $t0 OR ' +
        'searchHaystack @3@ $t1 OR object @4@ $t1)',
    );
    expect(leg.score).toBe(
      'math::sum([math::max([search::score(1), search::score(2)]), ' +
        'math::max([search::score(3), search::score(4)])])',
    );
    expect(leg.params).toEqual({ t0: 'parser', t1: 'project' });
  });

  it('refs never repeat across the whole disjunction', () => {
    const leg = buildLexMatchLeg({
      fields: ['searchHaystack', 'object'],
      topic: 'alpha bravo charlie delta echo',
      mode: 'or_terms',
    });
    const refs = [...leg.where.matchAll(/@(\d+)@/g)].map((m) => m[1]);
    expect(new Set(refs).size).toBe(refs.length);
    expect(refs).toHaveLength(10); // 5 terms × 2 fields
  });

  it('bounds the term count (8 terms → ≤16 refs on the two-field leg)', () => {
    const topic = Array.from({ length: 20 }, (_, i) => `term${i}word`).join(
      ' ',
    );
    const leg = buildLexMatchLeg({ fields: ['text'], topic, mode: 'or_terms' });
    expect(Object.keys(leg.params)).toHaveLength(8);
  });

  it('falls back to the phrase shape when the topic strips to nothing', () => {
    const leg = buildLexMatchLeg({
      fields: ['text'],
      topic: 'the of an',
      mode: 'or_terms',
    });
    expect(leg.where).toBe('(text @1@ $topic)');
    expect(leg.params).toEqual({ topic: 'the of an' });
  });
});

describe('coverageLexMode profile point', () => {
  it('defaults to the legacy phrase shape', () => {
    expect(
      resolveRetrievalProfile({} as NodeJS.ProcessEnv).coverageLexMode,
    ).toBe('phrase');
  });

  it('round-trips through the env', () => {
    expect(
      resolveRetrievalProfile({
        RETRIEVAL_COVERAGE_LEX_MODE: 'or_terms',
      } as NodeJS.ProcessEnv).coverageLexMode,
    ).toBe('or_terms');
  });

  it('overlays per tenant', () => {
    const env = {
      RETRIEVAL_PROFILE_OVERRIDES: JSON.stringify({
        bigco: { coverageLexMode: 'or_terms' },
      }),
    } as NodeJS.ProcessEnv;
    expect(resolveRetrievalProfileFor('bigco', env).coverageLexMode).toBe(
      'or_terms',
    );
    expect(resolveRetrievalProfileFor('other', env).coverageLexMode).toBe(
      'phrase',
    );
  });
});
