/**
 * Code-memory Phase 1 — capture pipeline unit coverage.
 *
 * Pins the deterministic Layer-1 gate (HeuristicDecisionClassifier) and the
 * pipeline orchestration (filter → classify → extract → sink) with stubbed
 * Layer-2 + sink. The LLM extractor and HTTP sink are exercised only behind
 * their interfaces here — their concrete impls are integration concerns.
 */
import { parseCommitSignals } from '../src/code-memory/capture/commit-signals';
import { HeuristicDecisionClassifier } from '../src/code-memory/capture/heuristic-classifier';
import { runCapturePipeline } from '../src/code-memory/capture/capture-pipeline';
import type {
  CommitInput,
  DecisionCandidate,
  DecisionExtractor,
  DecisionSink,
} from '../src/code-memory/capture/types';

function commit(over: Partial<CommitInput>): CommitInput {
  return {
    sha: 'a1211e8d',
    message: 'chore: bump deps',
    changedFiles: ['package.json'],
    authorDate: '2026-06-28T00:00:00Z',
    ...over,
  };
}

describe('parseCommitSignals', () => {
  it('extracts conventional type, trailers, issue refs, rationale markers', () => {
    const s = parseCommitSignals(
      commit({
        message: `refactor(ingest): split IngestService (#67)

Split the god-class because 21 positional args drifted between call-sites.
Why: max-params=3 gate.
Decision: route every write through one gateway.`,
      }),
    );
    expect(s.conventionalType).toBe('refactor');
    expect(s.issueRefs).toContain('67');
    expect(s.trailers.why).toMatch(/max-params/);
    expect(s.trailers.decision).toMatch(/one gateway/);
    expect(s.rationaleMarkers).toContain('because');
  });

  it('handles a subject-only message (no body)', () => {
    const s = parseCommitSignals(commit({ message: 'fix: typo' }));
    expect(s.conventionalType).toBe('fix');
    expect(s.bodyLength).toBe(0);
    expect(s.rationaleMarkers).toHaveLength(0);
  });
});

describe('HeuristicDecisionClassifier', () => {
  const c = new HeuristicDecisionClassifier();

  it('rejects merge commits', () => {
    const v = c.classify(commit({ message: 'Merge pull request #5 from x/y' }));
    expect(v.likelyDecision).toBe(false);
    expect(v.reason).toMatch(/merge/);
  });

  it('admits on an explicit decision/rationale trailer', () => {
    const v = c.classify(
      commit({ message: 'fix: x\n\nWhy: prevents a race under FANOUT' }),
    );
    expect(v.likelyDecision).toBe(true);
    expect(v.reason).toMatch(/trailer/);
  });

  it('rejects a low-signal type with no body', () => {
    const v = c.classify(commit({ message: 'chore: bump deps' }));
    expect(v.likelyDecision).toBe(false);
    expect(v.reason).toMatch(/low-signal/);
  });

  it('admits when rationale markers appear in prose', () => {
    const v = c.classify(
      commit({
        message: 'style: reformat\n\nReordered so that the hot path stays inlined instead of a call.',
      }),
    );
    expect(v.likelyDecision).toBe(true);
    expect(v.reason).toMatch(/rationale/);
  });

  it('admits a decision-type with an explanatory body', () => {
    const v = c.classify(
      commit({
        message: `refactor: extract FactResolverService

The single fn::resolve_fact gateway centralises the 21-arg call so a
signature change cannot drift the two call-sites out of sync.`,
      }),
    );
    expect(v.likelyDecision).toBe(true);
    expect(v.reason).toMatch(/decision-type|explanatory body/);
  });

  it('rejects a bare decision-type subject with no body', () => {
    const v = c.classify(commit({ message: 'feat: add endpoint' }));
    expect(v.likelyDecision).toBe(false);
  });
});

describe('runCapturePipeline', () => {
  const classifier = new HeuristicDecisionClassifier();

  function stubExtractor(bySha: Record<string, DecisionCandidate[]>): DecisionExtractor {
    return {
      extract: (cmt) => Promise.resolve(bySha[cmt.sha] ?? []),
    };
  }
  function collectingSink(): DecisionSink & { recorded: DecisionCandidate[] } {
    const recorded: DecisionCandidate[] = [];
    return {
      recorded,
      record: (cand) => {
        recorded.push(cand);
        return Promise.resolve({ outcome: 'INSERTED' });
      },
    };
  }

  it('skips merge + classifier-rejected, extracts + records the rest', async () => {
    const sink = collectingSink();
    const candidate: DecisionCandidate = {
      kind: 'decided',
      text: 'route writes through one gateway',
      anchor: 'src/ingest/fact-resolver.service.ts',
      commit: 'dec1',
      validFrom: '2026-06-28T00:00:00Z',
    };
    const summary = await runCapturePipeline({
      commits: [
        commit({ sha: 'merge1', message: 'Merge pull request #1 from a/b' }),
        commit({ sha: 'chore1', message: 'chore: bump deps' }),
        commit({
          sha: 'dec1',
          message: 'refactor: split service\n\nbecause the god-class drifted between call-sites and we wanted ≤3 deps.',
        }),
      ],
      classifier,
      extractor: stubExtractor({ dec1: [candidate] }),
      sink,
    });

    expect(summary.scanned).toBe(3);
    expect(summary.trivialSkipped).toBe(1);
    expect(summary.classifierRejected).toBe(1);
    expect(summary.extracted).toBe(1);
    expect(summary.recorded).toBe(1);
    expect(summary.failures).toBe(0);
    expect(sink.recorded).toHaveLength(1);
    expect(sink.recorded[0].anchor).toMatch(/fact-resolver/);
  });

  it('counts an extractor failure without aborting the run', async () => {
    const sink = collectingSink();
    const extractor: DecisionExtractor = {
      extract: (cmt) =>
        cmt.sha === 'boom'
          ? Promise.reject(new Error('LLM down'))
          : Promise.resolve([
              {
                kind: 'gotcha',
                text: 'g',
                anchor: 'a.ts',
                commit: cmt.sha,
                validFrom: '2026-06-28T00:00:00Z',
              },
            ]),
    };
    const admit = (sha: string) =>
      commit({ sha, message: `fix: x\n\nWhy: rationale body for ${sha}` });

    const summary = await runCapturePipeline({
      commits: [admit('boom'), admit('ok')],
      classifier,
      extractor,
      sink,
    });

    expect(summary.failures).toBe(1);
    expect(summary.recorded).toBe(1);
    expect(sink.recorded).toHaveLength(1);
  });

  it('counts a sink failure per candidate and continues', async () => {
    const failingSink: DecisionSink = {
      record: () => Promise.reject(new Error('503 from brain')),
    };
    const summary = await runCapturePipeline({
      commits: [commit({ sha: 'd', message: 'fix: x\n\nWhy: because reasons here for body' })],
      classifier,
      extractor: stubExtractor({
        d: [
          {
            kind: 'decided',
            text: 't',
            anchor: 'a.ts',
            commit: 'd',
            validFrom: '2026-06-28T00:00:00Z',
          },
        ],
      }),
      sink: failingSink,
    });
    expect(summary.extracted).toBe(1);
    expect(summary.recorded).toBe(0);
    expect(summary.failures).toBe(1);
  });
});
