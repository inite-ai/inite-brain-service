/**
 * Brain v2 shadow Scenes substrate e2e (migration 0106): flag gate (off →
 * 404, no rows), scene derivation over episode-only ingest (two sessions →
 * two scenes with contiguous core membership, gist, version + generation
 * stamps, a 'built' projection row), idempotent re-run on a fresh
 * generation, the SCENES_VERSION_FINGERPRINT coexistence contract
 * (Drift-3: flag off = the literal constant version + the locked id
 * formula; flag on + config change = a disjoint id-space beside the old
 * world; purge removes only the purged world), the exact-match swap
 * ownership rule (Drift-4: a foreign multi-conversation scene survives a
 * per-conversation rebuild), and the user-forget GDPR cascade taking
 * scenes + members. Embedder-free path (SCENES_TOPIC_BOUNDARY stays off)
 * — no paid calls.
 */
import { createHash } from 'node:crypto';
import { RecordId, StringRecordId } from 'surrealdb';
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { effectiveSegmenterVersion } from '../src/admin/scene-segmentation';

const CONV = 'proj:scenes';
const USER = 'scene_user';

interface SceneRow {
  id: unknown;
  gist: string;
  sceneLabel: string;
  conversationIds: string[];
  segmenterVersion: string;
  generation: string;
  userId?: string;
  scope: string[];
}

describe('memory_episode — shadow scenes substrate (e2e)', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  const saved: Record<string, string | undefined> = {};
  beforeAll(async () => {
    for (const k of ['EPISODE_SUBSTRATE_ENABLED', 'INGEST_EPISODE_ONLY']) {
      saved[k] = process.env[k];
      process.env[k] = '1';
    }
    saved.SCENES_SEGMENTATION_ENABLED = process.env.SCENES_SEGMENTATION_ENABLED;
    delete process.env.SCENES_SEGMENTATION_ENABLED;
    // The fingerprint/coexistence test flips these; start from a known-off
    // state and restore whatever the environment had in afterAll.
    for (const k of ['SCENES_VERSION_FINGERPRINT', 'SCENES_MAX_TURNS']) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    f = await createApp({ companyId: 'co_scenes_e2e' });
    // One conversation, two sessions: 3 turns, then a >60-min gap, then 2.
    const turns = [
      { t: '2026-02-01T10:00:00.000Z', text: 'I started planning the Lisbon trip.' },
      { t: '2026-02-01T10:05:00.000Z', text: 'Comparing flights for next month.' },
      { t: '2026-02-01T10:10:00.000Z', text: 'Booked the morning one.' },
      { t: '2026-02-01T12:00:00.000Z', text: 'Back to it — now the hotel.' },
      { t: '2026-02-01T12:05:00.000Z', text: 'Found a place near the river.' },
    ];
    for (const [i, turn] of turns.entries()) {
      const res = await f.http
        .post('/v1/ingest/mention')
        .set(auth())
        .send({
          text: turn.text,
          contextRef: { vertical: 'proj', conversationId: CONV, messageId: `sc${i}` },
          knownEntities: [{ vertical: 'proj', id: 'mika', role: 'speaker', name: 'mika' }],
          userId: USER,
          emittedAt: turn.t,
        });
      expect(res.status).toBe(201);
    }
  });

  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (f) await f.close();
  });

  const scenesInDb = async (): Promise<SceneRow[]> => {
    const surreal = f.app.get(SurrealService);
    return surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[SceneRow[]]>(
        `SELECT * FROM memory_episode ORDER BY occurredFrom ASC`,
      );
      return rows ?? [];
    });
  };

  const membersOf = async (sceneId: unknown): Promise<Array<{ ord: number; role: string }>> => {
    const surreal = f.app.get(SurrealService);
    return surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[Array<{ ord: number; role: string }>]>(
        `SELECT ord, role FROM memory_episode_member WHERE in = $scene ORDER BY ord ASC`,
        { scene: sceneId },
      );
      return rows ?? [];
    });
  };

  /** Deletes are synchronous but poll anyway — cheap and future-proof. */
  const waitForSceneCount = async (expected: number): Promise<SceneRow[]> => {
    for (let i = 0; i < 40; i++) {
      const rows = await scenesInDb();
      if (rows.length === expected) return rows;
      await new Promise((r) => setTimeout(r, 100));
    }
    return scenesInDb();
  };

  it('404s with the flag off and writes nothing', async () => {
    const res = await f.http.post('/v1/admin/maintenance/scenes').set(auth()).send({});
    expect(res.status).toBe(404);
    expect(await scenesInDb()).toHaveLength(0);
  });

  it('derives two scenes with core membership, stamps, and a built projection row', async () => {
    process.env.SCENES_SEGMENTATION_ENABLED = '1';
    const res = await f.http.post('/v1/admin/maintenance/scenes').set(auth()).send({});
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ conversations: 1, scenes: 2 });

    const scenes = await scenesInDb();
    expect(scenes).toHaveLength(2);
    for (const [index, scene] of scenes.entries()) {
      expect(scene.gist.length).toBeGreaterThan(0);
      // Flag off ⇒ the LITERAL constant version — byte-identical to the
      // pre-fingerprint build (SCENES_VERSION_FINGERPRINT default-off
      // contract) — and the locked id formula:
      // sha256(conversation|version|index) first 24 hex chars.
      expect(scene.segmenterVersion).toBe('scene-segmenter-v1');
      const expectedTail = createHash('sha256')
        .update(`${CONV}|scene-segmenter-v1|${index}`)
        .digest('hex')
        .slice(0, 24);
      expect(String(scene.id)).toContain(expectedTail);
      // The composer only ever writes single-conversation scenes — the
      // invariant that makes the swap's exact-match delete
      // (conversationIds = [$conv]) byte-identical to the previous
      // CONTAINS filter on all producible data (Drift-4).
      expect(scene.conversationIds).toEqual([CONV]);
      expect(scene.generation).toBeDefined();
      // Single-user conversation → per-user scope folded onto the scene.
      expect(scene.userId).toBe(USER);
      expect(scene.scope).toEqual([`user:${USER}`]);
    }
    const first = await membersOf(scenes[0]!.id);
    expect(first.map((m) => m.ord)).toEqual([0, 1, 2]);
    expect(first.every((m) => m.role === 'core')).toBe(true);
    expect((await membersOf(scenes[1]!.id)).map((m) => m.ord)).toEqual([0, 1]);

    const surreal = f.app.get(SurrealService);
    const projection = await surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[Array<{ status: string }>]>(
        `SELECT status FROM projection WHERE name = 'scenes'`,
      );
      return rows ?? [];
    });
    expect(projection).toHaveLength(1);
    expect(projection[0]!.status).toBe('built');
  });

  it('re-runs idempotently onto a fresh generation', async () => {
    const before = await scenesInDb();
    const res = await f.http.post('/v1/admin/maintenance/scenes').set(auth()).send({});
    expect(res.status).toBe(201);
    expect(res.body.scenes).toBe(2);
    const after = await scenesInDb();
    expect(after).toHaveLength(before.length);
    expect(after[0]!.generation).not.toBe(before[0]!.generation);
  });

  it('fingerprinted world coexists with the constant world; purge removes only it', async () => {
    const before = await scenesInDb();
    expect(before).toHaveLength(2);
    // The expected effective version of world B, recomputed here from the
    // exact config the run will resolve (boundary off ⇒ minCosine/space
    // are excluded from the fingerprint, so their values are irrelevant).
    const effectiveB = effectiveSegmenterVersion({
      topicBoundary: false,
      minCosine: 0.55,
      maxTurns: 2,
      embeddingSpaceId: null,
    });
    expect(effectiveB).toMatch(/^scene-segmenter-v1\+[0-9a-f]{8}$/);
    const key = (s: SceneRow) => String(s.id);
    const sortById = (rows: SceneRow[]) => [...rows].sort((a, b) => key(a).localeCompare(key(b)));

    process.env.SCENES_VERSION_FINGERPRINT = '1';
    process.env.SCENES_MAX_TURNS = '2';
    try {
      // World B: maxTurns=2 splits the 3+2 turn sessions into 2+1+2 turns
      // ⇒ 3 scenes, under the fingerprinted version.
      const res = await f.http.post('/v1/admin/maintenance/scenes').set(auth()).send({});
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ conversations: 1, scenes: 3 });

      const all = await scenesInDb();
      expect(all).toHaveLength(5);
      expect(new Set(all.map((s) => s.segmenterVersion))).toEqual(
        new Set(['scene-segmenter-v1', effectiveB]),
      );
      const worldA = all.filter((s) => s.segmenterVersion === 'scene-segmenter-v1');
      const worldB = all.filter((s) => s.segmenterVersion === effectiveB);
      expect(worldB).toHaveLength(3);
      // World A rows byte-unchanged; the two id-spaces are disjoint.
      expect(sortById(worldA)).toEqual(sortById(before));
      const beforeIds = new Set(before.map(key));
      for (const scene of worldB) expect(beforeIds.has(key(scene))).toBe(false);

      // Member rows carry the fingerprinted version too.
      const surreal = f.app.get(SurrealService);
      const bMemberVersions = await surreal.withCompany(f.companyId, async (db) => {
        const [rows] = await db.query<[Array<{ segmenterVersion: string }>]>(
          `SELECT segmenterVersion FROM memory_episode_member WHERE in INSIDE $ids`,
          { ids: worldB.map((s) => s.id) },
        );
        return rows ?? [];
      });
      expect(bMemberVersions).toHaveLength(5);
      expect(bMemberVersions.every((m) => m.segmenterVersion === effectiveB)).toBe(true);

      // Purge world B (the '+' is a literal character in a path segment):
      // world A intact, B gone, B's registry row demoted to residual while
      // A's row (keyed per version) stays built.
      const purge = await f.http
        .delete(`/v1/admin/maintenance/scenes/versions/${effectiveB}`)
        .set(auth())
        .send({});
      expect(purge.status).toBe(200);
      expect(purge.body).toMatchObject({ scenes: 3, members: 5 });
      expect(sortById(await scenesInDb())).toEqual(sortById(before));
      const registry = await surreal.withCompany(f.companyId, async (db) => {
        const [rows] = await db.query<[Array<{ version: string; status: string }>]>(
          `SELECT version, status FROM projection WHERE name = 'scenes'`,
        );
        return rows ?? [];
      });
      const byVersion = new Map(registry.map((r) => [r.version, r.status]));
      expect(byVersion.get('scene-segmenter-v1')).toBe('built');
      expect(byVersion.get(effectiveB)).toBe('residual');
    } finally {
      delete process.env.SCENES_VERSION_FINGERPRINT;
      delete process.env.SCENES_MAX_TURNS;
    }
  });

  it('per-conversation swap leaves a foreign multi-conversation scene untouched', async () => {
    const surreal = f.app.get(SurrealService);
    const before = await scenesInDb();
    expect(before).toHaveLength(2);
    const beforeGenerations = new Set(before.map((s) => s.generation));

    // Hand-INSERT a synthetic MULTI-conversation scene (a future
    // consolidation output) under the current version, with one member
    // row. The pre-fix CONTAINS filter would have deleted it on any CONV
    // rebuild; the exact-match [$conv] filter must not (Drift-4).
    const epId = await surreal.withCompany(f.companyId, async (db) => {
      const [eps] = await db.query<[Array<{ id: unknown }>]>(
        `SELECT id, occurredAt FROM episode WHERE conversationId = $conv
           ORDER BY occurredAt ASC LIMIT 1`,
        { conv: CONV },
      );
      expect(eps ?? []).toHaveLength(1);
      await db.query(`CREATE memory_episode:multiconv CONTENT $content`, {
        content: {
          sceneLabel: 'synthetic multi-conversation scene',
          conversationIds: [CONV, 'proj:other-conv'],
          occurredFrom: new Date('2026-02-01T10:00:00.000Z'),
          occurredTo: new Date('2026-02-01T12:05:00.000Z'),
          gist: 'synthetic multi-conversation gist',
          confidence: 1,
          segmenterVersion: 'scene-segmenter-v1',
          generation: 'synthetic-generation',
          source: { recorder: 'test-seed' },
          userId: USER,
          scope: [`user:${USER}`],
        },
      });
      await db.query(`INSERT RELATION INTO memory_episode_member $rows`, {
        rows: [
          {
            in: new RecordId('memory_episode', 'multiconv'),
            out: new StringRecordId(String((eps ?? [])[0]!.id)),
            role: 'core',
            ord: 0,
            relevance: 1,
            segmenterVersion: 'scene-segmenter-v1',
          },
        ],
      });
      return String((eps ?? [])[0]!.id);
    });
    expect(epId.length).toBeGreaterThan(0);

    try {
      const res = await f.http
        .post('/v1/admin/maintenance/scenes')
        .set(auth())
        .send({ conversationId: CONV });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ conversations: 1, scenes: 2 });

      const after = await scenesInDb();
      expect(after).toHaveLength(3);
      const synthetic = after.find((s) => String(s.id).includes('multiconv'));
      expect(synthetic).toBeDefined();
      expect(synthetic!.generation).toBe('synthetic-generation'); // untouched
      expect(await membersOf(synthetic!.id)).toHaveLength(1); // member survived
      // The single-conversation scenes WERE swapped (fresh generation).
      const swapped = after.filter((s) => !String(s.id).includes('multiconv'));
      expect(swapped).toHaveLength(2);
      for (const scene of swapped) {
        expect(beforeGenerations.has(scene.generation)).toBe(false);
      }
    } finally {
      // Restore the 2-scene world for the forget-cascade test below.
      // Cleanup uses the id-list idiom (3.2.4 compound-index DELETE bug).
      await surreal.withCompany(f.companyId, async (db) => {
        await db.query(
          `LET $ids = (SELECT VALUE id FROM memory_episode_member
             WHERE in = memory_episode:multiconv);
           DELETE $ids;
           DELETE memory_episode:multiconv;`,
        );
      });
    }
    expect(await scenesInDb()).toHaveLength(2);
  });

  it('user forget cascades over scenes and membership', async () => {
    // Capture the user's scene ids BEFORE the forget so the membership
    // assertion below targets exactly those scenes by id — it must not
    // pass by way of the by-reference (out INSIDE deleted-episodes)
    // sweep alone masking a silently no-oped membership delete (the
    // 3.2.4 compound-index DELETE bug the cascade works around).
    const before = await scenesInDb();
    expect(before.length).toBeGreaterThan(0);
    const sceneIds = before.map((s) => s.id);

    const forget = await f.http.post(`/v1/users/${USER}/forget`).set(auth()).send({});
    expect([200, 201]).toContain(forget.status);
    expect(await waitForSceneCount(0)).toHaveLength(0);

    const surreal = f.app.get(SurrealService);
    const counts = await surreal.withCompany(f.companyId, async (db) => {
      const [forScenes] = await db.query<[Array<{ n: number }>]>(
        `SELECT count() AS n FROM memory_episode_member WHERE in INSIDE $sceneIds GROUP ALL`,
        { sceneIds },
      );
      const [total] = await db.query<[Array<{ n: number }>]>(
        `SELECT count() AS n FROM memory_episode_member GROUP ALL`,
      );
      const [userScenes] = await db.query<[Array<{ n: number }>]>(
        `SELECT count() AS n FROM memory_episode WHERE userId = $u GROUP ALL`,
        { u: USER },
      );
      return {
        membersForScenes: (forScenes ?? [])[0]?.n ?? 0,
        membersTotal: (total ?? [])[0]?.n ?? 0,
        userScenes: (userScenes ?? [])[0]?.n ?? 0,
      };
    });
    expect(counts.membersForScenes).toBe(0);
    expect(counts.membersTotal).toBe(0);
    expect(counts.userScenes).toBe(0);
  });
});
