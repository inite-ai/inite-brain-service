/**
 * Evidence blob upload e2e (Brain v2.1 MM-7) — the first surface that
 * takes BYTES into custody, end to end over HTTP:
 *
 *  - default-off pin: bare 404 while EVIDENCE_BLOB_UPLOAD_ENABLED is off,
 *    even with the substrate, quarantine and the sibling metadata route
 *    all on — and the 404 is raised BEFORE the multipart body is parsed;
 *  - fail-closed pin: upload-on with EVIDENCE_QUARANTINE off answers 503
 *    (bytes over HTTP are external ingest; no external bytes without the
 *    scan seam) and writes nothing;
 *  - the happy path: a tiny in-test buffer lands as a `hot` asset with a
 *    real fs:// storageRef, a server-computed sha256 identity, the
 *    per-user 0055/0093 stamps, and quarantineStatus 'clean' — i.e. it
 *    was actually scanned, not merely admitted;
 *  - the allowlist and the size cap over the wire (400 / 413);
 *  - a rejecting scan hook: 422, a content-free message, the row a
 *    tombstone and the bytes gone — including on a re-upload of
 *    already-rejected content;
 *  - dispatch: fire-and-forget from the upload path produces a real
 *    processing_run + derived text, and the admin maintenance sweep
 *    reaches an asset no upload dispatch covered (404 while dark);
 *  - the raw bytes really are retrievable through the storage adapter.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { EvidenceQuarantineService } from '../src/evidence/quarantine.service';
import type { EvidenceScanHook } from '../src/evidence/processing/scan-hook';
import { FsEvidenceStorageAdapter } from '../src/evidence/storage/fs-storage.adapter';

const COMPANY = 'co_evidence_blob_upload_e2e';
const USER = 'blob_upload_user';
const PACK = 'blob_upload_pack';

const NOTE = 'the quick brown fox jumps over the lazy dog';
const NOTE_BYTES = Buffer.from(NOTE, 'utf8');
const NOTE_HASH = createHash('sha256').update(NOTE_BYTES).digest('hex');

const PREDICATE = {
  localId: 'blob_note',
  displayLabel: 'blob note',
  description: 'TYPE subject is a person; value is a note about an uploaded blob',
  datatype: 'string',
  semantics: 'append_only',
  decayHalfLifeDays: null,
  piiClass: 'none',
  status: 'active',
};

const packManifest = {
  id: PACK,
  version: '1.0.0',
  description: 'Blob upload e2e pack.',
  predicates: [PREDICATE],
  memoryModel: {
    modalities: ['document'],
    processors: [{ id: 'doc_text', modality: 'document', produces: ['text'] }],
  },
};

describe('evidence blob upload surface (e2e)', () => {
  let f: AppFixture;
  let readOnlyKey: string;
  let fsRoot: string;
  const auth = (key?: string) => ({ Authorization: `Bearer ${key ?? f.apiKey}` });
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    fsRoot = await mkdtemp(join(tmpdir(), 'evidence-blob-upload-e2e-'));
    for (const k of [
      'EVIDENCE_SUBSTRATE_ENABLED',
      'EVIDENCE_BLOB_UPLOAD_ENABLED',
      'EVIDENCE_QUARANTINE',
      'EVIDENCE_PROCESSOR_BROKER',
      'EVIDENCE_MAX_BYTES',
      'EVIDENCE_FS_ROOT',
    ]) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.EVIDENCE_FS_ROOT = fsRoot;
    process.env.EVIDENCE_SUBSTRATE_ENABLED = '1';
    f = await createApp({
      companyId: COMPANY,
      scopes: ['brain:read', 'brain:write', 'brain:admin'],
      extraKeys: [{ scopes: ['brain:read'] }],
    });
    readOnlyKey = f.extraApiKeys[0]!;
  }, 120_000);

  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(fsRoot, { recursive: true, force: true });
    if (f) await f.close();
  });

  const countRows = async (table: string): Promise<number> => {
    const surreal = f.app.get(SurrealService);
    return surreal.withCompany(COMPANY, async (db) => {
      const [rows] = await db.query<[Array<{ n: number }>]>(
        `SELECT count() AS n FROM ${table} GROUP ALL`,
      );
      return (rows as Array<{ n: number }>)?.[0]?.n ?? 0;
    });
  };

  const rawRow = async (recordId: string): Promise<Record<string, unknown>> => {
    const surreal = f.app.get(SurrealService);
    const table = recordId.slice(0, recordId.indexOf(':'));
    const tail = recordId.slice(recordId.indexOf(':') + 1);
    return surreal.withCompany(COMPANY, async (db) => {
      const [rows] = await db.query<[Array<Record<string, unknown>>]>(
        `SELECT * FROM type::record($t, $tail)`,
        { t: table, tail },
      );
      return (rows as Array<Record<string, unknown>>)[0]!;
    });
  };

  /** Wait for a fire-and-forget effect without asserting on a race. */
  const eventually = async (probe: () => Promise<boolean>): Promise<boolean> => {
    for (let i = 0; i < 100; i++) {
      if (await probe()) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  };

  interface UploadOpts {
    bytes?: Buffer;
    filename?: string;
    contentType?: string;
    fields?: Record<string, string>;
    key?: string;
  }

  const upload = (opts: UploadOpts = {}) => {
    let req = f.http.post('/v1/ingest/evidence-blob').set(auth(opts.key));
    const fields = {
      modality: 'document',
      occurredAt: '2026-05-01T10:00:00.000Z',
      vertical: 'proj',
      userId: USER,
      ...opts.fields,
    };
    for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
    return req.attach('file', opts.bytes ?? NOTE_BYTES, {
      filename: opts.filename ?? 'note.txt',
      contentType: opts.contentType ?? 'text/plain',
    });
  };

  let assetId = '';
  let sweepAssetId = '';

  it('answers a bare 404 while EVIDENCE_BLOB_UPLOAD_ENABLED is off', async () => {
    process.env.EVIDENCE_QUARANTINE = '1';
    const res = await upload().expect(404);
    // Bare: the off-state answer must not describe the route it hides.
    expect(JSON.stringify(res.body)).not.toContain('evidence-blob');
    expect(await countRows('evidence_asset')).toBe(0);
    delete process.env.EVIDENCE_QUARANTINE;
  });

  it('fails closed with 503 when the quarantine seam is off — bytes are external ingest', async () => {
    process.env.EVIDENCE_BLOB_UPLOAD_ENABLED = '1';
    const res = await upload().expect(503);
    expect(JSON.stringify(res.body)).toContain('EVIDENCE_QUARANTINE');
    expect(await countRows('evidence_asset')).toBe(0);
  });

  it('requires brain:write (403 for a read-only key)', async () => {
    process.env.EVIDENCE_QUARANTINE = '1';
    await upload({ key: readOnlyKey }).expect(403);
    expect(await countRows('evidence_asset')).toBe(0);
  });

  it('stores the bytes, registers a hot asset, and scans it before serving', async () => {
    const res = await upload({
      fields: { scope: 'team:alpha,team:beta', piiClasses: '', pageCount: '1' },
    }).expect(201);

    expect(res.body).toMatchObject({
      availability: 'hot',
      deduped: false,
      byteHash: NOTE_HASH,
      byteLength: NOTE_BYTES.byteLength,
      mediaType: 'text/plain',
      // Actually scanned — not merely admitted.
      quarantineStatus: 'clean',
      // No packId was sent, so nothing was dispatched.
      dispatched: false,
    });
    expect(res.body.storageRef).toBe(`fs://${COMPANY}/${NOTE_HASH}`);
    assetId = String(res.body.assetId);

    const row = await rawRow(assetId);
    expect(row).toMatchObject({
      availability: 'hot',
      quarantineStatus: 'clean',
      mediaType: 'text/plain',
      modality: 'document',
      userId: USER,
      byteHash: NOTE_HASH,
      pageCount: 1,
    });
    // 0055 userId + 0093 scope tags stamped exactly as registerAsset does
    // for every other writer; piiClasses [] is the affirmative-clean
    // polarity, distinct from the field being absent.
    expect(row.scope).toEqual(['team:alpha', 'team:beta']);
    expect(row.piiClasses).toEqual([]);

    // The bytes are genuinely on disk under the ref the row carries.
    const adapter = f.app.get(FsEvidenceStorageAdapter);
    expect(await adapter.head(String(row.storageRef))).toEqual({
      byteLength: NOTE_BYTES.byteLength,
    });
    const stream = await adapter.get(String(row.storageRef));
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
    expect(Buffer.concat(chunks).toString('utf8')).toBe(NOTE);
  });

  it('dedupes a same-user re-upload of identical bytes', async () => {
    const res = await upload().expect(201);
    expect(res.body).toMatchObject({ assetId, deduped: true, availability: 'hot' });
    expect(await countRows('evidence_asset')).toBe(1);
  });

  it('refuses media types outside the allowlist and mismatched modality pairs', async () => {
    // Deliberate exclusion: an SVG is an active document.
    await upload({
      contentType: 'image/svg+xml',
      filename: 'x.svg',
      fields: { modality: 'image' },
    }).expect(400);
    // Allowlisted overall, wrong modality for these bytes.
    await upload({ contentType: 'application/pdf', fields: { modality: 'image' } }).expect(400);
    // Opaque bytes cannot be modality-checked.
    await upload({ contentType: 'application/octet-stream' }).expect(400);
    expect(await countRows('evidence_asset')).toBe(1);
  });

  it('enforces the runtime-mutable size cap (413) and rejects an unknown field (400)', async () => {
    process.env.EVIDENCE_MAX_BYTES = '8';
    await upload({ bytes: Buffer.from('this is definitely more than eight bytes') }).expect(413);
    delete process.env.EVIDENCE_MAX_BYTES;
    // forbidNonWhitelisted still governs the metadata half.
    await upload({ fields: { storageRef: `fs://${COMPANY}/${NOTE_HASH}` } }).expect(400);
    expect(await countRows('evidence_asset')).toBe(1);
  });

  it('dispatches fire-and-forget from the upload path: a real processing run lands', async () => {
    const install = await f.http
      .post('/v1/admin/packs')
      .set(auth())
      .send({ manifest: packManifest, acceptModalities: true });
    expect([200, 201]).toContain(install.status);
    process.env.EVIDENCE_PROCESSOR_BROKER = '1';

    const second = 'a second observation, uploaded and processed';
    const res = await upload({
      bytes: Buffer.from(second, 'utf8'),
      fields: { packId: PACK },
    }).expect(201);
    // The response never waits on the broker — it only reports that a
    // dispatch was STARTED.
    expect(res.body).toMatchObject({ quarantineStatus: 'clean', dispatched: true });

    expect(await eventually(async () => (await countRows('processing_run')) >= 1)).toBe(true);
    const surreal = f.app.get(SurrealService);
    const repr = await surreal.withCompany(COMPANY, async (db) => {
      const [rows] = await db.query<[Array<Record<string, unknown>>]>(
        `SELECT kind, content, producerVersion FROM derived_representation LIMIT 1`,
      );
      return (rows as Array<Record<string, unknown>>)[0];
    });
    expect(repr).toMatchObject({
      kind: 'text',
      content: second,
      producerVersion: 'text-extraction-passthrough-v1',
    });
  });

  it('a failing dispatch target never fails the upload', async () => {
    const res = await upload({
      bytes: Buffer.from('uploaded against a pack that is not installed', 'utf8'),
      fields: { packId: 'no_such_pack_installed' },
    }).expect(201);
    expect(res.body).toMatchObject({ availability: 'hot', quarantineStatus: 'clean' });
    sweepAssetId = String(res.body.assetId);
  });

  it('a rejecting scan hook answers 422, tombstones the row and deletes the bytes', async () => {
    const quarantine = f.app.get(EvidenceQuarantineService) as unknown as {
      hook: EvidenceScanHook;
    };
    const original = quarantine.hook;
    const rejected = 'bytes a real scanner would refuse';
    const rejectedHash = createHash('sha256').update(Buffer.from(rejected, 'utf8')).digest('hex');
    try {
      quarantine.hook = { name: 'reject-all-test', scan: () => Promise.resolve('rejected') };
      const res = await upload({ bytes: Buffer.from(rejected, 'utf8') }).expect(422);
      // Content-free: a scan verdict must not describe what it matched.
      expect(JSON.stringify(res.body)).not.toContain(rejected);

      const adapter = f.app.get(FsEvidenceStorageAdapter);
      expect(await adapter.exists(`fs://${COMPANY}/${rejectedHash}`)).toBe(false);
      const surreal = f.app.get(SurrealService);
      const tomb = await surreal.withCompany(COMPANY, async (db) => {
        const [rows] = await db.query<[Array<Record<string, unknown>>]>(
          `SELECT availability, quarantineStatus, storageRef FROM evidence_asset
            WHERE byteHash = $h LIMIT 1`,
          { h: rejectedHash },
        );
        return (rows as Array<Record<string, unknown>>)[0]!;
      });
      expect(tomb).toMatchObject({ availability: 'gone', quarantineStatus: 'rejected' });
      expect(tomb.storageRef ?? null).toBeNull();

      // Re-uploading known-rejected bytes stays rejected AND does not
      // leave the re-materialised blob behind.
      await upload({ bytes: Buffer.from(rejected, 'utf8') }).expect(422);
      expect(await adapter.exists(`fs://${COMPANY}/${rejectedHash}`)).toBe(false);
    } finally {
      quarantine.hook = original;
    }
  });

  it('the admin sweep reaches an asset no upload dispatch covered', async () => {
    const sweep = await f.http
      .post('/v1/admin/maintenance/evidence/dispatch')
      .set(auth())
      .send({ packId: PACK, assetId: sweepAssetId })
      .expect(201);
    expect(sweep.body).toMatchObject({ assets: 1, dispatched: 1, runs: 1, failed: 0 });

    // Untargeted, it sweeps every live asset — including the one
    // registered before the broker was even on. Running it TWICE is the
    // replay-idempotence pin: the second pass touches the same assets and
    // produces the same runs, writing no new row.
    const wide = await f.http
      .post('/v1/admin/maintenance/evidence/dispatch')
      .set(auth())
      .send({ packId: PACK })
      .expect(201);
    expect(wide.body.assets).toBeGreaterThan(1);
    expect(wide.body.dispatched).toBe(wide.body.assets);
    const runsAfterWide = await countRows('processing_run');
    const again = await f.http
      .post('/v1/admin/maintenance/evidence/dispatch')
      .set(auth())
      .send({ packId: PACK })
      .expect(201);
    expect(again.body).toMatchObject({ assets: wide.body.assets, runs: wide.body.runs, failed: 0 });
    expect(await countRows('processing_run')).toBe(runsAfterWide);
  });

  it('the admin sweep validates its params and 404s while the broker is dark', async () => {
    await f.http.post('/v1/admin/maintenance/evidence/dispatch').set(auth()).send({}).expect(400);
    await f.http
      .post('/v1/admin/maintenance/evidence/dispatch')
      .set(auth())
      .send({ packId: PACK, assetId: 'not_a_record_id' })
      .expect(400);
    delete process.env.EVIDENCE_PROCESSOR_BROKER;
    await f.http
      .post('/v1/admin/maintenance/evidence/dispatch')
      .set(auth())
      .send({ packId: PACK })
      .expect(404);
  });

  it('flag flip back off returns the surface to a bare 404 (runtime-mutable)', async () => {
    delete process.env.EVIDENCE_BLOB_UPLOAD_ENABLED;
    await upload({ bytes: Buffer.from('after the flip', 'utf8') }).expect(404);
    delete process.env.EVIDENCE_QUARANTINE;
  });
});
