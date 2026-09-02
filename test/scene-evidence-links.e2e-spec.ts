/**
 * Scene evidence links e2e (MM-zoom PR1, real SurrealDB): the 0123
 * reconstructed_from activation end-to-end —
 *   (1) the linker writes scene→fragment/asset edges from member
 *       episodes' source.evidenceRefs and a re-run inserts NOTHING new
 *       (INSERT RELATION IGNORE proven on the REAL pinned server);
 *   (2) GET /v1/facts/:id/provenance with the read flag on serves the
 *       post-walk reconstructed_from edges next to the crossed
 *       supported_by edge;
 *   (3) read flag off → NO supportEdges key (byte-identical response);
 *   (4) linker flag off → zero writes on the real path (defensive
 *       return, not just the controller 404);
 *   (5) user-forget of the EVIDENCE OWNER — whose turns/facts/scenes
 *       all survive — erases the reconstructed_from edges from the out
 *       side (the 0123 GDPR leg), leaving the scene and its
 *       supported_by edge intact. Runs with the linker flag OFF (GDPR
 *       runs regardless).
 */
import { AppFixture, createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { SceneBacklinkService } from '../src/admin/scene-backlink.service';
import { SceneEvidenceLinkerService } from '../src/admin/scene-evidence-linker.service';
import { SEGMENTER_VERSION } from '../src/admin/scene-segmentation';
import { UserForgetService } from '../src/entities/user-forget.service';

const FLAG_KEYS = [
  'FACTS_API_ENABLED',
  'PROVENANCE_RECURSIVE_CLOSURE',
  'PROVENANCE_SUPPORT_EDGES',
  'PROVENANCE_SUPPORT_GRAPH_READ',
  'SCENES_FACT_BACKLINK',
  'SCENES_EVIDENCE_LINKS',
] as const;
const savedEnv = new Map<string, string | undefined>();

describe('scene evidence links (real SurrealDB)', () => {
  let f: AppFixture;
  let surreal: SurrealService;
  let sceneId = '';
  let assetId = '';
  let fragmentId = '';
  let backlinkFactId = '';
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  const countEdges = async (where: string, params: Record<string, unknown> = {}) =>
    surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[Array<{ n: number }>]>(
        `SELECT count() AS n FROM memory_support ${where} GROUP ALL`,
        params,
      );
      return rows?.[0]?.n ?? 0;
    });

  beforeAll(async () => {
    for (const k of FLAG_KEYS) savedEnv.set(k, process.env[k]);
    process.env.FACTS_API_ENABLED = '1';
    process.env.PROVENANCE_RECURSIVE_CLOSURE = '1';
    process.env.PROVENANCE_SUPPORT_EDGES = '1';
    process.env.PROVENANCE_SUPPORT_GRAPH_READ = '1';
    process.env.SCENES_FACT_BACKLINK = '1';
    process.env.SCENES_EVIDENCE_LINKS = '1';
    f = await createApp({ companyId: 'co_scene_evidence_links_e2e' });
    surreal = f.app.get(SurrealService);

    await surreal.withCompany(f.companyId, async (db) => {
      // Evidence rows owned by 'user-evd' — the forget subject whose
      // TURNS do not exist (the scene must survive their forget).
      const [assetRows] = await db.query<[Array<{ id: unknown }>]>(
        `CREATE evidence_asset CONTENT {
           modality: 'image', mediaType: 'image/jpeg',
           byteHash: 'sel-e2e-hash', byteLength: 128,
           occurredAt: d'2026-07-01T09:00:00Z', availability: 'hot',
           piiClasses: [], vertical: 'rent', userId: 'user-evd'
         }`,
      );
      assetId = String(assetRows[0]!.id);
      const [fragRows] = await db.query<[Array<{ id: unknown }>]>(
        `CREATE evidence_fragment CONTENT {
           assetId: $assetId, locator: { kind: 'pageRegion' }, piiClasses: []
         }`,
        { assetId: assetRows[0]!.id },
      );
      fragmentId = String(fragRows[0]!.id);

      // Two tenant-global turns; the SEEDED evidence refs are the
      // producer stand-in (the metadata-ingest path is not wired to
      // episodes yet — the linker's contract is the FLEXIBLE key).
      // The 'episode:' decoy pins the membership-ref exclusion.
      const [epRows] = await db.query<[Array<{ id: unknown }>]>(`INSERT INTO episode $rows`, {
        rows: [
          {
            kind: 'turn',
            conversationId: 'conv_sel',
            messageId: 'sel1',
            speaker: 'user',
            text: 'here is the signed lease scan',
            occurredAt: new Date('2026-07-01T10:00:00Z'),
            source: { evidenceRefs: [fragmentId, 'episode:decoy'] },
          },
          {
            kind: 'turn',
            conversationId: 'conv_sel',
            messageId: 'sel2',
            speaker: 'assistant',
            text: 'scan received and filed',
            occurredAt: new Date('2026-07-01T10:01:00Z'),
            source: { evidenceRefs: [assetId] },
          },
        ],
      });
      const episodeRefs = (epRows ?? []).map((r) => r.id);
      const episodeIds = episodeRefs.map(String);

      const [sceneRows] = await db.query<[Array<{ id: unknown }>]>(
        `CREATE memory_episode CONTENT $scene`,
        {
          scene: {
            sceneLabel: 'lease scan intake',
            conversationIds: ['conv_sel'],
            occurredFrom: new Date('2026-07-01T10:00:00Z'),
            occurredTo: new Date('2026-07-01T10:01:00Z'),
            gist: 'user: here is the signed lease scan',
            confidence: 0.9,
            segmenterVersion: SEGMENTER_VERSION,
            generation: 'gen-e2e',
            source: {},
          },
        },
      );
      sceneId = String(sceneRows[0]!.id);
      await db.query(`INSERT RELATION INTO memory_episode_member $rows`, {
        rows: episodeRefs.map((out, ord) => ({
          in: sceneRows[0]!.id,
          out,
          role: 'core',
          ord,
          relevance: 1,
          segmenterVersion: SEGMENTER_VERSION,
        })),
      });

      // A grounded fact in the scene's conversation — the backlink
      // writer emits the fact-supported_by->scene edge the provenance
      // walk crosses to reach the scene.
      const [entRows] = await db.query<[Array<{ id: unknown }>]>(
        `CREATE knowledge_entity CONTENT { type: 'customer', canonicalName: 'Scene Evidence Subject' }`,
      );
      const [factRows] = await db.query<[Array<{ id: unknown }>]>(
        `CREATE knowledge_fact CONTENT $fact`,
        {
          fact: {
            entityId: entRows[0]!.id,
            predicate: 'said',
            object: 'here is the signed lease scan',
            confidence: 0.9,
            validFrom: new Date('2026-07-01T00:00:00Z'),
            status: 'active',
            source: { kind: 'fact', conversationId: 'conv_sel', episodeIds: [episodeIds[0]] },
          },
        },
      );
      backlinkFactId = String(factRows[0]!.id);
    });
  });

  afterAll(async () => {
    for (const k of FLAG_KEYS) {
      const v = savedEnv.get(k);
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await f.close();
  });

  it('linker writes scene→fragment/asset edges; a re-run inserts NOTHING new (IGNORE proven)', async () => {
    const linker = f.app.get(SceneEvidenceLinkerService);
    const first = await linker.run(f.companyId);
    expect(first).toEqual({ scenes: 1, scenesLinked: 1, edges: 2 });
    expect(await countEdges(`WHERE kind = 'reconstructed_from'`)).toBe(2);

    // Replay — same deterministic scene id, same refs: INSERT RELATION
    // IGNORE over UNIQUE(in, out, kind) must dedupe on the REAL server.
    await linker.run(f.companyId);
    expect(await countEdges(`WHERE kind = 'reconstructed_from'`)).toBe(2);

    const rows = await surreal.withCompany(f.companyId, async (db) => {
      const [r] = await db.query<
        [Array<{ in: unknown; out: unknown; writer: string; writerVersion: string }>]
      >(`SELECT in, out, writer, writerVersion FROM memory_support
           WHERE kind = 'reconstructed_from' ORDER BY out`);
      return r ?? [];
    });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(String(row.in)).toBe(sceneId);
      expect(row.writer).toBe('scene_evidence_linker');
      expect(row.writerVersion).toBe(SEGMENTER_VERSION);
    }
    expect(rows.map((r) => String(r.out)).sort()).toEqual([assetId, fragmentId].sort());
  });

  it('provenance serves the post-walk reconstructed_from edges next to the crossed supported_by', async () => {
    // The backlink writer emits the fact→scene edge the walk crosses.
    const backlink = f.app.get(SceneBacklinkService);
    const linked = await backlink.run(f.companyId);
    expect(linked.factsLinked).toBe(1);

    const res = await f.http
      .get(`/v1/facts/${encodeURIComponent(backlinkFactId)}/provenance`)
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.supportEdges).toEqual(
      expect.arrayContaining([
        { kind: 'supported_by', from: backlinkFactId, to: sceneId },
        { kind: 'reconstructed_from', from: sceneId, to: fragmentId },
        { kind: 'reconstructed_from', from: sceneId, to: assetId },
      ]),
    );
    // The zoom edges never leak into the fact-closure surfaces.
    expect(res.body.derivedFacts).toEqual([]);
  });

  it('read flag OFF: the provenance response has NO supportEdges key (byte-identical)', async () => {
    process.env.PROVENANCE_SUPPORT_GRAPH_READ = '0';
    try {
      const res = await f.http
        .get(`/v1/facts/${encodeURIComponent(backlinkFactId)}/provenance`)
        .set(auth());
      expect(res.status).toBe(200);
      expect(res.body).not.toHaveProperty('supportEdges');
    } finally {
      process.env.PROVENANCE_SUPPORT_GRAPH_READ = '1';
    }
  });

  it('linker flag OFF: zero result and NO new writes on the real path (defensive return)', async () => {
    process.env.SCENES_EVIDENCE_LINKS = '0';
    try {
      const result = await f.app.get(SceneEvidenceLinkerService).run(f.companyId);
      expect(result).toEqual({ scenes: 0, scenesLinked: 0, edges: 0 });
    } finally {
      process.env.SCENES_EVIDENCE_LINKS = '1';
    }
    expect(await countEdges(`WHERE kind = 'reconstructed_from'`)).toBe(2);
  });

  it('user-forget of the evidence owner erases the zoom edges from the OUT side; the scene survives', async () => {
    // 'user-evd' owns ONLY the evidence rows — no turns, no facts, no
    // scenes — so the main support-edge erase has no subjects and the
    // scene must survive. The dying asset/fragment endpoints alone must
    // take the reconstructed_from edges with them (the 0123 out-side
    // leg in eraseEvidenceRows), with the linker flag OFF (GDPR runs
    // regardless of the write flag).
    process.env.SCENES_EVIDENCE_LINKS = '0';
    try {
      await f.app.get(UserForgetService).forgetUser(f.companyId, 'user-evd');
    } finally {
      process.env.SCENES_EVIDENCE_LINKS = '1';
    }
    await surreal.withCompany(f.companyId, async (db) => {
      const [assets] = await db.query<[unknown[]]>(`SELECT id FROM evidence_asset`);
      const [frags] = await db.query<[unknown[]]>(`SELECT id FROM evidence_fragment`);
      const [scenes] = await db.query<[unknown[]]>(`SELECT id FROM memory_episode`);
      expect(assets ?? []).toHaveLength(0);
      expect(frags ?? []).toHaveLength(0);
      expect(scenes ?? []).toHaveLength(1);
    });
    expect(await countEdges(`WHERE kind = 'reconstructed_from'`)).toBe(0);
    // The claim-plane edge to the surviving scene is untouched.
    expect(await countEdges(`WHERE kind = 'supported_by'`)).toBe(1);
  });
});
