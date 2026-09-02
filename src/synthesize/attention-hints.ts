import { composePredicateId, MM_MAX_ATTENTION_HINTS } from '../ai/domain-packs/manifest';

/**
 * FOVEA_ATTENTION_HINTS — pack attention hints as an ordering-only anchor
 * boost (the read side of the memoryModel.attentionHints declaration).
 *
 * A pack declares "when the query is about <cue>, prefer facts asserted
 * through <these predicates>" (PackAttentionHint: literal cue, pack-local
 * predicate ids, weight in (0,1]). This module resolves those declarations
 * against ONE query into a predicate→boost map that mergeAnchorSources
 * applies POST-normalization to the L3 anchor scores — and scores are only
 * the tie-break under the density-primary rankL3Sessions key, so the hint
 * can nudge which session escalates first but never add, drop, or filter
 * an anchor.
 *
 * Pure; no IO, no env (engine-gates S5.2 — the service reads the flag via
 * the common layer and consults the memory-model reader lazily). Inputs are
 * treated as UNTRUSTED even though the reader re-validates stored models:
 * a garbage hint (non-string cue, out-of-bounds cue length, missing/empty
 * prefer list, non-string prefer entries) is skipped, and a resolution that
 * yields nothing returns null — the caller then passes no boost and the
 * merge is structurally the no-hint code path.
 *
 * Cue matching is a case-folded LITERAL substring test (NFC + toLowerCase
 * on both sides) — never a regex, never a template — mirroring the
 * manifest's "literal substring" contract for cues.
 */

/** One installed pack's attentionHints list, treated as untrusted. */
export interface AttentionHintSource {
  /** The pack's id — the namespace its `prefer` localIds resolve under. */
  packId: string;
  /** The pack memoryModel.attentionHints entries (PackAttentionHint[]). */
  hints: ReadonlyArray<unknown>;
}

/** Fully-qualified stored predicate id (`<packId>__<localId>`) → score
 *  multiplier in [1, 2]. */
export type AttentionHintBoost = ReadonlyMap<string, number>;

/** Manifest bound: an attention hint prefers ≤ 8 predicate localIds. */
const MAX_PREFER = 8;
/** Manifest bound: a cue is a literal of 2..64 chars. */
const CUE_MIN = 2;
const CUE_MAX = 64;
/** PackAttentionHint.weight default when absent/garbage. */
const DEFAULT_WEIGHT = 0.5;
const BOOST_MIN = 1;
const BOOST_MAX = 2;

/**
 * Clamp a hint boost into [1, 2]. Applied both when the map is built and
 * again where mergeAnchorSources consumes it, so a boost can never shrink
 * a score (min 1 — hints only ever PREFER, never punish) and never more
 * than double it (max 2 — a hint out-nudges a tie, it cannot manufacture
 * dominance; density stays the primary rank key regardless). Non-finite
 * input collapses to the identity 1.
 */
export function clampAttentionBoost(v: number): number {
  if (!Number.isFinite(v)) return BOOST_MIN;
  if (v < BOOST_MIN) return BOOST_MIN;
  if (v > BOOST_MAX) return BOOST_MAX;
  return v;
}

/** Case-fold for the literal cue test: NFC (composed/decomposed forms
 *  match) then locale-independent toLowerCase. */
function fold(s: string): string {
  return s.normalize('NFC').toLowerCase();
}

/** A hint entry that survived the garbage checks, ready to apply. */
interface ParsedHint {
  cue: string;
  prefer: string[];
  weight: number;
}

/**
 * Untrusted entry → usable hint, or null to skip: the cue must be a
 * string within the manifest's 2..64 literal bound, the prefer list
 * non-empty with ≥1 non-empty string after the 8-cap, and a weight
 * outside (0,1] (or missing, or non-numeric) falls back to the 0.5
 * default rather than poisoning the boost.
 */
function parseHint(entry: unknown): ParsedHint | null {
  const hint = entry as { cue?: unknown; prefer?: unknown; weight?: unknown } | null;
  if (typeof hint?.cue !== 'string') return null;
  if (hint.cue.length < CUE_MIN || hint.cue.length > CUE_MAX) return null;
  if (!Array.isArray(hint.prefer) || hint.prefer.length === 0) return null;
  const prefer = hint.prefer
    .slice(0, MAX_PREFER)
    .filter((p): p is string => typeof p === 'string' && p !== '');
  if (prefer.length === 0) return null;
  const weight =
    typeof hint.weight === 'number' &&
    Number.isFinite(hint.weight) &&
    hint.weight > 0 &&
    hint.weight <= 1
      ? hint.weight
      : DEFAULT_WEIGHT;
  return { cue: hint.cue, prefer, weight };
}

/**
 * Resolve the installed packs' attention hints against one query.
 *
 * A hint contributes iff its cue occurs in the query (case-folded literal
 * substring) AND it declares a usable `prefer` list; each preferred
 * localId then maps — namespaced under the declaring pack, exactly as the
 * registry stores pack predicates — to `1 + weight`, clamped to [1, 2]
 * (weight ∈ (0,1], default 0.5, so the natural range is (1, 2]). When
 * several matched hints prefer the same predicate the strongest boost
 * wins (max, not product — stacked cues must not compound past the
 * clamp's intent).
 *
 * Returns null when nothing matched or nothing was usable: the structural
 * no-op signal (the caller passes no boost at all).
 */
export function resolveAttentionHintBoost(
  query: string,
  sources: ReadonlyArray<AttentionHintSource>,
): AttentionHintBoost | null {
  const foldedQuery = fold(query);
  if (foldedQuery.trim() === '') return null;
  const byPredicate = new Map<string, number>();
  for (const s of sources) {
    if (!s || typeof s.packId !== 'string' || s.packId === '' || !Array.isArray(s.hints)) continue;
    // Defensive bound mirroring the manifest cap — a malformed list can
    // never turn resolution into unbounded work.
    for (const entry of s.hints.slice(0, MM_MAX_ATTENTION_HINTS)) {
      const hint = parseHint(entry);
      if (!hint || !foldedQuery.includes(fold(hint.cue))) continue;
      const boost = clampAttentionBoost(1 + hint.weight);
      for (const localId of hint.prefer) {
        const qualified = composePredicateId(s.packId, localId);
        const prev = byPredicate.get(qualified);
        if (prev === undefined || boost > prev) byPredicate.set(qualified, boost);
      }
    }
  }
  return byPredicate.size > 0 ? byPredicate : null;
}
