/**
 * Offline BEAM official nugget re-score (V11 §1) — runs the paper's
 * unified per-rubric-item judge over predictions ALREADY saved in
 * report JSONs, without re-running QA. This is the calibration run the
 * V10.5 research digest demanded: our headline numbers come from the
 * strict binary judge, the paper's tables from the nugget protocol —
 * comparing them across judges is meaningless. One cheap re-score of
 * the best checkpoint decides whether the "gap to leaders" framing
 * survives (paper SOTA-100K macro average = 0.358).
 *
 * Protocol mirror (see test/eval/beam/nugget-judge.ts for the two
 * documented deliberate fixes): every ability scores as the mean over
 * rubric items with partial credit, EXCEPT event_ordering which uses
 * LLM-aligned normalized Kendall tau-b (tau_norm — the number
 * report_results.py actually reads). The headline is the macro average
 * of the 10 per-ability means, matching the paper's tables.
 *
 * Usage:
 *   OPENAI_API_KEY=... npx tsx scripts/offline-nugget-score.ts \
 *     /tmp/beam_100k.json var/beam-100k-v6boost.json [more reports...] \
 *     [--model gpt-4.1-mini] [--concurrency 6]
 *
 * Judge calls are paid — every scored row checkpoints to
 * var/<report-basename>-nugget.ckpt.jsonl immediately, and a re-run
 * resumes (same contract as the live runners). Output:
 * var/<report-basename>-nugget.json.
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import OpenAI from 'openai';
import { createNuggetJudge } from '../test/eval/beam/nugget-judge';
import { loadCheckpoint, appendCheckpoint } from '../test/eval/checkpoint';

interface BeamQuestion {
  questionId: string;
  ability: string;
  rubric: string[];
}
interface BeamConv {
  questions: BeamQuestion[];
}
interface ReportScore {
  questionId: string;
  group: string;
  question: string;
  prediction: string;
}
interface Report {
  scores: ReportScore[];
}
interface NuggetRow {
  questionId: string;
  ability: string;
  /** Float-credit mean (our documented fix 1 — 0.5s survive). */
  score: number;
  /** Raw per-item scores; absent for event_ordering (tau row). */
  itemScores?: number[];
}

/** The official aggregation: `score += int(response['score'])` — a
 *  judged 0.5 truncates to 0 in 8/10 ability evaluators. Computed
 *  alongside the float mean so our macro is comparable BOTH ways
 *  (the paper's tables come from the truncating code). */
function truncatedScore(r: NuggetRow): number {
  if (!r.itemScores || r.itemScores.length === 0) return r.score;
  const sum = r.itemScores.reduce((s, x) => s + Math.floor(x), 0);
  return sum / r.itemScores.length;
}

function arg(name: string, dflt: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

async function scoreReport(
  reportPath: string,
  byId: Map<string, BeamQuestion>,
  judge: ReturnType<typeof createNuggetJudge>,
  concurrency: number,
): Promise<void> {
  const name = basename(reportPath).replace(/\.json$/, '');
  // v2: rows carry itemScores (the truncated aggregate needs them).
  const ckptPath = `var/${name}-nugget-v2.ckpt.jsonl`;
  const outPath = `var/${name}-nugget.json`;
  const report = JSON.parse(readFileSync(reportPath, 'utf8')) as Report;
  const done = await loadCheckpoint<NuggetRow>(ckptPath, (r) => r.questionId);
  const todo = report.scores.filter((s) => !done.has(s.questionId));
  console.log(
    `${name}: ${report.scores.length} rows, ${done.size} checkpointed, ${todo.length} to judge`,
  );

  let failed = 0;
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      if (i >= todo.length) return;
      const row = todo[i];
      const q = byId.get(row.questionId);
      if (!q) {
        console.error(`  no dataset entry for ${row.questionId} — skipped`);
        failed += 1;
        continue;
      }
      try {
        let out: NuggetRow;
        if (q.ability === 'event_ordering') {
          const r = await judge.orderingScore({
            rubric: q.rubric,
            prediction: row.prediction,
          });
          out = {
            questionId: row.questionId,
            ability: q.ability,
            score: r.tauNorm,
          };
        } else {
          const r = await judge.scoreQuestion({
            question: row.question,
            rubric: q.rubric,
            prediction: row.prediction,
          });
          out = {
            questionId: row.questionId,
            ability: q.ability,
            score: r.nuggetScore,
            itemScores: r.itemScores,
          };
        }
        done.set(out.questionId, out);
        await appendCheckpoint(ckptPath, out);
        if (done.size % 40 === 0) {
          console.log(`  ${done.size}/${report.scores.length}`);
        }
      } catch (e) {
        // Not checkpointed — a resume retries (quota deaths cost nothing).
        failed += 1;
        console.error(
          `  judge failed ${row.questionId}: ${(e as Error).message}`,
        );
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));

  const byAbility = new Map<string, number[]>();
  for (const r of done.values()) {
    const list = byAbility.get(r.ability) ?? [];
    list.push(r.score);
    byAbility.set(r.ability, list);
  }
  const mean = (xs: number[]): number =>
    xs.reduce((s, x) => s + x, 0) / xs.length;
  const byAbilityTrunc = new Map<string, number[]>();
  for (const r of done.values()) {
    const list = byAbilityTrunc.get(r.ability) ?? [];
    list.push(truncatedScore(r));
    byAbilityTrunc.set(r.ability, list);
  }
  const perAbility = [...byAbility.entries()]
    .map(([ability, xs]) => ({
      ability,
      n: xs.length,
      mean: mean(xs),
      meanTruncated: mean(byAbilityTrunc.get(ability) ?? [0]),
    }))
    .sort((a, b) => a.ability.localeCompare(b.ability));
  const macro = mean(perAbility.map((a) => a.mean));
  const macroTruncated = mean(perAbility.map((a) => a.meanTruncated));
  const summary = {
    report: reportPath,
    judgedN: done.size,
    failed,
    macroAverage: macro,
    /** Comparable to the paper's tables (their truncating aggregation). */
    macroAverageTruncated: macroTruncated,
    perAbility,
  };
  const { promises: fsp } = await import('node:fs');
  await fsp.writeFile(outPath, JSON.stringify(summary, null, 2));
  console.log(
    `${name}: macro=${macro.toFixed(4)} truncated=${macroTruncated.toFixed(4)} ` +
      `(paper SOTA-100K 0.358, truncating code)`,
  );
  for (const a of perAbility) {
    console.log(
      `  ${a.ability}: ${a.mean.toFixed(4)} / trunc ${a.meanTruncated.toFixed(4)} (n=${a.n})`,
    );
  }
  console.log(`→ ${outPath}`);
}

async function main(): Promise<void> {
  const positional = process.argv
    .slice(2)
    .filter((a, i, all) => !a.startsWith('--') && all[i - 1]?.startsWith('--') !== true);
  const [datasetPath, ...reportPaths] = positional;
  if (!datasetPath || reportPaths.length === 0) {
    throw new Error(
      'usage: offline-nugget-score.ts <dataset.json> <report.json...> [--model m] [--concurrency n]',
    );
  }
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is required (paid judge calls)');
  }
  const dataset = JSON.parse(readFileSync(datasetPath, 'utf8')) as BeamConv[];
  const byId = new Map<string, BeamQuestion>();
  for (const conv of dataset) {
    for (const q of conv.questions) byId.set(q.questionId, q);
  }
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const judge = createNuggetJudge(
    client as Parameters<typeof createNuggetJudge>[0],
    arg('model', process.env.LOCOMO_JUDGE_MODEL ?? 'gpt-4.1-mini'),
  );
  const concurrency = parseInt(arg('concurrency', '6'), 10);
  for (const reportPath of reportPaths) {
    await scoreReport(reportPath, byId, judge, concurrency);
  }
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
