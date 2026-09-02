/**
 * Evidence ingest surface e2e (Brain v2.1 M3, PR-C):
 * POST /v1/ingest/evidence-asset.
 *
 *  - default-off pin: both flags off → bare 404; substrate-on/ingest-off
 *    → still 404 (the surface flag is THE gate, scenes precedent);
 *  - ingest-on/substrate-off → 503 from the write seam, no rows;
 *  - metadata-only boundary (MM-6): storageRef rejected by the
 *    forbidNonWhitelisted pipe, originUri + byteHash required;
 *  - locator matrix pre-validation is ATOMIC — one bad locator = 400
 *    and NO asset row written;
 *  - excerpts land as derived_representation kind 'text' with
 *    producerVersion 'ingest-excerpt-v1';
 *  - same-user re-registration dedupes + appends fragments; a different
 *    principal gets a bare 409 that leaks no stored metadata;
 *  - brain:write scope required (403 for read-only keys).
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';

const COMPANY = 'co_evidence_ingest_e2e';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_D = 'd'.repeat(64);

const baseBody = () => ({
  modality: 'document',
  mediaType: 'application/pdf',
  byteHash: HASH_A,
  byteLength: 12_345,
  occurredAt: '2026-03-01T10:00:00.000Z',
  originUri: 'https://files.example.com/contracts/q1.pdf',
  vertical: 'proj',
  userId: 'evidence_ingest_user',
});

describe('evidence ingest surface (e2e)', () => {
  let f: AppFixture;
  let readOnlyKey: string;
  const auth = (key?: string) => ({ Authorization: `Bearer ${key ?? f.apiKey}` });
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    saved.EVIDENCE_SUBSTRATE_ENABLED = process.env.EVIDENCE_SUBSTRATE_ENABLED;
    saved.EVIDENCE_INGEST_ENABLED = process.env.EVIDENCE_INGEST_ENABLED;
    delete process.env.EVIDENCE_SUBSTRATE_ENABLED;
    delete process.env.EVIDENCE_INGEST_ENABLED;
    f = await createApp({
      companyId: COMPANY,
      extraKeys: [{ scopes: ['brain:read'] }],
    });
    readOnlyKey = f.extraApiKeys[0]!;
  });

  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (f) await f.close();
  });

  const countRows = async (table: string): Promise<number> => {
    const surreal = f.app.get(SurrealService);
    return surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[Array<{ n: number }>]>(
        `SELECT count() AS n FROM ${table} GROUP ALL`,
      );
      return (rows as Array<{ n: number }>)?.[0]?.n ?? 0;
    });
  };

  const post = (body: Record<string, unknown>, key?: string) =>
    f.http.post('/v1/ingest/evidence-asset').set(auth(key)).send(body);

  it('answers a bare 404 while EVIDENCE_INGEST_ENABLED is off — even with the substrate on', async () => {
    await post(baseBody()).expect(404);
    process.env.EVIDENCE_SUBSTRATE_ENABLED = '1';
    await post(baseBody()).expect(404);
    delete process.env.EVIDENCE_SUBSTRATE_ENABLED;
    expect(await countRows('evidence_asset')).toBe(0);
  });

  it('answers 503 from the write seam when ingest is on but the substrate is off', async () => {
    process.env.EVIDENCE_INGEST_ENABLED = '1';
    const res = await post(baseBody()).expect(503);
    expect(JSON.stringify(res.body)).toContain('EVIDENCE_SUBSTRATE_ENABLED');
    expect(await countRows('evidence_asset')).toBe(0);
  });

  it('registers a metadata-only asset with fragments; excerpts land as text representations', async () => {
    process.env.EVIDENCE_INGEST_ENABLED = '1';
    process.env.EVIDENCE_SUBSTRATE_ENABLED = '1';
    const res = await post({
      ...baseBody(),
      pageCount: 12,
      piiClasses: [],
      fragments: [
        {
          locator: { kind: 'charRange', start: 100, end: 180 },
          label: 'termination clause',
          excerpt: 'Either party may terminate with 30 days notice.',
          lang: 'en',
        },
        { locator: { kind: 'pageRegion', page: 3, x: 0.1, y: 0.2, w: 0.5, h: 0.3 } },
      ],
    }).expect(201);

    expect(res.body.assetId).toContain('evidence_asset:');
    expect(res.body.availability).toBe('external');
    expect(res.body.deduped).toBe(false);
    expect(res.body.fragments).toHaveLength(2);
    expect(res.body.fragments[0].fragmentId).toContain('evidence_fragment:');
    expect(res.body.fragments[0].representationId).toContain('derived_representation:');
    expect(res.body.fragments[1].representationId).toBeUndefined();

    expect(await countRows('evidence_asset')).toBe(1);
    expect(await countRows('evidence_fragment')).toBe(2);
    expect(await countRows('derived_representation')).toBe(1);

    const surreal = f.app.get(SurrealService);
    const repr = await surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[Array<Record<string, unknown>>]>(
        `SELECT kind, content, producerVersion, lang, subjectKind FROM derived_representation LIMIT 1`,
      );
      return (rows as Array<Record<string, unknown>>)[0];
    });
    expect(repr).toMatchObject({
      kind: 'text',
      content: 'Either party may terminate with 30 days notice.',
      producerVersion: 'ingest-excerpt-v1',
      lang: 'en',
      subjectKind: 'fragment',
    });
  });

  it('rejects storageRef — the metadata-only MM-6 boundary', async () => {
    const res = await post({
      ...baseBody(),
      byteHash: HASH_B,
      storageRef: 'fs://co_evidence_ingest_e2e/bb/' + HASH_B,
    }).expect(400);
    expect(JSON.stringify(res.body.message)).toContain('storageRef should not exist');
    expect(await countRows('evidence_asset')).toBe(1);
  });

  it('requires originUri and byteHash', async () => {
    const { originUri, ...noOrigin } = { ...baseBody(), byteHash: HASH_B };
    void originUri;
    await post(noOrigin).expect(400);
    const { byteHash, ...noHash } = baseBody();
    void byteHash;
    await post(noHash).expect(400);
    expect(await countRows('evidence_asset')).toBe(1);
  });

  it('one bad locator fails the whole request atomically — no asset row written', async () => {
    const res = await post({
      ...baseBody(),
      byteHash: HASH_B,
      fragments: [
        { locator: { kind: 'charRange', start: 0, end: 10 } },
        { locator: { kind: 'frameRange', startFrame: 0, endFrame: 10 } }, // video-only kind
      ],
    }).expect(400);
    expect(JSON.stringify(res.body.message)).toContain('fragments[1].locator');
    expect(await countRows('evidence_asset')).toBe(1);
    expect(await countRows('evidence_fragment')).toBe(2);
  });

  it('rejects unknown modalities and unknown media PII classes (taxonomy-strict)', async () => {
    await post({ ...baseBody(), byteHash: HASH_B, modality: 'hologram' }).expect(400);
    await post({ ...baseBody(), byteHash: HASH_B, piiClasses: ['shoe_size'] }).expect(400);
    expect(await countRows('evidence_asset')).toBe(1);
  });

  it('same-user re-registration dedupes and appends the requested fragments', async () => {
    const res = await post({
      ...baseBody(),
      fragments: [{ locator: { kind: 'charRange', start: 200, end: 240 } }],
    }).expect(201);
    expect(res.body.deduped).toBe(true);
    expect(await countRows('evidence_asset')).toBe(1);
    expect(await countRows('evidence_fragment')).toBe(3);
  });

  it('a different principal hitting a known byteHash gets a bare 409 without stored metadata', async () => {
    const res = await post({ ...baseBody(), userId: 'someone_else' }).expect(409);
    const wire = JSON.stringify(res.body);
    expect(wire).not.toContain('files.example.com');
    expect(wire).not.toContain('evidence_ingest_user');
  });

  it('requires brain:write (403 for a read-only key)', async () => {
    await post({ ...baseBody(), byteHash: HASH_C }, readOnlyKey).expect(403);
  });

  it('flag flip back off returns the surface to a bare 404 (runtime-mutable)', async () => {
    delete process.env.EVIDENCE_INGEST_ENABLED;
    await post({ ...baseBody(), byteHash: HASH_D }).expect(404);
    delete process.env.EVIDENCE_SUBSTRATE_ENABLED;
  });
});
