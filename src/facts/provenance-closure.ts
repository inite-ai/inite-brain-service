/**
 * Bounded recursive provenance closure (evidence plane, PR gap #6).
 *
 * Promotion/compaction/composers replace member facts with summary rows
 * whose `derivedFrom` points at the (now hidden) members — one-hop
 * provenance dead-ends at the summary. This walker follows `derivedFrom`
 * breadth-first from an ALREADY-FENCED root, harvesting each depth's
 * grounding stamps (`source.episodeIds` + `source.charSpans`), so the
 * provenance surface can serve the union of verbatim turns behind the
 * whole support closure.
 *
 * Pure module, unit-testable with a stubbed db: the caller supplies the
 * batched row fetch and the per-row visibility verdict. Fence semantics
 * are the caller's (facts.service `factVisible`): an invisible member is
 * a SILENT drop (`filtered`), never an error — and its subtree is
 * dropped with it, because evidence reachable only through a fenced fact
 * is evidence the caller may not see.
 *
 * Status is deliberately NOT filtered: compacted/retracted members still
 * witness what a summary was derived from — status is REPORTED on the
 * wire, not hidden.
 */

/** Wire span shape — {start, end, exact} only (G3). */
export interface ProvenanceSpan {
  start: number;
  end: number;
  exact: string;
}

/**
 * Defensive read of source.charSpans (G3 — written by the derive row
 * builder, but `source` is FLEXIBLE so shapes are never guaranteed).
 * Keeps the first well-formed span per episode; malformed entries are
 * ignored. Only {start, end, exact} go on the wire — prefix/suffix are
 * re-anchoring context for the store, not the API.
 */
export function indexCharSpans(charSpans: unknown): Map<string, ProvenanceSpan> {
  const byEpisode = new Map<string, ProvenanceSpan>();
  if (!Array.isArray(charSpans)) return byEpisode;
  for (const raw of charSpans) {
    const s = raw as {
      episodeId?: unknown;
      start?: unknown;
      end?: unknown;
      exact?: unknown;
    };
    if (
      typeof s?.episodeId === 'string' &&
      typeof s.start === 'number' &&
      typeof s.end === 'number' &&
      typeof s.exact === 'string' &&
      !byEpisode.has(s.episodeId)
    ) {
      byEpisode.set(s.episodeId, {
        start: s.start,
        end: s.end,
        exact: s.exact,
      });
    }
  }
  return byEpisode;
}

/** The minimal row shape the walk reads. FactReadRow satisfies it. */
export interface ClosureFactRow {
  id: unknown;
  predicate?: unknown;
  status?: unknown;
  userId?: unknown;
  source?: unknown;
  derivedFrom?: unknown;
}

export interface ProvenanceClosureCaps {
  /** Max derivedFrom hops from the root (root = depth 0). */
  maxDepth: number;
  /** Total supporting facts admitted across the whole walk. */
  maxFacts: number;
  /** Distinct grounding episodes harvested across the whole walk. */
  maxEpisodes: number;
}

export interface ProvenanceClosureResult<Row extends ClosureFactRow> {
  /** Visible supporting facts, BFS order, root excluded (depth ≥ 1). */
  closureFacts: Array<{ fact: Row; depth: number }>;
  /**
   * episodeId → contributing fact's userId ('' = tenant-global).
   * Insertion-ordered (BFS order, root's stamps first); the first
   * contributing fact wins the ownership key.
   */
  episodes: Map<string, string>;
  /** episodeId → first-wins char span across the walk (root first). */
  spans: Map<string, ProvenanceSpan>;
  truncated: { depth: boolean; fanout: boolean; episodes: boolean };
  /** True when ≥1 member row was silently dropped by the fence. */
  filtered: boolean;
}

/** Mutable walk bookkeeping shared by the per-depth helpers. */
interface WalkState {
  visited: Set<string>;
  episodes: Map<string, string>;
  spans: Map<string, ProvenanceSpan>;
  truncated: { depth: boolean; fanout: boolean; episodes: boolean };
  /** Fact budget consumed — children admitted across the whole walk. */
  admitted: number;
}

/**
 * Harvest one fact's grounding stamps into the walk state: 'episode:'-
 * prefixed ids (String()-coerced, deduped, episode-budget capped) keyed
 * to the fact's userId ('' = tenant-global), and first-wins char spans.
 */
function harvestGrounding(fact: ClosureFactRow, caps: ProvenanceClosureCaps, s: WalkState): void {
  const source = (fact.source ?? {}) as { episodeIds?: unknown; charSpans?: unknown };
  const owner = typeof fact.userId === 'string' && fact.userId.length > 0 ? fact.userId : '';
  if (Array.isArray(source.episodeIds)) {
    for (const raw of source.episodeIds) {
      const id = String(raw);
      if (!id.startsWith('episode:') || s.episodes.has(id)) continue;
      if (s.episodes.size >= caps.maxEpisodes) {
        s.truncated.episodes = true;
        continue;
      }
      s.episodes.set(id, owner);
    }
  }
  for (const [episodeId, span] of indexCharSpans(source.charSpans)) {
    if (!s.spans.has(episodeId)) s.spans.set(episodeId, span);
  }
}

/**
 * The frontier's next generation: union of derivedFrom minus visited,
 * String()-normalized, capped by the walk-wide fact budget (fanout).
 */
function collectChildren(
  frontier: readonly ClosureFactRow[],
  caps: ProvenanceClosureCaps,
  s: WalkState,
): string[] {
  const children: string[] = [];
  for (const fact of frontier) {
    if (!Array.isArray(fact.derivedFrom)) continue;
    for (const raw of fact.derivedFrom) {
      const id = String(raw);
      if (s.visited.has(id)) continue;
      if (s.admitted >= caps.maxFacts) {
        s.truncated.fanout = true;
        continue;
      }
      s.visited.add(id);
      s.admitted += 1;
      children.push(id);
    }
  }
  return children;
}

/**
 * BFS over `derivedFrom` from an already-fenced root. One batched fetch
 * per depth (`WHERE id INSIDE $ids` — the caller's query carries NO
 * status filter); record-id shapes are String()-normalized throughout,
 * so RecordId objects and plain strings key the visited set identically
 * (which is also what terminates cycles — each id is admitted once).
 */
export async function walkProvenanceClosure<Row extends ClosureFactRow>(opts: {
  root: Row;
  caps: ProvenanceClosureCaps;
  /** Per-row fence verdict (user scope / scope tags / row policy). */
  visible: (fact: Row) => boolean;
  /** ONE batched SELECT of loadVisibleFact's column set — no status filter. */
  fetchByIds: (ids: string[]) => Promise<Row[]>;
}): Promise<ProvenanceClosureResult<Row>> {
  const { caps } = opts;
  const state: WalkState = {
    visited: new Set<string>([String(opts.root.id)]),
    episodes: new Map<string, string>(),
    spans: new Map<string, ProvenanceSpan>(),
    truncated: { depth: false, fanout: false, episodes: false },
    admitted: 0,
  };
  const closureFacts: Array<{ fact: Row; depth: number }> = [];
  let filtered = false;
  let frontier: Row[] = [opts.root];
  let depth = 0;

  while (frontier.length > 0) {
    // 1. Harvest this depth's grounding stamps. A member without
    //    episodeIds still contributes its children below.
    for (const fact of frontier) harvestGrounding(fact, caps, state);

    // 2. Next generation, minus visited, fact-budget capped.
    const children = collectChildren(frontier, caps, state);
    if (children.length === 0) break;
    if (depth >= caps.maxDepth) {
      // Unvisited children remain past the depth cap.
      state.truncated.depth = true;
      break;
    }

    // 3. Fetch + fence. Invisible member = silent drop, subtree included.
    const rows = await opts.fetchByIds(children);
    const visibleRows = rows.filter((row) => opts.visible(row));
    if (visibleRows.length < rows.length) filtered = true;
    depth += 1;
    for (const row of visibleRows) closureFacts.push({ fact: row, depth });
    frontier = visibleRows;
  }

  return {
    closureFacts,
    episodes: state.episodes,
    spans: state.spans,
    truncated: state.truncated,
    filtered,
  };
}
