/**
 * Multilingual Tier 2 — embedder A/B harness (SCAFFOLD).
 *
 * Proves the comparison wiring works AND that no paid call is reachable:
 *   - default env → every arm runs on the StubModel (modelKind 'stub')
 *   - the overall metrics are laid side-by-side per arm, tagged with each
 *     arm's canonical embeddingSpaceId
 *   - the live gate is inherited from Tier 0: live flag without a key throws
 *     rather than billing
 *   - a degraded arm visibly diverges from a perfect arm (scorers wired)
 */
import { multilingualMatrix } from '../src/eval/scenarios';
import { MultilingualAbHarness, DEFAULT_AB_ARMS } from './eval/multilingual/ab-harness';

describe('MultilingualAbHarness — stub-only comparison (no paid eval)', () => {
  const harness = new MultilingualAbHarness();

  it('default env → all arms are stub, never a live model', () => {
    const cmp = harness.run(multilingualMatrix, DEFAULT_AB_ARMS, {});
    expect(cmp.modelKind).toBe('stub');
    expect(cmp.arms.map((a) => a.arm)).toEqual(['openai', 'bge-m3', 'bge-m3+reranker']);
    for (const arm of cmp.arms) expect(arm.report.modelKind).toBe('stub');
  });

  it('tags each arm with its canonical embeddingSpaceId + reranker flag', () => {
    const cmp = harness.run(multilingualMatrix, DEFAULT_AB_ARMS, {});
    const byName = new Map(cmp.arms.map((a) => [a.arm, a]));
    expect(byName.get('openai')!.spaceId).toBe('openai:text-embedding-3-small:1536:l2');
    expect(byName.get('bge-m3')!.spaceId).toBe('bge-m3:Xenova/bge-m3:1024:l2');
    expect(byName.get('bge-m3+reranker')!.reranker).toBe(true);
  });

  it('lays overall metrics side-by-side per arm', () => {
    const cmp = harness.run(multilingualMatrix, DEFAULT_AB_ARMS, {});
    const recall = cmp.overallByMetric.find((r) => r.metric === 'recall@1');
    expect(recall).toBeDefined();
    expect(Object.keys(recall!.values).sort()).toEqual(['bge-m3', 'bge-m3+reranker', 'openai']);
    // Perfect-stub arms → recall@1 ≈ 1 for every arm.
    for (const v of Object.values(recall!.values)) expect(v).toBeCloseTo(1, 6);
  });

  it('a degraded arm diverges from a perfect arm (scorers actually wired)', () => {
    const cmp = harness.run(
      multilingualMatrix,
      [
        { name: 'perfect', spaceId: 'openai:m:1536:l2', stubMode: 'perfect' },
        { name: 'degraded', spaceId: 'bge-m3:m:1024:l2', stubMode: 'degraded' },
      ],
      {},
    );
    const recall = cmp.overallByMetric.find((r) => r.metric === 'recall@1')!;
    expect(recall.values.perfect).toBeCloseTo(1, 6);
    expect(recall.values.degraded).toBe(0);
  });

  it('inherits the Tier-0 spend gate: live flag without a key throws (never bills)', () => {
    expect(harness.isLive({})).toBe(false);
    expect(harness.isLive({ MULTILINGUAL_EVAL_LIVE: '1' })).toBe(true);
    expect(() =>
      harness.run(multilingualMatrix, DEFAULT_AB_ARMS, { MULTILINGUAL_EVAL_LIVE: '1' }),
    ).toThrow(/refusing to construct a live model/i);
  });
});
