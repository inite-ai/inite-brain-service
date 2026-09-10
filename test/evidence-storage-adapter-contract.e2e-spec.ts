/**
 * ONE contract, both stores. Every assertion below is run twice — once
 * against the local-disk adapter and once against a real S3-compatible
 * server (MinIO in a pinned container) — because the whole value of the
 * scheme registry is that consumers cannot tell which adapter they got.
 * A semantic that holds for fs and not for s3 is a bug that would only
 * surface in production, on the pod that did not take the upload.
 *
 * The last describe is the finding itself: with per-pod roots the fs
 * adapter answers `head() → null` for a blob a sibling replica holds
 * (which the read path turns into a bare 404), while two independent s3
 * adapter instances over one bucket serve each other's bytes.
 *
 * Nothing here reaches the network beyond pulling the pinned image.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { FsEvidenceStorageAdapter } from '../src/evidence/storage/fs-storage.adapter';
import { S3EvidenceStorageAdapter } from '../src/evidence/storage/s3-storage.adapter';
import type { EvidenceStorageAdapter } from '../src/evidence/storage/storage-adapter';

// Pinned: an object store's compatibility surface is exactly what this
// suite is measuring, so `latest` would make a green run unrepeatable.
const MINIO_IMAGE = 'minio/minio:RELEASE.2025-01-20T14-49-07Z';
const ACCESS_KEY = 'minioadmin';
const SECRET_KEY = 'minioadmin';
const BUCKET = 'brain-evidence-contract';
const PREFIX = 'contract';

let minio: StartedTestContainer | undefined;
let endpoint = '';
let fsRoot = '';
const savedEnv: Record<string, string | undefined> = {};

const ENV_KEYS = [
  'EVIDENCE_FS_ROOT',
  'EVIDENCE_STORAGE_SCHEME',
  'EVIDENCE_S3_BUCKET',
  'EVIDENCE_S3_ENDPOINT',
  'EVIDENCE_S3_REGION',
  'EVIDENCE_S3_PREFIX',
  'EVIDENCE_S3_ACCESS_KEY_ID',
  'EVIDENCE_S3_SECRET_ACCESS_KEY',
  'EVIDENCE_S3_FORCE_PATH_STYLE',
] as const;

beforeAll(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];

  fsRoot = await mkdtemp(join(tmpdir(), 'evidence-contract-fs-'));
  process.env.EVIDENCE_FS_ROOT = fsRoot;

  minio = await new GenericContainer(MINIO_IMAGE)
    .withEnvironment({ MINIO_ROOT_USER: ACCESS_KEY, MINIO_ROOT_PASSWORD: SECRET_KEY })
    .withCommand(['server', '/data'])
    .withExposedPorts(9000)
    .withWaitStrategy(Wait.forHttp('/minio/health/live', 9000).forStatusCode(200))
    .withStartupTimeout(120_000)
    .start();
  endpoint = `http://${minio.getHost()}:${minio.getMappedPort(9000)}`;

  process.env.EVIDENCE_S3_ENDPOINT = endpoint;
  process.env.EVIDENCE_S3_BUCKET = BUCKET;
  process.env.EVIDENCE_S3_REGION = 'us-east-1';
  process.env.EVIDENCE_S3_PREFIX = PREFIX;
  process.env.EVIDENCE_S3_ACCESS_KEY_ID = ACCESS_KEY;
  process.env.EVIDENCE_S3_SECRET_ACCESS_KEY = SECRET_KEY;
  // MinIO-class hosts have no per-bucket DNS.
  process.env.EVIDENCE_S3_FORCE_PATH_STYLE = '1';

  const client = new S3Client({
    region: 'us-east-1',
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
  });
  await client.send(new CreateBucketCommand({ Bucket: BUCKET }));
  client.destroy();
}, 180_000);

afterAll(async () => {
  if (minio) await minio.stop();
  if (fsRoot) await rm(fsRoot, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

/** A fresh tenant per test, so no case can see another's blobs. */
function tenant(): string {
  return `co_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

const CASES: Array<{ scheme: string; make: () => EvidenceStorageAdapter }> = [
  { scheme: 'fs', make: () => new FsEvidenceStorageAdapter() },
  { scheme: 's3', make: () => new S3EvidenceStorageAdapter() },
];

describe.each(CASES)('evidence storage adapter contract — $scheme', ({ scheme, make }) => {
  let adapter: EvidenceStorageAdapter;
  let company: string;

  beforeEach(() => {
    adapter = make();
    company = tenant();
  });

  const HASH_OF_NOTHING_STORED = 'b'.repeat(64);

  it('put is content-addressed, idempotent, and reports the length', async () => {
    const bytes = Buffer.from('one contract, two stores', 'utf8');
    const hash = sha256(bytes);
    const first = await adapter.put(company, hash, bytes);
    expect(first).toEqual({
      storageRef: `${scheme}://${company}/${hash}`,
      byteLength: bytes.byteLength,
    });
    // Re-putting identical bytes lands on the same ref and is a no-op.
    expect(await adapter.put(company, hash, bytes)).toEqual(first);
    expect(await adapter.head(first.storageRef)).toEqual({ byteLength: bytes.byteLength });
    expect(await adapter.exists(first.storageRef)).toBe(true);
  });

  it('put refuses bytes whose hash the caller got wrong, and a hostile tenant id', async () => {
    const bytes = Buffer.from('payload', 'utf8');
    await expect(adapter.put(company, HASH_OF_NOTHING_STORED, bytes)).rejects.toThrow(
      /byteHash does not match/,
    );
    await expect(adapter.put('../escape', sha256(bytes), bytes)).rejects.toThrow(/invalid/);
    await expect(adapter.put(company, 'not-a-hash', bytes)).rejects.toThrow(/invalid/);
  });

  it('head and exists answer absence rather than throwing', async () => {
    const ref = `${scheme}://${company}/${HASH_OF_NOTHING_STORED}`;
    expect(await adapter.head(ref)).toBeNull();
    expect(await adapter.exists(ref)).toBe(false);
  });

  it('get streams the exact bytes back — a large blob is never materialised twice', async () => {
    // Bigger than a single default chunk, so the read really is a stream.
    const bytes = randomBytes(5 * 1024 * 1024);
    const hash = sha256(bytes);
    const { storageRef } = await adapter.put(company, hash, bytes);
    const stream = await adapter.get(storageRef);
    const readBack = await collect(stream);
    expect(readBack.byteLength).toBe(bytes.byteLength);
    expect(sha256(readBack)).toBe(hash);
  });

  it('get rejects for a blob that is not there, and for a malformed ref', async () => {
    await expect(adapter.get(`${scheme}://${company}/${HASH_OF_NOTHING_STORED}`)).rejects.toThrow();
    await expect(adapter.get(`${scheme}://${company}/nope`)).rejects.toThrow();
    await expect(adapter.head(`${scheme}://${company}/nope`)).rejects.toThrow();
  });

  it('delete reports honestly whether a blob existed', async () => {
    const bytes = Buffer.from('to be erased', 'utf8');
    const { storageRef } = await adapter.put(company, sha256(bytes), bytes);
    expect(await adapter.delete(storageRef)).toBe(true);
    expect(await adapter.head(storageRef)).toBeNull();
    // The GDPR cascade and the sweeps log these counts, so the second
    // answer must be false, not a throw and not another true.
    expect(await adapter.delete(storageRef)).toBe(false);
  });

  it('belongsToTenant is structural — another tenant’s ref and a malformed one are refused', async () => {
    const other = tenant();
    expect(
      adapter.belongsToTenant(company, `${scheme}://${company}/${HASH_OF_NOTHING_STORED}`),
    ).toBe(true);
    expect(adapter.belongsToTenant(company, `${scheme}://${other}/${HASH_OF_NOTHING_STORED}`)).toBe(
      false,
    );
    expect(adapter.belongsToTenant(company, `${scheme}://${company}/short`)).toBe(false);
    expect(adapter.belongsToTenant(company, 'nonsense')).toBe(false);
  });

  it('listBlobs yields this tenant’s blobs with size and write time, and nobody else’s', async () => {
    const other = make();
    const otherCompany = tenant();
    const mine = Buffer.from('mine', 'utf8');
    const theirs = Buffer.from('theirs', 'utf8');
    const before = Date.now();
    const put = await adapter.put(company, sha256(mine), mine);
    await other.put(otherCompany, sha256(theirs), theirs);

    const entries = [];
    for await (const entry of adapter.listBlobs!(company)) entries.push(entry);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.storageRef).toBe(put.storageRef);
    expect(entries[0]!.byteLength).toBe(mine.byteLength);
    // The write time, so the orphan sweep's grace window protects an
    // upload whose row does not exist yet. Allow a second of clock skew
    // between this process and the store.
    expect(entries[0]!.modifiedAtMs).toBeGreaterThanOrEqual(before - 1_000);
    expect(entries[0]!.modifiedAtMs).toBeLessThanOrEqual(Date.now() + 1_000);
    // Every yielded ref satisfies the sweep's fence by construction.
    for (const entry of entries) {
      expect(adapter.belongsToTenant(company, entry.storageRef)).toBe(true);
    }
  });

  it('listBlobs is an empty iteration for a tenant that never uploaded', async () => {
    const entries = [];
    for await (const entry of adapter.listBlobs!(tenant())) entries.push(entry);
    expect(entries).toEqual([]);
  });

  it('the partial-write broom never touches a complete blob', async () => {
    const bytes = Buffer.from('complete', 'utf8');
    const { storageRef } = await adapter.put(company, sha256(bytes), bytes);
    const swept = await adapter.sweepIncompleteWrites!(company, {
      olderThanMs: 0,
      dryRun: false,
    });
    expect(swept.removed).toBe(0);
    expect(await adapter.head(storageRef)).not.toBeNull();
  });
});

describe('the fs adapter only holds together on one disk', () => {
  it('a blob written on one replica’s root is absent on another’s — the 404 the finding describes', async () => {
    const podA = await mkdtemp(join(tmpdir(), 'evidence-pod-a-'));
    const podB = await mkdtemp(join(tmpdir(), 'evidence-pod-b-'));
    const company = tenant();
    const bytes = Buffer.from('uploaded through pod A', 'utf8');
    try {
      // The root is read per call, so pointing it at a second pod's
      // volume is exactly what a sibling replica sees.
      process.env.EVIDENCE_FS_ROOT = podA;
      const a = new FsEvidenceStorageAdapter();
      const { storageRef } = await a.put(company, sha256(bytes), bytes);
      expect(await a.head(storageRef)).not.toBeNull();

      process.env.EVIDENCE_FS_ROOT = podB;
      const b = new FsEvidenceStorageAdapter();
      expect(await b.head(storageRef)).toBeNull();
      expect(await b.exists(storageRef)).toBe(false);
      // And the leader-elected orphan sweep would only ever see its own.
      const seen = [];
      for await (const entry of b.listBlobs!(company)) seen.push(entry);
      expect(seen).toEqual([]);
    } finally {
      process.env.EVIDENCE_FS_ROOT = fsRoot;
      await rm(podA, { recursive: true, force: true });
      await rm(podB, { recursive: true, force: true });
    }
  });

  it('a shared volume is the other correct fs deployment', async () => {
    const shared = await mkdtemp(join(tmpdir(), 'evidence-shared-'));
    const company = tenant();
    const bytes = Buffer.from('one volume, two pods', 'utf8');
    try {
      process.env.EVIDENCE_FS_ROOT = shared;
      const a = new FsEvidenceStorageAdapter();
      const b = new FsEvidenceStorageAdapter();
      const { storageRef } = await a.put(company, sha256(bytes), bytes);
      expect(await b.head(storageRef)).toEqual({ byteLength: bytes.byteLength });
    } finally {
      process.env.EVIDENCE_FS_ROOT = fsRoot;
      await rm(shared, { recursive: true, force: true });
    }
  });
});

describe('the object store crosses the replica boundary', () => {
  it('a blob written through one adapter instance is served by a second over the same bucket', async () => {
    // Two instances, each with its own S3 client — the closest a test
    // gets to two pods behind a round-robin balancer.
    const podA = new S3EvidenceStorageAdapter();
    const podB = new S3EvidenceStorageAdapter();
    const company = tenant();
    const bytes = randomBytes(2 * 1024 * 1024);
    const hash = sha256(bytes);

    const { storageRef } = await podA.put(company, hash, bytes);
    expect(await podB.head(storageRef)).toEqual({ byteLength: bytes.byteLength });
    expect(sha256(await collect(await podB.get(storageRef)))).toBe(hash);

    // The sweep runs on whichever pod holds the lease, and sees the
    // shared store rather than one pod's disk.
    const seen = [];
    for await (const entry of podB.listBlobs!(company)) seen.push(entry.storageRef);
    expect(seen).toEqual([storageRef]);

    // A delete on either pod is a delete for both.
    expect(await podB.delete(storageRef)).toBe(true);
    expect(await podA.head(storageRef)).toBeNull();
  });

  it('the readiness probe passes against the live bucket and names the problem when it cannot', async () => {
    await expect(new S3EvidenceStorageAdapter().probe!()).resolves.toBeUndefined();

    const savedBucket = process.env.EVIDENCE_S3_BUCKET;
    process.env.EVIDENCE_S3_BUCKET = 'brain-evidence-does-not-exist';
    try {
      await expect(new S3EvidenceStorageAdapter().probe!()).rejects.toThrow(
        /evidence s3 store is not serving: bucket 'brain-evidence-does-not-exist'/,
      );
    } finally {
      process.env.EVIDENCE_S3_BUCKET = savedBucket;
    }
  });

  it('the prefix namespaces the keys without appearing in any ref', async () => {
    const company = tenant();
    const bytes = Buffer.from('prefixed', 'utf8');
    const hash = sha256(bytes);
    const { storageRef } = await new S3EvidenceStorageAdapter().put(company, hash, bytes);
    // The ref carries tenant + hash only, so relocating the store is
    // configuration and never a row rewrite.
    expect(storageRef).toBe(`s3://${company}/${hash}`);

    // Under a different prefix the same ref addresses nothing — and the
    // bytes are still there under the original one.
    process.env.EVIDENCE_S3_PREFIX = 'somewhere-else';
    try {
      expect(await new S3EvidenceStorageAdapter().head(storageRef)).toBeNull();
    } finally {
      process.env.EVIDENCE_S3_PREFIX = PREFIX;
    }
    expect(await new S3EvidenceStorageAdapter().head(storageRef)).not.toBeNull();
  });

  it('an unconfigured bucket is a loud error, never a default one', async () => {
    const savedBucket = process.env.EVIDENCE_S3_BUCKET;
    delete process.env.EVIDENCE_S3_BUCKET;
    try {
      await expect(
        new S3EvidenceStorageAdapter().head(`s3://${tenant()}/${'c'.repeat(64)}`),
      ).rejects.toThrow(/EVIDENCE_S3_BUCKET is not set/);
    } finally {
      process.env.EVIDENCE_S3_BUCKET = savedBucket;
    }
  });
});

/** Keeps the fs branch honest about tmp debris, which s3 cannot have. */
describe('the fs partial-write broom', () => {
  it('removes a straggler left by a process killed between write and rename', async () => {
    const company = tenant();
    const adapter = new FsEvidenceStorageAdapter();
    const bytes = Buffer.from('debris', 'utf8');
    const hash = sha256(bytes);
    await adapter.put(company, hash, bytes);
    const shard = join(fsRoot, company, hash.slice(0, 2));
    const straggler = join(shard, `.tmp-${randomUUID()}`);
    await writeFile(straggler, 'half a blob');
    // Aged past the grace window: a tmp file written seconds ago may be
    // an upload writing right now, and the broom must leave it alone.
    const anHourAgo = new Date(Date.now() - 3_600_000);
    await utimes(straggler, anHourAgo, anHourAgo);

    const grace = { olderThanMs: 60_000 };
    const dry = await adapter.sweepIncompleteWrites!(company, { ...grace, dryRun: true });
    expect(dry).toEqual({ found: 1, removed: 0 });
    const wet = await adapter.sweepIncompleteWrites!(company, { ...grace, dryRun: false });
    expect(wet).toEqual({ found: 1, removed: 1 });
    // The complete blob is untouched, and no ref ever addressed the debris.
    expect(await adapter.head(`fs://${company}/${hash}`)).not.toBeNull();
  });
});
