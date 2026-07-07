import type { CommitInput, DecisionKind } from './types';
import { parseCommitSignals } from './commit-signals';
import { commitText } from './silver-dataset';
import { HeuristicDecisionClassifier } from './heuristic-classifier';
import { featurize } from './gate-features';
import { predictProba, type GateModel } from './gate-classifier';

/**
 * Code-memory track C — a FROZEN, hand-labeled golden eval set for the Layer-1
 * gate. (docs/code-memory/distillation-dataset.md)
 *
 * The silver labels are teacher-derived (noisy); this is human truth, so it's a
 * stable regression guard: a shipped/trained gate model is asserted to beat the
 * heuristic here. Deliberately mixes genuine "why" commits (decision / rationale
 * / invariant / gotcha, several with the reason in the SUBJECT only — which the
 * body-scanning heuristic misses) with what-only noise (`label:0`). Edit with
 * care: this is the contract the gate is measured against.
 */

export interface GoldenCase {
  message: string;
  label: 0 | 1;
  kinds: DecisionKind[];
}

export const GATE_GOLDEN: GoldenCase[] = [
  // ── decision-bearing (label 1) ─────────────────────────────────────────
  {
    message:
      'refactor(auth): funnel token checks through one guard\n\nThe checks had drifted between three middlewares and disagreed on expiry; one gateway keeps them consistent.',
    label: 1,
    kinds: ['decided', 'because'],
  },
  {
    message:
      'fix(di): export the new @Injectable from the @Global module\n\nInvariant: anything constructed by a @Global provider must be listed in exports or e2e DI boot fails.',
    label: 1,
    kinds: ['invariant'],
  },
  {
    message:
      'test: filter with --testPathPattern= (equals form)\n\nGotcha: `pnpm test -- --testPathPattern x` swallows the flag via the double dash; only the = form filters.',
    label: 1,
    kinds: ['gotcha'],
  },
  {
    message:
      'perf: cache the predicate snapshot for 60s\n\nReloading per request added a cold-start round-trip; a short TTL cuts it without real staleness risk.',
    label: 1,
    kinds: ['decided', 'because'],
  },
  {
    message:
      'feat(packs): sign manifests with ed25519\n\nChose ed25519 over RSA: no extra dependency and far smaller signatures.',
    label: 1,
    kinds: ['decided', 'because'],
  },
  {
    message:
      'revert: back out the async write cache\n\nIt introduced a race that dropped writes under load; reverting until we add a lock.',
    label: 1,
    kinds: ['because'],
  },
  {
    message:
      'fix(surreal): omit null on option<> fields\n\nGotcha: SCHEMAFULL rejects a JS null for option<string> with "Found NULL"; emit NONE or omit the field.',
    label: 1,
    kinds: ['gotcha'],
  },
  {
    message:
      'feat: resolve facts through a single gateway\n\nDecided to centralize conflict resolution so the bitemporal rules live in exactly one place.',
    label: 1,
    kinds: ['decided'],
  },
  {
    message:
      'docs: note that migrations must be idempotent\n\nInvariant: every migration uses IF NOT EXISTS so a re-run is a no-op.',
    label: 1,
    kinds: ['invariant'],
  },
  {
    message:
      'refactor: make the registry snapshot TTL-cached\n\nChose a 60s TTL to bound staleness while amortizing the load across requests.',
    label: 1,
    kinds: ['decided', 'because'],
  },
  {
    message:
      'feat: keep the distributable pack out of the builtin seed\n\nDecided to install real-estate per tenant so its predicates do not seed into unrelated tenants.',
    label: 1,
    kinds: ['decided', 'because'],
  },
  // reason in the SUBJECT only — the body-scanning heuristic tends to miss these
  {
    message:
      'fix: acquire the pool lock before migrating because concurrent boots race the schema',
    label: 1,
    kinds: ['because', 'invariant'],
  },
  {
    message:
      'chore: pin the docker digest — a floating tag silently changed the base image',
    label: 1,
    kinds: ['gotcha', 'because'],
  },
  {
    message:
      'refactor: split the god-class into phase services because 21 positional args drifted between call-sites',
    label: 1,
    kinds: ['decided', 'because'],
  },
  {
    message:
      'fix: always redact PII before the extractor call — raw bodies must never reach the LLM log',
    label: 1,
    kinds: ['invariant'],
  },
  {
    message:
      'perf: memoize the embedder to avoid N sequential round-trips on cold tenants',
    label: 1,
    kinds: ['decided', 'because'],
  },
  {
    message:
      'perf: batch predicate embeds into one call instead of per-row to kill the fresh-tenant tax',
    label: 1,
    kinds: ['decided', 'because'],
  },
  {
    message:
      'ci: disable throttling in e2e — the FANOUT suites trip the 10/min expensive cap and 429',
    label: 1,
    kinds: ['gotcha', 'because'],
  },
  {
    message:
      'fix: dedupe in-flight bootstrap per tenant to prevent duplicate predicate rows under concurrent cold reads',
    label: 1,
    kinds: ['because'],
  },
  {
    message:
      'fix: clamp LLM input so a huge mention cannot blow the token budget or stall the queue',
    label: 1,
    kinds: ['because'],
  },
  // ── what-only noise (label 0) ──────────────────────────────────────────
  { message: 'chore: bump deps', label: 0, kinds: [] },
  { message: 'style: run prettier', label: 0, kinds: [] },
  { message: 'docs: fix typo in README', label: 0, kinds: [] },
  { message: 'ci: update workflow file', label: 0, kinds: [] },
  { message: 'build: bump version to 1.2.3', label: 0, kinds: [] },
  { message: 'test: add a missing semicolon', label: 0, kinds: [] },
  { message: 'chore: update lockfile', label: 0, kinds: [] },
  { message: 'refactor: rename variable foo to bar', label: 0, kinds: [] },
  { message: 'feat: add a user settings endpoint', label: 0, kinds: [] },
  { message: 'fix: correct spelling in a comment', label: 0, kinds: [] },
  { message: 'chore(release): 2.0.0', label: 0, kinds: [] },
  { message: 'docs: update the changelog', label: 0, kinds: [] },
  { message: 'style: reformat imports', label: 0, kinds: [] },
  { message: 'feat: add a GET /health route', label: 0, kinds: [] },
  { message: 'test: increase coverage for utils', label: 0, kinds: [] },
  { message: 'chore: remove an unused import', label: 0, kinds: [] },
  { message: 'refactor: extract a helper function', label: 0, kinds: [] },
  { message: 'fix: update snapshot tests', label: 0, kinds: [] },
  { message: 'build: add a tsconfig path alias', label: 0, kinds: [] },
  { message: 'feat: wire up the new button', label: 0, kinds: [] },
];

export interface GateEvalMetrics {
  n: number;
  accuracy: number;
  precision: number;
  recall: number;
  f1: number;
}

/** Golden case → a synthetic CommitInput (the gate only reads message text). */
export function goldenCommit(c: GoldenCase): CommitInput {
  return {
    sha: 'golden',
    message: c.message,
    changedFiles: ['src/x.ts'],
    authorDate: '2026-07-07T00:00:00Z',
  };
}

function prf(preds: number[], labels: number[]): GateEvalMetrics {
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

/** Score a trained model against the golden set. */
export function evaluateModelOnGolden(
  model: GateModel,
  golden: GoldenCase[] = GATE_GOLDEN,
): GateEvalMetrics {
  const preds = golden.map((c) =>
    predictProba(
      model,
      featurize(commitText(goldenCommit(c)), parseCommitSignals(goldenCommit(c)), model.config),
    ) >= model.threshold
      ? 1
      : 0,
  );
  return prf(preds, golden.map((c) => c.label));
}

/** Score the deterministic heuristic against the golden set (the baseline). */
export function evaluateHeuristicOnGolden(
  golden: GoldenCase[] = GATE_GOLDEN,
): GateEvalMetrics {
  const h = new HeuristicDecisionClassifier();
  const preds = golden.map((c) =>
    h.classify(goldenCommit(c)).likelyDecision ? 1 : 0,
  );
  return prf(preds, golden.map((c) => c.label));
}
