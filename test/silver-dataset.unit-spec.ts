/**
 * Code-memory track C — silver dataset builder. Verifies the teacher→label
 * distillation logic and, crucially, the heuristic-vs-teacher confusion counts
 * (the payoff signal: where a trained gate would beat the heuristic).
 */
import { HeuristicDecisionClassifier } from '../src/code-memory/capture/heuristic-classifier';
import {
  buildSilverExample,
  commitText,
  labelCommits,
} from '../src/code-memory/capture/silver-dataset';
import type {
  CommitInput,
  DecisionCandidate,
  DecisionExtractor,
} from '../src/code-memory/capture/types';

function commit(over: Partial<CommitInput> & { sha: string }): CommitInput {
  return {
    message: '',
    changedFiles: ['src/x.ts'],
    authorDate: '2026-07-07T00:00:00Z',
    ...over,
  };
}
function candidate(over: Partial<DecisionCandidate> = {}): DecisionCandidate {
  return {
    kind: 'decided',
    text: 'a decision',
    anchor: 'src/x.ts',
    commit: 'sha',
    validFrom: '2026-07-07T00:00:00Z',
    ...over,
  };
}

describe('commitText', () => {
  it('joins message + PR body (no diff)', () => {
    expect(commitText(commit({ sha: 'a', message: 'msg', prBody: 'body' }))).toBe(
      'msg\n\nbody',
    );
  });
  it('is just the message when there is no PR body', () => {
    expect(commitText(commit({ sha: 'a', message: 'msg' }))).toBe('msg');
  });
});

describe('buildSilverExample', () => {
  const classifier = new HeuristicDecisionClassifier();
  it('labels 1 with deduped kinds when the teacher extracts candidates', () => {
    const ex = buildSilverExample({
      commit: commit({ sha: 'a', message: 'feat: x\n\nbecause it avoids drift' }),
      candidates: [
        candidate({ kind: 'decided' }),
        candidate({ kind: 'because' }),
        candidate({ kind: 'because' }),
      ],
      classifier,
    });
    expect(ex.label).toBe(1);
    expect(ex.candidateCount).toBe(3);
    expect([...ex.kinds].sort()).toEqual(['because', 'decided']);
    expect(ex.heuristic.likelyDecision).toBe(true);
  });
  it('labels 0 when the teacher extracts nothing', () => {
    const ex = buildSilverExample({
      commit: commit({ sha: 'b', message: 'chore: bump deps' }),
      candidates: [],
      classifier,
    });
    expect(ex.label).toBe(0);
    expect(ex.kinds).toEqual([]);
    expect(ex.heuristic.likelyDecision).toBe(false); // heuristic also rejects
  });
});

describe('labelCommits', () => {
  it('skips merges, counts failures, and scores heuristic vs teacher', async () => {
    const commits: CommitInput[] = [
      // agree: heuristic admits (rationale marker) + teacher positive
      commit({ sha: 'a1', message: 'feat: x\n\nWe did this because it avoids drift.' }),
      // false-neg: heuristic rejects (chore, no body) but teacher positive
      commit({ sha: 'b2', message: 'chore: bump deps' }),
      // false-pos: heuristic admits (refactor + long body) but teacher empty
      commit({
        sha: 'c3',
        message:
          'refactor: layout\n\nThis restructures the module layout and renames the internal handlers across the whole package.',
      }),
      // merge: skipped, not labeled
      commit({ sha: 'd4', message: "Merge branch 'topic' into main" }),
      // failure: teacher throws
      commit({ sha: 'e5', message: 'feat: y\n\nbecause reasons enough to admit here' }),
    ];
    const scripted: Record<string, DecisionCandidate[]> = {
      a1: [candidate({ kind: 'decided' })],
      b2: [candidate({ kind: 'because' })],
      c3: [],
    };
    const extractor: DecisionExtractor = {
      extract: async (c) => {
        if (c.sha === 'e5') throw new Error('boom');
        return scripted[c.sha] ?? [];
      },
    };
    const emitted: string[] = [];
    const summary = await labelCommits({
      commits,
      extractor,
      classifier: new HeuristicDecisionClassifier(),
      emit: (ex) => emitted.push(ex.sha),
      concurrency: 2,
    });

    expect(summary.scanned).toBe(5);
    expect(summary.merges).toBe(1);
    expect(summary.labeled).toBe(3); // a1, b2, c3 (e5 failed, d4 merge)
    expect(summary.positive).toBe(2); // a1, b2
    expect(summary.negative).toBe(1); // c3
    expect(summary.failures).toBe(1); // e5
    expect(summary.heuristicAgree).toBe(1); // a1
    expect(summary.heuristicFalseNeg).toBe(1); // b2 — the "why" the heuristic missed
    expect(summary.heuristicFalsePos).toBe(1); // c3 — the wasted LLM call
    expect(emitted.sort()).toEqual(['a1', 'b2', 'c3']);
  });
});
