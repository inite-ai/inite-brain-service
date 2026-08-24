import { detectEvidenceConflicts } from '../src/synthesize/answer-router';
import { ALL_LANES, resolveRetrievalProfile } from '../src/search/retrieval-profile';
import type { SearchHit } from '../src/search/search.service';

/**
 * Multilingual Tier 4 — typed conflict detection (MULTILINGUAL_CONFLICT).
 * With typedCompare OFF (default) the detector is byte-identical surface-string
 * equality; ON it compares normalized TYPED values so cross-lingual numeric /
 * boolean disagreements are caught and cosmetic differences (digit script,
 * case, number locale) don't false-flag. It never adjudicates — it only decides
 * which slots to surface. LLM/NLI string-equivalence ("tea" ≡ "чай") is deferred.
 */
const LANES = new Set(ALL_LANES);

const hitWith = (facts: Array<Record<string, unknown>>): SearchHit =>
  ({
    entityId: 'e1',
    entityType: 'person',
    canonicalName: 'n',
    externalRefs: {},
    score: 1,
    facts: facts.map((f, i) => ({
      factId: `knowledge_fact:f${i}`,
      confidence: 0.7,
      score: 1,
      status: 'active',
      ...f,
    })),
  }) as unknown as SearchHit;

const labels = (c: Array<{ label: string }>) => c.map((x) => x.label);

describe('detectEvidenceConflicts — typedCompare OFF (byte-identical)', () => {
  it('a numeric disagreement without COMPETING/polarity is NOT flagged (legacy)', () => {
    const hit = hitWith([
      { predicate: 'weight', object: 'weighs 70 kg' },
      { predicate: 'weight', object: 'весит 75 kg' },
    ]);
    expect(detectEvidenceConflicts([hit], LANES)).toEqual([]);
    // explicit false is identical to the default (no drift).
    expect(detectEvidenceConflicts([hit], LANES, false)).toEqual([]);
  });
  it('still flags COMPETING and polarity splits exactly as before', () => {
    const competing = hitWith([
      { predicate: 'has_key', object: 'yes', status: 'active' },
      { predicate: 'has_key', object: 'no', status: 'COMPETING' },
    ]);
    expect(detectEvidenceConflicts([competing], LANES)).toHaveLength(1);
  });
});

describe('detectEvidenceConflicts — typedCompare ON', () => {
  it('catches a cross-lingual NUMERIC conflict on a typed slot (same unit)', () => {
    const hit = hitWith([
      { predicate: 'weight', object: 'weighs 70 kg' },
      { predicate: 'weight', object: 'весит 75 kg' },
    ]);
    const c = detectEvidenceConflicts([hit], LANES, true);
    expect(c).toHaveLength(1);
    expect(labels(c)).toEqual(['weight']);
  });
  it('catches a BOOLEAN conflict across languages (yes vs нет)', () => {
    const hit = hitWith([
      { predicate: 'vaccinated', object: 'Yes' },
      { predicate: 'vaccinated', object: 'нет' },
    ]);
    expect(detectEvidenceConflicts([hit], LANES, true)).toHaveLength(1);
  });
  it('does NOT flag equal values that differ only in DIGIT SCRIPT (no false positive)', () => {
    // Arabic-Indic ٧٠ == 70; even with a COMPETING marker they normalize to one
    // typed value, so the slot is not a conflict.
    const hit = hitWith([
      { predicate: 'weight', object: '٧٠ kg', status: 'COMPETING' },
      { predicate: 'weight', object: '70 kg', status: 'active' },
    ]);
    expect(detectEvidenceConflicts([hit], LANES, true)).toEqual([]);
  });
  it('parses locale number formats (de 1.000,50 == en 1000.5) → not a conflict', () => {
    const same = hitWith([
      { predicate: 'salary', object: '1.000,50' },
      { predicate: 'salary', object: '1000.5' },
    ]);
    expect(detectEvidenceConflicts([same], LANES, true)).toEqual([]);
    const diff = hitWith([
      { predicate: 'salary', object: '1.000,50' },
      { predicate: 'salary', object: '1.500,50' },
    ]);
    expect(detectEvidenceConflicts([diff], LANES, true)).toHaveLength(1);
  });
  it('does NOT over-flag free-text strings (cross-lingual equivalence deferred to NLI)', () => {
    // "tea"/"чай" are the same drink, but we cannot know that without a model;
    // typed comparison must not invent a numeric/boolean conflict from strings.
    const hit = hitWith([
      { predicate: 'favorite_drink', object: 'tea' },
      { predicate: 'favorite_drink', object: 'чай' },
    ]);
    expect(detectEvidenceConflicts([hit], LANES, true)).toEqual([]);
  });
  it('still surfaces a genuine COMPETING string conflict when typedCompare is on', () => {
    const hit = hitWith([
      { predicate: 'favorite_drink', object: 'tea', status: 'active' },
      { predicate: 'favorite_drink', object: 'coffee', status: 'COMPETING' },
    ]);
    expect(detectEvidenceConflicts([hit], LANES, true)).toHaveLength(1);
  });
  it('does not fire when a different unit could mean an equivalent value (conservative)', () => {
    // 70 kg vs 154 lb — no unit conversion (deferred); different unit tokens
    // are left alone rather than risk a false positive.
    const hit = hitWith([
      { predicate: 'weight', object: '70 kg' },
      { predicate: 'weight', object: '154 lb' },
    ]);
    expect(detectEvidenceConflicts([hit], LANES, true)).toEqual([]);
  });
  it('respects the lane gate even with typedCompare on', () => {
    const hit = hitWith([
      { predicate: 'weight', object: '70 kg' },
      { predicate: 'weight', object: '75 kg' },
    ]);
    expect(detectEvidenceConflicts([hit], new Set(), true)).toEqual([]);
  });
});

describe('MULTILINGUAL_CONFLICT → RetrievalProfile.multilingualConflict', () => {
  it('defaults off and round-trips through the profile resolver', () => {
    expect(resolveRetrievalProfile({} as NodeJS.ProcessEnv).multilingualConflict).toBe(false);
    expect(
      resolveRetrievalProfile({ MULTILINGUAL_CONFLICT: '1' } as NodeJS.ProcessEnv)
        .multilingualConflict,
    ).toBe(true);
    expect(
      resolveRetrievalProfile({ MULTILINGUAL_CONFLICT: '0' } as NodeJS.ProcessEnv)
        .multilingualConflict,
    ).toBe(false);
  });
});
