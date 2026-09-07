/**
 * Unit sanity for the code-memory battery scorers (test/eval/
 * code-memory/scorers.ts) — the mechanical judges of the battery.
 * Pure fixtures, no HTTP: if these are wrong, every scorecard is
 * wrong, so they get their own spec even though the battery itself
 * never runs in CI. The generic primitives the battery reuses
 * (containsAnyOf, isAbstention, walkProvenance, checkHistorySequence,
 * scoreServe, findExactPredicateFact, findNamespacedTools, …) are
 * covered by the siblings' test/memory-fitness-scorers.unit-spec.ts,
 * test/state-transition-scorers.unit-spec.ts and
 * test/domain-pack-scorers.unit-spec.ts.
 *
 * The corpus-integrity block additionally pins the battery's own
 * scoreability invariants — including the HONESTY POLICY: every check
 * that targets a predicate the live builtin manifest does not declare
 * yet MUST carry a gap annotation (`expectedUnknown`), so the battery
 * can never hardcode green ahead of the parallel PRs.
 */
import type { HitLike } from './eval/domain-packs/scorers';
import {
  ALL_TURNS,
  CHECKS,
  CM,
  CM_040,
  CODE_MEMORY_PACK,
  currentPredicate,
  gap040,
  packHasPredicate,
} from './eval/code-memory/corpus';
import {
  checkBuiltinPredicates,
  checkEntityFactGroups,
  checkNoForbiddenFact,
  checkSupersession,
  checkWhyRoundtrip,
  resolveModuleEntity,
  type PredicateLike,
  type WhyLike,
} from './eval/code-memory/scorers';

describe('code-memory scorers', () => {
  describe('builtin-seed matcher', () => {
    const seeded: PredicateLike[] = [
      { predicateId: 'code_memory__decided', status: 'active' },
      { predicateId: 'code_memory__because', status: 'active' },
      { predicateId: 'code_memory__invariant', status: 'active' },
      { predicateId: 'code_memory__gotcha', status: 'active' },
      { predicateId: 'identifier', status: 'active' },
    ];

    it('passes when every required predicate is present and active', () => {
      const v = checkBuiltinPredicates(seeded, ['code_memory__decided', 'code_memory__gotcha']);
      expect(v.pass).toBe(true);
      expect(v.detail).toContain('without install');
    });

    it('fails and names a missing predicate', () => {
      const v = checkBuiltinPredicates(seeded, ['code_memory__owns']);
      expect(v.pass).toBe(false);
      expect(v.detail).toContain('code_memory__owns');
    });

    it('fails on a non-active status and names it', () => {
      const v = checkBuiltinPredicates(
        [{ predicateId: 'code_memory__decided', status: 'deprecated' }],
        ['code_memory__decided'],
      );
      expect(v.pass).toBe(false);
      expect(v.detail).toContain('code_memory__decided (deprecated)');
    });
  });

  describe('forbidden-transition scan (intention guard)', () => {
    const hits: HitLike[] = [
      {
        entityId: 'e1',
        canonicalName: 'ACME_STRICT_MODE',
        facts: [
          { factId: 'f1', predicate: 'identifier', object: 'ACME_STRICT_MODE' },
          { factId: 'f2', predicate: 'status', object: 'not enabled anywhere' },
        ],
      },
      {
        entityId: 'e2',
        canonicalName: 'cm-agent',
        facts: [{ factId: 'f3', predicate: 'state_change', object: 'merged PR #212 in acme-api' }],
      },
    ];

    it('passes when no state_change fact names the guarded flag', () => {
      const v = checkNoForbiddenFact(hits, 'state_change', ['ACME_STRICT_MODE']);
      expect(v.pass).toBe(true);
      expect(v.detail).toContain('3 facts scanned');
    });

    it('fails and names the offending fact when a voiced plan flipped state', () => {
      const flipped: HitLike[] = [
        ...hits,
        {
          entityId: 'e3',
          canonicalName: 'cm-agent',
          facts: [
            {
              factId: 'f9',
              predicate: 'state_change',
              object: 'enabled ACME_STRICT_MODE next quarter',
            },
          ],
        },
      ];
      const v = checkNoForbiddenFact(flipped, 'state_change', ['ACME_STRICT_MODE']);
      expect(v.pass).toBe(false);
      expect(v.detail).toContain('f9');
      expect(v.detail).toContain('voiced plan flipped state');
    });

    it('only the exact predicate counts — an identifier fact naming the flag is fine', () => {
      const v = checkNoForbiddenFact(hits, 'state_change', ['ACME_STRICT_MODE', 'anywhere']);
      expect(v.pass).toBe(true);
    });
  });

  describe('path-vs-symbol entity identity (resolve + predicate-agnostic scan)', () => {
    const tokens = ['webhook-dispatcher', 'webhookdispatcher', 'webhook dispatcher'];
    const groups = [
      ['dispatch path', 'outbound webhook'],
      ['cents', 'line-item'],
    ];
    const merged: HitLike = {
      entityId: 'e1',
      canonicalName: 'src/gateway/webhook-dispatcher.ts',
      facts: [
        { factId: 'f1', predicate: 'decided', object: 'one dispatch path instead of six' },
        { factId: 'f2', predicate: 'emits', object: 'line-item amounts in cents' },
      ],
    };

    it('resolves exactly one named entity', () => {
      const r = resolveModuleEntity([merged], tokens);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.entity.entityId).toBe('e1');
    });

    it('STRICT uniqueness: per-phrasing duplication fails resolution and names both entities', () => {
      const dup: HitLike = { entityId: 'e2', canonicalName: 'WebhookDispatcher', facts: [] };
      const r = resolveModuleEntity([merged, dup], tokens);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.fail.detail).toContain('split across 2 entities');
        expect(r.fail.detail).toContain('WebhookDispatcher');
      }
    });

    it('fails resolution when no hit carries a module name token', () => {
      const r = resolveModuleEntity(
        [{ entityId: 'e9', canonicalName: 'acme-api', facts: [] }],
        tokens,
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.fail.detail).toContain('no hit named');
    });

    it('passes when the entity carries facts from both phrasings', () => {
      const v = checkEntityFactGroups(
        'src/gateway/webhook-dispatcher.ts',
        merged.facts ?? [],
        groups,
      );
      expect(v.pass).toBe(true);
      expect(v.detail).toContain('both phrasings');
    });

    it('PREDICATE-AGNOSTIC: a split, mis-slotted fact still proves identity when attached', () => {
      // The measured k10 failure (run cmmtq1z412): extraction split the
      // invariant sentence and slotted its fragment as default_value.
      // Identity is about ATTACHMENT to the one entity — the scan must
      // count it under ANY predicate; slot quality is k02–k06 scope.
      const misSlotted = [
        { predicate: 'code_memory__decided', object: 'one dispatch path instead of six' },
        { predicate: 'code_memory__default_value', object: 'every line-item amount in cents' },
        { predicate: 'code_memory__invariant', object: 'never floats' },
      ];
      const v = checkEntityFactGroups('src/gateway/webhook-dispatcher.ts', misSlotted, groups);
      expect(v.pass).toBe(true);
      expect(v.detail).toContain('[cents|line-item]=1');
    });

    it('matches a marker landing in the predicate text, not only the object', () => {
      // A coined predicate can swallow the marker itself ("cents_convention")
      // while the object carries none — attachment still proves identity.
      const inPredicate = [
        { predicate: 'decided', object: 'one dispatch path instead of six' },
        { predicate: 'cents_convention', object: 'minor units only' },
      ];
      const v = checkEntityFactGroups('m', inPredicate, groups);
      expect(v.pass).toBe(true);
    });

    it("fails when one phrasing's facts are missing from the full fact set", () => {
      const onlyPath = [{ predicate: 'decided', object: 'one dispatch path instead of six' }];
      const v = checkEntityFactGroups('src/gateway/webhook-dispatcher.ts', onlyPath, groups);
      expect(v.pass).toBe(false);
      expect(v.detail).toContain('[cents|line-item]=0');
    });
  });

  describe('why roundtrip verdict', () => {
    const out: WhyLike = {
      found: 2,
      memory: [
        { kind: 'decided', text: 'Cap the replay window at 48 hours' },
        { kind: 'gotcha', text: 'longer windows re-deliver' },
      ],
    };

    it('passes on the recorded kind with matching text', () => {
      const v = checkWhyRoundtrip(out, 'decided', ['48 hours']);
      expect(v.pass).toBe(true);
      expect(v.detail).toContain('48 hours');
    });

    it('fails on found:0', () => {
      const v = checkWhyRoundtrip({ found: 0, memory: [] }, 'decided', ['48 hours']);
      expect(v.pass).toBe(false);
      expect(v.detail).toContain('found:0');
    });

    it('fails when the text lands under the wrong kind', () => {
      const v = checkWhyRoundtrip(out, 'invariant', ['48 hours']);
      expect(v.pass).toBe(false);
      expect(v.detail).toContain('no invariant entry');
    });
  });

  describe('supersession verdict', () => {
    const OLD = ['in-process'];
    const NEW = ['managed queue relay'];
    const nowGood: WhyLike = {
      found: 1,
      memory: [{ kind: 'decided', text: 'Route retries through the managed queue relay.' }],
    };
    const asOfGood: WhyLike = {
      found: 1,
      memory: [{ kind: 'decided', text: 'Route retries through the in-process queue.' }],
    };

    it('passes when now serves ONE new decision and asOf recalls the old one', () => {
      const v = checkSupersession(nowGood, asOfGood, 'decided', OLD, NEW);
      expect(v.pass).toBe(true);
      expect(v.detail).toContain('supersession holds');
    });

    it('fails when TWO decisions are active now (single_active broken)', () => {
      const twoActive: WhyLike = {
        found: 2,
        memory: [
          { kind: 'decided', text: 'Route retries through the in-process queue.' },
          { kind: 'decided', text: 'Route retries through the managed queue relay.' },
        ],
      };
      const v = checkSupersession(twoActive, asOfGood, 'decided', OLD, NEW);
      expect(v.pass).toBe(false);
      expect(v.detail).toContain('got 2');
    });

    it('fails when the active decision is still the old one', () => {
      const v = checkSupersession(asOfGood, asOfGood, 'decided', OLD, NEW);
      expect(v.pass).toBe(false);
      expect(v.detail).toContain('not the new decision');
    });

    it('fails when the superseded decision is unrecoverable at asOf', () => {
      const v = checkSupersession(nowGood, { found: 0, memory: [] }, 'decided', OLD, NEW);
      expect(v.pass).toBe(false);
      expect(v.detail).toContain('unrecoverable at asOf');
    });

    it('fails when asOf leaks the future decision', () => {
      const leaky: WhyLike = {
        found: 2,
        memory: [
          { kind: 'decided', text: 'Route retries through the in-process queue.' },
          { kind: 'decided', text: 'Route retries through the managed queue relay.' },
        ],
      };
      const v = checkSupersession(nowGood, leaky, 'decided', OLD, NEW);
      expect(v.pass).toBe(false);
      expect(v.detail).toContain('FUTURE');
    });
  });
});

describe('code-memory corpus integrity', () => {
  it('derives current predicate ids from the real builtin manifest', () => {
    expect(CM.decided).toBe('code_memory__decided');
    expect(CM.because).toBe('code_memory__because');
    expect(CM.invariant).toBe('code_memory__invariant');
    expect(CM.gotcha).toBe('code_memory__gotcha');
    expect(() => currentPredicate('surely_not_a_predicate')).toThrow(/not in code_memory/);
  });

  it('HONESTY POLICY: every check on a predicate the manifest does not declare is gap-gated', () => {
    // The battery must never hardcode green ahead of the pack 0.4.0
    // ontology increment: a pack-vocab check whose predicate is not in
    // the LIVE manifest must carry expectedUnknown. Version-agnostic:
    // when 0.4.0 lands, the ids join the manifest and this invariant
    // holds vacuously for them.
    const declared = new Set(
      CODE_MEMORY_PACK.predicates.map((p) => `${CODE_MEMORY_PACK.id}__${p.localId}`),
    );
    for (const check of CHECKS) {
      if (check.kind !== 'pack-vocab') continue;
      if (!declared.has(check.predicate)) {
        expect(check.expectedUnknown).toBeDefined();
        expect(check.expectedUnknown).toContain('0.4.0');
      }
    }
  });

  it('gap040 self-softens once the manifest declares the predicate', () => {
    // For an id the manifest declares TODAY the annotation is already
    // the never-measured baseline; for one it never will declare, the
    // annotation says the check cannot pass yet. This is what flips
    // the 0.4.0-gated checks to plain findings without an edit here.
    expect(packHasPredicate('decided')).toBe(true);
    expect(gap040('decided', 'x')).toMatch(/^Outcome never measured/);
    expect(gap040('surely_not_a_predicate', 'x')).toContain('does not declare');
    expect(CM_040.defaultValue).toBe('code_memory__default_value');
    expect(CM_040.owns).toBe('code_memory__owns');
  });

  it('gap-gates exactly the checks that depend on unlanded work', () => {
    const gated = CHECKS.filter((c) => c.expectedUnknown !== undefined).map((c) => c.id);
    expect(gated).toEqual([
      'k02-vocab-decided',
      'k03-vocab-invariant',
      'k04-vocab-gotcha',
      'k05-vocab-default-value',
      'k06-vocab-depends-on-version',
      'k08-flag-transition',
      'k12-serve-current-default',
      'k13-serve-owner',
    ]);
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

  it('never restates the OLD flag value in the NEW transition turn', () => {
    for (const check of CHECKS) {
      if (check.kind !== 'flag-transition') continue;
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

  it('keeps the numeric literal markers unique to one turn each', () => {
    for (const marker of ['9187', '120']) {
      const carriers = ALL_TURNS.filter((t) => t.text.includes(marker));
      expect(carriers).toHaveLength(1);
    }
  });

  it('every ACME_STRICT_MODE turn is a voiced plan, never a completed transition', () => {
    const turns = ALL_TURNS.filter((t) => t.text.includes('ACME_STRICT_MODE'));
    expect(turns.length).toBeGreaterThan(0);
    for (const turn of turns) {
      expect(/should probably|have not/.test(turn.text)).toBe(true);
    }
  });

  it('uses unique check ids', () => {
    const ids = CHECKS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
