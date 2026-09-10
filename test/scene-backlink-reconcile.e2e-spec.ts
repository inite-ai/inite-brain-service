/**
 * Scene backlink reconcile e2e (audit 2026-09-06, note 2), against the
 * real pinned server: a GDPR erase of a co-grounded subject takes the
 * scene that quoted its turn, and the surviving fact of ANOTHER subject
 * keeps a pointer to the dead scene until the backlink re-run SETs its
 * stamp to the live set (stale gone, valid kept, idempotent after). The
 * version purge verb then empties the world: a tenant-wide re-run still
 * reaches the conversation that lost every scene, and a rebuild re-links
 * through the composer's post-swap hook. Mirrors
 * scene-enrichment.e2e-spec.ts: episode-only ingest, embedder-free
 * segmentation, direct fact seed (no paid derive call).
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { SEGMENTER_VERSION } from '../src/admin/scene-segmentation';

const CONV = 'proj:scene-backlink';
const USER = 'sbr_user';
const FACT_A = 'knowledge_fact:sbr_a';
const FACT_B = 'knowledge_fact:sbr_b';
const FACT_Z = 'knowledge_fact:sbr_z';

describe('scene backlink reconcile (e2e)', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  const saved: Record<string, string | undefined> = {};
  beforeAll(async () => {
    for (const k of [
      'EPISODE_SUBSTRATE_ENABLED',
      'INGEST_EPISODE_ONLY',
      'SCENES_SEGMENTATION_ENABLED',
      'SCENES_FACT_BACKLINK',
    ]) {
      saved[k] = process.env[k];
      process.env[k] = '1';
    }
    for (const k of [
      'SCENES_LLM_ENRICHMENT',
      'SCENES_GIST_EMBEDDING',
      'SCENES_ENTITY_LINKS',
      'SCENES_EVIDENCE_LINKS',
      'SCENES_BELIEF_PROMOTION',
      'SCENES_VERSION_FINGERPRINT',
      'PROVENANCE_SUPPORT_EDGES',
    ]) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    f = await createApp({ companyId: 'co_scene_backlink_e2e' });

    // One conversation, two sessions: 3 turns, a >60-min gap, then 2.
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
          contextRef: { vertical: 'proj', conversationId: CONV, messageId: `sbr${i}` },
          knownEntities: [{ vertical: 'proj', id: 'mika', role: 'speaker', name: 'mika' }],
          userId: USER,
          emittedAt: turn.t,
        });
      expect(res.status).toBe(201);
    }

    // Two subjects. `keep` owns fact A (turn 0, first scene) and fact B
    // (turn 3, second scene); `gone` owns fact Z, co-grounded in turn 3 —
    // erasing `gone` erases turn 3 and therefore the second scene, while
    // fact B survives it.
    const surreal = f.app.get(SurrealService);
    await surreal.withCompany(f.companyId, async (db) => {
      const [eps] = await db.query<[Array<{ id: unknown }>]>(
        `SELECT id, occurredAt FROM episode WHERE conversationId = $conv ORDER BY occurredAt ASC`,
        { conv: CONV },
      );
      const ids = (eps ?? []).map((e) => String(e.id));
      expect(ids).toHaveLength(5);
      await db.query(
        `CREATE knowledge_entity:sbr_keep CONTENT {
           type: 'other', canonicalName: 'Mika', externalRefs: { proj: 'sbr_keep' }
         }`,
      );
      await db.query(
        `CREATE knowledge_entity:sbr_gone CONTENT {
           type: 'other', canonicalName: 'Other', externalRefs: { proj: 'sbr_gone' }
         }`,
      );
      const seed = async (id: string, entity: string, object: string, ep: string) =>
        db.query(
          `CREATE ${id} CONTENT {
             entityId: ${entity},
             predicate: 'travel',
             object: $object,
             confidence: 0.85,
             validFrom: $vf,
             source: { vertical: 'derived', recorder: 'test-seed', conversationId: $conv,
                       episodeIds: [$ep] }
           }`,
          { object, vf: new Date('2026-02-01'), conv: CONV, ep },
        );
      await seed(FACT_A, 'knowledge_entity:sbr_keep', 'Mika is planning a Lisbon trip.', ids[0]!);
      await seed(FACT_B, 'knowledge_entity:sbr_keep', 'Mika is looking at hotels.', ids[3]!);
      await seed(FACT_Z, 'knowledge_entity:sbr_gone', 'Other mentioned the hotel too.', ids[3]!);
    });

    // Build the world; the backlink flag is on, so the post-swap hook
    // stamps the facts as part of the compose.
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

  /** Scene ids of the world in time order. */
  const sceneIds = async (): Promise<string[]> => {
    const surreal = f.app.get(SurrealService);
    return surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[Array<{ id: unknown }>]>(
        `SELECT id, occurredFrom FROM memory_episode ORDER BY occurredFrom ASC`,
      );
      return (rows ?? []).map((r) => String(r.id));
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

  const rerun = () => f.http.post('/v1/admin/maintenance/scenes/backlink').set(auth()).send({});

  it('links every fact to the scene quoting its grounding turn', async () => {
    const [s1, s2] = await sceneIds();
    const res = await rerun();
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ scenes: 2, factsLinked: 3, stalePointersRemoved: 0 });
    expect(await factSource(FACT_A)).toMatchObject({
      memoryEpisodeIds: [s1],
      sceneLinkVersion: SEGMENTER_VERSION,
    });
    expect((await factSource(FACT_B)).memoryEpisodeIds).toEqual([s2]);
    expect((await factSource(FACT_Z)).memoryEpisodeIds).toEqual([s2]);
  });

  it('GDPR erase of a co-grounded subject: the re-run drops the pointer to the dead scene and keeps the live one', async () => {
    const [s1, s2] = await sceneIds();
    const forget = await f.http
      .post('/v1/entities/knowledge_entity:sbr_gone/forget')
      .set(auth())
      .send({ reason: 'gdpr_request', requestId: 'sbr-req-1' });
    expect([200, 201]).toContain(forget.status);

    // The cascade took the second scene (it quoted the erased turn) and
    // fact Z; fact B survives pointing at a scene that no longer exists —
    // the gap the reconcile closes.
    expect(await sceneIds()).toEqual([s1]);
    expect((await factSource(FACT_B)).memoryEpisodeIds).toEqual([s2]);

    const res = await rerun();
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ scenes: 1, factsLinked: 1, stalePointersRemoved: 1 });
    expect(await factSource(FACT_B)).toMatchObject({
      memoryEpisodeIds: [],
      sceneLinkVersion: SEGMENTER_VERSION,
    });
    expect((await factSource(FACT_A)).memoryEpisodeIds).toEqual([s1]);

    // Idempotent: a second re-run finds nothing to repair and changes nothing.
    const again = await rerun();
    expect(again.body).toEqual({ scenes: 1, factsLinked: 1, stalePointersRemoved: 0 });
    expect((await factSource(FACT_B)).memoryEpisodeIds).toEqual([]);
    expect((await factSource(FACT_A)).memoryEpisodeIds).toEqual([s1]);
  });

  it('version purge: a tenant-wide re-run clears the conversation that lost its world; a rebuild re-links', async () => {
    const [s1] = await sceneIds();
    const purge = await f.http
      .delete(`/v1/admin/maintenance/scenes/versions/${SEGMENTER_VERSION}`)
      .set(auth())
      .send({});
    expect(purge.status).toBe(200);
    expect(purge.body).toMatchObject({ scenes: 1 });
    expect(await sceneIds()).toEqual([]);
    expect((await factSource(FACT_A)).memoryEpisodeIds).toEqual([s1]);

    // No scene selects this conversation any more — the stamped-fact
    // scan is the only way the run reaches it.
    const res = await rerun();
    expect(res.body).toEqual({ scenes: 0, factsLinked: 0, stalePointersRemoved: 1 });
    expect((await factSource(FACT_A)).memoryEpisodeIds).toEqual([]);

    // Rebuild: four surviving turns still split at the gap into two
    // scenes with the same deterministic ids; the post-swap hook
    // re-links A, and B (its turn was erased) stays empty.
    const recompose = await f.http.post('/v1/admin/maintenance/scenes').set(auth()).send({});
    expect(recompose.status).toBe(201);
    expect(recompose.body).toMatchObject({ conversations: 1, scenes: 2 });
    expect((await sceneIds())[0]).toBe(s1);
    expect((await factSource(FACT_A)).memoryEpisodeIds).toEqual([s1]);
    expect((await factSource(FACT_B)).memoryEpisodeIds).toEqual([]);
  });
});
