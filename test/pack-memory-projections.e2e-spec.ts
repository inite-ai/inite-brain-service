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
 * view, and the version purge through the existing admin scenes verb.
 */
import { AppFixture, createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { packSceneVersion } from '../src/documents/scene-candidate-writer.service';

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
      sceneSchemas: [{ id: 'viewing', description: 'A property viewing.' }],
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

  beforeAll(async () => {
    f = await createApp({
      companyId: 'co_pack_proj_e2e',
      scopes: ['brain:read', 'brain:write', 'brain:admin', 'brain:read_pii', 'indexer:write'],
      // A plain-read key in the SAME tenant for the default-deny check.
      extraKeys: [{ scopes: ['brain:read'] }],
    });
    process.env.DOCUMENT_INGEST_ENABLED = '1';
    process.env.PACK_MEMORY_PROJECTIONS_ENABLED = '1';
    const install = await f.http.post('/v1/admin/packs').set(auth()).send({ manifest: MANIFEST });
    expect([200, 201]).toContain(install.status);
  });

  afterAll(async () => {
    delete process.env.DOCUMENT_INGEST_ENABLED;
    delete process.env.PACK_MEMORY_PROJECTIONS_ENABLED;
    if (f) await f.close();
  });

  async function createDoc(text: string) {
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
