import type {
  CaptureSummary,
  CommitInput,
  DecisionClassifier,
  DecisionExtractor,
  DecisionSink,
} from './types';
import type { DecisionVerifier } from './llm-verifier';
import { isMergeCommit } from './commit-signals';

/**
 * The hybrid client-side capture pipeline. For each commit:
 *   1. trivial filter (merge commits) — cheapest reject
 *   2. Layer 1 classifier — deterministic admit/reject gate
 *   3. Layer 2 extractor — LLM extraction of decision candidates (admitted only)
 *   4. sink — record each candidate into brain (facts only, no source)
 *
 * Collaborators are injected (classifier / extractor / sink) so the orchestration
 * is pure and unit-testable with stubs, and so the LLM + network live behind
 * swappable seams. A per-commit extractor/sink failure is counted and logged via
 * `log`, never aborts the run (one bad commit must not lose the rest).
 */
export async function runCapturePipeline(opts: {
  commits: CommitInput[];
  classifier: DecisionClassifier;
  extractor: DecisionExtractor;
  /** Optional strict LLM-judge pass — filters over-labeled candidates before
   *  they're recorded (raises precision). Fail-open. */
  verifier?: DecisionVerifier;
  sink: DecisionSink;
  /**
   * Optional Phase-2 anchor refinement — upgrade a candidate's file anchor to a
   * grounded symbol anchor (see anchor/refine.ts). Runs client-side (reads local
   * files); defaults to identity so Phase-1 file anchoring still works.
   */
  refineAnchor?: (
    c: import('./types').DecisionCandidate,
  ) => import('./types').DecisionCandidate;
  log?: (msg: string) => void;
}): Promise<CaptureSummary> {
  const { commits, classifier, extractor, sink } = opts;
  const refineAnchor = opts.refineAnchor ?? ((c) => c);
  const log = opts.log ?? (() => {});
  const summary: CaptureSummary = {
    scanned: commits.length,
    trivialSkipped: 0,
    classifierRejected: 0,
    extracted: 0,
    recorded: 0,
    failures: 0,
  };

  for (const commit of commits) {
    if (isMergeCommit(commit)) {
      summary.trivialSkipped += 1;
      continue;
    }

    const verdict = classifier.classify(commit);
    if (!verdict.likelyDecision) {
      summary.classifierRejected += 1;
      log(`skip ${short(commit.sha)}: ${verdict.reason}`);
      continue;
    }

    let candidates;
    try {
      candidates = await extractor.extract(commit);
    } catch (e) {
      summary.failures += 1;
      log(`extract failed ${short(commit.sha)}: ${(e as Error).message}`);
      continue;
    }
    if (opts.verifier) {
      try {
        candidates = await opts.verifier.rescore(commit, candidates);
      } catch (e) {
        // Fail-open: keep the raw candidates if the judge errors.
        log(`verify failed ${short(commit.sha)} (keeping raw): ${(e as Error).message}`);
      }
    }
    summary.extracted += candidates.length;

    for (const raw of candidates) {
      const candidate = refineAnchor(raw);
      try {
        await sink.record(candidate);
        summary.recorded += 1;
      } catch (e) {
        summary.failures += 1;
        log(
          `record failed ${short(commit.sha)} (${candidate.kind} @ ${candidate.anchor}): ${(e as Error).message}`,
        );
      }
    }
  }

  return summary;
}

function short(sha: string): string {
  return sha.slice(0, 8);
}
