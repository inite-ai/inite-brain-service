import { Injectable } from '@nestjs/common';
import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { assertPublicHttpUrl } from '../../common/egress-guard';
import { sourceEgressAllowPrivate, sourceKindEnabled } from '../../common/source-plane-flags';
import type {
  Connector,
  ConnectorCtx,
  EnumerateOptions,
  FetchedItem,
  ItemDelta,
  ItemDescriptor,
} from '../connector';
import { FS_BINARY_EXTENSIONS, FS_TEXT_EXTENSIONS, looksBinary } from './fs.connector';

/**
 * `s3` — an object bucket (raw-evidence-sources-2026-09.md W1): AWS S3
 * and every S3-compatible store (MinIO, R2, B2, GCS interop) through the
 * SDK the evidence adapter already uses. Items are objects under a
 * prefix; ListObjectsV2 lists everything every run (`walksEverything`),
 * the ETag is the revision, LastModified the source's clock. The same
 * extension rules as the fs connector decide what a document-shaped
 * entry admits (text-like) and what a binary-shaped one does (PDFs,
 * images).
 *
 * Credentials: `credential` is `accessKeyId:secretAccessKey`; absent ⇒
 * the SDK's default provider chain (instance role, env). A custom
 * endpoint passes the egress guard — private endpoints need the double
 * opt-in (SOURCE_EGRESS_ALLOW_PRIVATE + `allowPrivate`).
 */

export interface S3ConnectorConfig {
  bucket: string;
  prefix?: string | undefined;
  region?: string | undefined;
  endpoint?: string | undefined;
  forcePathStyle?: boolean | undefined;
  allowPrivate?: boolean | undefined;
  extensions?: string[] | undefined;
  maxObjects?: number | undefined;
  maxObjectBytes?: number | undefined;
}

const DEFAULT_MAX_OBJECTS = 20_000;
const DEFAULT_MAX_OBJECT_BYTES = 2 * 1024 * 1024;
const HARD_MAX_OBJECT_BYTES = 64 * 1024 * 1024;

const MEDIA_TYPES: Record<string, string> = {
  md: 'text/markdown', txt: 'text/plain', csv: 'text/csv', json: 'application/json',
  yaml: 'text/plain', yml: 'text/plain', html: 'text/html', htm: 'text/html', xml: 'text/xml',
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
};

/** The subset of the SDK client the connector uses — injectable for tests. */
export interface S3ClientLike {
  send(command: ListObjectsV2Command | GetObjectCommand): Promise<unknown>;
}

@Injectable()
export class S3Connector implements Connector {
  readonly kind = 's3';
  readonly walksEverything = true;

  /** Test seam: a factory returning a client for the resolved config. */
  clientFactory: (cfg: S3ConnectorConfig, credential: string | null) => S3ClientLike = defaultClient;

  enabled(): boolean {
    return sourceKindEnabled('s3');
  }

  async *enumerate(ctx: ConnectorCtx, _opts: EnumerateOptions): AsyncIterable<ItemDelta> {
    const cfg = configOf(ctx);
    await guardEndpoint(cfg);
    const client = this.clientFactory(cfg, ctx.connection.credential);
    const extensions = new Set(extensionsFor(ctx, cfg));
    const maxObjects = cfg.maxObjects ?? DEFAULT_MAX_OBJECTS;
    const maxBytes = byteCap(cfg);
    let token: string | undefined;
    let emitted = 0;
    let skippedLarge = 0;
    do {
      if (ctx.signal.aborted) throw new Error('aborted');
      const page = (await client.send(
        new ListObjectsV2Command({
          Bucket: cfg.bucket,
          ...(cfg.prefix ? { Prefix: cfg.prefix } : {}),
          ...(token ? { ContinuationToken: token } : {}),
          MaxKeys: 1000,
        }),
      )) as {
        Contents?: Array<{ Key?: string; ETag?: string; Size?: number; LastModified?: Date }>;
        IsTruncated?: boolean;
        NextContinuationToken?: string;
      };
      for (const obj of page.Contents ?? []) {
        const verdict = admitObject(obj, extensions, maxBytes);
        if (verdict === 'large') skippedLarge++;
        if (verdict !== 'admit') continue;
        emitted++;
        yield { type: 'upsert', item: describeObject(cfg.bucket, obj) };
        if (emitted >= maxObjects) break;
      }
      token = page.IsTruncated && emitted < maxObjects ? page.NextContinuationToken : undefined;
    } while (token);
    if (skippedLarge > 0) ctx.log(`s3 walk of ${cfg.bucket} skipped ${skippedLarge} object(s) over maxObjectBytes`);
    yield { type: 'checkpoint', checkpoint: { walkedAt: new Date().toISOString(), objects: emitted } };
  }

  async fetch(ctx: ConnectorCtx, item: ItemDescriptor): Promise<FetchedItem> {
    const cfg = configOf(ctx);
    await guardEndpoint(cfg);
    const client = this.clientFactory(cfg, ctx.connection.credential);
    const res = (await client.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: item.externalId }))) as {
      Body?: { transformToByteArray(): Promise<Uint8Array> };
      ContentType?: string;
      LastModified?: Date;
    };
    if (!res.Body) throw new Error(`empty object body: ${item.externalId}`);
    const bytes = Buffer.from(await res.Body.transformToByteArray());
    if (bytes.byteLength > byteCap(cfg)) throw new Error(`object over maxObjectBytes: ${item.externalId}`);
    const ext = extOf(item.externalId);
    const mediaType = MEDIA_TYPES[ext] ?? res.ContentType ?? 'application/octet-stream';
    const occurredAt = res.LastModified?.toISOString() ?? item.modifiedAt;
    if (ctx.connection.shape === 'binary') {
      return { shape: 'binary', bytes, mediaType, modality: ext === 'pdf' ? 'document' : 'image', occurredAt };
    }
    if (looksBinary(bytes)) throw new Error(`binary content in a text-shaped item: ${item.externalId}`);
    return {
      shape: 'document',
      text: bytes.toString('utf8'),
      title: item.title,
      occurredAt,
      kind: 'object',
    };
  }
}

type S3Object = { Key?: string; ETag?: string; Size?: number; LastModified?: Date };

function admitObject(obj: S3Object, extensions: Set<string>, maxBytes: number): 'admit' | 'skip' | 'large' {
  const key = obj.Key ?? '';
  if (!key || key.endsWith('/')) return 'skip';
  if (!extensions.has(extOf(key))) return 'skip';
  return (obj.Size ?? 0) > maxBytes ? 'large' : 'admit';
}

function describeObject(bucket: string, obj: S3Object): ItemDescriptor {
  const key = obj.Key ?? '';
  const ext = extOf(key);
  return {
    externalId: key,
    path: key,
    title: key.slice(key.lastIndexOf('/') + 1),
    originUri: `s3://${bucket}/${key}`,
    mediaType: MEDIA_TYPES[ext] ?? 'application/octet-stream',
    size: obj.Size,
    ...(obj.ETag ? { revision: `etag:${obj.ETag.replace(/"/g, '')}` } : {}),
    ...(obj.LastModified ? { modifiedAt: obj.LastModified.toISOString() } : {}),
  };
}

function configOf(ctx: ConnectorCtx): S3ConnectorConfig {
  const cfg = ctx.connection.config as Partial<S3ConnectorConfig>;
  if (typeof cfg.bucket !== 'string' || cfg.bucket.length === 0) {
    throw new Error('s3 connector: config.bucket is required');
  }
  return cfg as S3ConnectorConfig;
}

async function guardEndpoint(cfg: S3ConnectorConfig): Promise<void> {
  if (!cfg.endpoint) return;
  await assertPublicHttpUrl(cfg.endpoint, {
    allowHttp: cfg.allowPrivate === true && sourceEgressAllowPrivate(),
  });
}

function defaultClient(cfg: S3ConnectorConfig, credential: string | null): S3ClientLike {
  const [accessKeyId, secretAccessKey] = (credential ?? '').split(':');
  return new S3Client({
    region: cfg.region ?? 'us-east-1',
    ...(cfg.endpoint ? { endpoint: cfg.endpoint } : {}),
    ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
    forcePathStyle: cfg.forcePathStyle === true,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

function extensionsFor(ctx: ConnectorCtx, cfg: S3ConnectorConfig): string[] {
  const declared = cfg.extensions?.map((e) => e.toLowerCase().replace(/^\./, ''));
  if (declared && declared.length > 0) return declared;
  return ctx.connection.shape === 'binary' ? FS_BINARY_EXTENSIONS : FS_TEXT_EXTENSIONS;
}

function byteCap(cfg: S3ConnectorConfig): number {
  const v = cfg.maxObjectBytes ?? DEFAULT_MAX_OBJECT_BYTES;
  return Math.min(Math.max(1, v), HARD_MAX_OBJECT_BYTES);
}

function extOf(key: string): string {
  const name = key.slice(key.lastIndexOf('/') + 1);
  const i = name.lastIndexOf('.');
  return i === -1 ? '' : name.slice(i + 1).toLowerCase();
}
