/**
 * Multilingual Tier 2 — embedder A/B harness (SCAFFOLD, no paid scoring).
 *
 * Compares several embedding "arms" — OpenAI vs bge-m3 vs bge-m3+reranker —
 * over the Tier-0 multilingual matrix and lays their metrics side by side so
 * a space migration can be justified by numbers rather than a hunch. It is
 * deliberately a scaffold: every arm's model comes from the SAME Tier-0
 * spend gate (`createMultilingualModel`), so in CI every arm runs on the
 * deterministic StubModel and NO real / paid embedder call is reachable.
 * The live path (a real embedder behind each arm) stays inert exactly like
 * Tier 0's RealModel — its `predict` throws — until it is deliberately built
 * behind MULTILINGUAL_EVAL_LIVE.
 *
 * Each arm carries its canonical `embeddingSpaceId` (Tier 2) purely as
 * provenance on the comparison — so a report says which vector space each
 * column was produced in.
 */

import type { MultilingualCase, MultilingualMatrixReport } from '../../../src/eval/types';
import { embeddingSpaceId } from '../../../src/ai/embedder/embedding-space';
import { MultilingualMatrixRunner } from './matrix-runner';
import {
  createMultilingualModel,
  isLiveEvalEnabled,
  type MultilingualModelEnv,
  type StubMode,
} from './model';

export interface AbArm {
  /** Display name, e.g. `openai` | `bge-m3` | `bge-m3+reranker`. */
  name: string;
  /** Canonical embedding-space id of the arm's embedder — provenance only. */
  spaceId: string;
  /** Whether this arm also applies a reranker over the retrieved pool. Only
   *  metadata in the scaffold; the live wiring would route retrieval through
   *  a cross-encoder before scoring. */
  reranker?: boolean;
  /** In the stub/CI path, how this arm's StubModel behaves. Lets a caller
   *  make the A/B diff visibly non-zero without any real model. */
  stubMode?: StubMode;
}

export interface AbArmResult {
  arm: string;
  spaceId: string;
  reranker: boolean;
  report: MultilingualMatrixReport;
}

export interface AbMetricRow {
  metric: string;
  /** arm name → overall value for that metric (null when N/A). */
  values: Record<string, number | null>;
}

export interface AbComparison {
  generatedAt: string;
  /** 'stub' in CI; 'real' only under MULTILINGUAL_EVAL_LIVE + a key. */
  modelKind: 'stub' | 'real';
  arms: AbArmResult[];
  /** Overall metric values laid out per arm — the side-by-side table. */
  overallByMetric: AbMetricRow[];
}

/**
 * The three canonical arms of the Tier-2 comparison. Space ids are built via
 * the pure helper so they stay in lockstep with the serving-side descriptors.
 */
export const DEFAULT_AB_ARMS: AbArm[] = [
  {
    name: 'openai',
    spaceId: embeddingSpaceId({
      provider: 'openai',
      model: 'text-embedding-3-small',
      dim: 1536,
      norm: 'l2',
    }),
    stubMode: 'perfect',
  },
  {
    name: 'bge-m3',
    spaceId: embeddingSpaceId({
      provider: 'bge-m3',
      model: 'Xenova/bge-m3',
      dim: 1024,
      norm: 'l2',
    }),
    stubMode: 'perfect',
  },
  {
    name: 'bge-m3+reranker',
    spaceId: embeddingSpaceId({
      provider: 'bge-m3',
      model: 'Xenova/bge-m3',
      dim: 1024,
      norm: 'l2',
    }),
    reranker: true,
    stubMode: 'perfect',
  },
];

export class MultilingualAbHarness {
  constructor(private readonly runner: MultilingualMatrixRunner = new MultilingualMatrixRunner()) {}

  /** True only when a live A/B run is explicitly enabled (never in CI). */
  isLive(env: MultilingualModelEnv = process.env): boolean {
    return isLiveEvalEnabled(env);
  }

  /**
   * Score every arm over the matrix and lay the overall metrics side by side.
   * Each arm's model comes from the Tier-0 spend gate, so this is stub-only
   * in CI. Throws (never bills) if the live flag is set without a key —
   * inherited straight from `createMultilingualModel`.
   */
  run(
    cases: MultilingualCase[],
    arms: AbArm[] = DEFAULT_AB_ARMS,
    env: MultilingualModelEnv = process.env,
  ): AbComparison {
    const results: AbArmResult[] = arms.map((arm) => {
      // Conditional spread: under exactOptionalPropertyTypes an explicit
      // `mode: undefined` is not assignable to StubModelOptions.
      const model = createMultilingualModel(env, arm.stubMode ? { mode: arm.stubMode } : {});
      return {
        arm: arm.name,
        spaceId: arm.spaceId,
        reranker: arm.reranker === true,
        report: this.runner.run(cases, model),
      };
    });

    // Union of metric names across arms (they share the Tier-0 column set,
    // but union keeps this robust to arm-specific columns later).
    const metricNames: string[] = [];
    const seen = new Set<string>();
    for (const r of results) {
      for (const cellMetric of r.report.overall) {
        if (!seen.has(cellMetric.metric)) {
          seen.add(cellMetric.metric);
          metricNames.push(cellMetric.metric);
        }
      }
    }

    const overallByMetric: AbMetricRow[] = metricNames.map((metric) => {
      const values: Record<string, number | null> = {};
      for (const r of results) {
        const c = r.report.overall.find((x) => x.metric === metric);
        values[r.arm] = c ? c.value : null;
      }
      return { metric, values };
    });

    return {
      generatedAt: new Date().toISOString(),
      modelKind: results[0]?.report.modelKind ?? 'stub',
      arms: results,
      overallByMetric,
    };
  }
}
