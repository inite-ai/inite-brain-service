/**
 * FsEvidenceStorageAdapter (0109): put/get/head/exists/delete round-trip
 * on a per-test mkdtemp root, content-addressed idempotency, malformed
 * ref / path-traversal rejection, and the unconfigured (EVIDENCE_FS_ROOT
 * unset) loud throw.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FsEvidenceStorageAdapter,
  parseStorageRef,
} from '../src/evidence/storage/fs-storage.adapter';

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe('parseStorageRef', () => {
  const hash = 'a'.repeat(64);

  it('parses a well-formed fs ref', () => {
    expect(parseStorageRef(`fs://co_x/${hash}`)).toEqual({
      companyId: 'co_x',
      byteHash: hash,
    });
  });

  it.each([
    ['wrong scheme', `s3://co_x/${'a'.repeat(64)}`],
    ['short hash', 'fs://co_x/abc123'],
    ['uppercase hash', `fs://co_x/${'A'.repeat(64)}`],
    ['non-hex hash', `fs://co_x/${'z'.repeat(64)}`],
    ['traversal tenant', `fs://../${'a'.repeat(64)}`],
    ['dot tenant', `fs://./${'a'.repeat(64)}`],
    ['extra segment', `fs://co_x/extra/${'a'.repeat(64)}`],
    ['tenant with slash encoded shape', `fs://co%2Fx/${'a'.repeat(64)}`],
    ['empty tenant', `fs:///${'a'.repeat(64)}`],
  ])('rejects %s', (_label, ref) => {
    expect(parseStorageRef(ref)).toBeNull();
  });
});

describe('FsEvidenceStorageAdapter', () => {
  let root: string;
  let adapter: FsEvidenceStorageAdapter;
  const savedRoot = process.env.EVIDENCE_FS_ROOT;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'evidence-fs-'));
    process.env.EVIDENCE_FS_ROOT = root;
    adapter = new FsEvidenceStorageAdapter();
  });

  afterEach(async () => {
    if (savedRoot === undefined) delete process.env.EVIDENCE_FS_ROOT;
    else process.env.EVIDENCE_FS_ROOT = savedRoot;
    await rm(root, { recursive: true, force: true });
  });

  it('round-trips put → head → get → exists → delete', async () => {
    const data = randomBytes(1024);
    const hash = sha256(data);
    const { storageRef, byteLength } = await adapter.put('co_a', hash, data);
    expect(storageRef).toBe(`fs://co_a/${hash}`);
    expect(byteLength).toBe(1024);

    expect(await adapter.head(storageRef)).toEqual({ byteLength: 1024 });
    expect(await adapter.exists(storageRef)).toBe(true);

    const stream = await adapter.get(storageRef);
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).equals(data)).toBe(true);

    expect(await adapter.delete(storageRef)).toBe(true);
    expect(await adapter.head(storageRef)).toBeNull();
    expect(await adapter.exists(storageRef)).toBe(false);
    // Deleting an absent blob is honest about it.
    expect(await adapter.delete(storageRef)).toBe(false);
  });

  it('put is content-addressed idempotent', async () => {
    const data = randomBytes(64);
    const hash = sha256(data);
    const first = await adapter.put('co_a', hash, data);
    const second = await adapter.put('co_a', hash, data);
    expect(second.storageRef).toBe(first.storageRef);
    expect(second.byteLength).toBe(64);
  });

  it('rejects invalid hash and tenant shapes on put', async () => {
    await expect(adapter.put('co_a', 'nothex', Buffer.from('x'))).rejects.toThrow(/byteHash/);
    await expect(adapter.put('../evil', 'a'.repeat(64), Buffer.from('x'))).rejects.toThrow(
      /companyId/,
    );
  });

  it('rejects malformed / traversal refs on every read-side method', async () => {
    for (const ref of ['fs://co_a/short', `fs://../${'a'.repeat(64)}`, 'not-a-ref']) {
      await expect(adapter.head(ref)).rejects.toThrow(/malformed fs storageRef/);
      await expect(adapter.get(ref)).rejects.toThrow(/malformed fs storageRef/);
      await expect(adapter.delete(ref)).rejects.toThrow(/malformed fs storageRef/);
    }
  });

  it('throws the clear unconfigured error when EVIDENCE_FS_ROOT is unset', async () => {
    delete process.env.EVIDENCE_FS_ROOT;
    const bare = new FsEvidenceStorageAdapter();
    const hash = 'a'.repeat(64);
    await expect(bare.put('co_a', hash, Buffer.from('x'))).rejects.toThrow(/EVIDENCE_FS_ROOT/);
    await expect(bare.head(`fs://co_a/${hash}`)).rejects.toThrow(/EVIDENCE_FS_ROOT/);
    await expect(bare.delete(`fs://co_a/${hash}`)).rejects.toThrow(/EVIDENCE_FS_ROOT/);
  });
});
