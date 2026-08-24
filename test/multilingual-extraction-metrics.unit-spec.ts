import { extractionF1, meanExtractionF1 } from './eval/metrics/multilingual-extraction-f1';
import { entityLinkingAccuracy, fragmentationRate } from './eval/metrics/entity-linking';

describe('extractionF1', () => {
  it('perfect set match → 1.0', () => {
    const s = extractionF1(['status=cfo', 'name=Li'], ['name=Li', 'status=cfo']);
    expect(s.precision).toBe(1);
    expect(s.recall).toBe(1);
    expect(s.f1).toBe(1);
  });

  it('half overlap → precision/recall/f1 all 2/3', () => {
    const s = extractionF1(['a=1', 'b=2', 'c=3'], ['a=1', 'b=2', 'd=4']);
    expect(s.precision).toBeCloseTo(2 / 3, 6);
    expect(s.recall).toBeCloseTo(2 / 3, 6);
    expect(s.f1).toBeCloseTo(2 / 3, 6);
    expect(s.truePositives).toBe(2);
    expect(s.falsePositives).toBe(1);
    expect(s.falseNegatives).toBe(1);
  });

  it('both empty → vacuous perfect', () => {
    const s = extractionF1([], []);
    expect(s.f1).toBe(1);
  });

  it('predicted empty, gold non-empty → 0', () => {
    const s = extractionF1([], ['a=1']);
    expect(s.precision).toBe(0);
    expect(s.recall).toBe(0);
    expect(s.f1).toBe(0);
  });

  it('gold empty, predicted noise → P=0, R=1, F1=0', () => {
    const s = extractionF1(['noise=1'], []);
    expect(s.precision).toBe(0);
    expect(s.recall).toBe(1);
    expect(s.f1).toBe(0);
  });

  it('duplicate predictions are deduped (set semantics)', () => {
    const s = extractionF1(['a=1', 'a=1', 'b=2'], ['a=1']);
    expect(s.precision).toBe(0.5); // {a,b} vs {a}
    expect(s.recall).toBe(1);
  });
});

describe('meanExtractionF1', () => {
  it('null on empty', () => {
    expect(meanExtractionF1([])).toBeNull();
  });

  it('macro averages per-case F1; micro pools TP/FP/FN', () => {
    const perfect = extractionF1(['a=1'], ['a=1']);
    const zero = extractionF1(['x=9'], ['a=1']);
    const agg = meanExtractionF1([perfect, zero])!;
    expect(agg.count).toBe(2);
    expect(agg.macroF1).toBe(0.5); // (1 + 0) / 2
    // micro: tp=1, fp=1, fn=1 → P=R=0.5 → microF1=0.5
    expect(agg.microF1).toBeCloseTo(0.5, 6);
  });
});

describe('entityLinkingAccuracy', () => {
  it('all surfaces linked to gold → 1.0', () => {
    expect(entityLinkingAccuracy(['e1', 'e1', 'e1'], ['e1', 'e1', 'e1'])).toBe(1);
  });

  it('half linked correctly → 0.5', () => {
    expect(entityLinkingAccuracy(['e1', 'wrong'], ['e1', 'e1'])).toBe(0.5);
  });

  it('null (unlinked) prediction counts as a miss', () => {
    expect(entityLinkingAccuracy([null, 'e1'], ['e1', 'e1'])).toBe(0.5);
  });

  it('empty → null', () => {
    expect(entityLinkingAccuracy([], [])).toBeNull();
  });
});

describe('fragmentationRate', () => {
  it('one node per gold entity → rate 0, duplicatesPerEntity 1', () => {
    const r = fragmentationRate([
      { goldEntity: 'e1', nodeId: 'n0' },
      { goldEntity: 'e1', nodeId: 'n0' },
    ]);
    expect(r.fragmentationRate).toBe(0);
    expect(r.duplicatesPerEntity).toBe(1);
    expect(r.fragmentedEntities).toBe(0);
    expect(r.goldEntities).toBe(1);
    expect(r.predictedNodes).toBe(1);
  });

  it('fully fragmented entity → surplus nodes counted', () => {
    // e1: nodes {n0} (1); e2: nodes {n1,n2} (2). predictedNodes=3, gold=2.
    const r = fragmentationRate([
      { goldEntity: 'e1', nodeId: 'n0' },
      { goldEntity: 'e2', nodeId: 'n1' },
      { goldEntity: 'e2', nodeId: 'n2' },
    ]);
    expect(r.predictedNodes).toBe(3);
    expect(r.goldEntities).toBe(2);
    expect(r.fragmentationRate).toBeCloseTo(1 / 3, 6);
    expect(r.duplicatesPerEntity).toBeCloseTo(1.5, 6);
    expect(r.fragmentedEntities).toBe(1);
  });

  it('empty → nulls', () => {
    const r = fragmentationRate([]);
    expect(r.fragmentationRate).toBeNull();
    expect(r.duplicatesPerEntity).toBeNull();
    expect(r.goldEntities).toBe(0);
  });
});
