import { buildEntityExpansionQuery } from '../src/search/internals/query-expansion';
import { resolveRetrievalProfileFor } from '../src/search/retrieval-profile';
import type { FusedRow } from '../src/search/internals/types';

/**
 * Audit W4 #19: no entity-expansion rewrite existed — retrieval
 * discovered entities the query never named and did nothing with them.
 */
function row(name: string | undefined, fusedScore: number): FusedRow {
  return {
    id: `knowledge_fact:${name ?? 'x'}-${fusedScore}`,
    entityId: `knowledge_entity:${name ?? 'x'}`,
    predicate: 'hobby',
    object: 'pottery',
    confidence: 0.9,
    validFrom: '2023-01-01T00:00:00Z',
    recordedAt: '2023-01-01T00:00:00Z',
    status: 'active',
    source: {},
    ...(name
      ? {
          entity: {
            id: `knowledge_entity:${name}`,
            type: 'person',
            canonicalName: name,
          },
        }
      : {}),
    fusedScore,
  } as FusedRow;
}

describe('buildEntityExpansionQuery', () => {
  it('appends top discovered names the query never mentioned', () => {
    const q = buildEntityExpansionQuery('who has cats?', [
      row('Caroline', 0.9),
      row('Melanie', 0.7),
    ]);
    expect(q).toBe('who has cats? Caroline Melanie');
  });

  it('orders by best fused score and caps at three names', () => {
    const q = buildEntityExpansionQuery('who has cats?', [
      row('Dana', 0.2),
      row('Alice', 0.9),
      row('Bob', 0.5),
      row('Carol', 0.7),
      row('Alice', 0.1), // duplicate keeps its best score
    ]);
    expect(q).toBe('who has cats? Alice Carol Bob');
  });

  it('names already present in the query are not anchors', () => {
    expect(
      buildEntityExpansionQuery('what does Caroline like?', [row('Caroline', 0.9)]),
    ).toBeNull();
  });

  it('empty pass, missing entities, or too-short names → null', () => {
    expect(buildEntityExpansionQuery('q', [])).toBeNull();
    expect(buildEntityExpansionQuery('q', [row(undefined, 0.9)])).toBeNull();
    expect(buildEntityExpansionQuery('q', [row('ab', 0.9)])).toBeNull();
  });
});

describe('profile entityExpansion resolution', () => {
  const saved = process.env.RETRIEVAL_ENTITY_EXPANSION;
  afterEach(() => {
    if (saved === undefined) delete process.env.RETRIEVAL_ENTITY_EXPANSION;
    else process.env.RETRIEVAL_ENTITY_EXPANSION = saved;
  });

  it('defaults off; env and per-tenant overrides win', () => {
    delete process.env.RETRIEVAL_ENTITY_EXPANSION;
    expect(resolveRetrievalProfileFor('co_x').entityExpansion).toBe(false);
    process.env.RETRIEVAL_ENTITY_EXPANSION = '1';
    expect(resolveRetrievalProfileFor('co_x').entityExpansion).toBe(true);
    const profile = resolveRetrievalProfileFor('co_y', {
      ...process.env,
      RETRIEVAL_ENTITY_EXPANSION: '0',
      RETRIEVAL_PROFILE_OVERRIDES: JSON.stringify({
        co_y: { entityExpansion: true },
      }),
    });
    expect(profile.entityExpansion).toBe(true);
  });
});
