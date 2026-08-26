/**
 * Evidence substrate e2e (migration 0109): master-flag gate (off →
 * writers refuse, no rows), fs-backed registerAsset + fragment +
 * representation writes, same-user dedupe over the UNIQUE byteHash, the
 * user-forget GDPR cascade (rows + blob + response counters), and the
 * sweeper retention leg (retainUntil past → 'gone' tombstone + blob
 * deleted + dependents purged). Service-level suite — this PR ships no
 * HTTP evidence surface (sibling PR-C).
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { EvidenceStoreService } from '../src/evidence/evidence-store.service';
import { FsEvidenceStorageAdapter } from '../src/evidence/storage/fs-storage.adapter';
import { CandidateSweeperService } from '../src/documents/candidate-sweeper.service';

const COMPANY = 'co_evidence_e2e';
const USER = 'evidence_user';
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe('evidence substrate (e2e)', () => {
  let f: AppFixture;
  let store: EvidenceStoreService;
  let adapter: FsEvidenceStorageAdapter;
  let fsRoot: string;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    fsRoot = await mkdtemp(join(tmpdir(), 'evidence-e2e-'));
    saved.EVIDENCE_SUBSTRATE_ENABLED = process.env.EVIDENCE_SUBSTRATE_ENABLED;
    saved.EVIDENCE_FS_ROOT = process.env.EVIDENCE_FS_ROOT;
    delete process.env.EVIDENCE_SUBSTRATE_ENABLED;
    process.env.EVIDENCE_FS_ROOT = fsRoot;
    f = await createApp({ companyId: COMPANY });
    store = f.app.get(EvidenceStoreService);
    adapter = f.app.get(FsEvidenceStorageAdapter);
  });

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
    return surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[Array<{ n: number }>]>(
        `SELECT count() AS n FROM ${table} GROUP ALL`,
      );
      return (rows as Array<{ n: number }>)?.[0]?.n ?? 0;
    });
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
      userId: USER,
      vertical: 'proj',
      ...extra,
    });
  };

  it('refuses every write with the flag off and writes no rows', async () => {
    await expect(
      store.registerAsset(COMPANY, {
        modality: 'image',
        mediaType: 'image/jpeg',
        byteHash: 'a'.repeat(64),
        byteLength: 10,
        occurredAt: new Date(),
        originUri: 'https://example.com/x.jpg',
        vertical: 'proj',
      }),
    ).rejects.toThrow(/EVIDENCE_SUBSTRATE_ENABLED/);
    expect(await countRows('evidence_asset')).toBe(0);
  });

  it('registers an fs-backed asset with a fragment and a representation, and dedupes', async () => {
    process.env.EVIDENCE_SUBSTRATE_ENABLED = '1';
    const data = randomBytes(2048);
    const created = await registerFsAsset(data);
    expect(created.deduped).toBe(false);
    expect(created.availability).toBe('hot');

    const frag = await store.addFragment(COMPANY, {
      assetId: created.assetId,
      locator: { kind: 'pageRegion', page: 0, x: 0.1, y: 0.1, w: 0.4, h: 0.4 },
      label: 'receipt total, mail me at test@example.com',
    });
    const repr = await store.addRepresentation(COMPANY, {
      subjectId: frag.fragmentId,
      subjectKind: 'fragment',
      kind: 'caption',
      content: 'A receipt totalling 42 EUR',
      producerVersion: 'captioner-test-v1',
    });
    expect(repr.representationId).toContain('derived_representation:');
    expect(await countRows('evidence_asset')).toBe(1);
    expect(await countRows('evidence_fragment')).toBe(1);
    expect(await countRows('derived_representation')).toBe(1);

    // Fragment label went through the PII redactor at write.
    const surreal = f.app.get(SurrealService);
    const label = await surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[Array<{ label: string }>]>(
        `SELECT label FROM evidence_fragment LIMIT 1`,
      );
      return (rows as Array<{ label: string }>)?.[0]?.label ?? '';
    });
    expect(label).toContain('[EMAIL]');
    expect(label).not.toContain('test@example.com');

    // Same-user re-registration dedupes onto the same row.
    const again = await registerFsAsset(data);
    expect(again.deduped).toBe(true);
    expect(again.assetId).toBe(created.assetId);
    expect(await countRows('evidence_asset')).toBe(1);
  });

  it('user forget cascades rows, deletes the blob, and reports counters', async () => {
    const asset = (await store.getAsset(COMPANY, 'nonexistent')) ?? null;
    expect(asset).toBeNull(); // getters are flag-independent reads
    const surreal = f.app.get(SurrealService);
    const storageRef = await surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[Array<{ storageRef: string }>]>(
        `SELECT storageRef FROM evidence_asset LIMIT 1`,
      );
      return (rows as Array<{ storageRef: string }>)?.[0]?.storageRef ?? '';
    });
    expect(await adapter.exists(storageRef)).toBe(true);

    const forget = await f.http.post(`/v1/users/${USER}/forget`).set(auth()).send({});
    expect([200, 201]).toContain(forget.status);
    expect(forget.body).toMatchObject({
      evidenceAssetsDeleted: 1,
      evidenceFragmentsDeleted: 1,
      representationsDeleted: 1,
    });
    expect(await countRows('evidence_asset')).toBe(0);
    expect(await countRows('evidence_fragment')).toBe(0);
    expect(await countRows('derived_representation')).toBe(0);
    expect(await adapter.exists(storageRef)).toBe(false);
  });

  it('the sweeper retention leg tombstones an expired asset and deletes its blob', async () => {
    const data = randomBytes(512);
    const created = await registerFsAsset(data, {
      retainUntil: new Date('2020-01-01T00:00:00.000Z'),
    });
    await store.addFragment(COMPANY, {
      assetId: created.assetId,
      locator: { kind: 'pageRegion', page: 0, x: 0, y: 0, w: 1, h: 1 },
    });
    const storageRef = `fs://${COMPANY}/${sha256(data)}`;
    expect(await adapter.exists(storageRef)).toBe(true);

    const sweeper = f.app.get(CandidateSweeperService);
    const result = await sweeper.sweepTenant(COMPANY);
    expect(result.evidenceExpired).toBe(1);
    expect(result.evidenceBlobsDeleted).toBe(1);

    const surreal = f.app.get(SurrealService);
    const row = await surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[Array<Record<string, unknown>>]>(
        `SELECT availability, storageRef FROM evidence_asset LIMIT 1`,
      );
      return (rows as Array<Record<string, unknown>>)?.[0];
    });
    expect(row).toMatchObject({ availability: 'gone' });
    expect(row!.storageRef ?? null).toBeNull();
    expect(await countRows('evidence_fragment')).toBe(0);
    expect(await adapter.exists(storageRef)).toBe(false);
  });
});
