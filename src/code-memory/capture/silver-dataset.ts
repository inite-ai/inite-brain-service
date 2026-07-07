import type {
  CommitInput,
  DecisionCandidate,
  DecisionClassifier,
  DecisionExtractor,
  DecisionKind,
  Layer1Signals,
} from './types';
import type { DecisionVerifier } from './llm-verifier';
import { isMergeCommit, parseCommitSignals } from './commit-signals';

/**
 * Code-memory track C — SILVER dataset builder for the trained Layer-1 gate.
 * (docs/code-memory/distillation-dataset.md)
 *
 * The Layer-1 classifier is a cheap binary gate: "does this commit's text carry
 * an engineering 'why' worth an LLM extraction?". No public corpus labels the
 * decided/because/invariant/gotcha taxonomy, so we DISTILL: the existing Layer-2
 * LLM extractor is the TEACHER — a commit is decision-bearing iff the teacher
 * extracts ≥1 candidate — and its verdicts become silver labels to train a cheap
 * student (BiLSTM / DistilBERT) behind the same {@link DecisionClassifier} seam.
 *
 * CRUCIAL DIFFERENCE from the production capture pipeline: here we run the
 * teacher over EVERY commit, NOT behind the heuristic gate. Gating first would
 * hide the heuristic's false negatives — commits it rejected that DO carry a
 * "why" — which are exactly the examples a trained student must learn. Each row
 * also records the current heuristic verdict so we can measure how much the
 * heuristic over/under-filters (the payoff signal for training a model at all).
 */

/** One silver-labeled training row. `text` is the EXACT input the Layer-1
 *  classifier sees (message + PR body, no diff) — same at train + serve time. */
export interface SilverExample {
  sha: string;
  text: string;
  /** Teacher label: 1 iff Layer-2 extracted ≥1 decision candidate. */
  label: 0 | 1;
  /** Distinct kinds the teacher found — fodder for a future multi-label head. */
  kinds: DecisionKind[];
  candidateCount: number;
  /** Max confidence across the teacher's candidates (null if none carried one).
   *  Persisted so the label threshold can be RE-TUNED offline (drop weak
   *  positives) without re-spending on the LLM — the teacher over-labels bare
   *  "what" commits, so a confidence gate is the cheap precision knob. */
  maxConfidence: number | null;
  /** Deterministic cheap features (also the heuristic's substrate). */
  signals: Layer1Signals;
  /** Current heuristic verdict — for heuristic-vs-teacher agreement analysis. */
  heuristic: { likelyDecision: boolean; reason: string };
  authorDate: string;
}

/** The classifier input text: commit message + PR body (no diff, no file
 *  contents). Single source of truth so the trained student is fed the same
 *  text the production gate will see. */
export function commitText(commit: CommitInput): string {
  return commit.prBody
    ? `${commit.message}\n\n${commit.prBody}`
    : commit.message;
}

/** Build one silver example from a commit + the teacher's extraction. Pure. */
export function buildSilverExample(args: {
  commit: CommitInput;
  candidates: DecisionCandidate[];
  classifier: DecisionClassifier;
}): SilverExample {
  const { commit, candidates, classifier } = args;
  const kinds = [...new Set(candidates.map((c) => c.kind))];
  const verdict = classifier.classify(commit);
  const confidences = candidates
    .map((c) => c.confidence)
    .filter((c): c is number => typeof c === 'number');
  return {
    sha: commit.sha,
    text: commitText(commit),
    label: candidates.length > 0 ? 1 : 0,
    kinds,
    candidateCount: candidates.length,
    maxConfidence: confidences.length > 0 ? Math.max(...confidences) : null,
    signals: parseCommitSignals(commit),
    heuristic: {
      likelyDecision: verdict.likelyDecision,
      reason: verdict.reason,
    },
    authorDate: commit.authorDate,
  };
}

export interface LabelSummary {
  scanned: number;
  merges: number;
  labeled: number;
  positive: number;
  negative: number;
  failures: number;
  /** heuristic verdict == teacher label — how often the cheap gate already agrees. */
  heuristicAgree: number;
  /** heuristic REJECTED but teacher POSITIVE — the false negatives a model recovers. */
  heuristicFalseNeg: number;
  /** heuristic ADMITTED but teacher NEGATIVE — the wasted LLM calls a model saves. */
  heuristicFalsePos: number;
}

/**
 * Label a set of commits with the teacher extractor, emitting one SilverExample
 * per non-merge commit. Merges are trivially non-decision (skipped, not
 * labeled). A per-commit teacher failure is counted and skipped — one bad
 * commit must not sink the run. Bounded-concurrency; emit order is not
 * guaranteed (a JSONL dataset is order-insensitive).
 */
export async function labelCommits(opts: {
  commits: CommitInput[];
  extractor: DecisionExtractor;
  classifier: DecisionClassifier;
  emit: (ex: SilverExample) => void;
  /** Optional strict second pass (LLM-judge) that filters over-labeled
   *  candidates + calibrates confidence — a stronger teacher. Fail-open. */
  verifier?: DecisionVerifier;
  concurrency?: number;
  log?: (msg: string) => void;
}): Promise<LabelSummary> {
  const { commits, extractor, classifier, emit, verifier } = opts;
  const log = opts.log ?? (() => {});
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const summary: LabelSummary = {
    scanned: commits.length,
    merges: 0,
    labeled: 0,
    positive: 0,
    negative: 0,
    failures: 0,
    heuristicAgree: 0,
    heuristicFalseNeg: 0,
    heuristicFalsePos: 0,
  };

  const targets = commits.filter((c) => {
    if (isMergeCommit(c)) {
      summary.merges += 1;
      return false;
    }
    return true;
  });

  await runPool(targets, concurrency, async (commit) => {
    let candidates: DecisionCandidate[];
    try {
      candidates = await extractor.extract(commit);
    } catch (e) {
      summary.failures += 1;
      log(`label failed ${commit.sha.slice(0, 8)}: ${(e as Error).message}`);
      return;
    }
    if (verifier) {
      try {
        candidates = await verifier.rescore(commit, candidates);
      } catch (e) {
        // Fail-open: a judge failure keeps the raw candidates, never drops them.
        log(`verify failed ${commit.sha.slice(0, 8)} (keeping raw): ${(e as Error).message}`);
      }
    }
    const ex = buildSilverExample({ commit, candidates, classifier });
    emit(ex);
    summary.labeled += 1;
    if (ex.label === 1) summary.positive += 1;
    else summary.negative += 1;
    const heur = ex.heuristic.likelyDecision ? 1 : 0;
    if (heur === ex.label) summary.heuristicAgree += 1;
    else if (ex.label === 1) summary.heuristicFalseNeg += 1;
    else summary.heuristicFalsePos += 1;
  });

  return summary;
}

/** Minimal bounded-concurrency map — no external dep, keeps the capture module
 *  free of the NestJS/DI surface (it runs client-side). */
async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const lanes = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) break;
        await worker(items[i], i);
      }
    },
  );
  await Promise.all(lanes);
}
