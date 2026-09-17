/**
 * S3Connector over a fake client: pagination via ContinuationToken,
 * extension filter per shape, folder markers and oversized objects
 * skipped, ETag as revision, `s3://` originUri, maxObjects bound; fetch
 * decodes text (refusing NUL bytes) or hands bytes to the binary shape;
 * a private custom endpoint needs the double opt-in.
 */
import { GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { EgressDeniedError } from '../src/common/egress-guard';
import { S3Connector, type S3ClientLike } from '../src/source-plane/connectors/s3.connector';
import type { ConnectorCtx, ItemDelta } from '../src/source-plane/connector';

interface FakeObject {
  Key: string;
  ETag?: string;
  Size?: number;
  LastModified?: Date;
  body?: Buffer;
}

function fakeClient(objects: FakeObject[], pageSize = 2): S3ClientLike & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    async send(command: ListObjectsV2Command | GetObjectCommand) {
      calls.push(command);
      if (command instanceof ListObjectsV2Command) {
        const prefix = command.input.Prefix ?? '';
        const all = objects.filter((o) => o.Key.startsWith(prefix));
        const start = Number(command.input.ContinuationToken ?? 0);
        const page = all.slice(start, start + pageSize);
        const next = start + pageSize;
        return {
          Contents: page.map(({ body: _b, ...rest }) => rest),
          IsTruncated: next < all.length,
          NextContinuationToken: next < all.length ? String(next) : undefined,
        };
      }
      const obj = objects.find((o) => o.Key === command.input.Key);
      if (!obj) throw new Error('NoSuchKey');
      return {
        Body: { transformToByteArray: async () => new Uint8Array(obj.body ?? Buffer.alloc(0)) },
        ContentType: 'application/octet-stream',
        LastModified: obj.LastModified,
      };
    },
  };
}

function ctx(
  config: Record<string, unknown>,
  shape: 'document' | 'binary' = 'document',
): ConnectorCtx {
  return {
    companyId: 'co',
    connection: {
      id: 'source_connection:c1',
      packId: 'file_memory',
      sourceId: 'bucket',
      kind: 'native',
      connector: 's3',
      shape,
      host: 'server',
      config: { bucket: 'b', ...config },
      credential: 'ak:sk',
      contentPolicy: 'text',
      vertical: 'files',
      recorder: 'srcconn_c1',
      userId: null,
    },
    signal: new AbortController().signal,
    log: () => undefined,
  };
}

async function walk(c: S3Connector, x: ConnectorCtx): Promise<ItemDelta[]> {
  const out: ItemDelta[] = [];
  for await (const d of c.enumerate(x, { checkpoint: null, full: true })) out.push(d);
  return out;
}
const upserts = (deltas: ItemDelta[]) =>
  deltas.filter((d): d is Extract<ItemDelta, { type: 'upsert' }> => d.type === 'upsert');

const OBJECTS: FakeObject[] = [
  { Key: 'docs/', Size: 0 },
  {
    Key: 'docs/a.md',
    ETag: '"e1"',
    Size: 5,
    LastModified: new Date('2026-03-01T00:00:00Z'),
    body: Buffer.from('hello'),
  },
  { Key: 'docs/b.txt', ETag: '"e2"', Size: 3, body: Buffer.from('bye') },
  { Key: 'docs/big.md', ETag: '"e3"', Size: 10_000_000 },
  { Key: 'docs/scan.pdf', ETag: '"e4"', Size: 9, body: Buffer.from('%PDF fake') },
  { Key: 'docs/bin.md', ETag: '"e5"', Size: 2, body: Buffer.from([0x41, 0x00]) },
  { Key: 'other/c.md', ETag: '"e6"', Size: 1, body: Buffer.from('c') },
];

describe('S3Connector', () => {
  const saved = process.env.SOURCE_EGRESS_ALLOW_PRIVATE;
  afterEach(() => {
    if (saved === undefined) delete process.env.SOURCE_EGRESS_ALLOW_PRIVATE;
    else process.env.SOURCE_EGRESS_ALLOW_PRIVATE = saved;
  });

  it('paginates the prefix, filters by shape extensions, skips folders and oversized objects', async () => {
    const c = new S3Connector();
    const client = fakeClient(OBJECTS);
    c.clientFactory = () => client;
    const deltas = await walk(c, ctx({ prefix: 'docs/' }));
    const items = upserts(deltas).map((d) => d.item);
    expect(items.map((i) => i.externalId)).toEqual(['docs/a.md', 'docs/b.txt', 'docs/bin.md']);
    expect(items[0]).toMatchObject({
      originUri: 's3://b/docs/a.md',
      title: 'a.md',
      mediaType: 'text/markdown',
      size: 5,
      revision: 'etag:e1',
      modifiedAt: '2026-03-01T00:00:00.000Z',
    });
    expect(deltas.at(-1)).toMatchObject({ type: 'checkpoint', checkpoint: { objects: 3 } });
    expect(client.calls.filter((k) => k instanceof ListObjectsV2Command)).toHaveLength(3);
  });

  it('the binary shape admits PDFs; maxObjects bounds the walk', async () => {
    const c = new S3Connector();
    c.clientFactory = () => fakeClient(OBJECTS);
    expect(
      upserts(await walk(c, ctx({ prefix: 'docs/' }, 'binary'))).map((d) => d.item.externalId),
    ).toEqual(['docs/scan.pdf']);
    expect(upserts(await walk(c, ctx({ maxObjects: 1 })))).toHaveLength(1);
  });

  it('fetch decodes text, refuses NUL bytes in a text item, hands bytes to the binary shape', async () => {
    const c = new S3Connector();
    c.clientFactory = () => fakeClient(OBJECTS);
    expect(await c.fetch(ctx({}), { externalId: 'docs/a.md', title: 'a.md' })).toMatchObject({
      shape: 'document',
      text: 'hello',
      title: 'a.md',
      occurredAt: '2026-03-01T00:00:00.000Z',
      kind: 'object',
    });
    await expect(c.fetch(ctx({}), { externalId: 'docs/bin.md' })).rejects.toThrow('binary content');
    expect(await c.fetch(ctx({}, 'binary'), { externalId: 'docs/scan.pdf' })).toMatchObject({
      shape: 'binary',
      mediaType: 'application/pdf',
      modality: 'document',
    });
    await expect(c.fetch(ctx({}), { externalId: 'nope' })).rejects.toThrow('NoSuchKey');
  });

  it('a private custom endpoint needs the double opt-in', async () => {
    const c = new S3Connector();
    c.clientFactory = () => fakeClient(OBJECTS);
    delete process.env.SOURCE_EGRESS_ALLOW_PRIVATE;
    await expect(
      walk(c, ctx({ endpoint: 'http://minio.local:9000', allowPrivate: true })),
    ).rejects.toThrow(EgressDeniedError);
    process.env.SOURCE_EGRESS_ALLOW_PRIVATE = '1';
    await expect(walk(c, ctx({ endpoint: 'http://127.0.0.1:9000' }))).rejects.toThrow(
      EgressDeniedError,
    );
    expect(
      upserts(
        await walk(
          c,
          ctx({ endpoint: 'http://127.0.0.1:9000', allowPrivate: true, prefix: 'other/' }),
        ),
      ),
    ).toHaveLength(1);
  });

  it('config.bucket is required', async () => {
    const c = new S3Connector();
    await expect(walk(c, ctx({ bucket: '' }))).rejects.toThrow('config.bucket is required');
  });
});
