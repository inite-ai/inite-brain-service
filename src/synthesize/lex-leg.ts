import type { CoverageLexMode } from '../search/retrieval-profile';
import { topicTerms } from './mention-scan';

/**
 * Lexical (BM25) leg composer shared by the two coverage-first scan
 * lanes (mention-scan over episode_segment, query_arc over
 * knowledge_fact) — V11 audit A2.
 *
 * 'phrase' emits the legacy shape byte-equivalently modulo the added
 * parens: one matcher per indexed field fed the whole topic phrase,
 * scored by the best per-field BM25. Because the matches operator is
 * AND-semantics over analyzed tokens (SurrealDB 3.x), a 2-5 token
 * stripped topic must appear IN FULL for the row to match — which
 * rarely happens, leaving the hybrid pool dense-driven.
 *
 * 'or_terms' rewrites the leg as a bounded disjunction of per-term
 * matchers: a row mentioning ANY topic word is a lexical hit. Scoring
 * is the sum over terms of the best per-field score — disjunctive
 * BM25, so a row covering more topic words ranks higher, and the
 * per-field max preserves the legacy "better of the two indexes"
 * semantics on knowledge_fact (object stays the narrower surface).
 *
 * Stand-verified semantics this composer leans on (3.2.1):
 *  - match refs must be UNIQUE per query — a duplicated ref binds
 *    scoring to the last matcher and zeroes the others;
 *  - search::score(N) is 0.0 (not NONE) on rows that matched only
 *    other refs, so math::sum needs no NONE-guard;
 *  - 16 refs in one WHERE plan and score fine.
 */

/** Per-term bound: topics strip to 2-5 tokens; 8 keeps the ref count
 *  at ≤16 even on the two-field fact leg (the probed ceiling). */
const LEX_TERM_CAP = 8;

export interface LexMatchLeg {
  /** Parenthesized WHERE fragment, e.g. `(text @1@ $t0 OR …)`. */
  where: string;
  /** Score projection expression (no alias). */
  score: string;
  /** Bind params the fragment references ($topic or $t0…$tN). */
  params: Record<string, string>;
}

/**
 * Compose the lexical leg for `fields` (one matcher per field per
 * term; index refs assigned left-to-right starting at 1). 'or_terms'
 * with a topic that strips to zero terms falls back to the phrase
 * shape — the raw topic is all there is to match.
 */
export function buildLexMatchLeg(opts: {
  fields: readonly string[];
  topic: string;
  mode: CoverageLexMode;
}): LexMatchLeg {
  const { fields, topic, mode } = opts;
  const terms = mode === 'or_terms' ? topicTerms(topic).slice(0, LEX_TERM_CAP) : [];
  if (terms.length === 0) {
    const matchers = fields.map((f, j) => `${f} @${j + 1}@ $topic`);
    const scores = fields.map((_, j) => `search::score(${j + 1})`);
    return {
      where: `(${matchers.join(' OR ')})`,
      score: scores.length === 1 ? scores[0] : `math::max([${scores.join(', ')}])`,
      params: { topic },
    };
  }
  const matchers: string[] = [];
  const perTerm: string[] = [];
  const params: Record<string, string> = {};
  terms.forEach((term, i) => {
    params[`t${i}`] = term;
    const scores = fields.map((f, j) => {
      const ref = i * fields.length + j + 1;
      matchers.push(`${f} @${ref}@ $t${i}`);
      return `search::score(${ref})`;
    });
    perTerm.push(
      scores.length === 1 ? scores[0] : `math::max([${scores.join(', ')}])`,
    );
  });
  return {
    where: `(${matchers.join(' OR ')})`,
    score: `math::sum([${perTerm.join(', ')}])`,
    params,
  };
}
