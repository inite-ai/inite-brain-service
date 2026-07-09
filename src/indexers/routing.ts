/**
 * Rule layers of the indexer relevance router (L0/L1) + the cosine gate
 * used by the embedding layer (L2). Pure module — the IO (loading
 * bindings, computing embeddings) lives in IndexerRouterService.
 *
 * The router gates ONLY dedicated/external runs. Virtual packs ride the
 * union call unconditionally — their marginal cost is prompt tokens, not
 * LLM calls.
 */
import type { IndexerDescriptor, IndexerRelevance } from '../ai/domain-packs/manifest';

export interface IndexerBinding {
  indexerId: string;
  packVersion: string;
  mode: 'virtual' | 'dedicated' | 'external';
  description: string;
  relevance?: IndexerRelevance;
  dedicated?: IndexerDescriptor['dedicated'];
}

export interface RoutingInput {
  vertical: string;
  /** Document head (first few KB) — the cheap trigger surface. */
  head: string;
  /** Explicit per-request indexer selection (L0). */
  requested?: string[];
}

export interface RuleRoutingResult {
  /** Selected by L0 (explicit / vertical / alwaysRun) or L1 (keywords). */
  selected: IndexerBinding[];
  /** Undecided after rules; candidates for the L2 embedding gate. */
  needEmbedding: IndexerBinding[];
}

export const DEFAULT_RELEVANCE_THRESHOLD = 0.3;
/** How much of the document the rule/embedding layers look at. */
export const ROUTER_HEAD_CHARS = 4_000;

/** L0 + L1 over the dedicated bindings. */
export function routeByRules(
  bindings: IndexerBinding[],
  input: RoutingInput,
): RuleRoutingResult {
  const selected: IndexerBinding[] = [];
  const needEmbedding: IndexerBinding[] = [];
  const requested = new Set(input.requested ?? []);
  const head = input.head.slice(0, ROUTER_HEAD_CHARS).toLowerCase();

  for (const b of bindings) {
    if (b.mode !== 'dedicated') continue;
    const r = b.relevance;
    const l0 =
      requested.has(b.indexerId) ||
      r?.alwaysRun === true ||
      (r?.verticals?.includes(input.vertical) ?? false);
    const l1 =
      !l0 && (r?.keywords?.some((kw) => headMatchesKeyword(head, kw)) ?? false);
    if (l0 || l1) {
      selected.push(b);
    } else if (r?.description) {
      needEmbedding.push(b);
    }
    // No relevance triggers at all → the pack opted into dedicated but
    // gave the router nothing to route on; it only runs when explicitly
    // requested (L0 above).
  }
  return { selected, needEmbedding };
}

/**
 * Whole-token keyword match against the (lowercased) document head. A plain
 * substring test fires false positives — keyword "hr" matches "three",
 * "id" matches "hidden" — inflating LLM-call fan-out. Bound the match by
 * non-alphanumeric edges (Unicode-aware) so only a standalone occurrence
 * counts. Multi-word keywords are bounded as a whole phrase.
 */
export function headMatchesKeyword(head: string, keyword: string): boolean {
  const kw = keyword.trim().toLowerCase();
  if (!kw) return false;
  const esc = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${esc}(?:[^\\p{L}\\p{N}]|$)`, 'u').test(
    head,
  );
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}
