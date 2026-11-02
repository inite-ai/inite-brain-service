/**
 * Claim-level check battery (#877): every cited sentence of an answer put
 * through checkClaims (src/synthesize/claim-check.ts) — the code synthesis
 * serves with — against the facts it cites, rendered as synthesis renders
 * them. Rule fixed before measuring (see the module note and dataset.json
 * `_doc`). Local ONNX model, no paid call.
 *
 * Run: pnpm eval:claim-check
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { nliLabels, type NliPipelineParts } from '../../../src/admin/nli-entailment';
import { checkClaims, type CitedFact, type NliPort } from '../../../src/synthesize/claim-check';

const MODEL = 'Xenova/mDeBERTa-v3-base-xnli-multilingual-nli-2mil7';

type Gold = 'supported' | 'neutral' | 'contradicted' | 'uncited';
interface Item {
  cat: string;
  lang: string;
  facts: Record<string, { name: string; predicate: string; object: string }>;
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
  const port: NliPort = async (premise, hypotheses) => {
    const started = performance.now();
    const labels = await nliLabels(nli, premise, hypotheses);
    nliMs += performance.now() - started;
    pairs += hypotheses.length;
    return labels;
  };
  for (const item of items) {
    const factOf = (t: string): CitedFact | undefined => {
      const f = item.facts[t];
      return f && { canonicalName: f.name, predicate: f.predicate, object: f.object };
    };
    const { sentences, removed } = await checkClaims(item.answer, factOf, port);
    if (sentences.length !== item.gold.length) {
      throw new Error(
        `split gave ${sentences.length} sentences for ${item.gold.length} labels: ${item.answer}`,
      );
    }
    const removedTexts = new Set(removed.map((s) => s.text));
    for (const [i, sentence] of sentences.entries()) {
      const gold = item.gold[i]!;
      if (gold === 'uncited') {
        if (sentence.handles.length > 0) {
          throw new Error(`gold says uncited but the sentence cites: ${sentence.text}`);
        }
        continue;
      }
      const isRemoved = removedTexts.has(sentence.text);
      const key: keyof Tally =
        gold === 'contradicted' ? (isRemoved ? 'tp' : 'fn') : isRemoved ? 'fp' : 'tn';
      for (const tally of [
        all,
        byCat.get(item.cat) ?? byCat.set(item.cat, empty()).get(item.cat)!,
        byLang.get(item.lang) ?? byLang.set(item.lang, empty()).get(item.lang)!,
      ]) {
        tally[key] += 1;
      }
      if (key === 'fn' || key === 'fp')
        misses.push(`${key} [${item.lang}/${item.cat}]: ${sentence.claim}`);
    }
  }

  const line = (name: string, x: Tally) =>
    `${name.padEnd(14)} contradicted caught ${pct(x.tp, x.tp + x.fn)} (${x.tp}/${x.tp + x.fn})  ` +
    `precision ${pct(x.tp, x.tp + x.fp)}  false removals ${pct(x.fp, x.fp + x.tn)} (${x.fp}/${x.fp + x.tn})`;
  console.log(line('all', all));
  for (const [k, v] of [...byLang].sort()) console.log(line(`lang ${k}`, v));
  for (const [k, v] of [...byCat].sort()) console.log(line(`cat ${k}`, v));
  console.log(`${pairs} NLI pairs, ${(nliMs / Math.max(pairs, 1)).toFixed(0)} ms per pair`);
  for (const m of misses) console.log(`  miss ${m}`);
}

void main();
