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
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readCommits } from '../src/code-memory/capture/git-commits';
import { makeSymbolAnchorRefiner } from '../src/code-memory/anchor/refine';
import { HeuristicDecisionClassifier } from '../src/code-memory/capture/heuristic-classifier';
import { TrainedDecisionClassifier } from '../src/code-memory/capture/gate-classifier';
import { HybridDecisionClassifier } from '../src/code-memory/capture/hybrid-classifier';
import {
  LlmDecisionExtractor,
  makeOpenAiCompleter,
} from '../src/code-memory/capture/llm-extractor';
import { LlmDecisionVerifier } from '../src/code-memory/capture/llm-verifier';
import type { DecisionClassifier } from '../src/code-memory/capture/types';
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

/** The batteries-included default gate model shipped in the repo. */
const DEFAULT_GATE_MODEL = join(__dirname, '..', 'models', 'decision-gate.model.json');

function selectGate(): { classifier: DecisionClassifier; gateLabel: string } {
  const heuristic = new HeuristicDecisionClassifier();
  if (process.argv.includes('--heuristic')) {
    return { classifier: heuristic, gateLabel: 'heuristic (forced)' };
  }
  const modelPath =
    arg('gate-model') ??
    (existsSync(DEFAULT_GATE_MODEL) ? DEFAULT_GATE_MODEL : undefined);
  if (!modelPath) {
    return { classifier: heuristic, gateLabel: 'heuristic (no model)' };
  }
  const model = TrainedDecisionClassifier.fromJson(
    JSON.parse(readFileSync(modelPath, 'utf8')),
  );
  if (process.argv.includes('--trained-only')) {
    return { classifier: model, gateLabel: `trained-only (${modelPath})` };
  }
  return {
    classifier: new HybridDecisionClassifier(heuristic, model),
    gateLabel: `hybrid heuristic+model (${modelPath})`,
  };
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

  // Layer-1 gate. Default = HYBRID (heuristic OR the shipped trained model) — it
  // beats either alone on the golden. Flags: --gate-model <path> swaps the model,
  // --trained-only drops the heuristic, --heuristic forces heuristic-only.
  const { classifier, gateLabel } = selectGate();
  console.error(`[capture] Layer-1 gate: ${gateLabel}`);

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

  // Phase 2: ground LLM-proposed symbols against the local working tree and
  // upgrade file anchors to drift-resistant symbol anchors (client-side).
  const refineAnchor = makeSymbolAnchorRefiner({
    readFile: (p) => {
      try {
        return readFileSync(join(process.cwd(), p), 'utf8');
      } catch {
        return null;
      }
    },
  });

  // --verify adds a strict LLM-judge pass that filters over-labeled candidates
  // before they're recorded (raises precision at the cost of one call/commit).
  const verify = process.argv.includes('--verify');
  const summary = await runCapturePipeline({
    commits,
    classifier,
    extractor,
    ...(verify
      ? {
          verifier: new LlmDecisionVerifier(
            makeOpenAiCompleter({ apiKey: openAiKey, model }),
          ),
        }
      : {}),
    sink,
    refineAnchor,
    log: (m) => console.error(`[capture] ${m}`),
  });
  if (verify) console.error(`[capture] verification ON (judge=${model})`);

  console.error(`[capture] done: ${JSON.stringify(summary)}`);
}

main().catch((e) => {
  console.error(`[capture] fatal: ${(e as Error).message}`);
  process.exit(1);
});
