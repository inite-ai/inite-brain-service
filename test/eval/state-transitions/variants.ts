/**
 * Variation axis of the state-transition battery (STEV_VARIANT):
 * the SAME 12 scenarios, the SAME checks, three phrasings of the corpus.
 *
 *  - `default`    — the original corpus, byte-identical (buildScenarios
 *    returns the SCENARIOS array itself; pinned by unit test).
 *  - `paraphrase` — same facts, phrased WITHOUT any verb of the
 *    deterministic state-verb lexicon (src/ai/extractor-internals/
 *    state-verb-harvest.ts — pinned against the exported
 *    STATE_VERB_LEXICON by unit test), so only the transition
 *    classifier lane (morphology + BGE-M3 prototypes) and the LLM
 *    extractor can catch the transitions ("parted with the Kawasaki"
 *    for sold, "walked away from the chess club" for quit, …).
 *  - `ru`         — faithful Russian phrasings of the same facts
 *    (speakers/entities keep their names; brand names stay Latin, the
 *    way Russian text actually writes them), exercising the RU
 *    prototype path of the classifier («продал», «вернул», «вступил»,
 *    «записался», …) and the RU candidate matcher's sentence-scoped
 *    guards.
 *
 * Variants measure ROBUSTNESS, not pass/fail parity — see README.md.
 *
 * Overlay semantics (enforced by applyScenario / unit-tested):
 *
 *  - turn overlays REPLACE the text of a conversation's turns 1:1 —
 *    same conversation ids, same turn counts, same timestamps, so the
 *    ingest structure is identical across variants;
 *  - check overlays only EXTEND marker lists (expectAnyOf, conflict
 *    sides, history stages, belief tokens) with alternates the variant
 *    corpus makes legitimate — a served answer echoing «вернул» is as
 *    correct as one echoing 'returned'. Nothing is removed: every
 *    default marker stays, forbid lists stay, check ids/kinds/counts
 *    stay. The ONE replacement is provenance episodeFragments, which
 *    MUST quote the variant's seeded turns verbatim to mean anything —
 *    the builder refuses a variant that leaves them stale.
 */
import type {
  BeliefCheck,
  Check,
  FactHistoryCheck,
  ProvenanceCheck,
  Scenario,
  ScenarioTurn,
  ServeCheck,
} from './types';
import { SCENARIOS } from './scenarios';

export type StevVariant = 'default' | 'paraphrase' | 'ru';

export const STEV_VARIANTS: readonly StevVariant[] = ['default', 'paraphrase', 'ru'];

export function parseVariant(raw: string | undefined): StevVariant | null {
  if (raw === undefined || raw === '') return 'default';
  return (STEV_VARIANTS as readonly string[]).includes(raw) ? (raw as StevVariant) : null;
}

/** Per-check marker extensions / provenance replacement (see header). */
interface CheckOverlay {
  /** serve: appended to expectAnyOf. */
  expectExtra?: string[];
  /** serve conflict mode: appended to the respective side. */
  sideAExtra?: string[];
  sideBExtra?: string[];
  /** provenance: REPLACES episodeFragments (verbatim in variant turns). */
  fragments?: string[];
  /** fact-history: per-stage appended markers, aligned to stages. */
  stagesExtra?: string[][];
  /** belief: appended token/marker alternates. */
  subjectExtra?: string[];
  fieldExtra?: string[];
  valueExtra?: string[];
  priorExtra?: string[];
}

interface ScenarioOverlay {
  /** conversation id -> replacement texts for ALL its turns, in order. */
  turns?: Record<string, string[]>;
  /** check id -> marker overlay. */
  checks?: Record<string, CheckOverlay>;
}

type VariantOverlay = Record<string, ScenarioOverlay>;

/** RU alternates for the self-referring belief subject (see scenarios.ts SELF). */
const SELF_RU = ['Саша', 'пользовател'];

// ── paraphrase corpus ───────────────────────────────────────────────
// Rule: rephrase every turn that carried a transition (or any lexicon
// verb); scaffold turns stay byte-identical to the default corpus so
// deltas attribute to the transition phrasing, not to corpus drift.
const PARAPHRASE: VariantOverlay = {
  s01: {
    turns: {
      s01a: [
        'Life log, 2026-08-03. Weekend update: there is a new vehicle in my life.',
        "I picked up a Kawasaki Ninja on Saturday — it's registered to me.",
        'The Ninja lives in the garage; I plan to ride it to work on dry days.',
      ],
      s01b: [
        'Life log, 2026-08-10. The motorcycle experiment is over.',
        'I parted with the Kawasaki today; no bike anymore.',
        'The buyer picked it up this evening and the registration transfer is done.',
      ],
    },
    checks: {
      's01-serve': { expectExtra: ['parted with'] },
    },
  },
  s02: {
    turns: {
      s02b: [
        'Work-setup log, 2026-08-12. Laptop swap day.',
        'I swapped my laptop today: my work laptop is now a MacBook Pro, and the ThinkPad went back to IT.',
        'Everything is carried over; the MacBook Pro is the only machine I work on now.',
      ],
    },
  },
  s03: {
    turns: {
      s03a: [
        'Evening log, 2026-08-02.',
        'I became a member of the chess club today; sessions are on Mondays.',
      ],
      s03b: [
        'Evening log, 2026-08-09.',
        'I walked away from the chess club today; Mondays became too busy at work.',
      ],
      s03c: [
        'Evening log, 2026-08-20.',
        'I came back to the chess club today — they shifted sessions to Thursdays, so I am a member again.',
      ],
    },
    checks: {
      's03-serve': { expectExtra: ['came back'] },
      's03-history': { stagesExtra: [[], ['walked away'], ['came back']] },
    },
  },
  s04: {
    turns: {
      s04a: [
        'Subscriptions log, 2026-08-15. Going through my bank statement.',
        'Turns out I actually pulled the plug on my Spotify subscription back on August 1st.',
        'So since the start of the month I have had no music subscription at all.',
      ],
    },
    checks: {
      's04-serve': { expectExtra: ['pulled the plug'] },
      's04-prov': { fragments: ['pulled the plug on my Spotify'] },
    },
  },
  s05: {
    turns: {
      s05a: [
        'Hobby log, 2026-08-01.',
        'I own a drone — a DJI Mavic 3 from last spring; I fly it most weekends.',
      ],
      s05b: [
        'Hobby log, 2026-08-05.',
        "I'm toying with the idea of parting with my drone, maybe next month.",
        'No decision yet; I want to see what used Mavics go for first.',
      ],
    },
    checks: {
      's05-serve-intent': { expectExtra: ['part with', 'parting with', 'let go', 'letting go'] },
    },
  },
  s06: {
    turns: {
      s06a: [
        'Property log, 2026-08-07.',
        'I put my apartment in Riga on the market today.',
        'The listing went live in the afternoon; the agent expects the first viewings next week.',
      ],
    },
    checks: {
      's06-prov': { fragments: ['put my apartment in Riga on the market'] },
    },
  },
  s07: {
    turns: {
      s07a: [
        'Office log, 2026-08-08.',
        'The office lease is good through December 2026. That is what our signed contract copy says.',
      ],
      s07b: [
        'Office log, 2026-08-14. Surprise from the building manager.',
        'Facilities says the office lease actually wraps up in September 2026.',
        'I have not reconciled the two dates yet; someone is wrong and I need the original lease.',
      ],
    },
    checks: {
      's07-prov': { fragments: ['wraps up in September 2026', 'good through December 2026'] },
    },
  },
  s08: {
    turns: {
      s08b: [
        'Relocation log, 2026-08-18. Another move, sooner than planned.',
        'My place of residence shifted to Porto this week.',
        'The Lisbon chapter is over; from now on Porto is where I live.',
      ],
    },
  },
  s09: {
    turns: {
      s09a: [
        'Family log, 2026-08-09.',
        'My brother Boris was given a company car by his employer.',
      ],
      s09b: [
        'Family log, 2026-08-16.',
        'Boris handed the company car back when he changed employers.',
        'He starts at the new place on September 1st and will commute by train.',
      ],
    },
    checks: {
      's09-serve': { expectExtra: ['handed'] },
    },
  },
  s10: {
    turns: {
      s10a: [
        'Home-office log, 2026-08-11, morning.',
        'Put my name down for the standing desk trial this morning.',
      ],
      s10b: [
        'Home-office log, 2026-08-11, evening. That did not last long.',
        'Sent the standing desk back by evening — hurt my back.',
      ],
    },
    checks: {
      's10-serve': { expectExtra: ['sent'] },
      's10-history': { stagesExtra: [[], ['sent']] },
    },
  },
  s11: {
    turns: {
      s11b: [
        'Photography log, 2026-08-19. Gear cull.',
        'The Canon R6 went to a new owner today; the Fuji stays.',
        'One camera is enough — the X100 covers everything I actually shoot.',
      ],
    },
    checks: {
      's11-serve-sold': { expectExtra: ['new owner'] },
    },
  },
  s12: {
    checks: {
      's12-prov-sold': { fragments: ['parted with the Kawasaki'] },
      's12-prov-bought': { fragments: ['picked up a Kawasaki Ninja'] },
    },
  },
};

// ── Russian corpus ──────────────────────────────────────────────────
// Faithful phrasings, fully translated (a half-EN corpus would measure
// code-switching, not the RU path). Person names go Cyrillic the way
// Russian text writes them («Борис»); brand/product names stay Latin
// (Kawasaki Ninja, ThinkPad, Spotify …) — also the way Russian text
// writes them, and it keeps the brand-marker checks language-neutral.
// Known consequences measured, not papered over: the RU candidate
// guard is sentence-scoped and sentenceSpans splits only before
// Latin-uppercase, so «Я продал Kawasaki сегодня; байка больше нет.»
// is ONE guarded span (the documented deliberate-miss class).
const RUSSIAN: VariantOverlay = {
  s01: {
    turns: {
      s01a: [
        'Жизненный дневник, 2026-08-03. Итоги выходных: в моей жизни появился новый транспорт.',
        'Я купил Kawasaki Ninja в субботу — он зарегистрирован на меня.',
        'Ninja живёт в гараже; планирую ездить на нём на работу в сухие дни.',
      ],
      s01b: [
        'Жизненный дневник, 2026-08-10. Мотоциклетный эксперимент окончен.',
        'Я продал Kawasaki сегодня; байка больше нет.',
        'Покупатель забрал его вечером, и переоформление документов завершено.',
      ],
    },
    checks: {
      's01-serve': { expectExtra: ['продал', 'больше нет'] },
      's01-belief': {
        subjectExtra: SELF_RU,
        fieldExtra: ['мотоцикл', 'байк', 'транспорт'],
        valueExtra: ['нет', 'продал', 'продан'],
        priorExtra: ['Кавасаки'],
      },
    },
  },
  s02: {
    turns: {
      s02a: [
        'Дневник рабочего сетапа, 2026-08-04.',
        'Мой рабочий ноутбук — ThinkPad X1 Carbon; это машина, на которой я делаю всё.',
      ],
      s02b: [
        'Дневник рабочего сетапа, 2026-08-12. День замены ноутбука.',
        'Я заменил ноутбук сегодня: мой рабочий ноутбук теперь MacBook Pro, а ThinkPad вернулся в IT-отдел.',
        'Всё перенесено; MacBook Pro — единственная машина, на которой я теперь работаю.',
      ],
    },
    checks: {
      's02-belief': { subjectExtra: SELF_RU, fieldExtra: ['ноутбук'] },
    },
  },
  s03: {
    turns: {
      s03a: [
        'Вечерний дневник, 2026-08-02.',
        'Я вступил в шахматный клуб сегодня; занятия по понедельникам.',
      ],
      s03b: [
        'Вечерний дневник, 2026-08-09.',
        'Я вышел из шахматного клуба сегодня; понедельники стали слишком загруженными на работе.',
      ],
      s03c: [
        'Вечерний дневник, 2026-08-20.',
        'Я снова вступил в шахматный клуб сегодня — занятия перенесли на четверг, так что я опять член клуба.',
      ],
    },
    checks: {
      's03-serve': { expectExtra: ['член', 'снова'] },
      's03-history': {
        stagesExtra: [
          ['вступил', 'член'],
          ['вышел', 'покинул'],
          ['снова', 'опять'],
        ],
      },
    },
  },
  s04: {
    turns: {
      s04a: [
        'Дневник подписок, 2026-08-15. Разбираю банковскую выписку.',
        'Оказывается, я на самом деле отменил подписку на Spotify ещё 1 августа.',
        'Так что с начала месяца у меня вообще нет музыкальной подписки.',
      ],
    },
    checks: {
      's04-serve': { expectExtra: ['отмен'] },
      's04-prov': { fragments: ['отменил подписку на Spotify'] },
    },
  },
  s05: {
    turns: {
      s05a: [
        'Дневник хобби, 2026-08-01.',
        'У меня есть дрон — DJI Mavic 3, купленный прошлой весной; летаю на нём почти каждые выходные.',
      ],
      s05b: [
        'Дневник хобби, 2026-08-05.',
        'Я подумываю продать дрон, может быть, в следующем месяце.',
        'Решения пока нет; сначала хочу посмотреть, почём уходят подержанные Мавики.',
      ],
    },
    checks: {
      's05-serve-state': { expectExtra: ['есть дрон', 'владе'] },
      's05-serve-intent': { expectExtra: ['продать', 'продаж'] },
    },
  },
  s06: {
    turns: {
      s06a: [
        'Дневник недвижимости, 2026-08-07.',
        'Я выставил свою квартиру в Риге на продажу сегодня.',
        'Объявление появилось днём; агент ждёт первые просмотры на следующей неделе.',
      ],
    },
    checks: {
      's06-serve': { expectExtra: ['выставил', 'на продажу', 'владе'] },
      's06-prov': { fragments: ['выставил свою квартиру в Риге'] },
    },
  },
  s07: {
    turns: {
      s07a: [
        'Офисный дневник, 2026-08-08.',
        'Аренда офиса действует до декабря 2026 года. Так написано в нашей подписанной копии договора.',
      ],
      s07b: [
        'Офисный дневник, 2026-08-14. Сюрприз от управляющего зданием.',
        'Отдел эксплуатации говорит, что аренда офиса на самом деле заканчивается в сентябре 2026 года.',
        'Я ещё не сверил эти две даты; кто-то ошибается, и мне нужен оригинал договора.',
      ],
    },
    checks: {
      's07-serve': { sideAExtra: ['декабр'], sideBExtra: ['сентябр'] },
      's07-prov': {
        fragments: ['заканчивается в сентябре 2026', 'действует до декабря 2026'],
      },
    },
  },
  s08: {
    turns: {
      s08a: ['Дневник переезда, 2026-08-03.', 'Мой домашний город теперь Лиссабон.'],
      s08b: [
        'Дневник переезда, 2026-08-18. Ещё один переезд, раньше, чем планировалось.',
        'Моё место жительства переехало в Порту на этой неделе.',
        'Лиссабонская глава закрыта; отныне я живу в Порту.',
      ],
    },
    checks: {
      's08-belief': {
        subjectExtra: SELF_RU,
        fieldExtra: ['город', 'жительств', 'дом'],
        valueExtra: ['Порту'],
        priorExtra: ['Лиссабон'],
      },
      's08-serve': { expectExtra: ['Порту'] },
    },
  },
  s09: {
    turns: {
      s09a: [
        'Семейный дневник, 2026-08-09.',
        'Мой брат Борис получил служебную машину от работодателя.',
      ],
      s09b: [
        'Семейный дневник, 2026-08-16.',
        'Борис вернул служебную машину, когда сменил работу.',
        'Он выходит на новое место 1 сентября и будет ездить на работу на поезде.',
      ],
    },
    checks: {
      's09-serve': { expectExtra: ['вернул'] },
      's09-belief': {
        subjectExtra: ['Борис'],
        fieldExtra: ['машин', 'автомобил'],
        valueExtra: ['вернул', 'служебн', 'машин'],
      },
    },
  },
  s10: {
    turns: {
      s10a: [
        'Дневник домашнего офиса, 2026-08-11, утро.',
        'Записался на пробу стоячего стола этим утром.',
      ],
      s10b: [
        'Дневник домашнего офиса, 2026-08-11, вечер. Это продлилось недолго.',
        'Вернул стоячий стол к вечеру — заболела спина.',
      ],
    },
    checks: {
      's10-serve': { expectExtra: ['вернул'] },
      's10-history': { stagesExtra: [['записался', 'проб'], ['вернул']] },
    },
  },
  s11: {
    turns: {
      s11a: ['Фотодневник, 2026-08-06.', 'У меня две камеры: Fuji X100 и Canon R6.'],
      s11b: [
        'Фотодневник, 2026-08-19. Чистка техники.',
        'Продал Canon R6 сегодня; Fuji остаётся.',
        'Одной камеры достаточно — X100 закрывает всё, что я реально снимаю.',
      ],
    },
    checks: {
      's11-serve-sold': { expectExtra: ['продал', 'продан'] },
    },
  },
  s12: {
    checks: {
      's12-prov-sold': { fragments: ['продал Kawasaki'] },
      's12-prov-bought': { fragments: ['купил Kawasaki Ninja'] },
    },
  },
};

const OVERLAYS: Record<Exclude<StevVariant, 'default'>, VariantOverlay> = {
  paraphrase: PARAPHRASE,
  ru: RUSSIAN,
};

// ── builder ─────────────────────────────────────────────────────────

function fail(scenario: string, msg: string): never {
  throw new Error(`state-transitions variant overlay (${scenario}): ${msg}`);
}

function applyTurns(s: Scenario, overlay: ScenarioOverlay): ScenarioTurn[] {
  const byConv = new Map<string, number>();
  for (const t of s.turns) byConv.set(t.conversation, (byConv.get(t.conversation) ?? 0) + 1);
  for (const [conv, texts] of Object.entries(overlay.turns ?? {})) {
    const count = byConv.get(conv);
    if (count === undefined) fail(s.key, `overlay names unknown conversation "${conv}"`);
    if (count !== texts.length) {
      fail(s.key, `conversation "${conv}" has ${count} turns, overlay provides ${texts.length}`);
    }
  }
  return s.turns.map((t) => ({
    ...t,
    text: overlay.turns?.[t.conversation]?.[t.turn - 1] ?? t.text,
  }));
}

function extend(base: readonly string[] | undefined, extra: string[] | undefined): string[] {
  return [...(base ?? []), ...(extra ?? [])];
}

function applyServe(s: Scenario, check: ServeCheck, o: CheckOverlay): ServeCheck {
  if (o.expectExtra !== undefined && check.expectAnyOf === undefined) {
    fail(s.key, `${check.id}: expectExtra on a check with no expectAnyOf`);
  }
  if ((o.sideAExtra !== undefined || o.sideBExtra !== undefined) && !check.conflictSides) {
    fail(s.key, `${check.id}: conflict-side extras on a non-conflict check`);
  }
  return {
    ...check,
    ...(check.expectAnyOf !== undefined
      ? { expectAnyOf: extend(check.expectAnyOf, o.expectExtra) }
      : {}),
    ...(check.conflictSides !== undefined
      ? {
          conflictSides: {
            sideA: extend(check.conflictSides.sideA, o.sideAExtra),
            sideB: extend(check.conflictSides.sideB, o.sideBExtra),
          },
        }
      : {}),
  };
}

function applyHistory(s: Scenario, check: FactHistoryCheck, o: CheckOverlay): FactHistoryCheck {
  if (o.stagesExtra === undefined) return { ...check };
  if (o.stagesExtra.length !== check.stages.length) {
    fail(
      s.key,
      `${check.id}: stagesExtra has ${o.stagesExtra.length} entries for ${check.stages.length} stages`,
    );
  }
  return {
    ...check,
    stages: check.stages.map((stage, i) => extend(stage, o.stagesExtra?.[i])),
  };
}

function applyBelief(check: BeliefCheck, o: CheckOverlay): BeliefCheck {
  return {
    ...check,
    subjectTokens: extend(check.subjectTokens, o.subjectExtra),
    fieldTokens: extend(check.fieldTokens, o.fieldExtra),
    ...(check.valueMarkers !== undefined
      ? { valueMarkers: extend(check.valueMarkers, o.valueExtra) }
      : {}),
    ...(check.priorMarkers !== undefined
      ? { priorMarkers: extend(check.priorMarkers, o.priorExtra) }
      : {}),
  };
}

function applyProvenance(s: Scenario, check: ProvenanceCheck, o: CheckOverlay): ProvenanceCheck {
  // A variant corpus rewrites the seeded turns, so stale fragments can
  // no longer be quoted verbatim — the overlay MUST replace them.
  if (o.fragments === undefined || o.fragments.length === 0) {
    fail(s.key, `${check.id}: provenance check without replacement fragments`);
  }
  return { ...check, episodeFragments: o.fragments };
}

function applyCheck(s: Scenario, check: Check, o: CheckOverlay | undefined): Check {
  if (check.kind === 'provenance') {
    // Provenance fragments are corpus text — always variant-authored.
    return applyProvenance(s, check, o ?? {});
  }
  if (o === undefined) return check;
  switch (check.kind) {
    case 'serve':
      return applyServe(s, check, o);
    case 'fact-history':
      return applyHistory(s, check, o);
    case 'belief':
      return applyBelief(check, o);
  }
}

function applyScenario(s: Scenario, overlay: ScenarioOverlay | undefined): Scenario {
  const o = overlay ?? {};
  const checkIds = new Set(s.checks.map((c) => c.id));
  for (const id of Object.keys(o.checks ?? {})) {
    if (!checkIds.has(id)) fail(s.key, `overlay names unknown check "${id}"`);
  }
  return {
    ...s,
    turns: applyTurns(s, o),
    checks: s.checks.map((c) => applyCheck(s, c, o.checks?.[c.id])),
  };
}

/**
 * The corpus builder. `default` returns the SCENARIOS array ITSELF —
 * byte-identical current corpus by construction (unit-pinned); the
 * other variants overlay turn texts and marker extensions per the
 * header contract, validating overlay/corpus alignment as they build.
 */
export function buildScenarios(variant: StevVariant): Scenario[] {
  if (variant === 'default') return SCENARIOS;
  const overlay = OVERLAYS[variant];
  return SCENARIOS.map((s) => applyScenario(s, overlay[s.key]));
}

/** All mention turns of a built corpus, sorted chronologically. */
export function allTurnsOf(scenarios: readonly Scenario[]): ScenarioTurn[] {
  return scenarios.flatMap((s) => s.turns).sort((a, b) => a.emittedAt.localeCompare(b.emittedAt));
}
