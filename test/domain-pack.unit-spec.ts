/**
 * Domain Pack standard — manifest validation + seed assembly (namespacing,
 * collision detection) + the code-memory pack wiring.
 */
import {
  assembleSeed,
  composePredicateId,
  diffPackUpgrade,
  packChecksum,
  validatePack,
  DomainPackError,
  SEED_DOC_MAX_CHARS,
  SEED_MAX_DOCS,
  SEED_TOTAL_MAX_CHARS,
  type DomainPackManifest,
  type PackPredicate,
  type PackSeedDocument,
} from '../src/ai/domain-packs';
import { computeHash } from '../src/ai/predicate-registry-internals/db-mapping';
import {
  CODE_MEMORY_PACK,
  CODE_MEMORY_PREDICATE_IDS,
  codeMemoryKindOf,
  codeMemoryPredicateId,
  SEED_PREDICATES,
} from '../src/ai/domain-packs';
import type { PredicateDefinition } from '../src/ai/predicate-registry-internals/types';

function packPredicate(localId: string): PackPredicate {
  return {
    localId,
    displayLabel: localId,
    description: 'x',
    datatype: 'string',
    semantics: 'append_only',
    decayHalfLifeDays: null,
    piiClass: 'none',
    status: 'active',
  };
}
function pack(over: Partial<DomainPackManifest>): DomainPackManifest {
  return {
    id: 'demo',
    version: '0.1.0',
    description: 'demo',
    predicates: [packPredicate('thing')],
    ...over,
  };
}
function corePredicate(predicateId: string): PredicateDefinition {
  return {
    predicateId,
    displayLabel: predicateId,
    description: 'x',
    datatype: 'string',
    semantics: 'append_only',
    decayHalfLifeDays: null,
    piiClass: 'none',
    status: 'active',
    createdBy: 'system',
  };
}

describe('validatePack', () => {
  it('accepts a well-formed pack', () => {
    expect(() => validatePack(pack({}))).not.toThrow();
  });
  it('rejects a non-snake_case pack id', () => {
    expect(() => validatePack(pack({ id: 'Demo-Pack' }))).toThrow(DomainPackError);
  });
  it('rejects a pack id containing the namespace separator', () => {
    expect(() => validatePack(pack({ id: 'a__b' }))).toThrow(/__/);
  });
  it('rejects a non-semver version', () => {
    expect(() => validatePack(pack({ version: '1.0' }))).toThrow(/semver/);
  });
  it('rejects an empty predicate set', () => {
    expect(() => validatePack(pack({ predicates: [] }))).toThrow(/no predicates/);
  });
  it('rejects duplicate localIds', () => {
    expect(() =>
      validatePack(
        pack({ predicates: [packPredicate('x'), packPredicate('x')] }),
      ),
    ).toThrow(/duplicate/);
  });
  it('rejects a localId containing the separator', () => {
    expect(() =>
      validatePack(pack({ predicates: [packPredicate('a__b')] })),
    ).toThrow(DomainPackError);
  });
  it('rejects a pack id ending in underscore (uninstall-prefix collision)', () => {
    expect(() => validatePack(pack({ id: 'foo_' }))).toThrow(/underscore/);
  });
  it('rejects a bad semantics enum (would be a DB ASSERT 500 mid-install)', () => {
    const bad = { ...packPredicate('x'), semantics: 'sometimes' as never };
    expect(() => validatePack(pack({ predicates: [bad] }))).toThrow(/semantics/);
  });
  it('rejects a bad piiClass enum', () => {
    const bad = { ...packPredicate('x'), piiClass: 'secret' as never };
    expect(() => validatePack(pack({ predicates: [bad] }))).toThrow(/piiClass/);
  });
  it('rejects a non-array predicates field', () => {
    expect(() =>
      validatePack(pack({ predicates: 42 as never })),
    ).toThrow(/must be an array/);
  });
  it('accepts a well-formed extractionProfile', () => {
    expect(() =>
      validatePack(
        pack({
          extractionProfile: {
            guidance: 'read this domain carefully',
            fewShot: [{ text: 'sample', note: 'what to extract' }],
          },
        }),
      ),
    ).not.toThrow();
  });
  it('rejects a non-string extractionProfile.guidance', () => {
    expect(() =>
      validatePack(
        pack({ extractionProfile: { guidance: 42 as unknown as string } }),
      ),
    ).toThrow(/guidance must be a string/);
  });
  it('rejects a malformed extractionProfile.fewShot entry', () => {
    expect(() =>
      validatePack(
        pack({
          extractionProfile: {
            fewShot: [{ text: 'ok' } as unknown as { text: string; note: string }],
          },
        }),
      ),
    ).toThrow(/fewShot entries must be/);
  });
});

describe('validateSeedDocuments (via validatePack)', () => {
  function seed(over: Partial<PackSeedDocument> = {}): PackSeedDocument {
    return {
      localId: 'primer',
      title: 'Domain primer',
      text: 'Some seed knowledge.',
      vertical: 'demo',
      ...over,
    };
  }

  it('accepts a well-formed seed document set', () => {
    expect(() =>
      validatePack(
        pack({
          seedDocuments: [
            seed({
              originUri: 'https://example.com/primer',
              occurredAt: '2026-01-01T00:00:00Z',
              meta: { audience: 'agents', priority: 2, curated: true },
            }),
            seed({ localId: 'glossary' }),
          ],
        }),
      ),
    ).not.toThrow();
  });
  it('rejects duplicate seed localIds', () => {
    expect(() =>
      validatePack(pack({ seedDocuments: [seed(), seed()] })),
    ).toThrow(/duplicate seed document localId/);
  });
  it('rejects a non-snake_case seed localId', () => {
    expect(() =>
      validatePack(pack({ seedDocuments: [seed({ localId: 'Primer-1' })] })),
    ).toThrow(DomainPackError);
  });
  it('rejects a seed localId containing the namespace separator', () => {
    expect(() =>
      validatePack(pack({ seedDocuments: [seed({ localId: 'a__b' })] })),
    ).toThrow(/__/);
  });
  it('rejects a seed text over the per-document cap', () => {
    expect(() =>
      validatePack(
        pack({
          seedDocuments: [seed({ text: 'x'.repeat(SEED_DOC_MAX_CHARS + 1) })],
        }),
      ),
    ).toThrow(/per-document cap/);
  });
  it('rejects seed texts over the combined cap', () => {
    const chunk = 'x'.repeat(SEED_DOC_MAX_CHARS);
    const docs = Array.from(
      { length: Math.ceil(SEED_TOTAL_MAX_CHARS / SEED_DOC_MAX_CHARS) + 1 },
      (_, i) => seed({ localId: `doc_${i}`, text: chunk }),
    );
    expect(() => validatePack(pack({ seedDocuments: docs }))).toThrow(
      /chars of text combined/,
    );
  });
  it('rejects a seed without a vertical', () => {
    expect(() =>
      validatePack(
        pack({
          seedDocuments: [seed({ vertical: undefined as unknown as string })],
        }),
      ),
    ).toThrow(/vertical/);
  });
  it('rejects an unparseable occurredAt', () => {
    expect(() =>
      validatePack(pack({ seedDocuments: [seed({ occurredAt: 'yesterday' })] })),
    ).toThrow(/occurredAt/);
  });
  it('rejects non-scalar meta values', () => {
    expect(() =>
      validatePack(
        pack({
          seedDocuments: [
            seed({
              meta: { nested: { deep: true } } as unknown as PackSeedDocument['meta'],
            }),
          ],
        }),
      ),
    ).toThrow(/meta value/);
  });
  it('rejects a non-snake_case meta key', () => {
    expect(() =>
      validatePack(
        pack({ seedDocuments: [seed({ meta: { 'Bad-Key': 'x' } })] }),
      ),
    ).toThrow(/meta key/);
  });
  it(`rejects more than ${SEED_MAX_DOCS} seed documents`, () => {
    const docs = Array.from({ length: SEED_MAX_DOCS + 1 }, (_, i) =>
      seed({ localId: `doc_${i}` }),
    );
    expect(() => validatePack(pack({ seedDocuments: docs }))).toThrow(
      /the cap is/,
    );
  });
  it('changes the pack checksum when a seed text changes', () => {
    const a = pack({ seedDocuments: [seed({ text: 'version one' })] });
    const b = pack({ seedDocuments: [seed({ text: 'version two' })] });
    expect(packChecksum(a)).not.toBe(packChecksum(b));
  });
});

describe('assembleSeed', () => {
  it('namespaces pack predicates and keeps core unchanged', () => {
    const core = [corePredicate('name')];
    const merged = assembleSeed(core, [
      pack({ id: 'demo', predicates: [packPredicate('thing')] }),
    ]);
    const ids = merged.map((p) => p.predicateId);
    expect(ids).toContain('name');
    expect(ids).toContain('demo__thing');
    expect(merged.find((p) => p.predicateId === 'demo__thing')?.createdBy).toBe(
      'system',
    );
  });

  it('throws on a pack-vs-pack id collision', () => {
    expect(() =>
      assembleSeed(
        [],
        [
          pack({ id: 'dup', predicates: [packPredicate('x')] }),
          pack({ id: 'dup', predicates: [packPredicate('x')] }),
        ],
      ),
    ).toThrow(/collision/);
  });

  it('throws on a pack-vs-core id collision', () => {
    expect(() =>
      assembleSeed(
        [corePredicate('p__x')],
        [pack({ id: 'p', predicates: [packPredicate('x')] })],
      ),
    ).toThrow(/collision/);
  });
});

describe('packChecksum', () => {
  it('is deterministic and independent of key order', () => {
    const a = pack({ id: 'demo', version: '1.2.3' });
    const b = { version: '1.2.3', predicates: a.predicates, description: 'demo', id: 'demo' };
    expect(packChecksum(a)).toBe(packChecksum(b as DomainPackManifest));
  });
  it('changes when content changes', () => {
    const a = pack({ version: '1.0.0' });
    const c = pack({ version: '1.0.1' });
    expect(packChecksum(a)).not.toBe(packChecksum(c));
  });
});

describe('diffPackUpgrade', () => {
  it('detects a redefined predicate (piiClass change) as changed', () => {
    const prior = pack({ id: 'med', predicates: [packPredicate('dx')] });
    const bumped = {
      ...packPredicate('dx'),
      piiClass: 'sensitive' as const,
    };
    const next = pack({ id: 'med', predicates: [bumped] });
    const { changed, removedIds } = diffPackUpgrade('med', prior, next);
    expect(changed).toHaveLength(1);
    expect(changed[0]!.predicateId).toBe('med__dx');
    expect(changed[0]!.piiClass).toBe('sensitive');
    expect(changed[0]!.createdBy).toBe('admin');
    expect(removedIds).toEqual([]);
  });

  it('flags a predicate dropped by the new manifest as removed', () => {
    const prior = pack({
      id: 'med',
      predicates: [packPredicate('dx'), packPredicate('rx')],
    });
    const next = pack({ id: 'med', predicates: [packPredicate('dx')] });
    const { changed, removedIds } = diffPackUpgrade('med', prior, next);
    expect(changed).toEqual([]);
    expect(removedIds).toEqual(['med__rx']);
  });

  it('leaves genuinely new predicates to seedMissingPredicates (not "changed")', () => {
    const prior = pack({ id: 'med', predicates: [packPredicate('dx')] });
    const next = pack({
      id: 'med',
      predicates: [packPredicate('dx'), packPredicate('rx')],
    });
    const { changed, removedIds } = diffPackUpgrade('med', prior, next);
    expect(changed).toEqual([]);
    expect(removedIds).toEqual([]);
  });

  it('is a no-op when the manifest is unchanged', () => {
    const p = pack({ id: 'med', predicates: [packPredicate('dx')] });
    const { changed, removedIds } = diffPackUpgrade('med', p, p);
    expect(changed).toEqual([]);
    expect(removedIds).toEqual([]);
  });

  it('treats an absent prior manifest as all-additions', () => {
    const next = pack({ id: 'med', predicates: [packPredicate('dx')] });
    const { changed, removedIds } = diffPackUpgrade('med', undefined, next);
    expect(changed).toEqual([]);
    expect(removedIds).toEqual([]);
  });
});

describe('computeHash', () => {
  const preds = [corePredicate('name')];
  it('folds extraction profiles into the hash (profile-only change busts it)', () => {
    const bare = computeHash(preds);
    const withProfile = computeHash(preds, [
      { packId: 'med', profile: { guidance: 'v1' } },
    ]);
    const withProfileV2 = computeHash(preds, [
      { packId: 'med', profile: { guidance: 'v2' } },
    ]);
    expect(withProfile).not.toBe(bare);
    expect(withProfileV2).not.toBe(withProfile);
  });
  it('is stable regardless of profile order', () => {
    const a = computeHash(preds, [
      { packId: 'a', profile: { guidance: 'x' } },
      { packId: 'b', profile: { guidance: 'y' } },
    ]);
    const b = computeHash(preds, [
      { packId: 'b', profile: { guidance: 'y' } },
      { packId: 'a', profile: { guidance: 'x' } },
    ]);
    expect(a).toBe(b);
  });
  it('empty profiles === omitted profiles (byte-identical, no-op for profileless tenants)', () => {
    expect(computeHash(preds, [])).toBe(computeHash(preds));
  });
});

describe('composePredicateId', () => {
  it('joins with the double-underscore separator', () => {
    expect(composePredicateId('code_memory', 'decided')).toBe('code_memory__decided');
  });
});

describe('code-memory pack', () => {
  it('is a valid pack', () => {
    expect(() => validatePack(CODE_MEMORY_PACK)).not.toThrow();
  });
  it('exposes namespaced predicate ids + round-trips kindOf', () => {
    expect(codeMemoryPredicateId('decided')).toBe('code_memory__decided');
    expect(codeMemoryKindOf('code_memory__gotcha')).toBe('gotcha');
    expect(CODE_MEMORY_PREDICATE_IDS).toContain('code_memory__invariant');
  });
  it('is merged into SEED_PREDICATES (namespaced, not bare)', () => {
    const ids = SEED_PREDICATES.map((p) => p.predicateId);
    expect(ids).toContain('code_memory__decided');
    expect(ids).not.toContain('decided');
    // core predicates still present
    expect(ids).toContain('name');
  });
});
