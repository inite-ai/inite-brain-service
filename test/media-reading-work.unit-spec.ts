/**
 * Harness media reading (#900 step 3): the connected agent reads an image
 * the keyless server cannot see. take() hands out only images a pack's
 * current consent covers for image → text, downscaled to JPEG; submit()
 * stores the reading as the asset's text representation and queues the
 * document bridge, once per image.
 */
import { Readable } from 'node:stream';
import sharp from 'sharp';
import {
  MEDIA_READING_PRODUCER,
  MediaReadingWorkService,
  readingText,
} from '../src/evidence/media-reading-work.service';
import { declaredModalitySection, modalitiesChecksum } from '../src/ai/domain-packs';
import { verifyWorkToken, type MediaTokenPayload } from '../src/common/harness-work-token';
import type { DomainPackManifest } from '../src/ai/domain-packs';
import type { SurrealService } from '../src/db/surreal.service';
import type { EvidenceStoreService } from '../src/evidence/evidence-store.service';
import type { EvidenceStorageRegistry } from '../src/evidence/storage/storage-adapter';
import type { JobClaimService } from '../src/jobs/job-claim.service';

const manifest = (produces: string[]) =>
  ({
    id: 'photos',
    version: '1.0.0',
    description: 'unit',
    predicates: [],
    memoryModel: {
      modalities: ['image'],
      processors: [{ id: 'img', modality: 'image', produces }],
    },
  }) as unknown as DomainPackManifest;

const consented = (m: DomainPackManifest) => ({
  packId: 'photos',
  manifest: m,
  acceptedModalities: true,
  acceptedModalitiesChecksum: modalitiesChecksum(declaredModalitySection(m)),
});

const asset = {
  id: 'evidence_asset:img1',
  byteHash: 'h1',
  mediaType: 'image/png',
  modality: 'image',
  availability: 'hot',
  storageRef: 'fs://co_a/h1',
};

async function fixture(opts: { packs: unknown[]; unread?: boolean }) {
  const png = await sharp({
    create: { width: 3000, height: 1000, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .png()
    .toBuffer();
  const db = {
    query: jest.fn(async (sql: string) => {
      if (sql.includes('FROM evidence_asset')) return [[asset], opts.packs];
      if (sql.includes("type::record('evidence_asset'"))
        return [[{ n: opts.unread === false ? 1 : 0 }]];
      return [[]];
    }),
  };
  const surreal = {
    withCompany: async (_c: string, fn: (d: typeof db) => unknown) => fn(db),
  } as unknown as SurrealService;
  const addRepresentation = jest.fn(async () => ({
    representationId: 'derived_representation:r1',
  }));
  const store = { addRepresentation } as unknown as EvidenceStoreService;
  const storage = new Map([
    ['fs', { scheme: 'fs', get: async () => Readable.from([png]) }],
  ]) as unknown as EvidenceStorageRegistry;
  const enqueue = jest.fn(async () => ({ runId: 'j', created: true }));
  const svc = new MediaReadingWorkService(surreal, store, storage, {
    enqueue,
  } as unknown as JobClaimService);
  return { svc, addRepresentation, enqueue };
}

describe('MediaReadingWorkService', () => {
  const saved = process.env.EVIDENCE_DOCUMENT_BRIDGE;
  beforeEach(() => {
    process.env.EVIDENCE_DOCUMENT_BRIDGE = '1';
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.EVIDENCE_DOCUMENT_BRIDGE;
    else process.env.EVIDENCE_DOCUMENT_BRIDGE = saved;
  });

  it('hands out a consented image as a downscaled JPEG with a token naming it', async () => {
    const { svc } = await fixture({ packs: [consented(manifest(['text']))] });
    const work = await svc.take('co_a');
    expect(work?.kind).toBe('media_reading');
    expect(work?.images).toHaveLength(1);
    expect(work?.images?.[0]?.mimeType).toBe('image/jpeg');
    const meta = await sharp(Buffer.from(work!.images![0]!.data, 'base64')).metadata();
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(1568);
    const verdict = verifyWorkToken(work!.token);
    expect(verdict.state).toBe('valid');
    expect((verdict as { payload: MediaTokenPayload }).payload.a).toEqual([
      ['evidence_asset:img1', 'h1', 'photos'],
    ]);
  });

  it('offers nothing without current consent for image → text', async () => {
    expect(
      await (await fixture({ packs: [consented(manifest(['ocr']))] })).svc.take('co_a'),
    ).toBeNull();
    const stale = { ...consented(manifest(['text'])), acceptedModalitiesChecksum: 'old' };
    expect(await (await fixture({ packs: [stale] })).svc.take('co_a')).toBeNull();
    expect(await (await fixture({ packs: [] })).svc.take('co_a')).toBeNull();
  });

  it('stores the reading as the image text representation and queues the bridge', async () => {
    const { svc, addRepresentation, enqueue } = await fixture({ packs: [] });
    const payload = {
      v: 2,
      t: 'media_reading',
      c: 'co_a',
      n: 'n',
      exp: 0,
      a: [['evidence_asset:img1', 'h1', 'photos']],
    } as MediaTokenPayload;
    const out = await svc.submit('co_a', payload, {
      images: [{ image: 'i1', text: 'INVOICE #42', description: 'A photo of an invoice.' }],
    });
    expect(out).toEqual({ images: 1, read: 1, stale: 0, missing: 0 });
    expect(addRepresentation).toHaveBeenCalledWith('co_a', {
      subjectId: 'evidence_asset:img1',
      subjectKind: 'asset',
      kind: 'text',
      content: 'INVOICE #42\n\nA photo of an invoice.',
      model: 'connected-agent',
      producerVersion: MEDIA_READING_PRODUCER,
    });
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        jobType: 'evidence_document_bridge',
        payload: {
          assetId: 'evidence_asset:img1',
          representationId: 'derived_representation:r1',
          packId: 'photos',
        },
      }),
    );
  });

  it('an image read since, or changed, is stale; an unanswered one is missing', async () => {
    const payload = {
      v: 2,
      t: 'media_reading',
      c: 'co_a',
      n: 'n',
      exp: 0,
      a: [['evidence_asset:img1', 'h1', 'photos']],
    } as MediaTokenPayload;
    const read = await fixture({ packs: [], unread: false });
    expect(
      await read.svc.submit('co_a', payload, {
        images: [{ image: 'i1', text: 'x', description: '' }],
      }),
    ).toEqual({ images: 1, read: 0, stale: 1, missing: 0 });
    expect(read.addRepresentation).not.toHaveBeenCalled();
    const fresh = await fixture({ packs: [] });
    expect(await fresh.svc.submit('co_a', payload, { images: [] })).toEqual({
      images: 1,
      read: 0,
      stale: 0,
      missing: 1,
    });
    await expect(fresh.svc.submit('co_a', payload, {})).rejects.toThrow(/images/);
  });

  it('the stored reading is the text, then the description', () => {
    expect(readingText('  a  ', ' b ')).toBe('a\n\nb');
    expect(readingText('', 'only')).toBe('only');
    expect(readingText(undefined, null)).toBe('');
  });
});

describe('take_memory_work — images travel as image blocks', () => {
  it('puts each image after the JSON text, and keeps base64 out of the JSON', async () => {
    const saved = process.env.EXTRACTION_SOURCE;
    process.env.EXTRACTION_SOURCE = 'harness';
    try {
      const { registerHarnessWorkTools } = await import('../src/mcp/harness-work-tools');
      const handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
      const server = {
        registerTool: (
          name: string,
          _c: unknown,
          h: (a: Record<string, unknown>) => Promise<unknown>,
        ) => handlers.set(name, h),
      };
      const work = {
        kind: 'media_reading',
        token: 't',
        systemPrompt: 's',
        userContent: 'u',
        schema: {},
        items: 1,
        expiresAt: 'x',
        images: [{ data: 'QUJD', mimeType: 'image/jpeg' }],
      };
      registerHarnessWorkTools({
        server: server as never,
        companyId: 'co_a',
        deps: { media: () => ({ take: async () => work }) as never },
      });
      const res = (await handlers.get('take_memory_work')!({ kinds: ['media_reading'] })) as {
        content: Array<{ type: string; text?: string; data?: string }>;
      };
      expect(res.content.map((c) => c.type)).toEqual(['text', 'image']);
      expect(res.content[1]?.data).toBe('QUJD');
      expect(res.content[0]?.text).not.toContain('QUJD');
    } finally {
      if (saved === undefined) delete process.env.EXTRACTION_SOURCE;
      else process.env.EXTRACTION_SOURCE = saved;
    }
  });
});
