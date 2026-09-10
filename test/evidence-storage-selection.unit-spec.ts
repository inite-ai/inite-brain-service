/**
 * Store SELECTION and its configuration — the pure half of the
 * multi-replica fix (the byte-level adapter contract is exercised against
 * a real MinIO in evidence-storage-adapter-contract.e2e-spec.ts).
 *
 * The finding: only the fs adapter was ever registered, so evidence blobs
 * lived on the local disk of whichever replica took the upload and every
 * other replica answered a bare 404. These specs pin the seam that ends
 * that — which adapter uploads resolve to, what refuses at boot, and the
 * readiness/probe verdicts an operator sees when the selected store is
 * missing or unreachable.
 */
import { Logger } from '@nestjs/common';
import {
  evidenceS3Config,
  evidenceStorageScheme,
  validateEvidenceStorageEnv,
} from '../src/common/evidence-flags';
import { HealthService } from '../src/common/health.service';
import { CapabilityProbeService } from '../src/metrics/capability-probe.service';
import { MetricsService } from '../src/metrics/metrics.service';
import { FsEvidenceStorageAdapter } from '../src/evidence/storage/fs-storage.adapter';
import { parseS3StorageRef } from '../src/evidence/storage/s3-storage.adapter';
import type {
  EvidenceStorageAdapter,
  EvidenceStorageRegistry,
} from '../src/evidence/storage/storage-adapter';

const S3_KEYS = [
  'EVIDENCE_STORAGE_SCHEME',
  'EVIDENCE_S3_BUCKET',
  'EVIDENCE_S3_ENDPOINT',
  'EVIDENCE_S3_REGION',
  'EVIDENCE_S3_PREFIX',
  'EVIDENCE_S3_ACCESS_KEY_ID',
  'EVIDENCE_S3_SECRET_ACCESS_KEY',
  'EVIDENCE_S3_FORCE_PATH_STYLE',
  'EVIDENCE_FS_ROOT',
  'PROCESS_ROLE',
] as const;

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const k of S3_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of S3_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const HASH = 'a'.repeat(64);

describe('EVIDENCE_STORAGE_SCHEME — which store takes new uploads', () => {
  it('defaults to fs, so an untouched deployment keeps writing where it always did', () => {
    expect(evidenceStorageScheme()).toBe('fs');
  });

  it('selects s3 case- and whitespace-insensitively', () => {
    process.env.EVIDENCE_STORAGE_SCHEME = ' S3 ';
    expect(evidenceStorageScheme()).toBe('s3');
  });

  it('reads as fs for anything else — and boot refuses that value separately', () => {
    process.env.EVIDENCE_STORAGE_SCHEME = 'gcs';
    expect(evidenceStorageScheme()).toBe('fs');
    const errors: string[] = [];
    validateEvidenceStorageEnv(process.env, errors);
    expect(errors.join('\n')).toContain('EVIDENCE_STORAGE_SCHEME must be one of fs/s3');
  });

  it('is read per call, so a flip needs no restart', () => {
    expect(evidenceStorageScheme()).toBe('fs');
    process.env.EVIDENCE_STORAGE_SCHEME = 's3';
    expect(evidenceStorageScheme()).toBe('s3');
  });
});

describe('EVIDENCE_S3_* configuration', () => {
  it('is null while the bucket is unset — the adapter then does not register at all', () => {
    process.env.EVIDENCE_S3_REGION = 'eu-central-1';
    expect(evidenceS3Config()).toBeNull();
  });

  it('defaults region to us-east-1 and takes the SDK credential chain when no keys are given', () => {
    process.env.EVIDENCE_S3_BUCKET = 'brain-evidence';
    expect(evidenceS3Config()).toEqual({
      bucket: 'brain-evidence',
      region: 'us-east-1',
      endpoint: null,
      prefix: '',
      credentials: null,
      forcePathStyle: false,
    });
  });

  it('strips surrounding slashes from the prefix and carries the credential pair', () => {
    process.env.EVIDENCE_S3_BUCKET = 'brain-evidence';
    process.env.EVIDENCE_S3_PREFIX = '/preprod/blobs/';
    process.env.EVIDENCE_S3_ENDPOINT = 'http://minio:9000';
    process.env.EVIDENCE_S3_ACCESS_KEY_ID = 'key';
    process.env.EVIDENCE_S3_SECRET_ACCESS_KEY = 'secret';
    process.env.EVIDENCE_S3_FORCE_PATH_STYLE = '1';
    expect(evidenceS3Config()).toEqual({
      bucket: 'brain-evidence',
      region: 'us-east-1',
      endpoint: 'http://minio:9000',
      prefix: 'preprod/blobs',
      credentials: { accessKeyId: 'key', secretAccessKey: 'secret' },
      forcePathStyle: true,
    });
  });
});

describe('boot validation', () => {
  function errorsFor(env: Record<string, string>): string {
    const errors: string[] = [];
    validateEvidenceStorageEnv(env as NodeJS.ProcessEnv, errors);
    return errors.join('\n');
  }

  it('accepts the untouched deployment (nothing set at all)', () => {
    expect(errorsFor({})).toBe('');
  });

  it('refuses s3 without a bucket — every upload would answer 503', () => {
    expect(errorsFor({ EVIDENCE_STORAGE_SCHEME: 's3' })).toContain(
      'EVIDENCE_STORAGE_SCHEME=s3 requires EVIDENCE_S3_BUCKET',
    );
  });

  it('refuses a bucket name S3 could not accept', () => {
    expect(errorsFor({ EVIDENCE_S3_BUCKET: 'Not_A_Bucket' })).toContain(
      'EVIDENCE_S3_BUCKET must be an S3 bucket name',
    );
  });

  it('refuses an endpoint that is not an http(s) URL', () => {
    expect(errorsFor({ EVIDENCE_S3_BUCKET: 'b-1', EVIDENCE_S3_ENDPOINT: 'minio:9000' })).toContain(
      'EVIDENCE_S3_ENDPOINT must be an http(s) URL',
    );
  });

  it('refuses half a credential pair — the other half silently falling back is the trap', () => {
    expect(errorsFor({ EVIDENCE_S3_BUCKET: 'b-1', EVIDENCE_S3_ACCESS_KEY_ID: 'key' })).toContain(
      'must be set together',
    );
    expect(
      errorsFor({
        EVIDENCE_S3_BUCKET: 'b-1',
        EVIDENCE_S3_ACCESS_KEY_ID: 'key',
        EVIDENCE_S3_SECRET_ACCESS_KEY: 'secret',
      }),
    ).toBe('');
  });
});

describe('s3 storageRef grammar', () => {
  it('accepts a tenant + 64-hex content address and nothing else', () => {
    expect(parseS3StorageRef(`s3://co_acme/${HASH}`)).toEqual({
      companyId: 'co_acme',
      byteHash: HASH,
    });
    expect(parseS3StorageRef(`fs://co_acme/${HASH}`)).toBeNull();
    expect(parseS3StorageRef(`s3://co_acme/${HASH}/extra`)).toBeNull();
    expect(parseS3StorageRef(`s3://../${HASH}`)).toBeNull();
    expect(parseS3StorageRef(`s3://co_acme/${HASH.toUpperCase()}`)).toBeNull();
    expect(parseS3StorageRef('s3://co_acme/short')).toBeNull();
  });
});

describe('readiness gates on the SELECTED store', () => {
  const surreal = {
    ping: async () => true,
    scopedPoolEnabled: () => true,
    pingScoped: async () => true,
  } as never;
  const embedder = {
    isReady: () => true,
    warmupStatus: () => ({ ready: true, failures: 0, inFlight: false }),
  } as never;

  const adapter = (probe?: () => Promise<void>): EvidenceStorageAdapter =>
    ({ scheme: 's3', ...(probe ? { probe } : {}) }) as unknown as EvidenceStorageAdapter;

  it('is vacuously ok on fs — local disk has nothing remote to ask', async () => {
    const fs = { scheme: 'fs' } as unknown as EvidenceStorageAdapter;
    const r = await new HealthService(surreal, embedder, new Map([['fs', fs]])).readiness();
    expect(r.evidenceStoreOk).toBe(true);
    expect(r.ready).toBe(true);
    expect(r.detail.evidenceStore).toEqual({
      scheme: 'fs',
      probed: false,
      latencyMs: 0,
      error: null,
    });
  });

  it('is vacuous in a process with no storage registry wired at all', async () => {
    const r = await new HealthService(surreal, embedder).readiness();
    expect(r.evidenceStoreOk).toBe(true);
    expect(r.detail.evidenceStore).toMatchObject({ probed: false, error: null });
  });

  it('is NOT ready when the selected scheme has no adapter registered', async () => {
    process.env.EVIDENCE_STORAGE_SCHEME = 's3';
    const r = await new HealthService(surreal, embedder, new Map()).readiness();
    expect(r.evidenceStoreOk).toBe(false);
    expect(r.ready).toBe(false);
    expect(r.detail.evidenceStore.error).toContain("no 's3' evidence storage adapter");
  });

  it('reports the probe’s own message when the store refuses', async () => {
    process.env.EVIDENCE_STORAGE_SCHEME = 's3';
    const registry = new Map([
      [
        's3',
        adapter(() => Promise.reject(new Error('HTTP 403: the credentials do not authorize'))),
      ],
    ]);
    const r = await new HealthService(surreal, embedder, registry).readiness();
    expect(r.ready).toBe(false);
    expect(r.detail.evidenceStore).toMatchObject({ scheme: 's3', probed: true });
    expect(r.detail.evidenceStore.error).toContain('do not authorize');
  });

  it('goes green — and says it probed — when the bucket answers', async () => {
    process.env.EVIDENCE_STORAGE_SCHEME = 's3';
    const registry = new Map([['s3', adapter(() => Promise.resolve())]]);
    const r = await new HealthService(surreal, embedder, registry).readiness();
    expect(r.evidenceStoreOk).toBe(true);
    expect(r.ready).toBe(true);
    expect(r.detail.evidenceStore).toMatchObject({ scheme: 's3', probed: true, error: null });
  });

  it('does not hold /ready open on a wedged endpoint', async () => {
    process.env.EVIDENCE_STORAGE_SCHEME = 's3';
    jest.useFakeTimers();
    try {
      const registry = new Map([['s3', adapter(() => new Promise<void>(() => {}))]]);
      const pending = new HealthService(surreal, embedder, registry).readiness();
      await jest.advanceTimersByTimeAsync(6_000);
      const r = await pending;
      expect(r.ready).toBe(false);
      expect(r.detail.evidenceStore.error).toContain('timed out');
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('the store is exercised continuously, not only at deploy time', () => {
  function probe(registry?: EvidenceStorageRegistry): CapabilityProbeService {
    return new CapabilityProbeService(
      { withScopedCompany: jest.fn().mockResolvedValue([[]]) } as never,
      { fanOutRoster: () => ['acme'] } as never,
      new MetricsService(),
      undefined,
      registry,
    );
  }

  async function evidenceStoreReport(registry?: EvidenceStorageRegistry) {
    const reports = await probe(registry).runOnce();
    return reports.find((r) => r.capability === 'evidence_store')!;
  }

  it('reports skipped on fs rather than a green that proves nothing', async () => {
    const fs = { scheme: 'fs' } as unknown as EvidenceStorageAdapter;
    expect(await evidenceStoreReport(new Map([['fs', fs]]))).toMatchObject({
      outcome: 'skipped',
    });
  });

  it('classifies a 403 from the object store as unauthorized, not as a dead store', async () => {
    process.env.EVIDENCE_STORAGE_SCHEME = 's3';
    const s3 = {
      scheme: 's3',
      probe: () =>
        Promise.reject(
          new Error(
            "bucket 'b' at http://minio:9000 — the credentials do not authorize this bucket",
          ),
        ),
    } as unknown as EvidenceStorageAdapter;
    expect(await evidenceStoreReport(new Map([['s3', s3]]))).toMatchObject({
      outcome: 'unauthorized',
    });
  });

  it('is a conclusive error when the selected scheme is not registered', async () => {
    process.env.EVIDENCE_STORAGE_SCHEME = 's3';
    expect(await evidenceStoreReport(new Map())).toMatchObject({ outcome: 'error' });
  });

  it('serves when the bucket answers', async () => {
    process.env.EVIDENCE_STORAGE_SCHEME = 's3';
    const s3 = {
      scheme: 's3',
      probe: () => Promise.resolve(),
    } as unknown as EvidenceStorageAdapter;
    expect(await evidenceStoreReport(new Map([['s3', s3]]))).toMatchObject({
      outcome: 'serving',
    });
  });
});

describe('the fs adapter says out loud that it is local disk', () => {
  function warnings(): string[] {
    const captured: string[] = [];
    const spy = jest.spyOn(Logger.prototype, 'warn').mockImplementation((m) => {
      captured.push(String(m));
    });
    try {
      new FsEvidenceStorageAdapter().onApplicationBootstrap();
    } finally {
      spy.mockRestore();
    }
    return captured;
  }

  it('warns once on a split-role deployment, which is more than one process by definition', () => {
    process.env.EVIDENCE_FS_ROOT = '/var/lib/brain/evidence';
    process.env.PROCESS_ROLE = 'worker';
    const lines = warnings();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('local disk');
    expect(lines[0]).toContain('EVIDENCE_STORAGE_SCHEME=s3');
  });

  it('stays silent on the single-process default and when s3 is the selected store', () => {
    process.env.EVIDENCE_FS_ROOT = '/var/lib/brain/evidence';
    expect(warnings()).toEqual([]);
    process.env.PROCESS_ROLE = 'api';
    process.env.EVIDENCE_STORAGE_SCHEME = 's3';
    expect(warnings()).toEqual([]);
  });

  it('stays silent when the adapter is not configured at all', () => {
    process.env.PROCESS_ROLE = 'api';
    expect(warnings()).toEqual([]);
  });
});
