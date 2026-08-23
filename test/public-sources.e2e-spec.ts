/**
 * e2e for the public read-only trust-inputs surface (/v1/sources,
 * brain:read):
 *
 *   1. list serves the declared ⋈ learned catalogue WITHOUT the operator
 *      annotations (owner/note); filters (type / minSamples / domain
 *      capture) and pagination work; garbage query params are 400s.
 *   2. detail serves declared + trust scopes + history capped at 50
 *      (newest first); an unknown source is a 404.
 *   3. scope fences: a key without brain:read gets 403 on both routes;
 *      a plain brain:read key still gets 403 on /v1/admin/sources.
 *   4. ABAC: a policy denying `get_source_reputation` blocks the REST
 *      detail route (house rule — REST reuses the MCP action name) while
 *      the list route stays readable via @readonly.
 */
import { Surreal } from 'surrealdb';
import { SurrealService } from '../src/db/surreal.service';
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';

const SENIOR = 'rent:senior_auditor';
const API_BOT = 'rent:api_bot';
const LEARNED_ONLY = 'rent:learned_only';
const HISTORY_ROWS = 60;

describe('public sources API (trust inputs)', () => {
  let f: AppFixture;
  let readKey: string;
  let writeOnlyKey: string;
  const admin = () => ({ Authorization: `Bearer ${f.apiKey}` });
  const read = () => ({ Authorization: `Bearer ${readKey}` });

  const seedTrust = async (db: Surreal, over: Record<string, unknown>) => {
    // `domain` is option<string> — omit the key entirely for global rows.
    await db.query(
      `CREATE source_trust CONTENT {
         sourceKey: $k,
         ${over.domain !== undefined ? 'domain: $d,' : ''}
         agreementRate: $rate,
         sampleCount: $samples,
         winCount: $wins,
         lossCount: $losses,
         lastSeenAt: time::now()
       }`,
      {
        k: over.sourceKey,
        ...(over.domain !== undefined ? { d: over.domain } : {}),
        rate: over.rate ?? 0.9,
        samples: over.samples ?? 0,
        wins: over.wins ?? 0,
        losses: over.losses ?? 0,
      },
    );
  };

  beforeAll(async () => {
    f = await createApp({
      companyId: 'co_public_sources_e2e',
      extraKeys: [{ scopes: ['brain:read'] }, { scopes: ['brain:write'] }],
    });
    readKey = f.extraApiKeys[0]!;
    writeOnlyKey = f.extraApiKeys[1]!;

    // Declared identities — SENIOR carries the operator annotations the
    // public projection must never leak.
    const put = await f.http
      .put(`/v1/admin/sources/${encodeURIComponent(SENIOR)}`)
      .set(admin())
      .send({
        type: 'human',
        authLevel: 0.9,
        owner: 'ops-team',
        note: 'call before trusting',
      });
    expect(put.status).toBe(200);
    await f.http
      .put(`/v1/admin/sources/${encodeURIComponent(API_BOT)}`)
      .set(admin())
      .send({ type: 'api', authLevel: 0.2 });

    // Learned reputation + history, seeded directly (the refit writes
    // these tables; the read surface under test only reads them).
    await f.app.get(SurrealService).withCompany(f.companyId, async (db) => {
      await seedTrust(db, { sourceKey: SENIOR, samples: 40, wins: 36, losses: 4 });
      await seedTrust(db, { sourceKey: SENIOR, domain: 'status', samples: 3 });
      await seedTrust(db, { sourceKey: SENIOR, domain: 'address', samples: 12 });
      await seedTrust(db, { sourceKey: LEARNED_ONLY, rate: 0.6, samples: 9 });
      for (let i = 0; i < HISTORY_ROWS; i++) {
        await db.query(
          `CREATE source_trust_history CONTENT {
             sourceKey: $k,
             agreementRate: 0.5,
             sampleCount: $i,
             recordedAt: type::datetime($iso)
           }`,
          {
            k: SENIOR,
            i,
            iso: new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString(),
          },
        );
      }
    });
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  it('lists the catalogue under brain:read without owner/note', async () => {
    const res = await f.http.get('/v1/sources').set(read());
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.limit).toBe(50);
    expect(res.body.offset).toBe(0);
    // Sorted by sourceKey.
    expect(res.body.sources.map((s: any) => s.sourceKey)).toEqual([
      API_BOT,
      LEARNED_ONLY,
      SENIOR,
    ]);
    const senior = res.body.sources.find((s: any) => s.sourceKey === SENIOR);
    expect(senior.declared).toEqual({ type: 'human', authLevel: 0.9 });
    expect(senior.globalTrust.sampleCount).toBe(40);
    expect(senior.scopedDomains).toBe(2);
    expect('domainTrust' in senior).toBe(false);
    const learned = res.body.sources.find(
      (s: any) => s.sourceKey === LEARNED_ONLY,
    );
    expect(learned.declared).toBeNull();
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('ops-team');
    expect(raw).not.toContain('call before trusting');
    expect(raw).not.toContain('"owner"');
    expect(raw).not.toContain('"note"');
  });

  it('filters by type, minSamples, and captures domainTrust', async () => {
    const byType = await f.http.get('/v1/sources?type=api').set(read());
    expect(byType.body.sources.map((s: any) => s.sourceKey)).toEqual([API_BOT]);
    expect(byType.body.total).toBe(1);

    // Global basis: senior 40 ≥ 10; learned_only 9 and api_bot 0 drop.
    const bySamples = await f.http.get('/v1/sources?minSamples=10').set(read());
    expect(bySamples.body.sources.map((s: any) => s.sourceKey)).toEqual([
      SENIOR,
    ]);

    // Domain capture: every row gains a domainTrust slot (null without a
    // row for that domain).
    const byDomain = await f.http.get('/v1/sources?domain=address').set(read());
    const senior = byDomain.body.sources.find(
      (s: any) => s.sourceKey === SENIOR,
    );
    expect(senior.domainTrust.domain).toBe('address');
    expect(senior.domainTrust.sampleCount).toBe(12);
    const learned = byDomain.body.sources.find(
      (s: any) => s.sourceKey === LEARNED_ONLY,
    );
    expect(learned.domainTrust).toBeNull();

    // With a domain active, minSamples judges the scoped row when present
    // (senior's 3 `status` samples lose against its 40 global ones) and
    // falls back to the global row otherwise.
    const scoped = await f.http
      .get('/v1/sources?domain=status&minSamples=10')
      .set(read());
    expect(scoped.body.sources).toEqual([]);
    expect(scoped.body.total).toBe(0);
    const fallback = await f.http
      .get('/v1/sources?domain=status&minSamples=5')
      .set(read());
    expect(fallback.body.sources.map((s: any) => s.sourceKey)).toEqual([
      LEARNED_ONLY,
    ]);
  });

  it('paginates with a clamped limit and stable totals', async () => {
    const first = await f.http.get('/v1/sources?limit=1').set(read());
    expect(first.body.sources.map((s: any) => s.sourceKey)).toEqual([API_BOT]);
    expect(first.body.total).toBe(3);
    expect(first.body.limit).toBe(1);

    const second = await f.http
      .get('/v1/sources?limit=1&offset=1')
      .set(read());
    expect(second.body.sources.map((s: any) => s.sourceKey)).toEqual([
      LEARNED_ONLY,
    ]);

    const beyond = await f.http.get('/v1/sources?offset=999').set(read());
    expect(beyond.body.sources).toEqual([]);
    expect(beyond.body.total).toBe(3);

    const clamped = await f.http.get('/v1/sources?limit=9999').set(read());
    expect(clamped.body.limit).toBe(200);
  });

  it('400s on garbage query params', async () => {
    for (const q of [
      'limit=abc',
      'limit=0',
      'limit=1.5',
      'offset=-1',
      'offset=x',
      'minSamples=-2',
      'type=rumor_mill',
    ]) {
      const res = await f.http.get(`/v1/sources?${q}`).set(read());
      expect(res.status).toBe(400);
    }
  });

  it('serves detail with history capped at 50, newest first', async () => {
    const res = await f.http
      .get(`/v1/sources/${encodeURIComponent(SENIOR)}`)
      .set(read());
    expect(res.status).toBe(200);
    expect(res.body.sourceKey).toBe(SENIOR);
    expect(res.body.declared).toEqual({ type: 'human', authLevel: 0.9 });
    // Global scope first, then domains alphabetically.
    expect(res.body.trust.map((t: any) => t.domain)).toEqual([
      null,
      'address',
      'status',
    ]);
    expect(res.body.history).toHaveLength(50);
    expect(res.body.history[0].sampleCount).toBe(HISTORY_ROWS - 1);
    expect(res.body.history[49].sampleCount).toBe(HISTORY_ROWS - 50);
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('ops-team');
    expect(raw).not.toContain('call before trusting');
  });

  it('404s on an unknown source instead of an empty shell', async () => {
    const res = await f.http
      .get(`/v1/sources/${encodeURIComponent('nowhere:nobody')}`)
      .set(read());
    expect(res.status).toBe(404);
  });

  it('403s without brain:read on both routes', async () => {
    const writeAuth = { Authorization: `Bearer ${writeOnlyKey}` };
    const list = await f.http.get('/v1/sources').set(writeAuth);
    expect(list.status).toBe(403);
    const detail = await f.http
      .get(`/v1/sources/${encodeURIComponent(SENIOR)}`)
      .set(writeAuth);
    expect(detail.status).toBe(403);
  });

  it('brain:read does NOT unlock the admin surface', async () => {
    const res = await f.http.get('/v1/admin/sources').set(read());
    expect(res.status).toBe(403);
  });
});

describe('public sources API — ABAC action gate', () => {
  let f: AppFixture;
  let restrictedKey: string;

  beforeAll(async () => {
    process.env.ABAC_ENABLED = '1';
    f = await createApp({
      extraKeys: [
        {
          scopes: ['brain:read', 'brain:write'],
          policies: ['no-source-reputation'],
        },
      ],
    });
    restrictedKey = f.extraApiKeys[0]!;
    const created = await f.http
      .post('/v1/admin/policy-sets')
      .set({ Authorization: `Bearer ${f.apiKey}` })
      .send({
        name: 'no-source-reputation',
        description: 'reads allowed, source reputation denied',
        posture: { actions: 'deny', reads: 'allow' },
        mode: 'enforce',
        rules: [
          { id: 'ro', effect: 'allow', kind: 'action', actions: ['@readonly'] },
          {
            id: 'no-src',
            effect: 'deny',
            kind: 'action',
            actions: ['get_source_reputation'],
          },
        ],
      });
    expect(created.status).toBe(201);
  });

  afterAll(async () => {
    delete process.env.ABAC_ENABLED;
    if (f) await f.close();
  });

  it('denying get_source_reputation blocks REST detail; list stays readable', async () => {
    const auth = { Authorization: `Bearer ${restrictedKey}` };
    const list = await f.http.get('/v1/sources').set(auth);
    expect(list.status).toBe(200);

    const detail = await f.http.get('/v1/sources/rent:whatever').set(auth);
    expect(detail.status).toBe(403);
    expect(detail.body).toMatchObject({
      error: 'policy_denied',
      action: 'get_source_reputation',
      policySet: 'no-source-reputation',
    });
  });
});
