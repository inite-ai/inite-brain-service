/**
 * Evidence ownership grants e2e (migration 0122, MM-4): registerAsset
 * synthesizes the initial grant, the same-user dedup path keeps ONE live
 * grant, cross-user re-register stays a bare 409 (dedup-probe closure),
 * addGrant/revokeGrant/liveGrants seam behavior, the grant-aware GDPR
 * user-forget (shared assets survive minus the erased owner; sole-owned
 * die rows+blob), the pre-backfill legacy leg, and 0122 backfill
 * idempotence. Service-level like evidence-substrate.e2e-spec — this PR
 * ships no HTTP grant surface.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { EvidenceStoreService } from '../src/evidence/evidence-store.service';
import { FsEvidenceStorageAdapter } from '../src/evidence/storage/fs-storage.adapter';

const COMPANY = 'co_evidence_grant_e2e';
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe('evidence grants (e2e)', () => {
  let f: AppFixture;
  let store: EvidenceStoreService;
  let adapter: FsEvidenceStorageAdapter;
  let surreal: SurrealService;
  let fsRoot: string;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    fsRoot = await mkdtemp(join(tmpdir(), 'evidence-grant-e2e-'));
    saved.EVIDENCE_SUBSTRATE_ENABLED = process.env.EVIDENCE_SUBSTRATE_ENABLED;
    saved.EVIDENCE_FS_ROOT = process.env.EVIDENCE_FS_ROOT;
    process.env.EVIDENCE_SUBSTRATE_ENABLED = '1';
    process.env.EVIDENCE_FS_ROOT = fsRoot;
    f = await createApp({ companyId: COMPANY });
    store = f.app.get(EvidenceStoreService);
    adapter = f.app.get(FsEvidenceStorageAdapter);
    surreal = f.app.get(SurrealService);
  });

  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(fsRoot, { recursive: true, force: true });
    if (f) await f.close();
  });

  const query = async <T>(sql: string, params?: Record<string, unknown>): Promise<T> =>
    surreal.withCompany(COMPANY, async (db) => {
      const [rows] = await db.query<[T]>(sql, params);
      return rows;
    });

  const grantsFor = (assetId: string) =>
    query<Array<{ id: unknown; ownerKind: string; ownerId: string; revokedAt?: unknown }>>(
      `SELECT id, ownerKind, ownerId, revokedAt FROM evidence_grant
        WHERE assetId = type::record('evidence_asset', $tail)`,
      { tail: assetId.slice(assetId.indexOf(':') + 1) },
    );

  const countRows = async (table: string): Promise<number> => {
    const rows = await query<Array<{ n: number }>>(`SELECT count() AS n FROM ${table} GROUP ALL`);
    return rows?.[0]?.n ?? 0;
  };

  const registerFsAsset = async (
    data: Buffer,
    extra: Partial<Parameters<EvidenceStoreService['registerAsset']>[1]> = {},
  ) => {
    const byteHash = sha256(data);
    const { storageRef } = await adapter.put(COMPANY, byteHash, data);
    return store.registerAsset(COMPANY, {
      modality: 'image',
      mediaType: 'image/jpeg',
      byteHash,
      byteLength: data.byteLength,
      occurredAt: new Date('2026-03-01T10:00:00.000Z'),
      storageRef,
      userId: 'grant_u1',
      vertical: 'proj',
      ...extra,
    });
  };

  it('registerAsset synthesizes the initial user grant; dedup keeps ONE live grant', async () => {
    const data = randomBytes(1024);
    const created = await registerFsAsset(data);
    expect(created.deduped).toBe(false);
    let grants = await grantsFor(created.assetId);
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ ownerKind: 'user', ownerId: 'grant_u1' });

    const again = await registerFsAsset(data);
    expect(again.deduped).toBe(true);
    expect(again.assetId).toBe(created.assetId);
    grants = await grantsFor(created.assetId);
    expect(grants).toHaveLength(1);
  });

  it('cross-user re-register stays a bare 409 and grants nothing to the prober', async () => {
    const data = randomBytes(1024);
    const created = await registerFsAsset(data, { userId: 'grant_owner' });
    await expect(registerFsAsset(data, { userId: 'grant_prober' })).rejects.toThrow(
      'evidence asset with this byteHash already registered',
    );
    const grants = await grantsFor(created.assetId);
    expect(grants).toHaveLength(1);
    expect(grants[0]!.ownerId).toBe('grant_owner');
  });

  it('a userId-less registration is system-owned', async () => {
    const created = await store.registerAsset(COMPANY, {
      modality: 'image',
      mediaType: 'image/png',
      byteHash: sha256(randomBytes(64)),
      byteLength: 64,
      occurredAt: new Date('2026-03-01T10:00:00.000Z'),
      originUri: 'https://example.com/sys.png',
      vertical: 'proj',
    });
    const grants = await grantsFor(created.assetId);
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ ownerKind: 'system', ownerId: 'system' });
  });

  it('addGrant is idempotent over live triples; revokeGrant keeps the audit row', async () => {
    const created = await registerFsAsset(randomBytes(700), { userId: 'grant_u2' });
    const first = await store.addGrant(COMPANY, {
      assetId: created.assetId,
      ownerKind: 'pack',
      ownerId: 'pack_alpha',
      purpose: 'processor',
    });
    expect(first.created).toBe(true);
    const dup = await store.addGrant(COMPANY, {
      assetId: created.assetId,
      ownerKind: 'pack',
      ownerId: 'pack_alpha',
    });
    expect(dup).toEqual({ grantId: first.grantId, created: false });
    expect(await store.liveGrants(COMPANY, created.assetId)).toHaveLength(2);

    await store.revokeGrant(COMPANY, first.grantId);
    const live = await store.liveGrants(COMPANY, created.assetId);
    expect(live).toHaveLength(1);
    expect(live[0]!.ownerId).toBe('grant_u2');
    // The revoked row survives for audit; a fresh addGrant creates a new
    // LIVE row instead of resurrecting it.
    expect(await grantsFor(created.assetId)).toHaveLength(2);
    const again = await store.addGrant(COMPANY, {
      assetId: created.assetId,
      ownerKind: 'pack',
      ownerId: 'pack_alpha',
    });
    expect(again.created).toBe(true);
    expect(await grantsFor(created.assetId)).toHaveLength(3);
  });

  it('addGrant refuses unknown assets, gone assets, and the write-gate off', async () => {
    await expect(
      store.addGrant(COMPANY, {
        assetId: 'evidence_asset:missing',
        ownerKind: 'user',
        ownerId: 'nobody',
      }),
    ).rejects.toThrow(/not found/);

    const created = await registerFsAsset(randomBytes(80), { userId: 'grant_u3' });
    await query(`UPDATE type::record('evidence_asset', $tail) SET availability = 'gone'`, {
      tail: created.assetId.slice(created.assetId.indexOf(':') + 1),
    });
    await expect(
      store.addGrant(COMPANY, {
        assetId: created.assetId,
        ownerKind: 'user',
        ownerId: 'late_owner',
      }),
    ).rejects.toThrow(/no longer available/);

    delete process.env.EVIDENCE_SUBSTRATE_ENABLED;
    try {
      await expect(
        store.addGrant(COMPANY, {
          assetId: created.assetId,
          ownerKind: 'user',
          ownerId: 'anyone',
        }),
      ).rejects.toThrow(/EVIDENCE_SUBSTRATE_ENABLED/);
    } finally {
      process.env.EVIDENCE_SUBSTRATE_ENABLED = '1';
    }
  });

  it('forget of ONE owner of a shared asset removes the grant, keeps content for the other', async () => {
    const data = randomBytes(2048);
    const created = await registerFsAsset(data, { userId: 'share_u1' });
    const storageRef = `fs://${COMPANY}/${sha256(data)}`;
    await store.addFragment(COMPANY, {
      assetId: created.assetId,
      locator: { kind: 'pageRegion', page: 0, x: 0.1, y: 0.1, w: 0.4, h: 0.4 },
      label: 'shared receipt',
    });
    await store.addGrant(COMPANY, {
      assetId: created.assetId,
      ownerKind: 'user',
      ownerId: 'share_u2',
      purpose: 'share',
    });

    const forget = await f.http.post('/v1/users/share_u1/forget').set(auth()).send({});
    expect([200, 201]).toContain(forget.status);
    expect(forget.body).toMatchObject({
      evidenceGrantsDeleted: 1,
      evidenceAssetsDeleted: 0,
      evidenceFragmentsDeleted: 0,
      representationsDeleted: 0,
    });
    // Content survives for the other owner; the erased user's grant and
    // identity stamp are gone (#384 exclusive-document semantics on bytes).
    const asset = await store.getAsset(COMPANY, created.assetId);
    expect(asset).not.toBeNull();
    expect(asset!.userId ?? null).toBeNull();
    expect(await adapter.exists(storageRef)).toBe(true);
    expect(await countRows('evidence_blob_gc')).toBe(0);
    const live = await store.liveGrants(COMPANY, created.assetId);
    expect(live).toHaveLength(1);
    expect(live[0]!.ownerId).toBe('share_u2');

    // The LAST owner's forget kills rows and blob exactly like sole-owned.
    const last = await f.http.post('/v1/users/share_u2/forget').set(auth()).send({});
    expect([200, 201]).toContain(last.status);
    expect(last.body).toMatchObject({
      evidenceGrantsDeleted: 1,
      evidenceAssetsDeleted: 1,
      evidenceFragmentsDeleted: 1,
    });
    expect(await store.getAsset(COMPANY, created.assetId)).toBeNull();
    expect(await grantsFor(created.assetId)).toHaveLength(0);
    expect(await adapter.exists(storageRef)).toBe(false);
    expect(await countRows('evidence_blob_gc')).toBe(0);
  });

  it('legacy leg: a userId-stamped asset with ZERO grant rows still dies on forget', async () => {
    const data = randomBytes(640);
    const created = await registerFsAsset(data, { userId: 'legacy_u' });
    const storageRef = `fs://${COMPANY}/${sha256(data)}`;
    // Simulate a pre-0122 row: strip the synthetic grant.
    const ids = await query<unknown[]>(
      `SELECT VALUE id FROM evidence_grant
        WHERE assetId = type::record('evidence_asset', $tail)`,
      { tail: created.assetId.slice(created.assetId.indexOf(':') + 1) },
    );
    await query(`DELETE $ids`, { ids });
    expect(await grantsFor(created.assetId)).toHaveLength(0);

    const forget = await f.http.post('/v1/users/legacy_u/forget').set(auth()).send({});
    expect([200, 201]).toContain(forget.status);
    expect(forget.body).toMatchObject({ evidenceAssetsDeleted: 1, evidenceGrantsDeleted: 0 });
    expect(await store.getAsset(COMPANY, created.assetId)).toBeNull();
    expect(await adapter.exists(storageRef)).toBe(false);
  });

  it('the 0122 backfill is idempotent: applying it twice yields exactly one grant', async () => {
    const created = await registerFsAsset(randomBytes(96), { userId: 'backfill_u' });
    const tail = created.assetId.slice(created.assetId.indexOf(':') + 1);
    const ids = await query<unknown[]>(
      `SELECT VALUE id FROM evidence_grant
        WHERE assetId = type::record('evidence_asset', $tail)`,
      { tail },
    );
    await query(`DELETE $ids`, { ids });

    const migration = readFileSync(
      join(__dirname, '..', 'src', 'db', 'migrations', '0122_evidence_grant.surql'),
      'utf8',
    );
    await surreal.withCompany(COMPANY, async (db) => {
      await db.query(migration);
      await db.query(migration);
    });
    const grants = await grantsFor(created.assetId);
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ ownerKind: 'user', ownerId: 'backfill_u' });
  });
});
