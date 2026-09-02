import { envFlagEnabled } from './env-validation';

/**
 * Evidence plane — summary episode stamping master flag —
 * PROVENANCE_SUMMARY_EPISODE_STAMP.
 *
 * When on, every summary-producing writer (promotion runner, compaction
 * rollups, recompose rewrites, arc/aggregate composers) stamps the union
 * of its members' `source.episodeIds` onto the summary row's source —
 * the window-deriver idiom (window-deriver.service.ts:876): strings
 * filtered to the 'episode:' prefix, deduped, member order preserved,
 * capped at 64 — so a summary keeps a direct line to the verbatim turns
 * behind its members instead of breaking the evidence chain at
 * promotion. The env read lives here in the common layer, NOT inside the
 * engine dirs (engine-gates S5.2). Read at call time so a flip is
 * runtime-mutable. Default off ⇒ every summary write is byte-identical
 * to today's rows (no episodeIds key is ever added, no SET fragment is
 * ever emitted).
 */
export function summaryEpisodeStampEnabled(): boolean {
  return envFlagEnabled(process.env.PROVENANCE_SUMMARY_EPISODE_STAMP);
}

/**
 * Evidence plane — recursive support-closure master flag —
 * PROVENANCE_RECURSIVE_CLOSURE.
 *
 * When on, GET /v1/facts/:id/provenance of a fact WITH `derivedFrom`
 * runs a bounded BFS over the derivedFrom graph (provenance-closure.ts)
 * and serves the union of grounding episodes across the closure plus the
 * optional `derivedFacts` / `closure` result fields. Every member row
 * passes the SAME per-row fences as the root (user scope, scope tags,
 * row policy) — an invisible member is a SILENT drop (`filtered: true`),
 * never an error, while the root keeps its exact 404 semantics. The env
 * read lives here in the common layer, NOT inside the engine dirs
 * (engine-gates S5.2). Read at call time so a flip is runtime-mutable.
 * Default off ⇒ the provenance response is byte-identical to today's
 * one-hop shape (the optional fields are absent, not empty).
 */
export function recursiveClosureEnabled(): boolean {
  return envFlagEnabled(process.env.PROVENANCE_RECURSIVE_CLOSURE);
}

/**
 * Typed support graph — write side — PROVENANCE_SUPPORT_EDGES.
 *
 * When on, the three writer families emit canonical memory_support
 * edges (0116): scene-backlink adds fact-supported_by->scene edges
 * ALONGSIDE the legacy source.memoryEpisodeIds stamps, the conflict
 * resolver records loser-contradicted_by->winner on SUPERSEDED and the
 * mutual pair on COMPETING (CONFLICT_OUTCOME_CAP idiom), and
 * promotion/compaction/recompose mirror derivedFrom as
 * summary-derived_from->member edges (recompose deletes-then-reinserts
 * its summary's set to track rewrites). Writes are replay-idempotent
 * (`INSERT RELATION IGNORE` over UNIQUE(in, out, kind)). The GDPR
 * cascades erase edges REGARDLESS of this flag. The env read lives here
 * in the common layer, NOT inside the engine dirs (engine-gates S5.2).
 * Read at call time so a flip is runtime-mutable. Default off ⇒ no edge
 * is ever written and every writer's query sequence is byte-identical.
 */
export function supportEdgesEnabled(): boolean {
  return envFlagEnabled(process.env.PROVENANCE_SUPPORT_EDGES);
}

/**
 * Typed support graph — read side — PROVENANCE_SUPPORT_GRAPH_READ.
 *
 * When on, the provenance closure walk (PROVENANCE_RECURSIVE_CLOSURE)
 * additionally follows derived_from edges as children (same visited
 * set, same depth/fact/episode caps) and returns the supported_by /
 * contradicted_by / derived_from edges it crossed in the optional
 * `supportEdges` response field; a root with typed edges but an EMPTY
 * derivedFrom array now walks too. Members pass the same per-row
 * fences; edge targets are classified via the EvidenceRef prefix
 * vocabulary (support-edges.ts). The env read lives here in the common
 * layer, NOT inside the engine dirs (engine-gates S5.2). Read at call
 * time so a flip is runtime-mutable. Default off ⇒ the walk and the
 * provenance response are byte-identical (field absent, not empty).
 */
export function supportGraphReadEnabled(): boolean {
  return envFlagEnabled(process.env.PROVENANCE_SUPPORT_GRAPH_READ);
}

/** Closure walk caps — defaults + clamp bounds (see the knobs below). */
const DEFAULT_CLOSURE_MAX_DEPTH = 5;
const DEFAULT_CLOSURE_MAX_FACTS = 256;
const DEFAULT_CLOSURE_MAX_EPISODES = 200;

/** Integer knob: unset/blank/non-numeric → default; else clamped. */
function intKnob(raw: string | undefined, dflt: number, range: [min: number, max: number]): number {
  if (raw === undefined || raw.trim() === '') return dflt;
  const v = Math.floor(Number(raw));
  if (!Number.isFinite(v)) return dflt;
  return Math.min(range[1], Math.max(range[0], v));
}

/**
 * Closure depth cap (PROVENANCE_CLOSURE_MAX_DEPTH): the BFS stops after
 * this many derivedFrom hops from the root; unvisited children beyond it
 * report `truncated`. A non-boolean knob resolved here in the common
 * layer so the walker takes a resolved number. Default 5, clamped to
 * 1..10; unset, blank, or non-numeric → the default.
 */
export function closureMaxDepth(): number {
  return intKnob(process.env.PROVENANCE_CLOSURE_MAX_DEPTH, DEFAULT_CLOSURE_MAX_DEPTH, [1, 10]);
}

/**
 * Closure fact budget (PROVENANCE_CLOSURE_MAX_FACTS): total supporting
 * facts the walk may admit across all depths; children beyond it report
 * `truncated` (fan-out cap). A non-boolean knob resolved here in the
 * common layer so the walker takes a resolved number. Default 256,
 * clamped to 1..1024; unset, blank, or non-numeric → the default.
 */
export function closureMaxFacts(): number {
  return intKnob(process.env.PROVENANCE_CLOSURE_MAX_FACTS, DEFAULT_CLOSURE_MAX_FACTS, [1, 1024]);
}

/**
 * Closure episode budget (PROVENANCE_CLOSURE_MAX_EPISODES): distinct
 * grounding episodes harvested across the walk; ids beyond it report
 * `truncated`. A non-boolean knob resolved here in the common layer so
 * the walker takes a resolved number. Default 200, clamped to 1..500;
 * unset, blank, or non-numeric → the default.
 */
export function closureMaxEpisodes(): number {
  return intKnob(
    process.env.PROVENANCE_CLOSURE_MAX_EPISODES,
    DEFAULT_CLOSURE_MAX_EPISODES,
    [1, 500],
  );
}
