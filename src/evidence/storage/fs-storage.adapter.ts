import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { createReadStream, type Stats } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { evidenceFsRoot, evidenceStorageScheme } from '../../common/evidence-flags';
import { normalizeProcessRole } from '../../common/process-role';
import { HASH_RE, TENANT_RE, parseContentRef, type ParsedContentRef } from './content-ref';
import { EvidenceStorageAdapter, StoredBlobEntry } from './storage-adapter';

/** Prefix put() gives a blob mid-write, before the atomic rename. */
const TMP_PREFIX = '.tmp-';
/** The two-char fan-out directory a blob's content address lives under. */
const SHARD_RE = /^[0-9a-f]{2}$/;

/** Parsed, validated pieces of an fs:// storageRef. */
export type ParsedFsRef = ParsedContentRef;

/**
 * Parse + validate an `fs://<companyId>/<byteHash>` storageRef — the
 * shared content-ref grammar (content-ref.ts): both segments are
 * incapable of path escape ('..', separators, drive letters all fail the
 * regexes). Returns null on ANY deviation; callers treat null as a hard
 * error, never a guess.
 */
export function parseStorageRef(storageRef: string): ParsedFsRef | null {
  return parseContentRef('fs', storageRef);
}

/**
 * FsEvidenceStorageAdapter — the local-disk blob store: a directory tree
 * under EVIDENCE_FS_ROOT, layout `<root>/<companyId>/<hash[0..1]>/<hash>`
 * (two-char fan-out keeps per-directory entry counts sane at scale).
 * storageRef is `fs://<companyId>/<byteHash>` — the ROOT IS NOT part of
 * the ref, so an operator can relocate the tree by changing the env var
 * without rewriting rows.
 *
 * CORRECT ONLY FOR ONE REPLICA, OR A SHARED VOLUME. The tree lives on
 * the disk of the process that wrote it: with N replicas and per-pod
 * roots a blob uploaded through one pod is `head() → null` (a 404) on
 * every other, and the orphan sweep — leader-elected — only ever sees
 * the leader's disk. Either mount EVIDENCE_FS_ROOT as one volume every
 * replica shares, or select the object store (EVIDENCE_STORAGE_SCHEME=s3,
 * S3EvidenceStorageAdapter). onApplicationBootstrap warns once when a
 * split-role deployment (PROCESS_ROLE=api|worker — more than one process
 * by definition) is running on this adapter.
 *
 * put() is temp-file-then-rename atomic: a crash mid-write leaves a
 * `.tmp-…` straggler, never a half-written blob under its content
 * address. Root unset ⇒ every method throws the clear unconfigured error
 * (evidence-flags contract) — no silent default path.
 */
@Injectable()
export class FsEvidenceStorageAdapter implements EvidenceStorageAdapter, OnApplicationBootstrap {
  readonly scheme = 'fs';
  private readonly logger = new Logger(FsEvidenceStorageAdapter.name);

  /**
   * The one multi-replica warning, no knob: silent unless this adapter
   * is actually in use (root set, scheme fs) on a split-role process.
   */
  onApplicationBootstrap(): void {
    const root = evidenceFsRoot();
    if (root === null || evidenceStorageScheme() !== 'fs') return;
    const role = normalizeProcessRole(process.env.PROCESS_ROLE);
    if (role !== 'api' && role !== 'worker') return;
    this.logger.warn(
      `EVIDENCE_STORAGE_SCHEME=fs with PROCESS_ROLE=${role}: the fs evidence adapter keeps ` +
        `blobs on THIS process's local disk (${root}). A split-role deployment is more than ` +
        `one process — unless EVIDENCE_FS_ROOT is a volume every replica mounts, a blob ` +
        `uploaded through one replica is a 404 on the others and the orphan sweep only ` +
        `sees the leader's disk. Select EVIDENCE_STORAGE_SCHEME=s3 for a shared store ` +
        `(docs/operations.md § Evidence storage).`,
    );
  }

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
          // mtime, and deliberately NOT max(mtime, ctime): rename
          // preserves the tmp write's mtime, so mtime IS the moment
          // these bytes were written, to within the microseconds
          // between writeFile and rename. ctime would additionally move
          // on any metadata touch — a chmod, a restore, a container
          // layer copy — which only ever makes a blob look YOUNGER and
          // defer collection; safe, but it also makes the age
          // unobservable from a test and lets a whole store read as
          // fresh after an unrelated operator action. The write time is
          // the honest answer and the checkable one.
          modifiedAtMs: s.mtimeMs,
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
        if (!s || s.mtimeMs > cutoff) continue;
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
