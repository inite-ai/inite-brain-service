/**
 * Value-grounding battery for the open extraction vocabulary
 * (src/ai/extractor-internals/value-entailment.ts). Mechanical and free:
 * the local NLI model (the one the app loads, ~340 MB, downloaded once into
 * the transformers cache), no stand, no paid model, no judge.
 *
 * dataset.json holds `[turn, entity, predicate, value]` rows:
 *  - legit: values faithful to the turn, copied or paraphrased the way the
 *    open contract asks ("single" for "not seeing anyone"), in English,
 *    Russian and Portuguese;
 *  - bad: values the turn does not support (a hallucinated figure, a
 *    swapped name, an injected secret).
 * Reported: legit kept, bad rejected, and each miss with its check and label.
 *
 * Run: pnpm eval:value-grounding
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { nliLabels, type NliPipelineParts } from '../../../src/admin/nli-entailment';
import {
  valueCheck,
  valueHypothesis,
  valueStands,
} from '../../../src/ai/extractor-internals/value-entailment';

const MODEL = 'Xenova/mDeBERTa-v3-base-xnli-multilingual-nli-2mil7';

async function main(): Promise<void> {
  const t = (await import('@xenova/transformers')) as unknown as {
    env: { cacheDir?: string };
    pipeline: (task: string, model: string) => Promise<unknown>;
  };
  const cache = process.env.TRANSFORMERS_CACHE ?? process.env.HF_HOME;
  if (cache) t.env.cacheDir = cache;
  const nli = (await t.pipeline('zero-shot-classification', MODEL)) as NliPipelineParts;
  const data = JSON.parse(readFileSync(join(__dirname, 'dataset.json'), 'utf8')) as Record<
    'legit' | 'bad',
    Array<[string, string, string, string]>
  >;
  for (const kind of ['legit', 'bad'] as const) {
    let kept = 0;
    const misses: string[] = [];
    for (const [turn, entityName, predicate, value] of data[kind]) {
      const check = valueCheck(turn, value);
      const [label] =
        check === 'reject'
          ? [undefined]
          : await nliLabels(nli, turn, [valueHypothesis({ entityName, predicate, value })]);
      const stands = valueStands(check, label);
      if (stands) kept++;
      if (stands !== (kind === 'legit')) misses.push(`${predicate}=${value} (${check}/${label})`);
    }
    const n = data[kind].length;
    console.log(kind === 'legit' ? `legit kept    ${kept}/${n}` : `bad rejected  ${n - kept}/${n}`);
    for (const m of misses) console.log(`  miss: ${m}`);
  }
}

void main();
