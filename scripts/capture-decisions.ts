#!/usr/bin/env tsx
/**
 * Code-memory Phase 1 — hybrid client-side decision capture CLI.
 * (docs/roadmap/code-memory-domain.md)
 *
 *   OPENAI_API_KEY=... BRAIN_API_KEY=... \
 *     pnpm capture:decisions -- \
 *       --range origin/main..HEAD \
 *       --brain-url https://brain.inite.ai \
 *       [--dry-run]            # extract + print, do not POST
 *       [--model gpt-4o-mini]
 *
 * Runs WHERE THE CODE LIVES (CI step / git hook / locally). It reads commit
 * messages + changed file paths from the local git range, gates them through
 * the deterministic Layer-1 classifier, extracts the "why" with your own LLM
 * key (Layer 2), and POSTs ONLY the resulting decision facts (+ file anchors +
 * commit provenance) to brain. Raw source never leaves the machine.
 *
 * Anchors are file-level in Phase 1; symbol-level (SCIP) is Phase 2.
 */
import { readCommits } from '../src/code-memory/capture/git-commits';
import { HeuristicDecisionClassifier } from '../src/code-memory/capture/heuristic-classifier';
import {
  LlmDecisionExtractor,
  makeOpenAiCompleter,
} from '../src/code-memory/capture/llm-extractor';
import { HttpDecisionSink } from '../src/code-memory/capture/http-sink';
import { runCapturePipeline } from '../src/code-memory/capture/capture-pipeline';
import type {
  DecisionCandidate,
  DecisionSink,
} from '../src/code-memory/capture/types';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main(): Promise<void> {
  const range = arg('range', 'origin/main..HEAD')!;
  const brainUrl = arg('brain-url', process.env.BRAIN_URL);
  const model = arg('model', process.env.OPENAI_CHAT_MODEL ?? 'gpt-4o-mini')!;
  const dryRun = process.argv.includes('--dry-run');
  const openAiKey = process.env.OPENAI_API_KEY;
  const brainKey = process.env.BRAIN_API_KEY;

  if (!openAiKey) throw new Error('OPENAI_API_KEY is required');
  if (!dryRun && (!brainUrl || !brainKey)) {
    throw new Error('--brain-url and BRAIN_API_KEY required (or pass --dry-run)');
  }

  const commits = readCommits({ range });
  console.error(`[capture] ${commits.length} commit(s) in ${range}`);

  const extractor = new LlmDecisionExtractor(
    makeOpenAiCompleter({ apiKey: openAiKey, model }),
  );
  const sink: DecisionSink = dryRun
    ? {
        record: (c: DecisionCandidate) => {
          console.log(JSON.stringify(c));
          return Promise.resolve({ outcome: 'DRY_RUN' });
        },
      }
    : new HttpDecisionSink({ baseUrl: brainUrl!, apiKey: brainKey! });

  const summary = await runCapturePipeline({
    commits,
    classifier: new HeuristicDecisionClassifier(),
    extractor,
    sink,
    log: (m) => console.error(`[capture] ${m}`),
  });

  console.error(`[capture] done: ${JSON.stringify(summary)}`);
}

main().catch((e) => {
  console.error(`[capture] fatal: ${(e as Error).message}`);
  process.exit(1);
});
