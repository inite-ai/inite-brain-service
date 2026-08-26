import {
  walkProvenanceClosure,
  indexCharSpans,
  type ClosureFactRow,
} from '../src/facts/provenance-closure';

/**
 * Bounded BFS provenance walker (evidence plane, PROVENANCE_RECURSIVE_
 * CLOSURE). Pure module — the db is a stubbed fetchByIds over an
 * in-memory row map; the fence is a stubbed visible() verdict. These
 * pin the cap semantics (depth / fan-out / episodes, each with its own
 * truncated marker), cycle termination, first-wins span merging,
 * String() record-id normalization, and the status-is-reported-not-
 * hidden rule for compacted/retracted members.
 */

type Row = ClosureFactRow & Record<string, unknown>;

const CAPS = { maxDepth: 5, maxFacts: 256, maxEpisodes: 200 };

function fact(
  id: string,
  opts: {
    derivedFrom?: unknown[];
    episodeIds?: unknown[];
    charSpans?: unknown[];
    userId?: string;
    status?: string;
    source?: false;
  } = {},
): Row {
  return {
    id: `knowledge_fact:${id}`,
    predicate: 'preference',
    status: opts.status ?? 'active',
    ...(opts.userId ? { userId: opts.userId } : {}),
    ...(opts.source === false
      ? {}
      : {
          source: {
            kind: 'fact',
            ...(opts.episodeIds ? { episodeIds: opts.episodeIds } : {}),
            ...(opts.charSpans ? { charSpans: opts.charSpans } : {}),
          },
        }),
    ...(opts.derivedFrom ? { derivedFrom: opts.derivedFrom } : {}),
  };
}

function makeDb(rows: Row[]): {
  fetchByIds: (ids: string[]) => Promise<Row[]>;
  batches: string[][];
} {
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  const batches: string[][] = [];
  return {
    batches,
    fetchByIds: async (ids: string[]) => {
      batches.push(ids);
      return ids.map((id) => byId.get(id)).filter((r): r is Row => r !== undefined);
    },
  };
}

const allVisible = () => true;

describe('walkProvenanceClosure — caps', () => {
  it('depth cap: a chain deeper than maxDepth stops with truncated.depth', async () => {
    // root → c1 → c2 → c3 → c4 (maxDepth 2 ⇒ c1, c2 in; c3 unvisited).
    const rows = [
      fact('c1', { derivedFrom: ['knowledge_fact:c2'], episodeIds: ['episode:e1'] }),
      fact('c2', { derivedFrom: ['knowledge_fact:c3'], episodeIds: ['episode:e2'] }),
      fact('c3', { derivedFrom: ['knowledge_fact:c4'] }),
      fact('c4', {}),
    ];
    const db = makeDb(rows);
    const out = await walkProvenanceClosure({
      root: fact('root', { derivedFrom: ['knowledge_fact:c1'], episodeIds: ['episode:e0'] }),
      caps: { ...CAPS, maxDepth: 2 },
      visible: allVisible,
      fetchByIds: db.fetchByIds,
    });
    expect(out.closureFacts.map((c) => [String(c.fact.id), c.depth])).toEqual([
      ['knowledge_fact:c1', 1],
      ['knowledge_fact:c2', 2],
    ]);
    expect(out.truncated).toEqual({ depth: true, fanout: false, episodes: false });
    // Root's stamps harvested first, then each depth's.
    expect([...out.episodes.keys()]).toEqual(['episode:e0', 'episode:e1', 'episode:e2']);
    expect(out.filtered).toBe(false);
  });

  it('fan-out cap: a star wider than maxFacts truncates with truncated.fanout', async () => {
    const children = Array.from({ length: 6 }, (_, i) => `knowledge_fact:c${i}`);
    const db = makeDb(children.map((id) => fact(id.split(':')[1]!)));
    const out = await walkProvenanceClosure({
      root: fact('root', { derivedFrom: children }),
      caps: { ...CAPS, maxFacts: 4 },
      visible: allVisible,
      fetchByIds: db.fetchByIds,
    });
    expect(out.closureFacts).toHaveLength(4);
    expect(out.truncated.fanout).toBe(true);
    expect(out.truncated.depth).toBe(false);
    expect(db.batches).toEqual([children.slice(0, 4)]);
  });

  it('episode cap: harvesting stops at maxEpisodes with truncated.episodes', async () => {
    const out = await walkProvenanceClosure({
      root: fact('root', {
        derivedFrom: ['knowledge_fact:c1'],
        episodeIds: ['episode:e1', 'episode:e2'],
      }),
      caps: { ...CAPS, maxEpisodes: 3 },
      visible: allVisible,
      fetchByIds: makeDb([fact('c1', { episodeIds: ['episode:e2', 'episode:e3', 'episode:e4'] })])
        .fetchByIds,
    });
    // e1, e2 from the root; e2 deduped; e3 fills the cap; e4 truncated.
    expect([...out.episodes.keys()]).toEqual(['episode:e1', 'episode:e2', 'episode:e3']);
    expect(out.truncated.episodes).toBe(true);
  });
});

describe('walkProvenanceClosure — graph shapes', () => {
  it('cycle A↔B terminates, each node visited exactly once', async () => {
    const db = makeDb([
      fact('b', { derivedFrom: ['knowledge_fact:a'], episodeIds: ['episode:eb'] }),
    ]);
    const out = await walkProvenanceClosure({
      root: fact('a', { derivedFrom: ['knowledge_fact:b'], episodeIds: ['episode:ea'] }),
      caps: CAPS,
      visible: allVisible,
      fetchByIds: db.fetchByIds,
    });
    expect(out.closureFacts.map((c) => String(c.fact.id))).toEqual(['knowledge_fact:b']);
    expect(db.batches).toEqual([['knowledge_fact:b']]); // a never re-fetched
    expect(out.truncated).toEqual({ depth: false, fanout: false, episodes: false });
  });

  it('String-normalizes record-id shapes (RecordId-like objects and strings key identically)', async () => {
    // derivedFrom carries a RecordId-like object whose String() form is
    // the same id a later frontier references as a plain string.
    const ridLike = { toString: () => 'knowledge_fact:c1' };
    const db = makeDb([fact('c1', { derivedFrom: [ridLike] })]);
    const out = await walkProvenanceClosure({
      root: fact('root', { derivedFrom: [ridLike, 'knowledge_fact:c1'] }),
      caps: CAPS,
      visible: allVisible,
      fetchByIds: db.fetchByIds,
    });
    // One admission despite two shapes; c1's self-reference already visited.
    expect(db.batches).toEqual([['knowledge_fact:c1']]);
    expect(out.closureFacts).toHaveLength(1);
  });

  it('a member without episodeIds still contributes its children', async () => {
    const db = makeDb([
      fact('mid', { derivedFrom: ['knowledge_fact:leaf'], source: false }),
      fact('leaf', { episodeIds: ['episode:deep'] }),
    ]);
    const out = await walkProvenanceClosure({
      root: fact('root', { derivedFrom: ['knowledge_fact:mid'] }),
      caps: CAPS,
      visible: allVisible,
      fetchByIds: db.fetchByIds,
    });
    expect(out.closureFacts.map((c) => String(c.fact.id))).toEqual([
      'knowledge_fact:mid',
      'knowledge_fact:leaf',
    ]);
    expect([...out.episodes.keys()]).toEqual(['episode:deep']);
  });

  it('compacted/retracted members contribute; status is reported, not hidden', async () => {
    const db = makeDb([
      fact('m1', { status: 'compacted', episodeIds: ['episode:e1'] }),
      fact('m2', { status: 'retracted', episodeIds: ['episode:e2'] }),
    ]);
    const out = await walkProvenanceClosure({
      root: fact('root', { derivedFrom: ['knowledge_fact:m1', 'knowledge_fact:m2'] }),
      caps: CAPS,
      visible: allVisible,
      fetchByIds: db.fetchByIds,
    });
    expect(out.closureFacts.map((c) => String(c.fact.status))).toEqual(['compacted', 'retracted']);
    expect([...out.episodes.keys()]).toEqual(['episode:e1', 'episode:e2']);
    expect(out.filtered).toBe(false);
  });

  it('an invisible member is silently dropped (subtree included) and sets filtered', async () => {
    const db = makeDb([
      fact('visible', { episodeIds: ['episode:ok'] }),
      fact('hidden', {
        userId: 'someone-else',
        episodeIds: ['episode:secret'],
        derivedFrom: ['knowledge_fact:behind'],
      }),
      fact('behind', { episodeIds: ['episode:behind'] }),
    ]);
    const out = await walkProvenanceClosure({
      root: fact('root', {
        derivedFrom: ['knowledge_fact:visible', 'knowledge_fact:hidden'],
      }),
      caps: CAPS,
      visible: (f) => f.userId === undefined,
      fetchByIds: db.fetchByIds,
    });
    expect(out.filtered).toBe(true);
    expect(out.closureFacts.map((c) => String(c.fact.id))).toEqual(['knowledge_fact:visible']);
    // The fenced member's episodes AND its subtree never surface.
    expect([...out.episodes.keys()]).toEqual(['episode:ok']);
    expect(db.batches).toHaveLength(1);
  });
});

describe('walkProvenanceClosure — episode ownership + spans', () => {
  it("episodes map to the CONTRIBUTING fact's userId ('' = tenant-global), first-wins", async () => {
    const db = makeDb([
      fact('mine', { userId: 'user-a', episodeIds: ['episode:shared', 'episode:a-only'] }),
    ]);
    const out = await walkProvenanceClosure({
      root: fact('root', {
        derivedFrom: ['knowledge_fact:mine'],
        episodeIds: ['episode:shared'],
      }),
      caps: CAPS,
      visible: allVisible,
      fetchByIds: db.fetchByIds,
    });
    // 'shared' first seen on the tenant-global root — ownership sticks.
    expect(out.episodes.get('episode:shared')).toBe('');
    expect(out.episodes.get('episode:a-only')).toBe('user-a');
  });

  it('charSpans merge first-wins per episode across the walk (root first)', async () => {
    const rootSpan = { episodeId: 'episode:e1', start: 0, end: 4, exact: 'root' };
    const memberSpan = { episodeId: 'episode:e1', start: 9, end: 15, exact: 'member' };
    const otherSpan = { episodeId: 'episode:e2', start: 1, end: 3, exact: 'ok' };
    const db = makeDb([
      fact('m', {
        episodeIds: ['episode:e2'],
        charSpans: [memberSpan, otherSpan],
      }),
    ]);
    const out = await walkProvenanceClosure({
      root: fact('root', {
        derivedFrom: ['knowledge_fact:m'],
        episodeIds: ['episode:e1'],
        charSpans: [rootSpan],
      }),
      caps: CAPS,
      visible: allVisible,
      fetchByIds: db.fetchByIds,
    });
    expect(out.spans.get('episode:e1')).toEqual({ start: 0, end: 4, exact: 'root' });
    expect(out.spans.get('episode:e2')).toEqual({ start: 1, end: 3, exact: 'ok' });
  });

  it("harvest filters non-'episode:' ids and String()-coerces values", async () => {
    const out = await walkProvenanceClosure({
      root: fact('root', {
        episodeIds: ['episode:good', 'document:bad', { toString: () => 'episode:obj' }],
      }),
      caps: CAPS,
      visible: allVisible,
      fetchByIds: makeDb([]).fetchByIds,
    });
    expect([...out.episodes.keys()]).toEqual(['episode:good', 'episode:obj']);
    expect(out.closureFacts).toEqual([]);
  });
});

describe('indexCharSpans (shared helper)', () => {
  it('keeps the first well-formed span per episode and drops malformed entries', () => {
    const map = indexCharSpans([
      { episodeId: 'episode:e1', start: 1, end: 2, exact: 'a' },
      { episodeId: 'episode:e1', start: 3, end: 4, exact: 'b' }, // dup: first wins
      { episodeId: 'episode:e2', exact: 'missing-offsets' }, // malformed
      'not-an-object',
    ]);
    expect(map.get('episode:e1')).toEqual({ start: 1, end: 2, exact: 'a' });
    expect(map.has('episode:e2')).toBe(false);
  });

  it('tolerates a non-array input (FLEXIBLE source)', () => {
    expect(indexCharSpans(undefined).size).toBe(0);
    expect(indexCharSpans({ episodeId: 'episode:e1' }).size).toBe(0);
  });
});

/**
 * Typed support graph read (Drift-5, PROVENANCE_SUPPORT_GRAPH_READ):
 * the optional fetchEdges callback. ABSENT ⇒ the walk is byte-identical
 * to the pre-edge walker (pinned by deep-equal below AND by every
 * legacy spec above running unchanged). PRESENT ⇒ derived_from targets
 * join the generation through the SAME visited set and fact budget,
 * and every crossed edge lands in `edges`.
 */
describe('walkProvenanceClosure — fetchEdges (support graph read)', () => {
  type EdgeSeed = { in: string; out: string; kind: string };

  function makeEdgeDb(edges: EdgeSeed[]) {
    const batches: string[][] = [];
    return {
      batches,
      fetchEdges: async (ids: string[]) => {
        batches.push(ids);
        return edges.filter((e) => ids.includes(e.in));
      },
    };
  }

  it('fetchEdges ABSENT: result deep-equals the pre-edge shape (edges empty, no other change)', async () => {
    const rows = [fact('c1', { episodeIds: ['episode:e1'] })];
    const out = await walkProvenanceClosure({
      root: fact('root', { derivedFrom: ['knowledge_fact:c1'], episodeIds: ['episode:e0'] }),
      caps: CAPS,
      visible: allVisible,
      fetchByIds: makeDb(rows).fetchByIds,
    });
    expect(out.edges).toEqual([]);
    expect(out.closureFacts.map((c) => String(c.fact.id))).toEqual(['knowledge_fact:c1']);
    expect([...out.episodes.keys()]).toEqual(['episode:e0', 'episode:e1']);
    expect(out.truncated).toEqual({ depth: false, fanout: false, episodes: false });
    expect(out.filtered).toBe(false);
  });

  it('derived_from edges union targets into the generation (root with EMPTY derivedFrom walks)', async () => {
    const rows = [fact('c1', { episodeIds: ['episode:e1'] })];
    const edb = makeEdgeDb([
      { in: 'knowledge_fact:root', out: 'knowledge_fact:c1', kind: 'derived_from' },
    ]);
    const out = await walkProvenanceClosure({
      root: fact('root', { episodeIds: ['episode:e0'] }),
      caps: CAPS,
      visible: allVisible,
      fetchByIds: makeDb(rows).fetchByIds,
      fetchEdges: edb.fetchEdges,
    });
    expect(out.closureFacts.map((c) => [String(c.fact.id), c.depth])).toEqual([
      ['knowledge_fact:c1', 1],
    ]);
    expect(out.edges).toEqual([
      { kind: 'derived_from', from: 'knowledge_fact:root', to: 'knowledge_fact:c1' },
    ]);
    // Harvest reaches the edge-discovered child too.
    expect([...out.episodes.keys()]).toEqual(['episode:e0', 'episode:e1']);
    // One batched edge fetch per depth over the frontier.
    expect(edb.batches).toEqual([['knowledge_fact:root'], ['knowledge_fact:c1']]);
  });

  it('edge children pass the SAME visited set (derivedFrom twin deduped) and fact budget', async () => {
    const rows = [fact('c1', {}), fact('c2', {})];
    const edb = makeEdgeDb([
      // c1 arrives via BOTH the array and the edge — admitted once.
      { in: 'knowledge_fact:root', out: 'knowledge_fact:c1', kind: 'derived_from' },
      { in: 'knowledge_fact:root', out: 'knowledge_fact:c2', kind: 'derived_from' },
    ]);
    const db = makeDb(rows);
    const out = await walkProvenanceClosure({
      root: fact('root', { derivedFrom: ['knowledge_fact:c1'] }),
      caps: { ...CAPS, maxFacts: 2 },
      visible: allVisible,
      fetchByIds: db.fetchByIds,
      fetchEdges: edb.fetchEdges,
    });
    expect(db.batches).toEqual([['knowledge_fact:c1', 'knowledge_fact:c2']]);
    expect(out.closureFacts).toHaveLength(2);
    expect(out.truncated.fanout).toBe(false);
  });

  it('fact budget exhausted by edge children → truncated.fanout', async () => {
    const rows = [fact('c1', {})];
    const edb = makeEdgeDb([
      { in: 'knowledge_fact:root', out: 'knowledge_fact:c1', kind: 'derived_from' },
      { in: 'knowledge_fact:root', out: 'knowledge_fact:c2', kind: 'derived_from' },
    ]);
    const out = await walkProvenanceClosure({
      root: fact('root', {}),
      caps: { ...CAPS, maxFacts: 1 },
      visible: allVisible,
      fetchByIds: makeDb(rows).fetchByIds,
      fetchEdges: edb.fetchEdges,
    });
    expect(out.closureFacts.map((c) => String(c.fact.id))).toEqual(['knowledge_fact:c1']);
    expect(out.truncated.fanout).toBe(true);
  });

  it('supported_by / contradicted_by are collected but never walked; non-fact targets never walked', async () => {
    const edb = makeEdgeDb([
      { in: 'knowledge_fact:root', out: 'memory_episode:s1', kind: 'supported_by' },
      { in: 'knowledge_fact:root', out: 'knowledge_fact:rival', kind: 'contradicted_by' },
      // A derived_from pointing OUTSIDE the fact table: reported, not walked.
      { in: 'knowledge_fact:root', out: 'episode:e9', kind: 'derived_from' },
      // Reserved / unknown kinds are dropped entirely.
      { in: 'knowledge_fact:root', out: 'episode:e1', kind: 'reconstructed_from' },
      { in: 'knowledge_fact:root', out: 'knowledge_fact:x', kind: 'bogus' },
    ]);
    const db = makeDb([]);
    const out = await walkProvenanceClosure({
      root: fact('root', {}),
      caps: CAPS,
      visible: allVisible,
      fetchByIds: db.fetchByIds,
      fetchEdges: edb.fetchEdges,
    });
    expect(out.edges).toEqual([
      { kind: 'supported_by', from: 'knowledge_fact:root', to: 'memory_episode:s1' },
      { kind: 'contradicted_by', from: 'knowledge_fact:root', to: 'knowledge_fact:rival' },
      { kind: 'derived_from', from: 'knowledge_fact:root', to: 'episode:e9' },
    ]);
    // contradicted_by target is NOT a child; no fact fetch ever fired.
    expect(db.batches).toEqual([]);
    expect(out.closureFacts).toEqual([]);
  });

  it('a cycle via edges terminates (visited set covers edge children)', async () => {
    const rows = [fact('c1', {})];
    const edb = makeEdgeDb([
      { in: 'knowledge_fact:root', out: 'knowledge_fact:c1', kind: 'derived_from' },
      { in: 'knowledge_fact:c1', out: 'knowledge_fact:root', kind: 'derived_from' },
    ]);
    const out = await walkProvenanceClosure({
      root: fact('root', {}),
      caps: CAPS,
      visible: allVisible,
      fetchByIds: makeDb(rows).fetchByIds,
      fetchEdges: edb.fetchEdges,
    });
    expect(out.closureFacts.map((c) => String(c.fact.id))).toEqual(['knowledge_fact:c1']);
    // The back-edge is still REPORTED — it just cannot re-admit root.
    expect(out.edges).toEqual([
      { kind: 'derived_from', from: 'knowledge_fact:root', to: 'knowledge_fact:c1' },
      { kind: 'derived_from', from: 'knowledge_fact:c1', to: 'knowledge_fact:root' },
    ]);
  });

  it('edge surface shares the fact-budget cap (overflow marks truncated.fanout)', async () => {
    const edb = makeEdgeDb(
      Array.from({ length: 4 }, (_, i) => ({
        in: 'knowledge_fact:root',
        out: `memory_episode:s${i}`,
        kind: 'supported_by',
      })),
    );
    const out = await walkProvenanceClosure({
      root: fact('root', {}),
      caps: { ...CAPS, maxFacts: 2 },
      visible: allVisible,
      fetchByIds: makeDb([]).fetchByIds,
      fetchEdges: edb.fetchEdges,
    });
    expect(out.edges).toHaveLength(2);
    expect(out.truncated.fanout).toBe(true);
  });
});
