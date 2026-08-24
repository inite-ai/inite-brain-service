import type { Scenario, MultilingualCase, LanguageAttributionSample } from '../types';

const ISO = (d: string) => new Date(d).toISOString();

/** Compact constructor for a language-attribution telemetry sample. */
const tele = (
  lang: string,
  source: LanguageAttributionSample['source'],
  confidence: number,
): LanguageAttributionSample => ({ lang, confidence, source, detectorVersion: 'stub-detect-v1' });

/**
 * Phase 4 — multilingual / cross-lingual scenarios. Each scenario
 * seeds facts in two languages on the same entity, then queries
 * across the language boundary. The cross-lingual backoff path
 * (Phase 4.B) must surface the alternate-language fact when the
 * single-language first pass would otherwise miss it.
 *
 * The runner asserts `expectedTopEntityRef` against the canonical
 * external ref of the multilingual entity. recall@1 over this set
 * is the headline "cross-lingual retrieval" metric.
 */
export const multilingualScenarios: Scenario[] = [
  {
    id: 'multilingual.ru-fact-en-query',
    vertical: 'cross',
    description:
      'A Russian-tagged status fact must surface for an English query about the same role. Tests Phase 4.B cross-lingual backoff and Phase 4.A ingest lang-tagging.',
    setup: [
      {
        kind: 'fact',
        entityRef: { vertical: 'rent', id: 'multilingual_anya' },
        predicate: 'status',
        object: 'Технический директор',
        validFrom: ISO('2026-04-01'),
        source: { vertical: 'rent', eventId: 'auth.profile_updated' },
        confidence: 0.95,
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'rent', id: 'distractor_boris' },
        predicate: 'status',
        object: 'sales representative',
        validFrom: ISO('2026-04-01'),
        source: { vertical: 'rent', eventId: 'auth.profile_updated' },
        confidence: 0.9,
      },
    ],
    queries: [
      {
        query: 'Who is the CTO of this tenant',
        expectedTopEntityRef: 'rent.multilingual_anya',
        expectedFactPredicate: 'status',
      },
    ],
  },
  {
    id: 'multilingual.en-fact-ru-query',
    vertical: 'cross',
    description:
      'Mirror case: English-tagged status fact must surface for a Russian-language query. Pure detection + backoff path through the Cyrillic branch.',
    setup: [
      {
        kind: 'fact',
        entityRef: { vertical: 'rent', id: 'multilingual_charlie' },
        predicate: 'status',
        object: 'Chief Engineering Officer',
        validFrom: ISO('2026-04-01'),
        source: { vertical: 'rent', eventId: 'auth.profile_updated' },
        confidence: 0.95,
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'rent', id: 'distractor_dmitry' },
        predicate: 'status',
        object: 'Менеджер по продажам',
        validFrom: ISO('2026-04-01'),
        source: { vertical: 'rent', eventId: 'auth.profile_updated' },
        confidence: 0.9,
      },
    ],
    queries: [
      {
        query: 'кто руководит инженерным отделом',
        expectedTopEntityRef: 'rent.multilingual_charlie',
        expectedFactPredicate: 'status',
      },
    ],
  },
  {
    id: 'multilingual.same-language-no-backoff',
    vertical: 'cross',
    description:
      'Baseline: when both facts AND query are Russian, the filtered first pass alone should already win. Guards against a regression where the backoff path silently steals every win.',
    setup: [
      {
        kind: 'fact',
        entityRef: { vertical: 'rent', id: 'monolingual_ekaterina' },
        predicate: 'status',
        object: 'Финансовый директор',
        validFrom: ISO('2026-04-01'),
        source: { vertical: 'rent', eventId: 'auth.profile_updated' },
        confidence: 0.95,
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'rent', id: 'distractor_fyodor' },
        predicate: 'status',
        object: 'Главный инженер',
        validFrom: ISO('2026-04-01'),
        source: { vertical: 'rent', eventId: 'auth.profile_updated' },
        confidence: 0.9,
      },
    ],
    queries: [
      {
        query: 'кто финансовый директор',
        expectedTopEntityRef: 'rent.monolingual_ekaterina',
        expectedFactPredicate: 'status',
      },
    ],
  },
  // ── Script-class coverage: a fact stored in each non-Latin / Latin
  // script must surface for an English query about the same role.
  // Extends the ru/en pair above across de / es / zh / ar / hi so the
  // cross-lingual backoff is exercised on every script class our lexical
  // helpers break on. Gold is the canonical entity ref (language-neutral).
  {
    id: 'multilingual.de-fact-en-query',
    vertical: 'cross',
    description: 'German-tagged role fact must surface for an English query (Latin, non-English).',
    setup: [
      {
        kind: 'fact',
        entityRef: { vertical: 'rent', id: 'multilingual_greta' },
        predicate: 'status',
        object: 'Technische Leiterin',
        validFrom: ISO('2026-04-01'),
        source: { vertical: 'rent', eventId: 'auth.profile_updated' },
        confidence: 0.95,
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'rent', id: 'distractor_hans' },
        predicate: 'status',
        object: 'Vertriebsmitarbeiter',
        validFrom: ISO('2026-04-01'),
        source: { vertical: 'rent', eventId: 'auth.profile_updated' },
        confidence: 0.9,
      },
    ],
    queries: [
      {
        query: 'Who is the head of engineering',
        expectedTopEntityRef: 'rent.multilingual_greta',
        expectedFactPredicate: 'status',
      },
    ],
  },
  {
    id: 'multilingual.es-fact-en-query',
    vertical: 'cross',
    description: 'Spanish-tagged role fact must surface for an English query (Latin, non-English).',
    setup: [
      {
        kind: 'fact',
        entityRef: { vertical: 'rent', id: 'multilingual_sofia' },
        predicate: 'status',
        object: 'Directora de Ingeniería',
        validFrom: ISO('2026-04-01'),
        source: { vertical: 'rent', eventId: 'auth.profile_updated' },
        confidence: 0.95,
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'rent', id: 'distractor_diego' },
        predicate: 'status',
        object: 'Representante de ventas',
        validFrom: ISO('2026-04-01'),
        source: { vertical: 'rent', eventId: 'auth.profile_updated' },
        confidence: 0.9,
      },
    ],
    queries: [
      {
        query: 'Who leads engineering here',
        expectedTopEntityRef: 'rent.multilingual_sofia',
        expectedFactPredicate: 'status',
      },
    ],
  },
  {
    id: 'multilingual.zh-fact-en-query',
    vertical: 'cross',
    description: 'Chinese (CJK) role fact must surface for an English query — no shared tokens.',
    setup: [
      {
        kind: 'fact',
        entityRef: { vertical: 'rent', id: 'multilingual_lin' },
        predicate: 'status',
        object: '技术总监',
        validFrom: ISO('2026-04-01'),
        source: { vertical: 'rent', eventId: 'auth.profile_updated' },
        confidence: 0.95,
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'rent', id: 'distractor_wang' },
        predicate: 'status',
        object: '销售代表',
        validFrom: ISO('2026-04-01'),
        source: { vertical: 'rent', eventId: 'auth.profile_updated' },
        confidence: 0.9,
      },
    ],
    queries: [
      {
        query: 'Who is the CTO',
        expectedTopEntityRef: 'rent.multilingual_lin',
        expectedFactPredicate: 'status',
      },
    ],
  },
  {
    id: 'multilingual.ar-fact-en-query',
    vertical: 'cross',
    description:
      'Arabic (RTL) role fact must surface for an English query — bidi + no shared tokens.',
    setup: [
      {
        kind: 'fact',
        entityRef: { vertical: 'rent', id: 'multilingual_layla' },
        predicate: 'status',
        object: 'مديرة الهندسة',
        validFrom: ISO('2026-04-01'),
        source: { vertical: 'rent', eventId: 'auth.profile_updated' },
        confidence: 0.95,
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'rent', id: 'distractor_omar' },
        predicate: 'status',
        object: 'مندوب مبيعات',
        validFrom: ISO('2026-04-01'),
        source: { vertical: 'rent', eventId: 'auth.profile_updated' },
        confidence: 0.9,
      },
    ],
    queries: [
      {
        query: 'Who is the head of engineering',
        expectedTopEntityRef: 'rent.multilingual_layla',
        expectedFactPredicate: 'status',
      },
    ],
  },
  {
    id: 'multilingual.hi-fact-en-query',
    vertical: 'cross',
    description:
      'Hindi (Devanagari) role fact must surface for an English query — no shared tokens.',
    setup: [
      {
        kind: 'fact',
        entityRef: { vertical: 'rent', id: 'multilingual_aarav' },
        predicate: 'status',
        object: 'इंजीनियरिंग प्रमुख',
        validFrom: ISO('2026-04-01'),
        source: { vertical: 'rent', eventId: 'auth.profile_updated' },
        confidence: 0.95,
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'rent', id: 'distractor_rohan' },
        predicate: 'status',
        object: 'बिक्री प्रतिनिधि',
        validFrom: ISO('2026-04-01'),
        source: { vertical: 'rent', eventId: 'auth.profile_updated' },
        confidence: 0.9,
      },
    ],
    queries: [
      {
        query: 'Who heads engineering',
        expectedTopEntityRef: 'rent.multilingual_aarav',
        expectedFactPredicate: 'status',
      },
    ],
  },
  {
    id: 'multilingual.en-fact-zh-query',
    vertical: 'cross',
    description: 'Reverse direction: English-tagged fact must surface for a Chinese (CJK) query.',
    setup: [
      {
        kind: 'fact',
        entityRef: { vertical: 'rent', id: 'multilingual_grace' },
        predicate: 'status',
        object: 'Chief Technology Officer',
        validFrom: ISO('2026-04-01'),
        source: { vertical: 'rent', eventId: 'auth.profile_updated' },
        confidence: 0.95,
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'rent', id: 'distractor_mike' },
        predicate: 'status',
        object: 'Sales representative',
        validFrom: ISO('2026-04-01'),
        source: { vertical: 'rent', eventId: 'auth.profile_updated' },
        confidence: 0.9,
      },
    ],
    queries: [
      {
        query: '谁是技术总监',
        expectedTopEntityRef: 'rent.multilingual_grace',
        expectedFactPredicate: 'status',
      },
    ],
  },
  {
    id: 'multilingual.code-switching-query',
    vertical: 'cross',
    description:
      'Code-switched query (Cyrillic + Latin in one sentence) must still route to the right role fact.',
    setup: [
      {
        kind: 'fact',
        entityRef: { vertical: 'rent', id: 'multilingual_nadia' },
        predicate: 'status',
        object: 'Технический директор',
        validFrom: ISO('2026-04-01'),
        source: { vertical: 'rent', eventId: 'auth.profile_updated' },
        confidence: 0.95,
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'rent', id: 'distractor_pavel' },
        predicate: 'status',
        object: 'Менеджер по продажам',
        validFrom: ISO('2026-04-01'),
        source: { vertical: 'rent', eventId: 'auth.profile_updated' },
        confidence: 0.9,
      },
    ],
    queries: [
      {
        query: 'кто у нас CTO of the tenant',
        expectedTopEntityRef: 'rent.multilingual_nadia',
        expectedFactPredicate: 'status',
      },
    ],
  },
];

/**
 * Tier 0 multilingual eval MATRIX — the measurable, language-neutral grid.
 *
 * Distinct from `multilingualScenarios` above (which drive the live
 * HTTP retrieval harness): each `MultilingualCase` carries gold for the
 * pure metric scorers in test/eval/metrics/ across EVERY Tier-0
 * dimension (retrieval, extraction, entity-linking, temporal, conflict /
 * lane, answer-language, abstention, telemetry). The matrix runner
 * (test/eval/multilingual/) feeds a model interface's predictions plus
 * this gold into the scorers and renders a per-language × direction
 * table. Gold is ALWAYS a canonical ref or a normalized value — never a
 * surface string — so a case is scored identically regardless of the
 * script it was stored / queried in.
 *
 * Structured and data-driven on purpose: to grow coverage, append a
 * case tagged with the language pair + failure mode it exercises.
 *
 * `role_*` are the shared, language-neutral candidate refs the retrieval
 * cases rank; the gold answer is always the engineering-lead role.
 */
const ROLE_CORPUS = ['cross.role_eng', 'cross.role_sales', 'cross.role_finance'];

export const multilingualMatrix: MultilingualCase[] = [
  // ── Cross-lingual retrieval ─────────────────────────────────────────
  // Store the role fact in L1, query in L2. Gold = the engineering-lead
  // ref regardless of script. Mono baselines (store==query) guard against
  // a backoff path that silently steals every win. Each case also pins
  // answer-language (reply in the query's language), marks the query
  // answerable (abstention), and emits query+fact telemetry samples.
  {
    id: 'ml.retr.ru-en',
    failureMode: 'cross_lingual_retrieval',
    storeLang: 'ru',
    queryLang: 'en',
    direction: 'cross',
    description: 'Russian role fact, English query.',
    gold: {
      retrieval: { goldRef: 'cross.role_eng', corpusRefs: ROLE_CORPUS },
      lane: { goldLabel: 'default' },
      answerLang: { intended: 'en' },
      abstention: { shouldAnswer: true },
      telemetry: [tele('ru', 'fact', 0.97), tele('en', 'query', 0.95)],
    },
  },
  {
    id: 'ml.retr.en-ru',
    failureMode: 'cross_lingual_retrieval',
    storeLang: 'en',
    queryLang: 'ru',
    direction: 'cross',
    description: 'English role fact, Russian query.',
    gold: {
      retrieval: { goldRef: 'cross.role_eng', corpusRefs: ROLE_CORPUS },
      lane: { goldLabel: 'default' },
      answerLang: { intended: 'ru' },
      abstention: { shouldAnswer: true },
      telemetry: [tele('en', 'fact', 0.96), tele('ru', 'query', 0.94)],
    },
  },
  {
    id: 'ml.retr.de-en',
    failureMode: 'cross_lingual_retrieval',
    storeLang: 'de',
    queryLang: 'en',
    direction: 'cross',
    description: 'German role fact, English query.',
    gold: {
      retrieval: { goldRef: 'cross.role_eng', corpusRefs: ROLE_CORPUS },
      answerLang: { intended: 'en' },
      abstention: { shouldAnswer: true },
      telemetry: [tele('de', 'fact', 0.93), tele('en', 'query', 0.95)],
    },
  },
  {
    id: 'ml.retr.es-en',
    failureMode: 'cross_lingual_retrieval',
    storeLang: 'es',
    queryLang: 'en',
    direction: 'cross',
    description: 'Spanish role fact, English query.',
    gold: {
      retrieval: { goldRef: 'cross.role_eng', corpusRefs: ROLE_CORPUS },
      answerLang: { intended: 'en' },
      abstention: { shouldAnswer: true },
      telemetry: [tele('es', 'fact', 0.92), tele('en', 'query', 0.95)],
    },
  },
  {
    id: 'ml.retr.zh-en',
    failureMode: 'cross_lingual_retrieval',
    storeLang: 'zh',
    queryLang: 'en',
    direction: 'cross',
    description: 'Chinese (CJK) role fact, English query.',
    gold: {
      retrieval: { goldRef: 'cross.role_eng', corpusRefs: ROLE_CORPUS },
      answerLang: { intended: 'en' },
      abstention: { shouldAnswer: true },
      telemetry: [tele('zh', 'fact', 0.9), tele('en', 'query', 0.95)],
    },
  },
  {
    id: 'ml.retr.ar-en',
    failureMode: 'cross_lingual_retrieval',
    storeLang: 'ar',
    queryLang: 'en',
    direction: 'cross',
    description: 'Arabic (RTL) role fact, English query.',
    gold: {
      retrieval: { goldRef: 'cross.role_eng', corpusRefs: ROLE_CORPUS },
      answerLang: { intended: 'en' },
      abstention: { shouldAnswer: true },
      telemetry: [tele('ar', 'fact', 0.88), tele('en', 'query', 0.95)],
    },
  },
  {
    id: 'ml.retr.hi-en',
    failureMode: 'cross_lingual_retrieval',
    storeLang: 'hi',
    queryLang: 'en',
    direction: 'cross',
    description: 'Hindi (Devanagari) role fact, English query.',
    gold: {
      retrieval: { goldRef: 'cross.role_eng', corpusRefs: ROLE_CORPUS },
      answerLang: { intended: 'en' },
      abstention: { shouldAnswer: true },
      telemetry: [tele('hi', 'fact', 0.87), tele('en', 'query', 0.95)],
    },
  },
  {
    id: 'ml.retr.en-en',
    failureMode: 'cross_lingual_retrieval',
    storeLang: 'en',
    queryLang: 'en',
    direction: 'mono',
    description: 'English mono baseline — filtered first pass alone should win.',
    gold: {
      retrieval: { goldRef: 'cross.role_eng', corpusRefs: ROLE_CORPUS },
      answerLang: { intended: 'en' },
      abstention: { shouldAnswer: true },
      telemetry: [tele('en', 'fact', 0.98), tele('en', 'query', 0.98)],
    },
  },
  {
    id: 'ml.retr.ru-ru',
    failureMode: 'cross_lingual_retrieval',
    storeLang: 'ru',
    queryLang: 'ru',
    direction: 'mono',
    description: 'Russian mono baseline.',
    gold: {
      retrieval: { goldRef: 'cross.role_eng', corpusRefs: ROLE_CORPUS },
      answerLang: { intended: 'ru' },
      abstention: { shouldAnswer: true },
      telemetry: [tele('ru', 'fact', 0.98), tele('ru', 'query', 0.98)],
    },
  },
  {
    id: 'ml.retr.zh-zh',
    failureMode: 'cross_lingual_retrieval',
    storeLang: 'zh',
    queryLang: 'zh',
    direction: 'mono',
    description: 'Chinese mono baseline.',
    gold: {
      retrieval: { goldRef: 'cross.role_eng', corpusRefs: ROLE_CORPUS },
      answerLang: { intended: 'zh' },
      abstention: { shouldAnswer: true },
      telemetry: [tele('zh', 'fact', 0.97), tele('zh', 'query', 0.97)],
    },
  },

  // ── Short-string mislabeling ────────────────────────────────────────
  // A 1-3 glyph token (name, ticker, status abbrev) must be extracted
  // with the RIGHT predicate/type. Gold is the normalized fact set;
  // extraction F1 measures the overlap. These stress the lexical helpers
  // that guess entity type from token shape.
  {
    id: 'ml.short.zh-name',
    failureMode: 'short_string_mislabel',
    storeLang: 'zh',
    queryLang: 'zh',
    direction: 'mono',
    description: 'Two-glyph Chinese name "李伟" must extract as a person, not an org.',
    gold: {
      extraction: { goldFacts: ['entity_type=person', 'name=Li Wei', 'role=cto'] },
      telemetry: [tele('zh', 'fact', 0.86)],
    },
  },
  {
    id: 'ml.short.ar-status',
    failureMode: 'short_string_mislabel',
    storeLang: 'ar',
    queryLang: 'ar',
    direction: 'mono',
    description: 'Abbreviated Arabic status must resolve to the manager role.',
    gold: {
      extraction: { goldFacts: ['status=manager'] },
      telemetry: [tele('ar', 'fact', 0.82)],
    },
  },
  {
    id: 'ml.short.hi-name',
    failureMode: 'short_string_mislabel',
    storeLang: 'hi',
    queryLang: 'hi',
    direction: 'mono',
    description: 'Short Devanagari given name must extract as a person.',
    gold: {
      extraction: { goldFacts: ['entity_type=person', 'name=Aarav'] },
      telemetry: [tele('hi', 'fact', 0.83)],
    },
  },
  {
    id: 'ml.short.en-ticker',
    failureMode: 'short_string_mislabel',
    storeLang: 'en',
    queryLang: 'en',
    direction: 'mono',
    description: 'Ambiguous 3-letter ticker "ORB" must extract as an org ticker.',
    gold: {
      extraction: { goldFacts: ['entity_type=org', 'ticker=ORB'] },
      telemetry: [tele('en', 'fact', 0.9)],
    },
  },
  {
    id: 'ml.short.ru-abbr',
    failureMode: 'short_string_mislabel',
    storeLang: 'ru',
    queryLang: 'ru',
    direction: 'mono',
    description: 'Russian role abbreviation "ФД" must resolve to CFO status.',
    gold: {
      extraction: { goldFacts: ['status=cfo'] },
      telemetry: [tele('ru', 'fact', 0.85)],
    },
  },

  // ── Entity fragmentation across scripts ─────────────────────────────
  // The same real-world entity written in several scripts must collapse
  // to ONE node. fragmentation-rate measures over-splitting; linking
  // accuracy measures whether each surface reached the right canonical
  // entity.
  {
    id: 'ml.frag.person-multiscript',
    failureMode: 'entity_fragmentation',
    storeLang: 'en',
    queryLang: 'ru',
    direction: 'cross',
    description: 'One person named across Latin/Cyrillic/CJK/Arabic must not fragment.',
    gold: {
      linking: {
        goldEntity: 'cross.person_ivan',
        surfaces: [
          { surface: 'Ivan Petrov', lang: 'en' },
          { surface: 'Иван Петров', lang: 'ru' },
          { surface: '伊万·彼得罗夫', lang: 'zh' },
          { surface: 'إيفان بيتروف', lang: 'ar' },
        ],
      },
      telemetry: [tele('en', 'mention', 0.9), tele('ru', 'mention', 0.9)],
    },
  },
  {
    id: 'ml.frag.company-latin',
    failureMode: 'entity_fragmentation',
    storeLang: 'en',
    queryLang: 'de',
    direction: 'cross',
    description: 'One company with locale legal suffixes (GmbH / S.A.) must stay one node.',
    gold: {
      linking: {
        goldEntity: 'cross.company_orbital',
        surfaces: [
          { surface: 'Orbital Dynamics', lang: 'en' },
          { surface: 'Orbital Dynamics GmbH', lang: 'de' },
          { surface: 'Orbital Dynamics S.A.', lang: 'es' },
        ],
      },
    },
  },
  {
    id: 'ml.frag.person-hi-en',
    failureMode: 'entity_fragmentation',
    storeLang: 'en',
    queryLang: 'hi',
    direction: 'cross',
    description: 'A person named in Latin and Devanagari must collapse to one node.',
    gold: {
      linking: {
        goldEntity: 'cross.person_aarav',
        surfaces: [
          { surface: 'Aarav Sharma', lang: 'en' },
          { surface: 'आरव शर्मा', lang: 'hi' },
        ],
      },
    },
  },

  // ── Temporal expressions per locale ─────────────────────────────────
  // Every locale writes 2026-03-03 differently (order, month name,
  // native digits). Gold is the resolved ISO day; exact-day accuracy
  // measures per-locale resolution. All carry the temporal lane.
  {
    id: 'ml.temp.en',
    failureMode: 'temporal_locale',
    storeLang: 'en',
    queryLang: 'en',
    direction: 'mono',
    description: 'English "March 3, 2026".',
    gold: {
      temporal: { expression: 'March 3, 2026', lang: 'en', goldDate: '2026-03-03' },
      lane: { goldLabel: 'temporal' },
      telemetry: [tele('en', 'fact', 0.95)],
    },
  },
  {
    id: 'ml.temp.de',
    failureMode: 'temporal_locale',
    storeLang: 'de',
    queryLang: 'de',
    direction: 'mono',
    description: 'German "3. März 2026" (day-first, umlaut month).',
    gold: {
      temporal: { expression: '3. März 2026', lang: 'de', goldDate: '2026-03-03' },
      lane: { goldLabel: 'temporal' },
      telemetry: [tele('de', 'fact', 0.93)],
    },
  },
  {
    id: 'ml.temp.es',
    failureMode: 'temporal_locale',
    storeLang: 'es',
    queryLang: 'es',
    direction: 'mono',
    description: 'Spanish "3 de marzo de 2026".',
    gold: {
      temporal: { expression: '3 de marzo de 2026', lang: 'es', goldDate: '2026-03-03' },
      lane: { goldLabel: 'temporal' },
      telemetry: [tele('es', 'fact', 0.92)],
    },
  },
  {
    id: 'ml.temp.ru',
    failureMode: 'temporal_locale',
    storeLang: 'ru',
    queryLang: 'ru',
    direction: 'mono',
    description: 'Russian "3 марта 2026" (genitive month).',
    gold: {
      temporal: { expression: '3 марта 2026', lang: 'ru', goldDate: '2026-03-03' },
      lane: { goldLabel: 'temporal' },
      telemetry: [tele('ru', 'fact', 0.92)],
    },
  },
  {
    id: 'ml.temp.zh',
    failureMode: 'temporal_locale',
    storeLang: 'zh',
    queryLang: 'zh',
    direction: 'mono',
    description: 'Chinese "2026年3月3日" (year-first, unit glyphs).',
    gold: {
      temporal: { expression: '2026年3月3日', lang: 'zh', goldDate: '2026-03-03' },
      lane: { goldLabel: 'temporal' },
      telemetry: [tele('zh', 'fact', 0.9)],
    },
  },
  {
    id: 'ml.temp.ar',
    failureMode: 'temporal_locale',
    storeLang: 'ar',
    queryLang: 'ar',
    direction: 'mono',
    description: 'Arabic "٣ مارس ٢٠٢٦" (eastern-arabic digits, RTL).',
    gold: {
      temporal: { expression: '٣ مارس ٢٠٢٦', lang: 'ar', goldDate: '2026-03-03' },
      lane: { goldLabel: 'temporal' },
      telemetry: [tele('ar', 'fact', 0.86)],
    },
  },
  {
    id: 'ml.temp.hi',
    failureMode: 'temporal_locale',
    storeLang: 'hi',
    queryLang: 'hi',
    direction: 'mono',
    description: 'Hindi "3 मार्च 2026".',
    gold: {
      temporal: { expression: '3 मार्च 2026', lang: 'hi', goldDate: '2026-03-03' },
      lane: { goldLabel: 'temporal' },
      telemetry: [tele('hi', 'fact', 0.85)],
    },
  },

  // ── Code-switching ──────────────────────────────────────────────────
  // A single query/fact mixing two scripts. Exercises routing under
  // mixed input, the answer-language pin, conflict labelling, and the
  // abstention split (the false-premise case MUST refuse).
  {
    id: 'ml.cs.ru-en-retr',
    failureMode: 'code_switching',
    storeLang: 'ru',
    queryLang: 'en',
    direction: 'cross',
    description: 'Code-switched RU+EN query still routes to the engineering lead.',
    gold: {
      retrieval: { goldRef: 'cross.role_eng', corpusRefs: ROLE_CORPUS },
      lane: { goldLabel: 'default' },
      answerLang: { intended: 'ru' },
      abstention: { shouldAnswer: true },
      telemetry: [tele('ru', 'query', 0.6), tele('en', 'query', 0.55)],
    },
  },
  {
    id: 'ml.cs.false-premise',
    failureMode: 'code_switching',
    storeLang: 'ru',
    queryLang: 'en',
    direction: 'cross',
    description: 'Code-switched question about a role that was never stored — must abstain.',
    gold: {
      answerLang: { intended: 'en' },
      abstention: { shouldAnswer: false },
      telemetry: [tele('en', 'query', 0.6), tele('ru', 'query', 0.5)],
    },
  },
  {
    id: 'ml.cs.conflict',
    failureMode: 'code_switching',
    storeLang: 'ru',
    queryLang: 'en',
    direction: 'cross',
    description: 'Two role facts in different languages disagree — label as a value conflict.',
    gold: {
      conflict: { goldLabel: 'value_conflict' },
      lane: { goldLabel: 'contradiction' },
      telemetry: [tele('ru', 'fact', 0.9), tele('en', 'fact', 0.9)],
    },
  },
];
