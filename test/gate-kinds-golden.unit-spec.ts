/**
 * Code-memory track C — the multi-label kinds heads + the frozen golden eval.
 * Deterministic + offline: trains on the hand-labeled golden and checks the
 * gate beats the heuristic on human truth, and that the per-kind heads work.
 */
import { trainGate } from '../src/code-memory/capture/gate-train';
import { TrainedDecisionClassifier } from '../src/code-memory/capture/gate-classifier';
import {
  GATE_GOLDEN,
  evaluateHeuristicOnGolden,
  evaluateModelOnGolden,
  goldenCommit,
  type GoldenCase,
} from '../src/code-memory/capture/gate-golden';
import { parseCommitSignals } from '../src/code-memory/capture/commit-signals';
import { commitText } from '../src/code-memory/capture/silver-dataset';

function trainExamples(cases: GoldenCase[]) {
  return cases.map((c) => {
    const commit = goldenCommit(c);
    return {
      text: commitText(commit),
      signals: parseCommitSignals(commit),
      label: c.label,
      kinds: c.kinds,
    };
  });
}

describe('gate golden set', () => {
  it('is balanced and challenges the heuristic (subject-only "why" it misses)', () => {
    const pos = GATE_GOLDEN.filter((c) => c.label === 1).length;
    const neg = GATE_GOLDEN.length - pos;
    expect(pos).toBeGreaterThanOrEqual(15);
    expect(neg).toBeGreaterThanOrEqual(15);
    const heur = evaluateHeuristicOnGolden();
    // The heuristic can't recall the reason-in-subject positives → recall < 1.
    expect(heur.recall).toBeLessThan(1);
    expect(heur.f1).toBeLessThan(1);
  });
});

describe('trained gate vs heuristic on the golden', () => {
  it('the trained model beats the heuristic on human truth', () => {
    const model = trainGate(trainExamples(GATE_GOLDEN), { epochs: 60, seed: 7 });
    const m = evaluateModelOnGolden(model);
    const h = evaluateHeuristicOnGolden();
    expect(m.accuracy).toBeGreaterThanOrEqual(0.9);
    expect(m.f1).toBeGreaterThan(h.f1);
  });

  it('generalizes on a held-out split (model >= heuristic F1)', () => {
    const train = GATE_GOLDEN.filter((_, i) => i % 2 === 0);
    const test = GATE_GOLDEN.filter((_, i) => i % 2 === 1);
    const model = trainGate(trainExamples(train), { epochs: 60, seed: 7 });
    const m = evaluateModelOnGolden(model, test);
    const h = evaluateHeuristicOnGolden(test);
    expect(m.f1).toBeGreaterThanOrEqual(h.f1);
  });
});

describe('multi-label kinds heads', () => {
  const model = trainGate(trainExamples(GATE_GOLDEN), { epochs: 60, seed: 7 });

  it('trains a v2 model with a head per kind present in the corpus', () => {
    expect(model.version).toBe(2);
    expect(Object.keys(model.kinds ?? {}).sort()).toEqual([
      'because',
      'decided',
      'gotcha',
      'invariant',
    ]);
  });

  it('classifies the kinds of a clear commit', () => {
    const gate = new TrainedDecisionClassifier(model);
    const gotcha = gate.classifyKinds(
      goldenCommit({
        message:
          'test: filter with --testPathPattern= (equals form)\n\nGotcha: the double dash swallows the flag.',
        label: 1,
        kinds: ['gotcha'],
      }),
    );
    expect(gotcha).toContain('gotcha');

    const probas = gate.predictKinds(
      goldenCommit({
        message:
          'fix(di): export the new @Injectable from the @Global module\n\nInvariant: it must be listed in exports or DI boot fails.',
        label: 1,
        kinds: ['invariant'],
      }),
    );
    expect(probas.invariant).toBeGreaterThan(probas.gotcha ?? 0);
  });

  it('a v1 model (no kinds) yields no kind predictions', () => {
    const v1 = trainGate(
      trainExamples(GATE_GOLDEN).map(({ kinds: _kinds, ...rest }) => rest),
      { epochs: 20, seed: 7 },
    );
    expect(v1.version).toBe(1);
    expect(new TrainedDecisionClassifier(v1).classifyKinds(goldenCommit(GATE_GOLDEN[0]!))).toEqual([]);
  });
});
