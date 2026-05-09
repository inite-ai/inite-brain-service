import type {
  AggregateMetric,
  EvalReport,
  ScenarioOutcome,
  Vertical,
  VerticalReport,
} from '../types';
import {
  recallAtK,
  meanReciprocalRank,
  extractionRecall,
  entityExtractionRate,
  identityResolutionRate,
  piiGatingCorrectness,
  memoryLifecycleCorrectness,
  ndcgAtK,
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
      overall: this.computeMetrics(outcomes),
      outcomes,
    };
  }

  private computeMetrics(group: ScenarioOutcome[]): AggregateMetric[] {
    const queries = group.flatMap((o) => o.queryResults);
    const extractions = group.flatMap((o) => o.extractionResults);
    const merges = group
      .map((o) => o.identityMergeResult)
      .filter((r): r is NonNullable<typeof r> => r !== undefined);
    const memAssertions = group.flatMap((o) => o.memoryAssertionResults);

    // Temporal split: queries carrying an asOf are bitemporal /
    // historical-intent; the rest are current-state. A SOTA-claim
    // requires both partitions to be measured separately — a
    // 0.88 mean recall@1 can hide a 0.50 as-of-T slice if the
    // current slice is dominant.
    const temporalQueries = queries.filter((q) => q.temporal);
    const currentQueries = queries.filter((q) => !q.temporal);

    return [
      { name: 'recall@1', value: recallAtK(queries, 1), threshold: 0.6 },
      { name: 'recall@3', value: recallAtK(queries, 3), threshold: 0.8 },
      { name: 'MRR', value: meanReciprocalRank(queries), threshold: 0.5 },
      // NDCG@10 — canonical retrieval metric on BEIR/MTEB/MS MARCO.
      // Standard reporting unit for embedding-model papers; lets our
      // numbers be directly compared to published baselines.
      // No threshold here because the ground-truth distribution in
      // our scenarios is single-relevant — NDCG@10 mirrors recall@1
      // when k≥rank, so threshold pressure is already on recall@k.
      { name: 'NDCG@10', value: ndcgAtK(queries, 10) },
      // Temporal split. Reported alongside the aggregate so a
      // regression in either partition is loud. null when the
      // partition is empty (e.g. retrieval-only scenarios).
      {
        name: 'recall@1:temporal',
        value: recallAtK(temporalQueries, 1),
      },
      {
        name: 'recall@1:current',
        value: recallAtK(currentQueries, 1),
      },
      {
        name: 'MRR:temporal',
        value: meanReciprocalRank(temporalQueries),
      },
      {
        name: 'MRR:current',
        value: meanReciprocalRank(currentQueries),
      },
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
      { name: 'identity-resolution', value: identityResolutionRate(merges) },
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
    ];
  }
}
