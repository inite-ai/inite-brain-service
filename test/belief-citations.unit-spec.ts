/**
 * Belief citations (BELIEFS_SERVING_LANE) — the pure seams
 * (the fragment-citations.unit-spec sibling):
 *
 *  - resolveBeliefCitations: the rendered-set fence (unknown ids
 *    dropped + counted, never surfaced), rendered-excerpt-only, the
 *    one-of invariant (belief arm only — no episodeId, no fragmentId,
 *    no capability stamp), dedupe, the cap, and the defensive parse of
 *    malformed generator entries;
 *  - resolveAndCountBeliefCitations: absent fence map ⇒ [] (flag off /
 *    nothing rendered — the byte-identical default path), and the
 *    per-outcome metric emission.
 */
import {
  resolveBeliefCitations,
  resolveAndCountBeliefCitations,
  type CitableBelief,
} from '../src/synthesize/belief-citations';

const belief = (id: string, over: Partial<CitableBelief> = {}): CitableBelief => ({
  beliefId: id,
  subject: 'inventory service',
  field: 'database',
  value: 'SurrealDB',
  excerpt: 'inventory service — database: SurrealDB (was: PostgreSQL)',
  occurredAt: '2026-08-01T00:00:00.000Z',
  ...over,
});

const renderedSet = (...beliefs: CitableBelief[]): Map<string, CitableBelief> =>
  new Map(beliefs.map((b) => [b.beliefId, b]));

describe('resolveBeliefCitations — the rendered-set fence', () => {
  it('a rendered id resolves to a belief-arm citation carrying the RENDERED excerpt', () => {
    const { citations, counts } = resolveBeliefCitations(
      ['semantic_belief:b1'],
      renderedSet(belief('semantic_belief:b1')),
    );
    expect(citations).toEqual([
      {
        beliefId: 'semantic_belief:b1',
        excerpt: 'inventory service — database: SurrealDB (was: PostgreSQL)',
        occurredAt: '2026-08-01T00:00:00.000Z',
      },
    ]);
    expect(counts).toEqual({ cited: 1, dropped_unknown: 0 });
    // ONE-OF invariant: the belief arm never carries the other arms —
    // and no capability stamp (text baseline only for the 0113 gate).
    expect(citations[0]!.episodeId).toBeUndefined();
    expect(citations[0]!.fragmentId).toBeUndefined();
    expect(citations[0]!.capability).toBeUndefined();
  });

  it('an id NOT in the rendered set is dropped and counted — never surfaced', () => {
    const { citations, counts } = resolveBeliefCitations(
      ['semantic_belief:hallucinated', 'semantic_belief:b1'],
      renderedSet(belief('semantic_belief:b1')),
    );
    expect(citations).toHaveLength(1);
    expect(citations[0]!.beliefId).toBe('semantic_belief:b1');
    expect(counts).toEqual({ cited: 1, dropped_unknown: 1 });
  });

  it('malformed entries (non-string, empty, wrong-key object) are dropped and counted', () => {
    const { citations, counts } = resolveBeliefCitations(
      [42, '', null, { other: 'semantic_belief:b1' }, { beliefId: 'semantic_belief:b1' }],
      renderedSet(belief('semantic_belief:b1')),
    );
    // The tolerated {beliefId} object form resolves; the rest drop.
    expect(citations).toHaveLength(1);
    expect(counts).toEqual({ cited: 1, dropped_unknown: 4 });
  });

  it('dedupes by beliefId — a repeated cite ships once and counts once', () => {
    const { citations, counts } = resolveBeliefCitations(
      ['semantic_belief:b1', 'semantic_belief:b1'],
      renderedSet(belief('semantic_belief:b1')),
    );
    expect(citations).toHaveLength(1);
    expect(counts.cited).toBe(1);
  });

  it('caps resolved citations at 16', () => {
    const many = Array.from({ length: 20 }, (_, i) => belief(`semantic_belief:b${i}`));
    const { citations } = resolveBeliefCitations(
      many.map((b) => b.beliefId),
      renderedSet(...many),
    );
    expect(citations).toHaveLength(16);
  });

  it('omits occurredAt when the rendered belief has none', () => {
    const { citations } = resolveBeliefCitations(
      ['semantic_belief:b1'],
      renderedSet(belief('semantic_belief:b1', { occurredAt: undefined })),
    );
    expect('occurredAt' in citations[0]!).toBe(false);
  });
});

describe('resolveAndCountBeliefCitations — the service-facing wrapper', () => {
  it('absent fence map ⇒ [] (flag off / nothing rendered — byte-identical default)', () => {
    const counted: Array<[string, number]> = [];
    const out = resolveAndCountBeliefCitations({
      citedBeliefIds: ['semantic_belief:b1'],
      beliefsById: undefined,
      metrics: { countBeliefCitation: (o, n) => counted.push([o, n ?? 1]) },
    });
    expect(out).toEqual([]);
    expect(counted).toEqual([]);
  });

  it('emits one metric count per non-zero outcome', () => {
    const counted: Array<[string, number]> = [];
    const out = resolveAndCountBeliefCitations({
      citedBeliefIds: ['semantic_belief:b1', 'semantic_belief:nope', 'semantic_belief:nah'],
      beliefsById: renderedSet(belief('semantic_belief:b1')),
      metrics: { countBeliefCitation: (o, n) => counted.push([o, n ?? 1]) },
    });
    expect(out).toHaveLength(1);
    expect(counted).toEqual([
      ['cited', 1],
      ['dropped_unknown', 2],
    ]);
  });

  it('undefined citedBeliefIds with a populated map ⇒ [] and zero counts', () => {
    const counted: Array<[string, number]> = [];
    const out = resolveAndCountBeliefCitations({
      citedBeliefIds: undefined,
      beliefsById: renderedSet(belief('semantic_belief:b1')),
      metrics: { countBeliefCitation: (o, n) => counted.push([o, n ?? 1]) },
    });
    expect(out).toEqual([]);
    expect(counted).toEqual([]);
  });
});
