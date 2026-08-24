/**
 * Deterministic, dependency-free language detector for the seven matrix
 * languages. NOT a production detector — it exists so the stubbed harness
 * can turn a generated answer string into a detected-language label and
 * feed the answer-language-correctness metric end to end without a model
 * call. Tier 1 replaces this with the real detector; the metric contract
 * (a detected ISO 639-1 label + confidence) stays the same.
 *
 * Strategy: the non-Latin scripts are unambiguous by Unicode block
 * (Cyrillic→ru, Han→zh, Arabic→ar, Devanagari→hi). Latin text is
 * disambiguated among en/de/es by a tiny stopword vote — enough for the
 * canned answer strings the stub emits.
 */

import type { LanguageCode } from '../../../src/eval/types';

export interface ScriptDetection {
  /** ISO 639-1 code, or 'und' when the text is empty / unrecognized. */
  lang: LanguageCode | 'und';
  /** Coarse script class the decision rested on. */
  script: 'cyrillic' | 'han' | 'arabic' | 'devanagari' | 'latin' | 'none';
  /** 0..1 — dominant-script share, or the stopword-vote margin for Latin. */
  confidence: number;
}

const SCRIPT_RANGES: Array<{ script: ScriptDetection['script']; lang: LanguageCode; re: RegExp }> =
  [
    { script: 'cyrillic', lang: 'ru', re: /[Ѐ-ӿ]/g },
    { script: 'han', lang: 'zh', re: /[一-鿿]/g },
    { script: 'arabic', lang: 'ar', re: /[؀-ۿ]/g },
    { script: 'devanagari', lang: 'hi', re: /[ऀ-ॿ]/g },
  ];

const LATIN_RE = /[A-Za-zÀ-ɏ]/g;

const LATIN_STOPWORDS: Record<'en' | 'de' | 'es', Set<string>> = {
  en: new Set(['the', 'is', 'are', 'who', 'of', 'and', 'our', 'head', 'leads']),
  de: new Set(['der', 'die', 'das', 'und', 'ist', 'wer', 'unser', 'leiter']),
  es: new Set(['el', 'la', 'de', 'y', 'quien', 'es', 'nuestro', 'director']),
};

function countMatches(text: string, re: RegExp): number {
  return text.match(re)?.length ?? 0;
}

function voteLatin(text: string): ScriptDetection {
  const words = text
    .toLowerCase()
    .split(/[^a-zÀ-ɏ]+/)
    .filter(Boolean);
  const scores: Record<'en' | 'de' | 'es', number> = { en: 0, de: 0, es: 0 };
  for (const w of words) {
    if (LATIN_STOPWORDS.en.has(w)) scores.en++;
    if (LATIN_STOPWORDS.de.has(w)) scores.de++;
    if (LATIN_STOPWORDS.es.has(w)) scores.es++;
  }
  const langs: Array<'en' | 'de' | 'es'> = ['en', 'de', 'es'];
  langs.sort((a, b) => scores[b] - scores[a]);
  const winner = langs[0]!;
  const total = scores.en + scores.de + scores.es;
  // No stopword hit at all → default to English with low confidence.
  if (total === 0) return { lang: 'en', script: 'latin', confidence: 0.5 };
  return { lang: winner, script: 'latin', confidence: scores[winner] / total };
}

export function detectLanguage(text: string): ScriptDetection {
  if (text.trim().length === 0) return { lang: 'und', script: 'none', confidence: 0 };

  const counts = SCRIPT_RANGES.map((s) => ({ ...s, count: countMatches(text, s.re) }));
  const latinCount = countMatches(text, LATIN_RE);
  const totalScript = counts.reduce((a, s) => a + s.count, 0) + latinCount;
  if (totalScript === 0) return { lang: 'und', script: 'none', confidence: 0 };

  const topNonLatin = counts.reduce((best, s) => (s.count > best.count ? s : best), {
    count: 0,
    lang: 'en' as LanguageCode,
    script: 'none' as ScriptDetection['script'],
    re: LATIN_RE,
  });

  if (topNonLatin.count >= latinCount && topNonLatin.count > 0) {
    return {
      lang: topNonLatin.lang,
      script: topNonLatin.script,
      confidence: topNonLatin.count / totalScript,
    };
  }
  return voteLatin(text);
}
