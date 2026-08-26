/**
 * Brain v2 shadow Scenes substrate e2e (migration 0106): flag gate (off →
 * 404, no rows), scene derivation over episode-only ingest (two sessions →
 * two scenes with contiguous core membership, gist, version + generation
 * stamps, a 'built' projection row), idempotent re-run on a fresh
 * generation, and the user-forget GDPR cascade taking scenes + members.
 * Embedder-free path (SCENES_TOPIC_BOUNDARY stays off) — no paid calls.
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';

const CONV = 'proj:scenes';
const USER = 'scene_user';

interface SceneRow {
  id: unknown;
  gist: string;
  sceneLabel: string;
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
    for (const scene of scenes) {
      expect(scene.gist.length).toBeGreaterThan(0);
      expect(scene.segmenterVersion).toBe('scene-segmenter-v1');
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

  it('user forget cascades over scenes and membership', async () => {
    const forget = await f.http.post(`/v1/users/${USER}/forget`).set(auth()).send({});
    expect([200, 201]).toContain(forget.status);
    expect(await waitForSceneCount(0)).toHaveLength(0);
    const surreal = f.app.get(SurrealService);
    const members = await surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[Array<{ n: number }>]>(
        `SELECT count() AS n FROM memory_episode_member GROUP ALL`,
      );
      return (rows ?? [])[0]?.n ?? 0;
    });
    expect(members).toBe(0);
  });
});
