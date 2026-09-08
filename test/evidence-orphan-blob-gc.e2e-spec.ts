/**
 * Orphan-blob GC e2e (EVIDENCE_ORPHAN_BLOB_GC) — the delete-side hygiene
 * sweep, end to end over the real storage adapter and real rows:
 *
 *  - default-off pin: a bare 404 from the maintenance route while the
 *    flag is off, with nothing enumerated;
 *  - a REFERENCED blob is never reported, however old it is;
 *  - the leak itself: upload bytes, lose the row, and the blob becomes an
 *    orphan — reported by a dry run (which deletes nothing), then
 *    reclaimed by a real run once the second-stage flag is on;
 *  - a second sweep is a no-op — idempotent by enumeration, no queue;
 *  - the SHARED-blob case, where deletion must NOT happen: two rows
 *    pointing at one blob, one row dies, the bytes stay;
 *  - the grace window protects a fresh orphan;
 *  - `brain:admin` is required.
 *
 * Blobs are aged by BACK-DATING their mtime, never by mocking the clock.
 * A mocked Date.now() reaches the SurrealDB driver too, which then reads
 * its root session as expired and drops to anonymous — the tenant query
 * fails, the sweep's own per-tenant isolation catches it, and every
 * counter comes back zero with an `error`. Age is a property of the
 * store, so the test moves the store.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { EvidenceStoreService } from '../src/evidence/evidence-store.service';
import { FsEvidenceStorageAdapter } from '../src/evidence/storage/fs-storage.adapter';

const COMPANY = 'co_evidence_orphan_gc_e2e';
const USER = 'orphan_gc_user';
const ROUTE = '/v1/admin/maintenance/evidence/orphan-blob-gc';
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
/** Comfortably past the 1-hour grace window the suite configures. */
const PAST_GRACE_MS = 3 * 3600_000;

interface SweepBody {
  scanned: number;
  referenced: number;
  young: number;
  orphans: number;
  deleted: number;
  raced: number;
  failed: number;
  dryRun: boolean;
  bytesReclaimable: number;
  bytesDeleted: number;
  sampleOrphans: string[];
  /** Present only when the tenant pass threw — asserted absent below. */
  error?: string;
}

describe('evidence orphan blob GC (e2e)', () => {
  let f: AppFixture;
  let store: EvidenceStoreService;
  let adapter: FsEvidenceStorageAdapter;
  let fsRoot: string;
  let readOnlyKey: string;
  const auth = (key?: string) => ({ Authorization: `Bearer ${key ?? f.apiKey}` });
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    fsRoot = await mkdtemp(join(tmpdir(), 'evidence-orphan-gc-e2e-'));
    for (const k of [
      'EVIDENCE_SUBSTRATE_ENABLED',
      'EVIDENCE_FS_ROOT',
      'EVIDENCE_ORPHAN_BLOB_GC',
      'EVIDENCE_ORPHAN_BLOB_GC_DELETE',
      'EVIDENCE_ORPHAN_BLOB_GC_SCHEDULED',
      'EVIDENCE_ORPHAN_BLOB_GC_GRACE_HOURS',
      'EVIDENCE_ORPHAN_BLOB_GC_MAX_DELETIONS',
    ]) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.EVIDENCE_FS_ROOT = fsRoot;
    process.env.EVIDENCE_SUBSTRATE_ENABLED = '1';
    process.env.EVIDENCE_ORPHAN_BLOB_GC_GRACE_HOURS = '1';
    f = await createApp({
      companyId: COMPANY,
      scopes: ['brain:read', 'brain:write', 'brain:admin'],
      extraKeys: [{ scopes: ['brain:read'] }],
    });
    store = f.app.get(EvidenceStoreService);
    adapter = f.app.get(FsEvidenceStorageAdapter);
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

  /** Bytes into the store + a registered row, the upload path's shape. */
  const registerBlobbedAsset = async (data: Buffer, storageRefOverride?: string) => {
    const byteHash = sha256(data);
    const storageRef =
      storageRefOverride ?? (await adapter.put(COMPANY, byteHash, data)).storageRef;
    const asset = await store.registerAsset(COMPANY, {
      modality: 'image',
      mediaType: 'image/jpeg',
      byteHash,
      byteLength: data.byteLength,
      occurredAt: new Date('2026-05-01T10:00:00.000Z'),
      storageRef,
      userId: USER,
      vertical: 'proj',
    });
    return { ...asset, storageRef, byteHash };
  };

  /**
   * Erase a row without touching its blob — the leak, reproduced. Uses
   * the codebase's LET-select-ids → DELETE-ids idiom: SurrealDB refuses
   * `DELETE $id` when the bound value is a plain STRING record id
   * ("Cannot execute DELETE statement using value"), and every delete
   * leg in src/ therefore selects real record ids first.
   */
  const dropAssetRow = async (assetId: string): Promise<void> => {
    const surreal = f.app.get(SurrealService);
    await surreal.withCompany(COMPANY, async (db) => {
      const [ids] = await db.query<[unknown[]]>(
        `SELECT VALUE id FROM type::record('evidence_asset', $tail)`,
        { tail: assetId.slice(assetId.indexOf(':') + 1) },
      );
      await db.query(`DELETE $ids`, { ids });
    });
  };

  const countRows = async (table: string): Promise<number> => {
    const surreal = f.app.get(SurrealService);
    return surreal.withCompany(COMPANY, async (db) => {
      const [rows] = await db.query<[Array<{ n: number }>]>(
        `SELECT count() AS n FROM ${table} GROUP ALL`,
      );
      return (rows as Array<{ n: number }>)?.[0]?.n ?? 0;
    });
  };

  /**
   * Back-date a stored blob so it sits outside the grace window. The fs
   * adapter reports a blob's age as its mtime — the moment put() wrote
   * the bytes — so this is the same number the sweep reads, moved.
   */
  const ageBlob = async (storageRef: string, ageMs = PAST_GRACE_MS): Promise<void> => {
    const hash = storageRef.slice(storageRef.lastIndexOf('/') + 1);
    const when = new Date(Date.now() - ageMs);
    await utimes(join(fsRoot, COMPANY, hash.slice(0, 2), hash), when, when);
  };

  /** Run the maintenance verb; a tenant pass that threw fails loudly. */
  const sweep = async (body: Record<string, unknown> = {}): Promise<SweepBody> => {
    const res = await f.http.post(ROUTE).set(auth()).send(body).expect(201);
    const swept = res.body as SweepBody;
    // The sweep swallows per-tenant failures by design, so a green
    // assertion on zeroed counters would otherwise prove nothing.
    expect(swept.error).toBeUndefined();
    return swept;
  };

  let livingRef = '';
  let orphanRef = '';

  it('answers a bare 404 while EVIDENCE_ORPHAN_BLOB_GC is off', async () => {
    const res = await f.http.post(ROUTE).set(auth()).send({}).expect(404);
    // Bare: the off-state answer must not describe the route it hides.
    expect(JSON.stringify(res.body)).not.toContain('orphan');
  });

  it('requires brain:admin', async () => {
    process.env.EVIDENCE_ORPHAN_BLOB_GC = '1';
    await f.http.post(ROUTE).set(auth(readOnlyKey)).send({}).expect(403);
  });

  it('never reports a blob a live row references', async () => {
    const asset = await registerBlobbedAsset(randomBytes(64));
    livingRef = asset.storageRef;
    await ageBlob(livingRef);

    const body = await sweep();

    expect(body.dryRun).toBe(true); // stage one: report-only by default
    expect(body.scanned).toBe(1);
    expect(body.referenced).toBe(1);
    expect(body.orphans).toBe(0);
    expect(await adapter.exists(livingRef)).toBe(true);
  });

  it('reports the blob a lost row leaves behind, and deletes nothing in a dry run', async () => {
    const asset = await registerBlobbedAsset(randomBytes(128));
    orphanRef = asset.storageRef;
    // The leak: bytes are in custody, the row that pointed at them is
    // gone (a failed registration, a crashed request, an erased row).
    await dropAssetRow(asset.assetId);
    await ageBlob(orphanRef);

    const body = await sweep();

    expect(body.orphans).toBe(1);
    expect(body.sampleOrphans).toEqual([orphanRef]);
    expect(body.bytesReclaimable).toBe(128);
    expect(body.deleted).toBe(0);
    expect(body.bytesDeleted).toBe(0);
    // Report-only means the bytes are still there to be looked at.
    expect(await adapter.exists(orphanRef)).toBe(true);
    // …and the referenced blob was seen and spared in the same pass.
    expect(body.referenced).toBe(1);
    expect(await adapter.exists(livingRef)).toBe(true);
  });

  it('protects a fresh orphan with the grace window', async () => {
    // The same unreferenced blob, put back inside the window: bytes that
    // young may belong to an upload whose row has not landed yet.
    const fresh = new Date();
    await utimes(
      join(fsRoot, COMPANY, orphanRef.slice(-64, -62), orphanRef.slice(-64)),
      fresh,
      fresh,
    );

    const body = await sweep();

    expect(body.young).toBe(1);
    expect(body.orphans).toBe(0);
    expect(await adapter.exists(orphanRef)).toBe(true);

    // …and back out again, so the rest of the suite sees a real orphan.
    await ageBlob(orphanRef);
  });

  it('reclaims the orphan once the second stage is on, and only the orphan', async () => {
    process.env.EVIDENCE_ORPHAN_BLOB_GC_DELETE = '1';
    const assetsBefore = await countRows('evidence_asset');

    const body = await sweep();

    expect(body.dryRun).toBe(false);
    expect(body.orphans).toBe(1);
    expect(body.deleted).toBe(1);
    expect(body.bytesDeleted).toBe(128);
    expect(body.failed).toBe(0);
    expect(await adapter.exists(orphanRef)).toBe(false);
    // The referenced blob and every row are untouched: this pass deletes
    // bytes, never rows.
    expect(await adapter.exists(livingRef)).toBe(true);
    expect(await countRows('evidence_asset')).toBe(assetsBefore);
  });

  it('is a no-op on the second sweep', async () => {
    const body = await sweep();

    expect(body.orphans).toBe(0);
    expect(body.deleted).toBe(0);
    expect(body.referenced).toBe(1);
    expect(await adapter.exists(livingRef)).toBe(true);
  });

  it('never deletes a SHARED blob while a second row still points at it', async () => {
    // Content-addressed storage makes sharing real: registerAsset takes
    // an explicit storageRef, so a second row can be registered onto an
    // existing blob under its own identity.
    const shared = await registerBlobbedAsset(randomBytes(96));
    await ageBlob(shared.storageRef);
    // Its own identity (a distinct byteHash), the SAME bytes on disk —
    // the write seam only insists the declared length match what is
    // stored, which is why one blob can back more than one row.
    const sidecar = await registerBlobbedAsset(randomBytes(96), shared.storageRef);
    expect(sidecar.assetId).not.toBe(shared.assetId);

    // The blob's "own" row dies; the sidecar survives and still cites it.
    await dropAssetRow(shared.assetId);

    const body = await sweep();

    expect(body.orphans).toBe(0);
    expect(body.deleted).toBe(0);
    expect(await adapter.exists(shared.storageRef)).toBe(true);

    // Only when the LAST reference goes does the blob become collectable.
    await dropAssetRow(sidecar.assetId);
    const after = await sweep();
    expect(after.orphans).toBe(1);
    expect(after.deleted).toBe(1);
    expect(await adapter.exists(shared.storageRef)).toBe(false);
  });
});
