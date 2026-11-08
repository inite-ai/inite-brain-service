/**
 * Harness media reading against a real database (#900 step 3): a consented
 * image is offered once, the agent's reading lands as the image's text
 * representation, the bridge job is queued, and the image is not offered
 * again.
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
import { FsEvidenceStorageAdapter } from '../src/evidence/storage/fs-storage.adapter';
import {
  MEDIA_READING_PRODUCER,
  MediaReadingWorkService,
} from '../src/evidence/media-reading-work.service';
import { verifyWorkToken, type MediaTokenPayload } from '../src/common/harness-work-token';

const COMPANY = 'co_media_reading_e2e';
const FLAGS = ['EVIDENCE_SUBSTRATE_ENABLED', 'EVIDENCE_FS_ROOT', 'EVIDENCE_DOCUMENT_BRIDGE'];

describe('harness media reading (e2e)', () => {
  let f: AppFixture;
  let fsRoot: string;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    fsRoot = await mkdtemp(join(tmpdir(), 'media-reading-e2e-'));
    for (const k of FLAGS) saved[k] = process.env[k];
    Object.assign(process.env, {
      EVIDENCE_SUBSTRATE_ENABLED: '1',
      EVIDENCE_FS_ROOT: fsRoot,
      EVIDENCE_DOCUMENT_BRIDGE: '1',
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

  it('offers a consented image once and stores the reading', async () => {
    const install = await f.http
      .post('/v1/admin/packs')
      .set({ Authorization: `Bearer ${f.apiKey}` })
      .send({
        manifest: {
          id: 'photo_memory',
          version: '1.0.0',
          description: 'Media reading e2e pack.',
          predicates: [
            {
              localId: 'photo_note',
              displayLabel: 'photo note',
              description: 'TYPE subject is a person; value is a note read off a photo',
              datatype: 'string',
              semantics: 'append_only',
              decayHalfLifeDays: null,
              piiClass: 'none',
              status: 'active',
            },
          ],
          memoryModel: {
            modalities: ['image'],
            processors: [{ id: 'img_read', modality: 'image', produces: ['text'] }],
          },
        },
        acceptModalities: true,
      });
    expect([200, 201]).toContain(install.status);

    const png = await sharp({
      create: { width: 400, height: 300, channels: 3, background: { r: 200, g: 220, b: 240 } },
    })
      .png()
      .toBuffer();
    const byteHash = createHash('sha256').update(png).digest('hex');
    const { storageRef } = await f.app.get(FsEvidenceStorageAdapter).put(COMPANY, byteHash, png);
    const { assetId } = await f.app.get(EvidenceStoreService).registerAsset(COMPANY, {
      modality: 'image',
      mediaType: 'image/png',
      byteHash,
      byteLength: png.byteLength,
      occurredAt: new Date('2026-04-01T10:00:00.000Z'),
      storageRef,
      vertical: 'photos',
    });

    const svc = f.app.get(MediaReadingWorkService);
    const work = await svc.take(COMPANY);
    expect(work?.images).toHaveLength(1);
    const verdict = verifyWorkToken(work!.token);
    const payload = (verdict as { payload: MediaTokenPayload }).payload;
    expect(payload.a[0]?.[0]).toBe(assetId);

    const out = await svc.submit(COMPANY, payload, {
      images: [{ image: 'i1', text: 'Gate B22', description: 'A boarding sign.' }],
    });
    expect(out).toEqual({ images: 1, read: 1, stale: 0, missing: 0 });
    // Applied twice changes nothing.
    expect(
      await svc.submit(COMPANY, payload, {
        images: [{ image: 'i1', text: 'Gate B22', description: 'A boarding sign.' }],
      }),
    ).toEqual({ images: 1, read: 0, stale: 1, missing: 0 });

    const surreal = f.app.get(SurrealService);
    const [reps, jobs] = await surreal.withCompany(COMPANY, async (db) => {
      const [r] = await db.query<[Array<{ kind: string; content: string }>]>(
        `SELECT kind, content FROM derived_representation WHERE producerVersion = $pv`,
        { pv: MEDIA_READING_PRODUCER },
      );
      const [j] = await db.query<[unknown[]]>(
        `SELECT id FROM job_run WHERE jobType = 'evidence_document_bridge'`,
      );
      return [r ?? [], j ?? []] as const;
    });
    expect(reps).toEqual([{ kind: 'text', content: 'Gate B22\n\nA boarding sign.' }]);
    expect(jobs).toHaveLength(1);
    expect(await svc.take(COMPANY)).toBeNull();
  }, 120_000);
});
