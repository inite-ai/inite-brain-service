/**
 * Unit sanity for the domain-pack battery scorers (test/eval/
 * domain-packs/scorers.ts) — the mechanical judges of the battery.
 * Pure fixtures, no HTTP: if these are wrong, every scorecard is
 * wrong, so they get their own spec even though the battery itself
 * never runs in CI. The generic primitives the battery reuses
 * (containsAnyOf, isAbstention, walkProvenance, checkHistorySequence,
 * scoreServe, …) are covered by the siblings'
 * test/memory-fitness-scorers.unit-spec.ts and
 * test/state-transition-scorers.unit-spec.ts.
 *
 * The corpus-integrity block additionally pins the battery's own
 * scoreability invariants (real pack predicate ids, verbatim
 * provenance fragments, the 600-char provenance cap).
 */
import {
  ALL_TURNS,
  CHECKS,
  FIN,
  FIN_DOMAIN,
  BATTERY_PACKS,
  FINTECH_PACK,
  MED,
  MED_DOMAIN,
  MEDICAL_PACK,
  packPredicate,
} from './eval/domain-packs/corpus';
import {
  checkCrossDomainEntity,
  checkInterleavedDomains,
  checkPacksInstalled,
  findExactPredicateFact,
  findNamespacedTools,
  inDomain,
  scoreServeCross,
  type HitLike,
  type InstalledPackLike,
} from './eval/domain-packs/scorers';
import type { HistoryEvent } from './eval/state-transitions/scorers';

describe('domain-pack scorers', () => {
  describe('install matcher', () => {
    const installed: InstalledPackLike[] = [
      { packId: 'fintech', version: '0.1.0' },
      { packId: 'medical', version: '0.1.0' },
      { packId: 'code_memory', version: '0.2.0' },
    ];

    it('passes when every wanted pack is installed at the wanted version', () => {
      const v = checkPacksInstalled(installed, [
        { packId: 'fintech', version: '0.1.0' },
        { packId: 'medical', version: '0.1.0' },
      ]);
      expect(v.pass).toBe(true);
      expect(v.detail).toContain('fintech@0.1.0');
    });

    it('fails and names an absent pack', () => {
      const v = checkPacksInstalled(installed, [{ packId: 'legal', version: '0.1.0' }]);
      expect(v.pass).toBe(false);
      expect(v.detail).toContain('legal@0.1.0 (absent)');
    });

    it('fails and names a version mismatch', () => {
      const v = checkPacksInstalled(installed, [{ packId: 'fintech', version: '0.2.0' }]);
      expect(v.pass).toBe(false);
      expect(v.detail).toContain('installed at v0.1.0');
    });
  });

  describe('exact-predicate vocabulary matcher', () => {
    const hits: HitLike[] = [
      {
        entityId: 'e1',
        canonicalName: 'Meridian Clinic',
        facts: [
          { factId: 'f1', predicate: 'fintech__licensed_as', object: 'EMI' },
          { factId: 'f2', predicate: 'has_license', object: 'EMI license' },
          { factId: 'f3', predicate: 'medical__treats', object: 'type 2 diabetes' },
        ],
      },
      {
        entityId: 'e2',
        canonicalName: 'Dr. Vega',
        facts: [{ factId: 'f4', predicate: 'works_at', object: 'Meridian Clinic' }],
      },
    ];

    it('passes on the exact namespaced predicate with a matching value', () => {
      const v = findExactPredicateFact(hits, 'fintech__licensed_as', ['EMI']);
      expect(v.pass).toBe(true);
      expect(v.detail).toContain('f1');
      expect(v.detail).toContain('fintech__licensed_as');
    });

    it('fails and names the coined predicates that swallowed the value', () => {
      const v = findExactPredicateFact(hits, 'fintech__regulated_by', ['EMI']);
      expect(v.pass).toBe(false);
      expect(v.detail).toContain('coined predicate');
      expect(v.detail).toContain('has_license');
      // The exact-hit fact of ANOTHER predicate also counts as coinage
      // evidence for this one — the value landed somewhere else.
      expect(v.detail).toContain('fintech__licensed_as');
    });

    it('does not pass on the right predicate with the wrong value', () => {
      const v = findExactPredicateFact(hits, 'fintech__licensed_as', ['broker-dealer']);
      expect(v.pass).toBe(false);
      expect(v.detail).toContain('at all');
    });
  });

  describe('domain classifier', () => {
    it('classifies by namespace prefix regardless of markers', () => {
      expect(inDomain('fintech__settlement_period', 'weekly', FIN_DOMAIN)).toBe(true);
    });

    it('classifies by corpus value marker when the predicate is coined', () => {
      expect(inDomain('settles_in', 'T+1', FIN_DOMAIN)).toBe(true);
      expect(inDomain('dosage', '850 mg of metformin', MED_DOMAIN)).toBe(true);
    });

    it('rejects a fact matching neither namespace nor markers', () => {
      expect(inDomain('founded_in', '2009', FIN_DOMAIN)).toBe(false);
    });
  });

  describe('cross-domain entity check', () => {
    const spec = {
      entityNameToken: 'meridian',
      domains: [FIN_DOMAIN, MED_DOMAIN] as [typeof FIN_DOMAIN, typeof MED_DOMAIN],
      genericMarkers: ['2009', 'Lisbon'],
    };
    const clinic = (facts: NonNullable<HitLike['facts']>): HitLike => ({
      entityId: 'e1',
      canonicalName: 'Meridian Clinic',
      facts,
    });
    const bothDomainFacts = [
      { factId: 'f1', predicate: 'licensed_as', object: 'EMI' },
      { factId: 'f2', predicate: 'medical__treats', object: 'type 2 diabetes' },
      { factId: 'f3', predicate: 'founded_in', object: '2009' },
    ];

    it('passes on one entity carrying both domains plus a generic fact', () => {
      const v = checkCrossDomainEntity([clinic(bothDomainFacts)], spec);
      expect(v.pass).toBe(true);
      expect(v.detail).toContain('fintech=1, medical=1, generic=1');
    });

    it('fails on per-domain entity duplication', () => {
      const dup: HitLike = {
        entityId: 'e9',
        canonicalName: 'Meridian Clinic (payments)',
        facts: [],
      };
      const v = checkCrossDomainEntity([clinic(bothDomainFacts), dup], spec);
      expect(v.pass).toBe(false);
      expect(v.detail).toContain('duplicated across 2 hits');
    });

    it('fails when one domain is missing from the entity', () => {
      const v = checkCrossDomainEntity(
        [
          clinic([
            { factId: 'f1', predicate: 'licensed_as', object: 'EMI' },
            { factId: 'f3', predicate: 'founded_in', object: '2009' },
          ]),
        ],
        spec,
      );
      expect(v.pass).toBe(false);
      expect(v.detail).toContain('medical=0');
    });

    it('fails when no hit carries the entity name token', () => {
      const v = checkCrossDomainEntity(
        [{ entityId: 'e2', canonicalName: 'Dr. Vega', facts: [] }],
        spec,
      );
      expect(v.pass).toBe(false);
      expect(v.detail).toContain('no hit named');
    });
  });

  describe('timeline interleave check', () => {
    const ev = (predicate: string, object: string, at: string): HistoryEvent => ({
      predicate,
      object,
      at,
    });

    it('passes when neither domain sits entirely before the other', () => {
      const v = checkInterleavedDomains(
        [
          ev('licensed_as', 'EMI', '2026-08-31T09:00:00Z'),
          ev('treats', 'type 2 diabetes', '2026-08-31T14:00:00Z'),
          ev('complies_with', 'SOC 2', '2026-09-02T11:05:00Z'),
          ev('administered_via', 'intravenous infusion', '2026-09-02T11:10:00Z'),
        ],
        FIN_DOMAIN,
        MED_DOMAIN,
      );
      expect(v.pass).toBe(true);
      expect(v.detail).toContain('interleave');
    });

    it('fails when one domain is a single block before the other', () => {
      const v = checkInterleavedDomains(
        [
          ev('licensed_as', 'EMI', '2026-08-31T09:00:00Z'),
          ev('settles_in', 'T+2', '2026-08-31T09:05:00Z'),
          ev('treats', 'type 2 diabetes', '2026-09-02T14:00:00Z'),
        ],
        FIN_DOMAIN,
        MED_DOMAIN,
      );
      expect(v.pass).toBe(false);
      expect(v.detail).toContain('do not interleave');
    });

    it('fails when a domain is absent from the timeline', () => {
      const v = checkInterleavedDomains(
        [ev('licensed_as', 'EMI', '2026-08-31T09:00:00Z')],
        FIN_DOMAIN,
        MED_DOMAIN,
      );
      expect(v.pass).toBe(false);
      expect(v.detail).toContain('lacks a domain');
    });
  });

  describe('cross-domain serve verdict', () => {
    const groups = [
      ['EMI', 'FCA'],
      ['diabetes', 'metformin'],
    ];

    it('passes when the answer carries a marker of every domain group', () => {
      const v = scoreServeCross(
        'Meridian Clinic is an FCA-regulated payments provider that also treats type 2 diabetes.',
        undefined,
        groups,
      );
      expect(v.status).toBe('pass');
    });

    it('fails and names the missing domain group', () => {
      const v = scoreServeCross(
        'Meridian Clinic is an FCA-regulated payments provider.',
        undefined,
        groups,
      );
      expect(v.status).toBe('fail');
      expect(v.detail).toContain('diabetes | metformin');
    });

    it('fails on abstention — the entity is richly known', () => {
      const v = scoreServeCross(null, 'no_facts', groups);
      expect(v.status).toBe('fail');
      expect(v.detail).toContain('abstained');
    });
  });

  describe('rogue-tool scan', () => {
    it('accepts builtin single-underscore tools', () => {
      expect(
        findNamespacedTools(['search_knowledge', 'get_entity_timeline', 'synthesize']),
      ).toEqual([]);
    });

    it('flags pack-namespaced tools', () => {
      expect(findNamespacedTools(['search_knowledge', 'fintech__score_risk'])).toEqual([
        'fintech__score_risk',
      ]);
    });
  });
});

describe('domain-pack corpus integrity', () => {
  it('derives every referenced predicate from the real pack manifests', () => {
    // The corpus builds these through the packPredicate guard, which
    // throws on manifest drift — this pins the derived ids too.
    expect(FIN.settlement).toBe('fintech__settlement_period');
    expect(FIN.licensed).toBe('fintech__licensed_as');
    expect(MED.treats).toBe('medical__treats');
    expect(MED.dosed).toBe('medical__dosed_at');
    expect(() => packPredicate(FINTECH_PACK, 'kyc_status')).toThrow(/not in fintech/);
    expect(() => packPredicate(MEDICAL_PACK, 'specialty')).toThrow(/not in medical/);
  });

  it('targets only predicates that exist in the installed manifests', () => {
    // Derived from BATTERY_PACKS, not a hand-kept pair: the battery grew
    // from two packs to six, and a hardcoded list here would have to be
    // remembered on every growth — which is exactly how a gate stops
    // gating.
    const known = new Set(
      BATTERY_PACKS.flatMap((pack) => pack.predicates.map((p) => `${pack.id}__${p.localId}`)),
    );
    const unknown: string[] = [];
    for (const check of CHECKS) {
      if (check.kind === 'pack-vocab' && !known.has(check.predicate)) {
        unknown.push(`${check.id} -> ${check.predicate}`);
      }
    }
    expect(unknown).toEqual([]);
  });

  it('seeds every provenance fragment verbatim in exactly one turn', () => {
    for (const check of CHECKS) {
      if (check.kind !== 'trace-provenance') continue;
      for (const fragment of check.episodeFragments) {
        const carriers = ALL_TURNS.filter((t) =>
          t.text.toLowerCase().includes(fragment.toLowerCase()),
        );
        expect(carriers).toHaveLength(1);
      }
    }
  });

  it('keeps every turn under the 600-char provenance cap', () => {
    for (const turn of ALL_TURNS) {
      expect(turn.text.length).toBeLessThan(600);
    }
  });

  it('never restates the OLD transition value in the NEW turn', () => {
    // Scoreability: the history subsequence and the serve markers must
    // not cross-match. For each transition check, the last-stage turn
    // must not contain any first-stage marker.
    for (const check of CHECKS) {
      if (check.kind !== 'pack-transition') continue;
      const [oldStage, newStage] = [check.stages[0], check.stages[check.stages.length - 1]];
      if (oldStage === undefined || newStage === undefined) continue;
      const newTurns = ALL_TURNS.filter((t) =>
        newStage.some((m) => t.text.toLowerCase().includes(m.toLowerCase())),
      );
      expect(newTurns.length).toBeGreaterThan(0);
      for (const turn of newTurns) {
        for (const marker of oldStage) {
          expect(turn.text.toLowerCase()).not.toContain(marker.toLowerCase());
        }
      }
    }
  });

  it('uses unique check ids', () => {
    const ids = CHECKS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
