import {
  normalizeEntityId,
  factVisibleToScopes,
  blockedPredicates,
  activeFactWhere,
} from '../src/entities/entity-read.helpers';
import { PREDICATE_POLICIES } from '../src/ingest/conflict-resolver';
import { BrainScope } from '../src/auth/api-key.types';

const PII: BrainScope = 'brain:read_pii';

describe('normalizeEntityId', () => {
  it('strips a knowledge_entity: prefix into bare id + full form', () => {
    expect(normalizeEntityId('knowledge_entity:foo')).toEqual({
      id: 'foo',
      full: 'knowledge_entity:foo',
    });
  });

  it('promotes a bare id to the full table:id form', () => {
    expect(normalizeEntityId('foo')).toEqual({
      id: 'foo',
      full: 'knowledge_entity:foo',
    });
  });

  it('is idempotent — re-normalising never double-prefixes', () => {
    const once = normalizeEntityId('abc123');
    const twice = normalizeEntityId(once.full);
    expect(twice).toEqual(once);
  });

  it('only strips the leading prefix, not an embedded colon', () => {
    expect(normalizeEntityId('knowledge_entity:a:b')).toEqual({
      id: 'a:b',
      full: 'knowledge_entity:a:b',
    });
  });
});

describe('factVisibleToScopes', () => {
  // 'dob' / 'address' are seeded as requiresScope: 'brain:read_pii';
  // 'name' / 'said' are non-PII; an unknown predicate falls to DEFAULT_POLICY.
  it('hides a PII-classed predicate from a caller without the scope', () => {
    expect(factVisibleToScopes('dob', [])).toBe(false);
    expect(factVisibleToScopes('address', [])).toBe(false);
  });

  it('reveals a PII-classed predicate to a caller holding the scope', () => {
    expect(factVisibleToScopes('dob', [PII])).toBe(true);
    expect(factVisibleToScopes('address', [PII])).toBe(true);
  });

  it('always reveals a non-PII predicate regardless of scopes', () => {
    expect(factVisibleToScopes('name', [])).toBe(true);
    expect(factVisibleToScopes('said', [])).toBe(true);
  });

  it('reveals an unknown predicate (DEFAULT_POLICY has no required scope)', () => {
    expect(factVisibleToScopes('zzz_not_a_real_predicate', [])).toBe(true);
  });
});

describe('blockedPredicates', () => {
  it('lists the PII predicates when the caller lacks the scope', () => {
    const blocked = blockedPredicates([]);
    expect(blocked).toContain('dob');
    expect(blocked).toContain('address');
  });

  it('blocks nothing when the caller holds the PII scope', () => {
    expect(blockedPredicates([PII])).toEqual([]);
  });

  it('stays in lockstep with factVisibleToScopes for every known predicate', () => {
    // A predicate is in the DB-side blocklist iff the JS-side row filter
    // would hide it — the two gates must never disagree, or a low-scope
    // caller could move a watermark on a fact it cannot read.
    for (const scopes of [[] as BrainScope[], [PII]]) {
      const blocked = new Set(blockedPredicates(scopes));
      for (const predicate of Object.keys(PREDICATE_POLICIES)) {
        expect(blocked.has(predicate)).toBe(
          !factVisibleToScopes(predicate, scopes),
        );
      }
    }
  });
});

describe('activeFactWhere', () => {
  it('without asOf, gates on believed-now (retractedAt IS NONE) and binds no params', () => {
    const { clauses, params } = activeFactWhere(null);
    expect(clauses).toEqual(['retractedAt IS NONE']);
    expect(params).toEqual({});
  });

  it('with asOf, emits the four-axis bitemporal cutoff and binds $asOf', () => {
    const asOf = new Date('2026-01-02T03:04:05.000Z');
    const { clauses, params } = activeFactWhere(asOf);
    expect(clauses).toEqual([
      'recordedAt <= $asOf',
      '(retractedAt IS NONE OR retractedAt > $asOf)',
      'validFrom <= $asOf',
      '(validUntil IS NONE OR validUntil > $asOf)',
    ]);
    expect(params).toEqual({ asOf });
  });
});
