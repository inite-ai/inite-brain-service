/**
 * Claim-level check battery (#877): every cited sentence of an answer put to
 * the local NLI model against the facts it cites; a sentence is removed iff
 * the label is `contradiction` (rule fixed before measuring — see
 * dataset.json `_doc`). Local ONNX model, no paid call.
 *
 * Run: pnpm eval:claim-check
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { nliLabels, type NliPipelineParts } from '../../../src/admin/nli-entailment';
import { claimPairs, claimStands, splitAnswer } from '../../../src/synthesize/claim-check';
import { valueCheck } from '../../../src/ai/extractor-internals/value-entailment';

/**
 * Two rules, both fixed before measuring: `nli` removes on a contradiction
 * label alone; `nli+numbers` also removes a sentence whose numbers clash
 * with the cited facts' (the deterministic check #851 applies to extracted
 * values — NLI reads a swapped number or date as neutral).
 */
const RULE = process.argv.includes('--rule=nli+numbers') ? 'nli+numbers' : 'nli';

const MODEL = 'Xenova/mDeBERTa-v3-base-xnli-multilingual-nli-2mil7';

type Gold = 'supported' | 'neutral' | 'contradicted' | 'uncited';
interface Item {
  cat: string;
  lang: string;
  facts: Record<string, string>;
  answer: string;
  gold: Gold[];
}

interface Tally {
  tp: number; // contradicted, removed
  fn: number; // contradicted, kept
  fp: number; // supported/neutral, removed
  tn: number; // supported/neutral, kept
}
const empty = (): Tally => ({ tp: 0, fn: 0, fp: 0, tn: 0 });
const pct = (a: number, b: number) => (b === 0 ? '  n/a' : `${((100 * a) / b).toFixed(1)}%`);

async function main(): Promise<void> {
  const t = (await import('@xenova/transformers')) as unknown as {
    env: { cacheDir?: string };
    pipeline: (task: string, model: string) => Promise<unknown>;
  };
  const cache = process.env.TRANSFORMERS_CACHE ?? process.env.HF_HOME;
  if (cache) t.env.cacheDir = cache;
  const nli = (await t.pipeline('zero-shot-classification', MODEL)) as NliPipelineParts;
  const { items } = JSON.parse(readFileSync(join(__dirname, 'dataset.json'), 'utf8')) as {
    items: Item[];
  };

  const all = empty();
  const byCat = new Map<string, Tally>();
  const byLang = new Map<string, Tally>();
  const misses: string[] = [];
  let pairs = 0;
  let nliMs = 0;
  for (const item of items) {
    const sentences = splitAnswer(item.answer);
    if (sentences.length !== item.gold.length) {
      throw new Error(
        `split gave ${sentences.length} sentences for ${item.gold.length} labels: ${item.answer}`,
      );
    }
    const paired = new Map(claimPairs(sentences, (h) => item.facts[h]).map((p) => [p.sentence, p]));
    for (const [i, sentence] of sentences.entries()) {
      const gold = item.gold[i]!;
      const pair = paired.get(sentence);
      if (gold === 'uncited') {
        if (pair) throw new Error(`gold says uncited but the sentence cites: ${sentence.text}`);
        continue;
      }
      if (!pair) throw new Error(`a cited sentence produced no pair: ${sentence.text}`);
      const started = performance.now();
      const [label] = await nliLabels(nli, pair.premise, [pair.hypothesis]);
      nliMs += performance.now() - started;
      pairs += 1;
      const removed =
        !claimStands(label) ||
        (RULE === 'nli+numbers' && valueCheck(pair.premise, pair.hypothesis) === 'reject');
      const key: keyof Tally =
        gold === 'contradicted' ? (removed ? 'tp' : 'fn') : removed ? 'fp' : 'tn';
      for (const tally of [
        all,
        byCat.get(item.cat) ?? byCat.set(item.cat, empty()).get(item.cat)!,
        byLang.get(item.lang) ?? byLang.set(item.lang, empty()).get(item.lang)!,
      ]) {
        tally[key] += 1;
      }
      if (key === 'fn' || key === 'fp')
        misses.push(`${key} [${item.lang}/${item.cat}] ${label}: ${pair.hypothesis}`);
    }
  }

  const line = (name: string, x: Tally) =>
    `${name.padEnd(14)} contradicted caught ${pct(x.tp, x.tp + x.fn)} (${x.tp}/${x.tp + x.fn})  ` +
    `precision ${pct(x.tp, x.tp + x.fp)}  false removals ${pct(x.fp, x.fp + x.tn)} (${x.fp}/${x.fp + x.tn})`;
  console.log(`rule: ${RULE}`);
  console.log(line('all', all));
  for (const [k, v] of [...byLang].sort()) console.log(line(`lang ${k}`, v));
  for (const [k, v] of [...byCat].sort()) console.log(line(`cat ${k}`, v));
  console.log(`${pairs} NLI pairs, ${(nliMs / Math.max(pairs, 1)).toFixed(0)} ms per pair`);
  for (const m of misses) console.log(`  miss ${m}`);
}

void main();
