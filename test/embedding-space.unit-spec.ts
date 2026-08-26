/**
 * Multilingual Tier 2 — canonical embedding-space helpers.
 *
 * Pins the id FORMAT (provider:model:dim:norm) and the EXPLICIT
 * compatibility test (different dim / model / norm ⇒ incompatible), plus the
 * providerId → space-id derivation the embedder guard relies on.
 */
import {
  embeddingSpaceId,
  embeddingSpaceIdFromProviderId,
  parseEmbeddingSpaceId,
  spacesCompatible,
  describeSpaceIncompatibility,
  EMBEDDING_SPACE_FIELD,
  EMBEDDING_TABLES,
} from '../src/ai/embedder/embedding-space';

describe('embeddingSpaceId — canonical descriptor', () => {
  it('formats provider:model:dim:norm', () => {
    expect(
      embeddingSpaceId({
        provider: 'openai',
        model: 'text-embedding-3-small',
        dim: 1536,
        norm: 'l2',
      }),
    ).toBe('openai:text-embedding-3-small:1536:l2');
    expect(
      embeddingSpaceId({ provider: 'bge-m3', model: 'Xenova/bge-m3', dim: 1024, norm: 'l2' }),
    ).toBe('bge-m3:Xenova/bge-m3:1024:l2');
  });

  it('is a pure function — identical config ⇒ identical id', () => {
    const cfg = { provider: 'openai', model: 'm', dim: 8, norm: 'l2' } as const;
    expect(embeddingSpaceId(cfg)).toBe(embeddingSpaceId({ ...cfg }));
  });
});

describe('embeddingSpaceIdFromProviderId', () => {
  it('derives the space id from a vendor:model:dim providerId + norm', () => {
    expect(embeddingSpaceIdFromProviderId('openai:text-embedding-3-small:1536', 'l2')).toBe(
      'openai:text-embedding-3-small:1536:l2',
    );
    expect(embeddingSpaceIdFromProviderId('bge-m3:Xenova/bge-m3:1024', 'l2')).toBe(
      'bge-m3:Xenova/bge-m3:1024:l2',
    );
  });

  it('returns null for a non-three-part providerId (e.g. a stub)', () => {
    expect(embeddingSpaceIdFromProviderId('stub', 'l2')).toBeNull();
    expect(embeddingSpaceIdFromProviderId('vendor:model', 'l2')).toBeNull();
    expect(embeddingSpaceIdFromProviderId('openai:model:notanumber', 'l2')).toBeNull();
  });
});

describe('parseEmbeddingSpaceId', () => {
  it('round-trips a canonical id (model with a slash)', () => {
    expect(parseEmbeddingSpaceId('bge-m3:Xenova/bge-m3:1024:l2')).toEqual({
      provider: 'bge-m3',
      model: 'Xenova/bge-m3',
      dim: 1024,
      norm: 'l2',
    });
  });

  it('rejects malformed ids', () => {
    expect(parseEmbeddingSpaceId('too:short')).toBeNull();
    expect(parseEmbeddingSpaceId('a:b:notnum:l2')).toBeNull();
  });
});

describe('spacesCompatible — the EXPLICIT incompatibility test', () => {
  const openai = 'openai:text-embedding-3-small:1536:l2';
  const bge = 'bge-m3:Xenova/bge-m3:1024:l2';

  it('identical ids are compatible', () => {
    expect(spacesCompatible(openai, openai)).toBe(true);
  });

  it('different DIM ⇒ incompatible', () => {
    const other = 'openai:text-embedding-3-small:1024:l2';
    expect(spacesCompatible(openai, other)).toBe(false);
    expect(describeSpaceIncompatibility(openai, other)).toContain('dim');
  });

  it('different MODEL ⇒ incompatible', () => {
    const other = 'openai:text-embedding-3-large:1536:l2';
    expect(spacesCompatible(openai, other)).toBe(false);
    expect(describeSpaceIncompatibility(openai, other)).toContain('model');
  });

  it('different NORM ⇒ incompatible', () => {
    const other = 'openai:text-embedding-3-small:1536:none';
    expect(spacesCompatible(openai, other)).toBe(false);
    expect(describeSpaceIncompatibility(openai, other)).toContain('norm');
  });

  it('openai vs bge-m3 are incompatible (provider + model + dim differ)', () => {
    expect(spacesCompatible(openai, bge)).toBe(false);
  });

  it('an unparseable id is compatible ONLY with a byte-identical id', () => {
    expect(spacesCompatible('stub', 'stub')).toBe(true);
    expect(spacesCompatible('stub', openai)).toBe(false);
  });

  it('compatible ids ⇒ describeSpaceIncompatibility returns null', () => {
    expect(describeSpaceIncompatibility(openai, openai)).toBeNull();
  });
});

describe('EMBEDDING_TABLES / field constant', () => {
  it('names the column once', () => {
    expect(EMBEDDING_SPACE_FIELD).toBe('embeddingSpaceId');
  });

  it('enumerates every embedding-bearing table with its vector columns', () => {
    const tables = EMBEDDING_TABLES.map((t) => t.table);
    expect(tables).toEqual([
      'knowledge_fact',
      'knowledge_entity',
      'knowledge_predicate',
      'episode',
      'episode_segment',
      'memory_episode',
      'strategy_memory',
      'community_node',
      'procedural_memory',
    ]);
    const fact = EMBEDDING_TABLES.find((t) => t.table === 'knowledge_fact')!;
    expect(fact.vectorFields).toEqual(['embedding', 'altEmbedding']);
  });
});
