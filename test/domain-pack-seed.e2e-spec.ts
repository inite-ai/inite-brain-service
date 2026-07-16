/**
 * Pack seed documents — end-to-end on a real DB.
 *
 * Proves a pack shipping seedDocuments gets them ingested through the NORMAL
 * document pipeline on install: the install response reports the enqueue, the
 * pack_seed_ingest handler (driven directly here for determinism) creates
 * source_document rows with kind='pack_seed' + provenance meta, a re-run
 * dedups on contentHash, and with DOCUMENT_INGEST_ENABLED off the install
 * still succeeds while the seeds are skipped loudly.
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { PackSeedIngestService } from '../src/documents/pack-seed-ingest.service';
import { SurrealService } from '../src/db/surreal.service';

const GARDENING_MANIFEST = {
  id: 'gardening',
  version: '1.0.0',
  description: 'Gardening domain ontology (test pack).',
  predicates: [
    {
      localId: 'grows_in',
      displayLabel: 'grows in',
      description: 'TYPE subject is a plant; value is a growing condition',
      datatype: 'string',
      semantics: 'append_only',
      decayHalfLifeDays: null,
      piiClass: 'none',
      status: 'active',
    },
  ],
  seedDocuments: [
    {
      localId: 'primer',
      title: 'Gardening primer',
      text: 'Tomatoes grow best in full sun with regular watering.',
      vertical: 'garden',
      meta: { audience: 'agents' },
    },
    {
      localId: 'glossary',
      title: 'Gardening glossary',
      text: 'Perennial: a plant that lives more than two years.',
      vertical: 'garden',
      occurredAt: '2026-01-01T00:00:00Z',
    },
  ],
};

describe('/v1/admin/packs — seed documents through the pipeline (e2e)', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  beforeAll(async () => {
    // The direct runForPack calls below are the deterministic driver — park
    // the worker loop so the enqueued job can't race them.
    process.env.WORKER_LOOP_ENABLED = '0';
    process.env.DOCUMENT_INGEST_ENABLED = '1';
    f = await createApp({ companyId: 'co_pack_seed_e2e' });
  });
  afterAll(async () => {
    delete process.env.DOCUMENT_INGEST_ENABLED;
    delete process.env.WORKER_LOOP_ENABLED;
    if (f) await f.close();
  });

  const seedRows = async (packId: string) => {
    const surreal = f.app.get(SurrealService);
    return surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[any[]]>(
        `SELECT kind, title, meta, vertical FROM source_document WHERE kind = 'pack_seed' AND meta.pack_id = $packId`,
        { packId },
      );
      return (rows as any[]) ?? [];
    });
  };

  it('install reports the seed ingest as enqueued', async () => {
    const r = await f.http
      .post('/v1/admin/packs')
      .set(auth())
      .send({ manifest: GARDENING_MANIFEST });
    expect([200, 201]).toContain(r.status);
    expect(r.body.packId).toBe('gardening');
    expect(r.body.seedDocuments).toEqual({ count: 2, status: 'enqueued' });
  });

  it('runForPack ingests the seeds as pack_seed documents with provenance meta', async () => {
    const svc = f.app.get(PackSeedIngestService);
    const result = await svc.runForPack(f.companyId, {
      packId: 'gardening',
      packVersion: '1.0.0',
    });
    expect(result).toEqual({
      total: 2,
      ingested: 2,
      deduplicated: 0,
      failed: 0,
    });

    const rows = await seedRows('gardening');
    expect(rows).toHaveLength(2);
    const byDoc = new Map(rows.map((r: any) => [r.meta.pack_seed_doc, r]));
    const primer = byDoc.get('primer');
    expect(primer.title).toBe('Gardening primer');
    expect(primer.vertical).toBe('garden');
    expect(primer.meta.pack_seed).toBe(true);
    expect(primer.meta.pack_id).toBe('gardening');
    expect(primer.meta.pack_version).toBe('1.0.0');
    expect(primer.meta.audience).toBe('agents');
    expect(byDoc.get('glossary')).toBeDefined();
  });

  it('re-running the seed ingest dedups every document (idempotent)', async () => {
    const svc = f.app.get(PackSeedIngestService);
    const again = await svc.runForPack(f.companyId, {
      packId: 'gardening',
      packVersion: '1.0.0',
    });
    expect(again).toEqual({
      total: 2,
      ingested: 0,
      deduplicated: 2,
      failed: 0,
    });
    expect(await seedRows('gardening')).toHaveLength(2);
  });

  it('with DOCUMENT_INGEST_ENABLED off the install succeeds and skips the seeds', async () => {
    process.env.DOCUMENT_INGEST_ENABLED = '0';
    try {
      const r = await f.http
        .post('/v1/admin/packs')
        .set(auth())
        .send({
          manifest: {
            ...GARDENING_MANIFEST,
            id: 'beekeeping',
            description: 'Beekeeping domain ontology (test pack).',
            seedDocuments: [
              {
                localId: 'hive_basics',
                title: 'Hive basics',
                text: 'A healthy hive has one queen.',
                vertical: 'apiary',
              },
            ],
          },
        });
      expect([200, 201]).toContain(r.status);
      expect(r.body.seedDocuments).toEqual({
        count: 1,
        status: 'skipped_ingest_disabled',
      });
      expect(await seedRows('beekeeping')).toHaveLength(0);
    } finally {
      process.env.DOCUMENT_INGEST_ENABLED = '1';
    }
  });
});
