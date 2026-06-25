import type {
  AggregateMetric,
  EvalReport,
  ScenarioOutcome,
  Vertical,
  VerticalReport,
} from '../../../src/eval/types';
import {
  recallAtKVector,
  reciprocalRankVector,
  extractionRecall,
  entityExtractionRate,
  identityResolutionMetrics,
  piiGatingCorrectness,
  memoryLifecycleCorrectness,
  ndcgAtKVector,
  bootstrapMeanCI,
} from '../metrics';

/**
 * Aggregates per-scenario outcomes into per-vertical and overall metric
 * tables. Stateless — feed outcomes in, get the report back.
 */
export class Aggregator {
  build(outcomes: ScenarioOutcome[]): EvalReport {
    const byVertical = new Map<Vertical, ScenarioOutcome[]>();
    for (const o of outcomes) {
      const arr = byVertical.get(o.vertical) ?? [];
      arr.push(o);
      byVertical.set(o.vertical, arr);
    }

    const perVertical: VerticalReport[] = [];
    for (const [vertical, group] of byVertical) {
      perVertical.push({
        vertical,
        scenarios: group.length,
        metrics: this.computeMetrics(group),
      });
    }

    return {
      perVertical,
      overall: this.computeMetrics(outcomes, true),
      outcomes,
    };
  }

  private computeMetrics(
    group: ScenarioOutcome[],
    isOverall = false,
  ): AggregateMetric[] {
    // Per-vertical groups are small (n≈8–30) with wide CIs, so their core
    // retrieval floors stay lenient — a single miss on a 12-query vertical
    // shouldn't red the suite. The OVERALL aggregate (n≈260) is tight, so it
    // carries a much stricter floor that actually catches regression. The
    // measured 2026-06-25 baseline is recall@1 0.95 / recall@3 0.99 / MRR
    // 0.97; these floors sit ~10pp below with headroom for normal variance
    // while still tripping on a real drop (the old 0.6/0.8/0.5 could not).
    const recall1Floor = isOverall ? 0.85 : 0.6;
    const recall3Floor = isOverall ? 0.93 : 0.8;
    const mrrFloor = isOverall ? 0.88 : 0.5;
    const queries = group.flatMap((o) => o.queryResults);
    const extractions = group.flatMap((o) => o.extractionResults);
    const merges = group
      .map((o) => o.identityMergeResult)
      .filter((r): r is NonNullable<typeof r> => r !== undefined);
    const memAssertions = group.flatMap((o) => o.memoryAssertionResults);
    const miaResults = group.flatMap((o) => o.miaTestResults);
    const synthOutcomes = group.flatMap((o) => o.synthesizeOutcomes);
    const synthScored = synthOutcomes.filter(
      (o): o is typeof o & { faithfulness: number } => o.faithfulness !== null,
    );
    const synthMean =
      synthScored.length === 0
        ? null
        : synthScored.reduce((acc, o) => acc + o.faithfulness, 0) / synthScored.length;
    const synthVerifierFailures = synthOutcomes.filter(
      (o) => o.verifierFailureKind !== undefined,
    ).length;
    const synthPassRate =
      synthOutcomes.length === 0
        ? null
        : synthOutcomes.filter((o) => o.passed).length / synthOutcomes.length;

    // Temporal split: queries carrying an asOf are bitemporal /
    // historical-intent; the rest are current-state. A SOTA-claim
    // requires both partitions to be measured separately — a
    // 0.88 mean recall@1 can hide a 0.50 as-of-T slice if the
    // current slice is dominant.
    const temporalQueries = queries.filter((q) => q.temporal);
    const currentQueries = queries.filter((q) => !q.temporal);

    // Bootstrap-CI helper. Vector → AggregateMetric with mean, CI,
    // and N attached. 1000 resamples is enough for ±0.005 stability
    // on N≥10 (Efron 1979, conventional choice for sample-mean CI).
    // null vector → null bounds; reporter renders "—".
    const bootstrap = (
      name: string,
      vector: number[],
      threshold?: number,
    ) => {
      if (vector.length === 0) {
        return { name, value: null, ...(threshold !== undefined ? { threshold } : {}), n: 0 };
      }
      const mean = vector.reduce((a, b) => a + b, 0) / vector.length;
      const ci = bootstrapMeanCI(vector, { B: 1000 });
      return {
        name,
        value: mean,
        ...(threshold !== undefined ? { threshold } : {}),
        ciLower: ci.lower,
        ciUpper: ci.upper,
        n: vector.length,
      };
    };

    return [
      bootstrap('recall@1', recallAtKVector(queries, 1), recall1Floor),
      bootstrap('recall@3', recallAtKVector(queries, 3), recall3Floor),
      bootstrap('MRR', reciprocalRankVector(queries), mrrFloor),
      // NDCG@10 — canonical retrieval metric on BEIR/MTEB/MS MARCO.
      // Standard reporting unit for embedding-model papers; lets our
      // numbers be directly compared to published baselines.
      // No threshold here because the ground-truth distribution in
      // our scenarios is single-relevant — NDCG@10 mirrors recall@1
      // when k≥rank, so threshold pressure is already on recall@k.
      bootstrap('NDCG@10', ndcgAtKVector(queries, 10)),
      // Temporal split. Reported alongside the aggregate so a
      // regression in either partition is loud. null when the
      // partition is empty (e.g. retrieval-only scenarios).
      bootstrap('recall@1:temporal', recallAtKVector(temporalQueries, 1)),
      bootstrap('recall@1:current', recallAtKVector(currentQueries, 1)),
      bootstrap('MRR:temporal', reciprocalRankVector(temporalQueries)),
      bootstrap('MRR:current', reciprocalRankVector(currentQueries)),
      {
        name: 'extraction-predicate-recall',
        value: extractionRecall(extractions),
        threshold: 0.5,
      },
      {
        name: 'entity-extraction-rate',
        value: entityExtractionRate(extractions),
        threshold: 0.7,
      },
      // Identity-resolution: precision / recall / F1 over identity_of
      // intents. Recall = declared merges that succeeded; precision =
      // declared distractors NOT over-merged. The old single-rate
      // metric was blind to false merges (a placebo). Threshold is
      // attached to F1 only — precision/recall are reported alongside
      // for debuggability.
      ...identityMergeMetrics(merges),
      {
        name: 'pii-gating-correctness',
        value: piiGatingCorrectness(queries),
        threshold: 1.0,
      },
      // memory-lifecycle correctness covers update / supersede /
      // retract / forget. Threshold 1.0 — any lifecycle assertion
      // failing means brain's read-side disagrees with the write
      // semantics, which is non-negotiable. null when the slice has
      // no memory assertions (e.g. plain retrieval suites).
      {
        name: 'memory-lifecycle-correctness',
        value: memoryLifecycleCorrectness(memAssertions),
        threshold: 1.0,
      },
      // privacy-leakage AUC — Membership Inference Attack score.
      // We report the MAX AUC across all MIA tests in the slice;
      // one leaking test fails the run regardless of how many other
      // tests passed. Inverted threshold (lower is better): pass
      // when AUC ≤ 0.6 across every test; we surface the worst
      // value so a regression can't hide behind an average.
      // null when no MIA tests in the slice.
      // RAGAS faithfulness mean across synthesize outcomes. Threshold
      // 0.85 mirrors the production convention from the metric
      // documentation. faithfulness:pass-rate is the gate — mean is
      // reported alongside for diagnosis. verifier-failures is a
      // separate count (any non-zero means the LLM verifier returned
      // a malformed shape and the score is suspect).
      { name: 'faithfulness:mean', value: synthMean, n: synthScored.length },
      {
        name: 'faithfulness:pass-rate',
        value: synthPassRate,
        threshold: synthOutcomes.length > 0 ? 0.8 : undefined,
        n: synthOutcomes.length,
      },
      // Pure diagnostic count (no threshold) — gate semantics are
      // value >= threshold = pass, which inverts wrong for "want
      // zero failures". The faithfulness:pass-rate already counts
      // verifier failures as not-passed, so the gate signal is
      // already covered.
      {
        name: 'faithfulness:verifier-failures',
        value: synthOutcomes.length === 0 ? null : synthVerifierFailures,
        n: synthOutcomes.length,
      },
      // ── Phase 3 recent-additions gates ────────────────────────────
      // These three are computable from the existing SynthesizeOutcome
      // shape without touching the harness. Together they're the
      // smoke test that the Phase 3.A (calibration) + 3.C (ConU
      // conformal guardrail) infrastructure is live in eval, not
      // just declared:
      //   1. conformal-active-rate — fraction of synthesize calls
      //      where SYNTHESIZE_MIN_CONFIDENCE > 0 was active. With the
      //      0.30 default flipped on in deploy-brain.yml (commit
      //      91f0239) we expect this near 1.0 across the suite.
      //      A drop here means the guardrail silently regressed
      //      to identity.
      //   2. synthesize-abstain-rate — fraction of synthesize calls
      //      with answer === null. If the conformal floor is too
      //      aggressive OR the corpus is wrong this spikes. Pass
      //      gate ≤ 0.30 — anything higher and we're abstaining on
      //      a third of queries, which is the failure mode the
      //      audit flagged ("ConU short-circuit means the eval
      //      can't measure abstain quality").
      //   3. verifier-failure-rate — same data as the existing
      //      faithfulness:verifier-failures count, but rendered as
      //      a fraction with a hard threshold so a wave of malformed
      //      verifier responses (the audit's "LLM rerolls" failure
      //      mode) trips the gate instead of just being a diagnostic.
      {
        name: 'conformal-active-rate',
        value:
          synthOutcomes.length === 0
            ? null
            : synthOutcomes.filter((o) => o.faithfulnessFloor > 0).length /
              synthOutcomes.length,
        threshold: synthOutcomes.length > 0 ? 0.95 : undefined,
        n: synthOutcomes.length,
      },
      {
        name: 'synthesize-abstain-rate',
        // Pass condition is value < threshold (the gate is "low is
        // good"). Express as `1 - abstainRate` so the >= comparator
        // does the right thing without changing the harness.
        value:
          synthOutcomes.length === 0
            ? null
            : 1 -
              synthOutcomes.filter((o) => o.answer === null).length /
                synthOutcomes.length,
        threshold: synthOutcomes.length > 0 ? 0.7 : undefined,
        n: synthOutcomes.length,
      },
      {
        name: 'verifier-failure-rate',
        // Same flip — value is 1 - failure-rate so the gate reads
        // "at least 95% of synthesize calls had a clean verifier
        // response". Equivalent to failure-rate ≤ 0.05.
        value:
          synthOutcomes.length === 0
            ? null
            : 1 - synthVerifierFailures / synthOutcomes.length,
        threshold: synthOutcomes.length > 0 ? 0.95 : undefined,
        n: synthOutcomes.length,
      },
      ...phase4Metrics(synthOutcomes),
      {
        name: 'privacy-leakage-mia-auc',
        value: maxMiaAuc(miaResults),
        // No `threshold` on the worst-AUC metric directly because
        // the comparator the harness uses is `value < threshold` for
        // pass — wrong direction for AUC. Per-test pass/fail is
        // captured inside MiaTestResult.passed; the harness asserts
        // those separately.
      },
    ];
  }
}

/** Maximum AUC across MIA tests, or null when there are none. */
function maxMiaAuc(results: import('../../../src/eval/types').MiaTestResult[]): number | null {
  if (results.length === 0) return null;
  let max = 0;
  for (const r of results) if (r.auc > max) max = r.auc;
  return max;
}

/**
 * Phase 4.C / Phase 2 / Phase 3.B aggregate gates. Computed from the
 * diagnostic fields the FaithfulnessChecker now populates on every
 * SynthesizeOutcome. Kept as a small helper so the main metric block
 * stays readable.
 */
function phase4Metrics(
  outcomes: import('../../../src/eval/types').SynthesizeOutcome[],
): import('../../../src/eval/types').AggregateMetric[] {
  // answer-language-correctness — fraction of synthesize calls whose
  // detected answer language matched the SynthesizeExpectation's
  // expectedAnswerLang. Outcomes without an expectation are excluded
  // so locale-agnostic scenarios don't dilute the rate. Threshold
  // 0.95 — a single English answer to a Russian-expected query
  // shouldn't sneak past, but the embedded language detector has
  // false-negatives on very short answers, hence not 1.0.
  const langGated = outcomes.filter(
    (o) => typeof o.answerLangCorrect === 'boolean',
  );
  const langCorrect = langGated.filter((o) => o.answerLangCorrect === true)
    .length;

  // decision-log-citation-rate — fraction of synthesize calls where
  // the generator emitted at least one citation. 0-citation answers
  // are the soft-fail mode (the audit's "ALCE inline citations"
  // partial). Threshold 0.8 — most answers should ground, but a
  // long-tail of trivial yes/no responses may not.
  const synthWithAnswer = outcomes.filter((o) => o.answer && o.answer.trim());
  const citedAnswers = synthWithAnswer.filter(
    (o) => (o.decisionLogCitationCount ?? 0) > 0,
  ).length;

  // mean-extraction-entropy — diagnostic only, no threshold. Reported
  // so a Phase 3.B re-roll regression (entropy collapses to ~0 across
  // the suite = scN driver dead) surfaces in the report even when no
  // operator pre-declared an entropy expectation.
  const entropyValues = outcomes
    .map((o) => o.avgExtractionEntropy)
    .filter((v): v is number => typeof v === 'number');
  const meanEntropy =
    entropyValues.length === 0
      ? null
      : entropyValues.reduce((a, b) => a + b, 0) / entropyValues.length;

  return [
    {
      name: 'answer-language-correctness',
      value: langGated.length === 0 ? null : langCorrect / langGated.length,
      threshold: langGated.length > 0 ? 0.95 : undefined,
      n: langGated.length,
    },
    {
      name: 'decision-log-citation-rate',
      value:
        synthWithAnswer.length === 0
          ? null
          : citedAnswers / synthWithAnswer.length,
      threshold: synthWithAnswer.length > 0 ? 0.8 : undefined,
      n: synthWithAnswer.length,
    },
    {
      name: 'mean-extraction-entropy',
      value: meanEntropy,
      n: entropyValues.length,
    },
  ];
}

/**
 * Identity-resolution metrics flattened to AggregateMetric rows. F1
 * carries the gating threshold; precision and recall ride alongside
 * with no threshold (so an F1 dip doesn't double-fire at the gate).
 */
function identityMergeMetrics(
  merges: import('../../../src/eval/types').IdentityMergeResult[],
): AggregateMetric[] {
  const m = identityResolutionMetrics(merges);
  return [
    { name: 'identity-resolution-f1', value: m.f1, threshold: 0.8 },
    { name: 'identity-resolution-precision', value: m.precision },
    { name: 'identity-resolution-recall', value: m.recall },
  ];
}
