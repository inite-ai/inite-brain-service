/**
 * Scene read API e2e on real SurrealDB: GET /v1/scenes and
 * GET /v1/scenes/:id (SCENES_API_ENABLED, default on).
 *
 * The scenes are COMPOSED through the real chain (episode ingest → the
 * admin compose route), not seeded: the world registry row, the member
 * edges and the per-user scope fold are the composer's own, so the read
 * surface is pinned to what the shipped writer produces. One extra
 * out-of-contract row is seeded by hand to pin the fail-closed fence.
 *
 * Pins:
 *  - `=0` → both routes 404 byte-identically (the BELIEFS_API idiom);
 *  - the list serves the CURRENT world only (`built` counts — the lane
 *    need not be on), newest scene first, members in order;
 *  - user fence: a user-bound token sees its own scenes and the
 *    tenant-global ones whose member set contains it; another user's
 *    scene is 404 by id and absent from the list; a caller-asserted
 *    userId mismatch is 403 (pinUserScope); an unscoped M2M caller sees
 *    tenant-global scenes only (the episode read port's contract — a
 *    gist quotes verbatim turns) and scopes to a user with ?userId=; an
 *    unstamped row serves to no one;
 *  - filters: conversationId, entityId, since/until; limit validation;
 *  - wire contract: live responses parse against the zod schemas.
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import {
  SceneReadResponseSchema,
  ScenesListResponseSchema,
} from '../src/contracts/scenes/scenes.schema';

const USER = 'scene_reader_u1';
const OTHER = 'scene_reader_u2';
const CONV_USER = 'proj:scenes_c1';
const CONV_OTHER = 'proj:scenes_c2';
const FLAGS = [
  'SCENES_API_ENABLED',
  'EPISODE_SUBSTRATE_ENABLED',
  'INGEST_EPISODE_ONLY',
  'SCENES_SEGMENTATION_ENABLED',
  'SCENES_TOPIC_BOUNDARY',
  'RETRIEVAL_SCENE_LANE',
] as const;

describe('scenes read API (e2e)', () => {
  let f: AppFixture;
  const saved: Record<string, string | undefined> = {};
  const m2m = () => ({ Authorization: `Bearer ${f.apiKey}` });
  const userToken = () => ({ Authorization: `Bearer ${f.extraApiKeys[0]}` });
  let userSceneId = '';
  let otherSceneId = '';

  const db = <T>(
    fn: (d: { query: <Q>(sql: string, p?: Record<string, unknown>) => Promise<Q> }) => Promise<T>,
  ): Promise<T> => f.app.get(SurrealService).withCompany(f.companyId, fn);

  const ingest = async (conv: string, user: string, turns: string[], day: string) => {
    for (const [i, text] of turns.entries()) {
      const res = await f.http
        .post('/v1/ingest/mention')
        .set(m2m())
        .send({
          text,
          contextRef: { vertical: 'proj', conversationId: conv, messageId: `${conv}-${i}` },
          userId: user,
          emittedAt: `${day}T10:0${i}:00.000Z`,
        });
      expect(res.status).toBe(201);
    }
  };

  beforeAll(async () => {
    for (const k of FLAGS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.EPISODE_SUBSTRATE_ENABLED = '1';
    process.env.INGEST_EPISODE_ONLY = '1';
    process.env.SCENES_SEGMENTATION_ENABLED = '1';
    f = await createApp({
      companyId: 'co_scenes_api_e2e',
      extraKeys: [{ scopes: ['brain:read'], userId: USER }],
    });
    await ingest(
      CONV_USER,
      USER,
      ['Signed the lease for the Porto flat today.', 'Keys are handed over on Friday.'],
      '2026-07-01',
    );
    await ingest(
      CONV_OTHER,
      OTHER,
      ['Renewed the car insurance with Allianz.', 'The premium went up ten percent.'],
      '2026-07-03',
    );
    const composed = await f.http.post('/v1/admin/maintenance/scenes').set(m2m()).send({});
    expect(composed.status).toBe(201);
    expect(composed.body.scenes).toBeGreaterThanOrEqual(2);

    const rows = await db(async (d) => {
      const [r] = await d.query<[Array<{ id: unknown; userId?: string; occurredFrom: unknown }>]>(
        `SELECT id, userId, occurredFrom FROM memory_episode ORDER BY occurredFrom ASC`,
      );
      return r ?? [];
    });
    userSceneId = String(rows.find((r) => r.userId === USER)!.id);
    otherSceneId = String(rows.find((r) => r.userId === OTHER)!.id);
    // Out-of-contract: no owner, no member set — hidden from everyone.
    await db(async (d) => {
      await d.query(
        `CREATE memory_episode:unstamped CONTENT {
           scope: [], sceneLabel: 'ghost', conversationIds: ['proj:ghost'],
           occurredFrom: <datetime>'2026-07-05T10:00:00.000Z',
           occurredTo: <datetime>'2026-07-05T10:01:00.000Z',
           gist: 'a scene nobody may read', confidence: 1,
           segmenterVersion: $v, generation: 'seed', source: { recorder: 'seed' } }`,
        { v: rows[0] ? await worldOf(d) : '' },
      );
    });
  }, 180000);

  const worldOf = async (d: {
    query: <Q>(sql: string, p?: Record<string, unknown>) => Promise<Q>;
  }): Promise<string> => {
    const [w] = await d.query<[Array<{ version: string }>]>(
      `SELECT version, finishedAt FROM projection WHERE name = 'scenes'
        ORDER BY finishedAt DESC LIMIT 1`,
    );
    return w?.[0]?.version ?? '';
  };

  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (f) await f.close();
  });

  it('SCENES_API_ENABLED=0 → both routes 404, even for a fully-scoped M2M key', async () => {
    process.env.SCENES_API_ENABLED = '0';
    expect((await f.http.get(`/v1/scenes/${userSceneId}`).set(m2m())).status).toBe(404);
    expect((await f.http.get('/v1/scenes').set(m2m())).status).toBe(404);
    delete process.env.SCENES_API_ENABLED;
  });

  it('list: an unscoped M2M caller sees tenant-global scenes only; scoped, the user’s, newest first', async () => {
    const unscoped = await f.http.get('/v1/scenes').set(m2m());
    expect(unscoped.status).toBe(200);
    expect(ScenesListResponseSchema.safeParse(unscoped.body).success).toBe(true);
    expect(unscoped.body.world).not.toBe('');
    // Both composed scenes are one user's each; the unstamped seed is out
    // of contract — nothing is tenant-global here.
    expect(unscoped.body.scenes).toEqual([]);

    const res = await f.http.get(`/v1/scenes?userId=${USER}`).set(m2m());
    expect(res.status).toBe(200);
    expect(ScenesListResponseSchema.safeParse(res.body).success).toBe(true);
    const ids = res.body.scenes.map((s: { sceneId: string }) => s.sceneId);
    expect(ids).toEqual([userSceneId]);
    expect(res.body.found).toBe(1);
    const mine = res.body.scenes[0];
    expect(mine).toMatchObject({
      userId: USER,
      userIds: [USER],
      conversationIds: [CONV_USER],
      enriched: false,
    });
    expect(mine.episodeIds).toHaveLength(2);
    expect(mine.gist).toContain('lease');
    expect(mine.occurredFrom).toBe('2026-07-01T10:00:00.000Z');
    expect(mine.occurredTo).toBe('2026-07-01T10:01:00.000Z');
    expect(Date.parse(mine.recordedAt)).not.toBeNaN();
  });

  it('get by id (bare tail AND record form) for the owner; unscoped, unknown and unstamped are 404', async () => {
    const full = await f.http.get(`/v1/scenes/${userSceneId}`).set(userToken());
    expect(full.status).toBe(200);
    expect(SceneReadResponseSchema.safeParse(full.body).success).toBe(true);
    const bare = await f.http.get(`/v1/scenes/${userSceneId.split(':')[1]}`).set(userToken());
    expect(bare.status).toBe(200);
    expect(bare.body).toEqual(full.body);
    // A user's scene is not tenant-global: unscoped M2M gets the same 404.
    expect((await f.http.get(`/v1/scenes/${userSceneId}`).set(m2m())).status).toBe(404);
    expect((await f.http.get('/v1/scenes/never_existed').set(m2m())).status).toBe(404);
    expect((await f.http.get('/v1/scenes/unstamped').set(m2m())).status).toBe(404);
    expect((await f.http.get('/v1/scenes/unstamped').set(userToken())).status).toBe(404);
  });

  it("user fence: own scene serves, another user's is 404 and absent from the list, mismatch is 403", async () => {
    expect((await f.http.get(`/v1/scenes/${userSceneId}`).set(userToken())).status).toBe(200);
    expect((await f.http.get(`/v1/scenes/${otherSceneId}`).set(userToken())).status).toBe(404);
    const list = await f.http.get('/v1/scenes').set(userToken());
    expect(list.status).toBe(200);
    expect(list.body.scenes.map((s: { sceneId: string }) => s.sceneId)).toEqual([userSceneId]);
    expect((await f.http.get(`/v1/scenes?userId=${OTHER}`).set(userToken())).status).toBe(403);
    expect((await f.http.get(`/v1/scenes?userId=${USER}`).set(userToken())).status).toBe(200);
    const scoped = await f.http.get(`/v1/scenes?userId=${OTHER}`).set(m2m());
    expect(scoped.body.scenes.map((s: { sceneId: string }) => s.sceneId)).toEqual([otherSceneId]);
  });

  it('filters: conversationId, since/until, limit validation', async () => {
    const other = `userId=${OTHER}`;
    const conv = await f.http.get(`/v1/scenes?${other}&conversationId=${CONV_OTHER}`).set(m2m());
    expect(conv.body.scenes.map((s: { sceneId: string }) => s.sceneId)).toEqual([otherSceneId]);
    const none = await f.http.get(`/v1/scenes?${other}&conversationId=${CONV_USER}`).set(m2m());
    expect(none.body.scenes).toEqual([]);
    const early = await f.http.get('/v1/scenes?until=2026-07-02T00:00:00Z').set(userToken());
    expect(early.body.scenes.map((s: { sceneId: string }) => s.sceneId)).toEqual([userSceneId]);
    const late = await f.http.get('/v1/scenes?since=2026-07-02T00:00:00Z').set(userToken());
    expect(late.body.scenes).toEqual([]);
    expect((await f.http.get('/v1/scenes?limit=0').set(m2m())).status).toBe(400);
    expect((await f.http.get('/v1/scenes?since=yesterday').set(m2m())).status).toBe(400);
    const one = await f.http.get(`/v1/scenes?${other}&limit=1`).set(m2m());
    expect(one.body.found).toBe(1);
  });
});
