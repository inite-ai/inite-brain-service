import type { LanguageCode } from '../../../src/eval/types';

/**
 * The surface half of the multilingual matrix — the text a LIVE run has
 * to put in and ask with.
 *
 * WHY IT DID NOT EXIST. The scenarios in src/eval/scenarios were written
 * script-agnostic on purpose: gold is refs, never surface strings, so one
 * grid can score seven languages without the gold itself leaning on any
 * of them. That is right for the gold and it is why the matrix could
 * never be run against the real system — a live run needs sentences.
 * `RealModel.predict` says as much and throws.
 *
 * So this file is the missing adapter input, and nothing else: per ref
 * per language, the sentence that states that fact; per language, the
 * question that asks for it. The gold stays where it is.
 *
 * TWO RULES IT FOLLOWS, both to keep the measurement honest:
 *
 *  1. NATIVE NAMES, NOT TRANSLITERATED LATIN. Writing "Maria Alvarez" in
 *     the Chinese and Arabic sentences would make cross-lingual retrieval
 *     a lexical match on a Latin string, and the number would measure
 *     nothing. Each language names people the way that language does.
 *  2. REFS ARE RESOLVED BY ID, NOT BY TEXT. The adapter records which
 *     entity and fact ids each ingested sentence produced and maps
 *     results back through that. No string matching between a result and
 *     a ref anywhere — which is the only way a ref mapping can be
 *     script-independent in fact and not just in intention.
 *
 * Cases whose gold already carries its own surface text — every
 * `temporal` (the expression) and every `linking` (the surfaces) — are
 * not repeated here; only the carrier sentence that has to hold a
 * temporal expression is.
 */

export const MATRIX_LANGUAGES: readonly LanguageCode[] = ['en', 'ru', 'de', 'es', 'zh', 'ar', 'hi'];

/**
 * The three role facts the cross-lingual retrieval cases rank, one
 * sentence per language. Same company, three departments, three people —
 * so a query for one department has two plausible distractors in the same
 * tenant rather than a single obvious hit.
 */
export const ROLE_SENTENCES: Record<string, Record<LanguageCode, string>> = {
  'cross.role_eng': {
    en: 'Maria Alvarez is the head of engineering at Orbital Dynamics.',
    ru: 'Мария Альварес — руководитель инженерного отдела в Orbital Dynamics.',
    de: 'Maria Alvarez ist die Leiterin der Technik bei Orbital Dynamics.',
    es: 'María Álvarez es la directora de ingeniería en Orbital Dynamics.',
    zh: '玛丽亚·阿尔瓦雷斯是 Orbital Dynamics 的工程负责人。',
    ar: 'ماريا ألفاريز هي رئيسة قسم الهندسة في Orbital Dynamics.',
    hi: 'मारिया अल्वारेज़ Orbital Dynamics में इंजीनियरिंग प्रमुख हैं।',
  },
  'cross.role_sales': {
    en: 'Thomas Brandt is the head of sales at Orbital Dynamics.',
    ru: 'Томас Брандт — руководитель отдела продаж в Orbital Dynamics.',
    de: 'Thomas Brandt ist der Leiter des Vertriebs bei Orbital Dynamics.',
    es: 'Thomas Brandt es el director de ventas en Orbital Dynamics.',
    zh: '托马斯·勃兰特是 Orbital Dynamics 的销售负责人。',
    ar: 'توماس براندت هو رئيس قسم المبيعات في Orbital Dynamics.',
    hi: 'थॉमस ब्रांट Orbital Dynamics में बिक्री प्रमुख हैं।',
  },
  'cross.role_finance': {
    en: 'Nadia Haddad is the head of finance at Orbital Dynamics.',
    ru: 'Надия Хаддад — руководитель финансового отдела в Orbital Dynamics.',
    de: 'Nadia Haddad ist die Leiterin der Finanzen bei Orbital Dynamics.',
    es: 'Nadia Haddad es la directora de finanzas en Orbital Dynamics.',
    zh: '娜迪娅·哈达德是 Orbital Dynamics 的财务负责人。',
    ar: 'نادية حداد هي رئيسة قسم المالية في Orbital Dynamics.',
    hi: 'नादिया हद्दाद Orbital Dynamics में वित्त प्रमुख हैं।',
  },
};

/** The question every retrieval case asks, in the case's query language. */
export const ROLE_QUERIES: Record<LanguageCode, string> = {
  en: 'Who leads engineering at Orbital Dynamics?',
  ru: 'Кто руководит инженерным отделом в Orbital Dynamics?',
  de: 'Wer leitet die Technik bei Orbital Dynamics?',
  es: '¿Quién dirige el área de ingeniería en Orbital Dynamics?',
  zh: 'Orbital Dynamics 的工程负责人是谁？',
  ar: 'من يرأس قسم الهندسة في Orbital Dynamics؟',
  hi: 'Orbital Dynamics में इंजीनियरिंग का नेतृत्व कौन करता है?',
};

/**
 * Short-string inputs — the case's whole point is that the string is too
 * short for a detector to be confident about, so the sentence around it
 * stays minimal on purpose. Lengthening it would remove the failure mode
 * the case exists to measure.
 */
export const SHORT_INPUTS: Record<string, { text: string; lang: LanguageCode }> = {
  'ml.short.zh-name': { text: '李伟是我们的首席技术官。', lang: 'zh' },
  'ml.short.ar-status': { text: 'سمير هو المدير.', lang: 'ar' },
  'ml.short.hi-name': { text: 'आरव हमारी टीम में है।', lang: 'hi' },
  'ml.short.en-ticker': { text: 'ORB is listed on the exchange.', lang: 'en' },
  'ml.short.ru-abbr': { text: 'Пётр — ФД компании.', lang: 'ru' },
};

/**
 * Code-switching inputs. The query mixes scripts in one sentence, which
 * is what a bilingual user actually types and what a single-language
 * detector has no good answer for.
 */
export const CODE_SWITCH_QUERIES: Record<string, string> = {
  // A RU frame around an EN department name.
  'ml.cs.ru-en-retr': 'Кто у нас head of engineering в Orbital Dynamics?',
  // Asks for a department nobody stored — the system must refuse.
  'ml.cs.false-premise': 'Who is the head of юридического отдела at Orbital Dynamics?',
  // The second half of the conflict pair; the first is the stored RU fact.
  'ml.cs.conflict': 'Thomas Brandt is the head of engineering at Orbital Dynamics.',
};

/**
 * Carrier sentences for the temporal cases: the gold's `expression` has
 * to reach the extractor inside a sentence, and it has to appear in it
 * VERBATIM or the case would be measuring a different string than the one
 * the gold names.
 */
const TEMPORAL_CARRIER: Record<LanguageCode, (expression: string) => string> = {
  en: (e) => `The pilot launch is scheduled for ${e}.`,
  // "Пилотный запуск", not "Запуск пилота": the latter is "the launch of
  // the pilot" — a person — and the extractor, reading it that way,
  // returned no entity and no fact for it in every run while the same
  // sentence in German and Spanish yielded `pilot launch — scheduled_for`.
  // That was the whole of the ml.temp.ru miss; chrono reads the date fine.
  ru: (e) => `Пилотный запуск запланирован на ${e}.`,
  de: (e) => `Der Pilotstart ist für ${e} geplant.`,
  es: (e) => `El lanzamiento piloto está previsto para ${e}.`,
  zh: (e) => `试点发布定于 ${e}。`,
  ar: (e) => `من المقرر إطلاق التجربة في ${e}.`,
  hi: (e) => `पायलट लॉन्च ${e} को निर्धारित है।`,
};

export function temporalCarrier(expression: string, lang: LanguageCode): string {
  const build = TEMPORAL_CARRIER[lang];
  return build ? build(expression) : expression;
}

/**
 * Every case id this file can drive live. The adapter reports any case
 * outside it as uncovered rather than guessing an input for it — a
 * fabricated input would produce a number, and a number nobody can trace
 * to a stated input is worse than a gap.
 */
export function hasSurfaceFor(caseId: string, failureMode: string): boolean {
  if (failureMode === 'cross_lingual_retrieval') return true;
  if (failureMode === 'temporal_locale') return true;
  if (failureMode === 'entity_fragmentation') return true;
  if (failureMode === 'short_string_mislabel') return caseId in SHORT_INPUTS;
  if (failureMode === 'code_switching') return caseId in CODE_SWITCH_QUERIES;
  return false;
}
