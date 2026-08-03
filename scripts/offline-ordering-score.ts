/**
 * Offline tau_norm scoring of event_ordering predictions already saved in
 * BEAM report JSONs — re-scores without re-running QA.
 *
 * Usage:
 *   OPENAI_API_KEY=... npx ts-node -r tsconfig-paths/register \
 *     scripts/offline-ordering-score.ts /tmp/beam_100k.json \
 *     var/beam-100k-b0-0803.json var/beam-100k-b1-0803.json
 */
import { readFileSync } from 'node:fs';
import OpenAI from 'openai';
import { createNuggetJudge } from '../test/eval/beam/nugget-judge';

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
  prediction: string;
}

async function main() {
  const [datasetPath, ...reportPaths] = process.argv.slice(2);
  if (!datasetPath || reportPaths.length === 0) {
    throw new Error('usage: offline-ordering-score.ts <dataset> <report...>');
  }
  const dataset = JSON.parse(readFileSync(datasetPath, 'utf8')) as BeamConv[];
  const rubricById = new Map<string, string[]>();
  for (const conv of dataset) {
    for (const q of conv.questions) {
      if (q.ability === 'event_ordering') rubricById.set(q.questionId, q.rubric);
    }
  }
  const judge = createNuggetJudge(
    new OpenAI({ apiKey: process.env.OPENAI_API_KEY }),
    process.env.LOCOMO_JUDGE_MODEL ?? 'gpt-4.1-mini',
  );

  for (const reportPath of reportPaths) {
    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as {
      scores: ReportScore[];
    };
    const rows = report.scores.filter((s) => s.group === 'event_ordering');
    const results: { questionId: string; tauNorm: number; f1: number }[] = [];
    const queue = [...rows];
    const workers = Array.from({ length: 8 }, async () => {
      for (;;) {
        const row = queue.shift();
        if (!row) return;
        const rubric = rubricById.get(row.questionId);
        if (!rubric?.length) continue;
        try {
          const score = await judge.orderingScore({
            rubric,
            prediction: row.prediction ?? '',
          });
          results.push({
            questionId: row.questionId,
            tauNorm: score.tauNorm,
            f1: score.f1,
          });
        } catch (e) {
          console.error(`  ${row.questionId} ERROR: ${(e as Error).message}`);
        }
      }
    });
    await Promise.all(workers);
    const avg = (xs: number[]) =>
      xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
    console.log(
      `${reportPath}: n=${results.length} ` +
        `tau_norm=${avg(results.map((r) => r.tauNorm)).toFixed(4)} ` +
        `F1=${avg(results.map((r) => r.f1)).toFixed(4)}`,
    );
    for (const r of results.sort((a, b) => a.questionId.localeCompare(b.questionId))) {
      console.log(`  ${r.questionId} tau_norm=${r.tauNorm.toFixed(3)} f1=${r.f1.toFixed(3)}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
