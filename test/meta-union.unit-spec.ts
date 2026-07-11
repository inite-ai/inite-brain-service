/**
 * Effective-meta union hardening (audit wave C):
 *   1. the origin-meta LRU is keyed per TENANT — a contentHash shared by
 *      two tenants must never serve tenant A's document meta to tenant B
 *      (the cache is process-global; contentHash is unique only per-DB).
 *   2. the union re-evaluation carries the row's OWN trust/corroboration/
 *      userId, so a COMPOUND deny rule (source.meta.* AND corroboration.*)
 *      still fires on the unioned meta instead of silently passing.
 */
import { applyMetaUnion } from '../src/policy/meta-union';
import { compilePolicySet } from '../src/policy/policy-compile';
import {
  CompiledPolicySet,
  PolicyContext,
  PolicyDocument,
  PolicyDocumentSchema,
} from '../src/policy/policy.types';
import { SurrealService } from '../src/db/surreal.service';

function compile(rules: PolicyDocument['rules']): CompiledPolicySet {
  const parsed = PolicyDocumentSchema.parse({
    name: 'meta-union-test',
    description: '',
    posture: { actions: 'allow', reads: 'allow' },
    mode: 'enforce',
    rules,
  });
  const compiled = compilePolicySet(parsed);
  if (!compiled) throw new Error('unexpected disabled set');
  return compiled;
}

function ctxOf(set: CompiledPolicySet): PolicyContext {
  return {
    companyId: 'co_test',
    keyHash: 'sha256:test',
    sets: [set],
    forceReportOnly: false,
    resolutionError: false,
  };
}

/** Stub Surreal that returns per-tenant documents by contentHash. */
function stubSurreal(
  docsByTenant: Record<string, Array<{ contentHash: string; meta: unknown }>>,
): SurrealService {
  return {
    withCompany: async <R>(
      companyId: string,
      fn: (db: unknown) => Promise<R>,
    ): Promise<R> => {
      const db = {
        query: async (_sql: string, params: { hashes: string[] }) => {
          const docs = (docsByTenant[companyId] ?? []).filter((d) =>
            params.hashes.includes(d.contentHash),
          );
          return [docs];
        },
      };
      return fn(db);
    },
  } as unknown as SurrealService;
}

const publicRow = (hash: string, count = 1) => ({
  predicate: 'tier',
  source: { vertical: 'notes', recorder: 'sync', meta: { data_class: 'public' } },
  corroboration: { originKeys: [`doc:${hash}`], count },
  userId: null,
});

describe('applyMetaUnion tenant isolation + compound rules', () => {
  beforeAll(() => {
    process.env.POLICY_META_UNION_ENABLED = '1';
  });
  afterAll(() => {
    delete process.env.POLICY_META_UNION_ENABLED;
  });

  const piiDeny = compile([
    {
      id: 'meta-pii',
      enabled: true,
      effect: 'deny',
      kind: 'source',
      match: [{ attr: 'source.meta.data_class', op: 'eq', value: 'pii' }],
    },
  ]);

  it('keys the origin-meta cache by tenant — no cross-tenant leak', async () => {
    const ctx = ctxOf(piiDeny);
    const HASH = 'crosstenanthash01';
    // Tenant A owns a PII-classed document with this hash → the corroborated
    // (own-meta clean) row is denied via the union.
    const surreal = stubSurreal({
      co_a: [{ contentHash: HASH, meta: { data_class: 'pii' } }],
      co_b: [], // Tenant B has NO document with this hash.
    });

    const a = await applyMetaUnion({
      surreal,
      companyId: 'co_a',
      ctx,
      rows: [publicRow(HASH)],
    });
    expect(a).toHaveLength(0); // denied through the union

    // Same hash, different tenant: must NOT reuse tenant A's cached pii meta.
    const b = await applyMetaUnion({
      surreal,
      companyId: 'co_b',
      ctx,
      rows: [publicRow(HASH)],
    });
    expect(b).toHaveLength(1); // survives — the cache did not leak across tenants
  });

  it('carries corroboration.count into the union view for compound deny rules', async () => {
    const ctx = ctxOf(
      compile([
        {
          id: 'meta-and-corrob',
          enabled: true,
          effect: 'deny',
          kind: 'source',
          match: [
            { attr: 'source.meta.data_class', op: 'eq', value: 'pii' },
            { attr: 'corroboration.count', op: 'gte', value: 2 },
          ],
        },
      ]),
    );

    // count 2 → BOTH conditions match → denied. Before the fix the union
    // view dropped corroboration, so this rule silently passed (survived).
    const HASH = 'compoundhash01';
    const denied = await applyMetaUnion({
      surreal: stubSurreal({ co_c: [{ contentHash: HASH, meta: { data_class: 'pii' } }] }),
      companyId: 'co_c',
      ctx,
      rows: [publicRow(HASH, 2)],
    });
    expect(denied).toHaveLength(0);

    // count 1 → second condition fails → survives (control).
    const HASH2 = 'compoundhash02';
    const kept = await applyMetaUnion({
      surreal: stubSurreal({ co_c: [{ contentHash: HASH2, meta: { data_class: 'pii' } }] }),
      companyId: 'co_c',
      ctx,
      rows: [publicRow(HASH2, 1)],
    });
    expect(kept).toHaveLength(1);
  });
});
