/**
 * Domain Pack eval fixtures — the pure scorer + manifest validation.
 */
import {
  scoreFixture,
  validatePack,
  type EvalFixture,
  type ScorableExtraction,
} from '../src/ai/domain-packs';

function extraction(
  facts: Array<{ predicate: string; object: string }>,
  entityCount = 1,
): ScorableExtraction {
  return { entities: Array(entityCount).fill({}), facts };
}

describe('scoreFixture', () => {
  const fixture: EvalFixture = {
    id: 'zoning',
    text: 'The parcel at 12 Elm St is zoned R-2.',
    expect: { facts: [{ predicate: 'zoned_as', objectIncludes: 'R-2' }] },
  };

  it('passes when a bare predicate resolves to the pack namespace and matches', () => {
    const r = scoreFixture(
      'real_estate',
      fixture,
      extraction([{ predicate: 'real_estate__zoned_as', object: 'R-2' }]),
    );
    expect(r.passed).toBe(true);
    expect(r.failures).toEqual([]);
  });

  it('fails with a reason when the expected fact is absent', () => {
    const r = scoreFixture(
      'real_estate',
      fixture,
      extraction([{ predicate: 'real_estate__valued_at', object: '$1' }]),
    );
    expect(r.passed).toBe(false);
    expect(r.failures[0]).toMatch(/missing fact real_estate__zoned_as ~ "R-2"/);
  });

  it('respects objectIncludes (case-insensitive substring)', () => {
    const r = scoreFixture(
      'real_estate',
      fixture,
      extraction([{ predicate: 'real_estate__zoned_as', object: 'zoned r-2 residential' }]),
    );
    expect(r.passed).toBe(true);
  });

  it('uses an already-namespaced predicate verbatim (can assert core predicates)', () => {
    const f: EvalFixture = {
      id: 'core',
      text: 'x',
      expect: { facts: [{ predicate: 'name' }] }, // no __ but core — resolves to real_estate__name
    };
    // A bare non-pack predicate composes to the pack namespace, so a core
    // assertion must be written fully-qualified:
    const qualified: EvalFixture = {
      id: 'core2',
      text: 'x',
      expect: { facts: [{ predicate: 'address' }] },
    };
    expect(
      scoreFixture('real_estate', f, extraction([{ predicate: 'name', object: 'Bob' }]))
        .passed,
    ).toBe(false); // resolved to real_estate__name, not core name
    expect(
      scoreFixture(
        'real_estate',
        { ...qualified, expect: { facts: [{ predicate: 'core__address' }] } },
        extraction([{ predicate: 'core__address', object: 'Berlin' }]),
      ).passed,
    ).toBe(true);
  });

  it('enforces minEntities / minFacts thresholds', () => {
    const f: EvalFixture = { id: 't', text: 'x', expect: { minEntities: 2, minFacts: 1 } };
    const r = scoreFixture('p', f, extraction([{ predicate: 'p__a', object: 'v' }], 1));
    expect(r.passed).toBe(false);
    expect(r.failures.some((x) => /entities/.test(x))).toBe(true);
  });
});

describe('validatePack — evalFixtures', () => {
  const base = {
    id: 'demo',
    version: '0.1.0',
    description: 'd',
    predicates: [
      {
        localId: 'thing',
        displayLabel: 'thing',
        description: 'x',
        datatype: 'string' as const,
        semantics: 'append_only' as const,
        decayHalfLifeDays: null,
        piiClass: 'none' as const,
        status: 'active' as const,
      },
    ],
  };
  it('accepts well-formed fixtures', () => {
    expect(() =>
      validatePack({
        ...base,
        evalFixtures: [{ id: 'a', text: 't', expect: { facts: [{ predicate: 'thing' }] } }],
      }),
    ).not.toThrow();
  });
  it('rejects a fixture without an id', () => {
    expect(() =>
      validatePack({ ...base, evalFixtures: [{ text: 't', expect: {} } as never] }),
    ).toThrow(/non-empty string id/);
  });
  it('rejects duplicate fixture ids', () => {
    expect(() =>
      validatePack({
        ...base,
        evalFixtures: [
          { id: 'a', text: 't', expect: {} },
          { id: 'a', text: 't2', expect: {} },
        ],
      }),
    ).toThrow(/duplicate id/);
  });
  it('rejects a fact expectation without a string predicate', () => {
    expect(() =>
      validatePack({
        ...base,
        evalFixtures: [{ id: 'a', text: 't', expect: { facts: [{} as never] } }],
      }),
    ).toThrow(/string predicate/);
  });
});
