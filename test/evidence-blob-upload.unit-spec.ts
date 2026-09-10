/**
 * Evidence blob upload unit pins (Brain v2.1 MM-7) — the pure decision
 * seams of the byte surface, no Nest app and no database:
 *
 *  - the media-type allowlist: membership, modality PAIRING, parameter
 *    normalisation, and the explicit exclusions (SVG, HTML, archives,
 *    octet-stream);
 *  - the flag gate: interceptor 404 before any multipart parsing, and
 *    the handler's second 404 — both while EVIDENCE_BLOB_UPLOAD_ENABLED
 *    is off;
 *  - the size cap and the empty-part rejection;
 *  - userId / scope stamping reaching registerAsset verbatim, together
 *    with the server-owned identity fields (byteHash over the RECEIVED
 *    bytes, measured byteLength, adapter-minted storageRef, origin
 *    'external_ingest');
 *  - scan-before-serve: clean, rejected (422 + blob removal), and a
 *    throwing hook leaving 'scanning' rather than failing open;
 *  - dispatch fire-and-forget: a rejecting broker never fails the upload.
 */
import { NotFoundException } from '@nestjs/common';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { EvidenceBlobUploadInterceptor } from '../src/evidence/blob-upload.interceptor';
import { EvidenceIngestController } from '../src/evidence/evidence-ingest.controller';
import {
  EvidenceUploadService,
  type UploadEvidenceBlobInput,
} from '../src/evidence/evidence-upload.service';
import type { UploadedEvidenceBlob } from '../src/evidence/blob-upload.interceptor';
import {
  EVIDENCE_UPLOAD_MEDIA_TYPES,
  normalizeUploadMediaType,
  uploadMediaTypeError,
} from '../src/evidence/upload-media-types';
import type {
  EvidenceStoreService,
  RegisterAssetInput,
} from '../src/evidence/evidence-store.service';
import type { EvidenceProcessorBrokerService } from '../src/evidence/processor-broker.service';
import type { EvidenceQuarantineService } from '../src/evidence/quarantine.service';
import type { EvidenceStorageAdapter } from '../src/evidence/storage/storage-adapter';

const COMPANY = 'co_blob_unit';
// The default EVIDENCE_STORAGE_SCHEME: uploads resolve their adapter by
// scheme, so the fixture registers itself under the one the service asks for.
const UPLOAD_SCHEME = 'fs';
const BYTES = Buffer.from('hello upload', 'utf8');
// sha256('hello upload') — pinned so a change to what the server hashes
// (the received bytes, never a caller assertion) fails loudly here.
const BYTES_HASH = '2d119f1cd272958a492a144af600b9dc36531f73027b34073967345b027021b1';

function blob(over: Partial<UploadedEvidenceBlob> = {}): UploadedEvidenceBlob {
  return {
    originalname: 'note.txt',
    mimetype: 'text/plain',
    size: BYTES.byteLength,
    buffer: BYTES,
    ...over,
  };
}

function input(over: Partial<UploadEvidenceBlobInput> = {}): UploadEvidenceBlobInput {
  return {
    modality: 'document',
    occurredAt: new Date('2026-05-01T10:00:00.000Z'),
    vertical: 'proj',
    ...over,
  };
}

interface Harness {
  service: EvidenceUploadService;
  registered: RegisterAssetInput[];
  deleted: string[];
  dispatches: Array<{ packId: string; assetId: string }>;
  adapter: EvidenceStorageAdapter;
}

function harness(
  opts: {
    scan?: () => Promise<{ assetId: string; quarantineStatus: 'clean' | 'rejected' }>;
    dispatch?: () => Promise<never>;
    availability?: string;
    deduped?: boolean;
    registerThrows?: Error;
    adapters?: Map<string, EvidenceStorageAdapter>;
  } = {},
): Harness {
  const registered: RegisterAssetInput[] = [];
  const deleted: string[] = [];
  const dispatches: Array<{ packId: string; assetId: string }> = [];
  const stored = new Map<string, Buffer>();
  const adapter = {
    scheme: UPLOAD_SCHEME,
    put: (companyId: string, byteHash: string, data: Buffer) => {
      const storageRef = `${UPLOAD_SCHEME}://${companyId}/${byteHash}`;
      stored.set(storageRef, data);
      return Promise.resolve({ storageRef, byteLength: data.byteLength });
    },
    belongsToTenant: () => true,
    get: () => Promise.reject(new Error('unused')),
    head: (ref: string) => {
      const found = stored.get(ref);
      return Promise.resolve(found ? { byteLength: found.byteLength } : null);
    },
    exists: (ref: string) => Promise.resolve(stored.has(ref)),
    delete: (ref: string) => {
      deleted.push(ref);
      return Promise.resolve(stored.delete(ref));
    },
  } as unknown as EvidenceStorageAdapter;
  const store = {
    registerAsset: (_companyId: string, spec: RegisterAssetInput) => {
      if (opts.registerThrows) return Promise.reject(opts.registerThrows);
      registered.push(spec);
      return Promise.resolve({
        assetId: 'evidence_asset:up1',
        availability: opts.availability ?? 'hot',
        deduped: opts.deduped ?? false,
      });
    },
  } as unknown as EvidenceStoreService;
  const quarantine = {
    runScan: opts.scan ?? (() => Promise.resolve({ assetId: 'x', quarantineStatus: 'clean' })),
  } as unknown as EvidenceQuarantineService;
  const broker = {
    dispatchForPack: (_c: string, req: { packId: string; assetId: string }) => {
      dispatches.push(req);
      return opts.dispatch ? opts.dispatch() : Promise.resolve({ runs: [], denied: [] });
    },
  } as unknown as EvidenceProcessorBrokerService;
  const adapters = opts.adapters ?? new Map([[UPLOAD_SCHEME, adapter]]);
  return {
    service: new EvidenceUploadService(store, adapters, quarantine, broker),
    registered,
    deleted,
    dispatches,
    adapter,
  };
}

describe('upload media-type allowlist', () => {
  it('accepts only the declared pairs and rejects the cross-modality ones', () => {
    expect(uploadMediaTypeError('document', 'application/pdf')).toBeNull();
    expect(uploadMediaTypeError('image', 'image/png')).toBeNull();
    // text/csv is allowlisted for BOTH document and sensor — deliberate.
    expect(uploadMediaTypeError('document', 'text/csv')).toBeNull();
    expect(uploadMediaTypeError('sensor', 'text/csv')).toBeNull();
    // Allowlisted overall, wrong modality: named as a pairing failure.
    const paired = uploadMediaTypeError('document', 'image/png');
    expect(paired).toContain("not accepted for modality 'document'");
  });

  it('refuses the deliberate exclusions', () => {
    for (const [modality, type] of [
      ['image', 'image/svg+xml'],
      ['document', 'text/html'],
      ['document', 'application/octet-stream'],
      ['document', 'application/zip'],
      ['document', 'application/vnd.ms-excel'],
    ] as const) {
      expect(uploadMediaTypeError(modality, type)).toContain('not accepted');
    }
  });

  it('normalises parameters and case before matching', () => {
    expect(normalizeUploadMediaType(' TEXT/Plain; charset=utf-8 ')).toBe('text/plain');
    expect(uploadMediaTypeError('document', 'Text/Plain; charset=UTF-8')).toBeNull();
    expect(uploadMediaTypeError('document', '   ')).toContain('media type is required');
  });

  it('every allowlist entry is a bare lowercase type/subtype', () => {
    for (const types of Object.values(EVIDENCE_UPLOAD_MEDIA_TYPES)) {
      for (const t of types) expect(t).toBe(normalizeUploadMediaType(t));
    }
  });
});

describe('blob upload flag gate', () => {
  const saved = process.env.EVIDENCE_BLOB_UPLOAD_ENABLED;
  afterEach(() => {
    if (saved === undefined) delete process.env.EVIDENCE_BLOB_UPLOAD_ENABLED;
    else process.env.EVIDENCE_BLOB_UPLOAD_ENABLED = saved;
  });

  it('the interceptor 404s BEFORE the multipart body is parsed', () => {
    delete process.env.EVIDENCE_BLOB_UPLOAD_ENABLED;
    const interceptor = new EvidenceBlobUploadInterceptor();
    const next = { handle: jest.fn() } as unknown as CallHandler;
    expect(() => interceptor.intercept({} as ExecutionContext, next)).toThrow(NotFoundException);
    // The proof that nothing was parsed: the handler chain was never
    // entered, so no multer instance ever saw the request.
    expect((next.handle as jest.Mock).mock.calls).toHaveLength(0);
  });

  it('the handler keeps its own 404 (defence in depth)', async () => {
    delete process.env.EVIDENCE_BLOB_UPLOAD_ENABLED;
    const h = harness();
    const controller = new EvidenceIngestController(
      {} as unknown as EvidenceStoreService,
      h.service,
    );
    const req = { brainAuth: { companyId: COMPANY } } as never;
    await expect(
      controller.uploadEvidenceBlob(req, { modality: 'document' } as never, blob()),
    ).rejects.toThrow(NotFoundException);
  });

  it('with the flag on, a missing file part is a 400 (not a 500)', async () => {
    process.env.EVIDENCE_BLOB_UPLOAD_ENABLED = '1';
    const h = harness();
    const controller = new EvidenceIngestController(
      {} as unknown as EvidenceStoreService,
      h.service,
    );
    const req = { brainAuth: { companyId: COMPANY } } as never;
    await expect(
      controller.uploadEvidenceBlob(req, { modality: 'document' } as never, undefined),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe('blob upload pipeline', () => {
  const savedCap = process.env.EVIDENCE_MAX_BYTES;
  afterEach(() => {
    if (savedCap === undefined) delete process.env.EVIDENCE_MAX_BYTES;
    else process.env.EVIDENCE_MAX_BYTES = savedCap;
  });

  it('stamps userId + scope and owns byteHash / byteLength / storageRef / origin', async () => {
    const h = harness();
    const res = await h.service.upload(
      COMPANY,
      blob(),
      input({ userId: 'u1', scope: ['team:a', 'team:b'], piiClasses: [] }),
    );
    const spec = h.registered[0]!;
    expect(spec.userId).toBe('u1');
    expect(spec.scope).toEqual(['team:a', 'team:b']);
    expect(spec.piiClasses).toEqual([]);
    // Server-owned identity, not caller-asserted.
    expect(spec.byteHash).toBe(BYTES_HASH);
    expect(spec.byteLength).toBe(BYTES.byteLength);
    expect(spec.storageRef).toBe(`${UPLOAD_SCHEME}://${COMPANY}/${BYTES_HASH}`);
    expect(spec.originUri).toBeUndefined();
    // Bytes over HTTP are external ingest — the MM-6 fence must apply.
    expect(spec.origin).toBe('external_ingest');
    expect(res).toMatchObject({
      availability: 'hot',
      byteHash: BYTES_HASH,
      quarantineStatus: 'clean',
      dispatched: false,
      mediaType: 'text/plain',
    });
  });

  it('canonicalises a parameterised part media type onto the row', async () => {
    const h = harness();
    const res = await h.service.upload(
      COMPANY,
      blob({ mimetype: 'text/plain; charset=utf-8' }),
      input(),
    );
    expect(res.mediaType).toBe('text/plain');
    expect(h.registered[0]!.mediaType).toBe('text/plain');
  });

  it('rejects an over-cap upload with 413 and an empty part with 400', async () => {
    process.env.EVIDENCE_MAX_BYTES = '4';
    const h = harness();
    await expect(h.service.upload(COMPANY, blob(), input())).rejects.toMatchObject({ status: 413 });
    delete process.env.EVIDENCE_MAX_BYTES;
    await expect(
      h.service.upload(COMPANY, blob({ buffer: Buffer.alloc(0) }), input()),
    ).rejects.toMatchObject({ status: 400 });
    expect(h.registered).toHaveLength(0);
  });

  it('rejects a disallowed media type before anything is stored', async () => {
    const h = harness();
    await expect(
      h.service.upload(COMPANY, blob({ mimetype: 'image/svg+xml' }), input({ modality: 'image' })),
    ).rejects.toMatchObject({ status: 400 });
    expect(h.registered).toHaveLength(0);
    expect(await h.adapter.exists(`${UPLOAD_SCHEME}://${COMPANY}/${BYTES_HASH}`)).toBe(false);
  });

  it('503s when no adapter owns the upload scheme', async () => {
    const h = harness({ adapters: new Map() });
    await expect(h.service.upload(COMPANY, blob(), input())).rejects.toMatchObject({ status: 503 });
  });

  describe('EVIDENCE_STORAGE_SCHEME picks the store', () => {
    afterEach(() => delete process.env.EVIDENCE_STORAGE_SCHEME);

    /** An adapter under a different scheme, remembering what it was handed. */
    function objectStore(): { adapter: EvidenceStorageAdapter; refs: string[] } {
      const refs: string[] = [];
      const adapter = {
        scheme: 's3',
        put: (companyId: string, byteHash: string, data: Buffer) => {
          const storageRef = `s3://${companyId}/${byteHash}`;
          refs.push(storageRef);
          return Promise.resolve({ storageRef, byteLength: data.byteLength });
        },
        belongsToTenant: () => true,
        head: () => Promise.resolve(null),
        exists: () => Promise.resolve(false),
        get: () => Promise.reject(new Error('unused')),
        delete: () => Promise.resolve(true),
      } as unknown as EvidenceStorageAdapter;
      return { adapter, refs };
    }

    it('writes the bytes through the selected adapter and records ITS ref on the row', async () => {
      process.env.EVIDENCE_STORAGE_SCHEME = 's3';
      const s3 = objectStore();
      const h = harness({ adapters: new Map([['s3', s3.adapter]]) });
      await h.service.upload(COMPANY, blob(), input());
      expect(s3.refs).toEqual([`s3://${COMPANY}/${BYTES_HASH}`]);
      expect(h.registered[0]!.storageRef).toBe(`s3://${COMPANY}/${BYTES_HASH}`);
    });

    it('503s rather than silently falling back to local disk when s3 is unregistered', async () => {
      process.env.EVIDENCE_STORAGE_SCHEME = 's3';
      // The fs adapter IS registered — the point is that it is not used.
      const h = harness();
      await expect(h.service.upload(COMPANY, blob(), input())).rejects.toMatchObject({
        status: 503,
      });
      expect(h.registered).toHaveLength(0);
    });
  });
});

describe('scan before serve', () => {
  it('a rejected verdict answers 422 and removes the re-materialised blob', async () => {
    const h = harness({
      scan: () => Promise.resolve({ assetId: 'evidence_asset:up1', quarantineStatus: 'rejected' }),
    });
    await expect(h.service.upload(COMPANY, blob(), input())).rejects.toMatchObject({ status: 422 });
    expect(h.deleted).toEqual([`${UPLOAD_SCHEME}://${COMPANY}/${BYTES_HASH}`]);
  });

  it('a throwing scan hook leaves the asset scanning — it never fails open', async () => {
    const h = harness({ scan: () => Promise.reject(new Error('scanner down')) });
    const res = await h.service.upload(COMPANY, blob(), input({ packId: 'p1' }));
    expect(res.quarantineStatus).toBe('scanning');
    // Not clean ⇒ no dispatch is even attempted (the gate would deny it
    // anyway, but the upload path must not ask).
    expect(res.dispatched).toBe(false);
    expect(h.dispatches).toHaveLength(0);
  });
});

describe('dispatch is fire-and-forget', () => {
  const saved = process.env.EVIDENCE_PROCESSOR_BROKER;
  afterEach(() => {
    if (saved === undefined) delete process.env.EVIDENCE_PROCESSOR_BROKER;
    else process.env.EVIDENCE_PROCESSOR_BROKER = saved;
  });

  it('a failing dispatch does not fail the upload', async () => {
    process.env.EVIDENCE_PROCESSOR_BROKER = '1';
    const h = harness({ dispatch: () => Promise.reject(new Error('broker exploded')) });
    const res = await h.service.upload(COMPANY, blob(), input({ packId: 'p1' }));
    expect(res.dispatched).toBe(true);
    expect(res.assetId).toBe('evidence_asset:up1');
    expect(h.dispatches).toEqual([{ packId: 'p1', assetId: 'evidence_asset:up1' }]);
    // Let the rejected promise settle so the handled .catch() runs.
    await new Promise((resolve) => setImmediate(resolve));
  });

  it('dispatches nothing while the broker flag is off, or with no packId', async () => {
    delete process.env.EVIDENCE_PROCESSOR_BROKER;
    const off = harness();
    expect((await off.service.upload(COMPANY, blob(), input({ packId: 'p1' }))).dispatched).toBe(
      false,
    );
    expect(off.dispatches).toHaveLength(0);

    process.env.EVIDENCE_PROCESSOR_BROKER = '1';
    const noPack = harness();
    expect((await noPack.service.upload(COMPANY, blob(), input())).dispatched).toBe(false);
    expect(noPack.dispatches).toHaveLength(0);
  });
});
