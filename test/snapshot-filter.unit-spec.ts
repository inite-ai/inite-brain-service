/**
 * Unit-test for filterSnapshotForPack — the pack-scoped vocabulary view a
 * dedicated indexer extracts with: pack predicates + (by default) core,
 * only the pack's profile, a distinct stable sub-hash.
 */
import { filterSnapshotForPack } from '../src/indexers/snapshot-filter';
import type {
  PredicateDefinition,
  PredicateSnapshot,
} from '../src/ai/predicate-registry-internals/types';

const pred = (predicateId: string): PredicateDefinition =>
  ({
    predicateId,
    displayLabel: predicateId,
    description: 'test',
    datatype: 'string',
    semantics: 'append_only',
    decayHalfLifeDays: 0,
    piiClass: 'none',
    status: 'active',
    createdBy: 'system',
  }) as unknown as PredicateDefinition;

const snapshot = (): PredicateSnapshot => {
  const active = [
    pred('works_at'),
    pred('prefers'),
    pred('real_estate__zoned_as'),
    pred('real_estate__valued_at'),
    pred('fintech__regulated_by'),
  ];
  return {
    versionHash: 'abc123',
    active,
    byId: new Map(active.map((p) => [p.predicateId, p])),
    aliasMap: new Map([
      ['zoning', 'real_estate__zoned_as'],
      ['oversees', 'fintech__regulated_by'],
    ]),
    embeddings: new Map(active.map((p) => [p.predicateId, [0.1, 0.2]])),
    extractionProfiles: [
      { packId: 'real_estate', profile: { guidance: 'RE guidance' } },
      { packId: 'fintech', profile: { guidance: 'FT guidance' } },
    ],
  };
};

describe('filterSnapshotForPack', () => {
  it('keeps the pack predicates plus core by default', () => {
    const out = filterSnapshotForPack(snapshot(), { packId: 'real_estate' });
    expect(out.active.map((p) => p.predicateId).sort()).toEqual([
      'prefers',
      'real_estate__valued_at',
      'real_estate__zoned_as',
      'works_at',
    ]);
  });

  it('drops core when includeCorePredicates=false', () => {
    const out = filterSnapshotForPack(snapshot(), {
      packId: 'real_estate',
      includeCorePredicates: false,
    });
    expect(out.active.map((p) => p.predicateId).sort()).toEqual([
      'real_estate__valued_at',
      'real_estate__zoned_as',
    ]);
  });

  it('keeps only the pack profile', () => {
    const out = filterSnapshotForPack(snapshot(), { packId: 'real_estate' });
    expect(out.extractionProfiles).toEqual([
      { packId: 'real_estate', profile: { guidance: 'RE guidance' } },
    ]);
  });

  it('prunes aliases whose canonical target left the view', () => {
    const out = filterSnapshotForPack(snapshot(), { packId: 'real_estate' });
    expect(out.aliasMap.has('zoning')).toBe(true);
    expect(out.aliasMap.has('oversees')).toBe(false);
  });

  it('sub-hash is stable, distinct from the full hash and per pack', () => {
    const a1 = filterSnapshotForPack(snapshot(), { packId: 'real_estate' });
    const a2 = filterSnapshotForPack(snapshot(), { packId: 'real_estate' });
    const b = filterSnapshotForPack(snapshot(), { packId: 'fintech' });
    const c = filterSnapshotForPack(snapshot(), {
      packId: 'real_estate',
      includeCorePredicates: false,
    });
    expect(a1.versionHash).toBe(a2.versionHash);
    expect(a1.versionHash).not.toBe('abc123');
    expect(a1.versionHash).not.toBe(b.versionHash);
    expect(a1.versionHash).not.toBe(c.versionHash);
  });
});
