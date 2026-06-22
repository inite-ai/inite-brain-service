import {
  isGroundedSpan,
  groundEntities,
  normalizeForGrounding,
  applyGroundingGate,
} from '../src/ai/extractor-internals/grounding';
import type { RawExtractedFact } from '../src/ai/extractor-internals/types';

const norm = normalizeForGrounding;

describe('isGroundedSpan word-boundary', () => {
  it('grounds a standalone token', () => {
    expect(isGroundedSpan(norm('the CTO resigned'), norm('CTO'))).toBe(true);
  });

  it('rejects a span buried inside a larger Latin word', () => {
    // "act" must not ground on "active" — the classic sub-word false positive.
    expect(isGroundedSpan(norm('she is active'), norm('act'))).toBe(false);
  });

  it('grounds a multi-word span', () => {
    expect(
      isGroundedSpan(norm('moved to New York City'), norm('New York')),
    ).toBe(true);
  });

  it('keeps plain-substring semantics for unspaced (CJK) scripts', () => {
    // 北京 (Beijing) inside 北京市 (Beijing City) — adjacent chars are letters
    // but CJK has no word spacing, so the boundary rule must not reject it.
    expect(isGroundedSpan('北京市', '北京')).toBe(true);
  });

  it('grounds Cyrillic standalone but rejects sub-word', () => {
    expect(isGroundedSpan(norm('живёт в Москве'), norm('Москве'))).toBe(true);
    expect(isGroundedSpan(norm('живёт в Москве'), norm('оск'))).toBe(false);
  });

  it('empty span is never grounded', () => {
    expect(isGroundedSpan('anything', '')).toBe(false);
  });
});

describe('groundEntities', () => {
  it('masks entities whose name is absent from the source', () => {
    const mask = groundEntities('Maria is the new CTO', [
      { name: 'Maria', type: 'customer' },
      { name: 'Hannibal', type: 'customer' }, // hallucinated
    ]);
    expect(mask).toEqual([true, false]);
  });
});

describe('applyGroundingGate value word-boundary', () => {
  it('drops a fact whose valueSpan is only a sub-word of the input', () => {
    const raw: RawExtractedFact[] = [
      {
        entityIndex: 0,
        clauseIndex: undefined,
        predicate: 'status',
        valueSpan: 'act', // only present inside "active"
        confidence: 0.9,
      },
    ];
    const { facts, dropped } = applyGroundingGate('she is active', raw, []);
    expect(facts).toHaveLength(0);
    expect(dropped[0].reason).toBe('not_grounded');
  });
});
