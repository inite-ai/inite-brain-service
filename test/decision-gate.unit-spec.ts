/**
 * Code-memory track C — train + serve the Layer-1 decision gate. Fully offline:
 * synthetic separable data, deterministic training, and the serving classifier
 * behind the same DecisionClassifier seam as the heuristic.
 */
import { trainGate } from '../src/code-memory/capture/gate-train';
import {
  TrainedDecisionClassifier,
  evaluateGate,
  predictProba,
  type GateModel,
} from '../src/code-memory/capture/gate-classifier';
import { featurize } from '../src/code-memory/capture/gate-features';
import { parseCommitSignals } from '../src/code-memory/capture/commit-signals';
import type { CommitInput } from '../src/code-memory/capture/types';

function commit(message: string): CommitInput {
  return {
    sha: message.slice(0, 6),
    message,
    changedFiles: ['src/x.ts'],
    authorDate: '2026-07-07T00:00:00Z',
  };
}

// Decision-bearing (rationale/decision/invariant/gotcha prose) vs noise.
const POSITIVE = [
  'refactor: split module because the 21 args drifted between call-sites',
  'feat: gateway so that facts resolve through one path and stay consistent',
  'fix: guard the loop to avoid a race that otherwise corrupts state',
  'perf: cache the snapshot instead of recomputing to prevent cold-start tax',
  'refactor: decided to invert control so tenants cannot leak across dbs',
  'fix: invariant — always export from the global module otherwise DI fails',
  'feat: chose ed25519 because it needs no dependency and proves authorship',
  'refactor: gotcha — pnpm test double-dash does not work, use testPathPattern',
];
const NEGATIVE = [
  'chore: bump deps',
  'style: run prettier',
  'docs: fix typo in readme',
  'ci: update workflow file',
  'build: bump version to 1.2.3',
  'test: add missing semicolon',
  'chore: update lockfile',
  'style: reformat imports',
];

function dataset(): Array<{
  text: string;
  signals: ReturnType<typeof parseCommitSignals>;
  label: 0 | 1;
}> {
  const rows: Array<{ text: string; signals: any; label: 0 | 1 }> = [];
  for (const m of POSITIVE) {
    const c = commit(m);
    rows.push({ text: m, signals: parseCommitSignals(c), label: 1 });
  }
  for (const m of NEGATIVE) {
    const c = commit(m);
    rows.push({ text: m, signals: parseCommitSignals(c), label: 0 });
  }
  return rows;
}

describe('trainGate + evaluateGate', () => {
  it('fits the separable training set', () => {
    const rows = dataset();
    const model = trainGate(rows, { epochs: 40, seed: 1 });
    const feats = rows.map((r) => ({
      feats: featurize(r.text, r.signals, model.config),
      label: r.label,
    }));
    const m = evaluateGate(model, feats);
    expect(m.accuracy).toBeGreaterThanOrEqual(0.9);
    expect(m.f1).toBeGreaterThanOrEqual(0.9);
  });

  it('is reproducible for a fixed seed', () => {
    const rows = dataset();
    const a = trainGate(rows, { epochs: 20, seed: 7 });
    const b = trainGate(rows, { epochs: 20, seed: 7 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('prunes near-zero weights from the artifact', () => {
    const rows = dataset();
    const model = trainGate(rows, { epochs: 20, seed: 1, pruneBelow: 1e-4 });
    for (const w of Object.values(model.weights)) {
      expect(Math.abs(w)).toBeGreaterThanOrEqual(1e-4);
    }
  });
});

describe('TrainedDecisionClassifier', () => {
  it('admits a decision-bearing commit and rejects noise', () => {
    const model = trainGate(dataset(), { epochs: 40, seed: 1 });
    const gate = new TrainedDecisionClassifier(model);
    const pos = gate.classify(
      commit('refactor: split it because the args drifted between call-sites'),
    );
    const neg = gate.classify(commit('chore: bump deps'));
    expect(pos.likelyDecision).toBe(true);
    expect(neg.likelyDecision).toBe(false);
    expect(pos.reason).toMatch(/trained gate p=/);
    expect(pos.signals).toBeDefined();
  });

  it('round-trips through JSON (fromJson gives identical predictions)', () => {
    const model = trainGate(dataset(), { epochs: 20, seed: 3 });
    const restored = TrainedDecisionClassifier.fromJson(
      JSON.parse(JSON.stringify(model)),
    );
    const c = commit('feat: gateway so that facts resolve through one path');
    const before = predictProba(model, featurize(c.message, parseCommitSignals(c), model.config));
    const after = restored.classify(c);
    expect(after.likelyDecision).toBe(before >= model.threshold);
  });

  it('rejects an invalid model JSON', () => {
    expect(() => TrainedDecisionClassifier.fromJson({ version: 2 })).toThrow(
      /invalid gate model/,
    );
    expect(() =>
      TrainedDecisionClassifier.fromJson({ version: 1, bias: 0 } as Partial<GateModel>),
    ).toThrow(/invalid gate model/);
  });
});
