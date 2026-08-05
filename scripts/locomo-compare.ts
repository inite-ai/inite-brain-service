/**
 * Compare LoCoMo reports side by side — headline, per-category, per-conversation,
 * and the DEAD-ANSWER count that a rate-limited run hides behind a plausible
 * number.
 *
 *   npx ts-node scripts/locomo-compare.ts var/a.json var/b.json [...]
 *
 * Why this exists as a script rather than a shell one-liner: every comparison in
 * this program has been made from the same four numbers, and re-deriving them by
 * hand each time is how a run gets read wrong. Category-5 (adversarial) is
 * excluded from the headline exactly as the harness does, so the numbers here
 * are directly comparable to the report's own `overall.judgeAccuracy`.
 */
import * as fs from 'node:fs';
import { LOCOMO_CATEGORY_NAMES } from '../test/eval/locomo/types';

const CATEGORY_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(LOCOMO_CATEGORY_NAMES).filter(([cat]) => cat !== '5'),
);

interface Score {
  sampleId: string;
  category: number;
  prediction?: string;
  judgeCorrect?: boolean;
}

interface Summary {
  file: string;
  n: number;
  dead: number;
  headline: number;
  perCategory: Record<string, string>;
  perSample: Record<string, string>;
}

function pct(scores: Score[]): number {
  if (scores.length === 0) return 0;
  const correct = scores.filter((s) => s.judgeCorrect).length;
  return (100 * correct) / scores.length;
}

/**
 * A dead answer is an empty or error prediction. It scores as WRONG, so a run
 * with many of them reports a real-looking number that is really an outage —
 * the 0.5% "result" that turned out to be an exhausted OpenAI quota.
 */
function isDead(s: Score): boolean {
  return !s.prediction || /^\[error/i.test(s.prediction);
}

function summarize(file: string): Summary {
  const report = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    scores?: Score[];
  };
  const scores = (report.scores ?? []).filter((s) => s.category !== 5);
  const perCategory: Record<string, string> = {};
  for (const [cat, name] of Object.entries(CATEGORY_NAMES)) {
    const slice = scores.filter((s) => s.category === Number(cat));
    perCategory[name] = `${pct(slice).toFixed(1)} (n=${slice.length})`;
  }
  const bySample = new Map<string, Score[]>();
  for (const s of scores) {
    const arr = bySample.get(s.sampleId) ?? [];
    arr.push(s);
    bySample.set(s.sampleId, arr);
  }
  const perSample: Record<string, string> = {};
  for (const [id, arr] of [...bySample].sort()) {
    perSample[id] = pct(arr).toFixed(1);
  }
  return {
    file,
    n: scores.length,
    dead: scores.filter(isDead).length,
    headline: pct(scores),
    perCategory,
    perSample,
  };
}

function main(): void {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error('usage: locomo-compare.ts <report.json> [report.json ...]');
    process.exit(1);
  }
  const summaries = files.map(summarize);
  const base = summaries[0];

  for (const s of summaries) {
    const delta =
      s === base ? '' : ` (${(s.headline - base.headline >= 0 ? '+' : '')}${(s.headline - base.headline).toFixed(1)}pp vs ${base.file})`;
    console.log(
      `\n${s.file}  headline ${s.headline.toFixed(1)}%  n=${s.n}  dead=${s.dead}${delta}`,
    );
    console.log(
      '  ' +
        Object.entries(s.perCategory)
          .map(([k, v]) => `${k} ${v}`)
          .join('  |  '),
    );
    console.log(
      '  per-conv: ' +
        Object.entries(s.perSample)
          .map(([k, v]) => `${k} ${v}`)
          .join('  '),
    );
    if (s.dead > s.n * 0.02) {
      console.log(
        `  ⚠️  ${s.dead}/${s.n} answers are empty or errored — that is ${((100 * s.dead) / s.n).toFixed(1)}% scored as WRONG. Check for rate limiting before trusting this number.`,
      );
    }
  }
}

main();
