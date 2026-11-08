/**
 * #909 step 1: a predicate's sensitivity class is the fence. Before it,
 * only an explicit `requiresScope` gated a read, so the relationship
 * pack's `stated_affect` (classed `sensitive`, no scope) was readable by
 * any brain:read caller.
 */
import {
  PII_CLASSES,
  classRequiredScope,
  fencedClasses,
  withClassScope,
} from '../src/ai/predicate-registry-internals/types';
import { deserializeFromRow } from '../src/ai/predicate-registry-internals/db-mapping';
import { makeRowPolicyFilter } from '../src/policy/row-filter';
import { policyFor } from '../src/ingest/conflict-resolver';
import { beliefClassReadable } from '../src/beliefs/beliefs.service';
import { RELATIONSHIP_PACK } from '../src/ai/domain-packs/relationship.pack';

const READ = ['brain:read'];
const READ_PII = ['brain:read', 'brain:read_pii'];

describe('class → scope', () => {
  it('sensitive, affect and health need brain:read_pii; the rest need nothing', () => {
    expect(PII_CLASSES.filter((c) => classRequiredScope(c) !== undefined)).toEqual([
      'sensitive',
      'affect',
      'health',
    ]);
  });

  it('an explicit requiresScope wins over the class', () => {
    expect(withClassScope({ piiClass: 'none', requiresScope: 'brain:admin' }).requiresScope).toBe(
      'brain:admin',
    );
    expect(withClassScope({ piiClass: 'affect' }).requiresScope).toBe('brain:read_pii');
    expect(withClassScope({ piiClass: 'text' }).requiresScope).toBeUndefined();
  });

  it('fencedClasses: everything scoped for a plain reader, nothing for a PII reader', () => {
    expect(fencedClasses(READ)).toEqual(['sensitive', 'affect', 'health']);
    expect(fencedClasses(READ_PII)).toEqual([]);
  });
});

describe('a tenant registry row fences by its class', () => {
  const row = (piiClass: string) =>
    deserializeFromRow({
      predicateId: 'relationship__stated_affect',
      semantics: 'single_active',
      piiClass,
      status: 'active',
    });

  it('an affect row with no stored scope reads as brain:read_pii', () => {
    expect(row('affect').requiresScope).toBe('brain:read_pii');
    expect(row('sensitive').requiresScope).toBe('brain:read_pii');
    expect(row('behavioral').requiresScope).toBeUndefined();
  });

  it('the row filter drops it for brain:read and keeps it for brain:read_pii', () => {
    const lookup = () => row('affect');
    const fact = { predicate: 'relationship__stated_affect' };
    expect(
      makeRowPolicyFilter({
        callerScopes: READ,
        surface: 't',
        policy: null,
        policyLookup: lookup,
      }).filter(fact),
    ).toBe(false);
    expect(
      makeRowPolicyFilter({
        callerScopes: READ_PII,
        surface: 't',
        policy: null,
        policyLookup: lookup,
      }).filter(fact),
    ).toBe(true);
  });
});

describe('seeds and packs', () => {
  it('the legacy seed lookup keeps dob/address behind brain:read_pii', () => {
    expect(policyFor('dob').requiresScope).toBe('brain:read_pii');
    expect(policyFor('address').requiresScope).toBe('brain:read_pii');
  });

  it('the relationship pack classes feeling and guesses as affect', () => {
    const classes = Object.fromEntries(
      RELATIONSHIP_PACK.predicates.map((p) => [p.localId, p.piiClass]),
    );
    expect(classes).toMatchObject({
      stated_affect: 'affect',
      hypothesis: 'affect',
      hypothesis_confirmed: 'affect',
      hypothesis_rejected: 'affect',
    });
  });
});

describe('beliefs carry their own class (0185)', () => {
  it('an affect belief needs brain:read_pii; an unclassed one reads as before', () => {
    expect(beliefClassReadable({ piiClass: 'affect' }, READ)).toBe(false);
    expect(beliefClassReadable({ piiClass: 'affect' }, READ_PII)).toBe(true);
    expect(beliefClassReadable({}, READ)).toBe(true);
    expect(beliefClassReadable({ piiClass: 'text' }, READ)).toBe(true);
  });
});
