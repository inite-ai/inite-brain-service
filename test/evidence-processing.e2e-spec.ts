/**
 * Evidence processing lifecycle e2e (migration 0121): OFF byte-identity
 * (no quarantineStatus key, broker 503, zero run rows), idempotent
 * dispatch + replay over a hot text asset, re-processing with a bumped
 * version (supersede pass + sweeper GC), the quarantine seam
 * (external_ingest → quarantined → scan → clean|rejected), consent-gated
 * dispatch (install-time refusal + out-of-band checksum staleness), and
 * the user-forget cascade over processing runs. Service-level suite —
 * this PR ships no HTTP processing surface (sibling PR-C doctrine).
 */
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { EvidenceStoreService } from '../src/evidence/evidence-store.service';
import { EvidenceProcessorBrokerService } from '../src/evidence/processor-broker.service';
import { EvidenceQuarantineService } from '../src/evidence/quarantine.service';
import { TextExtractionPassthroughAdapter } from '../src/evidence/processing/adapters/text-extraction-passthrough.adapter';
import type { EvidenceScanHook } from '../src/evidence/processing/scan-hook';
import { FsEvidenceStorageAdapter } from '../src/evidence/storage/fs-storage.adapter';

const COMPANY = 'co_evidence_processing_e2e';
const USER = 'processing_user';
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

const PREDICATE = {
  localId: 'proc_note',
  displayLabel: 'processing note',
  description: 'TYPE subject is a person; value is a note about processing',
  datatype: 'string',
  semantics: 'append_only',
  decayHalfLifeDays: null,
  piiClass: 'none',
  status: 'active',
};

const packManifest = (id: string) => ({
  id,
  version: '1.0.0',
  description: 'Processing lifecycle e2e pack.',
  predicates: [PREDICATE],
  memoryModel: {
    modalities: ['document'],
    processors: [{ id: 'doc_text', modality: 'document', produces: ['text'] }],
  },
});

describe('evidence processing lifecycle (e2e)', () => {
  let f: AppFixture;
  let store: EvidenceStoreService;
  let broker: EvidenceProcessorBrokerService;
  let quarantine: EvidenceQuarantineService;
  let adapter: FsEvidenceStorageAdapter;
  let fsRoot: string;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    fsRoot = await mkdtemp(join(tmpdir(), 'evidence-processing-e2e-'));
    for (const k of [
      'EVIDENCE_SUBSTRATE_ENABLED',
      'EVIDENCE_PROCESSOR_BROKER',
      'EVIDENCE_QUARANTINE',
      'EVIDENCE_DERIVED_MAX_BYTES',
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
    });
    store = f.app.get(EvidenceStoreService);
    broker = f.app.get(EvidenceProcessorBrokerService);
    quarantine = f.app.get(EvidenceQuarantineService);
    adapter = f.app.get(FsEvidenceStorageAdapter);
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
    const tail = recordId.slice(recordId.indexOf(':') + 1);
    const table = recordId.slice(0, recordId.indexOf(':'));
    return surreal.withCompany(COMPANY, async (db) => {
      const [rows] = await db.query<[Array<Record<string, unknown>>]>(
        `SELECT * FROM type::record($t, $tail)`,
        { t: table, tail },
      );
      return (rows as Array<Record<string, unknown>>)[0]!;
    });
  };

  const registerTextAsset = async (
    text: string,
    extra: Partial<Parameters<EvidenceStoreService['registerAsset']>[1]> = {},
  ) => {
    const data = Buffer.from(text, 'utf8');
    const byteHash = sha256(data);
    const { storageRef } = await adapter.put(COMPANY, byteHash, data);
    return store.registerAsset(COMPANY, {
      modality: 'document',
      mediaType: 'text/plain',
      byteHash,
      byteLength: data.byteLength,
      occurredAt: new Date('2026-04-01T10:00:00.000Z'),
      storageRef,
      userId: USER,
      vertical: 'proj',
      ...extra,
    });
  };

  let firstAssetId = '';
  let firstRunId = '';
  let firstReprId = '';

  it('OFF byte-identity: no quarantineStatus key, broker+quarantine 503, zero run rows', async () => {
    const created = await registerTextAsset('hello evidence');
    firstAssetId = created.assetId;
    const row = await rawRow(created.assetId);
    expect('quarantineStatus' in row).toBe(false);
    await expect(
      broker.dispatchForPack(COMPANY, { packId: 'proc_lifecycle', assetId: created.assetId }),
    ).rejects.toThrow(/EVIDENCE_PROCESSOR_BROKER/);
    await expect(quarantine.runScan(COMPANY, created.assetId)).rejects.toThrow(
      /EVIDENCE_QUARANTINE/,
    );
    // Fail closed: external bytes may not enter without the seam.
    await expect(
      registerTextAsset('external attempt', { origin: 'external_ingest' }),
    ).rejects.toThrow(/EVIDENCE_QUARANTINE/);
    expect(await countRows('processing_run')).toBe(0);
  });

  it('dispatches a declared text extraction once and replays the second call', async () => {
    process.env.EVIDENCE_PROCESSOR_BROKER = '1';
    const install = await f.http
      .post('/v1/admin/packs')
      .set(auth())
      .send({ manifest: packManifest('proc_lifecycle'), acceptModalities: true });
    expect([200, 201]).toContain(install.status);

    const first = await broker.dispatchForPack(COMPANY, {
      packId: 'proc_lifecycle',
      assetId: firstAssetId,
    });
    expect(first.denied).toHaveLength(0);
    expect(first.runs).toHaveLength(1);
    expect(first.runs[0]).toMatchObject({ capability: 'text', status: 'succeeded' });
    expect(first.runs[0]!.representationIds).toHaveLength(1);
    firstRunId = first.runs[0]!.runId;
    firstReprId = first.runs[0]!.representationIds[0]!;

    const repr = await rawRow(firstReprId);
    expect(repr.content).toBe('hello evidence');
    expect(repr.producerVersion).toBe('text-extraction-passthrough-v1');
    expect(String(repr.producedByRun)).toBe(firstRunId);
    expect(await countRows('processing_run')).toBe(1);
    expect(await countRows('derived_representation')).toBe(1);

    const again = await broker.dispatchForPack(COMPANY, {
      packId: 'proc_lifecycle',
      assetId: firstAssetId,
    });
    expect(again.runs[0]).toMatchObject({ status: 'replayed' });
    expect(again.runs[0]!.representationIds).toEqual([firstReprId]);
    expect(await countRows('processing_run')).toBe(1);
    expect(await countRows('derived_representation')).toBe(1);
  });

  it('reprocesses under a bumped version: supersede pass, then sweeper GC', async () => {
    const textAdapter = f.app.get(TextExtractionPassthroughAdapter) as { version: string };
    const originalVersion = textAdapter.version;
    try {
      textAdapter.version = 'text-extraction-passthrough-v2-test';
      const res = await broker.dispatchForPack(COMPANY, {
        packId: 'proc_lifecycle',
        assetId: firstAssetId,
      });
      expect(res.runs[0]).toMatchObject({ status: 'succeeded' });
      const newReprId = res.runs[0]!.representationIds[0]!;
      expect(newReprId).not.toBe(firstReprId);
      expect(res.runs[0]!.runId).not.toBe(firstRunId);

      // Old representation points at its replacement; old run superseded;
      // nothing deleted at supersede time.
      const oldRepr = await rawRow(firstReprId);
      expect(String(oldRepr.supersededBy)).toBe(newReprId);
      const oldRun = await rawRow(firstRunId);
      expect(oldRun.status).toBe('superseded');
      expect(await countRows('processing_run')).toBe(2);
      expect(await countRows('derived_representation')).toBe(2);

      // GC owns removal: the sweeper collects the superseded generation.
      const sweep = await store.sweepTenantEvidence(COMPANY);
      expect(sweep.evidenceSupersededPurged).toBe(1);
      expect(await countRows('derived_representation')).toBe(1);
      const survivor = await rawRow(newReprId);
      expect(survivor.content).toBe('hello evidence');
    } finally {
      textAdapter.version = originalVersion;
    }
  });

  it('quarantines external ingest: dispatch blocked until a scan passes; rejection tombstones', async () => {
    process.env.EVIDENCE_QUARANTINE = '1';
    const external = await registerTextAsset('external bytes one', { origin: 'external_ingest' });
    expect((await rawRow(external.assetId)).quarantineStatus).toBe('quarantined');
    // Internal writes are affirmatively clean while the seam is on.
    const internal = await registerTextAsset('internal while seam on');
    expect((await rawRow(internal.assetId)).quarantineStatus).toBe('clean');

    const blocked = await broker.dispatchForPack(COMPANY, {
      packId: 'proc_lifecycle',
      assetId: external.assetId,
    });
    expect(blocked.runs).toHaveLength(0);
    expect(blocked.denied[0]!.reason).toContain('quarantine');

    const scanned = await quarantine.runScan(COMPANY, external.assetId);
    expect(scanned.quarantineStatus).toBe('clean');
    const after = await broker.dispatchForPack(COMPANY, {
      packId: 'proc_lifecycle',
      assetId: external.assetId,
    });
    expect(after.runs[0]).toMatchObject({ status: 'succeeded' });

    // Rejection path via a test hook override.
    const qsvc = quarantine as unknown as { hook: EvidenceScanHook };
    const originalHook = qsvc.hook;
    try {
      qsvc.hook = { name: 'reject-all-test', scan: () => Promise.resolve('rejected') };
      const doomed = await registerTextAsset('external bytes two', { origin: 'external_ingest' });
      const storageRef = `fs://${COMPANY}/${sha256(Buffer.from('external bytes two', 'utf8'))}`;
      expect(await adapter.exists(storageRef)).toBe(true);
      const verdict = await quarantine.runScan(COMPANY, doomed.assetId);
      expect(verdict.quarantineStatus).toBe('rejected');
      const row = await rawRow(doomed.assetId);
      expect(row).toMatchObject({ availability: 'gone', quarantineStatus: 'rejected' });
      expect(row.storageRef ?? null).toBeNull();
      expect(await adapter.exists(storageRef)).toBe(false);
      const denied = await broker.dispatchForPack(COMPANY, {
        packId: 'proc_lifecycle',
        assetId: doomed.assetId,
      });
      expect(denied.runs).toHaveLength(0);
      expect(denied.denied[0]!.reason).toContain('quarantine');
    } finally {
      qsvc.hook = originalHook;
    }
  });

  it('consent gates dispatch: install refusal, then out-of-band checksum staleness', async () => {
    const refused = await f.http
      .post('/v1/admin/packs')
      .set(auth())
      .send({ manifest: packManifest('proc_consent') });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toContain('acceptModalities');

    const ok = await f.http
      .post('/v1/admin/packs')
      .set(auth())
      .send({ manifest: packManifest('proc_consent'), acceptModalities: true });
    expect([200, 201]).toContain(ok.status);

    const asset = await registerTextAsset('consent-gated content');
    const good = await broker.dispatchForPack(COMPANY, {
      packId: 'proc_consent',
      assetId: asset.assetId,
    });
    expect(good.runs[0]).toMatchObject({ status: 'succeeded' });

    // Out-of-band row edit: stale consent serves/processes NOTHING.
    // Two-step SELECT-ids → UPDATE $ids (3.2.4 planner discipline).
    const surreal = f.app.get(SurrealService);
    await surreal.withCompany(COMPANY, async (db) => {
      const [ids] = await db.query<[unknown[]]>(
        `SELECT VALUE id FROM domain_pack WHERE packId = $p`,
        { p: 'proc_consent' },
      );
      await db.query(`UPDATE $ids SET acceptedModalitiesChecksum = 'stale'`, { ids });
    });
    const stale = await broker.dispatchForPack(COMPANY, {
      packId: 'proc_consent',
      assetId: asset.assetId,
    });
    expect(stale.runs).toHaveLength(0);
    expect(stale.denied[0]!.reason).toContain('modality consent');
  });

  it('user forget cascades processing runs with the evidence rows and drains the blob outbox', async () => {
    expect(await countRows('processing_run')).toBeGreaterThan(0);
    const forget = await f.http.post(`/v1/users/${USER}/forget`).set(auth()).send({});
    expect([200, 201]).toContain(forget.status);
    // Counter SHAPE unchanged (0109 contract) — runs are deleted without
    // a new response field.
    expect(typeof forget.body.evidenceAssetsDeleted).toBe('number');
    expect(typeof forget.body.evidenceFragmentsDeleted).toBe('number');
    expect(typeof forget.body.representationsDeleted).toBe('number');
    expect(forget.body.evidenceAssetsDeleted).toBeGreaterThan(0);
    expect(await countRows('processing_run')).toBe(0);
    expect(await countRows('derived_representation')).toBe(0);
    expect(await countRows('evidence_fragment')).toBe(0);
    expect(await countRows('evidence_asset')).toBe(0);
    expect(await countRows('evidence_blob_gc')).toBe(0);
  });
});
