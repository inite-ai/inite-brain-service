/**
 * Typed support graph (Drift-5, 0116) — the pure edge-row assembly
 * module. Pins the endpoint-pairing verdicts (assertEdgeShape,
 * reconstructed_from reserved), the (in, out, kind) dedupe with
 * emission order + SUPPORT_EDGE_CAP, the conflict-verdict directions
 * (SUPERSEDED loser→winner; COMPETING mutual, capped), and the
 * EvidenceRef runtime adoption (classifySupportTarget dispatches the
 * evidence-plane prefixes through parseRecordRef).
 */
import {
  SUPPORT_EDGE_CAP,
  assertEdgeShape,
  buildConflictEdgeRows,
  buildSupportEdgeBatches,
  buildSupportEdgeRows,
  classifySupportTarget,
  isEmittedEdgeKind,
} from '../src/common/support-edges';

describe('classifySupportTarget (EvidenceRef prefix vocabulary)', () => {
  it.each([
    ['knowledge_fact:f1', 'fact'],
    ['memory_episode:s1', 'scene'],
    // The three parseRecordRef arms — the evidence plane and the
    // support graph share ONE prefix vocabulary.
    ['episode:e1', 'episode'],
    ['evidence_fragment:fr1', 'fragment'],
    ['evidence_asset:a1', 'asset'],
    ['knowledge_entity:e1', 'unknown'],
    ['', 'unknown'],
  ])('%s → %s', (raw, expected) => {
    expect(classifySupportTarget(raw)).toBe(expected);
  });
});

describe('assertEdgeShape (endpoint pairing per kind)', () => {
  it('supported_by: fact → scene only', () => {
    expect(assertEdgeShape('supported_by', 'knowledge_fact:f1', 'memory_episode:s1')).toBe(true);
    expect(assertEdgeShape('supported_by', 'knowledge_fact:f1', 'knowledge_fact:f2')).toBe(false);
    expect(assertEdgeShape('supported_by', 'knowledge_fact:f1', 'episode:e1')).toBe(false);
    expect(assertEdgeShape('supported_by', 'memory_episode:s1', 'memory_episode:s2')).toBe(false);
  });

  it('contradicted_by / derived_from: fact → fact only', () => {
    for (const kind of ['contradicted_by', 'derived_from'] as const) {
      expect(assertEdgeShape(kind, 'knowledge_fact:f1', 'knowledge_fact:f2')).toBe(true);
      expect(assertEdgeShape(kind, 'knowledge_fact:f1', 'memory_episode:s1')).toBe(false);
      expect(assertEdgeShape(kind, 'episode:e1', 'knowledge_fact:f2')).toBe(false);
    }
  });

  it('reconstructed_from is RESERVED — always rejected (0106 stays canonical)', () => {
    expect(assertEdgeShape('reconstructed_from', 'knowledge_fact:f1', 'knowledge_fact:f2')).toBe(
      false,
    );
    expect(assertEdgeShape('reconstructed_from', 'memory_episode:s1', 'episode:e1')).toBe(false);
  });

  it('isEmittedEdgeKind excludes the reserved kind', () => {
    expect(isEmittedEdgeKind('supported_by')).toBe(true);
    expect(isEmittedEdgeKind('reconstructed_from')).toBe(false);
    expect(isEmittedEdgeKind('bogus')).toBe(false);
  });
});

describe('buildSupportEdgeRows (dedupe / order / cap / skip)', () => {
  it('dedupes by (in, out, kind) preserving emission order; counts skipped', () => {
    const { rows, skipped } = buildSupportEdgeRows({
      kind: 'derived_from',
      writer: 'promotion_runner',
      pairs: [
        { in: 'knowledge_fact:sum', out: 'knowledge_fact:m2' },
        { in: 'knowledge_fact:sum', out: 'knowledge_fact:m1' },
        { in: 'knowledge_fact:sum', out: 'knowledge_fact:m2' }, // dupe
        { in: 'knowledge_fact:sum', out: 'memory_episode:bad' }, // wrong shape
      ],
    });
    expect(rows.map((r) => r.out)).toEqual(['knowledge_fact:m2', 'knowledge_fact:m1']);
    expect(rows[0]).toEqual({
      in: 'knowledge_fact:sum',
      out: 'knowledge_fact:m2',
      kind: 'derived_from',
      writer: 'promotion_runner',
    });
    expect(skipped).toBe(1);
  });

  it('writerVersion is carried only when supplied', () => {
    const { rows } = buildSupportEdgeRows({
      kind: 'supported_by',
      writer: 'scene_backlink',
      writerVersion: 'seg-v9',
      pairs: [{ in: 'knowledge_fact:f1', out: 'memory_episode:s1' }],
    });
    expect(rows[0]!.writerVersion).toBe('seg-v9');
  });

  it(`caps a single call at SUPPORT_EDGE_CAP (${SUPPORT_EDGE_CAP})`, () => {
    const pairs = Array.from({ length: SUPPORT_EDGE_CAP + 10 }, (_, i) => ({
      in: 'knowledge_fact:sum',
      out: `knowledge_fact:m${i}`,
    }));
    const { rows } = buildSupportEdgeRows({ kind: 'derived_from', writer: 'recompose', pairs });
    expect(rows).toHaveLength(SUPPORT_EDGE_CAP);
    expect(rows[0]!.out).toBe('knowledge_fact:m0');
  });

  it('buildSupportEdgeBatches slices the full deduped set into cap-sized payloads', () => {
    const pairs = Array.from({ length: SUPPORT_EDGE_CAP + 10 }, (_, i) => ({
      in: 'knowledge_fact:sum',
      out: `knowledge_fact:m${i}`,
    }));
    const { batches, skipped } = buildSupportEdgeBatches({
      kind: 'derived_from',
      writer: 'compaction_runner',
      pairs: [...pairs, ...pairs], // full duplicate — deduped away
    });
    expect(skipped).toBe(0);
    expect(batches.map((b) => b.length)).toEqual([SUPPORT_EDGE_CAP, 10]);
    expect(batches[1]![9]!.out).toBe(`knowledge_fact:m${SUPPORT_EDGE_CAP + 9}`);
  });

  it('nothing valid → zero batches (writers then issue zero queries)', () => {
    const { batches, skipped } = buildSupportEdgeBatches({
      kind: 'supported_by',
      writer: 'scene_backlink',
      pairs: [{ in: 'knowledge_fact:f1', out: 'episode:not-a-scene' }],
    });
    expect(batches).toEqual([]);
    expect(skipped).toBe(1);
  });
});

describe('buildConflictEdgeRows (resolver verdicts → contradicted_by)', () => {
  const CAP = 20;

  it('SUPERSEDED: one edge per displaced fact, in = LOSER, out = WINNER', () => {
    const rows = buildConflictEdgeRows(
      {
        outcome: 'SUPERSEDED',
        factId: 'knowledge_fact:winner',
        supersededFactIds: ['knowledge_fact:loser1', 'knowledge_fact:loser2'],
      },
      CAP,
    );
    expect(rows).toEqual([
      {
        in: 'knowledge_fact:loser1',
        out: 'knowledge_fact:winner',
        kind: 'contradicted_by',
        writer: 'fact_resolver',
      },
      {
        in: 'knowledge_fact:loser2',
        out: 'knowledge_fact:winner',
        kind: 'contradicted_by',
        writer: 'fact_resolver',
      },
    ]);
  });

  it('COMPETING: the MUTUAL pair per standing competitor (new fact excluded as its own rival)', () => {
    const rows = buildConflictEdgeRows(
      {
        outcome: 'COMPETING',
        factId: 'knowledge_fact:new',
        competingFactIds: ['knowledge_fact:standing', 'knowledge_fact:new'],
      },
      CAP,
    );
    expect(rows.map((r) => [r.in, r.out])).toEqual([
      ['knowledge_fact:standing', 'knowledge_fact:new'],
      ['knowledge_fact:new', 'knowledge_fact:standing'],
    ]);
  });

  it('COMPETING fan-out is capped (the CONFLICT_OUTCOME_CAP idiom, applied to edges)', () => {
    const rows = buildConflictEdgeRows(
      {
        outcome: 'COMPETING',
        factId: 'knowledge_fact:new',
        competingFactIds: Array.from({ length: 30 }, (_, i) => `knowledge_fact:c${i}`),
      },
      CAP,
    );
    expect(rows).toHaveLength(CAP);
  });

  it.each(['INSERTED', 'CORROBORATED', 'REJECTED', 'SKIPPED'])('%s → no rows', (outcome) => {
    expect(buildConflictEdgeRows({ outcome, factId: 'knowledge_fact:x' }, CAP)).toEqual([]);
  });

  it('no factId (nothing to point at) → no rows, even on SUPERSEDED', () => {
    expect(
      buildConflictEdgeRows(
        { outcome: 'SUPERSEDED', factId: null, supersededFactIds: ['knowledge_fact:l'] },
        CAP,
      ),
    ).toEqual([]);
  });
});
