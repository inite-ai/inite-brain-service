/**
 * Code-memory track C — teacher verification (LLM-judge). Raises precision by
 * dropping over-labeled candidates; composes with the confidence gate. Fail-open
 * so a bad judge response never deletes a real "why".
 */
import {
  LlmDecisionVerifier,
  applyVerdicts,
  buildVerifyPrompt,
} from '../src/code-memory/capture/llm-verifier';
import { labelCommits } from '../src/code-memory/capture/silver-dataset';
import { HeuristicDecisionClassifier } from '../src/code-memory/capture/heuristic-classifier';
import type {
  CommitInput,
  DecisionCandidate,
  DecisionExtractor,
} from '../src/code-memory/capture/types';

function commit(over: Partial<CommitInput> & { sha: string }): CommitInput {
  return {
    message: 'feat: x',
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
    commit: 's',
    validFrom: '2026-07-07T00:00:00Z',
    ...over,
  };
}

describe('applyVerdicts', () => {
  const cands = [
    candidate({ kind: 'decided', text: 'real decision', confidence: 0.9 }),
    candidate({ kind: 'because', text: 'restates the what', confidence: 0.9 }),
  ];

  it('drops keep=false and calibrates confidence on keep=true', () => {
    const raw = JSON.stringify({
      verdicts: [
        { keep: true, confidence: 0.8 },
        { keep: false, confidence: 0.1 },
      ],
    });
    const out = applyVerdicts(cands, raw);
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe('real decision');
    expect(out[0].confidence).toBe(0.8); // recalibrated by the judge
  });

  it('fails open on unparseable judge output (keeps raw)', () => {
    expect(applyVerdicts(cands, 'not json at all')).toEqual(cands);
  });

  it('fails open on a verdict-count mismatch (misaligned → untrusted)', () => {
    const raw = JSON.stringify({ verdicts: [{ keep: false }] }); // 1 vs 2
    expect(applyVerdicts(cands, raw)).toEqual(cands);
  });

  it('accepts a bare array and keeps original confidence when none given', () => {
    const raw = JSON.stringify([{ keep: true }, { keep: true }]);
    const out = applyVerdicts(cands, raw);
    expect(out).toHaveLength(2);
    expect(out[0].confidence).toBe(0.9); // unchanged
  });
});

describe('buildVerifyPrompt', () => {
  it('lists each candidate with its kind + text', () => {
    const { system, user } = buildVerifyPrompt(
      commit({ sha: 'a', message: 'feat: x', prBody: 'why body' }),
      [candidate({ kind: 'gotcha', text: 'double dash trap' })],
    );
    expect(system).toMatch(/STRICT reviewer/);
    expect(user).toContain('[gotcha] double dash trap');
    expect(user).toContain('why body');
  });
});

describe('LlmDecisionVerifier.rescore', () => {
  it('does not call the judge for an empty candidate list', async () => {
    let called = false;
    const v = new LlmDecisionVerifier(async () => {
      called = true;
      return '{}';
    });
    expect(await v.rescore(commit({ sha: 'a' }), [])).toEqual([]);
    expect(called).toBe(false);
  });

  it('filters via the judge verdicts', async () => {
    const v = new LlmDecisionVerifier(async () =>
      JSON.stringify({ verdicts: [{ keep: false }, { keep: true, confidence: 0.7 }] }),
    );
    const out = await v.rescore(commit({ sha: 'a' }), [
      candidate({ text: 'drop me' }),
      candidate({ text: 'keep me' }),
    ]);
    expect(out.map((c) => c.text)).toEqual(['keep me']);
    expect(out[0].confidence).toBe(0.7);
  });
});

describe('labelCommits with a verifier', () => {
  it('flips the label to 0 when the judge rejects every candidate', async () => {
    const extractor: DecisionExtractor = {
      extract: async () => [candidate({ text: 'over-labeled decided' })],
    };
    const verifier = {
      rescore: async () => [] as DecisionCandidate[], // judge rejects all
    };
    const rows: string[] = [];
    const emitted: Array<{ label: 0 | 1 }> = [];
    const summary = await labelCommits({
      commits: [commit({ sha: 'a', message: 'chore: bump deps' })],
      extractor,
      classifier: new HeuristicDecisionClassifier(),
      verifier,
      emit: (ex) => {
        rows.push(ex.sha);
        emitted.push({ label: ex.label });
      },
    });
    expect(summary.labeled).toBe(1);
    expect(emitted[0].label).toBe(0); // verifier turned an over-label into a negative
    expect(summary.positive).toBe(0);
  });
});
