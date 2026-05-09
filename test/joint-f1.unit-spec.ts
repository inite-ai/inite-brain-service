import { jointF1, meanJointF1 } from './eval/metrics/joint-f1';

describe('jointF1', () => {
  it('perfect match → all metrics 1.0', () => {
    const s = jointF1(
      {
        answerEntityRefs: ['acme.alice', 'acme.bob'],
        supportingFactIds: ['f1', 'f2', 'f3'],
      },
      {
        answerEntityRefs: ['acme.alice', 'acme.bob'],
        supportingFactIds: ['f1', 'f2', 'f3'],
      },
    );
    expect(s.answerEM).toBe(1);
    expect(s.answerF1).toBe(1);
    expect(s.supportEM).toBe(1);
    expect(s.supportF1).toBe(1);
    expect(s.jointEM).toBe(1);
    expect(s.jointF1).toBe(1);
  });

  it('right answer, wrong evidence chain → joint F1 collapses', () => {
    // Answer matches perfectly; supporting facts are completely
    // disjoint. This is the failure mode HotpotQA's Joint F1 was
    // designed to catch.
    const s = jointF1(
      {
        answerEntityRefs: ['acme.alice'],
        supportingFactIds: ['wrong_f1', 'wrong_f2'],
      },
      {
        answerEntityRefs: ['acme.alice'],
        supportingFactIds: ['gold_f1', 'gold_f2'],
      },
    );
    expect(s.answerEM).toBe(1);
    expect(s.answerF1).toBe(1);
    expect(s.supportF1).toBe(0);
    expect(s.jointEM).toBe(0);
    expect(s.jointF1).toBe(0);
  });

  it('half-correct support drags joint F1 below 0.5', () => {
    // Answer perfect (F1=1); support has 2 of 4 gold facts AND 1
    // false positive: P=2/3, R=2/4=0.5, F1 ≈ 0.571.
    // jointP = 1 × 2/3 = 0.667
    // jointR = 1 × 0.5 = 0.5
    // jointF1 = 2*0.667*0.5 / (0.667+0.5) ≈ 0.571 (same as supportF1
    // when answer is perfect)
    const s = jointF1(
      {
        answerEntityRefs: ['acme.alice'],
        supportingFactIds: ['f1', 'f2', 'f5'],
      },
      {
        answerEntityRefs: ['acme.alice'],
        supportingFactIds: ['f1', 'f2', 'f3', 'f4'],
      },
    );
    expect(s.answerF1).toBe(1);
    expect(s.supportPrecision).toBeCloseTo(2 / 3, 6);
    expect(s.supportRecall).toBeCloseTo(0.5, 6);
    expect(s.supportF1).toBeCloseTo((2 * (2 / 3) * 0.5) / (2 / 3 + 0.5), 6);
    expect(s.jointF1).toBeCloseTo(s.supportF1, 6);
    expect(s.jointEM).toBe(0);
  });

  it('partial answer + perfect support → joint F1 weighted by both', () => {
    // Answer: 1 of 2 gold (F1=2*0.5*1.0/1.5? wait — P=1/1=1, R=1/2=0.5, F1=2/3)
    // hmm, predicted has 1 element (alice), expected has 2 (alice, bob).
    //   P = 1/1 = 1, R = 1/2 = 0.5, F1 = 2*1*0.5/(1+0.5) = 2/3.
    // Support: perfect 1.0.
    // jointP = 1 × 1 = 1, jointR = 0.5 × 1 = 0.5, jointF1 = 2/3.
    const s = jointF1(
      {
        answerEntityRefs: ['acme.alice'],
        supportingFactIds: ['f1', 'f2'],
      },
      {
        answerEntityRefs: ['acme.alice', 'acme.bob'],
        supportingFactIds: ['f1', 'f2'],
      },
    );
    expect(s.answerPrecision).toBe(1);
    expect(s.answerRecall).toBe(0.5);
    expect(s.answerF1).toBeCloseTo(2 / 3, 6);
    expect(s.supportF1).toBe(1);
    expect(s.jointF1).toBeCloseTo(2 / 3, 6);
  });

  it('total miss on both → all zero', () => {
    const s = jointF1(
      {
        answerEntityRefs: ['acme.wrong'],
        supportingFactIds: ['fwrong'],
      },
      {
        answerEntityRefs: ['acme.right'],
        supportingFactIds: ['fright'],
      },
    );
    expect(s.answerF1).toBe(0);
    expect(s.supportF1).toBe(0);
    expect(s.jointF1).toBe(0);
    expect(s.jointEM).toBe(0);
  });

  it('empty predictions when expected non-empty → zeros', () => {
    const s = jointF1(
      { answerEntityRefs: [], supportingFactIds: [] },
      {
        answerEntityRefs: ['acme.alice'],
        supportingFactIds: ['f1'],
      },
    );
    expect(s.answerF1).toBe(0);
    expect(s.supportF1).toBe(0);
    expect(s.jointF1).toBe(0);
  });

  it('both empty → vacuous perfect', () => {
    const s = jointF1(
      { answerEntityRefs: [], supportingFactIds: [] },
      { answerEntityRefs: [], supportingFactIds: [] },
    );
    expect(s.answerEM).toBe(1);
    expect(s.supportEM).toBe(1);
    expect(s.jointF1).toBe(1);
    expect(s.jointEM).toBe(1);
  });

  it('predicted non-empty but expected empty → P=0 → joint F1 = 0', () => {
    const s = jointF1(
      {
        answerEntityRefs: ['acme.noisy'],
        supportingFactIds: ['fnoisy'],
      },
      { answerEntityRefs: [], supportingFactIds: [] },
    );
    expect(s.answerPrecision).toBe(0);
    expect(s.answerRecall).toBe(1);
    expect(s.answerF1).toBe(0);
    expect(s.jointF1).toBe(0);
  });

  it('duplicates in predicted are deduped (set semantics)', () => {
    // predicted has alice twice + a hallucinated bob; expected just alice.
    // Set: {alice, bob}. P = 1/2 = 0.5, R = 1/1 = 1, F1 = 2/3.
    const s = jointF1(
      {
        answerEntityRefs: ['acme.alice', 'acme.alice', 'acme.bob'],
        supportingFactIds: [],
      },
      {
        answerEntityRefs: ['acme.alice'],
        supportingFactIds: [],
      },
    );
    expect(s.answerPrecision).toBe(0.5);
    expect(s.answerRecall).toBe(1);
    expect(s.answerF1).toBeCloseTo(2 / 3, 6);
  });
});

describe('meanJointF1', () => {
  it('returns null on empty input', () => {
    expect(meanJointF1([])).toBeNull();
  });

  it('averages perfect + zero → 0.5 across all metrics', () => {
    const perfect = jointF1(
      {
        answerEntityRefs: ['acme.a'],
        supportingFactIds: ['f1'],
      },
      {
        answerEntityRefs: ['acme.a'],
        supportingFactIds: ['f1'],
      },
    );
    const zero = jointF1(
      {
        answerEntityRefs: ['acme.wrong'],
        supportingFactIds: ['fwrong'],
      },
      {
        answerEntityRefs: ['acme.right'],
        supportingFactIds: ['fright'],
      },
    );
    const agg = meanJointF1([perfect, zero])!;
    expect(agg.count).toBe(2);
    expect(agg.answerF1).toBe(0.5);
    expect(agg.supportF1).toBe(0.5);
    expect(agg.jointF1).toBe(0.5);
    expect(agg.jointEM).toBe(0.5);
  });

  it('aggregate jointF1 reflects the full distribution, not just EM', () => {
    // One query with right answer wrong support (joint F1 = 0)
    // + one with EM perfect (joint F1 = 1) → mean joint F1 = 0.5
    const wrongSupport = jointF1(
      {
        answerEntityRefs: ['acme.a'],
        supportingFactIds: ['fwrong'],
      },
      {
        answerEntityRefs: ['acme.a'],
        supportingFactIds: ['fright'],
      },
    );
    const perfect = jointF1(
      {
        answerEntityRefs: ['acme.b'],
        supportingFactIds: ['f1'],
      },
      {
        answerEntityRefs: ['acme.b'],
        supportingFactIds: ['f1'],
      },
    );
    const agg = meanJointF1([wrongSupport, perfect])!;
    // EM-based metric collapses to 0.5 too here, but jointF1 (continuous)
    // averages 0 and 1 = 0.5 regardless.
    expect(agg.jointEM).toBe(0.5);
    expect(agg.jointF1).toBe(0.5);
    expect(agg.answerEM).toBe(1.0); // both predicted the right answer entity
  });
});
