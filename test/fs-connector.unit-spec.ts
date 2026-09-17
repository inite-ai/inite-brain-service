/**
 * FsConnector over a real temp tree:
 *  - the root jail: no SOURCE_FS_ROOTS ⇒ refused; a root outside ⇒
 *    refused; a symlinked root inside ⇒ resolved; a `..` escape ⇒ refused;
 *  - the walk: text-like extensions only (per shape), hidden entries and
 *    excluded directories skipped, symlinks never followed, files over
 *    maxFileBytes skipped, maxFiles bounds the walk, a checkpoint last;
 *  - the descriptor: POSIX-relative externalId, `file://` originUri,
 *    media type, `mtime:size` revision;
 *  - fetch: re-checks containment, refuses binary content in a text item,
 *    hands PDFs / images to the binary shape with the right modality;
 *  - the kind switch: off ⇒ the registry lookup says so by name.
 */
import { mkdtemp, mkdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  containedPath,
  FsConnector,
  jailedRoot,
  looksBinary,
} from '../src/source-plane/connectors/fs.connector';
import {
  connectorState,
  connectorUnavailableMessage,
  findConnector,
  type ConnectorCtx,
  type ItemDelta,
} from '../src/source-plane/connector';

let base = '';
let root = '';
let outside = '';

function ctx(over: { shape?: 'document' | 'binary'; config?: Record<string, unknown> } = {}): ConnectorCtx {
  return {
    companyId: 'co',
    connection: {
      id: 'source_connection:c1',
      packId: 'file_memory',
      sourceId: 'folder',
      kind: 'native',
      connector: 'fs',
      shape: over.shape ?? 'document',
      host: 'server',
      config: { root, ...(over.config ?? {}) },
      credential: null,
      contentPolicy: 'text',
      vertical: 'files',
      recorder: 'srcconn_c1',
      userId: null,
    },
    signal: new AbortController().signal,
    log: () => undefined,
  };
}

async function walk(c: FsConnector, x: ConnectorCtx): Promise<ItemDelta[]> {
  const out: ItemDelta[] = [];
  for await (const d of c.enumerate(x, { checkpoint: null, full: true })) out.push(d);
  return out;
}

const ids = (deltas: ItemDelta[]) =>
  deltas.filter((d) => d.type === 'upsert').map((d) => (d as { item: { externalId: string } }).item.externalId).sort();

describe('FsConnector', () => {
  const saved: Record<string, string | undefined> = {};
  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'fs-connector-'));
    root = join(base, 'vault');
    outside = join(base, 'elsewhere');
    await mkdir(join(root, 'docs', 'runbooks'), { recursive: true });
    await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
    await mkdir(join(root, '.git'), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(root, 'README.md'), '# Vault\nWelcome.');
    await writeFile(join(root, 'docs', 'runbooks', 'oncall.md'), 'On-call rotation.');
    await writeFile(join(root, 'docs', 'notes.txt'), 'plain notes');
    await writeFile(join(root, 'docs', 'data.bin'), Buffer.from([1, 2, 3]));
    await writeFile(join(root, 'docs', 'fake.md'), Buffer.from([0x68, 0x69, 0x00, 0x21]));
    await writeFile(join(root, 'docs', 'scan.pdf'), '%PDF-1.4 fake');
    await writeFile(join(root, 'docs', 'photo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(join(root, '.hidden.md'), 'secret');
    await writeFile(join(root, 'node_modules', 'pkg', 'index.md'), 'dep');
    await writeFile(join(root, '.git', 'HEAD'), 'ref');
    await writeFile(join(root, 'big.md'), 'x'.repeat(5000));
    await writeFile(join(outside, 'leak.md'), 'must never be read');
    await symlink(join(outside, 'leak.md'), join(root, 'docs', 'link.md'));
    await symlink(outside, join(root, 'docs', 'linkdir'));
    await symlink(root, join(base, 'vault-link'));
    await utimes(join(root, 'README.md'), new Date('2026-09-01T00:00:00Z'), new Date('2026-09-01T00:00:00Z'));
    for (const k of ['SOURCE_FS_ROOTS', 'SOURCE_KIND_FS']) saved[k] = process.env[k];
    process.env.SOURCE_FS_ROOTS = base;
    process.env.SOURCE_KIND_FS = '1';
  });
  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(base, { recursive: true, force: true });
  });

  it('jails the root: unset roots refuse, outside refuses, a symlinked root inside resolves', async () => {
    delete process.env.SOURCE_FS_ROOTS;
    await expect(jailedRoot(root)).rejects.toThrow('SOURCE_FS_ROOTS is not set');
    process.env.SOURCE_FS_ROOTS = join(base, 'somewhere-else');
    await expect(jailedRoot(root)).rejects.toThrow('outside SOURCE_FS_ROOTS');
    process.env.SOURCE_FS_ROOTS = base;
    await expect(jailedRoot(join(base, 'vault-link'))).resolves.toBe(await jailedRoot(root));
    await expect(jailedRoot(join(root, 'docs', '..', '..', 'elsewhere'))).resolves.toContain('elsewhere');
    await expect(jailedRoot(join(base, 'missing'))).rejects.toThrow('does not exist');
  });

  it('refuses a catalogue path that escapes the root', () => {
    const r = '/srv/vault';
    expect(containedPath(r, 'docs/a.md')).toBe('/srv/vault/docs/a.md');
    expect(() => containedPath(r, '../etc/passwd')).toThrow('escapes the root');
    expect(() => containedPath(r, 'docs/../../x')).toThrow('escapes the root');
    expect(() => containedPath(r, 'a\0b')).toThrow('invalid path');
  });

  it('walks text-like files only, skipping hidden, excluded, symlinked and oversized entries', async () => {
    const c = new FsConnector();
    const deltas = await walk(c, ctx({ config: { maxFileBytes: 4000 } }));
    expect(ids(deltas)).toEqual(['README.md', 'docs/fake.md', 'docs/notes.txt', 'docs/runbooks/oncall.md']);
    const readme = deltas.find(
      (d): d is Extract<ItemDelta, { type: 'upsert' }> => d.type === 'upsert' && d.item.externalId === 'README.md',
    )!;
    expect(readme.item).toMatchObject({
      path: 'README.md',
      title: 'README.md',
      originUri: `file://${await jailedRoot(root)}/README.md`,
      mediaType: 'text/markdown',
      size: 16,
      modifiedAt: '2026-09-01T00:00:00.000Z',
    });
    expect(readme.item.revision).toBe(`${Date.parse('2026-09-01T00:00:00Z')}:16`);
    expect(deltas.at(-1)).toMatchObject({ type: 'checkpoint', checkpoint: { files: 4 } });
  });

  it('the binary shape walks PDFs and images and fetches them with the right modality', async () => {
    const c = new FsConnector();
    const x = ctx({ shape: 'binary' });
    expect(ids(await walk(c, x))).toEqual(['docs/photo.png', 'docs/scan.pdf']);
    const pdf = await c.fetch(x, { externalId: 'docs/scan.pdf' });
    expect(pdf).toMatchObject({ shape: 'binary', mediaType: 'application/pdf', modality: 'document' });
    const png = await c.fetch(x, { externalId: 'docs/photo.png' });
    expect(png).toMatchObject({ shape: 'binary', mediaType: 'image/png', modality: 'image' });
  });

  it('maxFiles bounds the walk; explicit extensions and includeHidden widen it', async () => {
    const c = new FsConnector();
    const bounded = await walk(c, ctx({ config: { maxFiles: 2 } }));
    expect(ids(bounded)).toHaveLength(2);
    const widened = await walk(c, ctx({ config: { extensions: ['md'], includeHidden: true, excludeDirs: [] } }));
    expect(ids(widened)).toEqual(['.hidden.md', 'README.md', 'big.md', 'docs/fake.md', 'docs/runbooks/oncall.md', 'node_modules/pkg/index.md']);
  });

  it('fetch reads a text file, refuses binary content in a text item, and re-checks containment', async () => {
    const c = new FsConnector();
    const x = ctx();
    const doc = await c.fetch(x, { externalId: 'docs/runbooks/oncall.md' });
    expect(doc).toMatchObject({ shape: 'document', text: 'On-call rotation.', title: 'oncall.md', kind: 'file' });
    await expect(c.fetch(x, { externalId: 'docs/fake.md' })).rejects.toThrow('binary content');
    await expect(c.fetch(x, { externalId: '../elsewhere/leak.md' })).rejects.toThrow('escapes the root');
    await expect(c.fetch(x, { externalId: 'docs/link.md' })).rejects.toThrow('not a regular file');
    expect(looksBinary(Buffer.from('plain'))).toBe(false);
    expect(looksBinary(Buffer.from([0x41, 0x00]))).toBe(true);
  });

  it('the kind switch makes the connector "not installed" by name', () => {
    const c = new FsConnector();
    expect(findConnector([c], 'fs')).toBe(c);
    delete process.env.SOURCE_KIND_FS;
    expect(findConnector([c], 'fs')).toBeNull();
    expect(connectorState([c], 'fs')).toBe('disabled');
    expect(connectorUnavailableMessage('fs', 'disabled')).toContain('SOURCE_KIND_FS');
    expect(connectorState([c], 's3')).toBe('missing');
    process.env.SOURCE_KIND_FS = '1';
  });
});
