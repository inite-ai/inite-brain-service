/**
 * Scoreability invariants of the domain-pack battery corpus.
 *
 * The battery's verdicts are only worth reading if its markers actually
 * discriminate. A provenance fragment that appears in two turns lets the
 * unroll check pass against the wrong episode; a forbidden marker that
 * shares a turn with an expected one makes an isolation check
 * unsatisfiable; a transition stage value restated later makes the
 * history subsequence cross-match. None of that fails loudly at run
 * time — it just produces a number nobody can trust.
 *
 * These run without a stand, so a corpus edit is checked in CI rather
 * than discovered on the next paid run.
 */
import { ALL_TURNS, BATTERY_PACKS, CHECKS, GENERIC_MARKERS } from './eval/domain-packs/corpus';

const texts = ALL_TURNS.map((t) => t.text);
const turnsContaining = (needle: string): string[] => texts.filter((t) => t.includes(needle));

type LooseCheck = Record<string, unknown> & { id: string };
const checks = CHECKS as unknown as LooseCheck[];

describe('domain-pack corpus — coverage', () => {
  it('exercises every first-party pack the battery installs', () => {
    // Four of these (legal / hr / insurance / real_estate) shipped and
    // were run by nothing at all until the battery grew to cover them.
    expect(BATTERY_PACKS.map((p) => p.id).sort()).toEqual([
      'fintech',
      'hr',
      'insurance',
      'legal',
      'medical',
      'real_estate',
    ]);
  });

  it('gives every installed pack at least one vocab, transition and trace check', () => {
    const idsFor = (cls: string) =>
      checks.filter((c) => c.cls === cls).map((c) => c.id.toLowerCase());
    // Check ids carry a domain tag: c16-vocab-leg, c24-transition-leg…
    const tags: Record<string, string> = {
      fintech: 'fin',
      medical: 'med',
      legal: 'leg',
      hr: 'hr',
      insurance: 'ins',
      real_estate: 're',
    };
    const gaps: string[] = [];
    for (const pack of BATTERY_PACKS) {
      const tag = tags[pack.id] ?? pack.id;
      for (const cls of ['vocab', 'transition', 'trace']) {
        const hit = idsFor(cls).some((id) => id.endsWith(`-${tag}`) || id.includes(`-${tag}-`));
        if (!hit) gaps.push(`${pack.id} has no ${cls} check`);
      }
    }
    expect(gaps).toEqual([]);
  });
});

describe('domain-pack corpus — scoreability', () => {
  it('every provenance fragment appears verbatim in exactly one turn', () => {
    const offenders: string[] = [];
    for (const check of checks) {
      for (const frag of (check.episodeFragments as string[] | undefined) ?? []) {
        const hits = turnsContaining(frag).length;
        if (hits !== 1) offenders.push(`${check.id}: "${frag}" in ${hits} turns`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no isolation check forbids a marker that shares a turn with what it expects', () => {
    const offenders: string[] = [];
    for (const check of checks) {
      const expected = (check.expectAnyOf as string[] | undefined) ?? [];
      const forbidden = (check.forbidAnyOf as string[] | undefined) ?? [];
      for (const e of expected) {
        const carriers = turnsContaining(e);
        if (carriers.length === 0) {
          offenders.push(`${check.id}: expected "${e}" is in no corpus turn`);
          continue;
        }
        for (const f of forbidden) {
          if (carriers.some((t) => t.includes(f))) {
            offenders.push(`${check.id}: "${e}" shares a turn with forbidden "${f}"`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every transition stage value appears in exactly one turn', () => {
    // The rule that makes an ordered history readable: a transition turn
    // never restates the old value, so stage 1 and stage 2 cannot both
    // match the same turn.
    const offenders: string[] = [];
    for (const check of checks) {
      for (const stage of (check.stages as string[][] | undefined) ?? []) {
        for (const value of stage) {
          const hits = turnsContaining(value).length;
          if (hits !== 1) offenders.push(`${check.id}: stage "${value}" in ${hits} turns`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('generic markers stay exclusive to the domain-free conversation', () => {
    // The cross-entity check proves generic facts attach to the shared
    // entity by finding one of these. A second home for the token lets a
    // domain fact satisfy that evidence and quietly weakens the check —
    // "Lisbon" in an HR turn did exactly that while this was being written.
    const offenders: string[] = [];
    for (const marker of GENERIC_MARKERS) {
      const hits = turnsContaining(marker);
      if (hits.length !== 1) offenders.push(`"${marker}" in ${hits.length} turns`);
    }
    expect(offenders).toEqual([]);
  });

  it('check ids are unique', () => {
    const ids = checks.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
