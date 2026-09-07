/**
 * E2E for pack memory projections (migration 0110,
 * PACK_MEMORY_PROJECTIONS_ENABLED): an external indexer pack that
 * declares a memoryModel stages `scenes`/`stateDeltas` through
 * POST /v1/documents/:id/candidates; the commit step projects them into
 * shadow memory_episode rows under segmenterVersion `pack:<packId>+<fp>`
 * and registers the world as (name `scenes:<packId>`) in the projection
 * ledger. Covers: the flag fence (400 when off), the declaration fence
 * (undeclared schemaId/state 400), the happy-path projection (rows,
 * statuses, commitRefs, registry), default-deny redaction of the audit
 * view, the CAPTURE-path (mention) origin writing into the same pack
 * world with an L0 membership edge, and the version purge through the
 * existing admin scenes verb.
 *
 * Plus the FULL LOOP (SCENES_PACK_DELTA_PROMOTION): document → scenes →
 * pack-namespaced state deltas → semantic_belief. Before it, prod ran
 * PACK_MEMORY_PROJECTIONS_ENABLED=1 writing deltas nothing could ever
 * read — the deltas carried no `field` and the promoter's version fence
 * excluded the `pack:` worlds. No paid calls: the extractor is stubbed
 * and belief statements stay on the deterministic template.
 */
import { AppFixture, createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { packSceneVersion } from '../src/documents/scene-candidate-writer.service';
import { BELIEF_PROMOTER_VERSION } from '../src/admin/belief-promotion.service';

describe('pack memory projections (e2e)', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });
  const readOnlyAuth = () => ({ Authorization: `Bearer ${f.extraApiKeys[0]}` });
  const surreal = () => f.app.get(SurrealService);

  const PACK_ID = 'realty_proj';
  const PACK_VERSION = '1.0.0';
  const DOC_TEXT =
    'Viewing log: the client toured 12 Elm St, asked about the asking ' +
    'price, and said they would sleep on an offer.';

  const MANIFEST = {
    id: PACK_ID,
    version: PACK_VERSION,
    description: 'Pack memory projections e2e pack (0110).',
    indexer: { mode: 'external' },
    predicates: [
      {
        localId: 'deal_stage',
        displayLabel: 'deal stage',
        description: 'TYPE subject is a deal; value is its stage',
        datatype: 'string',
        semantics: 'single_active',
        decayHalfLifeDays: null,
        piiClass: 'none',
        status: 'active',
      },
    ],
    memoryModel: {
      // `cues` are the literal substrings the CAPTURE-path producer reads;
      // the document path ignores them (an external indexer submits its
      // own scene hypotheses).
      sceneSchemas: [
        { id: 'viewing', description: 'A property viewing.', cues: ['viewing', 'open house'] },
      ],
      stateModels: [
        {
          id: 'deal',
          subjectType: 'deal',
          states: ['open', 'under_offer', 'closed'],
          transitions: [{ from: 'open', to: 'under_offer' }],
        },
      ],
    },
  };

  const savedEpisodes = process.env.EPISODE_SUBSTRATE_ENABLED;

  beforeAll(async () => {
    f = await createApp({
      companyId: 'co_pack_proj_e2e',
      scopes: ['brain:read', 'brain:write', 'brain:admin', 'brain:read_pii', 'indexer:write'],
      // A plain-read key in the SAME tenant for the default-deny check.
      extraKeys: [{ scopes: ['brain:read'] }],
    });
    process.env.DOCUMENT_INGEST_ENABLED = '1';
    process.env.PACK_MEMORY_PROJECTIONS_ENABLED = '1';
    // The capture-path producer projects only a CAPTURED turn — the L0
    // episode row is its GDPR erasure anchor.
    process.env.EPISODE_SUBSTRATE_ENABLED = '1';
    const install = await f.http.post('/v1/admin/packs').set(auth()).send({ manifest: MANIFEST });
    expect([200, 201]).toContain(install.status);
  });

  afterAll(async () => {
    delete process.env.DOCUMENT_INGEST_ENABLED;
    delete process.env.PACK_MEMORY_PROJECTIONS_ENABLED;
    if (savedEpisodes === undefined) delete process.env.EPISODE_SUBSTRATE_ENABLED;
    else process.env.EPISODE_SUBSTRATE_ENABLED = savedEpisodes;
    if (f) await f.close();
  });

  async function createDoc(text: string, userId?: string) {
    // Empty extraction: the document exists purely as a Source for the
    // external indexer to read.
    f.extractor.setScript({ entities: [], facts: [], edges: [] });
    const r = await f.http
      .post('/v1/ingest/document')
      .set(auth())
      .send({
        kind: 'markdown',
        text,
        occurredAt: '2026-09-01T10:00:00.000Z',
        contextRef: { vertical: 'proj_e2e' },
        ...(userId !== undefined ? { userId } : {}),
      });
    expect(r.status).toBe(201);
    return r.body.documentId as string;
  }

  const submission = (over: Record<string, unknown> = {}) => ({
    indexerId: PACK_ID,
    entities: [],
    facts: [],
    scenes: [
      {
        schemaId: 'viewing',
        label: 'Viewing at 12 Elm St',
        gist: 'Client toured 12 Elm St and weighed an offer.',
        occurredFrom: '2026-09-01T10:00:00.000Z',
        occurredTo: '2026-09-01T11:00:00.000Z',
        confidence: 0.8,
      },
    ],
    stateDeltas: [
      {
        sceneIndex: 0,
        stateModelId: 'deal',
        subject: 'the Elm St purchase',
        from: 'open',
        to: 'under_offer',
      },
    ],
    ...over,
  });

  const submit = (docId: string, body: Record<string, unknown>) =>
    f.http
      .post(`/v1/documents/${encodeURIComponent(docId)}/candidates`)
      .set(auth())
      .send(body);

  it('rejects scenes/stateDeltas while the flag is off (fail-closed fence)', async () => {
    const docId = await createDoc(`${DOC_TEXT} Flag-off variant.`);
    process.env.PACK_MEMORY_PROJECTIONS_ENABLED = '0';
    try {
      const r = await submit(docId, submission());
      expect(r.status).toBe(400);
      expect(r.body.message).toMatch(/PACK_MEMORY_PROJECTIONS_ENABLED/);
    } finally {
      process.env.PACK_MEMORY_PROJECTIONS_ENABLED = '1';
    }
    // Nothing was staged by the rejected submission.
    const list = await f.http
      .get(`/v1/documents/${encodeURIComponent(docId)}/candidates`)
      .set(auth());
    expect(list.status).toBe(200);
    expect(list.body.candidates).toHaveLength(0);
  });

  it('rejects an undeclared schemaId and an undeclared state (400, nothing staged)', async () => {
    const docId = await createDoc(`${DOC_TEXT} Fence variant.`);
    const badSchema = await submit(
      docId,
      submission({ scenes: [{ schemaId: 'intake', label: 'x', gist: 'y' }], stateDeltas: [] }),
    );
    expect(badSchema.status).toBe(400);
    expect(badSchema.body.message).toMatch(/not a declared sceneSchema/);

    const badState = await submit(
      docId,
      submission({
        stateDeltas: [{ sceneIndex: 0, stateModelId: 'deal', subject: 's', to: 'demolished' }],
      }),
    );
    expect(badState.status).toBe(400);
    expect(badState.body.message).toMatch(/not a declared state/);
  });

  it('stages, commits and projects scenes into the pack-versioned shadow world', async () => {
    const docId = await createDoc(DOC_TEXT);
    const r = await submit(docId, submission());
    expect(r.status).toBe(201);
    expect(r.body.staged).toEqual({
      entities: 0,
      facts: 0,
      relations: 0,
      scenes: 1,
      stateDeltas: 1,
    });
    expect(r.body.commit).toMatchObject({ deferred: false, committed: true });

    const version = packSceneVersion(PACK_ID, PACK_VERSION);
    const rows = await surreal().withCompany(f.companyId, async (db) => {
      const [eps] = await db.query<[Array<Record<string, unknown>>]>(
        `SELECT sceneLabel, gist, segmenterVersion, generation, confidence,
                stateDeltas, source, conversationIds, userId
           FROM memory_episode WHERE segmenterVersion = $v`,
        { v: version },
      );
      return (eps as Array<Record<string, unknown>>) ?? [];
    });
    expect(rows).toHaveLength(1);
    const scene = rows[0]!;
    expect(scene.sceneLabel).toBe('Viewing at 12 Elm St');
    expect(scene.gist).toBe('Client toured 12 Elm St and weighed an offer.');
    expect(scene.conversationIds).toEqual([]);
    expect(scene.userId).toBeUndefined();
    expect(scene.confidence).toBeCloseTo(0.8);
    expect(typeof scene.generation).toBe('string');
    const source = scene.source as Record<string, unknown>;
    expect(source.recorder).toBe('pack-scene-projector-v1');
    expect(source.packId).toBe(PACK_ID);
    expect(source.schemaId).toBe('viewing');
    expect(String(source.docId)).toContain('source_document:');
    const deltas = scene.stateDeltas as Array<Record<string, unknown>>;
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({
      stateModelId: 'deal',
      subject: 'the Elm St purchase',
      from: 'open',
      to: 'under_offer',
    });

    // Candidate statuses: both episodic rows committed, commitRef → the
    // projected episode id.
    const list = await f.http
      .get(`/v1/documents/${encodeURIComponent(docId)}/candidates`)
      .set(auth());
    expect(list.status).toBe(200);
    const byKind = (k: string) =>
      list.body.candidates.filter((c: { kind: string }) => c.kind === k);
    expect(byKind('scene')).toHaveLength(1);
    expect(byKind('state_delta')).toHaveLength(1);
    expect(byKind('scene')[0].status).toBe('committed');
    expect(byKind('scene')[0].commitRef).toMatch(/^memory_episode:/);
    expect(byKind('state_delta')[0].status).toBe('committed');
    expect(byKind('state_delta')[0].commitRef).toBe(byKind('scene')[0].commitRef);

    // The world registered in the projection ledger under scenes:<packId>.
    const ledger = await surreal().withCompany(f.companyId, async (db) => {
      const [ps] = await db.query<[Array<Record<string, unknown>>]>(
        `SELECT name, version, status, builder FROM projection WHERE name = $n`,
        { n: `scenes:${PACK_ID}` },
      );
      return (ps as Array<Record<string, unknown>>) ?? [];
    });
    expect(ledger).toEqual([
      {
        name: `scenes:${PACK_ID}`,
        version,
        status: 'built',
        builder: 'pack-scene-projector-v1',
      },
    ]);
  });

  it('default-denies scene content in the audit view under plain brain:read', async () => {
    const docId = await createDoc(`${DOC_TEXT} Redaction variant.`);
    const r = await submit(docId, submission());
    expect(r.status).toBe(201);

    const plain = await f.http
      .get(`/v1/documents/${encodeURIComponent(docId)}/candidates`)
      .set(readOnlyAuth());
    expect(plain.status).toBe(200);
    const sceneRow = plain.body.candidates.find((c: { kind: string }) => c.kind === 'scene');
    expect(sceneRow.payload.redacted).toBe(true);
    expect(sceneRow.payload.label).toBeUndefined();
    expect(sceneRow.payload.gist).toBeUndefined();
    expect(sceneRow.payload.schemaId).toBe('viewing');

    const pii = await f.http
      .get(`/v1/documents/${encodeURIComponent(docId)}/candidates`)
      .set(auth());
    const piiScene = pii.body.candidates.find((c: { kind: string }) => c.kind === 'scene');
    expect(piiScene.payload.gist).toBe('Client toured 12 Elm St and weighed an offer.');
    expect(piiScene.payload.redacted).toBeUndefined();
  });

  // ORDER MATTERS: this block asserts an EXACT belief set, and BOTH pack
  // projection origins now stamp the promotable `field` — so it runs
  // before the capture-path test below, whose user-scoped turn scene would
  // otherwise promote into a third belief. Keep it above that test.
  describe('pack deltas reach belief promotion (SCENES_PACK_DELTA_PROMOTION)', () => {
    const USER_A = 'pack_belief_u1';
    const USER_B = 'pack_belief_u2';
    const BELIEF_FLAGS = ['SCENES_SEGMENTATION_ENABLED', 'SCENES_BELIEF_PROMOTION'];
    const savedFlags: Record<string, string | undefined> = {};

    interface BeliefRow {
      userId: string;
      subject: string;
      field: string;
      value: string;
      priorValue?: string;
      statement: string;
      statementSource: string;
      revision: number;
      status: string;
      conversationIds?: string[];
      promoterVersion?: string;
      sourceSceneIds?: unknown[];
    }

    const beliefs = (): Promise<BeliefRow[]> =>
      surreal().withCompany(f.companyId, async (db) => {
        const [rows] = await db.query<[BeliefRow[]]>(
          `SELECT * FROM semantic_belief ORDER BY userId ASC, field ASC, revision ASC`,
        );
        return rows ?? [];
      });

    const promote = () => f.http.post('/v1/admin/maintenance/scenes/beliefs').set(auth()).send({});

    beforeAll(async () => {
      for (const k of BELIEF_FLAGS) {
        savedFlags[k] = process.env[k];
        process.env[k] = '1';
      }
      delete process.env.SCENES_PACK_DELTA_PROMOTION;

      // Two USER-SCOPED documents (0128) — each projects scenes stamped
      // with its own user (userId + 0093 scope + 0117 userIds), which is
      // what makes them promotable at all under the #387 fence.
      const docA = await createDoc(`${DOC_TEXT} Belief loop, user A.`, USER_A);
      expect((await submit(docA, submission())).status).toBe(201);

      const docB = await createDoc(`${DOC_TEXT} Belief loop, user B.`, USER_B);
      expect(
        (
          await submit(
            docB,
            submission({
              stateDeltas: [
                {
                  sceneIndex: 0,
                  stateModelId: 'deal',
                  subject: 'the Elm St purchase',
                  from: 'open',
                  to: 'closed',
                },
              ],
            }),
          )
        ).status,
      ).toBe(201);
    });

    afterAll(() => {
      for (const k of BELIEF_FLAGS) {
        if (savedFlags[k] === undefined) delete process.env[k];
        else process.env[k] = savedFlags[k];
      }
      delete process.env.SCENES_PACK_DELTA_PROMOTION;
    });

    it('projects the pack-namespaced field alongside the stateModelId', async () => {
      const deltas = await surreal().withCompany(f.companyId, async (db) => {
        const [rows] = await db.query<[Array<{ stateDeltas: Array<Record<string, unknown>> }>]>(
          `SELECT stateDeltas FROM memory_episode
            WHERE segmenterVersion = $v AND userId = $u`,
          { v: packSceneVersion(PACK_ID, PACK_VERSION), u: USER_A },
        );
        return (rows ?? []).flatMap((r) => r.stateDeltas ?? []);
      });
      expect(deltas).toHaveLength(1);
      expect(deltas[0]).toMatchObject({
        // BOTH: stateModelId is the pack provenance, field is the key the
        // belief fold reads (and drops the delta without).
        stateModelId: 'deal',
        field: `${PACK_ID}__deal`,
        subject: 'the Elm St purchase',
        to: 'under_offer',
      });
    });

    it('flag off ⇒ the promotion pass never sees a pack scene (byte-identical)', async () => {
      delete process.env.SCENES_PACK_DELTA_PROMOTION;
      const r = await promote();
      expect(r.status).toBe(201);
      // No composer world exists in this tenant, so the historical
      // selection matches nothing at all.
      expect(r.body.scenes).toBe(0);
      expect(r.body.beliefsCreated).toBe(0);
      expect(await beliefs()).toEqual([]);
    });

    it('flag on ⇒ each user-scoped pack scene promotes into that user’s own belief', async () => {
      process.env.SCENES_PACK_DELTA_PROMOTION = '1';
      const r = await promote();
      expect(r.status).toBe(201);
      expect(r.body.beliefsCreated).toBe(2);
      // The tenant-global documents projected by the earlier tests are
      // seen and REFUSED fail-closed — a scene with no userIds belongs to
      // no one, so it can never feed a belief.
      expect(r.body.skippedMixedUser).toBeGreaterThanOrEqual(1);

      const rows = await beliefs();
      expect(rows.map((b) => [b.userId, b.field, b.value])).toEqual([
        [USER_A, `${PACK_ID}__deal`, 'under_offer'],
        [USER_B, `${PACK_ID}__deal`, 'closed'],
      ]);
      const a = rows[0]!;
      expect(a.subject).toBe('the Elm St purchase');
      expect(a.priorValue).toBe('open');
      expect(a.revision).toBe(1);
      expect(a.status).toBe('active');
      // No paid call: the statement is the deterministic template.
      expect(a.statementSource).toBe('template');
      expect(a.statement).toBe(`the Elm St purchase — ${PACK_ID}__deal: under_offer (was: open)`);
      // Pack provenance on the belief row itself — no new column.
      expect(a.promoterVersion).toBe(
        `${BELIEF_PROMOTER_VERSION}|${packSceneVersion(PACK_ID, PACK_VERSION)}`,
      );
      expect(a.sourceSceneIds).toHaveLength(1);
      // Document scenes carry no conversation — the distinct-conversation
      // floor would exclude them, which is why it stays at 0 here.
      expect(a.conversationIds).toEqual([]);
    });

    it('is replay-idempotent (a second pass corroborates, never duplicates)', async () => {
      process.env.SCENES_PACK_DELTA_PROMOTION = '1';
      const r = await promote();
      expect(r.status).toBe(201);
      expect(r.body.beliefsCreated).toBe(0);
      expect(r.body.beliefsRevised).toBe(0);
      expect(await beliefs()).toHaveLength(2);
    });
  });

  it('projects a CAPTURE-path turn into the same pack world, bound to its L0 episode', async () => {
    const version = packSceneVersion(PACK_ID, PACK_VERSION);
    // The subject of a derived state delta = the turn's first extracted
    // entity (advisory); the scene itself is derived from literal cues.
    f.extractor.setScript({
      entities: [{ name: '12 Elm St', type: 'asset' }],
      facts: [],
      edges: [],
    });
    const mention = () =>
      f.http
        .post('/v1/ingest/mention')
        .set(auth())
        .send({
          text: 'The viewing at 12 Elm St went well — the deal is under offer now.',
          contextRef: { vertical: 'proj_e2e', conversationId: 'conv:cap', messageId: 'turn-1' },
          userId: 'u_capture',
          emittedAt: '2026-09-02T09:00:00.000Z',
        });
    expect((await mention()).status).toBe(201);

    const readTurnScenes = () =>
      surreal().withCompany(f.companyId, async (db) => {
        const [eps] = await db.query<[Array<Record<string, unknown>>]>(
          `SELECT id, sceneLabel, gist, segmenterVersion, confidence, stateDeltas,
                  source, conversationIds, userId, scope, userIds
             FROM memory_episode
            WHERE segmenterVersion = $v AND source.episodeId != NONE`,
          { v: version },
        );
        return (eps as Array<Record<string, unknown>>) ?? [];
      });

    const rows = await readTurnScenes();
    expect(rows).toHaveLength(1);
    const scene = rows[0]!;
    // Label + gist: pack vocabulary for the label, the REDACTED turn for
    // the gist — the same shape the document origin writes.
    expect(scene.sceneLabel).toBe('viewing · viewing');
    expect(scene.gist).toBe('The viewing at 12 Elm St went well — the deal is under offer now.');
    expect(scene.conversationIds).toEqual(['conv:cap']);
    // 0055/0093/0117 per-user stamping rides the turn's pinned user.
    expect(scene.userId).toBe('u_capture');
    expect(scene.scope).toEqual(['user:u_capture']);
    expect(scene.userIds).toEqual(['u_capture']);
    const source = scene.source as Record<string, unknown>;
    expect(source.recorder).toBe('pack-scene-projector-v1');
    expect(source.packId).toBe(PACK_ID);
    expect(source.schemaId).toBe('viewing');
    expect(String(source.episodeId)).toContain('episode:');
    expect(source.docId).toBeUndefined();
    // Only 'under offer' is named in the turn, so the delta carries a
    // destination and no origin state (an absent `from` is not stored).
    // `field` is the SHARED belief key — a capture-origin delta is the
    // same entry the document origin writes, minus the candidateId.
    expect(scene.stateDeltas).toEqual([
      {
        stateModelId: 'deal',
        field: `${PACK_ID}__deal`,
        subject: '12 Elm St',
        to: 'under_offer',
        confidence: 0.5,
      },
    ]);

    // The membership edge the GDPR forget cascades ride (scene → L0 turn).
    const members = await surreal().withCompany(f.companyId, async (db) => {
      const [ms] = await db.query<[Array<Record<string, unknown>>]>(
        `SELECT in, out, role, segmenterVersion FROM memory_episode_member WHERE in = $scene`,
        { scene: scene.id },
      );
      return (ms as Array<Record<string, unknown>>) ?? [];
    });
    expect(members).toHaveLength(1);
    expect(String(members[0]!.out)).toBe(String(source.episodeId));
    expect(members[0]!.segmenterVersion).toBe(version);

    // Idempotent per (turn, pack, schema): re-ingesting the same turn
    // converges on the same row instead of appending a second one.
    expect((await mention()).status).toBe(201);
    const again = await readTurnScenes();
    expect(again).toHaveLength(1);
    expect(String(again[0]!.id)).toBe(String(scene.id));

    // The world is the SAME one the document origin registered.
    const ledger = await surreal().withCompany(f.companyId, async (db) => {
      const [ps] = await db.query<[Array<Record<string, unknown>>]>(
        `SELECT version, status FROM projection WHERE name = $n`,
        { n: `scenes:${PACK_ID}` },
      );
      return (ps as Array<Record<string, unknown>>) ?? [];
    });
    expect(ledger).toEqual([{ version, status: 'built' }]);
  });

  it('purges a pack world through the existing admin scenes version verb', async () => {
    const version = packSceneVersion(PACK_ID, PACK_VERSION);
    process.env.SCENES_SEGMENTATION_ENABLED = '1';
    try {
      const purge = await f.http
        .delete(`/v1/admin/maintenance/scenes/versions/${encodeURIComponent(version)}`)
        .set(auth())
        .send({});
      expect(purge.status).toBe(200);
      // Both projected worlds above (happy-path + redaction docs) share
      // the version — all their scenes go at once.
      expect(purge.body.scenes).toBeGreaterThanOrEqual(2);
    } finally {
      delete process.env.SCENES_SEGMENTATION_ENABLED;
    }
    const remaining = await surreal().withCompany(f.companyId, async (db) => {
      const [eps] = await db.query<[Array<unknown>]>(
        `SELECT id FROM memory_episode WHERE segmenterVersion = $v`,
        { v: version },
      );
      return ((eps as Array<unknown>) ?? []).length;
    });
    expect(remaining).toBe(0);
  });
});
