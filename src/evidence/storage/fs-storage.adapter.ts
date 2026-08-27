import { Injectable } from '@nestjs/common';
import { createReadStream } from 'node:fs';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { evidenceFsRoot } from '../../common/evidence-flags';
import { EvidenceStorageAdapter } from './storage-adapter';

const HASH_RE = /^[0-9a-f]{64}$/;
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
    const tmp = join(dir, `.tmp-${randomUUID()}`);
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
}
