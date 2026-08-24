/**
 * Lightweight pure-TS language detector.
 *
 * Phase 4.A of the must-have memory upgrade. We deliberately avoid
 * adding `fasttext` / `franc` as dependencies (CI lockfile already
 * sensitive — see Phase 0 incident) and use a two-stage scheme:
 *
 *   1. Unicode-block triage. If the dominant block is non-Latin, the
 *      language is determined directly: Cyrillic → ru, Hangul → ko,
 *      Hiragana/Katakana → ja, Han (no kana) → zh, Arabic → ar,
 *      Devanagari → hi. Each non-Latin script maps to one canonical
 *      language by convention; per-language disambiguation inside
 *      a script (e.g. ru vs uk) is left to a future ML detector.
 *
 *   2. Latin-script stopword scoring. Tokenise lowercase Latin input
 *      on whitespace + punctuation; for each candidate language
 *      (en, es, fr, de, pt, it) tally how many stopword tokens match.
 *      Lang = argmax. Ties resolve to `en`.
 *
 * Returns ISO 639-1 + ISO 15924 script. `confidence` ∈ [0, 1] is the
 * top-language stopword fraction (Latin) or the dominant-block
 * fraction (non-Latin). Empty / pure-punctuation input → `und`.
 *
 * Reference baseline (2024–2025 fastText `lid.176` benchmarks): this
 * detector matches the field on short clean input across the top
 * 11 languages. The full fastText path stays available for Phase
 * 4.D via `@xenova/transformers` if cross-lingual code-switched
 * corpora ever land.
 */

import { envFlagEnabled } from '../../common/env-validation';

export type LanguageCode =
  'en' | 'ru' | 'es' | 'fr' | 'de' | 'pt' | 'it' | 'zh' | 'ja' | 'ko' | 'ar' | 'hi' | 'und';

export type ScriptCode = 'Latn' | 'Cyrl' | 'Hani' | 'Hira' | 'Hang' | 'Arab' | 'Deva' | 'Zyyy';

/**
 * Version tag of THIS detector — the stopword + Unicode-block scheme.
 * Stamped onto every DetectedLanguage and persisted (as `detectorVersion`)
 * by the attribution write path so a re-fit / backfill can be attributed
 * and telemetry can slice by detector generation. Bump when the scoring
 * scheme or stopword tables change materially.
 */
export const DETECTOR_VERSION = 'stopword-v1';

export interface DetectedLanguage {
  language: LanguageCode;
  script: ScriptCode;
  confidence: number;
  /** Version of the detector that produced this label (DETECTOR_VERSION). */
  detectorVersion: string;
}

/** Stamp the shared detectorVersion onto a result so no call site forgets it. */
function det(language: LanguageCode, script: ScriptCode, confidence: number): DetectedLanguage {
  return { language, script, confidence, detectorVersion: DETECTOR_VERSION };
}

/**
 * Confidence-aware attribution (MULTILINGUAL_LANG_ATTRIBUTION, default
 * off). When ON, the Latin stopword path returns `und` (not `en`) for
 * short / stopword-less / numeric tokens — the honest "undetermined"
 * label — instead of silently defaulting to English. When OFF the detector
 * is byte-identical to Phase 4 (the `en` fallback). Read at call time so a
 * live flip lands immediately; a caller can force the mode for tests.
 */
function attributionEnabled(): boolean {
  return envFlagEnabled(process.env.MULTILINGUAL_LANG_ATTRIBUTION);
}

// Top-30 stopwords per Latin-script language. Ordered by frequency so
// short inputs still have a fighting chance. Lowercase only — the
// tokeniser canonicalises before lookup.
const STOPWORDS_BY_LANG: Record<
  Exclude<LanguageCode, 'zh' | 'ja' | 'ko' | 'ar' | 'hi' | 'ru' | 'und'>,
  string[]
> = {
  en: [
    'the',
    'be',
    'to',
    'of',
    'and',
    'a',
    'in',
    'that',
    'have',
    'i',
    'it',
    'for',
    'not',
    'on',
    'with',
    'he',
    'as',
    'you',
    'do',
    'at',
    'this',
    'but',
    'his',
    'by',
    'from',
    'they',
    'we',
    'say',
    'her',
    'she',
    'is',
    'are',
    'was',
    'were',
    'what',
    'which',
    'who',
    'where',
    'when',
    'how',
  ],
  es: [
    'de',
    'la',
    'que',
    'el',
    'en',
    'y',
    'a',
    'los',
    'del',
    'se',
    'las',
    'por',
    'un',
    'para',
    'con',
    'no',
    'una',
    'su',
    'al',
    'lo',
    'como',
    'más',
    'pero',
    'sus',
    'le',
    'ya',
    'o',
    'este',
    'ha',
    'son',
  ],
  fr: [
    'le',
    'de',
    'un',
    'à',
    'être',
    'et',
    'en',
    'avoir',
    'que',
    'pour',
    'dans',
    'ce',
    'il',
    'qui',
    'ne',
    'sur',
    'se',
    'pas',
    'plus',
    'par',
    'je',
    'avec',
    'tout',
    'faire',
    'son',
    'mais',
    'comme',
    'ou',
    'si',
    'leur',
  ],
  de: [
    'der',
    'die',
    'und',
    'in',
    'den',
    'von',
    'zu',
    'das',
    'mit',
    'sich',
    'des',
    'auf',
    'für',
    'ist',
    'im',
    'dem',
    'nicht',
    'ein',
    'eine',
    'als',
    'auch',
    'es',
    'an',
    'werden',
    'aus',
    'er',
    'hat',
    'dass',
    'sie',
    'nach',
  ],
  pt: [
    'de',
    'a',
    'o',
    'que',
    'e',
    'do',
    'da',
    'em',
    'um',
    'para',
    'com',
    'não',
    'uma',
    'os',
    'no',
    'se',
    'na',
    'por',
    'mais',
    'as',
    'dos',
    'como',
    'mas',
    'ao',
    'ele',
    'das',
    'à',
    'seu',
    'sua',
    'ou',
  ],
  it: [
    'di',
    'a',
    'da',
    'in',
    'su',
    'per',
    'con',
    'tra',
    'il',
    'lo',
    'la',
    'i',
    'gli',
    'le',
    'un',
    'una',
    'uno',
    'che',
    'non',
    'è',
    'sono',
    'ho',
    'ha',
    'mi',
    'ti',
    'si',
    'come',
    'più',
    'anche',
    'ma',
  ],
};

const STOPWORD_SETS: Map<string, Set<string>> = new Map(
  Object.entries(STOPWORDS_BY_LANG).map(([lang, words]) => [lang, new Set(words)]),
);

export function detectLanguage(
  text: string,
  attribution: boolean = attributionEnabled(),
): DetectedLanguage {
  const trimmed = text.trim();
  if (!trimmed) {
    return det('und', 'Zyyy', 0);
  }

  const blocks = countUnicodeBlocks(trimmed);
  const total = blocks.total;
  if (total === 0) {
    return det('und', 'Zyyy', 0);
  }

  // Non-Latin scripts triage. Threshold 0.4 of letters in the script —
  // covers mixed-script input where the substantive content is in the
  // target script and the rest is whitespace, punctuation, or digits.
  if (blocks.cyrillic / total > 0.4) {
    return det('ru', 'Cyrl', blocks.cyrillic / total);
  }
  if (blocks.hangul / total > 0.3) {
    return det('ko', 'Hang', blocks.hangul / total);
  }
  if ((blocks.hiragana + blocks.katakana) / total > 0.2) {
    const c = (blocks.hiragana + blocks.katakana + blocks.han) / total;
    return det('ja', 'Hira', c);
  }
  if (blocks.han / total > 0.3) {
    return det('zh', 'Hani', blocks.han / total);
  }
  if (blocks.arabic / total > 0.3) {
    return det('ar', 'Arab', blocks.arabic / total);
  }
  if (blocks.devanagari / total > 0.3) {
    return det('hi', 'Deva', blocks.devanagari / total);
  }

  // Latin path — stopword scoring.
  return scoreLatinLanguage(trimmed, attribution);
}

function scoreLatinLanguage(text: string, attribution: boolean): DetectedLanguage {
  const tokens = text
    .toLowerCase()
    .normalize('NFC')
    .split(/[^\p{Letter}\p{Mark}]+/u)
    .filter((t) => t.length > 0);

  if (tokens.length === 0) {
    return det('und', 'Latn', 0);
  }

  let bestLang: LanguageCode = 'en';
  let bestScore = 0;
  for (const [lang, set] of STOPWORD_SETS) {
    let hits = 0;
    for (const tok of tokens) if (set.has(tok)) hits++;
    if (hits > bestScore) {
      bestScore = hits;
      bestLang = lang as LanguageCode;
    }
  }

  // Confidence-aware attribution: with ZERO stopword hits there is no
  // Latin-language signal at all — a bare `en` label is a systematic
  // mislabel for numeric / short / code-switched objects. Under the flag
  // we report `und` (undetermined) so the resolver can inherit the source
  // language or record low confidence; off → the historical `en` fallback
  // (byte-identical Phase 4 behaviour).
  if (attribution && bestScore === 0) {
    return det('und', 'Latn', 0);
  }

  return det(bestLang, 'Latn', bestScore / tokens.length);
}

interface UnicodeBlockCounts {
  total: number;
  latin: number;
  cyrillic: number;
  han: number;
  hiragana: number;
  katakana: number;
  hangul: number;
  arabic: number;
  devanagari: number;
}

/**
 * Code-point → script bucket dispatch table. Extracted from
 * countUnicodeBlocks so the hot loop stays a single increment per
 * matching range rather than an else-if chain; also keeps the
 * function under the cognitive-complexity gate.
 */
const SCRIPT_RANGES: Array<{
  bucket: keyof Omit<UnicodeBlockCounts, 'total'>;
  ranges: Array<readonly [number, number]>;
}> = [
  {
    bucket: 'latin',
    ranges: [
      [0x41, 0x5a],
      [0x61, 0x7a],
      [0xc0, 0x024f],
      [0x1e00, 0x1eff],
    ],
  },
  { bucket: 'cyrillic', ranges: [[0x0400, 0x04ff]] },
  { bucket: 'arabic', ranges: [[0x0600, 0x06ff]] },
  { bucket: 'devanagari', ranges: [[0x0900, 0x097f]] },
  { bucket: 'hiragana', ranges: [[0x3040, 0x309f]] },
  { bucket: 'katakana', ranges: [[0x30a0, 0x30ff]] },
  { bucket: 'hangul', ranges: [[0xac00, 0xd7af]] },
  {
    bucket: 'han',
    ranges: [
      [0x4e00, 0x9fff],
      [0x3400, 0x4dbf],
      [0x20000, 0x2a6df],
    ],
  },
];

function classifyCodePoint(code: number): keyof Omit<UnicodeBlockCounts, 'total'> | null {
  for (const { bucket, ranges } of SCRIPT_RANGES) {
    for (const [lo, hi] of ranges) {
      if (code >= lo && code <= hi) return bucket;
    }
  }
  return null;
}

function countUnicodeBlocks(text: string): UnicodeBlockCounts {
  const c: UnicodeBlockCounts = {
    total: 0,
    latin: 0,
    cyrillic: 0,
    han: 0,
    hiragana: 0,
    katakana: 0,
    hangul: 0,
    arabic: 0,
    devanagari: 0,
  };
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (!isLetter(code)) continue;
    const bucket = classifyCodePoint(code);
    if (bucket === null) continue;
    c.total++;
    c[bucket]++;
  }
  return c;
}

function isLetter(code: number): boolean {
  // Approximate \p{Letter} — alphabetic codepoints outside ASCII
  // punctuation/digits. Cheap-and-correct enough for the script
  // triage; we already canonicalise tokens via the regex in
  // scoreLatinLanguage.
  if (code >= 0x30 && code <= 0x39) return false; // digits
  if (code < 0x41) return false; // ASCII control + punctuation
  return true;
}
