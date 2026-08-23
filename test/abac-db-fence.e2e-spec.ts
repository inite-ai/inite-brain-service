/**
 * DB-level ABAC fence (migration 0057, ABAC_DB_FENCE_ENABLED) — the
 * prepared defense-in-depth layer behind the app-side row filter.
 *
 * TWO ROLES:
 *   1. Verify the pieces that ARE live: the pushdown compiler and
 *      fn::policy_row_denied evaluate correctly, and the per-request
 *      binding never breaks scoped reads.
 *   2. CANARY the documented finding (0057 header): on the current
 *      stack SurrealDB ignores field PERMISSIONS for the brain_caller
 *      SYSTEM user, so neither the 0005 PII fence nor this policy
 *      fence actually masks values — the app-layer JS filter is the
 *      only active gate. If an upgrade (or a move to record users)
 *      makes PERMISSIONS fire, the canary FAILS on purpose: flip its
 *      expectations, activate the fence, and celebrate.
 */
import { AppFixture, createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { compileDenyPushdown } from '../src/policy/db-fence';
import { compilePolicySet } from '../src/policy/policy-compile';
import { PolicyContext, PolicyDocumentSchema } from '../src/policy/policy.types';

jest.setTimeout(180_000);

const NO_HR = {
  name: 'no-hr-fence',
  description: 'deny hr-vertical facts',
  posture: { actions: 'allow', reads: 'allow' },
  mode: 'enforce',
  rules: [
    {
      id: 'hr-off',
      effect: 'deny',
      kind: 'source',
      match: [{ attr: 'source.vertical', op: 'in', value: ['hr', 'finance'] }],
    },
    {
      id: 'low-trust',
      effect: 'deny',
      kind: 'source',
      match: [{ attr: 'trust.authority', op: 'lt', value: 0.2 }],
    },
  ],
};

function ctxOf(doc: unknown): PolicyContext {
  const compiled = compilePolicySet(PolicyDocumentSchema.parse(doc));
  if (!compiled) throw new Error('set disabled');
  return {
    companyId: 'co_test',
    keyHash: 'sha256:test',
    sets: [compiled],
    forceReportOnly: false,
    resolutionError: false,
  };
}

describe('compileDenyPushdown', () => {
  it('pushes only fully equality-shaped deny rules', () => {
    const deny = compileDenyPushdown(ctxOf(NO_HR));
    // hr-off pushes (in-list on source.vertical); low-trust does NOT
    // (threshold) — a partial pushdown would be a false positive.
    expect(deny).toEqual([{ vertical: ['hr', 'finance'] }]);
  });

  it('returns [] with no context, forceReportOnly, or report_only sets', () => {
    expect(compileDenyPushdown(undefined)).toEqual([]);
    expect(compileDenyPushdown({ ...ctxOf(NO_HR), forceReportOnly: true })).toEqual([]);
    expect(compileDenyPushdown(ctxOf({ ...NO_HR, mode: 'report_only' }))).toEqual([]);
  });
});

describe('DB fence (scoped pool)', () => {
  let f: AppFixture;

  beforeAll(async () => {
    process.env.ABAC_ENABLED = '1';
    process.env.ABAC_DB_FENCE_ENABLED = '1';
    f = await createApp({ enableScopedPool: true });
    for (const [vertical, object, predicate] of [
      ['hr', 'salary spreadsheet location', 'preference'],
      ['support', 'prefers email contact', 'preference'],
      ['rent', '42 Fence Probe St', 'address'],
    ] as const) {
      const r = await f.http
        .post('/v1/ingest/fact')
        .set({ Authorization: `Bearer ${f.apiKey}` })
        .send({
          entityRef: { vertical: 'rent', id: 'subj_db_fence' },
          predicate,
          object,
          validFrom: '2026-01-01',
          confidence: 0.9,
          source: { vertical, recorder: 'bot' },
        });
      expect([200, 201]).toContain(r.status);
    }
  });

  afterAll(async () => {
    delete process.env.ABAC_ENABLED;
    delete process.env.ABAC_DB_FENCE_ENABLED;
    await f.close();
  });

  it('fn::policy_row_denied evaluates the pushed deny form correctly', async () => {
    const surreal = f.app.get(SurrealService);
    const deny = compileDenyPushdown(ctxOf(NO_HR));
    const out = await surreal.withCompany(f.companyId, async (db) => {
      const [hit] = await db.query<[any]>(
        `RETURN fn::policy_row_denied('preference', { vertical: 'hr' }, $deny)`,
        { deny },
      );
      const [miss] = await db.query<[any]>(
        `RETURN fn::policy_row_denied('preference', { vertical: 'support' }, $deny)`,
        { deny },
      );
      const [noSource] = await db.query<[any]>(
        `RETURN fn::policy_row_denied('preference', NONE, $deny)`,
        { deny },
      );
      return { hit, miss, noSource };
    });
    expect(out.hit).toBe(true);
    expect(out.miss).toBe(false);
    expect(out.noSource).toBe(false); // absent attr never matches
  });

  it('the per-request deny binding never breaks scoped reads', async () => {
    // The service-side binding runs on every withScopedCompany call
    // while the flag is on (empty form here — no ALS policy). Reads
    // must stay healthy.
    const surreal = f.app.get(SurrealService);
    const rows = await surreal.withScopedCompany(
      f.companyId,
      ['brain:read', 'brain:read_pii'],
      async (db) => {
        const [r] = await db.query<[any[]]>(
          `SELECT object, source.vertical AS vertical FROM knowledge_fact
            WHERE predicate = 'preference'`,
        );
        return (r as any[]) ?? [];
      },
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.object).sort()).toEqual([
      'prefers email contact',
      'salary spreadsheet location',
    ]);
  });

  it('CANARY: field PERMISSIONS do NOT fire for the system user (0005 + 0057 inert)', async () => {
    const surreal = f.app.get(SurrealService);

    // LET does not survive a query() boundary on this stack…
    const persistence = await surreal.withScopedCompany(f.companyId, ['brain:read'], async (db) => {
      await db.query(`LET $probe_var = 42`);
      const [a] = await db.query<[any]>(`RETURN $probe_var ?? 'GONE'`);
      return a;
    });
    expect(persistence).toBe('GONE');

    // …and PERMISSIONS are skipped for brain_caller (system user): an
    // address `object` is READABLE without brain:read_pii, and an hr
    // row's object survives a bound policy-deny form. When either
    // assertion starts failing, the stack began honoring PERMISSIONS —
    // activate the fence (flip these expectations, enable the flag in
    // prod runbooks, update docs/abac.md + 0057's header).
    const deny = compileDenyPushdown(ctxOf(NO_HR));
    const probe = await surreal.withScopedCompany(
      f.companyId,
      ['brain:read'], // deliberately NO brain:read_pii
      async (db) => {
        await db.query(`LET $caller_policy_deny = $deny`, { deny });
        const [pii] = await db.query<[any[]]>(
          `SELECT object FROM knowledge_fact WHERE predicate = 'address'`,
        );
        const [hr] = await db.query<[any[]]>(
          `SELECT object FROM knowledge_fact
            WHERE predicate = 'preference' AND source.vertical = 'hr'`,
        );
        return { pii: (pii as any[]) ?? [], hr: (hr as any[]) ?? [] };
      },
    );
    expect(probe.pii[0]?.object).toBe('42 Fence Probe St');
    expect(probe.hr[0]?.object).toBe('salary spreadsheet location');
  });
});
