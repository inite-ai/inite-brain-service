/**
 * G6 scope-tag foundation — PARITY proof (step 2 of
 * docs/roadmap/sota-gap-build-2026-08.md) against a REAL SurrealDB.
 *
 * The load-bearing guarantee: turning SCOPE_TAGS_ENABLED ON changes
 * NOTHING for current single-tag data. The scope evaluator runs as an
 * ADDITIONAL AND-fence alongside the untouched migration-0055 userId
 * filter, so for data where `scope` mirrors `userId` the two fences keep
 * IDENTICAL row sets — which is what makes shipping the flag enabled
 * safe later.
 *
 * Seeds user-A facts, user-B facts, and tenant-global facts, then for
 * EACH of {flag off, flag on} snapshots what user-A, user-B, and an M2M
 * caller see through search + get-fact + provenance. Asserts the two
 * snapshots are byte-identical (parity), that A never sees B's rows (and
 * vice versa), and that M2M sees every fact by id.
 */
import { AppFixture, createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';

describe('scope-tags parity (SCOPE_TAGS_ENABLED off ≡ on)', () => {
  let f: AppFixture;
  // Main key = M2M (tenant-wide, no bound user). Two user-bound tokens.
  const READ = ['brain:read', 'brain:read_pii'];
  let aToken: string;
  let bToken: string;

  let globalFactId: string;
  let aFactId: string;
  let bFactId: string;

  const savedFlag = process.env.SCOPE_TAGS_ENABLED;
  const savedFactsApi = process.env.FACTS_API_ENABLED;

  const m2m = () => ({ Authorization: `Bearer ${f.apiKey}` });
  const asToken = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
    // get-fact / provenance routes are gated behind this flag.
    process.env.FACTS_API_ENABLED = '1';
    f = await createApp({
      companyId: 'co_scope_parity_e2e',
      extraKeys: [
        { scopes: READ, userId: 'user_a' },
        { scopes: READ, userId: 'user_b' },
      ],
    });
    aToken = f.extraApiKeys[0];
    bToken = f.extraApiKeys[1];

    // Seed via M2M asserting the scope in the body. The write path stamps
    // both userId (0055) AND scope (0093) regardless of the read flag, so
    // the facts carry real scope tags for the flag-on fence to act on.
    const ingest = async (body: Record<string, unknown>): Promise<string> => {
      const r = await f.http.post('/v1/ingest/fact').set(m2m()).send({
        validFrom: '2026-01-01',
        confidence: 0.9,
        source: { vertical: 'rent', recorder: 'bot' },
        ...body,
      });
      expect([200, 201]).toContain(r.status);
      return r.body.factId as string;
    };

    globalFactId = await ingest({
      entityRef: { vertical: 'rent', id: 'sp_global' },
      predicate: 'note_probe',
      object: 'scopeparity marker global tenant',
    });
    aFactId = await ingest({
      entityRef: { vertical: 'rent', id: 'sp_alpha' },
      predicate: 'note_probe',
      object: 'scopeparity marker alpha personal',
      userId: 'user_a',
    });
    bFactId = await ingest({
      entityRef: { vertical: 'rent', id: 'sp_beta' },
      predicate: 'note_probe',
      object: 'scopeparity marker beta personal',
      userId: 'user_b',
    });
  });

  afterAll(async () => {
    if (savedFlag === undefined) delete process.env.SCOPE_TAGS_ENABLED;
    else process.env.SCOPE_TAGS_ENABLED = savedFlag;
    if (savedFactsApi === undefined) delete process.env.FACTS_API_ENABLED;
    else process.env.FACTS_API_ENABLED = savedFactsApi;
    if (f) await f.close();
  });

  /** GET /v1/facts/:id → true when visible (200), false when fenced (404). */
  const getFactVisible = async (
    headers: Record<string, string>,
    factId: string,
  ): Promise<boolean> => {
    const r = await f.http
      .get(`/v1/facts/${encodeURIComponent(factId)}`)
      .set(headers);
    if (r.status === 200) return true;
    expect(r.status).toBe(404);
    return false;
  };

  /** GET /v1/facts/:id/provenance → true when visible (200), false (404). */
  const provVisible = async (
    headers: Record<string, string>,
    factId: string,
  ): Promise<boolean> => {
    const r = await f.http
      .get(`/v1/facts/${encodeURIComponent(factId)}/provenance`)
      .set(headers);
    if (r.status === 200) return true;
    expect(r.status).toBe(404);
    return false;
  };

  /** Objects a caller can see via search (userId pinned for bound tokens). */
  const searchObjects = async (
    headers: Record<string, string>,
    userId?: string,
  ): Promise<string[]> => {
    const r = await f.http
      .post('/v1/search')
      .set(headers)
      .send({ query: 'scopeparity marker', limit: 20, ...(userId ? { userId } : {}) });
    expect(r.status).toBe(201);
    return (r.body.results as Array<{ facts: Array<{ object: string }> }>)
      .flatMap((h) => h.facts ?? [])
      .map((fa) => fa.object)
      .filter((o) => o.includes('scopeparity'))
      .sort();
  };

  /** The full visibility matrix for the three principals. */
  const snapshot = async () => {
    const principals: Array<{
      name: string;
      headers: Record<string, string>;
      searchUserId?: string;
    }> = [
      { name: 'm2m', headers: m2m() },
      { name: 'user_a', headers: asToken(aToken) },
      { name: 'user_b', headers: asToken(bToken) },
    ];
    const out: Record<string, unknown> = {};
    for (const p of principals) {
      out[p.name] = {
        getFact: {
          global: await getFactVisible(p.headers, globalFactId),
          a: await getFactVisible(p.headers, aFactId),
          b: await getFactVisible(p.headers, bFactId),
        },
        provenance: {
          global: await provVisible(p.headers, globalFactId),
          a: await provVisible(p.headers, aFactId),
          b: await provVisible(p.headers, bFactId),
        },
        // Bound tokens pin their own userId; M2M asserts none → global.
        search: await searchObjects(p.headers),
      };
    }
    return out;
  };

  it('the write path stamps the scope column mirroring userId (step 1)', async () => {
    // Parity alone can pass vacuously (userId is the binding fence), so
    // prove the scope column is actually populated — the write-stamp is
    // what gives the flag-on fence real tags to act on.
    const surreal = f.app.get(SurrealService);
    const scopeOf = async (factId: string): Promise<unknown> =>
      surreal.withCompany(f.companyId, async (db) => {
        const [rows] = await db.query<[Array<{ scope: unknown; userId: unknown }>]>(
          `SELECT scope, userId FROM type::record('knowledge_fact', $tail)`,
          { tail: factId.split(':')[1] },
        );
        return (rows as Array<{ scope: unknown }>)[0]?.scope;
      });
    expect(await scopeOf(aFactId)).toEqual(['user:user_a']);
    expect(await scopeOf(bFactId)).toEqual(['user:user_b']);
    // Tenant-global fact carries the empty AND-set (DEFAULT []).
    expect(await scopeOf(globalFactId)).toEqual([]);
  });

  it('flag OFF and flag ON produce IDENTICAL visibility (parity)', async () => {
    delete process.env.SCOPE_TAGS_ENABLED;
    const off = await snapshot();

    process.env.SCOPE_TAGS_ENABLED = '1';
    const on = await snapshot();

    delete process.env.SCOPE_TAGS_ENABLED;

    // The whole point: enabling the flag changes nothing for step-1 data.
    expect(on).toEqual(off);
  });

  it('user A never sees user B rows, and vice versa (both flag states)', async () => {
    for (const flag of [undefined, '1'] as const) {
      if (flag === undefined) delete process.env.SCOPE_TAGS_ENABLED;
      else process.env.SCOPE_TAGS_ENABLED = flag;

      // get-fact: A sees global + its own, never B's; symmetric for B.
      expect(await getFactVisible(asToken(aToken), globalFactId)).toBe(true);
      expect(await getFactVisible(asToken(aToken), aFactId)).toBe(true);
      expect(await getFactVisible(asToken(aToken), bFactId)).toBe(false);
      expect(await getFactVisible(asToken(bToken), bFactId)).toBe(true);
      expect(await getFactVisible(asToken(bToken), aFactId)).toBe(false);

      // search: A's results carry alpha (own) + global, never beta.
      const aSeen = await searchObjects(asToken(aToken));
      expect(aSeen).toContain('scopeparity marker alpha personal');
      expect(aSeen).toContain('scopeparity marker global tenant');
      expect(aSeen).not.toContain('scopeparity marker beta personal');

      const bSeen = await searchObjects(asToken(bToken));
      expect(bSeen).toContain('scopeparity marker beta personal');
      expect(bSeen).not.toContain('scopeparity marker alpha personal');
    }
    delete process.env.SCOPE_TAGS_ENABLED;
  });

  it('M2M sees every fact by id; its unscoped search stays tenant-global', async () => {
    for (const flag of [undefined, '1'] as const) {
      if (flag === undefined) delete process.env.SCOPE_TAGS_ENABLED;
      else process.env.SCOPE_TAGS_ENABLED = flag;

      // Tenant-wide authority: reads any user's fact by id.
      expect(await getFactVisible(m2m(), globalFactId)).toBe(true);
      expect(await getFactVisible(m2m(), aFactId)).toBe(true);
      expect(await getFactVisible(m2m(), bFactId)).toBe(true);

      // An M2M search that asserts no userId still sees tenant-global only
      // (matching today's userGate) — personal rows need an explicit scope.
      const seen = await searchObjects(m2m());
      expect(seen).toContain('scopeparity marker global tenant');
      expect(seen).not.toContain('scopeparity marker alpha personal');
      expect(seen).not.toContain('scopeparity marker beta personal');
    }
    delete process.env.SCOPE_TAGS_ENABLED;
  });
});
