import { Injectable } from '@nestjs/common';
import { createReadStream, type Stats } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { evidenceFsRoot } from '../../common/evidence-flags';
import { EvidenceStorageAdapter, StoredBlobEntry } from './storage-adapter';

const HASH_RE = /^[0-9a-f]{64}$/;
/** Prefix put() gives a blob mid-write, before the atomic rename. */
const TMP_PREFIX = '.tmp-';
/** The two-char fan-out directory a blob's content address lives under. */
const SHARD_RE = /^[0-9a-f]{2}$/;
// Tenant ids as the fixture/auth layer mints them (co_…): a conservative
// shape that keeps every path segment traversal-free by construction.
const TENANT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Parsed, validated pieces of an fs:// storageRef. */
export interface ParsedFsRef {
  companyId: string;
  byteHash: string;
}

/**
 * Parse + validate an `fs://<companyId>/<byteHash>` storageRef. Pure and
 * unit-testable: hash must be 64 lowercase hex chars, the tenant id must
 * match the conservative shape above — both segments are therefore
 * incapable of path escape ('..', separators, drive letters all fail the
 * regexes). Returns null on ANY deviation; callers treat null as a
 * hard error, never a guess.
 */
export function parseStorageRef(storageRef: string): ParsedFsRef | null {
  const m = /^fs:\/\/([^/]+)\/([^/]+)$/.exec(storageRef);
  if (!m) return null;
  const companyId = m[1]!;
  const byteHash = m[2]!;
  if (!TENANT_RE.test(companyId) || !HASH_RE.test(byteHash)) return null;
  return { companyId, byteHash };
}

/**
 * FsEvidenceStorageAdapter — the v1 blob store: a local directory tree
 * under EVIDENCE_FS_ROOT, layout `<root>/<companyId>/<hash[0..1]>/<hash>`
 * (two-char fan-out keeps per-directory entry counts sane at scale).
 * storageRef is `fs://<companyId>/<byteHash>` — the ROOT IS NOT part of
 * the ref, so an operator can relocate the tree by changing the env var
 * without rewriting rows.
 *
 * put() is temp-file-then-rename atomic: a crash mid-write leaves a
 * `.tmp-…` straggler, never a half-written blob under its content
 * address. Root unset ⇒ every method throws the clear unconfigured error
 * (evidence-flags contract) — no silent default path.
 */
@Injectable()
export class FsEvidenceStorageAdapter implements EvidenceStorageAdapter {
  readonly scheme = 'fs';

  /** Resolved root, or a loud error — never a default path. */
  private root(): string {
    const root = evidenceFsRoot();
    if (!root) {
      throw new Error(
        'EVIDENCE_FS_ROOT is not set — the fs evidence storage adapter is ' +
          'unconfigured. Set EVIDENCE_FS_ROOT to the blob directory root.',
      );
    }
    return resolve(root);
  }

  /** Absolute blob path for a validated ref; throws on a malformed ref. */
  private pathFor(storageRef: string): string {
    const parsed = parseStorageRef(storageRef);
    if (!parsed) throw new Error(`malformed fs storageRef: ${storageRef}`);
    const root = this.root();
    const p = resolve(join(root, parsed.companyId, parsed.byteHash.slice(0, 2), parsed.byteHash));
    // Defense in depth: the segment regexes already forbid traversal, but
    // the resolved path must still sit under the root or we refuse.
    if (!p.startsWith(root + sep)) throw new Error(`fs storageRef escapes root: ${storageRef}`);
    return p;
  }

  async put(
    companyId: string,
    byteHash: string,
    data: Buffer,
  ): Promise<{ storageRef: string; byteLength: number }> {
    if (!TENANT_RE.test(companyId)) throw new Error(`invalid companyId for fs put: ${companyId}`);
    if (!HASH_RE.test(byteHash)) throw new Error(`invalid byteHash for fs put: ${byteHash}`);
    const actualHash = createHash('sha256').update(data).digest('hex');
    if (actualHash !== byteHash) {
      throw new Error(`byteHash does not match the supplied bytes`);
    }
    const storageRef = `fs://${companyId}/${byteHash}`;
    const dest = this.pathFor(storageRef);
    const existing = await this.head(storageRef);
    if (existing) return { storageRef, byteLength: existing.byteLength }; // content-addressed no-op
    const dir = join(dest, '..');
    await mkdir(dir, { recursive: true });
    const tmp = join(dir, `${TMP_PREFIX}${randomUUID()}`);
    try {
      await writeFile(tmp, data);
      await rename(tmp, dest); // atomic within one filesystem
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
    return { storageRef, byteLength: data.byteLength };
  }

  belongsToTenant(companyId: string, storageRef: string): boolean {
    return parseStorageRef(storageRef)?.companyId === companyId;
  }

  async get(storageRef: string): Promise<Readable> {
    const p = this.pathFor(storageRef);
    await stat(p); // throw a clean ENOENT before handing back a stream
    return createReadStream(p);
  }

  async head(storageRef: string): Promise<{ byteLength: number } | null> {
    try {
      const s = await stat(this.pathFor(storageRef));
      return { byteLength: s.size };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }

  async exists(storageRef: string): Promise<boolean> {
    return (await this.head(storageRef)) !== null;
  }

  async delete(storageRef: string): Promise<boolean> {
    const p = this.pathFor(storageRef);
    try {
      await rm(p);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw e;
    }
  }

  /**
   * Enumerate one tenant's blobs — the orphan-GC contract in
   * storage-adapter.ts. Walks `<root>/<companyId>/<xx>/` and yields ONLY
   * files whose name is a well-formed 64-hex content address sitting
   * under its own two-char fan-out directory: anything this layout could
   * not have produced is not a blob this adapter owns, and is therefore
   * never offered to a deleter. `.tmp-…` stragglers are excluded here on
   * purpose — they carry no ref at all and are swept by
   * sweepIncompleteWrites below.
   *
   * Every yielded ref is `fs://<companyId>/<hash>`, so
   * belongsToTenant(companyId, ref) holds by construction — contract
   * point 1. An absent tenant directory yields nothing (a tenant that has
   * never uploaded is not an error).
   */
  async *listBlobs(companyId: string): AsyncGenerator<StoredBlobEntry> {
    if (!TENANT_RE.test(companyId)) return;
    const tenantDir = join(this.root(), companyId);
    for (const shard of await this.namesIn(tenantDir, 'dir')) {
      if (!SHARD_RE.test(shard)) continue;
      for (const name of await this.namesIn(join(tenantDir, shard), 'file')) {
        if (!HASH_RE.test(name) || name.slice(0, 2) !== shard) continue;
        const s = await this.statOrNull(join(tenantDir, shard, name));
        if (!s) continue; // vanished mid-walk (a concurrent delete) — fine
        yield {
          storageRef: `fs://${companyId}/${name}`,
          byteLength: s.size,
          // ctime moves on the atomic rename that PUBLISHES the blob;
          // mtime carries over from the tmp write that preceded it. The
          // later of the two is the honest "when did the store last
          // touch this", and the conservative input to a grace window
          // that exists to protect bytes whose row is still in flight
          // (contract point 2).
          modifiedAtMs: Math.max(s.mtimeMs, s.ctimeMs),
        };
      }
    }
  }

  /**
   * Drop `.tmp-<uuid>` stragglers older than `olderThanMs` — the debris
   * a process killed between writeFile and rename leaves behind. put()'s
   * own catch removes them on a normal failure, so anything reaching this
   * broom outlived the process that made it. No ref addresses these
   * files, so no row can reference them and listBlobs cannot enumerate
   * them: unreachable by construction, which is precisely why they need
   * their own leg.
   *
   * The same grace the blob leg applies: a tmp file younger than the
   * cutoff may be an upload writing RIGHT NOW. `dryRun` counts without
   * removing. Per-file failures are swallowed — the straggler is
   * rediscovered next run.
   */
  async sweepIncompleteWrites(
    companyId: string,
    opts: { olderThanMs: number; dryRun: boolean },
  ): Promise<{ found: number; removed: number }> {
    if (!TENANT_RE.test(companyId)) return { found: 0, removed: 0 };
    const tenantDir = join(this.root(), companyId);
    const cutoff = Date.now() - Math.max(0, opts.olderThanMs);
    let found = 0;
    let removed = 0;
    for (const shard of await this.namesIn(tenantDir, 'dir')) {
      if (!SHARD_RE.test(shard)) continue;
      for (const name of await this.namesIn(join(tenantDir, shard), 'file')) {
        if (!name.startsWith(TMP_PREFIX)) continue;
        const path = join(tenantDir, shard, name);
        const s = await this.statOrNull(path);
        if (!s || Math.max(s.mtimeMs, s.ctimeMs) > cutoff) continue;
        found++;
        if (opts.dryRun) continue;
        try {
          await rm(path, { force: true });
          removed++;
        } catch {
          // Best effort, like every other delete leg in the substrate.
        }
      }
    }
    return { found, removed };
  }

  /** Directory listing filtered by entry kind; absent directory ⇒ []. */
  private async namesIn(dir: string, want: 'dir' | 'file'): Promise<string[]> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      return entries
        .filter((e) => (want === 'dir' ? e.isDirectory() : e.isFile()))
        .map((e) => e.name);
    } catch (e) {
      // ENOENT is "this tenant has nothing here", every other errno is a
      // real problem the caller should see — a silently unreadable shard
      // would under-report and hide a permissions mistake.
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
  }

  /** stat() that answers null for a file that is not (or no longer) there. */
  private async statOrNull(path: string): Promise<Stats | null> {
    try {
      return await stat(path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }

  /** Explicit no-op (0121): fs blobs rely on filesystem permissions (and
   *  any OS-level disk encryption) — there is no KMS context to report. */
  encryptionContext(_storageRef: string): Promise<{ kmsKeyRef: string } | null> {
    return Promise.resolve(null);
  }

  /** Explicit no-op (0121): the fs adapter cannot mint URLs — raw
   *  serving stays in-process and separately gated by
   *  raw-evidence-gate.ts; null = unsupported, callers must not fall
   *  back to a raw path. */
  signedGetUrl(_storageRef: string, _ttlSeconds: number): Promise<string | null> {
    return Promise.resolve(null);
  }
}
