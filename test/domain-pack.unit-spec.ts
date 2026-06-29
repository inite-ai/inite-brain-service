/**
 * Domain Pack standard — manifest validation + seed assembly (namespacing,
 * collision detection) + the code-memory pack wiring.
 */
import {
  assembleSeed,
  composePredicateId,
  validatePack,
  DomainPackError,
  type DomainPackManifest,
  type PackPredicate,
} from '../src/ai/domain-packs';
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
