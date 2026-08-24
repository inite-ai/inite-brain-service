/**
 * Multilingual Tier 3 — CJK segmentation (MULTILINGUAL_CJK_SEGMENTATION).
 *
 * topicTerms defaults to the byte-identical legacy split (CJK chars are
 * separators → nothing). With segmentCjk=true it uses the Intl.Segmenter
 * built-in (ICU-backed, no new dependency) so CJK text yields real terms.
 * The flag is resolved into RetrievalProfile.cjkSegmentation at the profile
 * boundary; the pure topicTerms takes the resolved boolean.
 */
import { topicTerms } from '../src/synthesize/mention-scan';
import { resolveRetrievalProfile } from '../src/search/retrieval-profile';

describe('topicTerms — CJK segmentation OFF (default, byte-identical)', () => {
  it('drops CJK to nothing exactly as the legacy split does', () => {
    // 北京 → separators under /[^a-z0-9а-яё]+/i, only the ASCII word survives.
    expect(topicTerms('北京 feature')).toEqual(['feature']);
  });

  it('the default arg equals an explicit false (no drift)', () => {
    for (const q of ['北京 feature', 'the autocomplete feature of my app', '東京タワー']) {
      expect(topicTerms(q, false)).toEqual(topicTerms(q));
    }
  });

  it('keeps existing Latin/Cyrillic behavior unchanged', () => {
    expect(topicTerms('the autocomplete feature')).toEqual(
      expect.arrayContaining(['autocomplete', 'feature']),
    );
    expect(topicTerms('the autocomplete feature')).not.toContain('the');
  });
});

describe('topicTerms — CJK segmentation ON', () => {
  it('segments CJK into real terms instead of dropping them', () => {
    const terms = topicTerms('北京 feature', true);
    expect(terms).toEqual(expect.arrayContaining(['北京', 'feature']));
  });

  it('segments Japanese (no spaces) into multiple terms', () => {
    // 東京タワー ("Tokyo Tower") is space-free; the legacy split yields
    // nothing, the segmenter yields ICU word units.
    const terms = topicTerms('東京タワー', true);
    expect(terms.length).toBeGreaterThan(0);
    expect(terms.join('')).toContain('東京');
  });

  it('still drops Latin glue and short tokens under the ASCII ≥3 rule', () => {
    const terms = topicTerms('the 北京 app', true);
    expect(terms).toContain('北京');
    expect(terms).not.toContain('the'); // TERM_STOP
  });
});

describe('MULTILINGUAL_CJK_SEGMENTATION → RetrievalProfile.cjkSegmentation', () => {
  it('defaults off and round-trips through the profile resolver', () => {
    expect(resolveRetrievalProfile({} as NodeJS.ProcessEnv).cjkSegmentation).toBe(false);
    expect(
      resolveRetrievalProfile({
        MULTILINGUAL_CJK_SEGMENTATION: '1',
      } as NodeJS.ProcessEnv).cjkSegmentation,
    ).toBe(true);
    expect(
      resolveRetrievalProfile({
        MULTILINGUAL_CJK_SEGMENTATION: '0',
      } as NodeJS.ProcessEnv).cjkSegmentation,
    ).toBe(false);
  });
});
