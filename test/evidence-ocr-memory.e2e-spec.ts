/**
 * #900 step 2: the words an image yields become memory. A screenshot is
 * uploaded, the OCR processor reads it (the real tesseract.js engine, local
 * models), and the evidence → document bridge hands the whole run — every
 * text region, in reading order — to the ordinary document pipeline, which
 * commits facts with the asset as provenance. Before, the bridge passed
 * only a `document` asset's `text` representation, so an image was read
 * and never remembered.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { EvidenceStoreService } from '../src/evidence/evidence-store.service';
import { EvidenceProcessorBrokerService } from '../src/evidence/processor-broker.service';
import { EvidenceDocumentBridgeService } from '../src/documents/evidence-document-bridge.service';
import { FsEvidenceStorageAdapter } from '../src/evidence/storage/fs-storage.adapter';

const COMPANY = 'co_evidence_ocr_memory_e2e';
const USER = 'ocr_user';
const PACK = 'ocr_memory';
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

const FLAGS = [
  'EVIDENCE_SUBSTRATE_ENABLED',
  'EVIDENCE_PROCESSOR_BROKER',
  'EVIDENCE_OCR_ENABLED',
  'EVIDENCE_FS_ROOT',
  'EVIDENCE_DOCUMENT_BRIDGE',
  'DOCUMENT_INGEST_ENABLED',
];

/** Dark type on white with a white margin (test/eval/media/runner.ts on why). */
async function screenshot(text: string): Promise<Buffer> {
  const glyphs = await sharp({ text: { text, width: 1400, dpi: 300, rgba: false } })
    .negate()
    .png()
    .toBuffer();
  return sharp(glyphs)
    .toColourspace('srgb')
    .extend({ top: 40, bottom: 40, left: 40, right: 40, background: { r: 255, g: 255, b: 255 } })
    .png()
    .toBuffer();
}

describe('OCR text becomes memory (e2e)', () => {
  let f: AppFixture;
  let fsRoot: string;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    fsRoot = await mkdtemp(join(tmpdir(), 'evidence-ocr-memory-e2e-'));
    for (const k of FLAGS) saved[k] = process.env[k];
    Object.assign(process.env, {
      EVIDENCE_SUBSTRATE_ENABLED: '1',
      EVIDENCE_PROCESSOR_BROKER: '1',
      EVIDENCE_OCR_ENABLED: '1',
      EVIDENCE_FS_ROOT: fsRoot,
      EVIDENCE_DOCUMENT_BRIDGE: '1',
      DOCUMENT_INGEST_ENABLED: '1',
    });
    f = await createApp({
      companyId: COMPANY,
      scopes: ['brain:read', 'brain:write', 'brain:admin'],
    });
  }, 120_000);

  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(fsRoot, { recursive: true, force: true });
    if (f) await f.close();
  });

  it('a screenshot is read, bridged as one document and committed as facts', async () => {
    const install = await f.http
      .post('/v1/admin/packs')
      .set({ Authorization: `Bearer ${f.apiKey}` })
      .send({
        manifest: {
          id: PACK,
          version: '1.0.0',
          description: 'OCR memory e2e pack.',
          predicates: [],
          memoryModel: {
            modalities: ['image'],
            processors: [{ id: 'img_ocr', modality: 'image', produces: ['ocr'] }],
          },
        },
        acceptModalities: true,
      });
    expect([200, 201]).toContain(install.status);

    const png = await screenshot('INVOICE #INV-2026-0417\nTotal due: $12,480.00');
    const byteHash = sha256(png);
    const { storageRef } = await f.app.get(FsEvidenceStorageAdapter).put(COMPANY, byteHash, png);
    const { assetId } = await f.app.get(EvidenceStoreService).registerAsset(COMPANY, {
      modality: 'image',
      mediaType: 'image/png',
      byteHash,
      byteLength: png.byteLength,
      occurredAt: new Date('2026-04-01T10:00:00.000Z'),
      storageRef,
      userId: USER,
      vertical: 'finance',
    });

    const dispatch = await f.app
      .get(EvidenceProcessorBrokerService)
      .dispatchForPack(COMPANY, { packId: PACK, assetId });
    expect(dispatch.denied).toHaveLength(0);
    expect(dispatch.runs[0]).toMatchObject({ capability: 'ocr', status: 'succeeded' });
    const representationId = dispatch.runs[0]!.representationIds[0]!;

    const r = await f.app
      .get(EvidenceDocumentBridgeService)
      .bridge(COMPANY, { assetId, representationId, packId: PACK });
    expect(r.failed).toBe(0);
    expect(r.ingested + r.deduplicated).toBe(1);

    const surreal = f.app.get(SurrealService);
    const docs = await surreal.withCompany(COMPANY, async (db) => {
      const [rows] = await db.query<[Array<{ id: unknown; content?: string; userId?: string }>]>(
        `SELECT id, content, userId FROM source_document WHERE kind = 'evidence_text'`,
      );
      return rows ?? [];
    });
    expect(docs).toHaveLength(1);
    expect(docs[0]!.userId).toBe(USER);
    expect(docs[0]!.content).toContain('INV-2026-0417');
    expect(docs[0]!.content).toContain('$12,480.00');

    const facts = await surreal.withCompany(COMPANY, async (db) => {
      const [rows] = await db.query<[Array<{ source: { evidence?: unknown[] } }>]>(
        `SELECT source FROM knowledge_fact WHERE source.documentId = $doc`,
        { doc: docs[0]!.id },
      );
      return rows ?? [];
    });
    expect(facts.length).toBeGreaterThanOrEqual(1);
    expect(facts[0]!.source.evidence).toContainEqual(
      expect.objectContaining({ kind: 'asset', ref: assetId }),
    );
  }, 120_000);
});
