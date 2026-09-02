/**
 * Belief-B e2e on real SurrealDB: the read API over semantic_belief
 * (GET /v1/beliefs/:id + GET /v1/beliefs, BELIEFS_API_ENABLED).
 *
 * Pins:
 *  - default-off → BOTH routes 404 byte-identically (the FACTS_API
 *    idiom: an absent surface is indistinguishable from a disabled one);
 *  - visibility fences: user-bound tokens see only their OWN beliefs
 *    (another user's id is a 404, the list silently narrows), a
 *    caller-asserted userId mismatch is a 403 (pinUserScope), and an
 *    out-of-contract row (blank userId stamp) serves to NO ONE — M2M
 *    included, fail-closed;
 *  - list caps + filters: subject/field exact match, status default
 *    'active', limit clamp/validation;
 *  - wire contract: live responses parse against the zod schemas.
 *
 * Belief rows are seeded directly in the DB (the belief-promotion
 * entity-forget precedent): the promotion pass has its own suite; the
 * read path serves rows regardless of who wrote them.
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import {
  BeliefReadResponseSchema,
  BeliefsListResponseSchema,
} from '../src/contracts/beliefs/beliefs.schema';

const USER = 'belief_reader_u1';
const OTHER_USER = 'belief_reader_u2';

describe('beliefs read API (e2e)', () => {
  let f: AppFixture;
  const m2m = () => ({ Authorization: `Bearer ${f.apiKey}` });
  const userToken = () => ({ Authorization: `Bearer ${f.extraApiKeys[0]}` });

  const savedFlag = process.env.BELIEFS_API_ENABLED;

  const db = <T>(
    fn: (d: { query: <Q>(sql: string, p?: Record<string, unknown>) => Promise<Q> }) => Promise<T>,
  ): Promise<T> => f.app.get(SurrealService).withCompany(f.companyId, fn);

  const seedBelief = async (opts: {
    tail: string;
    user: string;
    subject: string;
    field: string;
    value: string;
    revision: number;
    status: 'active' | 'superseded';
    priorValue?: string;
    supersededBy?: string;
    validUntil?: string;
  }): Promise<void> => {
    await db(async (d) => {
      await d.query(
        `CREATE type::record('semantic_belief', $tail) CONTENT {
           userId: $user, subject: $subject, field: $field, value: $value,
           ${opts.priorValue !== undefined ? 'priorValue: $prior,' : ''}
           ${opts.supersededBy !== undefined ? `supersededBy: type::record('semantic_belief', $sup),` : ''}
           ${opts.validUntil !== undefined ? 'validUntil: <datetime>$until,' : ''}
           statement: $stmt, statementSource: 'template',
           confidence: 0.85, revision: $revision, status: $status,
           validFrom: <datetime>'2026-03-01T10:00:00.000Z',
           sourceSceneIds: [memory_episode:seed_scene],
           conversationIds: ['proj:c1'], corroborationCount: 1,
           conversationCount: 1,
           promoterVersion: 'belief-promotion-v1|scene-segmenter-v1'
         }`,
        {
          tail: opts.tail,
          user: opts.user,
          subject: opts.subject,
          field: opts.field,
          value: opts.value,
          stmt: `${opts.subject} — ${opts.field}: ${opts.value}`,
          revision: opts.revision,
          status: opts.status,
          ...(opts.priorValue !== undefined ? { prior: opts.priorValue } : {}),
          ...(opts.supersededBy !== undefined ? { sup: opts.supersededBy } : {}),
          ...(opts.validUntil !== undefined ? { until: opts.validUntil } : {}),
        },
      );
    });
  };

  beforeAll(async () => {
    delete process.env.BELIEFS_API_ENABLED;
    f = await createApp({
      companyId: 'co_beliefs_api_e2e',
      extraKeys: [{ scopes: ['brain:read'], userId: USER }],
    });

    // USER's home.city supersede chain (rev1 superseded -> rev2 active).
    await seedBelief({
      tail: 'b_city_r1',
      user: USER,
      subject: 'mika',
      field: 'home.city',
      value: 'lisbon',
      revision: 1,
      status: 'superseded',
      supersededBy: 'b_city_r2',
      validUntil: '2026-03-05T10:00:00.000Z',
    });
    await seedBelief({
      tail: 'b_city_r2',
      user: USER,
      subject: 'mika',
      field: 'home.city',
      value: 'porto',
      revision: 2,
      status: 'active',
      priorValue: 'lisbon',
    });
    await seedBelief({
      tail: 'b_coffee',
      user: USER,
      subject: 'mika',
      field: 'coffee.pref',
      value: 'espresso',
      revision: 1,
      status: 'active',
    });
    // Another user's belief — invisible to USER's token.
    await seedBelief({
      tail: 'b_other',
      user: OTHER_USER,
      subject: 'other',
      field: 'pet',
      value: 'dog',
      revision: 1,
      status: 'active',
    });
    // Out-of-contract stamp (blank userId — the promotion never writes
    // this, #387): must serve to NO caller, fail-closed.
    await seedBelief({
      tail: 'b_corrupt',
      user: '',
      subject: 'ghost',
      field: 'x',
      value: 'y',
      revision: 1,
      status: 'active',
    });
  }, 120000);

  afterAll(async () => {
    if (savedFlag === undefined) delete process.env.BELIEFS_API_ENABLED;
    else process.env.BELIEFS_API_ENABLED = savedFlag;
    if (f) await f.close();
  });

  it('default off → both routes 404, even for a fully-scoped M2M key', async () => {
    expect((await f.http.get('/v1/beliefs/b_city_r2').set(m2m())).status).toBe(404);
    expect((await f.http.get('/v1/beliefs').set(m2m())).status).toBe(404);
  });

  it('serves one belief by id (bare tail AND full record form), wire-contract-clean', async () => {
    process.env.BELIEFS_API_ENABLED = '1';
    const res = await f.http.get('/v1/beliefs/semantic_belief:b_city_r2').set(m2m());
    expect(res.status).toBe(200);
    expect(BeliefReadResponseSchema.safeParse(res.body).success).toBe(true);
    expect(res.body).toMatchObject({
      beliefId: 'semantic_belief:b_city_r2',
      userId: USER,
      subject: 'mika',
      field: 'home.city',
      value: 'porto',
      priorValue: 'lisbon',
      statement: 'mika — home.city: porto',
      statementSource: 'template',
      confidence: 0.85,
      revision: 2,
      status: 'active',
      validFrom: '2026-03-01T10:00:00.000Z',
      sourceSceneIds: ['memory_episode:seed_scene'],
      conversationIds: ['proj:c1'],
      corroborationCount: 1,
      conversationCount: 1,
      promoterVersion: 'belief-promotion-v1|scene-segmenter-v1',
    });
    expect(res.body.supersededBy).toBeUndefined();
    expect(res.body.validUntil).toBeUndefined();

    const bare = await f.http.get('/v1/beliefs/b_city_r2').set(m2m());
    expect(bare.status).toBe(200);
    expect(bare.body).toEqual(res.body);
  });

  it('a superseded revision still resolves, with its chain stamps', async () => {
    const res = await f.http.get('/v1/beliefs/b_city_r1').set(m2m());
    expect(res.status).toBe(200);
    expect(BeliefReadResponseSchema.safeParse(res.body).success).toBe(true);
    expect(res.body).toMatchObject({
      status: 'superseded',
      supersededBy: 'semantic_belief:b_city_r2',
      validUntil: '2026-03-05T10:00:00.000Z',
    });
  });

  it('a missing id is the same 404 as a fenced one', async () => {
    expect((await f.http.get('/v1/beliefs/nope_never_existed').set(m2m())).status).toBe(404);
  });

  it("user fence by id: own belief serves, another user's is 404, corrupt is 404 for everyone", async () => {
    expect((await f.http.get('/v1/beliefs/b_coffee').set(userToken())).status).toBe(200);
    expect((await f.http.get('/v1/beliefs/b_other').set(userToken())).status).toBe(404);
    // Fail-closed: blank stamp serves to NO caller, M2M included.
    expect((await f.http.get('/v1/beliefs/b_corrupt').set(userToken())).status).toBe(404);
    expect((await f.http.get('/v1/beliefs/b_corrupt').set(m2m())).status).toBe(404);
  });

  it('list (M2M, defaults): active rows only, corrupt row never serves', async () => {
    const res = await f.http.get('/v1/beliefs').set(m2m());
    expect(res.status).toBe(200);
    expect(BeliefsListResponseSchema.safeParse(res.body).success).toBe(true);
    const ids = res.body.beliefs.map((b: { beliefId: string }) => b.beliefId);
    // Deterministic order: userId ASC, subject ASC, field ASC, rev DESC.
    expect(ids).toEqual([
      'semantic_belief:b_coffee',
      'semantic_belief:b_city_r2',
      'semantic_belief:b_other',
    ]);
    expect(res.body.found).toBe(3);
  });

  it('list filters: subject+field exact match, status=all / superseded, userId scope', async () => {
    const keyed = await f.http
      .get('/v1/beliefs?subject=mika&field=home.city&status=all')
      .set(m2m());
    expect(keyed.status).toBe(200);
    expect(keyed.body.beliefs.map((b: { revision: number }) => b.revision)).toEqual([2, 1]);

    const superseded = await f.http.get('/v1/beliefs?status=superseded').set(m2m());
    expect(superseded.body.beliefs.map((b: { beliefId: string }) => b.beliefId)).toEqual([
      'semantic_belief:b_city_r1',
    ]);

    const scoped = await f.http.get(`/v1/beliefs?userId=${OTHER_USER}`).set(m2m());
    expect(scoped.body.beliefs.map((b: { beliefId: string }) => b.beliefId)).toEqual([
      'semantic_belief:b_other',
    ]);
  });

  it('list user fence: a user-bound token sees only its own; asserting another user is 403', async () => {
    const res = await f.http.get('/v1/beliefs').set(userToken());
    expect(res.status).toBe(200);
    expect(res.body.beliefs.map((b: { beliefId: string }) => b.beliefId)).toEqual([
      'semantic_belief:b_coffee',
      'semantic_belief:b_city_r2',
    ]);
    // pinUserScope: an explicit mismatching assertion is a 403 (the
    // platform-wide pin idiom — distinct from the 404 row fence).
    expect((await f.http.get(`/v1/beliefs?userId=${OTHER_USER}`).set(userToken())).status).toBe(
      403,
    );
    // Asserting the OWN user is a no-op pass-through.
    expect((await f.http.get(`/v1/beliefs?userId=${USER}`).set(userToken())).status).toBe(200);
  });

  it('list caps: limit honored, invalid limits 400, oversize clamped not erred', async () => {
    const one = await f.http.get('/v1/beliefs?limit=1').set(m2m());
    expect(one.status).toBe(200);
    expect(one.body.beliefs).toHaveLength(1);
    expect(one.body.found).toBe(1);

    expect((await f.http.get('/v1/beliefs?limit=0').set(m2m())).status).toBe(400);
    expect((await f.http.get('/v1/beliefs?limit=-5').set(m2m())).status).toBe(400);
    expect((await f.http.get('/v1/beliefs?limit=abc').set(m2m())).status).toBe(400);
    expect((await f.http.get('/v1/beliefs?status=bogus').set(m2m())).status).toBe(400);
    // Above the cap clamps (100) rather than erring.
    expect((await f.http.get('/v1/beliefs?limit=99999').set(m2m())).status).toBe(200);
  });

  it('flag flip back off → 404 again (runtime-mutable, no restart)', async () => {
    delete process.env.BELIEFS_API_ENABLED;
    expect((await f.http.get('/v1/beliefs/b_city_r2').set(m2m())).status).toBe(404);
    expect((await f.http.get('/v1/beliefs').set(m2m())).status).toBe(404);
    process.env.BELIEFS_API_ENABLED = '1';
  });
});
