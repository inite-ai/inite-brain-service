/**
 * Corpus-builder contract for the state-transition battery's variation
 * axis (test/eval/state-transitions/variants.ts). Four pins:
 *
 *  1. default identity — buildScenarios('default') IS the current
 *     corpus, byte-identical (same reference AND same serialized
 *     bytes), so the axis can never drift the baseline;
 *  2. structural parity — every variant keeps every scenario, every
 *     check (id, kind, count), every conversation/turn/timestamp; only
 *     turn TEXT differs. No scenario loses checks, no marker list
 *     loses a default marker (except provenance fragments, which are
 *     corpus text and are REPLACED — pinned verbatim below);
 *  3. paraphrase honesty — the paraphrase corpus contains NO verb of
 *     the deterministic state-verb lexicon (asserted against the REAL
 *     exported STATE_VERB_LEXICON, not a copy), so a paraphrase pass
 *     can only come from the transition classifier or the LLM lane;
 *  4. ru honesty — every RU turn actually carries Cyrillic, and every
 *     variant's provenance fragments are verbatim substrings of that
 *     variant's seeded turns (a fragment that quotes nothing measures
 *     nothing).
 */
import { STATE_VERB_LEXICON } from '../src/ai/extractor-internals/state-verb-harvest';
import { SCENARIOS } from './eval/state-transitions/scenarios';
import {
  allTurnsOf,
  buildScenarios,
  parseVariant,
  STEV_VARIANTS,
  type StevVariant,
} from './eval/state-transitions/variants';
import type { Check } from './eval/state-transitions/types';

const VARIANTS: readonly StevVariant[] = STEV_VARIANTS;
const NON_DEFAULT = VARIANTS.filter((v) => v !== 'default');

/** The default-marker lists a variant must never shrink. */
function markerLists(check: Check): Record<string, readonly string[] | undefined> {
  switch (check.kind) {
    case 'serve':
      return {
        expectAnyOf: check.expectAnyOf,
        forbidAnyOf: check.forbidAnyOf,
        sideA: check.conflictSides?.sideA,
        sideB: check.conflictSides?.sideB,
      };
    case 'belief':
      return {
        subjectTokens: check.subjectTokens,
        fieldTokens: check.fieldTokens,
        valueMarkers: check.valueMarkers,
        priorMarkers: check.priorMarkers,
      };
    case 'fact-history':
      return Object.fromEntries(check.stages.map((s, i) => [`stage${i}`, s]));
    case 'provenance':
      // Fragments are corpus text — replaced per variant, pinned by the
      // verbatim test below instead of the superset rule.
      return {};
  }
}

describe('state-transition corpus builder (variation axis)', () => {
  it('parses the variant env value strictly', () => {
    expect(parseVariant(undefined)).toBe('default');
    expect(parseVariant('')).toBe('default');
    expect(parseVariant('default')).toBe('default');
    expect(parseVariant('paraphrase')).toBe('paraphrase');
    expect(parseVariant('ru')).toBe('ru');
    expect(parseVariant('RU')).toBeNull();
    expect(parseVariant('russian')).toBeNull();
  });

  it('default is the current corpus, byte-identical', () => {
    const built = buildScenarios('default');
    expect(built).toBe(SCENARIOS);
    expect(JSON.stringify(built)).toBe(JSON.stringify(SCENARIOS));
  });

  it.each(NON_DEFAULT)('%s keeps every scenario and every check (id, kind, order)', (variant) => {
    const built = buildScenarios(variant);
    expect(built.map((s) => s.key)).toEqual(SCENARIOS.map((s) => s.key));
    for (const [i, scenario] of built.entries()) {
      const base = SCENARIOS[i];
      if (base === undefined) throw new Error('scenario count changed');
      expect(scenario.checks.map((c) => `${c.id}:${c.kind}`)).toEqual(
        base.checks.map((c) => `${c.id}:${c.kind}`),
      );
    }
  });

  it.each(NON_DEFAULT)('%s keeps the ingest structure — only turn text differs', (variant) => {
    const built = buildScenarios(variant);
    for (const [i, scenario] of built.entries()) {
      const base = SCENARIOS[i];
      if (base === undefined) throw new Error('scenario count changed');
      expect(scenario.turns.map((t) => `${t.conversation}#${t.turn}@${t.emittedAt}`)).toEqual(
        base.turns.map((t) => `${t.conversation}#${t.turn}@${t.emittedAt}`),
      );
    }
    // Same total corpus size in every variant (52 turns today).
    expect(allTurnsOf(built).length).toBe(allTurnsOf(SCENARIOS).length);
  });

  it.each(NON_DEFAULT)('%s never drops a default marker from any check', (variant) => {
    const built = buildScenarios(variant);
    for (const [i, scenario] of built.entries()) {
      const base = SCENARIOS[i];
      if (base === undefined) throw new Error('scenario count changed');
      for (const [j, check] of scenario.checks.entries()) {
        const baseCheck = base.checks[j];
        if (baseCheck === undefined) throw new Error('check count changed');
        const baseLists = markerLists(baseCheck);
        const builtLists = markerLists(check);
        for (const [name, baseList] of Object.entries(baseLists)) {
          if (baseList === undefined) {
            expect(builtLists[name]).toBeUndefined();
            continue;
          }
          for (const marker of baseList) {
            expect(builtLists[name]).toContain(marker);
          }
        }
      }
    }
  });

  it('paraphrase corpus contains NO state-verb-lexicon verb (classifier-only by construction)', () => {
    const lexicon = new RegExp(
      `\\b(?:${[...STATE_VERB_LEXICON].sort((a, b) => b.length - a.length).join('|')})\\b`,
      'i',
    );
    for (const turn of allTurnsOf(buildScenarios('paraphrase'))) {
      const hit = lexicon.exec(turn.text);
      expect(
        hit === null ? null : `${turn.conversation}#${turn.turn} contains lexicon verb "${hit[0]}"`,
      ).toBeNull();
    }
  });

  it('ru corpus is actually Russian — every turn carries Cyrillic', () => {
    for (const turn of allTurnsOf(buildScenarios('ru'))) {
      expect(/[а-яё]/i.test(turn.text)).toBe(true);
    }
  });

  it.each(VARIANTS)(
    '%s provenance fragments quote a seeded turn of the SAME variant verbatim',
    (variant) => {
      const built = buildScenarios(variant);
      const texts = allTurnsOf(built).map((t) => t.text);
      for (const scenario of built) {
        for (const check of scenario.checks) {
          if (check.kind !== 'provenance') continue;
          expect(check.episodeFragments.length).toBeGreaterThan(0);
          for (const fragment of check.episodeFragments) {
            const carrier = texts.find((t) => t.includes(fragment));
            expect(
              carrier === undefined ? `${check.id}: fragment "${fragment}" quotes no turn` : 'ok',
            ).toBe('ok');
          }
        }
      }
    },
  );

  it('variant serve checks stay honest — no bare negation markers were introduced', () => {
    // The scenarios.ts header rule: decline answers contain 'no' /
    // 'do not', and 'now' contains 'no' — a variant extension must not
    // smuggle them in as expect markers.
    const banned = new Set(['no', 'not', 'do not', "don't", 'нет', 'не']);
    for (const variant of NON_DEFAULT) {
      for (const scenario of buildScenarios(variant)) {
        for (const check of scenario.checks) {
          if (check.kind !== 'serve' || check.expectAnyOf === undefined) continue;
          for (const marker of check.expectAnyOf) {
            expect(banned.has(marker.toLowerCase())).toBe(false);
          }
        }
      }
    }
  });
});
