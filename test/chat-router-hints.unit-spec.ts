/**
 * Unit-test for extractPredicateHintsLocally — embedding-based predicate
 * hint extraction. Verifies threshold, ranking, span anchoring, and
 * silent-degrade on failure.
 */
import { extractPredicateHintsLocally } from '../src/admin/chat-router.service';
import type { EmbedderService } from '../src/ai/embedder.service';
import type {
  PredicateSnapshot,
  PredicateDefinition,
} from '../src/ai/predicate-registry.service';

function vec(values: number[]): number[] {
  return values;
}

/** Embeds the message to a fixed vector — tests inject mappings per-case. */
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
  };
}

describe('extractPredicateHintsLocally', () => {
  it('returns [] when snapshot is null', async () => {
    const hints = await extractPredicateHintsLocally(
      'q',
      null,
      mkEmbedder(new Map([['q', vec([1, 0])]])),
      0.4,
      3,
    );
    expect(hints).toEqual([]);
  });

  it('returns [] when snapshot has no embeddings', async () => {
    const hints = await extractPredicateHintsLocally(
      'q',
      mkSnapshot({}),
      mkEmbedder(new Map([['q', vec([1, 0])]])),
      0.4,
      3,
    );
    expect(hints).toEqual([]);
  });

  it('returns [] when message is empty', async () => {
    const hints = await extractPredicateHintsLocally(
      '',
      mkSnapshot({ address: vec([1, 0]) }),
      mkEmbedder(new Map()),
      0.4,
      3,
    );
    expect(hints).toEqual([]);
  });

  it('emits hint for the only predicate above threshold', async () => {
    const snap = mkSnapshot({
      address: vec([1, 0]),
      email: vec([0, 1]),
    });
    const emb = mkEmbedder(new Map([['where lives', vec([1, 0])]]));
    const hints = await extractPredicateHintsLocally(
      'where lives',
      snap,
      emb,
      0.4,
      3,
    );
    expect(hints).toHaveLength(1);
    expect(hints[0].predicateId).toBe('address');
    expect(hints[0].similarity).toBeCloseTo(1, 5);
  });

  it('sorts hints by similarity descending and caps at maxHints', async () => {
    const snap = mkSnapshot({
      address: vec([1, 0, 0]),
      email: vec([0.9, 0.1, 0]),
      phone: vec([0.7, 0.7, 0]),
      status: vec([0, 0, 1]),
    });
    const emb = mkEmbedder(new Map([['x', vec([1, 0, 0])]]));
    const hints = await extractPredicateHintsLocally('x', snap, emb, 0.4, 2);
    expect(hints).toHaveLength(2);
    expect(hints[0].predicateId).toBe('address');
    expect(hints[1].predicateId).toBe('email');
  });

  it('drops predicates whose similarity is below threshold', async () => {
    const snap = mkSnapshot({
      address: vec([1, 0]),
      email: vec([0, 1]),
    });
    // Query at 45° → cosine ≈ 0.707 with each axis
    const emb = mkEmbedder(
      new Map([['x', vec([Math.SQRT1_2, Math.SQRT1_2])]]),
    );
    const tightHints = await extractPredicateHintsLocally(
      'x',
      snap,
      emb,
      0.8,
      3,
    );
    expect(tightHints).toEqual([]);
    const loose = await extractPredicateHintsLocally('x', snap, emb, 0.5, 3);
    expect(loose.map((h) => h.predicateId).sort()).toEqual([
      'address',
      'email',
    ]);
  });

  it('returns triggerSpan covering the whole message', async () => {
    const snap = mkSnapshot({ address: vec([1, 0]) });
    const emb = mkEmbedder(new Map([['where Maria lives', vec([1, 0])]]));
    const hints = await extractPredicateHintsLocally(
      'where Maria lives',
      snap,
      emb,
      0.4,
      3,
    );
    expect(hints[0].triggerSpan).toEqual({
      text: 'where Maria lives',
      start: 0,
      end: 17,
    });
  });

  it('degrades silently when embedder throws', async () => {
    const snap = mkSnapshot({ address: vec([1, 0]) });
    const hints = await extractPredicateHintsLocally(
      'x',
      snap,
      mkEmbedder(new Map(), true),
      0.4,
      3,
    );
    expect(hints).toEqual([]);
  });
});
