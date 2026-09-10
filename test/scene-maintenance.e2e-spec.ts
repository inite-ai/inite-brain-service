/**
 * Scheduled scene maintenance e2e (SCENES_SCHEDULED_MAINTENANCE, migration
 * 0130) — the loop the scene plane had no runner for, end to end against a
 * real SurrealDB 3.2.4:
 *
 *   ingest turns → a dirty mark appears → the nightly pass composes exactly
 *   the dirty conversations → scenes exist → the mark is cleared → a second
 *   pass finds nothing to do (and composes nothing) → new turns re-dirty the
 *   same conversation → the pass picks it up again.
 *
 * Plus the two pins: with the flag off no mark is ever written, and the
 * admin route still performs the FULL rebuild it always did (a conversation
 * that was never marked still gets scenes from the operator button).
 *
 * Embedder-free (SCENES_TOPIC_BOUNDARY stays off) and enrichment-free
 * (SCENES_LLM_ENRICHMENT stays off) — no paid call anywhere.
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { SceneMaintenanceService } from '../src/admin/scene-maintenance.service';

const CONV = 'proj:maintenance';
const QUIET_CONV = 'proj:never-marked';
const USER = 'maintenance_user';

interface DirtyRow {
  id: unknown;
  conversationId: string;
  markedAt: string;
}

const ENV = [
  'EPISODE_SUBSTRATE_ENABLED',
  'INGEST_EPISODE_ONLY',
  'SCENES_SEGMENTATION_ENABLED',
  'SCENES_SCHEDULED_MAINTENANCE',
  'SCENES_TOPIC_BOUNDARY',
  'SCENES_LLM_ENRICHMENT',
  'SCENES_BELIEF_PROMOTION',
  'SCENES_MAINTENANCE_MAX_CONVERSATIONS',
] as const;

describe('scheduled scene maintenance (e2e)', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const k of ENV) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.EPISODE_SUBSTRATE_ENABLED = '1';
    process.env.INGEST_EPISODE_ONLY = '1';
    process.env.SCENES_SEGMENTATION_ENABLED = '1';
    process.env.SCENES_SCHEDULED_MAINTENANCE = '1';
    f = await createApp({ companyId: 'co_scene_maint_e2e' });
  });

  afterAll(async () => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    if (f) await f.close();
  });

  const ingest = async (conversationId: string, i: number, iso: string, text: string) => {
    const res = await f.http
      .post('/v1/ingest/mention')
      .set(auth())
      .send({
        text,
        contextRef: { vertical: 'proj', conversationId, messageId: `${conversationId}#${i}` },
        knownEntities: [{ vertical: 'proj', id: 'mika', role: 'speaker', name: 'mika' }],
        userId: USER,
        emittedAt: iso,
      });
    expect(res.status).toBe(201);
  };

  const dirtyRows = async (): Promise<DirtyRow[]> => {
    const surreal = f.app.get(SurrealService);
    return surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[DirtyRow[]]>(
        `SELECT id, conversationId, markedAt FROM scene_dirty_conversation
          ORDER BY markedAt ASC`,
      );
      return rows ?? [];
    });
  };

  const scenesOf = async (
    conversationId: string,
  ): Promise<Array<{ gist: string; confidence: number }>> => {
    const surreal = f.app.get(SurrealService);
    return surreal.withCompany(f.companyId, async (db) => {
      // occurredFrom must be SELECTed to be orderable (3.2.4 parse rule).
      const [rows] = await db.query<[Array<{ gist: string; confidence: number }>]>(
        `SELECT gist, confidence, occurredFrom FROM memory_episode
          WHERE conversationIds CONTAINS $conv ORDER BY occurredFrom ASC`,
        { conv: conversationId },
      );
      return rows ?? [];
    });
  };

  const maintenance = () => f.app.get(SceneMaintenanceService);

  it('ingest marks the conversation dirty', async () => {
    // One conversation, two sessions (a >60-min gap) ⇒ two scenes later.
    await ingest(CONV, 0, '2026-04-01T10:00:00.000Z', 'I started planning the Porto trip.');
    await ingest(CONV, 1, '2026-04-01T10:05:00.000Z', 'Comparing trains for next month.');
    await ingest(CONV, 2, '2026-04-01T12:00:00.000Z', 'Back to it — now the hotel.');

    const rows = await dirtyRows();
    expect(rows.map((r) => r.conversationId)).toEqual([CONV]);
    expect(rows[0]!.markedAt).toBeTruthy();
    // Three turns collapsed onto ONE row (UPSERT by primary key).
    expect(rows).toHaveLength(1);
    // Nothing has composed yet — the mark is the only artefact.
    expect(await scenesOf(CONV)).toHaveLength(0);
  });

  it('the nightly pass composes the dirty conversation and clears its mark', async () => {
    const run = await maintenance().runNightly();
    expect(run.budgetExhausted).toBe(false);
    // The roster is every tenant the shared in-process database holds — the
    // sibling e2e suites' fixtures included — so this asserts OUR tenant's
    // row, never the roster's length. Every other tenant contributes a
    // zero-work row, which the "no dirty work" case below pins.
    const mine = run.tenants.find((t) => t.companyId === f.companyId);
    expect(mine).toMatchObject({
      companyId: f.companyId,
      dirty: 1,
      conversations: 1,
      cleared: 1,
    });
    expect(mine!.error).toBeUndefined();

    const scenes = await scenesOf(CONV);
    expect(scenes).toHaveLength(2);
    // Embedder-free run: both edges are exact rules, so confidence is 1.
    expect(scenes.map((s) => s.confidence)).toEqual([1, 1]);
    expect(await dirtyRows()).toHaveLength(0);
  });

  it('a second pass finds nothing dirty and composes nothing', async () => {
    const run = await maintenance().runNightly();
    expect(run.tenants.find((t) => t.companyId === f.companyId)).toMatchObject({
      dirty: 0,
      conversations: 0,
      scenes: 0,
      cleared: 0,
    });
    // The scene world is untouched — no rebuild happened.
    expect(await scenesOf(CONV)).toHaveLength(2);
  });

  it('new turns re-dirty the same conversation and the next pass picks it up', async () => {
    await ingest(CONV, 3, '2026-04-01T12:05:00.000Z', 'Found a place near the river.');
    expect((await dirtyRows()).map((r) => r.conversationId)).toEqual([CONV]);

    const run = await maintenance().runNightly();
    expect(run.tenants.find((t) => t.companyId === f.companyId)).toMatchObject({
      dirty: 1,
      conversations: 1,
      cleared: 1,
    });
    expect(await dirtyRows()).toHaveLength(0);
    // Still two sessions, now 2 + 2 turns.
    expect(await scenesOf(CONV)).toHaveLength(2);
  });

  it('PIN: with SCENES_SCHEDULED_MAINTENANCE off, ingest marks nothing', async () => {
    delete process.env.SCENES_SCHEDULED_MAINTENANCE;
    try {
      await ingest(QUIET_CONV, 0, '2026-04-02T09:00:00.000Z', 'A conversation nobody scheduled.');
      await ingest(QUIET_CONV, 1, '2026-04-02T09:05:00.000Z', 'Still nothing marked.');
      expect(await dirtyRows()).toHaveLength(0);
      // …and the cron itself is inert.
      const run = await maintenance().runNightly();
      expect(run.tenants).toHaveLength(0);
      expect(await scenesOf(QUIET_CONV)).toHaveLength(0);
    } finally {
      process.env.SCENES_SCHEDULED_MAINTENANCE = '1';
    }
  });

  it('the admin route still does the FULL rebuild, marks or no marks', async () => {
    // QUIET_CONV was never marked; the operator button must still cover it.
    const res = await f.http.post('/v1/admin/maintenance/scenes').set(auth()).send({});
    expect(res.status).toBe(201);
    expect(res.body.conversations).toBeGreaterThanOrEqual(2);
    expect(await scenesOf(QUIET_CONV)).toHaveLength(1);
    expect(await scenesOf(CONV)).toHaveLength(2);
  });

  it('the per-tenant conversation budget caps one run and the rest drains next', async () => {
    process.env.SCENES_MAINTENANCE_MAX_CONVERSATIONS = '1';
    try {
      await ingest(CONV, 4, '2026-04-01T12:10:00.000Z', 'One more on the river place.');
      await ingest(QUIET_CONV, 2, '2026-04-02T09:10:00.000Z', 'And one here too.');
      expect(await dirtyRows()).toHaveLength(2);

      // The roster is shared with every other suite's tenant in this
      // container and sorted, so find this tenant's row rather than [0].
      const own = (run: { tenants: Array<{ companyId: string }> }) =>
        run.tenants.find((t) => t.companyId === f.companyId);
      const first = await maintenance().runNightly();
      expect(own(first)).toMatchObject({ dirty: 1, cleared: 1 });
      // Exactly one mark consumed; the other waits for the next run.
      expect(await dirtyRows()).toHaveLength(1);

      const second = await maintenance().runNightly();
      expect(own(second)).toMatchObject({ dirty: 1, cleared: 1 });
      expect(await dirtyRows()).toHaveLength(0);
    } finally {
      delete process.env.SCENES_MAINTENANCE_MAX_CONVERSATIONS;
    }
  });
});
