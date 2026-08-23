import type { CommitInput, Layer1Signals } from './types';
import { parseCommitSignals } from './commit-signals';
import { commitText } from './silver-dataset';

/**
 * Code-memory track C — feature extraction for the trained Layer-1 gate.
 * (docs/code-memory/distillation-dataset.md)
 *
 * SINGLE SOURCE OF TRUTH for features, shared by the trainer and the serving
 * classifier — train-time and serve-time features MUST match. Pure, zero-dep:
 * the whole point of the Layer-1 gate is to run client-side (CI / git hook) with
 * no ML runtime. We use the hashing trick (no stored vocabulary) over token
 * n-grams of the commit text PLUS the deterministic commit signals the heuristic
 * already parses, so the linear student subsumes the heuristic's knowledge.
 */

export interface FeatureConfig {
  /** Hashing space size — MUST be a power of two (bucket = hash & (dim-1)). */
  dim: number;
  /** Max token n-gram length (1 = unigrams, 2 = uni+bigrams). */
  ngram: number;
}

export const DEFAULT_FEATURE_CONFIG: FeatureConfig = { dim: 1 << 15, ngram: 2 };

/** FNV-1a → bucket. Deterministic across runs/processes (no Math.random). */
function hashToken(s: string, dim: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) & (dim - 1);
}

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
}

/** Structured features from the deterministic signals, prefixed with `§` so they
 *  live in the same hashed space as text tokens without colliding with prose. */
function structuredFeatures(signals: Layer1Signals): string[] {
  const f: string[] = [];
  if (signals.conventionalType) f.push(`§type=${signals.conventionalType}`);
  for (const k of Object.keys(signals.trailers)) f.push(`§trailer=${k}`);
  for (const m of signals.rationaleMarkers) f.push(`§rat=${m}`);
  f.push(`§bodybucket=${bodyBucket(signals.bodyLength)}`);
  if (signals.issueRefs.length > 0) f.push('§hasissue');
  return f;
}

function bodyBucket(len: number): string {
  if (len === 0) return '0';
  if (len < 80) return 's';
  if (len < 400) return 'm';
  return 'l';
}

/** Featurize raw text + signals into a sparse {bucket → count} map. */
export function featurize(
  text: string,
  signals: Layer1Signals,
  config: FeatureConfig = DEFAULT_FEATURE_CONFIG,
): Map<number, number> {
  const feats = new Map<number, number>();
  const add = (tok: string) => {
    const idx = hashToken(tok, config.dim);
    feats.set(idx, (feats.get(idx) ?? 0) + 1);
  };
  const tokens = tokenize(text);
  for (const [i, tok] of tokens.entries()) {
    add(tok);
    if (config.ngram >= 2 && i + 1 < tokens.length) {
      add(`${tok} ${tokens[i + 1]}`);
    }
  }
  for (const s of structuredFeatures(signals)) add(s);
  return feats;
}

/** Featurize a commit exactly as the serving gate sees it (message + PR body +
 *  parsed signals) — the bridge used by TrainedDecisionClassifier. */
export function featurizeCommit(
  commit: CommitInput,
  config?: FeatureConfig,
): Map<number, number> {
  return featurize(commitText(commit), parseCommitSignals(commit), config);
}
