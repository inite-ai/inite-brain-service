/**
 * #909 step 2: a claim says where it came from — one rule over the
 * writer's stamp and the predicate's declaration.
 */
import { assertionOf, inferredStamp } from '../src/common/assertion';
import {
  deserializeFromRow,
  serializeForInsert,
} from '../src/ai/predicate-registry-internals/db-mapping';
import { validatePack } from '../src/ai/domain-packs/validate';
import { RELATIONSHIP_PACK } from '../src/ai/domain-packs/relationship.pack';
import { diffPackUpgrade } from '../src/ai/domain-packs/upgrade-diff';

describe('assertionOf', () => {
  it('a writer that concludes stamps inferred; that stamp wins', () => {
    const source = {
      recorder: 'arc-composer-v1',
      ...inferredStamp({ recorder: 'arc-composer-v1' }),
    };
    expect(assertionOf(source, 'hypothesis')).toBe('inferred');
    expect(source.inferredBy).toEqual({ recorder: 'arc-composer-v1', modality: 'text' });
  });

  it("else the predicate's declaration; else stated", () => {
    expect(assertionOf({ vertical: 'chat' }, 'hypothesis')).toBe('hypothesis');
    expect(assertionOf({ vertical: 'chat' }, 'confirmed')).toBe('confirmed');
    expect(assertionOf({ vertical: 'chat' })).toBe('stated');
    expect(assertionOf(undefined)).toBe('stated');
  });

  it('an off-contract stamp is ignored, not trusted', () => {
    expect(assertionOf({ assertion: 'gospel' })).toBe('stated');
  });
});

describe('the predicate declaration round-trips and validates', () => {
  it('serialize → deserialize keeps it; an off-contract stored value is dropped', () => {
    const def = deserializeFromRow({
      predicateId: 'relationship__hypothesis',
      semantics: 'append_only',
      piiClass: 'affect',
      assertion: 'hypothesis',
    });
    expect(def.assertion).toBe('hypothesis');
    expect(serializeForInsert(def).assertion).toBe('hypothesis');
    expect(
      deserializeFromRow({
        predicateId: 'x',
        semantics: 'append_only',
        piiClass: 'none',
        assertion: 'nope',
      }).assertion,
    ).toBeUndefined();
  });

  it('the relationship pack declares its guesses and confirmations', () => {
    const by = Object.fromEntries(
      RELATIONSHIP_PACK.predicates.map((p) => [p.localId, p.assertion]),
    );
    expect(by).toMatchObject({ hypothesis: 'hypothesis', hypothesis_confirmed: 'confirmed' });
    expect(by.stated_affect).toBeUndefined();
    expect(by.hypothesis_rejected).toBeUndefined();
  });

  it('pack validation refuses an assertion a predicate cannot declare', () => {
    const bad = {
      ...RELATIONSHIP_PACK,
      predicates: [{ ...RELATIONSHIP_PACK.predicates[0]!, assertion: 'inferred' as never }],
    };
    expect(() => validatePack(bad)).toThrow(/assertion "inferred"/);
  });

  it('a changed declaration is a pack upgrade to re-apply', () => {
    const before = {
      ...RELATIONSHIP_PACK,
      predicates: RELATIONSHIP_PACK.predicates.map((p) => {
        const { assertion: _drop, ...rest } = p;
        return rest;
      }),
    };
    const diff = diffPackUpgrade(RELATIONSHIP_PACK.id, before, RELATIONSHIP_PACK);
    expect(diff.changed.map((p) => p.predicateId).sort()).toEqual([
      'relationship__hypothesis',
      'relationship__hypothesis_confirmed',
    ]);
  });
});
