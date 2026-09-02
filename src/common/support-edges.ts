/**
 * Typed support graph (Drift-5, migration 0116) — the pure edge-row
 * assembly shared by every memory_support writer and the closure
 * walker's edge classification. Pure module (episode-ids.ts
 * discipline): no Nest, no I/O — writers own their db calls
 * (`INSERT RELATION IGNORE INTO memory_support $rows`, verified
 * replay-idempotent on the pinned 3.2.4 via UNIQUE(in, out, kind)).
 *
 * Direction semantics (`in` = the claim being supported / contradicted
 * / derived — see the 0116 header):
 *   * supported_by:    in = knowledge_fact, out = memory_episode (scene)
 *   * contradicted_by: in = knowledge_fact (loser), out = knowledge_fact
 *     (winner); COMPETING writes the mutual pair
 *   * derived_from:    in = summary knowledge_fact, out = member
 *     knowledge_fact (typed mirror of the untyped derivedFrom array)
 *   * reconstructed_from: in = memory_episode (scene), out =
 *     evidence_fragment | evidence_asset — the scene is reconstructed
 *     from that piece of recorded evidence (MM-zoom PR1, kind activated
 *     by 0123, writer scene_evidence_linker). Scene -> turn membership
 *     STAYS in memory_episode_member (0106) — this kind names
 *     evidence-plane reconstruction sources, NOT membership.
 */
import { parseRecordRef } from './evidence-ref';

export const SUPPORT_EDGE_KINDS = [
  'supported_by',
  'contradicted_by',
  'derived_from',
  'reconstructed_from',
] as const;
export type SupportEdgeKind = (typeof SUPPORT_EDGE_KINDS)[number];

/**
 * The kinds the closure WALK crosses mid-walk (fact/belief-rooted
 * frontier fetches). reconstructed_from is deliberately NOT here even
 * though the linker writes it: its `in` is a scene, so it can never
 * appear in a frontier fetch — the provenance reader harvests it in a
 * dedicated POST-walk fetch over the crossed scenes instead
 * (provenance-closure.ts, normalizeReconstructedEdges).
 */
export const EMITTED_EDGE_KINDS = ['supported_by', 'contradicted_by', 'derived_from'] as const;
export type EmittedEdgeKind = (typeof EMITTED_EDGE_KINDS)[number];

export function isEmittedEdgeKind(v: string): v is EmittedEdgeKind {
  return (EMITTED_EDGE_KINDS as readonly string[]).includes(v);
}

export const SUPPORT_EDGE_WRITERS = [
  'scene_backlink',
  'fact_resolver',
  'promotion_runner',
  'compaction_runner',
  'recompose',
  'belief_promotion',
  'scene_evidence_linker',
] as const;
export type SupportEdgeWriter = (typeof SUPPORT_EDGE_WRITERS)[number];

/** Rows per INSERT payload — the unionEvidenceRefs cap idiom. */
export const SUPPORT_EDGE_CAP = 64;

/** One memory_support row as assembled (record ids as strings — the
 *  writer converts to StringRecordId at the bind site; 3.x does not
 *  coerce string↔record). */
export interface SupportEdgeRow {
  in: string;
  out: string;
  kind: SupportEdgeKind;
  writer: SupportEdgeWriter;
  writerVersion?: string;
}

/**
 * Classify an edge endpoint by table prefix. EvidenceRef runtime
 * adoption: evidence-plane prefixes (episode:/evidence_fragment:/
 * evidence_asset:) dispatch through `parseRecordRef` — its first
 * runtime caller — so the evidence plane and the support graph share
 * ONE prefix vocabulary; the two support-graph-native tables are
 * matched directly. 'unknown' is never a guess.
 */
export type SupportTargetClass =
  'fact' | 'belief' | 'scene' | 'episode' | 'fragment' | 'asset' | 'unknown';

export function classifySupportTarget(raw: string): SupportTargetClass {
  const ref = parseRecordRef(raw);
  if (ref !== null && ref.kind !== 'external') return ref.kind;
  if (raw.startsWith('knowledge_fact:')) return 'fact';
  if (raw.startsWith('memory_episode:')) return 'scene';
  if (raw.startsWith('semantic_belief:')) return 'belief';
  return 'unknown';
}

/**
 * Endpoint-table pairing per kind (the TS-side substitute for the
 * FROM/TO types one polymorphic RELATION table cannot carry — 0116
 * header). Returns a boolean verdict: writers SKIP invalid rows with a
 * warn, never throw.
 *
 * Belief edges (0120, writer 'belief_promotion') follow the SAME
 * direction semantics with `in` = semantic_belief: supported_by
 * belief->scene mirrors the fact rule; contradicted_by / derived_from
 * pair a belief ONLY with another belief (revision chains never cross
 * into the claim plane — the SemanticBelief/Claim separation).
 *
 * reconstructed_from (0123) is the ONE kind rooted in the episodic
 * plane: in = scene, out = fragment | asset — every other pairing stays
 * rejected, and the three claim-plane kinds keep their exact pre-0123
 * verdicts (in must classify fact/belief; pinned in the unit spec).
 */
export function assertEdgeShape(kind: SupportEdgeKind, inId: string, outId: string): boolean {
  const inClass = classifySupportTarget(inId);
  const out = classifySupportTarget(outId);
  switch (kind) {
    case 'supported_by':
      return (inClass === 'fact' || inClass === 'belief') && out === 'scene';
    case 'contradicted_by':
    case 'derived_from':
      return (inClass === 'fact' || inClass === 'belief') && out === inClass;
    case 'reconstructed_from':
      return inClass === 'scene' && (out === 'fragment' || out === 'asset');
  }
}

export interface SupportEdgeSpec {
  kind: SupportEdgeKind;
  writer: SupportEdgeWriter;
  writerVersion?: string | undefined;
  /** Endpoint pairs in emission order (record ids as strings). */
  pairs: ReadonlyArray<{ in: string; out: string }>;
}

/**
 * Assemble edge rows from endpoint pairs: shape-validated
 * (assertEdgeShape — invalid pairs are counted, not thrown), deduped by
 * (in, out, kind) with emission order preserved (Set-insertion idiom of
 * unionEvidenceRefs), capped at SUPPORT_EDGE_CAP per call. Callers with
 * potentially larger sets use `buildSupportEdgeBatches`.
 */
export function buildSupportEdgeRows(spec: SupportEdgeSpec): {
  rows: SupportEdgeRow[];
  skipped: number;
} {
  const { batches, skipped } = buildSupportEdgeBatches(spec);
  return { rows: batches[0] ?? [], skipped };
}

/**
 * The unbounded-input form: same validation/dedupe as
 * buildSupportEdgeRows, the deduped set sliced into
 * SUPPORT_EDGE_CAP-sized INSERT payloads (bounded query payloads, the
 * FACTS_PER_UPDATE discipline).
 */
export function buildSupportEdgeBatches(spec: SupportEdgeSpec): {
  batches: SupportEdgeRow[][];
  skipped: number;
} {
  const seen = new Set<string>();
  const rows: SupportEdgeRow[] = [];
  let skipped = 0;
  for (const pair of spec.pairs) {
    if (!assertEdgeShape(spec.kind, pair.in, pair.out)) {
      skipped += 1;
      continue;
    }
    const key = `${pair.in}\x00${pair.out}\x00${spec.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      in: pair.in,
      out: pair.out,
      kind: spec.kind,
      writer: spec.writer,
      ...(spec.writerVersion !== undefined ? { writerVersion: spec.writerVersion } : {}),
    });
  }
  const batches: SupportEdgeRow[][] = [];
  for (let i = 0; i < rows.length; i += SUPPORT_EDGE_CAP) {
    batches.push(rows.slice(i, i + SUPPORT_EDGE_CAP));
  }
  return { batches, skipped };
}

/** The resolver-verdict slice buildConflictEdgeRows reads
 *  (ResolveOutcome structurally satisfies it). */
export interface ConflictVerdict {
  outcome?: unknown;
  factId?: unknown;
  supersededFactIds?: unknown;
  competingFactIds?: unknown;
}

/**
 * Conflict verdicts → contradicted_by rows (the emitConflictOutcomes
 * pairing, decision #4):
 *   * SUPERSEDED → one edge per displaced fact, in = LOSER,
 *     out = WINNER ("the old claim is contradicted by the new one");
 *   * COMPETING → the MUTUAL pair (both directions) between each
 *     standing competitor and the new fact;
 *   * every other outcome → no rows.
 * `cap` bounds a pathological fan-out (the CONFLICT_OUTCOME_CAP idiom —
 * applied to EDGES here, after dedupe).
 */
export function buildConflictEdgeRows(result: ConflictVerdict, cap: number): SupportEdgeRow[] {
  const outcome = String(result?.outcome ?? '');
  const newFactId = result?.factId ? String(result.factId) : undefined;
  if (!newFactId) return [];
  const pairs: Array<{ in: string; out: string }> = [];
  if (outcome === 'SUPERSEDED') {
    for (const raw of asArray(result.supersededFactIds)) {
      pairs.push({ in: String(raw), out: newFactId });
    }
  } else if (outcome === 'COMPETING') {
    for (const raw of asArray(result.competingFactIds)) {
      const competitor = String(raw);
      if (competitor === newFactId) continue;
      pairs.push({ in: competitor, out: newFactId });
      pairs.push({ in: newFactId, out: competitor });
    }
  }
  const { rows } = buildSupportEdgeRows({
    kind: 'contradicted_by',
    writer: 'fact_resolver',
    pairs,
  });
  return rows.slice(0, cap);
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
