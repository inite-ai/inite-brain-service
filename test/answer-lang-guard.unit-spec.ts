/**
 * Unit spec — multilingual Tier 5 answer-language guard (pure helpers).
 *
 * Covers the two pure pieces of the guard:
 *   - resolveAnswerLang: the OFF path is byte-identical to the historical
 *     explicit→detect→null behaviour; the ON path follows the strict fallback
 *     ORDER explicit → session locale → confidently-detected query language →
 *     no forced language (so the FACTS never decide the answer language).
 *   - answerLanguageMismatch: the output-language check — cross-script only,
 *     confidence-gated, und/proper-noun/numeric-safe.
 *
 * The service-level ONE-shot corrective regeneration is an integration
 * concern (it re-calls the LLM) and is exercised end-to-end elsewhere; the
 * OFF-path no-op is guaranteed here structurally — answerLanguageMismatch is
 * only ever consulted when profile.answerLangGuard is on.
 */
import {
  answerLanguageMismatch,
  enforceAnswerLanguage,
  resolveAnswerLang,
} from '../src/synthesize/synthesize.helpers';
import type { SynthesizeDto } from '../src/synthesize/dto/synthesize.dto';
import type { GeneratorOutput } from '../src/synthesize/synthesize.types';

const dto = (fields: Partial<SynthesizeDto> & { query: string }): SynthesizeDto =>
  fields as SynthesizeDto;

const RU = 'Привет, как у тебя дела сегодня вечером';
const EN = 'the user lives in paris and works as an engineer at the company';
// A Latin query with a single stopword hit ⇒ detected en at confidence 0.2
// (< the 0.3 floor), independent of MULTILINGUAL_LANG_ATTRIBUTION (bestScore
// is > 0, so attribution never forces `und`).
const LOW_CONF_LATIN = 'zzz the qqq www eee';

describe('resolveAnswerLang — OFF (byte-identical historical behaviour)', () => {
  it('explicit answerLang always wins', () => {
    expect(resolveAnswerLang(dto({ query: RU, answerLang: 'de' }))).toBe('de');
  });

  it('detects the query language when no explicit value', () => {
    expect(resolveAnswerLang(dto({ query: RU }))).toBe('ru');
  });

  it('returns null when the detector is undecided (und)', () => {
    expect(resolveAnswerLang(dto({ query: '42 42 42' }))).toBeNull();
  });

  it('returns a LOW-confidence detection unchanged (no confidence gate off)', () => {
    // The whole point of contrast with the guard: off, any non-und wins.
    expect(resolveAnswerLang(dto({ query: LOW_CONF_LATIN }))).toBe('en');
  });

  it('ignores a session locale when the guard is off', () => {
    expect(resolveAnswerLang(dto({ query: RU, queryLang: 'en' }))).toBe('ru');
  });
});

describe('resolveAnswerLang — ON (Tier 5 fallback ordering)', () => {
  // The guard flag lives on the resolved RetrievalProfile; the session locale
  // is dto.queryLang.
  const on = { answerLangGuard: true };

  it('1) explicit answerLang wins over everything', () => {
    expect(resolveAnswerLang(dto({ query: RU, answerLang: 'de', queryLang: 'fr' }), on)).toBe('de');
  });

  it('2) session locale (dto.queryLang) beats a confident query detection', () => {
    expect(resolveAnswerLang(dto({ query: RU, queryLang: 'en' }), on)).toBe('en');
  });

  it('2) session locale is normalised (case + region tag stripped)', () => {
    expect(resolveAnswerLang(dto({ query: RU, queryLang: 'EN-US' }), on)).toBe('en');
    expect(resolveAnswerLang(dto({ query: RU, queryLang: 'pt_BR' }), on)).toBe('pt');
  });

  it('2) an unusable session locale falls through to detection', () => {
    expect(resolveAnswerLang(dto({ query: RU, queryLang: '123' }), on)).toBe('ru');
    expect(resolveAnswerLang(dto({ query: RU, queryLang: '' }), on)).toBe('ru');
  });

  it('3) a CONFIDENT query detection is used when no explicit / no locale', () => {
    expect(resolveAnswerLang(dto({ query: RU }), on)).toBe('ru');
  });

  it('4) a LOW-confidence detection forces NO language (null)', () => {
    expect(resolveAnswerLang(dto({ query: LOW_CONF_LATIN }), on)).toBeNull();
  });

  it('4) an undecided query forces no language (null)', () => {
    expect(resolveAnswerLang(dto({ query: '42 42 42' }), on)).toBeNull();
  });
});

describe('answerLanguageMismatch — output-language check (cross-script)', () => {
  it('flags a Latin answer against a Cyrillic target', () => {
    expect(answerLanguageMismatch(EN, 'ru')).toBe(true);
  });

  it('flags a Cyrillic answer against a Latin target', () => {
    expect(answerLanguageMismatch(RU, 'en')).toBe(true);
  });

  it('does NOT flag a matching-script answer', () => {
    expect(answerLanguageMismatch(RU, 'ru')).toBe(false);
    expect(answerLanguageMismatch(EN, 'en')).toBe(false);
  });

  it('does NOT adjudicate within-script (es answer vs en target)', () => {
    const ES = 'el usuario vive en la ciudad de madrid con su familia y su perro';
    expect(answerLanguageMismatch(ES, 'en')).toBe(false);
  });

  it('is safe on proper-noun / numeric / empty answers (und or low-confidence)', () => {
    expect(answerLanguageMismatch('Paris', 'ru')).toBe(false);
    expect(answerLanguageMismatch('42', 'ru')).toBe(false);
    expect(answerLanguageMismatch('', 'ru')).toBe(false);
    expect(answerLanguageMismatch('   ', 'ru')).toBe(false);
  });

  it('maps region-tagged / cased targets to their canonical script', () => {
    expect(answerLanguageMismatch(EN, 'RU-ru')).toBe(true);
    expect(answerLanguageMismatch(RU, 'EN')).toBe(true);
  });

  it('respects the confidence floor', () => {
    // A single-stopword Latin string is below the default floor ⇒ not a
    // mismatch even against a Cyrillic target; forcing the floor to 0 makes
    // it one.
    expect(answerLanguageMismatch(LOW_CONF_LATIN, 'ru')).toBe(false);
    expect(answerLanguageMismatch(LOW_CONF_LATIN, 'ru', 0)).toBe(true);
  });
});

describe('enforceAnswerLanguage — bounded corrective retry', () => {
  const gen = (answer: string): GeneratorOutput => ({ answer, citedFactIds: [] });
  const makeDeps = () => {
    const countSynthesize = jest.fn();
    const warn = jest.fn();
    return {
      deps: { metrics: { countSynthesize } as never, logger: { warn } },
      countSynthesize,
      warn,
    };
  };

  it('OFF (guard false) is a no-op — never regenerates, returns null', async () => {
    const { deps, countSynthesize } = makeDeps();
    const regenerate = jest.fn(async () => gen(RU));
    const out = await enforceAnswerLanguage(
      deps,
      { guard: false, target: 'ru', answer: EN },
      regenerate,
    );
    expect(out).toBeNull();
    expect(regenerate).not.toHaveBeenCalled();
    expect(countSynthesize).not.toHaveBeenCalled();
  });

  it('no forced target ⇒ no-op', async () => {
    const { deps } = makeDeps();
    const regenerate = jest.fn(async () => gen(RU));
    expect(
      await enforceAnswerLanguage(deps, { guard: true, target: null, answer: EN }, regenerate),
    ).toBeNull();
    expect(regenerate).not.toHaveBeenCalled();
  });

  it('a matching-language answer ⇒ no-op (no retry)', async () => {
    const { deps, countSynthesize } = makeDeps();
    const regenerate = jest.fn(async () => gen(RU));
    expect(
      await enforceAnswerLanguage(deps, { guard: true, target: 'ru', answer: RU }, regenerate),
    ).toBeNull();
    expect(regenerate).not.toHaveBeenCalled();
    expect(countSynthesize).not.toHaveBeenCalled();
  });

  it('a mismatch regenerates ONCE and returns the corrected answer', async () => {
    const { deps, countSynthesize, warn } = makeDeps();
    const corrected = gen(RU);
    const regenerate = jest.fn(async () => corrected);
    const out = await enforceAnswerLanguage(
      deps,
      { guard: true, target: 'ru', answer: EN },
      regenerate,
    );
    expect(out).toBe(corrected);
    expect(regenerate).toHaveBeenCalledTimes(1);
    expect(countSynthesize).toHaveBeenCalledWith('answer_lang_retry');
    expect(countSynthesize).not.toHaveBeenCalledWith('answer_lang_unresolved');
    expect(warn).not.toHaveBeenCalled();
  });

  it('a STILL-wrong retry is flagged and returned best-effort (bounded: one retry)', async () => {
    const { deps, countSynthesize, warn } = makeDeps();
    const stillWrong = gen(EN);
    const regenerate = jest.fn(async () => stillWrong);
    const out = await enforceAnswerLanguage(
      deps,
      { guard: true, target: 'ru', answer: EN },
      regenerate,
    );
    expect(out).toBe(stillWrong);
    expect(regenerate).toHaveBeenCalledTimes(1); // never twice
    expect(countSynthesize).toHaveBeenCalledWith('answer_lang_retry');
    expect(countSynthesize).toHaveBeenCalledWith('answer_lang_unresolved');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('a regeneration failure keeps the original (returns null) and logs', async () => {
    const { deps, warn } = makeDeps();
    const regenerate = jest.fn(async () => {
      throw new Error('boom');
    });
    const out = await enforceAnswerLanguage(
      deps,
      { guard: true, target: 'ru', answer: EN },
      regenerate,
    );
    expect(out).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
