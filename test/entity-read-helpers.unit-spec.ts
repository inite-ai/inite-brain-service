import {
  normalizeEntityId,
  blockedPredicates,
  activeFactWhere,
} from '../src/entities/entity-read.helpers';
import { makeRowPolicyFilter } from '../src/policy/row-filter';
import { PREDICATE_POLICIES } from '../src/ingest/conflict-resolver';
import { BrainScope } from '../src/auth/api-key.types';

const PII: BrainScope = 'brain:read_pii';

/** The JS row gate as every read surface applies it (seed lookup,
 *  policy forced off so only the predicate scope gate runs). */
function gateAllows(predicate: string, scopes: BrainScope[]): boolean {
  const f = makeRowPolicyFilter({
    callerScopes: scopes,
    surface: 'entity-read-helpers-spec',
    policy: null,
  });
  const ok = f.filter({ predicate });
  f.finish();
  return ok;
}

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

describe('row-filter predicate scope gate', () => {
  // 'dob' / 'address' are seeded as requiresScope: 'brain:read_pii';
  // 'name' / 'said' are non-PII; an unknown predicate falls to DEFAULT_POLICY.
  it('hides a PII-classed predicate from a caller without the scope', () => {
    expect(gateAllows('dob', [])).toBe(false);
    expect(gateAllows('address', [])).toBe(false);
  });

  it('reveals a PII-classed predicate to a caller holding the scope', () => {
    expect(gateAllows('dob', [PII])).toBe(true);
    expect(gateAllows('address', [PII])).toBe(true);
  });

  it('always reveals a non-PII predicate regardless of scopes', () => {
    expect(gateAllows('name', [])).toBe(true);
    expect(gateAllows('said', [])).toBe(true);
  });

  it('reveals an unknown predicate (DEFAULT_POLICY has no required scope)', () => {
    expect(gateAllows('zzz_not_a_real_predicate', [])).toBe(true);
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

  it('stays in lockstep with the row-filter scope gate for every known predicate', () => {
    // A predicate is in the DB-side blocklist iff the JS-side row filter
    // would hide it — the two gates must never disagree, or a low-scope
    // caller could move a watermark on a fact it cannot read.
    for (const scopes of [[] as BrainScope[], [PII]]) {
      const blocked = new Set(blockedPredicates(scopes));
      for (const predicate of Object.keys(PREDICATE_POLICIES)) {
        expect(blocked.has(predicate)).toBe(!gateAllows(predicate, scopes));
      }
    }
  });
});

describe('activeFactWhere', () => {
  it('without asOf, applies the full believed-and-valid-now closure and binds no params', () => {
    const { clauses, params } = activeFactWhere(null);
    expect(clauses).toEqual([
      'retractedAt IS NONE',
      // Validity window + compacted gate: the old retractedAt-only shape
      // leaked naturally-superseded facts (a supersede sets NO
      // retractedAt — migration 0014), expired facts, and compacted
      // skeletons into profile/summarize/why. Mirrors search's
      // where-builder, including the future-gap supersede rule (a
      // superseded fact whose interval still covers now IS the current
      // value while its successor is future-dated).
      'validFrom <= time::now()',
      '(validUntil IS NONE OR validUntil > time::now())',
      "status != 'compacted'",
      // Corroborating rows (migration 0047) are audit records of a second
      // claim — hidden from profile reads; the incumbent carries the fact.
      "status != 'corroborating'",
      "(status != 'superseded' OR validUntil > time::now())",
    ]);
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
      // Matches where-builder's asOf branch: compacted skeletons stay
      // hidden in point-in-time views too (the compaction summary fact
      // carries the surviving content).
      "status != 'compacted'",
      "status != 'corroborating'",
    ]);
    expect(params).toEqual({ asOf });
  });

  const TX_SUPERSEDE_CLAUSE =
    `((supersededBy IS NOT NONE AND supersededBy.recordedAt > $txAt` +
    ` AND (priorValidUntil IS NONE OR priorValidUntil > $evalAt))` +
    ` OR ((supersededBy IS NONE OR supersededBy.recordedAt <= $txAt)` +
    ` AND (validUntil IS NONE OR validUntil > $evalAt)))`;

  it('with recordedAt, replays belief at tx-time T (window evaluated at T)', () => {
    const txAt = new Date('2026-03-01T00:00:00.000Z');
    const { clauses, params } = activeFactWhere(null, txAt);
    expect(clauses).toEqual([
      'recordedAt <= $txAt',
      // A retraction after T had not happened yet — the fact is believed.
      '(retractedAt IS NONE OR retractedAt > $txAt)',
      'validFrom <= $evalAt',
      // A supersede carries no timestamp of its own; its tx-time is the
      // successor's recordedAt. Recorded after T → the fact was still
      // believed active, with the pre-supersede priorValidUntil window.
      TX_SUPERSEDE_CLAUSE,
      "status != 'compacted'",
      "status != 'corroborating'",
    ]);
    // Without asOf, the world moment defaults to T itself — the honest
    // replay of what the no-param closure returned at wall-clock T.
    expect(params).toEqual({ txAt, evalAt: txAt });
  });

  it('with recordedAt AND asOf, cuts the tx axis at T and evaluates validity at asOf', () => {
    const txAt = new Date('2026-03-01T00:00:00.000Z');
    const asOf = new Date('2026-02-01T00:00:00.000Z');
    const { clauses, params } = activeFactWhere(asOf, txAt);
    // asOf must NOT leak into the tx clauses — the axes stay separate.
    expect(clauses.filter((c) => c.includes('$txAt'))).toEqual([
      'recordedAt <= $txAt',
      '(retractedAt IS NONE OR retractedAt > $txAt)',
      TX_SUPERSEDE_CLAUSE,
    ]);
    expect(params).toEqual({ txAt, evalAt: asOf });
  });

  it('ignores an absent recordedAt — existing branches unchanged', () => {
    expect(activeFactWhere(null, null)).toEqual(activeFactWhere(null));
    const asOf = new Date('2026-01-02T03:04:05.000Z');
    expect(activeFactWhere(asOf, undefined)).toEqual(activeFactWhere(asOf));
  });
});
