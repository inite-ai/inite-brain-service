import type { LanguageCode } from '../../../src/eval/types';
import { detectLanguage as brainDetect } from '../../../src/ai/locale/language-detector';

/**
 * The matrix's answer-language reading — the BRAIN's detector, narrowed
 * to the matrix's seven languages.
 *
 * This file used to be a second detector of its own: script ranges
 * counted by character, then a nine-word stopword vote for Latin. It
 * called a Chinese answer English because the answer plane appends a
 * citation (`[knowledge_fact:392mtme48rfejfl1jhvg]`, 34 Latin letters)
 * to every answer, and 15 Han characters lost that count. The matrix
 * reported `answer-language-correctness` 0.00 for zh/mono on an answer
 * that read "Orbital Dynamics 的工程负责人是玛丽亚·阿尔瓦雷斯" — the ruler,
 * not the thing measured.
 *
 * The brain's detector had the same flaw and was fixed once, there
 * (word shares by ICU segmentation, machine tokens stripped). Two
 * detectors that can disagree is how an eval ends up grading the system
 * against a standard the system itself does not use; there is one now.
 */
export interface ScriptDetection {
  /** ISO 639-1 code, or 'und' when the text is empty / unrecognized. */
  lang: LanguageCode | 'und';
  /** Coarse script class the decision rested on. */
  script: 'cyrillic' | 'han' | 'arabic' | 'devanagari' | 'latin' | 'none';
  /** 0..1 — the brain detector's own confidence. */
  confidence: number;
}

const MATRIX_LANGS: ReadonlySet<string> = new Set<LanguageCode>([
  'en',
  'ru',
  'de',
  'es',
  'zh',
  'ar',
  'hi',
]);

const SCRIPT_OF: Record<string, ScriptDetection['script']> = {
  Cyrl: 'cyrillic',
  Hani: 'han',
  Arab: 'arabic',
  Deva: 'devanagari',
  Latn: 'latin',
};

export function detectLanguage(text: string): ScriptDetection {
  const r = brainDetect(text, false);
  if (r.language === 'und') return { lang: 'und', script: 'none', confidence: 0 };
  return {
    // A language the matrix does not grade (fr, ja, …) is reported as
    // 'und' rather than mapped onto a neighbour: the case then scores as
    // a miss with the real reason visible in the prediction.
    lang: MATRIX_LANGS.has(r.language) ? (r.language as LanguageCode) : 'und',
    script: SCRIPT_OF[r.script] ?? 'none',
    confidence: r.confidence,
  };
}
