/**
 * FsEvidenceStorageAdapter (0109): put/get/head/exists/delete round-trip
 * on a per-test mkdtemp root, content-addressed idempotency, malformed
 * ref / path-traversal rejection, and the unconfigured (EVIDENCE_FS_ROOT
 * unset) loud throw.
 *
 * Plus the two orphan-GC extension points and the promises the sweep
 * leans on when it DELETES what they report: listBlobs yields one
 * tenant's addressable blobs and nothing else, and sweepIncompleteWrites
 * removes only aged `.tmp-…` debris — never a real blob, never in a dry
 * run. Ages here are REAL (back-dated mtimes), never a mocked clock:
 * blob age is the input to the grace window, so it has to be checkable
 * the way the sweep actually reads it.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
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
    expect(adapter.belongsToTenant('co_a', storageRef)).toBe(true);
    expect(adapter.belongsToTenant('co_b', storageRef)).toBe(false);

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
    await expect(adapter.put('co_a', 'a'.repeat(64), Buffer.from('x'))).rejects.toThrow(
      /does not match/,
    );
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

  describe('listBlobs (orphan-GC enumeration contract)', () => {
    const collect = async (companyId: string) => {
      const seen: Array<{ storageRef: string; byteLength: number; modifiedAtMs: number }> = [];
      for await (const e of adapter.listBlobs(companyId)) seen.push(e);
      return seen;
    };

    it('yields this tenant only, with sizes, and never another tenant s blobs', async () => {
      const mine = randomBytes(32);
      const theirs = randomBytes(48);
      const mineRef = (await adapter.put('co_a', sha256(mine), mine)).storageRef;
      await adapter.put('co_b', sha256(theirs), theirs);

      const seen = await collect('co_a');
      expect(seen.map((e) => e.storageRef)).toEqual([mineRef]);
      expect(seen[0]!.byteLength).toBe(32);
      // The write time, observable and back-datable — the grace window
      // the orphan sweep applies is only as trustworthy as this number.
      expect(seen[0]!.modifiedAtMs).toBeGreaterThan(0);
      expect(seen[0]!.modifiedAtMs).toBeLessThanOrEqual(Date.now() + 1000);
      // Contract point 1: everything yielded belongs to the tenant asked for.
      expect(adapter.belongsToTenant('co_a', seen[0]!.storageRef)).toBe(true);
      expect((await collect('co_b')).map((e) => e.storageRef)).toEqual([
        `fs://co_b/${sha256(theirs)}`,
      ]);
    });

    it('is an empty iteration for a tenant that has never stored anything', async () => {
      expect(await collect('co_never')).toEqual([]);
      // …and for a companyId the layout could not have produced.
      expect(await collect('../evil')).toEqual([]);
    });

    it('ignores files the content-addressed layout could not have produced', async () => {
      const data = randomBytes(16);
      const hash = sha256(data);
      await adapter.put('co_a', hash, data);
      const shard = join(root, 'co_a', hash.slice(0, 2));
      // A stray name, a tmp straggler, and a well-formed hash filed under
      // the WRONG fan-out shard: none of them is an addressable blob, so
      // none may ever be offered to a deleter.
      //
      // The third name is derived from this blob's shard rather than
      // hard-coded. It used to be `'b'.repeat(64)`, which is only in the
      // WRONG shard while the random blob's hash does not itself start
      // with `bb` — a 1-in-256 draw per run, and when it came up the file
      // was correctly addressable and the assertion failed for a reason
      // the test is not about.
      const foreignShardName = (shard.endsWith('bb') ? 'c' : 'b').repeat(64);
      await writeFile(join(shard, 'README'), 'x');
      await writeFile(join(shard, '.tmp-abc'), 'x');
      await writeFile(join(shard, foreignShardName), 'x');

      expect((await collect('co_a')).map((e) => e.storageRef)).toEqual([`fs://co_a/${hash}`]);
    });
  });

  describe('sweepIncompleteWrites', () => {
    // A straggler's age is its mtime (see the adapter), which utimes can
    // set — so ages here are REAL, no clock mocking. `ageMs` back-dates;
    // 0 leaves the file as freshly written.
    const tmpIn = async (hash: string, name: string, ageMs = 0) => {
      const shard = join(root, 'co_a', hash.slice(0, 2));
      await mkdir(shard, { recursive: true });
      const path = join(shard, name);
      await writeFile(path, 'partial');
      if (ageMs > 0) {
        const when = new Date(Date.now() - ageMs);
        await utimes(path, when, when);
      }
      return path;
    };

    it('removes only stragglers past the grace window', async () => {
      const data = randomBytes(8);
      const hash = sha256(data);
      await adapter.put('co_a', hash, data);
      const old = await tmpIn(hash, '.tmp-old', 3600_000);
      const young = await tmpIn(hash, '.tmp-young');

      const swept = await adapter.sweepIncompleteWrites('co_a', {
        olderThanMs: 60_000,
        dryRun: false,
      });
      expect(swept).toEqual({ found: 1, removed: 1 });
      expect(existsSync(old)).toBe(false);
      expect(existsSync(young)).toBe(true);
      // The real blob is untouched by the tmp broom.
      expect(await adapter.exists(`fs://co_a/${hash}`)).toBe(true);
    });

    it('protects every straggler while the window is generous', async () => {
      const data = randomBytes(8);
      const hash = sha256(data);
      await adapter.put('co_a', hash, data);
      const fresh = await tmpIn(hash, '.tmp-fresh', 60_000);

      expect(
        await adapter.sweepIncompleteWrites('co_a', { olderThanMs: 3600_000, dryRun: false }),
      ).toEqual({ found: 0, removed: 0 });
      expect(existsSync(fresh)).toBe(true);
    });

    it('reports without removing in dry-run mode, and is idempotent', async () => {
      const data = randomBytes(8);
      const hash = sha256(data);
      await adapter.put('co_a', hash, data);
      const old = await tmpIn(hash, '.tmp-old', 3600_000);
      const window = { olderThanMs: 60_000 };

      expect(await adapter.sweepIncompleteWrites('co_a', { ...window, dryRun: true })).toEqual({
        found: 1,
        removed: 0,
      });
      expect(existsSync(old)).toBe(true);

      await adapter.sweepIncompleteWrites('co_a', { ...window, dryRun: false });
      expect(await adapter.sweepIncompleteWrites('co_a', { ...window, dryRun: false })).toEqual({
        found: 0,
        removed: 0,
      });
    });

    it('is a no-op for an unknown tenant', async () => {
      expect(
        await adapter.sweepIncompleteWrites('co_never', { olderThanMs: 0, dryRun: false }),
      ).toEqual({ found: 0, removed: 0 });
    });
  });

  it('throws the clear unconfigured error when EVIDENCE_FS_ROOT is unset', async () => {
    delete process.env.EVIDENCE_FS_ROOT;
    const bare = new FsEvidenceStorageAdapter();
    const data = Buffer.from('x');
    const hash = sha256(data);
    await expect(bare.put('co_a', hash, data)).rejects.toThrow(/EVIDENCE_FS_ROOT/);
    await expect(bare.head(`fs://co_a/${hash}`)).rejects.toThrow(/EVIDENCE_FS_ROOT/);
    await expect(bare.delete(`fs://co_a/${hash}`)).rejects.toThrow(/EVIDENCE_FS_ROOT/);
  });
});
