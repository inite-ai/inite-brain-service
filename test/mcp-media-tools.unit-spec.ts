/**
 * MCP media tools (#900 step 3): read_media returns a stored image as an
 * image block (downscaled) or a recording as an audio block, through the
 * raw-evidence ladder; upload_media is the blob door with the modality its
 * media type is accepted under. Each registers only behind its flag.
 */
import { Readable } from 'node:stream';
import sharp from 'sharp';
import {
  modalityOf,
  registerMediaReadTools,
  registerMediaWriteTools,
} from '../src/mcp/media-tools';
import { ACTIONS } from '../src/policy/action-registry';

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
}>;

function serverOf() {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    server: {
      registerTool: (name: string, _c: unknown, h: Handler) => handlers.set(name, h),
    } as never,
  };
}

const FLAGS = ['EVIDENCE_RAW_READ_ENABLED', 'EVIDENCE_BLOB_UPLOAD_ENABLED'];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of FLAGS) saved[k] = process.env[k];
});
afterEach(() => {
  for (const k of FLAGS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('media tools — registration', () => {
  it('each tool exists only behind its flag, with an action entry', () => {
    process.env.EVIDENCE_RAW_READ_ENABLED = '0';
    process.env.EVIDENCE_BLOB_UPLOAD_ENABLED = '0';
    const off = serverOf();
    registerMediaReadTools({
      server: off.server,
      companyId: 'c',
      scopes: [],
      actorKeyHash: '',
      deps: {},
    });
    registerMediaWriteTools({ server: off.server, companyId: 'c', deps: {} });
    expect([...off.handlers.keys()]).toEqual([]);

    process.env.EVIDENCE_RAW_READ_ENABLED = '1';
    process.env.EVIDENCE_BLOB_UPLOAD_ENABLED = '1';
    const on = serverOf();
    registerMediaReadTools({
      server: on.server,
      companyId: 'c',
      scopes: ['brain:read_media'],
      actorKeyHash: '',
      deps: {},
    });
    registerMediaWriteTools({ server: on.server, companyId: 'c', deps: {} });
    expect([...on.handlers.keys()].sort()).toEqual(['read_media', 'upload_media']);
    // A key without brain:read_media is not offered read_media.
    const plain = serverOf();
    registerMediaReadTools({
      server: plain.server,
      companyId: 'c',
      scopes: ['brain:read'],
      actorKeyHash: '',
      deps: {},
    });
    expect([...plain.handlers.keys()]).toEqual([]);
    expect(ACTIONS.read_media?.kind).toBe('read');
    expect(ACTIONS.upload_media?.kind).toBe('write');
  });

  it('a media type maps to the modality it is accepted under', () => {
    expect(modalityOf('image/PNG')).toBe('image');
    expect(modalityOf('audio/mpeg')).toBe('audio');
    expect(modalityOf('application/pdf; x=1')).toBe('document');
    expect(modalityOf('text/csv')).toBe('document');
    expect(modalityOf('image/svg+xml')).toBeUndefined();
  });
});

describe('read_media', () => {
  async function reader(mediaType: string, bytes: Buffer) {
    process.env.EVIDENCE_RAW_READ_ENABLED = '1';
    const runLadder = jest.fn(async () => ({
      assetIdStr: 'evidence_asset:a1',
      storageRef: 'fs://c/h',
      mediaType,
      byteLength: bytes.byteLength,
    }));
    const { server, handlers } = serverOf();
    registerMediaReadTools({
      server,
      companyId: 'co_a',
      scopes: ['brain:read', 'brain:read_media'],
      actorKeyHash: 'kh',
      deps: {
        reads: () => ({ runLadder }) as never,
        storage: () => new Map([['fs', { get: async () => Readable.from([bytes]) }]]) as never,
      },
    });
    return { call: handlers.get('read_media')!, runLadder };
  }

  it('returns an image as a downscaled JPEG block, after running the raw-evidence ladder', async () => {
    const png = await sharp({
      create: { width: 4000, height: 1000, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .png()
      .toBuffer();
    const { call, runLadder } = await reader('image/png', png);
    const res = await call({ assetId: 'evidence_asset:a1' });
    expect(runLadder).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: 'co_a',
        keyHash: 'kh',
        assetId: 'evidence_asset:a1',
        verb: 'stream',
      }),
    );
    expect(res.content.map((c) => c.type)).toEqual(['text', 'image']);
    const meta = await sharp(Buffer.from(res.content[1]!.data!, 'base64')).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBe(1568);
  });

  it('returns a recording as an audio block, and refuses other kinds of file', async () => {
    const audio = await reader('audio/mpeg', Buffer.from('ID3fake'));
    const res = await audio.call({ fragmentId: 'evidence_fragment:f1' });
    expect(res.content[1]).toMatchObject({ type: 'audio', mimeType: 'audio/mpeg' });
    const pdf = await reader('application/pdf', Buffer.from('%PDF'));
    await expect(pdf.call({ assetId: 'evidence_asset:a1' })).rejects.toThrow(/images and audio/);
  });

  it('needs exactly one of assetId or fragmentId', async () => {
    const { call } = await reader('image/png', Buffer.from(''));
    await expect(call({})).rejects.toThrow(/exactly one/);
    await expect(call({ assetId: 'a', fragmentId: 'f' })).rejects.toThrow(/exactly one/);
  });
});

describe('upload_media', () => {
  it('hands the decoded bytes to the blob door under the inferred modality', async () => {
    process.env.EVIDENCE_BLOB_UPLOAD_ENABLED = '1';
    const upload = jest.fn(async () => ({
      assetId: 'evidence_asset:n1',
      deduped: false,
      mediaType: 'image/png',
      byteLength: 3,
      quarantineStatus: 'clean',
      dispatched: true,
      availability: 'hot',
      byteHash: 'h',
      storageRef: 'fs://x',
    }));
    const { server, handlers } = serverOf();
    registerMediaWriteTools({
      server,
      companyId: 'co_a',
      deps: { uploads: () => ({ upload }) as never },
    });
    const res = await handlers.get('upload_media')!({
      data: Buffer.from('abc').toString('base64'),
      mediaType: 'image/png',
    });
    expect(upload).toHaveBeenCalledWith(
      'co_a',
      expect.objectContaining({ buffer: Buffer.from('abc'), mimetype: 'image/png', size: 3 }),
      expect.objectContaining({ modality: 'image', mediaType: 'image/png', vertical: 'media' }),
    );
    expect(JSON.parse(res.content[0]!.text!)).toMatchObject({
      assetId: 'evidence_asset:n1',
      dispatched: true,
    });
    await expect(
      handlers.get('upload_media')!({ data: 'YWJj', mediaType: 'image/svg+xml' }),
    ).rejects.toThrow(/not accepted/);
  });
});
