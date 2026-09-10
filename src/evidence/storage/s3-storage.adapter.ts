import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import {
  AbortMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import {
  evidenceS3Config,
  evidenceStorageScheme,
  type EvidenceS3Config,
} from '../../common/evidence-flags';
import { HASH_RE, TENANT_RE, parseContentRef, type ParsedContentRef } from './content-ref';
import { EvidenceStorageAdapter, StoredBlobEntry } from './storage-adapter';

/** Wall-clock bound on the readiness probe's single round trip. */
const PROBE_TIMEOUT_MS = 10_000;

/** Parse + validate an `s3://<companyId>/<byteHash>` storageRef (content-ref grammar). */
export function parseS3StorageRef(storageRef: string): ParsedContentRef | null {
  return parseContentRef('s3', storageRef);
}

interface Bound {
  client: S3Client;
  config: EvidenceS3Config;
}

/**
 * S3EvidenceStorageAdapter — the shared blob store for N replicas: one
 * bucket every pod reads and writes, object key
 * `<EVIDENCE_S3_PREFIX>/<companyId>/<byteHash>`. storageRef is
 * `s3://<companyId>/<byteHash>` — bucket, prefix and endpoint are NOT
 * part of the ref (the fs adapter's rule), so an operator moves the
 * store by changing configuration, never by rewriting rows. Same
 * tenant/hash grammar as fs (content-ref.ts), so the tenant fence the
 * store service and the orphan sweep lean on is identical.
 *
 * Semantics mirror the fs adapter point for point: put() is
 * content-addressed and idempotent (a HEAD first, then ONE PutObject —
 * S3 commits an object atomically, so there is no temp-then-rename and
 * no half-written blob is ever visible); head()/exists() answer null /
 * false on a missing key; delete() reports whether a key existed; get()
 * hands back the response body stream, so a large blob is never
 * materialised. listBlobs pages ListObjectsV2 under the tenant prefix
 * and yields only well-formed content addresses; sweepIncompleteWrites
 * aborts abandoned multipart uploads under the same prefix (this adapter
 * never starts one, but a bucket shared with other writers may hold
 * them). The client is built from EVIDENCE_S3_* on first use and kept —
 * a live change of those keys is not picked up (restart). Bucket unset
 * ⇒ every method throws the clear unconfigured error.
 *
 * Checksums are sent only WHEN_REQUIRED: the SDK's default of a CRC32
 * trailer on every PUT is refused by several S3-compatible stores, and
 * integrity is already pinned by the content address (put() verifies
 * the sha256 before sending).
 */
@Injectable()
export class S3EvidenceStorageAdapter implements EvidenceStorageAdapter, OnApplicationBootstrap {
  readonly scheme = 's3';
  private readonly logger = new Logger(S3EvidenceStorageAdapter.name);
  private bound: Bound | undefined;

  /**
   * One boot-time line when this is the selected store — the probe's
   * verdict, so a misconfigured bucket is in the log before the first
   * /ready poll. Fire-and-forget: boot never waits on S3; readiness is
   * the gate.
   */
  onApplicationBootstrap(): void {
    if (evidenceStorageScheme() !== 's3') return;
    void this.probe().then(
      () => {
        const { config } = this.bind();
        this.logger.log(`evidence s3 store serving: bucket '${config.bucket}' at ${where(config)}`);
      },
      (e: unknown) => this.logger.error((e as Error).message),
    );
  }

  /** Bound client + config, or a loud error — never a default bucket. */
  private bind(): Bound {
    if (this.bound) return this.bound;
    const config = evidenceS3Config();
    if (!config) {
      throw new Error(
        'EVIDENCE_S3_BUCKET is not set — the s3 evidence storage adapter is ' +
          'unconfigured. Set EVIDENCE_S3_BUCKET (plus EVIDENCE_S3_ENDPOINT / ' +
          'EVIDENCE_S3_REGION / credentials as the store requires).',
      );
    }
    const client = new S3Client({
      region: config.region,
      ...(config.endpoint !== null ? { endpoint: config.endpoint } : {}),
      ...(config.credentials !== null ? { credentials: config.credentials } : {}),
      forcePathStyle: config.forcePathStyle,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
    this.bound = { client, config };
    return this.bound;
  }

  /** Client + bucket + key for a validated ref; throws on a malformed ref. */
  private locate(storageRef: string): { client: S3Client; bucket: string; key: string } {
    const parsed = parseS3StorageRef(storageRef);
    if (!parsed) throw new Error(`malformed s3 storageRef: ${storageRef}`);
    const { client, config } = this.bind();
    return {
      client,
      bucket: config.bucket,
      key: `${tenantPrefix(config, parsed.companyId)}${parsed.byteHash}`,
    };
  }

  async put(
    companyId: string,
    byteHash: string,
    data: Buffer,
  ): Promise<{ storageRef: string; byteLength: number }> {
    if (!TENANT_RE.test(companyId)) throw new Error(`invalid companyId for s3 put: ${companyId}`);
    if (!HASH_RE.test(byteHash)) throw new Error(`invalid byteHash for s3 put: ${byteHash}`);
    const actualHash = createHash('sha256').update(data).digest('hex');
    if (actualHash !== byteHash) {
      throw new Error(`byteHash does not match the supplied bytes`);
    }
    const storageRef = `s3://${companyId}/${byteHash}`;
    const existing = await this.head(storageRef);
    if (existing) return { storageRef, byteLength: existing.byteLength }; // content-addressed no-op
    const { client, bucket, key } = this.locate(storageRef);
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: data,
        ContentLength: data.byteLength,
        ContentType: 'application/octet-stream',
      }),
    );
    return { storageRef, byteLength: data.byteLength };
  }

  belongsToTenant(companyId: string, storageRef: string): boolean {
    return parseS3StorageRef(storageRef)?.companyId === companyId;
  }

  async get(storageRef: string): Promise<Readable> {
    const { client, bucket, key } = this.locate(storageRef);
    let body: unknown;
    try {
      body = (await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))).Body;
    } catch (e) {
      if (isMissing(e)) throw new Error(`s3 blob not found: ${storageRef}`);
      throw e;
    }
    if (!isReadable(body))
      throw new Error(`s3 GetObject returned no byte stream for ${storageRef}`);
    return body;
  }

  async head(storageRef: string): Promise<{ byteLength: number } | null> {
    const { client, bucket, key } = this.locate(storageRef);
    try {
      const out = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return { byteLength: out.ContentLength ?? 0 };
    } catch (e) {
      if (isMissing(e)) return null;
      throw e;
    }
  }

  async exists(storageRef: string): Promise<boolean> {
    return (await this.head(storageRef)) !== null;
  }

  /**
   * DeleteObject answers 204 whether or not the key existed, so the HEAD
   * first is what makes the boolean honest (the GDPR cascade and the
   * sweeps log real counts). A blob that vanishes between the two calls
   * is reported as deleted — the outcome the caller wanted anyway.
   */
  async delete(storageRef: string): Promise<boolean> {
    const { client, bucket, key } = this.locate(storageRef);
    if ((await this.head(storageRef)) === null) return false;
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  }

  /**
   * Enumerate one tenant's blobs — the orphan-GC contract in
   * storage-adapter.ts. Pages ListObjectsV2 under `<prefix>/<companyId>/`
   * and yields ONLY keys whose remainder is a well-formed 64-hex content
   * address: anything else under the prefix is not a blob this adapter
   * wrote and is never offered to a deleter. Every yielded ref is
   * `s3://<companyId>/<hash>`, so belongsToTenant holds by construction;
   * a tenant with no objects is an empty iteration.
   */
  async *listBlobs(companyId: string): AsyncGenerator<StoredBlobEntry> {
    if (!TENANT_RE.test(companyId)) return;
    const { client, config } = this.bind();
    const prefix = tenantPrefix(config, companyId);
    let token: string | undefined;
    do {
      const page = await client.send(
        new ListObjectsV2Command({
          Bucket: config.bucket,
          Prefix: prefix,
          ...(token !== undefined ? { ContinuationToken: token } : {}),
        }),
      );
      for (const object of page.Contents ?? []) {
        const name = object.Key?.slice(prefix.length);
        if (name === undefined || !HASH_RE.test(name)) continue;
        yield {
          storageRef: `s3://${companyId}/${name}`,
          byteLength: object.Size ?? 0,
          // LastModified is the PUT that wrote these bytes — the honest
          // write time. A store that omits it reads as written NOW: err
          // younger, per the contract.
          modifiedAtMs: object.LastModified?.getTime() ?? Date.now(),
        };
      }
      token = page.IsTruncated === true ? page.NextContinuationToken : undefined;
    } while (token !== undefined);
  }

  /**
   * Abort multipart uploads under this tenant's prefix that were started
   * before the cutoff — the object-store shape of the fs adapter's
   * `.tmp-…` stragglers: parts a writer paid for and never completed,
   * addressable by no ref, invisible to listBlobs. `dryRun` counts
   * without aborting; per-upload failures are swallowed and rediscovered
   * next run.
   */
  async sweepIncompleteWrites(
    companyId: string,
    opts: { olderThanMs: number; dryRun: boolean },
  ): Promise<{ found: number; removed: number }> {
    if (!TENANT_RE.test(companyId)) return { found: 0, removed: 0 };
    const { client, config } = this.bind();
    const prefix = tenantPrefix(config, companyId);
    const cutoff = Date.now() - Math.max(0, opts.olderThanMs);
    let found = 0;
    let removed = 0;
    let keyMarker: string | undefined;
    let uploadIdMarker: string | undefined;
    do {
      const page = await client.send(
        new ListMultipartUploadsCommand({
          Bucket: config.bucket,
          Prefix: prefix,
          ...(keyMarker !== undefined ? { KeyMarker: keyMarker } : {}),
          ...(uploadIdMarker !== undefined ? { UploadIdMarker: uploadIdMarker } : {}),
        }),
      );
      for (const upload of page.Uploads ?? []) {
        if (upload.Key === undefined || upload.UploadId === undefined) continue;
        if ((upload.Initiated?.getTime() ?? Date.now()) > cutoff) continue;
        found++;
        if (opts.dryRun) continue;
        try {
          await client.send(
            new AbortMultipartUploadCommand({
              Bucket: config.bucket,
              Key: upload.Key,
              UploadId: upload.UploadId,
            }),
          );
          removed++;
        } catch {
          // Best effort, like every other delete leg in the substrate.
        }
      }
      keyMarker = page.IsTruncated === true ? page.NextKeyMarker : undefined;
      uploadIdMarker = page.IsTruncated === true ? page.NextUploadIdMarker : undefined;
    } while (keyMarker !== undefined || uploadIdMarker !== undefined);
    return { found, removed };
  }

  /**
   * HeadBucket — reachable, authorized, and the bucket exists; the
   * readiness-contract method. The message names the bucket and endpoint
   * (never a credential) and turns the store's status into the operator's
   * next move.
   */
  async probe(): Promise<void> {
    const { client, config } = this.bind();
    try {
      await client.send(new HeadBucketCommand({ Bucket: config.bucket }), {
        abortSignal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
    } catch (e) {
      throw new Error(
        `evidence s3 store is not serving: bucket '${config.bucket}' at ${where(config)} — ` +
          `${explain(e)}. Check EVIDENCE_S3_BUCKET / EVIDENCE_S3_ENDPOINT / EVIDENCE_S3_REGION ` +
          `and the credentials` +
          (config.forcePathStyle ? '' : ' (MinIO-class hosts need EVIDENCE_S3_FORCE_PATH_STYLE=1)'),
      );
    }
  }

  /** The KMS key S3 reports for the object (SSE-KMS); null for SSE-S3 / none. */
  async encryptionContext(storageRef: string): Promise<{ kmsKeyRef: string } | null> {
    const { client, bucket, key } = this.locate(storageRef);
    try {
      const out = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return out.SSEKMSKeyId ? { kmsKeyRef: out.SSEKMSKeyId } : null;
    } catch (e) {
      if (isMissing(e)) return null;
      throw e;
    }
  }

  /** Explicit null: raw serving stays in-process behind the gate ladder
   *  (raw-evidence-gate.ts); a presigned bucket URL would hand out bytes
   *  the per-call gate never saw. null = unsupported, callers must not
   *  fall back to a raw path. */
  signedGetUrl(_storageRef: string, _ttlSeconds: number): Promise<string | null> {
    return Promise.resolve(null);
  }
}

/** `<prefix>/<companyId>/` — the key namespace one tenant's blobs live under. */
function tenantPrefix(config: EvidenceS3Config, companyId: string): string {
  return config.prefix ? `${config.prefix}/${companyId}/` : `${companyId}/`;
}

function where(config: EvidenceS3Config): string {
  return config.endpoint ?? `the AWS endpoint for region '${config.region}'`;
}

/**
 * "This key is not here" — HeadObject answers `NotFound`, GetObject
 * `NoSuchKey`, and the status covers stores that name it differently. A
 * MISSING BUCKET is deliberately excluded even though it is also a 404:
 * head() must not report a whole misconfigured store as one absent blob,
 * which is exactly the silent 404 this adapter exists to end.
 */
function isMissing(e: unknown): boolean {
  if (!(e instanceof S3ServiceException)) return false;
  if (e.name === 'NoSuchBucket') return false;
  return e.name === 'NotFound' || e.name === 'NoSuchKey' || e.$metadata.httpStatusCode === 404;
}

function isReadable(x: unknown): x is Readable {
  return typeof (x as { pipe?: unknown } | null)?.pipe === 'function';
}

/** What the store (or the network) said, as one greppable clause. */
function explain(e: unknown): string {
  if (e instanceof S3ServiceException) {
    const status = e.$metadata.httpStatusCode;
    if (status === 403) return `HTTP 403 ${e.name}: the credentials do not authorize this bucket`;
    if (status === 404) return `HTTP 404 ${e.name}: the bucket does not exist at this endpoint`;
    if (status === 301) return `HTTP 301 ${e.name}: the bucket lives in another region`;
    return `HTTP ${status ?? '?'} ${e.name}: ${e.message}`;
  }
  const err = e as { name?: string; message?: string; code?: string } | null;
  const code = err?.code ? ` ${err.code}` : '';
  return `${err?.name ?? 'Error'}${code}: ${err?.message ?? String(e)}`;
}
