/**
 * Code-memory track C — feature extraction for the trained gate. Deterministic,
 * shared by trainer + serving classifier (train/serve features must match).
 */
import {
  featurize,
  featurizeCommit,
  DEFAULT_FEATURE_CONFIG,
} from '../src/code-memory/capture/gate-features';
import { parseCommitSignals } from '../src/code-memory/capture/commit-signals';
import type { CommitInput } from '../src/code-memory/capture/types';

function commit(message: string): CommitInput {
  return {
    sha: 'x',
    message,
    changedFiles: ['src/x.ts'],
    authorDate: '2026-07-07T00:00:00Z',
  };
}

describe('featurize', () => {
  it('is deterministic for the same input', () => {
    const c = commit('feat: x\n\nwe did this because it avoids drift');
    const a = featurizeCommit(c);
    const b = featurizeCommit(c);
    expect([...a.entries()].sort()).toEqual([...b.entries()].sort());
  });

  it('changes when a rationale signal appears (structured features count)', () => {
    const plain = featurizeCommit(commit('refactor: rename the internal handler'));
    const withWhy = featurizeCommit(
      commit('refactor: rename the internal handler because it avoids drift'),
    );
    expect([...plain.entries()].sort()).not.toEqual([...withWhy.entries()].sort());
  });

  it('emits more features with bigrams than unigrams only', () => {
    const text = 'split the module per phase';
    const signals = parseCommitSignals(commit(text));
    const uni = featurize(text, signals, { dim: 1 << 14, ngram: 1 });
    const bi = featurize(text, signals, { dim: 1 << 14, ngram: 2 });
    expect(bi.size).toBeGreaterThan(uni.size);
  });

  it('buckets into the configured power-of-two space', () => {
    const feats = featurize('hello world', parseCommitSignals(commit('hello world')), {
      dim: 1 << 10,
      ngram: 2,
    });
    for (const idx of feats.keys()) {
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(1 << 10);
    }
    expect(DEFAULT_FEATURE_CONFIG.dim).toBe(1 << 15);
  });
});
