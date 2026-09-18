/**
 * The three cloud-drive connectors (W4) against one fake provider on
 * loopback (SOURCE_OAUTH_<P>_BASE_URL + the private-egress opt-in):
 *  - Google Drive: a full walk is breadth-first over folders, admits by the
 *    media table, exports native documents (text for a document shape,
 *    OOXML for a binary one), checkpoints the changes page token + the
 *    folder set; the next run reads `changes.list` — an upsert in scope, a
 *    removal, a file moved out of scope as gone, a new subfolder joining;
 *  - Dropbox: the cursor is the checkpoint; `continue` yields upserts and
 *    deletions; a reset cursor restarts the walk; bytes come by path;
 *  - OneDrive: the delta link is the checkpoint; an expired one restarts;
 *    bytes come from the pre-authenticated URL WITHOUT the bearer;
 *  - a rejected token is a named error; without the opt-in the loopback
 *    override is refused by the egress guard.
 */
import type { ConnectorCtx, ItemDelta } from '../src/source-plane/connector';
import { DropboxConnector, normalizePath } from '../src/source-plane/connectors/dropbox.connector';
import { GDriveConnector } from '../src/source-plane/connectors/gdrive.connector';
import {
  OneDriveConnector,
  folderResource,
} from '../src/source-plane/connectors/onedrive.connector';
import { startFakeCloud, type FakeCloud } from './fixtures/fake-cloud';

let cloud: FakeCloud;
let token = '';
const saved: Record<string, string | undefined> = {};
const ENV = [
  'SOURCE_EGRESS_ALLOW_PRIVATE',
  'SOURCE_OAUTH_GOOGLE_BASE_URL',
  'SOURCE_OAUTH_MICROSOFT_BASE_URL',
  'SOURCE_OAUTH_DROPBOX_BASE_URL',
];

beforeAll(async () => {
  cloud = await startFakeCloud();
  token = cloud.mint();
  for (const k of ENV) saved[k] = process.env[k];
  process.env.SOURCE_EGRESS_ALLOW_PRIVATE = '1';
  process.env.SOURCE_OAUTH_GOOGLE_BASE_URL = cloud.base;
  process.env.SOURCE_OAUTH_MICROSOFT_BASE_URL = cloud.base;
  process.env.SOURCE_OAUTH_DROPBOX_BASE_URL = cloud.base;
});

afterAll(async () => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await cloud.close();
});

function ctx(
  connector: string,
  shape: 'document' | 'binary',
  config: Record<string, unknown>,
  credential: string | null = token,
): ConnectorCtx {
  return {
    companyId: 'co',
    connection: {
      id: 'source_connection:x',
      packId: 'file_memory',
      sourceId: connector,
      kind: 'native',
      connector,
      shape,
      host: 'server',
      config,
      credential,
      contentPolicy: shape === 'binary' ? 'bytes' : 'text',
      vertical: 'files',
      recorder: 'r',
      userId: null,
    },
    signal: new AbortController().signal,
    log: () => undefined,
  };
}

async function collect(
  it: AsyncIterable<ItemDelta>,
): Promise<{ upserts: string[]; gone: string[]; checkpoint: Record<string, unknown> | null }> {
  const upserts: string[] = [];
  const gone: string[] = [];
  let checkpoint: Record<string, unknown> | null = null;
  for await (const d of it) {
    if (d.type === 'upsert') upserts.push(d.item.externalId);
    else if (d.type === 'gone') gone.push(d.externalId);
    else checkpoint = d.checkpoint;
  }
  return { upserts, gone, checkpoint };
}

describe('gdrive', () => {
  const g = new GDriveConnector();

  beforeEach(() => {
    cloud.google.folders = [{ id: 'f_docs', name: 'docs', parent: 'root' }];
    cloud.google.files = [
      {
        id: 'a',
        name: 'README.md',
        mimeType: 'text/markdown',
        content: '# hello',
        modified: '2026-01-01T00:00:00Z',
        parent: 'root',
      },
      {
        id: 'b',
        name: 'notes.txt',
        mimeType: 'text/plain',
        content: 'deep',
        modified: '2026-01-02T00:00:00Z',
        parent: 'f_docs',
      },
      {
        id: 'c',
        name: 'Plan',
        mimeType: 'application/vnd.google-apps.document',
        content: 'the plan',
        modified: '2026-01-03T00:00:00Z',
        parent: 'f_docs',
        native: true,
      },
      {
        id: 'd',
        name: 'scan.pdf',
        mimeType: 'application/pdf',
        content: '%PDF-1.4',
        modified: '2026-01-04T00:00:00Z',
        parent: 'root',
      },
      {
        id: 'e',
        name: 'Form',
        mimeType: 'application/vnd.google-apps.form',
        content: '',
        modified: '2026-01-05T00:00:00Z',
        parent: 'root',
        native: true,
      },
      {
        id: 's',
        name: 'shared.md',
        mimeType: 'text/markdown',
        content: 'shared',
        modified: '2026-01-06T00:00:00Z',
        parent: 'shared',
      },
    ];
    cloud.google.changes = [];
    cloud.google.startPageToken = '100';
  });

  it('walks folders breadth-first, admits by the table, exports natives, checkpoints the page token + folders', async () => {
    const r = await collect(
      g.enumerate(ctx('gdrive', 'document', {}), { checkpoint: null, full: true }),
    );
    expect(r.upserts.sort()).toEqual(['a', 'b', 'c']);
    expect(r.checkpoint).toMatchObject({ pageToken: '100', folders: ['root', 'f_docs'], files: 3 });
    const bin = await collect(
      g.enumerate(ctx('gdrive', 'binary', {}), { checkpoint: null, full: true }),
    );
    expect(bin.upserts.sort()).toEqual(['c', 'd']);
    const shared = await collect(
      g.enumerate(ctx('gdrive', 'document', { includeShared: true }), {
        checkpoint: null,
        full: true,
      }),
    );
    expect(shared.upserts).toContain('s');
  });

  it('fetches bytes, exports a native document as text or OOXML by shape', async () => {
    const doc = await g.fetch(ctx('gdrive', 'document', {}), {
      externalId: 'a',
      title: 'README.md',
      mediaType: 'text/markdown',
    });
    expect(doc).toMatchObject({ shape: 'document', text: '# hello', kind: 'drive_file' });
    const native = await g.fetch(ctx('gdrive', 'document', {}), {
      externalId: 'c',
      title: 'Plan',
      mediaType: 'application/vnd.google-apps.document',
    });
    expect(native).toMatchObject({ shape: 'document', text: 'the plan' });
    const ooxml = await g.fetch(ctx('gdrive', 'binary', {}), {
      externalId: 'c',
      title: 'Plan',
      mediaType: 'application/vnd.google-apps.document',
    });
    expect(ooxml).toMatchObject({ shape: 'binary', modality: 'document' });
    expect((ooxml as { mediaType: string }).mediaType).toContain('wordprocessingml');
    expect((ooxml as { bytes: Buffer }).bytes.toString()).toBe('OOXML:the plan');
    const pdf = await g.fetch(ctx('gdrive', 'binary', {}), {
      externalId: 'd',
      title: 'scan.pdf',
      mediaType: 'application/pdf',
    });
    expect(pdf).toMatchObject({
      shape: 'binary',
      mediaType: 'application/pdf',
      modality: 'document',
    });
  });

  it('reads the changes feed from the checkpoint: upserts in scope, removals and moves out as gone, new subfolders join', async () => {
    const first = await collect(
      g.enumerate(ctx('gdrive', 'document', {}), { checkpoint: null, full: true }),
    );
    cloud.google.folders.push({ id: 'f_new', name: 'new', parent: 'f_docs' });
    cloud.google.changes = [
      {
        fileId: 'b',
        file: {
          id: 'b',
          name: 'notes.txt',
          mimeType: 'text/plain',
          content: 'v2',
          modified: '2026-02-01T00:00:00Z',
          parent: 'f_docs',
        },
      },
      { fileId: 'a', removed: true },
      {
        fileId: 'f_new',
        file: {
          id: 'f_new',
          name: 'new',
          mimeType: 'application/vnd.google-apps.folder',
          content: '',
          modified: '2026-02-01T00:00:00Z',
          parent: 'f_docs',
        },
      },
      {
        fileId: 'n',
        file: {
          id: 'n',
          name: 'in-new.md',
          mimeType: 'text/markdown',
          content: 'x',
          modified: '2026-02-02T00:00:00Z',
          parent: 'f_new',
        },
      },
      {
        fileId: 'z',
        file: {
          id: 'z',
          name: 'elsewhere.md',
          mimeType: 'text/markdown',
          content: 'x',
          modified: '2026-02-02T00:00:00Z',
          parent: 'f_other',
        },
      },
      {
        fileId: 'd',
        file: {
          id: 'd',
          name: 'scan.pdf',
          mimeType: 'application/pdf',
          content: '',
          modified: '2026-02-02T00:00:00Z',
          parent: 'root',
        },
      },
    ];
    const next = await collect(
      g.enumerate(ctx('gdrive', 'document', {}), { checkpoint: first.checkpoint, full: false }),
    );
    expect(next.upserts).toEqual(['b', 'n']);
    expect(next.gone).toEqual(['a', 'z']);
    expect(next.checkpoint).toMatchObject({ pageToken: '101' });
    expect((next.checkpoint as { folders: string[] }).folders).toContain('f_new');
    expect(cloud.calls.filter((c) => c.path.startsWith('/drive/v3/changes?')).length).toBe(1);
  });

  it('names a rejected token', async () => {
    await expect(
      collect(
        g.enumerate(ctx('gdrive', 'document', {}, 'tok_bogus'), { checkpoint: null, full: true }),
      ),
    ).rejects.toThrow(/rejected \(401\)/);
    await expect(
      collect(g.enumerate(ctx('gdrive', 'document', {}, null), { checkpoint: null, full: true })),
    ).rejects.toThrow(/no connected Google account/);
  });

  it('is refused by the egress guard without the private opt-in', async () => {
    process.env.SOURCE_EGRESS_ALLOW_PRIVATE = '0';
    try {
      await expect(
        collect(g.enumerate(ctx('gdrive', 'document', {}), { checkpoint: null, full: true })),
      ).rejects.toThrow(/must use https|non-public/);
    } finally {
      process.env.SOURCE_EGRESS_ALLOW_PRIVATE = '1';
    }
  });
});

describe('dropbox', () => {
  const d = new DropboxConnector();

  beforeEach(() => {
    cloud.dropbox.all = [
      {
        id: '/Docs/readme.md',
        name: 'readme.md',
        mimeType: 'text/markdown',
        content: '# dbx',
        modified: '2026-01-01T00:00:00Z',
      },
      {
        id: '/Docs/deck.pptx',
        name: 'deck.pptx',
        mimeType: 'application/octet-stream',
        content: 'PK..',
        modified: '2026-01-02T00:00:00Z',
      },
      {
        id: '/Other/note.txt',
        name: 'note.txt',
        mimeType: 'text/plain',
        content: 'other',
        modified: '2026-01-03T00:00:00Z',
      },
    ];
    cloud.dropbox.changed = [];
    cloud.dropbox.deleted = [];
  });

  it('normalises the path the way Dropbox wants it', () => {
    expect(normalizePath('')).toBe('');
    expect(normalizePath('/')).toBe('');
    expect(normalizePath('Docs/')).toBe('/Docs');
    expect(normalizePath('/Docs/Sub')).toBe('/Docs/Sub');
  });

  it('walks the folder, keeps the cursor, then continues from it with upserts and deletions', async () => {
    const first = await collect(
      d.enumerate(ctx('dropbox', 'document', { path: '/Docs' }), { checkpoint: null, full: true }),
    );
    expect(first.upserts).toEqual(['/docs/readme.md']);
    expect(first.checkpoint).toMatchObject({ cursor: expect.stringMatching(/^cur_/) });
    const bin = await collect(
      d.enumerate(ctx('dropbox', 'binary', { path: '/Docs' }), { checkpoint: null, full: true }),
    );
    expect(bin.upserts).toEqual(['/docs/deck.pptx']);
    cloud.dropbox.changed = [
      {
        id: '/Docs/new.md',
        name: 'new.md',
        mimeType: 'text/markdown',
        content: 'n',
        modified: '2026-02-01T00:00:00Z',
      },
    ];
    cloud.dropbox.deleted = ['/Docs/readme.md'];
    const next = await collect(
      d.enumerate(ctx('dropbox', 'document', { path: '/Docs' }), {
        checkpoint: first.checkpoint,
        full: false,
      }),
    );
    expect(next.upserts).toEqual(['/docs/new.md']);
    expect(next.gone).toEqual(['/docs/readme.md']);
    expect(
      cloud.calls.filter((c) => c.path === '/2/files/list_folder/continue').length,
    ).toBeGreaterThan(0);
  });

  it('restarts the walk when the cursor was reset', async () => {
    const r = await collect(
      d.enumerate(ctx('dropbox', 'document', { path: '/Docs' }), {
        checkpoint: { cursor: 'reset-me' },
        full: false,
      }),
    );
    expect(r.upserts).toEqual(['/docs/readme.md']);
  });

  it('fetches by path', async () => {
    const doc = await d.fetch(ctx('dropbox', 'document', { path: '/Docs' }), {
      externalId: '/docs/readme.md',
      title: 'readme.md',
    });
    expect(doc).toMatchObject({ shape: 'document', text: '# dbx', kind: 'dropbox_file' });
    const call = cloud.calls.filter((c) => c.path === '/2/files/download').pop();
    expect(call?.auth).toBe(`Bearer ${token}`);
  });
});

describe('onedrive', () => {
  const o = new OneDriveConnector();

  beforeEach(() => {
    cloud.graph.all = [
      {
        id: 'i1',
        name: 'spec.md',
        mimeType: 'text/markdown',
        content: '# od',
        modified: '2026-01-01T00:00:00Z',
      },
      {
        id: 'i2',
        name: 'photo.png',
        mimeType: 'image/png',
        content: Buffer.from([0x89, 0x50]),
        modified: '2026-01-02T00:00:00Z',
      },
    ];
    cloud.graph.changed = [];
    cloud.graph.deleted = [];
    cloud.graph.expireDelta = false;
  });

  it('builds the folder resource for the root, a path, a drive and a site', () => {
    expect(folderResource('https://g/v1.0', {})).toBe('https://g/v1.0/me/drive/root');
    expect(folderResource('https://g/v1.0', { folderPath: '/Documents/Team' })).toBe(
      'https://g/v1.0/me/drive/root:/Documents/Team:',
    );
    expect(folderResource('https://g/v1.0', { driveId: 'D1' })).toBe(
      'https://g/v1.0/drives/D1/root',
    );
    expect(folderResource('https://g/v1.0', { siteId: 'S1', folderPath: 'Shared Documents' })).toBe(
      'https://g/v1.0/sites/S1/drive/root:/Shared%20Documents:',
    );
  });

  it('walks by delta, keeps the link, continues from it, restarts when expired', async () => {
    const first = await collect(
      o.enumerate(ctx('onedrive', 'document', { folderPath: '/Documents' }), {
        checkpoint: null,
        full: true,
      }),
    );
    expect(first.upserts).toEqual(['i1']);
    expect(first.checkpoint).toMatchObject({ deltaLink: expect.stringContaining('token=d') });
    cloud.graph.changed = [
      {
        id: 'i3',
        name: 'more.txt',
        mimeType: 'text/plain',
        content: 'm',
        modified: '2026-02-01T00:00:00Z',
      },
    ];
    cloud.graph.deleted = ['i1'];
    const next = await collect(
      o.enumerate(ctx('onedrive', 'document', { folderPath: '/Documents' }), {
        checkpoint: first.checkpoint,
        full: false,
      }),
    );
    expect(next.upserts).toEqual(['i3']);
    expect(next.gone).toEqual(['i1']);
    cloud.graph.expireDelta = true;
    const again = await collect(
      o.enumerate(ctx('onedrive', 'document', { folderPath: '/Documents' }), {
        checkpoint: next.checkpoint,
        full: false,
      }),
    );
    expect(again.upserts).toEqual(['i1']);
    const bin = await collect(
      o.enumerate(ctx('onedrive', 'binary', {}), { checkpoint: null, full: true }),
    );
    expect(bin.upserts).toEqual(['i2']);
  });

  it('fetches from the pre-authenticated download URL without the bearer', async () => {
    const doc = await o.fetch(ctx('onedrive', 'document', {}), {
      externalId: 'i1',
      title: 'spec.md',
      mediaType: 'text/markdown',
    });
    expect(doc).toMatchObject({ shape: 'document', text: '# od', kind: 'onedrive_file' });
    const dl = cloud.calls.filter((c) => c.path.startsWith('/dl/')).pop();
    expect(dl?.auth).toBeNull();
    const img = await o.fetch(ctx('onedrive', 'binary', {}), {
      externalId: 'i2',
      title: 'photo.png',
      mediaType: 'image/png',
    });
    expect(img).toMatchObject({ shape: 'binary', mediaType: 'image/png', modality: 'image' });
  });
});
