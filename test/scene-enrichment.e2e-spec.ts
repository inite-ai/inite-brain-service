/**
 * Brain v2 PR2 e2e: LLM enrichment (stubbed model — no paid calls) as a
 * REVISION beside the deterministic originals (Drift-3b / migration 0118:
 * gist/memoryValue immutable, enriched* siblings + model/version stamps,
 * idempotent skip on re-run, compose-over-enrich reset + post-swap hook
 * re-enrichment), fact backlink (idempotent source.memoryEpisodeIds
 * stamps), and version purge (rows gone + projection ledger row demoted
 * to 'residual'). Mirrors memory-episode.e2e-spec.ts: episode-only
 * ingest, embedder-free segmentation (SCENES_TOPIC_BOUNDARY stays off),
 * flags flipped via process.env after boot and restored in afterAll.
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { mockSceneEnricherOpenAi } from './test-doubles';
import { SurrealService } from '../src/db/surreal.service';
import { sceneEnrichmentVersion } from '../src/admin/scene-enricher.service';

const CONV = 'proj:scene-enrich';
const USER = 'scene2_user';

interface SceneRow {
  id: unknown;
  gist: string;
  gistPromptVersion?: string;
  memoryValue?: Record<string, unknown>;
  stateDeltas?: Array<Record<string, unknown>>;
  unexpectedDetails?: string[];
  enrichedGist?: string;
  enrichedMemoryValue?: Record<string, unknown>;
  enrichmentModel?: string;
  enrichmentVersion?: string;
  enrichedAt?: unknown;
}

const ENRICHMENT_REPLY = JSON.stringify({
  gist: 'Mika planned the Lisbon trip: compared flights and booked the morning one.',
  memoryValue: {
    novelty: 0.8,
    contradiction: 0,
    stateChange: 0.6,
    identity: 0.2,
    explicitness: 0.9,
    estimatedUtility: 0.7,
  },
  stateDeltas: [{ subject: 'mika', field: 'trip.flight', from: '', to: 'booked' }],
  unexpectedDetails: ['booked the morning flight'],
  entityMentions: ['Mika', 'Lisbon'],
});

describe('scene enrichment + fact backlink + version purge (e2e)', () => {
  let f: AppFixture;
  let episodeIds: string[] = [];
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  const saved: Record<string, string | undefined> = {};
  beforeAll(async () => {
    for (const k of ['EPISODE_SUBSTRATE_ENABLED', 'INGEST_EPISODE_ONLY']) {
      saved[k] = process.env[k];
      process.env[k] = '1';
    }
    // Master on for the whole suite; the PR2 flags start OFF so each `it`
    // proves its own 404 gate before flipping its flag on.
    saved.SCENES_SEGMENTATION_ENABLED = process.env.SCENES_SEGMENTATION_ENABLED;
    process.env.SCENES_SEGMENTATION_ENABLED = '1';
    for (const k of ['SCENES_LLM_ENRICHMENT', 'SCENES_FACT_BACKLINK']) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    f = await createApp({ companyId: 'co_scene_enrich_e2e' });

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
          contextRef: { vertical: 'proj', conversationId: CONV, messageId: `se${i}` },
          knownEntities: [{ vertical: 'proj', id: 'mika', role: 'speaker', name: 'mika' }],
          userId: USER,
          emittedAt: turn.t,
        });
      expect(res.status).toBe(201);
    }

    // Seed facts the backlink pass will (and will not) match: factA is
    // grounded in the first session's opening turn; factB belongs to a
    // DIFFERENT conversation — the control that must stay unstamped.
    // Direct DB seed mirrors facts-list-competing.e2e-spec.ts — the
    // derive path is a paid LLM call this suite must not make.
    const surreal = f.app.get(SurrealService);
    episodeIds = await surreal.withCompany(f.companyId, async (db) => {
      const [eps] = await db.query<[Array<{ id: unknown }>]>(
        `SELECT id, occurredAt FROM episode WHERE conversationId = $conv ORDER BY occurredAt ASC`,
        { conv: CONV },
      );
      const ids = (eps ?? []).map((e) => String(e.id));
      expect(ids).toHaveLength(5);
      await db.query(
        `CREATE knowledge_entity:se_subj CONTENT {
           type: 'other',
           canonicalName: 'Mika',
           externalRefs: { proj: 'mika' }
         }`,
      );
      await db.query(
        `CREATE knowledge_fact:se_a CONTENT {
           entityId: knowledge_entity:se_subj,
           predicate: 'travel',
           object: 'Mika is planning a Lisbon trip.',
           confidence: 0.85,
           validFrom: $vf,
           source: { vertical: 'derived', recorder: 'test-seed', conversationId: $conv,
                     episodeIds: [$ep0] }
         }`,
        { vf: new Date('2026-02-01'), conv: CONV, ep0: ids[0] },
      );
      await db.query(
        `CREATE knowledge_fact:se_b CONTENT {
           entityId: knowledge_entity:se_subj,
           predicate: 'travel',
           object: 'Control fact from another conversation.',
           confidence: 0.85,
           validFrom: $vf,
           source: { vertical: 'derived', recorder: 'test-seed', conversationId: 'proj:other',
                     episodeIds: [$ep0] }
         }`,
        { vf: new Date('2026-02-01'), ep0: ids[0] },
      );
      return ids;
    });

    // Build the scene world once (PR2 flags are still off ⇒ the composer
    // runs pure PR1: deterministic gists, no LLM, no fact stamps).
    const run = await f.http.post('/v1/admin/maintenance/scenes').set(auth()).send({});
    expect(run.status).toBe(201);
    expect(run.body).toMatchObject({ conversations: 1, scenes: 2 });
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

  const factSource = async (factId: string): Promise<Record<string, unknown>> => {
    const surreal = f.app.get(SurrealService);
    return surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[Array<{ source: Record<string, unknown> }>]>(
        `SELECT source FROM ${factId}`,
      );
      return (rows ?? [])[0]?.source ?? {};
    });
  };

  it('enriches scenes as a revision: originals intact, enriched* siblings + stamps', async () => {
    // Deterministic world before enrichment (flag off ⇒ 404, gist intact).
    const before = await scenesInDb();
    expect(before).toHaveLength(2);
    for (const scene of before) {
      expect(scene.gist).toContain('opens:'); // PR1 deterministic render
      expect(scene.gistPromptVersion).toBeUndefined();
      expect(scene.enrichedGist).toBeUndefined();
      expect(scene.enrichmentVersion).toBeUndefined();
    }
    const gated = await f.http.post('/v1/admin/maintenance/scenes/enrich').set(auth()).send({});
    expect(gated.status).toBe(404);

    process.env.SCENES_LLM_ENRICHMENT = '1';
    const mock = mockSceneEnricherOpenAi(f.app, [ENRICHMENT_REPLY]);
    const res = await f.http.post('/v1/admin/maintenance/scenes/enrich').set(auth()).send({});
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ scenes: 2, enriched: 2, failed: 0, skipped: 0 });
    expect(mock.calls).toHaveLength(2);
    // The scene transcripts (not the deterministic gists) are what the
    // model saw — one call per scene, in unspecified scene order.
    const prompts = mock.calls.map((c) => c.user).join('\n===\n');
    expect(prompts).toContain('Lisbon trip');
    expect(prompts).toContain('near the river');

    const after = await scenesInDb();
    const originals = new Map(before.map((s) => [String(s.id), s]));
    for (const scene of after) {
      // Drift-3b: the deterministic originals are byte-identical — the
      // enricher writes ONLY the revision siblings + stamps (0118).
      const original = originals.get(String(scene.id))!;
      expect(scene.gist).toBe(original.gist);
      expect(scene.gist).toContain('opens:');
      expect(scene.memoryValue).toEqual(original.memoryValue);
      expect(scene.gistPromptVersion).toBeUndefined(); // legacy-dead, never written
      expect(scene.enrichedGist).toBe(
        'Mika planned the Lisbon trip: compared flights and booked the morning one.',
      );
      expect(scene.enrichedMemoryValue).toMatchObject({
        novelty: 0.8,
        contradiction: 0,
        stateChange: 0.6,
        identity: 0.2,
        explicitness: 0.9,
        estimatedUtility: 0.7,
        scorerVersion: 'scene-scorer-llm-v1',
      });
      expect(scene.enrichedMemoryValue!.scoredAt).toBeDefined();
      expect(scene.stateDeltas).toEqual([
        { subject: 'mika', field: 'trip.flight', from: '', to: 'booked' },
      ]);
      expect(scene.unexpectedDetails).toEqual(['booked the morning flight']);
      // The resolved model id is stamped, and the composite names it.
      expect(typeof scene.enrichmentModel).toBe('string');
      expect(scene.enrichmentModel!.length).toBeGreaterThan(0);
      expect(scene.enrichmentVersion).toBe(sceneEnrichmentVersion(scene.enrichmentModel!));
      expect(scene.enrichedAt).toBeDefined();
    }
  });

  it('re-enrich with unchanged prompt+scorer+model is idempotent: zero calls, all skipped', async () => {
    const mock = mockSceneEnricherOpenAi(f.app, [ENRICHMENT_REPLY]);
    const res = await f.http.post('/v1/admin/maintenance/scenes/enrich').set(auth()).send({});
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ scenes: 2, enriched: 0, failed: 0, skipped: 2 });
    expect(mock.calls).toHaveLength(0);
  });

  it('composer re-run resets the revision; the post-swap hook re-enriches', async () => {
    // Flag off: a re-compose swaps in fresh rows WITHOUT enriched*
    // columns (deterministic-only) — enrichment is a revision on rows,
    // not a property of the world.
    delete process.env.SCENES_LLM_ENRICHMENT;
    const plain = await f.http.post('/v1/admin/maintenance/scenes').set(auth()).send({});
    expect(plain.status).toBe(201);
    expect(plain.body).toMatchObject({ conversations: 1, scenes: 2 });
    const fresh = await scenesInDb();
    expect(fresh).toHaveLength(2);
    for (const scene of fresh) {
      expect(scene.gist).toContain('opens:');
      expect(scene.enrichedGist).toBeUndefined();
      expect(scene.enrichmentVersion).toBeUndefined();
    }
    // Flag on: the composer's post-swap hook re-enriches the fresh rows.
    process.env.SCENES_LLM_ENRICHMENT = '1';
    const mock = mockSceneEnricherOpenAi(f.app, [ENRICHMENT_REPLY]);
    const hooked = await f.http.post('/v1/admin/maintenance/scenes').set(auth()).send({});
    expect(hooked.status).toBe(201);
    expect(mock.calls).toHaveLength(2);
    for (const scene of await scenesInDb()) {
      expect(scene.gist).toContain('opens:'); // originals still intact
      expect(scene.enrichedGist).toBe(
        'Mika planned the Lisbon trip: compared flights and booked the morning one.',
      );
    }
  });

  it('backlinks facts idempotently: pointer stamped once, control fact untouched', async () => {
    const gated = await f.http.post('/v1/admin/maintenance/scenes/backlink').set(auth()).send({});
    expect(gated.status).toBe(404);

    process.env.SCENES_FACT_BACKLINK = '1';
    const res = await f.http.post('/v1/admin/maintenance/scenes/backlink').set(auth()).send({});
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ scenes: 2, factsLinked: 1 });

    const scenes = await scenesInDb();
    const firstSceneId = String(scenes[0]!.id); // covers the first session (ep0)
    const linked = await factSource('knowledge_fact:se_a');
    expect(linked.memoryEpisodeIds).toEqual([firstSceneId]);
    expect(linked.sceneLinkVersion).toBe('scene-segmenter-v1');
    expect(linked.episodeIds).toEqual([episodeIds[0]]); // grounding untouched
    const control = await factSource('knowledge_fact:se_b');
    expect(control.memoryEpisodeIds).toBeUndefined();

    // Re-run: array::union keeps the pointer set duplicate-free.
    const rerun = await f.http.post('/v1/admin/maintenance/scenes/backlink').set(auth()).send({});
    expect(rerun.status).toBe(201);
    expect((await factSource('knowledge_fact:se_a')).memoryEpisodeIds).toEqual([firstSceneId]);
  });

  it('purges the segmenter version: rows gone, registry row residual', async () => {
    const tooLong = await f.http
      .delete(`/v1/admin/maintenance/scenes/versions/${'x'.repeat(65)}`)
      .set(auth())
      .send({});
    expect(tooLong.status).toBe(400);

    const res = await f.http
      .delete('/v1/admin/maintenance/scenes/versions/scene-segmenter-v1')
      .set(auth())
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ scenes: 2, members: 5 });

    const surreal = f.app.get(SurrealService);
    const counts = await surreal.withCompany(f.companyId, async (db) => {
      const [scenes] = await db.query<[Array<{ n: number }>]>(
        `SELECT count() AS n FROM memory_episode GROUP ALL`,
      );
      const [members] = await db.query<[Array<{ n: number }>]>(
        `SELECT count() AS n FROM memory_episode_member GROUP ALL`,
      );
      const [projection] = await db.query<[Array<{ status: string }>]>(
        `SELECT status FROM projection WHERE name = 'scenes'`,
      );
      return {
        scenes: (scenes ?? [])[0]?.n ?? 0,
        members: (members ?? [])[0]?.n ?? 0,
        projection: projection ?? [],
      };
    });
    expect(counts.scenes).toBe(0);
    expect(counts.members).toBe(0);
    expect(counts.projection).toHaveLength(1);
    expect(counts.projection[0]!.status).toBe('residual');
  });
});
