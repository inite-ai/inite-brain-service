/**
 * Scoring metrics for the LoCoMo benchmark.
 *
 * Matches the upstream paper's evaluation: token-level F1, ROUGE-L,
 * BLEU-1, plus per-category breakdowns. We add an explicit
 * `adversarialRefusal` score because category-5 questions expect the
 * model to refuse — F1 against a non-empty gold like "no information
 * available" doesn't capture refusal quality cleanly.
 *
 * Pure functions, no external dependencies. BERTScore is intentionally
 * NOT here — adds a 400MB BERT-base download + ~30 min CI time for a
 * metric the paper itself only reports as supplementary. The runner
 * exposes a stable surface that a downstream consumer can wire to
 * BERTScore if they want it.
 */

/** Normalize a string for token-level comparison. */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\s\n\r\t]+/g, ' ')
    .replace(/[.,/#!$%^&*;:{}=_`~()?"'-]/g, '')
    .trim();
}

export function tokenize(s: string): string[] {
  const norm = normalize(s);
  return norm.length === 0 ? [] : norm.split(' ');
}

/**
 * Token-level F1 (SQuAD convention).
 * F1 = 2 · precision · recall / (precision + recall) over the
 * multiset intersection of prediction and gold tokens.
 */
export function tokenF1(prediction: string, gold: string): number {
  const predTokens = tokenize(prediction);
  const goldTokens = tokenize(gold);
  if (predTokens.length === 0 && goldTokens.length === 0) return 1;
  if (predTokens.length === 0 || goldTokens.length === 0) return 0;
  const predCounts = countTokens(predTokens);
  const goldCounts = countTokens(goldTokens);
  let common = 0;
  for (const [tok, count] of predCounts.entries()) {
    common += Math.min(count, goldCounts.get(tok) ?? 0);
  }
  if (common === 0) return 0;
  const precision = common / predTokens.length;
  const recall = common / goldTokens.length;
  return (2 * precision * recall) / (precision + recall);
}

/** Exact-match after normalization. */
export function exactMatch(prediction: string, gold: string): number {
  return normalize(prediction) === normalize(gold) ? 1 : 0;
}

/** ROUGE-L (longest common subsequence) F1. */
export function rougeL(prediction: string, gold: string): number {
  const predTokens = tokenize(prediction);
  const goldTokens = tokenize(gold);
  if (predTokens.length === 0 && goldTokens.length === 0) return 1;
  if (predTokens.length === 0 || goldTokens.length === 0) return 0;
  const lcs = lcsLength(predTokens, goldTokens);
  if (lcs === 0) return 0;
  const precision = lcs / predTokens.length;
  const recall = lcs / goldTokens.length;
  return (2 * precision * recall) / (precision + recall);
}

/** BLEU-1 — unigram precision with brevity penalty. */
export function bleu1(prediction: string, gold: string): number {
  const predTokens = tokenize(prediction);
  const goldTokens = tokenize(gold);
  if (predTokens.length === 0 || goldTokens.length === 0) return 0;
  const goldCounts = countTokens(goldTokens);
  const clipped = new Map<string, number>();
  for (const tok of predTokens) {
    const used = clipped.get(tok) ?? 0;
    const avail = (goldCounts.get(tok) ?? 0) - used;
    if (avail > 0) clipped.set(tok, used + 1);
  }
  let matches = 0;
  for (const c of clipped.values()) matches += c;
  const precision = matches / predTokens.length;
  // Brevity penalty
  const bp =
    predTokens.length > goldTokens.length ? 1 : Math.exp(1 - goldTokens.length / predTokens.length);
  return bp * precision;
}

/**
 * Adversarial refusal detection. Category-5 questions in LoCoMo
 * have a gold answer that explicitly disclaims knowledge ("no
 * information available", "the conversation does not mention …",
 * etc). The agent passes when it produces a similarly-shaped refusal,
 * fails when it confabulates a specific answer.
 *
 * Heuristic: prediction is a refusal if it normalizes to contain one
 * of a fixed set of disclaimer phrases. This is intentionally coarse —
 * a tighter signal would need an LLM judge, which we keep out of the
 * core metric path to keep the scorer deterministic.
 */
const REFUSAL_PATTERNS = [
  'no information',
  'not mentioned',
  'not stated',
  'cannot be answered',
  'unknown',
  'i dont know',
  'i do not know',
  'no mention',
  'no specific',
  'not enough information',
  'does not mention',
  'does not say',
  'not specified',
  'not provided',
  'not discussed',
];

export function isRefusal(text: string): boolean {
  const norm = normalize(text);
  return REFUSAL_PATTERNS.some((p) => norm.includes(p));
}

export function adversarialScore(prediction: string, gold: string): number {
  const goldRefuses = isRefusal(gold);
  const predRefuses = isRefusal(prediction);
  if (!goldRefuses) {
    // Not actually adversarial — fall back to F1.
    return tokenF1(prediction, gold);
  }
  return predRefuses ? 1 : 0;
}

function countTokens(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const tok of tokens) counts.set(tok, (counts.get(tok) ?? 0) + 1);
  return counts;
}

function lcsLength(a: string[], b: string[]): number {
  const m = a.length;
  const n = b.length;
  if (m === 0 || n === 0) return 0;
  const prev = new Array<number>(n + 1).fill(0);
  const curr = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, curr[j - 1]!);
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j]!;
  }
  return prev[n]!;
}
