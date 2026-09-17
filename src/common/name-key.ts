import anyAscii from 'any-ascii';

/**
 * A script-independent lookup key for an entity name.
 *
 * WHY NOT AN EMBEDDING — the thing this replaces. Cross-script entity
 * linking was left entirely to `EntityResolverService`: embed
 * `name: <surface>`, take the nearest neighbour above a cosine floor,
 * ask an LLM judge. Measured on bge-m3 (the provider prod runs) on
 * 2026-09-14, that signal cannot do the job, and not because the floor
 * was mistuned:
 *
 *   SAME person                        cos     DIFFERENT people           cos
 *   Ivan Petrov ~ Иван Петров        0.865     Ivan Petrov ~ Иван Сидоров 0.712
 *   伊万·彼得罗夫 ~ إيفان بيتروف       0.825     Ivan Petrov ~ Maria Alvarez 0.445
 *   Ivan Petrov ~ 伊万·彼得罗夫        0.767
 *   Aarav Sharma ~ आरव शर्मा          0.748
 *   Иван Петров ~ إيفان بيتروف        0.695
 *
 * A DIFFERENT person who happens to share a given name scores above four
 * of the five true pairs. The bands overlap, so no threshold separates
 * them — which is what you would expect, because an embedding measures
 * MEANING and a name does not have one. To that model "Ivan Petrov" and
 * "Иван Сидоров" both mean "a Russian man's name", and it is answering
 * that question correctly; it is the wrong question.
 *
 * The right question for a name is orthographic, and it is settled by
 * writing both spellings in one script:
 *
 *   Иван Петров  -> ivan petrov   == Ivan Petrov  -> ivan petrov     same
 *   Иван Сидоров -> ivan sidorov  != Ivan Petrov  -> ivan petrov     different
 *
 * Deterministic, reversible, free, and it gets right the exact pair the
 * embedding gets wrong. The transliteration data is `any-ascii`, a port
 * of the Unicode transliteration tables — platform data of the same kind
 * as the ICU month names in locale-date.ts, not a table anyone here
 * maintains by hand.
 *
 * WHAT IT DOES NOT SOLVE, stated rather than hidden. Scripts that do not
 * encode a foreign name's vowels, or encode it by sound, transliterate to
 * something orthographically distant even when the name is identical:
 *
 *   伊万·彼得罗夫  -> yiwan bideluofu     (Han, rendered by sound)
 *   إيفان بيتروف   -> yfn bytrwf          (Arabic, short vowels unwritten)
 *   आरव शर्मा      -> arv srma            (Devanagari, inherent vowels)
 *
 * Those are genuinely hard and genuinely uncertain, and they are what the
 * embedding + judge path is FOR. The point of this module is that they
 * are now the only thing left in it: the cases a string comparison can
 * settle no longer go to an LLM to be guessed at.
 */

/**
 * Fold a surface name to its comparison key, or '' when nothing survives.
 *
 * Transliterate → drop modifier apostrophes → lowercase → keep letters and
 * digits, everything else becomes a single space. That lets "Иван Петров",
 * "Ivan  Petrov" and "IVAN-PETROV" meet, and keeps the CJK interpunct in
 * "伊万·彼得罗夫" from splitting its own transliteration.
 *
 * THE APOSTROPHE IS DELETED, NOT SPACED. any-ascii renders a Cyrillic soft
 * sign and an Arabic hamza as `'` — they are modifiers on the neighbouring
 * letter, not separators. Spacing them tore "Нью-Йорк" into "n yu york"
 * while "Nyu-York" folded to "nyu york", so the two spellings of one city
 * failed to meet on the very mechanism built to make them meet.
 *
 * A NAME MUST CONTAIN A LETTER OR A DIGIT to have a key at all. any-ascii
 * transliterates an emoji to its CLDR NAME — "🙂" becomes "slight smile" —
 * which is a perfectly good key and an entirely fake identity: two
 * unrelated entities whose names differ only in decoration would fuse on
 * it. Input with nothing alphanumeric in it gets no key, and no key means
 * this path never fires.
 *
 * AND THE KEY MUST BE AT LEAST `MIN_KEY_LENGTH` LONG, because folding
 * punctuation away can delete the only thing distinguishing two names:
 *
 *   C     -> "c"
 *   C++   -> "c"
 *   C#    -> "c"
 *
 * Three different languages, one key. On a code corpus that is a wrong
 * merge waiting for its first mention, and no amount of care downstream
 * can undo a name whose distinguishing characters were thrown away here.
 * A key this short carries almost no evidence anyway, so it is refused
 * outright — the cost is that two-letter names ("BP") resolve by the
 * paths that existed before this one, which is what they did yesterday.
 */
const MIN_KEY_LENGTH = 3;

export function nameKey(surface: string): string {
  if (!surface || !/[\p{L}\p{N}]/u.test(surface)) return '';
  const key = anyAscii(surface)
    .replace(/['’]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim();
  return key.length >= MIN_KEY_LENGTH ? key : '';
}

/**
 * The distinct, non-empty keys for an entity's canonical name and every
 * alias it carries — what gets stored on the row and searched against.
 */
export function nameKeysFor(names: ReadonlyArray<string | undefined | null>): string[] {
  const keys = new Set<string>();
  for (const n of names) {
    if (typeof n !== 'string') continue;
    const key = nameKey(n);
    if (key !== '') keys.add(key);
  }
  return [...keys];
}
