#!/usr/bin/env tsx
/**
 * Code-memory track C — train the Layer-1 decision gate.
 * (docs/code-memory/distillation-dataset.md)
 *
 *   pnpm train:decision-gate -- \
 *     --data data/code-memory/silver-decisions.jsonl \
 *     --out  data/code-memory/decision-gate.model.json \
 *     [--epochs 25] [--lr 0.1] [--l2 0.0001] [--threshold 0.5] \
 *     [--holdout 0.2] [--seed 42]
 *
 * Reads the silver JSONL produced by `pnpm label:decisions`, trains a logistic-
 * regression student, reports model-vs-heuristic metrics on a held-out split
 * (the payoff — does the trained gate beat the heuristic against the teacher
 * label?), and writes the portable model artifact for TrainedDecisionClassifier.
 * Fully offline: no LLM, no network.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { featurize } from '../src/code-memory/capture/gate-features';
import { evaluateGate } from '../src/code-memory/capture/gate-classifier';
import { trainGate } from '../src/code-memory/capture/gate-train';
import {
  evaluateHeuristicOnGolden,
  evaluateModelOnGolden,
} from '../src/code-memory/capture/gate-golden';
import type { SilverExample } from '../src/code-memory/capture/silver-dataset';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/** Deterministic holdout: bucket by an FNV hash of the sha, no shuffle needed. */
function inHoldout(sha: string, fraction: number, seed: number): boolean {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < sha.length; i++) {
    h ^= sha.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 1000 < fraction * 1000;
}

function prf(preds: number[], labels: number[]): {
  n: number;
  accuracy: number;
  precision: number;
  recall: number;
  f1: number;
} {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let correct = 0;
  for (let i = 0; i < labels.length; i++) {
    if (preds[i] === labels[i]) correct += 1;
    if (preds[i] === 1 && labels[i] === 1) tp += 1;
    else if (preds[i] === 1 && labels[i] === 0) fp += 1;
    else if (preds[i] === 0 && labels[i] === 1) fn += 1;
  }
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 =
    precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return {
    n: labels.length,
    accuracy: labels.length ? correct / labels.length : 0,
    precision,
    recall,
    f1,
  };
}

/** Shrink a model in place: drop tiny weights, round the rest. */
function compactModel(
  model: { bias: number; weights: Record<string, number>; kinds?: Record<string, { bias: number; weights: Record<string, number> }> },
  prune: number,
  round: number,
): void {
  const factor = round > 0 ? 10 ** round : 0;
  const shrink = (w: Record<string, number>) => {
    for (const k of Object.keys(w)) {
      if (prune > 0 && Math.abs(w[k]) < prune) delete w[k];
      else if (factor) w[k] = Math.round(w[k] * factor) / factor;
    }
  };
  shrink(model.weights);
  for (const head of Object.values(model.kinds ?? {})) shrink(head.weights);
}

function fmt(m: { accuracy: number; precision: number; recall: number; f1: number }): string {
  const p = (x: number) => (x * 100).toFixed(1);
  return `acc ${p(m.accuracy)}  P ${p(m.precision)}  R ${p(m.recall)}  F1 ${p(m.f1)}`;
}

function main(): void {
  const dataPath = arg('data', 'data/code-memory/silver-decisions.jsonl')!;
  const outPath = arg('out', 'data/code-memory/decision-gate.model.json')!;
  const epochs = parseInt(arg('epochs', '25')!, 10);
  const learningRate = parseFloat(arg('lr', '0.1')!);
  const l2 = parseFloat(arg('l2', '0.0001')!);
  const threshold = parseFloat(arg('threshold', '0.5')!);
  const holdout = parseFloat(arg('holdout', '0.2')!);
  const seed = parseInt(arg('seed', '42')!, 10);
  // Shrink the artifact for shipping: drop |w| below --prune and round the rest
  // to --round decimals. Tiny effect on a gate; large effect on file size.
  const prune = parseFloat(arg('prune', '0')!);
  const round = parseInt(arg('round', '0')!, 10);
  // Drop teacher positives below this confidence to a negative label — the
  // cheap precision knob against an over-lenient teacher (see the docs). 0 =
  // trust every teacher positive (the raw silver label).
  const minConfidence = parseFloat(arg('min-confidence', '0')!);

  const raw: SilverExample[] = readFileSync(dataPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as SilverExample);
  if (raw.length === 0) throw new Error(`no rows in ${dataPath}`);
  // Re-threshold the label offline (no re-labeling spend) using persisted
  // maxConfidence. A positive with confidence below the gate becomes negative.
  const rows: SilverExample[] = raw.map((r) =>
    r.label === 1 && minConfidence > 0 && (r.maxConfidence ?? 1) < minConfidence
      ? { ...r, label: 0 }
      : r,
  );
  if (minConfidence > 0) {
    const flipped = rows.filter((r, i) => r.label !== raw[i].label).length;
    console.error(
      `[train] min-confidence ${minConfidence}: flipped ${flipped} weak positive(s) → negative`,
    );
  }

  const train = rows.filter((r) => !inHoldout(r.sha, holdout, seed));
  const test = rows.filter((r) => inHoldout(r.sha, holdout, seed));
  const pos = rows.filter((r) => r.label === 1).length;
  console.error(
    `[train] ${rows.length} rows (${pos} pos / ${rows.length - pos} neg) → train ${train.length} / holdout ${test.length}`,
  );
  if (train.length === 0 || test.length === 0) {
    throw new Error('empty train or holdout split — need more data or a smaller --holdout');
  }

  const model = trainGate(
    train.map((r) => ({
      text: r.text,
      signals: r.signals,
      label: r.label,
      kinds: r.kinds,
    })),
    { epochs, learningRate, l2, threshold, seed },
  );
  if (model.kinds) {
    console.error(
      `[train] multi-label heads: ${Object.keys(model.kinds).join(', ')}`,
    );
  }

  const testFeats = test.map((r) => ({
    feats: featurize(r.text, r.signals, model.config),
    label: r.label,
  }));
  const modelMetrics = evaluateGate(model, testFeats);
  const heurMetrics = prf(
    test.map((r) => (r.heuristic.likelyDecision ? 1 : 0)),
    test.map((r) => r.label),
  );

  console.error(`[train] holdout heuristic: ${fmt(heurMetrics)}`);
  console.error(`[train] holdout model:     ${fmt(modelMetrics)}`);
  console.error(
    `[train] model F1 − heuristic F1 = ${((modelMetrics.f1 - heurMetrics.f1) * 100).toFixed(1)} pts`,
  );

  // Independent check against the frozen, hand-labeled golden (human truth) —
  // the shipping quality bar, unaffected by teacher-label noise in the corpus.
  const goldenModel = evaluateModelOnGolden(model);
  const goldenHeur = evaluateHeuristicOnGolden();
  console.error(`[train] golden heuristic:  ${fmt(goldenHeur)}`);
  console.error(`[train] golden model:      ${fmt(goldenModel)}`);

  // The gate only needs the binary head; --binary-only strips the (larger)
  // per-kind heads so a shipped default model stays small. Kinds stay a
  // trainable capability (omit the flag to keep them).
  if (process.argv.includes('--binary-only')) {
    delete model.kinds;
    delete model.kindThreshold;
    model.version = 1;
  }
  if (prune > 0 || round > 0) compactModel(model, prune, round);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(model)}\n`);
  const size = Object.keys(model.weights).length;
  console.error(`[train] wrote ${outPath} (${size} non-zero binary weights)`);
}

try {
  main();
} catch (e) {
  console.error(`[train] fatal: ${(e as Error).message}`);
  process.exit(1);
}
