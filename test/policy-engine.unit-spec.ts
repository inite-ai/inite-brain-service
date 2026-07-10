import { compilePolicySet, denyAllSet } from '../src/policy/policy-compile';
import {
  evaluateAction,
  evaluateRow,
  explainRow,
  toRowView,
} from '../src/policy/policy-engine';
import {
  CompiledPolicySet,
  PolicyContext,
  PolicyDocument,
  PolicyDocumentSchema,
  PolicyRowView,
} from '../src/policy/policy.types';

function compile(doc: Partial<PolicyDocument> & { name?: string }): CompiledPolicySet {
  const parsed = PolicyDocumentSchema.parse({
    name: doc.name ?? 'test-set',
    description: '',
    posture: { actions: 'allow', reads: 'allow' },
    mode: 'enforce',
    rules: [],
    ...doc,
  });
  const compiled = compilePolicySet(parsed);
  if (!compiled) throw new Error('unexpected disabled set');
  return compiled;
}

function ctxOf(...sets: CompiledPolicySet[]): PolicyContext {
  return {
    companyId: 'co_test',
    keyHash: 'sha256:test',
    sets,
    forceReportOnly: false,
    resolutionError: false,
  };
}

const view = (over: Partial<PolicyRowView> = {}): PolicyRowView => ({
  predicate: 'preference',
  piiClass: 'none',
  source: { vertical: 'support', recorder: 'crm' },
  trustSnapshot: { authority: 0.8, learnedTrust: 0.6 },
  corroboration: { count: 2 },
  userId: null,
  ...over,
});

describe('policy-engine action evaluation', () => {
  it('deny overrides allow regardless of rule order', () => {
    const set = compile({
      rules: [
        { id: 'a', effect: 'allow', kind: 'action', enabled: true, actions: ['record_fact'] },
        { id: 'd', effect: 'deny', kind: 'action', enabled: true, actions: ['record_fact'] },
      ],
    });
    expect(evaluateAction(ctxOf(set), 'record_fact').decision).toBe('deny');
  });

  it('default-deny posture blocks unmatched actions; allow rule opens exactly its names', () => {
    const set = compile({
      posture: { actions: 'deny', reads: 'allow' },
      rules: [
        { id: 'ro', effect: 'allow', kind: 'action', enabled: true, actions: ['search_knowledge'] },
      ],
    });
    expect(evaluateAction(ctxOf(set), 'search_knowledge').decision).toBe('allow');
    expect(evaluateAction(ctxOf(set), 'record_fact').decision).toBe('deny');
    expect(evaluateAction(ctxOf(set), 'GET /v1/whatever').decision).toBe('deny');
  });

  it('@readonly macro matches read-kind actions only (registered and auto-named)', () => {
    const set = compile({
      posture: { actions: 'deny', reads: 'allow' },
      rules: [
        { id: 'ro', effect: 'allow', kind: 'action', enabled: true, actions: ['@readonly'] },
      ],
    });
    const ctx = ctxOf(set);
    expect(evaluateAction(ctx, 'search_knowledge').decision).toBe('allow');
    expect(evaluateAction(ctx, 'graph_retrieve').decision).toBe('allow');
    expect(evaluateAction(ctx, 'GET /v1/stats/overview').decision).toBe('allow');
    expect(evaluateAction(ctx, 'record_fact').decision).toBe('deny');
    expect(evaluateAction(ctx, 'forget_entity').decision).toBe('deny');
    // Unknown non-GET auto-names are conservatively write-kind.
    expect(evaluateAction(ctx, 'POST /v1/unknown').decision).toBe('deny');
  });

  it('@write macro denies every write in one rule', () => {
    const set = compile({
      rules: [
        { id: 'nw', effect: 'deny', kind: 'action', enabled: true, actions: ['@write'] },
      ],
    });
    expect(evaluateAction(ctxOf(set), 'record_fact').decision).toBe('deny');
    expect(evaluateAction(ctxOf(set), 'search_knowledge').decision).toBe('allow');
  });

  it('multiple sets combine most-restrictive: any enforce deny wins', () => {
    const open = compile({ name: 'open-set' });
    const strict = compile({
      name: 'strict-set',
      rules: [
        { id: 'd', effect: 'deny', kind: 'action', enabled: true, actions: ['synthesize'] },
      ],
    });
    expect(evaluateAction(ctxOf(open, strict), 'synthesize').decision).toBe('deny');
    expect(evaluateAction(ctxOf(open, strict), 'search_knowledge').decision).toBe('allow');
  });

  it('report_only set records would_deny but never blocks', () => {
    const doc = compile({
      mode: 'report_only',
      posture: { actions: 'deny', reads: 'allow' },
    });
    const out = evaluateAction(ctxOf(doc), 'record_fact');
    expect(out.decision).toBe('would_deny');
    expect(out.verdicts[0]).toMatchObject({ verdict: 'deny', mode: 'report_only' });
  });

  it('forceReportOnly demotes enforce sets to would_deny', () => {
    const set = compile({ posture: { actions: 'deny', reads: 'allow' } });
    const ctx = { ...ctxOf(set), forceReportOnly: true };
    expect(evaluateAction(ctx, 'record_fact').decision).toBe('would_deny');
  });

  it('disabled rules are ignored at compile time', () => {
    const set = compile({
      rules: [
        { id: 'd', effect: 'deny', kind: 'action', enabled: false, actions: ['@all'] },
      ],
    });
    expect(evaluateAction(ctxOf(set), 'search_knowledge').decision).toBe('allow');
  });

  it('fail-closed denyAllSet blocks everything', () => {
    const ctx = ctxOf(denyAllSet('ghost'));
    expect(evaluateAction(ctx, 'search_knowledge').decision).toBe('deny');
    expect(evaluateRow(ctx, view()).decision).toBe('deny');
  });
});

describe('policy-engine row evaluation', () => {
  it('source equality and in-list rules deny matching rows', () => {
    const set = compile({
      rules: [
        {
          id: 'no-hr', effect: 'deny', kind: 'source', enabled: true,
          match: [{ attr: 'source.vertical', op: 'in', value: ['hr', 'finance'] }],
        },
      ],
    });
    const ctx = ctxOf(set);
    expect(evaluateRow(ctx, view({ source: { vertical: 'hr' } })).decision).toBe('deny');
    expect(evaluateRow(ctx, view({ source: { vertical: 'support' } })).decision).toBe('allow');
  });

  it('numeric threshold rules on trustSnapshot work (the beat-Zep case)', () => {
    const set = compile({
      rules: [
        {
          id: 'low-trust', effect: 'deny', kind: 'source', enabled: true,
          match: [{ attr: 'trust.authority', op: 'lt', value: 0.5 }],
        },
      ],
    });
    const ctx = ctxOf(set);
    expect(evaluateRow(ctx, view({ trustSnapshot: { authority: 0.3 } })).decision).toBe('deny');
    expect(evaluateRow(ctx, view({ trustSnapshot: { authority: 0.9 } })).decision).toBe('allow');
    // Absent attribute never matches a comparator — snapshot-less rows pass.
    expect(evaluateRow(ctx, view({ trustSnapshot: null })).decision).toBe('allow');
  });

  it('conditions inside one rule AND together', () => {
    const set = compile({
      rules: [
        {
          id: 'combo', effect: 'deny', kind: 'source', enabled: true,
          match: [
            { attr: 'source.vertical', op: 'eq', value: 'support' },
            { attr: 'corroboration.count', op: 'lt', value: 2 },
          ],
        },
      ],
    });
    const ctx = ctxOf(set);
    expect(evaluateRow(ctx, view({ corroboration: { count: 1 } })).decision).toBe('deny');
    expect(evaluateRow(ctx, view({ corroboration: { count: 3 } })).decision).toBe('allow');
  });

  it('default-deny reads posture with a single allow rule', () => {
    const set = compile({
      posture: { actions: 'allow', reads: 'deny' },
      rules: [
        {
          id: 'support-only', effect: 'allow', kind: 'source', enabled: true,
          match: [{ attr: 'source.vertical', op: 'eq', value: 'support' }],
        },
      ],
    });
    const ctx = ctxOf(set);
    expect(evaluateRow(ctx, view()).decision).toBe('allow');
    expect(evaluateRow(ctx, view({ source: { vertical: 'sales' } })).decision).toBe('deny');
    // No source at all → allow rule can't match → posture denies.
    expect(evaluateRow(ctx, view({ source: null })).decision).toBe('deny');
  });

  it('prefix, exists/not_exists, provenance.purged and userId attributes', () => {
    const set = compile({
      rules: [
        {
          id: 'purged', effect: 'deny', kind: 'source', enabled: true,
          match: [{ attr: 'provenance.purged', op: 'eq', value: true }],
        },
        {
          id: 'doc-origin', effect: 'deny', kind: 'source', enabled: true,
          match: [{ attr: 'source.originKey', op: 'prefix', value: 'doc:bad' }],
        },
        {
          id: 'personal', effect: 'deny', kind: 'source', enabled: true,
          match: [{ attr: 'userId', op: 'exists' }],
        },
      ],
    });
    const ctx = ctxOf(set);
    expect(
      evaluateRow(ctx, view({ source: { provenancePurged: true } })).decision,
    ).toBe('deny');
    expect(
      evaluateRow(ctx, view({ source: { originKey: 'doc:bad123' } })).decision,
    ).toBe('deny');
    expect(evaluateRow(ctx, view({ userId: 'u42' })).decision).toBe('deny');
    expect(evaluateRow(ctx, view()).decision).toBe('allow');
  });

  it('source.meta dotted paths match projected document metadata', () => {
    const set = compile({
      rules: [
        {
          id: 'no-pii-class', effect: 'deny', kind: 'source', enabled: true,
          match: [{ attr: 'source.meta.data_class', op: 'in', value: ['pii'] }],
        },
      ],
    });
    const ctx = ctxOf(set);
    expect(
      evaluateRow(ctx, view({ source: { meta: { data_class: 'pii' } } })).decision,
    ).toBe('deny');
    expect(
      evaluateRow(ctx, view({ source: { meta: { data_class: 'public' } } })).decision,
    ).toBe('allow');
    expect(evaluateRow(ctx, view({ source: {} })).decision).toBe('allow');
  });

  it('piiClass comes from the lookup passed to toRowView', () => {
    const set = compile({
      rules: [
        {
          id: 'no-pii', effect: 'deny', kind: 'source', enabled: true,
          match: [{ attr: 'piiClass', op: 'in', value: ['identifier', 'sensitive'] }],
        },
      ],
    });
    const rowView = toRowView(
      { predicate: 'dob', source: { vertical: 'crm' } },
      (p) => (p === 'dob' ? 'identifier' : 'none'),
    );
    expect(evaluateRow(ctxOf(set), rowView).decision).toBe('deny');
  });

  it('explainRow traces expected vs actual per condition', () => {
    const set = compile({
      rules: [
        {
          id: 'no-hr', effect: 'deny', kind: 'source', enabled: true,
          match: [{ attr: 'source.vertical', op: 'eq', value: 'hr' }],
        },
      ],
    });
    const traces = explainRow(ctxOf(set), view({ source: { vertical: 'hr' } }));
    expect(traces).toHaveLength(1);
    expect(traces[0].verdict).toBe('deny');
    expect(traces[0].decidedBy).toBe('no-hr');
    expect(traces[0].rules[0].fields?.[0]).toMatchObject({
      attr: 'source.vertical',
      expected: 'hr',
      actual: 'hr',
      matched: true,
    });
  });
});

describe('PolicyDocumentSchema validation', () => {
  const base = {
    name: 'valid-set',
    posture: { actions: 'allow', reads: 'allow' },
    mode: 'enforce',
  };

  it('rejects unknown attributes, bad operators, and missing values', () => {
    expect(
      PolicyDocumentSchema.safeParse({
        ...base,
        rules: [{ id: 'r', effect: 'deny', kind: 'source', match: [{ attr: 'object', op: 'eq', value: 'x' }] }],
      }).success,
    ).toBe(false);
    expect(
      PolicyDocumentSchema.safeParse({
        ...base,
        rules: [{ id: 'r', effect: 'deny', kind: 'source', match: [{ attr: 'trust.authority', op: 'prefix', value: '0.' }] }],
      }).success,
    ).toBe(false);
    expect(
      PolicyDocumentSchema.safeParse({
        ...base,
        rules: [{ id: 'r', effect: 'deny', kind: 'source', match: [{ attr: 'predicate', op: 'eq' }] }],
      }).success,
    ).toBe(false);
  });

  it('rejects duplicate rule ids, kind/field mismatches, unknown macros, bad names', () => {
    expect(
      PolicyDocumentSchema.safeParse({
        ...base,
        rules: [
          { id: 'dup', effect: 'allow', kind: 'action', actions: ['@readonly'] },
          { id: 'dup', effect: 'deny', kind: 'action', actions: ['record_fact'] },
        ],
      }).success,
    ).toBe(false);
    expect(
      PolicyDocumentSchema.safeParse({
        ...base,
        rules: [{ id: 'r', effect: 'deny', kind: 'action', match: [{ attr: 'predicate', op: 'eq', value: 'x' }] }],
      }).success,
    ).toBe(false);
    expect(
      PolicyDocumentSchema.safeParse({
        ...base,
        rules: [{ id: 'r', effect: 'allow', kind: 'action', actions: ['@readwrite'] }],
      }).success,
    ).toBe(false);
    expect(PolicyDocumentSchema.safeParse({ ...base, name: 'Bad Name!' }).success).toBe(false);
  });

  it('accepts a full valid document and defaults enabled=true', () => {
    const parsed = PolicyDocumentSchema.parse({
      ...base,
      rules: [
        { id: 'ro', effect: 'allow', kind: 'action', actions: ['@readonly', 'rest.stats.overview'] },
        {
          id: 's', effect: 'deny', kind: 'source',
          match: [
            { attr: 'source.meta.data_class', op: 'exists' },
            { attr: 'trust.learnedTrust', op: 'lte', value: 0.2 },
          ],
        },
      ],
    });
    expect(parsed.rules[0].enabled).toBe(true);
    expect(parsed.description).toBe('');
  });
});
