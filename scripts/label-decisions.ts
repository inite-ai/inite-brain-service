#!/usr/bin/env tsx
/**
 * Code-memory track C — SILVER dataset builder CLI.
 * (docs/code-memory/distillation-dataset.md)
 *
 *   OPENAI_API_KEY=... pnpm label:decisions -- \
 *     --range origin/main~2000..HEAD \
 *     --out data/code-memory/silver-decisions.jsonl \
 *     [--model gpt-4o-mini] [--limit 500] [--concurrency 6]
 *
 * Runs the Layer-2 LLM extractor (the TEACHER) over a git range and writes one
 * JSONL silver-labeled row per non-merge commit: the classifier input text
 * (message + PR body), the teacher's binary label + kinds, the deterministic
 * signals, and the current heuristic verdict (for heuristic-vs-teacher analysis).
 * Feed the JSONL to a cheap student (BiLSTM / DistilBERT) that then drops into
 * the DecisionClassifier seam. Client-side: only your own LLM key is used; no
 * data leaves for anywhere but your LLM provider.
 */
import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { readCommits } from '../src/code-memory/capture/git-commits';
import { HeuristicDecisionClassifier } from '../src/code-memory/capture/heuristic-classifier';
import {
  LlmDecisionExtractor,
  makeOpenAiCompleter,
} from '../src/code-memory/capture/llm-extractor';
import { LlmDecisionVerifier } from '../src/code-memory/capture/llm-verifier';
import { labelCommits } from '../src/code-memory/capture/silver-dataset';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main(): Promise<void> {
  const range = arg('range', 'origin/main..HEAD')!;
  const out = arg('out', 'data/code-memory/silver-decisions.jsonl')!;
  const model = arg('model', process.env.OPENAI_CHAT_MODEL ?? 'gpt-4o-mini')!;
  const limit = arg('limit') ? parseInt(arg('limit')!, 10) : undefined;
  const concurrency = parseInt(arg('concurrency', '4')!, 10);
  const openAiKey = process.env.OPENAI_API_KEY;
  if (!openAiKey) throw new Error('OPENAI_API_KEY is required');

  let commits = readCommits({ range });
  if (limit && limit > 0) commits = commits.slice(0, limit);
  console.error(
    `[label] ${commits.length} commit(s) in ${range} → ${out} (teacher=${model}, concurrency=${concurrency})`,
  );

  mkdirSync(dirname(out), { recursive: true });
  const stream = createWriteStream(out, { flags: 'w' });

  // --verify adds a strict LLM-judge pass (a stronger teacher — raises
  // precision against the extractor's over-labeling). --verify-model overrides.
  const verify = process.argv.includes('--verify');
  const verifyModel = arg('verify-model', model)!;
  const summary = await labelCommits({
    commits,
    extractor: new LlmDecisionExtractor(
      makeOpenAiCompleter({ apiKey: openAiKey, model }),
    ),
    classifier: new HeuristicDecisionClassifier(),
    ...(verify
      ? {
          verifier: new LlmDecisionVerifier(
            makeOpenAiCompleter({ apiKey: openAiKey, model: verifyModel }),
          ),
        }
      : {}),
    emit: (ex) => stream.write(`${JSON.stringify(ex)}\n`),
    concurrency,
    log: (m) => console.error(`[label] ${m}`),
  });
  if (verify) console.error(`[label] verification ON (judge=${verifyModel})`);

  await new Promise<void>((resolve, reject) => {
    stream.end((err?: Error | null) => (err ? reject(err) : resolve()));
  });
  console.error(`[label] done: ${JSON.stringify(summary)}`);
  // Surface the payoff up front: how much a trained gate could beat the heuristic.
  const { heuristicFalseNeg, heuristicFalsePos, labeled } = summary;
  if (labeled > 0) {
    console.error(
      `[label] heuristic vs teacher: ${heuristicFalseNeg} false-neg (missed "why"), ` +
        `${heuristicFalsePos} false-pos (wasted LLM calls) of ${labeled} labeled`,
    );
  }
}

main().catch((e) => {
  console.error(`[label] fatal: ${(e as Error).message}`);
  process.exit(1);
});
