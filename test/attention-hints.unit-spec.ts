import {
  clampAttentionBoost,
  resolveAttentionHintBoost,
  type AttentionHintSource,
} from '../src/synthesize/attention-hints';

/**
 * FOVEA_ATTENTION_HINTS — the pure hint resolver. The load-bearing
 * properties: literal case-folded cue matching (never a regex), boosts
 * clamped to [1,2] keyed by the pack-namespaced predicate id, and the
 * garbage-in → null contract (null = the caller passes no boost = the
 * structural no-op).
 */

function src(hints: unknown[], packId = 'billing'): AttentionHintSource {
  return { packId, hints };
}

describe('resolveAttentionHintBoost — cue matching', () => {
  it('maps a matched cue to 1+weight under the pack-namespaced predicate id', () => {
    const boost = resolveAttentionHintBoost('what is the invoice state?', [
      src([{ cue: 'invoice', prefer: ['state'], weight: 0.25 }]),
    ]);
    expect(boost).not.toBeNull();
    expect([...boost!.entries()]).toEqual([['billing__state', 1.25]]);
  });

  it('matches case-folded (cue and query fold together)', () => {
    const boost = resolveAttentionHintBoost('INVOICE overdue?', [
      src([{ cue: 'Invoice', prefer: ['state'] }]),
    ]);
    expect(boost?.get('billing__state')).toBe(1.5);
  });

  it('matches across NFC composed/decomposed forms', () => {
    // Query uses e + combining acute; the cue uses the precomposed é.
    const boost = resolveAttentionHintBoost('resume café order', [
      src([{ cue: 'café', prefer: ['state'] }]),
    ]);
    expect(boost?.get('billing__state')).toBe(1.5);
  });

  it('is a literal substring test, never a regex', () => {
    expect(
      resolveAttentionHintBoost('anything at all', [src([{ cue: '.*', prefer: ['state'] }])]),
    ).toBeNull();
    // …but the same characters DO match literally.
    expect(
      resolveAttentionHintBoost('glob .* pattern', [src([{ cue: '.*', prefer: ['state'] }])]),
    ).not.toBeNull();
  });

  it('returns null when no cue occurs in the query', () => {
    expect(
      resolveAttentionHintBoost('completely unrelated', [
        src([{ cue: 'invoice', prefer: ['state'] }]),
      ]),
    ).toBeNull();
  });

  it('returns null on a blank query', () => {
    expect(
      resolveAttentionHintBoost('   ', [src([{ cue: 'invoice', prefer: ['state'] }])]),
    ).toBeNull();
  });
});

describe('resolveAttentionHintBoost — weight and clamp', () => {
  it('defaults an absent weight to 0.5 (boost 1.5)', () => {
    const boost = resolveAttentionHintBoost('invoice?', [src([{ cue: 'invoice', prefer: ['s'] }])]);
    expect(boost?.get('billing__s')).toBe(1.5);
  });

  it('weight 1 yields the max boost 2', () => {
    const boost = resolveAttentionHintBoost('invoice?', [
      src([{ cue: 'invoice', prefer: ['s'], weight: 1 }]),
    ]);
    expect(boost?.get('billing__s')).toBe(2);
  });

  it('out-of-range or non-numeric weights fall back to the 0.5 default', () => {
    for (const weight of [5, 0, -1, Number.NaN, 'big', null]) {
      const boost = resolveAttentionHintBoost('invoice?', [
        src([{ cue: 'invoice', prefer: ['s'], weight }]),
      ]);
      expect(boost?.get('billing__s')).toBe(1.5);
    }
  });

  it('the strongest boost wins when several matched hints prefer one predicate', () => {
    const boost = resolveAttentionHintBoost('invoice due date', [
      src([
        { cue: 'invoice', prefer: ['s'], weight: 0.2 },
        { cue: 'due', prefer: ['s'], weight: 0.9 },
      ]),
    ]);
    // max, not product: 1.9, not 1.2 × 1.9.
    expect(boost?.get('billing__s')).toBe(1.9);
  });

  it('clampAttentionBoost pins [1,2] and collapses non-finite to 1', () => {
    expect(clampAttentionBoost(1.4)).toBe(1.4);
    expect(clampAttentionBoost(0.5)).toBe(1);
    expect(clampAttentionBoost(7)).toBe(2);
    expect(clampAttentionBoost(Number.NaN)).toBe(1);
    expect(clampAttentionBoost(Number.POSITIVE_INFINITY)).toBe(1);
  });
});

describe('resolveAttentionHintBoost — garbage in, null out', () => {
  it('skips hints with a non-string / out-of-bounds cue', () => {
    expect(
      resolveAttentionHintBoost('invoice x', [
        src([
          { cue: 42, prefer: ['s'] },
          { cue: 'x', prefer: ['s'] }, // 1 char < min 2
          { cue: 'i'.repeat(65), prefer: ['s'] }, // > max 64
          { prefer: ['s'] },
          null,
          'not-an-object',
        ]),
      ]),
    ).toBeNull();
  });

  it('skips hints without a usable prefer list (zoom-only hints boost nothing)', () => {
    expect(
      resolveAttentionHintBoost('invoice x', [
        src([
          { cue: 'invoice' },
          { cue: 'invoice', prefer: [] },
          { cue: 'invoice', prefer: 'state' },
          { cue: 'invoice', prefer: ['s'], zoom: ['facts'] },
        ]),
      ])?.size,
    ).toBe(1); // only the last hint is usable
  });

  it('skips non-string prefer entries but keeps the valid ones', () => {
    const boost = resolveAttentionHintBoost('invoice x', [
      src([{ cue: 'invoice', prefer: [42, '', 'ok'] }]),
    ]);
    expect([...boost!.keys()]).toEqual(['billing__ok']);
  });

  it('skips sources with a garbage packId or hints shape', () => {
    expect(
      resolveAttentionHintBoost('invoice x', [
        { packId: '', hints: [{ cue: 'invoice', prefer: ['s'] }] },
        { packId: 'p', hints: 'nope' as unknown as unknown[] },
      ]),
    ).toBeNull();
  });

  it('caps hints at the manifest bound (16) and prefer at 8', () => {
    // Hint #17 is the only matching one — the defensive cap drops it.
    const filler = Array.from({ length: 16 }, (_, i) => ({
      cue: `zz${i}`,
      prefer: ['s'],
    }));
    expect(
      resolveAttentionHintBoost('invoice x', [src([...filler, { cue: 'invoice', prefer: ['s'] }])]),
    ).toBeNull();
    // Prefer entry #9 is dropped by the 8-cap.
    const boost = resolveAttentionHintBoost('invoice x', [
      src([{ cue: 'invoice', prefer: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'ninth'] }]),
    ]);
    expect(boost?.size).toBe(8);
    expect(boost?.has('billing__ninth')).toBe(false);
  });
});
