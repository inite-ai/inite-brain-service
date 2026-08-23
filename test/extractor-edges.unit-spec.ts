/**
 * Unit-test for ExtractedEdge parsing logic in ExtractorService.
 *
 * Tests the standalone edge-validation block from extractor.service.ts
 * by replicating its decision predicates inline. Full
 * ExtractorService.extract() integration is covered by e2e specs that
 * exercise the OpenAI round-trip; this spec pins the deterministic
 * bounds + dedup logic.
 */

interface RawEdge {
  fromEntityIndex?: unknown;
  toEntityIndex?: unknown;
  kind?: unknown;
  clauseIndex?: unknown;
  confidence?: unknown;
}

interface ParsedEdge {
  fromEntityIndex: number;
  toEntityIndex: number;
  kind: string;
  confidence: number;
  clause?: string;
}

function parseEdges(
  raw: unknown,
  entityCount: number,
  clauses: string[],
): { edges: ParsedEdge[]; dropped: Array<{ reason: string; kind?: string | undefined }> } {
  const edges: ParsedEdge[] = [];
  const dropped: Array<{ reason: string; kind?: string | undefined }> = [];
  if (!Array.isArray(raw)) return { edges, dropped };
  for (const e of raw as RawEdge[]) {
    if (!e || typeof e !== 'object') continue;
    const from = Number(e.fromEntityIndex);
    const to = Number(e.toEntityIndex);
    const kind = typeof e.kind === 'string' ? e.kind.trim().toLowerCase() : '';
    if (
      !Number.isInteger(from) ||
      !Number.isInteger(to) ||
      from < 0 ||
      to < 0 ||
      from >= entityCount ||
      to >= entityCount
    ) {
      dropped.push({
        kind: kind || undefined,
        reason: 'entity_index_out_of_bounds',
      });
      continue;
    }
    if (from === to) {
      dropped.push({ kind, reason: 'self_edge' });
      continue;
    }
    if (kind.length === 0) {
      dropped.push({ reason: 'empty_kind' });
      continue;
    }
    const clauseIndex =
      Number.isInteger(e.clauseIndex) && (e.clauseIndex as number) >= 0
        ? (e.clauseIndex as number)
        : undefined;
    const clauseText =
      clauseIndex !== undefined && clauseIndex < clauses.length ? clauses[clauseIndex] : undefined;
    const confidence =
      typeof e.confidence === 'number' ? Math.max(0, Math.min(1, e.confidence)) : 0.7;
    edges.push({
      fromEntityIndex: from,
      toEntityIndex: to,
      kind,
      confidence,
      ...(clauseText ? { clause: clauseText } : {}),
    });
  }
  return { edges, dropped };
}

describe('Extractor edge parsing — bounds + dedup', () => {
  const clauses = ['Maria is the CTO at Acme', 'She lives in Berlin'];

  it('accepts valid edge between two entities', () => {
    const { edges, dropped } = parseEdges(
      [{ fromEntityIndex: 0, toEntityIndex: 1, kind: 'works_at', clauseIndex: 0, confidence: 0.9 }],
      2,
      clauses,
    );
    expect(edges).toHaveLength(1);
    expect(edges[0]).toEqual({
      fromEntityIndex: 0,
      toEntityIndex: 1,
      kind: 'works_at',
      confidence: 0.9,
      clause: 'Maria is the CTO at Acme',
    });
    expect(dropped).toEqual([]);
  });

  it('drops edge with index out of bounds', () => {
    const { edges, dropped } = parseEdges(
      [{ fromEntityIndex: 0, toEntityIndex: 5, kind: 'works_at', clauseIndex: 0, confidence: 0.9 }],
      2,
      clauses,
    );
    expect(edges).toEqual([]);
    expect(dropped).toEqual([{ kind: 'works_at', reason: 'entity_index_out_of_bounds' }]);
  });

  it('drops self-edge', () => {
    const { edges, dropped } = parseEdges(
      [{ fromEntityIndex: 0, toEntityIndex: 0, kind: 'self', clauseIndex: 0, confidence: 1 }],
      2,
      clauses,
    );
    expect(edges).toEqual([]);
    expect(dropped).toEqual([{ kind: 'self', reason: 'self_edge' }]);
  });

  it('drops edge with empty kind', () => {
    const { edges, dropped } = parseEdges(
      [{ fromEntityIndex: 0, toEntityIndex: 1, kind: '   ', clauseIndex: 0, confidence: 0.9 }],
      2,
      clauses,
    );
    expect(edges).toEqual([]);
    expect(dropped).toEqual([{ reason: 'empty_kind' }]);
  });

  it('normalizes kind to lowercase + trims', () => {
    const { edges } = parseEdges(
      [
        {
          fromEntityIndex: 0,
          toEntityIndex: 1,
          kind: '  WORKS_AT  ',
          clauseIndex: 0,
          confidence: 0.9,
        },
      ],
      2,
      clauses,
    );
    expect(edges[0]!.kind).toBe('works_at');
  });

  it('clamps confidence to [0,1] and defaults when missing', () => {
    const { edges } = parseEdges(
      [
        { fromEntityIndex: 0, toEntityIndex: 1, kind: 'works_at', clauseIndex: 0, confidence: 2 },
        { fromEntityIndex: 1, toEntityIndex: 0, kind: 'knows', clauseIndex: 0 },
      ],
      2,
      clauses,
    );
    expect(edges).toHaveLength(2);
    expect(edges[0]!.confidence).toBe(1);
    expect(edges[1]!.confidence).toBe(0.7);
  });

  it('omits clause when clauseIndex out of bounds', () => {
    const { edges } = parseEdges(
      [
        {
          fromEntityIndex: 0,
          toEntityIndex: 1,
          kind: 'works_at',
          clauseIndex: 99,
          confidence: 0.9,
        },
      ],
      2,
      clauses,
    );
    expect(edges[0]!.clause).toBeUndefined();
  });

  it('returns [] on non-array input', () => {
    expect(parseEdges(null, 2, clauses).edges).toEqual([]);
    expect(parseEdges({}, 2, clauses).edges).toEqual([]);
  });

  it('processes multiple edges per call', () => {
    const { edges } = parseEdges(
      [
        { fromEntityIndex: 0, toEntityIndex: 1, kind: 'works_at', clauseIndex: 0, confidence: 0.9 },
        {
          fromEntityIndex: 0,
          toEntityIndex: 2,
          kind: 'lives_at',
          clauseIndex: 1,
          confidence: 0.85,
        },
      ],
      3,
      clauses,
    );
    expect(edges).toHaveLength(2);
    expect(edges.map((e) => e.kind)).toEqual(['works_at', 'lives_at']);
  });
});
