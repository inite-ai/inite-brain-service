/**
 * Mixed-user scope fence e2e (migration 0117,
 * PRIVACY_SEGMENT_USER_FENCE) against a REAL SurrealDB.
 *
 * THE HOLE THIS PINS FIRST (fence off — today's behavior): a window
 * whose member turns belong to users A and B folds to userId = NONE
 * (tenant-global), so ANY user-scoped caller C in the tenant is served
 * the A+B verbatim window through the fused segment leg. With the fence
 * on: C is blocked, member A is still served (per-member visibility —
 * co-present verbatim is re-disclosure, not disclosure), M2M and purely
 * global windows are unchanged, and un-backfilled legacy rows
 * (userIds IS NONE) fail CLOSED until the backfill endpoint stamps
 * them. GDPR: forgetting a member deletes the mixed window WHOLE.
 *
 * Serving path: RETRIEVAL_VERBATIM_EVIDENCE=fused (the LLM-free fused
 * search leg — segments ride /v1/search as first-class candidates).
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';

const READ = ['brain:read', 'brain:read_pii'];
const CONV_MIXED = 'proj:fence-mixed';
const CONV_GLOBAL = 'proj:fence-global';
// Distinctive multi-word markers: the BM25 leg (@1@ AND-semantics)
// retrieves the window on them regardless of the stub dense vectors.
const MARKER_MIXED = 'plutonium picnic logistics';
const MARKER_GLOBAL = 'gravel garden inventory';

describe('segment user fence (0117 + PRIVACY_SEGMENT_USER_FENCE) e2e', () => {
  let f: AppFixture;
  let aToken: string;
  let cToken: string;

  const saved: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    'EPISODE_SUBSTRATE_ENABLED',
    'INGEST_EPISODE_ONLY',
    'RETRIEVAL_VERBATIM_EVIDENCE',
    'PRIVACY_SEGMENT_USER_FENCE',
  ];
  const m2m = () => ({ Authorization: `Bearer ${f.apiKey}` });
  const asToken = (t: string) => ({ Authorization: `Bearer ${t}` });
  const fenceOn = () => {
    process.env.PRIVACY_SEGMENT_USER_FENCE = '1';
  };
  const fenceOff = () => {
    delete process.env.PRIVACY_SEGMENT_USER_FENCE;
  };

  beforeAll(async () => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.EPISODE_SUBSTRATE_ENABLED = '1';
    process.env.INGEST_EPISODE_ONLY = '1';
    process.env.RETRIEVAL_VERBATIM_EVIDENCE = 'fused';
    delete process.env.PRIVACY_SEGMENT_USER_FENCE;

    f = await createApp({
      companyId: 'co_segment_fence_e2e',
      extraKeys: [
        { scopes: READ, userId: 'user_a' },
        { scopes: READ, userId: 'user_c' },
      ],
    });
    aToken = f.extraApiKeys[0]!;
    cToken = f.extraApiKeys[1]!;

    const ingest = async (
      conversationId: string,
      i: number,
      text: string,
      userId?: string,
    ): Promise<void> => {
      const res = await f.http
        .post('/v1/ingest/mention')
        .set(m2m())
        .send({
          text,
          contextRef: { vertical: 'proj', conversationId, messageId: `t${i}` },
          knownEntities: [{ vertical: 'proj', id: 'mika', role: 'speaker', name: 'mika' }],
          ...(userId ? { userId } : {}),
          emittedAt: `2026-03-01T10:0${i}:00.000Z`,
        });
      expect(res.status).toBe(201);
    };

    // Mixed conversation: one window holding A's and B's turns.
    await ingest(CONV_MIXED, 0, `we should sort the ${MARKER_MIXED} before friday`, 'user_a');
    await ingest(CONV_MIXED, 1, 'agreed, I will bring the hampers', 'user_b');
    // All-global conversation: no userId on any turn.
    await ingest(CONV_GLOBAL, 0, `the ${MARKER_GLOBAL} needs a recount`);
    await ingest(CONV_GLOBAL, 1, 'noted, recount scheduled');

    const composed = await f.http.post('/v1/admin/maintenance/segments').set(m2m()).send({});
    expect(composed.status).toBe(201);
    expect(composed.body.segments).toBeGreaterThanOrEqual(2);
  });

  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (f) await f.close();
  });

  /** Sorted verbatim objects a caller retrieves for `query`. */
  const verbatimFor = async (headers: Record<string, string>, query: string): Promise<string[]> => {
    const r = await f.http.post('/v1/search').set(headers).send({ query });
    expect(r.status).toBe(201);
    return (r.body.results as Array<{ facts: Array<{ predicate: string; object: string }> }>)
      .flatMap((h) => h.facts)
      .filter((x) => x.predicate === 'verbatim')
      .map((x) => String(x.object))
      .sort();
  };
  const seesMixed = (objects: string[]) => objects.some((o) => o.includes(MARKER_MIXED));
  const seesGlobal = (objects: string[]) => objects.some((o) => o.includes(MARKER_GLOBAL));

  it('fence OFF (today): the mixed A+B window is served to NON-MEMBER C — the hole', async () => {
    fenceOff();
    expect(seesMixed(await verbatimFor(asToken(aToken), MARKER_MIXED))).toBe(true);
    // The defect this PR closes, pinned as-is: C was never in the
    // window, yet the tenant-global fold serves it B's verbatim text.
    expect(seesMixed(await verbatimFor(asToken(cToken), MARKER_MIXED))).toBe(true);
    expect(seesMixed(await verbatimFor(m2m(), MARKER_MIXED))).toBe(true);
  });

  it('fence ON: C blocked, member A served, M2M unchanged', async () => {
    fenceOn();
    expect(seesMixed(await verbatimFor(asToken(cToken), MARKER_MIXED))).toBe(false);
    expect(seesMixed(await verbatimFor(asToken(aToken), MARKER_MIXED))).toBe(true);
    expect(seesMixed(await verbatimFor(m2m(), MARKER_MIXED))).toBe(true);
  });

  it('fence ON: purely global windows (userIds = []) still served to every caller', async () => {
    fenceOn();
    expect(seesGlobal(await verbatimFor(asToken(aToken), MARKER_GLOBAL))).toBe(true);
    expect(seesGlobal(await verbatimFor(asToken(cToken), MARKER_GLOBAL))).toBe(true);
    expect(seesGlobal(await verbatimFor(m2m(), MARKER_GLOBAL))).toBe(true);
  });

  it('parity: unaffected slices are identical fence off ≡ on', async () => {
    // Projection compare (object text) — the verbatim pseudo-rows stamp
    // recordedAt = now, so a full-body compare would flake. NOTE: the
    // dense leg is a brute cosine scan, so a query's result pool spans
    // every row the GATE admits — parity must therefore be measured on
    // a caller whose admitted set the fence does not change. A is a
    // member of the only mixed window: A's visible set is identical in
    // both modes, so A's served bytes must be too.
    fenceOff();
    const offMixed = await verbatimFor(asToken(aToken), MARKER_MIXED);
    const offGlobal = await verbatimFor(asToken(aToken), MARKER_GLOBAL);
    fenceOn();
    expect(await verbatimFor(asToken(aToken), MARKER_MIXED)).toEqual(offMixed);
    expect(await verbatimFor(asToken(aToken), MARKER_GLOBAL)).toEqual(offGlobal);
    // And the purely-global rows themselves serve identically to the
    // non-member C in both modes (the userIds = [] path).
    fenceOff();
    const offC = (await verbatimFor(asToken(cToken), MARKER_GLOBAL)).filter((o) =>
      o.includes(MARKER_GLOBAL),
    );
    fenceOn();
    const onC = (await verbatimFor(asToken(cToken), MARKER_GLOBAL)).filter((o) =>
      o.includes(MARKER_GLOBAL),
    );
    expect(onC).toEqual(offC);
    expect(offC.length).toBeGreaterThan(0);
  });

  it('legacy rows (userIds IS NONE) fail CLOSED; the backfill restores membership', async () => {
    // Simulate pre-0117 rows: null out userIds by primary key.
    const surreal = f.app.get(SurrealService);
    await surreal.withCompany(f.companyId, async (db) => {
      const [ids] = await db.query<[unknown[]]>(`SELECT VALUE id FROM episode_segment`);
      for (const id of ids ?? []) {
        await db.query(`UPDATE $id SET userIds = NONE`, { id });
      }
    });

    fenceOn();
    // Hidden even from member A (a NONE row MAY be mixed — fail closed),
    // and even the genuinely global window is hidden until backfill.
    expect(seesMixed(await verbatimFor(asToken(aToken), MARKER_MIXED))).toBe(false);
    expect(seesGlobal(await verbatimFor(asToken(aToken), MARKER_GLOBAL))).toBe(false);
    // The tenant-global caller is untouched by the fence.
    expect(seesMixed(await verbatimFor(m2m(), MARKER_MIXED))).toBe(true);

    const backfill = await f.http
      .post('/v1/admin/maintenance/segments/backfill-user-ids')
      .set(m2m())
      .send({});
    expect(backfill.status).toBe(201);
    expect(backfill.body.updated).toBeGreaterThanOrEqual(2);
    expect(backfill.body.remaining).toBe(0);
    expect(backfill.body.skippedDangling).toBe(0);

    expect(seesMixed(await verbatimFor(asToken(aToken), MARKER_MIXED))).toBe(true);
    expect(seesGlobal(await verbatimFor(asToken(aToken), MARKER_GLOBAL))).toBe(true);
    expect(seesMixed(await verbatimFor(asToken(cToken), MARKER_MIXED))).toBe(false);
  });

  it('GDPR: forgetting member B deletes the mixed window WHOLE (no userIds edit)', async () => {
    const forget = await f.http.post('/v1/users/user_b/forget').set(m2m()).send({});
    expect([200, 201]).toContain(forget.status);

    const surreal = f.app.get(SurrealService);
    const remaining = await surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[Array<{ conversationId: string }>]>(
        `SELECT conversationId FROM episode_segment`,
      );
      return rows ?? [];
    });
    // The mixed conversation's windows are GONE — not edited down to A.
    expect(remaining.some((r) => r.conversationId === CONV_MIXED)).toBe(false);
    expect(remaining.some((r) => r.conversationId === CONV_GLOBAL)).toBe(true);

    fenceOn();
    expect(seesMixed(await verbatimFor(asToken(aToken), MARKER_MIXED))).toBe(false);
  });
});
