/**
 * MULTILINGUAL_LANG_FILTER_CONFIDENCE_GATE — confidence gate on the
 * hard same-language search exclusion (search.service hardLangFilterFor
 * + retrieval-profile tuning resolution).
 *
 * Measured failure being pinned (code-memory battery k07): the scorer
 * query "acme-api webhooks rate limit" carries ZERO stopword evidence,
 * so the detector's Phase-4 fallback labels it `en` with confidence 0 —
 * and the hard `lang = 'en' OR lang IS NONE` exclusion then hid the
 * `rate_limit: 120 requests per minute` fact, which had been stamped
 * `it` at write time off the lone Italian stopword "per" (confidence
 * 0.33). The fact ranked #1 by raw cosine (the INGEST_PREDICATE_INDEX_TEXT
 * humanized embedding worked) and was excluded purely by language — on a
 * query that expressed no language at all. Verified live: the same
 * search with `disableLangFilter: true` served both rate_limit facts.
 *
 * Gate ON ⇒ the hard exclusion requires the SAME high-confidence floor
 * the Tier-1 soft boost trusts (0.5); below it the pass is single and
 * unfiltered. Gate OFF (default) ⇒ any non-`und` detection filters —
 * byte-identical legacy behaviour.
 */
import { detectLanguage } from '../src/ai/locale/language-detector';
import { resolveSearchTuning } from '../src/search/retrieval-profile';
import { hardLangFilterFor } from '../src/search/search.service';

describe('hardLangFilterFor', () => {
  it('no signal ⇒ no filter, gate irrelevant', () => {
    expect(hardLangFilterFor(undefined, false)).toBeUndefined();
    expect(hardLangFilterFor(undefined, true)).toBeUndefined();
  });

  it('gate OFF ⇒ any non-und signal filters (legacy, byte-identical)', () => {
    expect(hardLangFilterFor({ lang: 'en', confidence: 0 }, false)).toBe('en');
    expect(hardLangFilterFor({ lang: 'it', confidence: 0.2 }, false)).toBe('it');
  });

  it('gate ON ⇒ a below-floor signal never hard-filters', () => {
    expect(hardLangFilterFor({ lang: 'en', confidence: 0 }, true)).toBeUndefined();
    expect(hardLangFilterFor({ lang: 'it', confidence: 0.49 }, true)).toBeUndefined();
  });

  it('gate ON ⇒ a confident signal still filters (floor 0.5, inclusive)', () => {
    expect(hardLangFilterFor({ lang: 'en', confidence: 0.5 }, true)).toBe('en');
    // Explicit dto.queryLang is resolved at confidence 1 upstream — it
    // always clears the gate.
    expect(hardLangFilterFor({ lang: 'ru', confidence: 1 }, true)).toBe('ru');
  });

  it('k07 regression shape: the measured query/fact pair stops mis-excluding', () => {
    // The scorer query has no stopword evidence: Phase-4 fallback en@0.
    const query = detectLanguage('acme-api webhooks rate limit', false);
    expect(query.language).toBe('en');
    expect(query.confidence).toBe(0);
    // The write side stamped the fact `it` off one stopword ("per") —
    // the mislabel that made the en-filter a recall bug.
    const fact = detectLanguage('120 requests per minute', false);
    expect(fact.language).toBe('it');
    expect(fact.confidence).toBeLessThan(0.5);
    // Legacy: the zero-evidence query hard-filters to en and hides the
    // it-labeled fact. Gated: no filter — the fact stays retrievable.
    expect(hardLangFilterFor({ lang: query.language, confidence: query.confidence }, false)).toBe(
      'en',
    );
    expect(
      hardLangFilterFor({ lang: query.language, confidence: query.confidence }, true),
    ).toBeUndefined();
  });
});

describe('resolveSearchTuning.langFilterConfidenceGate', () => {
  it('defaults off; env flag flips it', () => {
    expect(resolveSearchTuning({} as NodeJS.ProcessEnv).langFilterConfidenceGate).toBe(false);
    expect(
      resolveSearchTuning({
        MULTILINGUAL_LANG_FILTER_CONFIDENCE_GATE: '1',
      } as NodeJS.ProcessEnv).langFilterConfidenceGate,
    ).toBe(true);
  });
});
