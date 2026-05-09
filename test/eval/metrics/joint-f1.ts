/**
 * Joint Exact Match / Joint F1 — HotpotQA convention.
 *
 * Multi-hop QA's foundational metric. Catches the failure mode that
 * end-to-end recall@k cannot see: a system that produces the right
 * ANSWER via the wrong REASONING CHAIN.
 *
 * Definitions (HotpotQA, Yang et al. 2018):
 *
 *   answer F1     — F1 over the predicted-answer set vs gold answer
 *                    set (entity-refs in our schema; tokens in the
 *                    original paper).
 *   support F1    — F1 over the predicted supporting-facts set vs
 *                    gold supporting-facts set (factIds in our
 *                    schema; sentence-ids in the original).
 *   Joint P       = answer_P × support_P
 *   Joint R       = answer_R × support_R
 *   Joint F1      = 2 · Joint_P · Joint_R / (Joint_P + Joint_R)
 *
 * Joint F1 = 1.0 ONLY when the system landed every gold answer AND
 * every gold supporting fact. A system that nails the answer but
 * pulls evidence from unrelated entities scores 0 on support F1
 * and therefore 0 on Joint F1 — exactly the signal the planner-LLM
 * needs to be held to.
 *
 * Pure function — no IO. Caller produces the predicted/expected
 * shape; this just does the math. Intended call site is the
 * eval-runner in real-e2e specs, but operators can use it directly
 * from any TypeScript code (e.g. a CLI that scores a saved
 * multi-hop response against a hand-crafted expected fixture).
 */

export interface JointF1Predicted {
  /** Externalrefs (vertical.id) of entities the system claimed are the answer. */
  answerEntityRefs: string[];
  /** factIds the system claimed are the supporting evidence chain. */
  supportingFactIds: string[];
}

export interface JointF1Expected {
  answerEntityRefs: string[];
  supportingFactIds: string[];
}

export interface JointF1Score {
  /** 1 if predicted answer set equals expected; 0 otherwise. */
  answerEM: number;
  answerPrecision: number;
  answerRecall: number;
  answerF1: number;
  /** 1 if predicted supporting-facts set equals expected; 0 otherwise. */
  supportEM: number;
  supportPrecision: number;
  supportRecall: number;
  supportF1: number;
  /** Multiplicative — 1 only if BOTH answer and support are EM-perfect. */
  jointEM: number;
  jointPrecision: number;
  jointRecall: number;
  jointF1: number;
}

export interface JointF1Aggregate {
  /** Mean values across the input array of per-query scores. */
  answerEM: number;
  answerF1: number;
  supportEM: number;
  supportF1: number;
  jointEM: number;
  jointF1: number;
  count: number;
}

/**
 * Score one (predicted, expected) pair.
 *
 * Edge cases:
 *   - Both sets empty (predicted and expected are both `[]`): the
 *     query "expected nothing" and the system delivered nothing.
 *     Treat as perfect (P=R=F1=1, EM=1).
 *   - Predicted empty but expected non-empty: zero precision (no
 *     positives) AND zero recall — F1=0, EM=0.
 *   - Expected empty but predicted non-empty: the predicted set is
 *     all noise. P=0, R=1 by convention (no false negatives in an
 *     empty gold set), F1=0. EM=0 because the sets aren't equal.
 *     The harmonic mean still collapses to 0; this matches HotpotQA.
 */
export function jointF1(
  p: JointF1Predicted,
  e: JointF1Expected,
): JointF1Score {
  const a = setMetrics(p.answerEntityRefs, e.answerEntityRefs);
  const s = setMetrics(p.supportingFactIds, e.supportingFactIds);
  const jointP = a.precision * s.precision;
  const jointR = a.recall * s.recall;
  const jointF1 =
    jointP + jointR > 0 ? (2 * jointP * jointR) / (jointP + jointR) : 0;
  return {
    answerEM: a.em,
    answerPrecision: a.precision,
    answerRecall: a.recall,
    answerF1: a.f1,
    supportEM: s.em,
    supportPrecision: s.precision,
    supportRecall: s.recall,
    supportF1: s.f1,
    jointEM: a.em * s.em,
    jointPrecision: jointP,
    jointRecall: jointR,
    jointF1,
  };
}

/** Mean across a batch of per-query scores. */
export function meanJointF1(scores: JointF1Score[]): JointF1Aggregate | null {
  if (scores.length === 0) return null;
  const n = scores.length;
  const mean = (key: keyof JointF1Score) =>
    scores.reduce((acc, s) => acc + (s[key] as number), 0) / n;
  return {
    answerEM: mean('answerEM'),
    answerF1: mean('answerF1'),
    supportEM: mean('supportEM'),
    supportF1: mean('supportF1'),
    jointEM: mean('jointEM'),
    jointF1: mean('jointF1'),
    count: n,
  };
}

interface SetMetrics {
  precision: number;
  recall: number;
  f1: number;
  em: number;
}

function setMetrics(predicted: string[], expected: string[]): SetMetrics {
  const predSet = new Set(predicted);
  const expSet = new Set(expected);

  if (predSet.size === 0 && expSet.size === 0) {
    return { precision: 1, recall: 1, f1: 1, em: 1 };
  }
  if (predSet.size === 0) {
    return { precision: 0, recall: 0, f1: 0, em: 0 };
  }
  if (expSet.size === 0) {
    // Vacuous recall (no false negatives possible) but the
    // predicted set is all FP — F1 collapses via P=0.
    return { precision: 0, recall: 1, f1: 0, em: 0 };
  }

  let intersection = 0;
  for (const x of predSet) if (expSet.has(x)) intersection++;
  const precision = intersection / predSet.size;
  const recall = intersection / expSet.size;
  const f1 =
    precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  const em =
    predSet.size === expSet.size && intersection === predSet.size ? 1 : 0;
  return { precision, recall, f1, em };
}
