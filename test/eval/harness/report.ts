import { EvalScore, EvalWorld } from './types';

/**
 * Axis-report aggregation — one implementation of the protocol's
 * reporting rules (docs/eval-protocol.md): abstention questions are a
 * separate denominator, judge accuracy is computed over judged
 * non-abstention rows only, token accounting is first-class, and error
 * counts are always surfaced.
 */

export interface GroupAccuracy {
  group: string;
  n: number;
  judgeAccuracy?: number | undefined;
}

export interface AxisReport {
  n: number;
  judgeAccuracy?: number | undefined;
  judgedN: number;
  byGroup: GroupAccuracy[];
  abstention: { n: number; abstainedRate?: number | undefined };
  avgPromptTokens?: number | undefined;
  errored: number;
  /**
   * BEAM official-protocol aggregate (--nugget-judge): mean nugget
   * score over ALL graded rows, abstention included — the official
   * scorer has no separate abstention denominator. Absent when the
   * nugget judge did not run.
   */
  nugget?: {
    n: number;
    mean: number;
    byGroup: Array<{ group: string; n: number; mean: number }>;
  };
}

/** Mean of nuggetScore over rows that carry one; undefined when none. */
function nuggetMean(rows: EvalScore[]): number | undefined {
  const graded = rows.filter((s) => typeof s.nuggetScore === 'number');
  if (graded.length === 0) return undefined;
  return (
    graded.reduce((a, s) => a + (s.nuggetScore as number), 0) / graded.length
  );
}

export function buildAxisReport(scores: EvalScore[]): AxisReport {
  const answerable = scores.filter((s) => !s.isAbstention);
  const judged = answerable.filter((s) => s.judgeCorrect !== undefined);
  const byGroup = new Map<string, EvalScore[]>();
  for (const s of answerable) {
    byGroup.set(s.group, [...(byGroup.get(s.group) ?? []), s]);
  }
  const abstention = scores.filter((s) => s.isAbstention);
  const withTokens = scores.filter((s) => s.promptTokens !== undefined);
  return {
    n: scores.length,
    judgeAccuracy: judged.length
      ? judged.filter((s) => s.judgeCorrect).length / judged.length
      : undefined,
    judgedN: judged.length,
    byGroup: [...byGroup.entries()].map(([group, arr]) => {
      const j = arr.filter((s) => s.judgeCorrect !== undefined);
      return {
        group,
        n: arr.length,
        judgeAccuracy: j.length
          ? j.filter((s) => s.judgeCorrect).length / j.length
          : undefined,
      };
    }),
    abstention: {
      n: abstention.length,
      abstainedRate: abstention.length
        ? abstention.filter((s) => s.abstained).length / abstention.length
        : undefined,
    },
    avgPromptTokens: withTokens.length
      ? Math.round(
          withTokens.reduce((a, s) => a + (s.promptTokens ?? 0), 0) /
            withTokens.length,
        )
      : undefined,
    errored: scores.filter((s) => s.errored).length,
    ...buildNuggetBlock(scores),
  };
}

/** Nugget aggregate over ALL rows (abstention included) — see AxisReport. */
function buildNuggetBlock(scores: EvalScore[]): Pick<AxisReport, 'nugget'> {
  const graded = scores.filter((s) => typeof s.nuggetScore === 'number');
  if (graded.length === 0) return {};
  const byGroup = new Map<string, EvalScore[]>();
  for (const s of graded) {
    byGroup.set(s.group, [...(byGroup.get(s.group) ?? []), s]);
  }
  return {
    nugget: {
      n: graded.length,
      mean: nuggetMean(graded) as number,
      byGroup: [...byGroup.entries()].map(([group, arr]) => ({
        group,
        n: arr.length,
        mean: nuggetMean(arr) as number,
      })),
    },
  };
}

/** Preflight sizing: ~chars/4 across all session turns of the worlds. */
export function estimateHaystackTokens(worlds: EvalWorld[]): number {
  let chars = 0;
  for (const w of worlds) {
    for (const s of w.sessions) {
      for (const t of s.turns) chars += t.content.length;
    }
  }
  return Math.round(chars / 4);
}

export function formatSummaryLine(
  axis: string,
  report: AxisReport,
  out: string,
): string {
  const acc =
    report.judgeAccuracy !== undefined
      ? `${(100 * report.judgeAccuracy).toFixed(1)}%`
      : 'n/a';
  return (
    `[${axis}] judge=${acc} (n=${report.judgedN}) ` +
    `abstention=${report.abstention.abstainedRate ?? 'n/a'} ` +
    `avgPromptTok=${report.avgPromptTokens ?? 'n/a'} ` +
    `errors=${report.errored} → ${out}`
  );
}
