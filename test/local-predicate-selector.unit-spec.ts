/**
 * Unit-test for LocalPredicateSelectorService.rank() — embed clause
 * vs predicate snapshot embeddings → cosine ranking. Mocks the
 * embedder so the test is deterministic without OpenAI.
 */
import { LocalPredicateSelectorService } from '../src/ai/local-predicate-selector.service';
import type { EmbedderService } from '../src/ai/embedder.service';
import type {
  PredicateSnapshot,
  PredicateDefinition,
} from '../src/ai/predicate-registry.service';

function mkEmbedder(
  map: Map<string, number[]>,
  fail = false,
): EmbedderService {
  return {
    embed: async (text: string) => {
      if (fail) throw new Error('boom');
      const hit = map.get(text);
      if (!hit) throw new Error(`no mock for "${text}"`);
      return hit;
    },
  } as unknown as EmbedderService;
}

function mkSnapshot(
  embeddings: Record<string, number[]>,
): PredicateSnapshot {
  const active: PredicateDefinition[] = Object.keys(embeddings).map((id) => ({
    predicateId: id,
    displayLabel: id,
    description: '',
    datatype: 'string',
    semantics: 'append_only',
    decayHalfLifeDays: null,
    piiClass: 'none',
    status: 'active',
    createdBy: 'system',
  }));
  return {
    versionHash: 'test',
    active,
    byId: new Map(active.map((p) => [p.predicateId, p])),
    aliasMap: new Map(),
    embeddings: new Map(Object.entries(embeddings)),
    extractionProfiles: [],
  };
}

describe('LocalPredicateSelectorService.rank', () => {
  it('returns [] on null snapshot', async () => {
    const svc = new LocalPredicateSelectorService(
      mkEmbedder(new Map([['q', [1, 0]]])),
    );
    expect(await svc.rank('q', null)).toEqual([]);
  });

  it('returns [] on snapshot with no embeddings', async () => {
    const svc = new LocalPredicateSelectorService(
      mkEmbedder(new Map([['q', [1, 0]]])),
    );
    expect(await svc.rank('q', mkSnapshot({}))).toEqual([]);
  });

  it('returns [] on empty clause', async () => {
    const svc = new LocalPredicateSelectorService(mkEmbedder(new Map()));
    expect(
      await svc.rank('   ', mkSnapshot({ address: [1, 0] })),
    ).toEqual([]);
  });

  it('returns [] when embedder fails', async () => {
    const svc = new LocalPredicateSelectorService(
      mkEmbedder(new Map(), true),
    );
    expect(
      await svc.rank('q', mkSnapshot({ address: [1, 0] })),
    ).toEqual([]);
  });

  it('ranks predicates by cosine similarity descending', async () => {
    const svc = new LocalPredicateSelectorService(
      mkEmbedder(new Map([['Maria is the CTO at Acme', [1, 0, 0]]])),
    );
    const snap = mkSnapshot({
      status: [1, 0, 0],
      address: [0, 1, 0],
      preference: [0, 0, 1],
    });
    const ranked = await svc.rank('Maria is the CTO at Acme', snap);
    expect(ranked[0].predicateId).toBe('status');
    expect(ranked[0].similarity).toBeCloseTo(1, 5);
    expect(ranked[1].similarity).toBeLessThan(ranked[0].similarity);
  });

  it('respects topN cap', async () => {
    const svc = new LocalPredicateSelectorService(
      mkEmbedder(new Map([['q', [1, 0, 0]]])),
    );
    const snap = mkSnapshot({
      a: [1, 0, 0],
      b: [0.9, 0.1, 0],
      c: [0.7, 0.7, 0],
      d: [0, 0, 1],
    });
    const ranked = await svc.rank('q', snap, 2);
    expect(ranked).toHaveLength(2);
    expect(ranked.map((r) => r.predicateId)).toEqual(['a', 'b']);
  });

  it('top-1 wins when clause semantically aligned with predicate', async () => {
    // Simulate the demo: clause is "She lives in Berlin" embedded into
    // a vector closer to `address` than `status`.
    const svc = new LocalPredicateSelectorService(
      mkEmbedder(
        new Map([['She lives in Berlin', [0.1, 0.95, 0.1]]]),
      ),
    );
    const snap = mkSnapshot({
      address: [0, 1, 0],
      status: [1, 0, 0],
      preference: [0, 0, 1],
    });
    const ranked = await svc.rank('She lives in Berlin', snap);
    expect(ranked[0].predicateId).toBe('address');
  });
});
